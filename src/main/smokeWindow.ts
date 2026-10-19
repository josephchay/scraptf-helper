// --smoke-window: the hermetic live test of the F21 scrap.tf window. Diagnostics only: main.ts imports this
// module in its gated branch alone (a development build or FLIPDESK_DIAGNOSTICS=1, a profile that is not the
// app's own, never beside --smoke-test), and no production module imports it. It drives the real
// BrowserWindow, view, toolbar and service import against local pages: before the window manager builds its
// view, every http(s) request of the window's sessions is answered by smokeWindowFixtures' router and every
// other scheme is cancelled (http(s) too, should the router not be in place), main.ts has this run's
// Chromium resolve no host name and use no proxy, and shell.openExternal is replaced so no page reaches the
// user's browser. Nothing here opens a connection. It writes a JSON report and exits 0 when no step failed
// (a key Electron's synthetic input cannot test is reported as not testable, not as a failure), else 1.
//
// Only this file may (test/compliance/static.test.ts): call the window manager outside a click, focus the
// view, send it input events, load a page into it, and answer its sessions' requests (protocol.handle,
// webRequest). It watches scraptfWindow.ts and READ_SCRIPT; it changes neither.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, session, shell, webContents, type BrowserWindow, type Session, type WebContents } from 'electron';
import type { Logger } from '../service/contracts';
import { BANK_STOCK_MAX_LIMIT } from '../shared/bankStock';
import { PARTIAL_READ } from '../shared/importCodes';
import { SCRAPTF_CHANGES_MAX_LIMIT } from '../shared/scraptfHistory';
import {
  READ_SCRIPT,
  READ_SETTLE_MS,
  READ_WORLD_ID,
  SCRAPTF_WINDOW_NOTICES,
  topLevelNavigationDecision,
  windowDisplayUrl,
  windowKeyAction,
  type WindowKeyAction,
} from '../shared/scraptfWindowPolicy';
import type { ImportBatch, ScraptfBank, ScraptfWindowNav, ScraptfWindowRead } from '../shared/types';
import { safeErrorMessage, SMOKE_WINDOW_HOST_RULES, SMOKE_WINDOW_NO_PROXY } from './paths';
import { SCRAPTF_WINDOW_TITLE, type ScraptfWindowManager } from './scraptfWindow';
import type { ServiceHost } from './serviceHost';
import type { SettingsStore } from './settingsStore';
import {
  routeSmokeRequest,
  SMOKE_CHALLENGE_AT_HATS_URL,
  SMOKE_CHALLENGE_URL,
  SMOKE_FIXTURE_FILES,
  SMOKE_HATS_URL,
  SMOKE_HOME_URL,
  SMOKE_PARTIAL_AT_HATS_URL,
  SMOKE_PARTIAL_HATS_URL,
  SMOKE_STEAM_LINK_POINT,
  SMOKE_STEAM_LOGIN_URL,
  SMOKE_STEAM_SENTINEL,
  SMOKE_UNUSUALS_URL,
  smokeWindowSettings,
  type SmokeFixtureName,
} from './smokeWindowFixtures';

const HOUR = 60 * 60 * 1000;
/** The whole run's ceiling: setup and every step's own timeout, with room to write the report. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
/** The report's own ceiling (its service calls, main's shutdown, the file search): then a short report and exit 1. */
const FINISH_TIMEOUT_MS = 2 * 60 * 1000;
/** What the report says in place of the Steam page's sentinel, should it ever reach it. */
const SENTINEL_REMOVED = '[the Steam sentinel, removed]';
const SERVICE_READY_MS = 30_000;
/** The spec's wait for the item schema; without it the import refuses every page (P3). */
const SCHEMA_WAIT_MS = 60_000;
const MAX_LISTED = 5_000;
/** Files larger than this are not searched for the sentinel (the run's profile is small). */
const MAX_SCANNED_BYTES = 256 * 1024 * 1024;

const HATS_PATH = new URL(SMOKE_HATS_URL).pathname;
const UNUSUALS_PATH = new URL(SMOKE_UNUSUALS_URL).pathname;

export interface SmokeWindowSetup {
  reportPath: string;
  version: string;
  /** app.getAppPath(): the project root in a development build, where test/fixtures/import lives. */
  appPath: string;
  log: Logger;
}

export interface SmokeWindowRuntime {
  settings: Pick<SettingsStore, 'get' | 'set'>;
  host: Pick<ServiceHost, 'call' | 'whenReady'>;
  scraptfWindow: ScraptfWindowManager;
  /** The run's logs folder and the service's data folder (its database): searched for the Steam sentinel. */
  logDir: string;
  dataDir: string;
  /** Main's shutdown (the window, the service, the logs flushed). */
  shutdown(): Promise<void>;
  exit(code: number): void;
}

export interface SmokeWindowRun {
  run(rt: SmokeWindowRuntime): Promise<void>;
}

export type SmokeStepStatus = 'pass' | 'fail' | 'untestable';

export interface SmokeWindowStep {
  name: string;
  /** False only for a failure: a step synthetic input cannot test is not one. */
  ok: boolean;
  status: SmokeStepStatus;
  detail: string;
  ms: number;
}

interface StepOutcome {
  status: SmokeStepStatus;
  detail: string;
}

const pass = (detail: string): StepOutcome => ({ status: 'pass', detail });
const fail = (detail: string): StepOutcome => ({ status: 'fail', detail });
const untestable = (detail: string): StepOutcome => ({ status: 'untestable', detail });

interface ViewEvent {
  kind: 'start' | 'navigate' | 'finish' | 'fail' | 'will-navigate';
  url: string;
  code: number | null;
  /** The toolbar pushes recorded before it: the window's own handlers run after the harness's. */
  pushAt: number;
}

interface SeenInput {
  type: string;
  key: string;
  alt: boolean;
  control: boolean;
  shift: boolean;
  meta: boolean;
  isAutoRepeat: boolean;
}

interface Push {
  event: 'scraptfWindow.read' | 'scraptfWindow.nav';
  payload: unknown;
}

/** A file save of a fixture, made before the window reads the same page: what each read is compared with. */
interface Baseline {
  batchId: number;
  parsed: number;
  rows: Map<string, string>;
  cards: number | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The probe's first value that is not null, undefined or false, or null after `timeoutMs`. */
async function until<T>(probe: () => T | null | undefined | false, timeoutMs: number, everyMs = 100): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() >= end) return null;
    await sleep(everyMs);
  }
}

/** The URL of the document a webContents' main frame shows ('' when it has none). */
function documentUrl(wc: WebContents): string {
  try {
    const url = wc.mainFrame.url;
    return typeof url === 'string' ? url : '';
  } catch {
    return '';
  }
}

function schemeOf(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
}

/** A bank stock row as saved: its raw price and stock (valuing it at the key price would vary with the feed). */
function rowSignature(row: { costKeys: number; costScrapRaw: number; stock: number | null }): string {
  return `${row.costKeys}|${row.costScrapRaw}|${row.stock ?? ''}`;
}

/** What differs between two saves' on-sale rows, or null when they are the same. */
function rowDifference(want: ReadonlyMap<string, string>, got: ReadonlyMap<string, string>): string | null {
  const missing = [...want.keys()].filter((k) => !got.has(k));
  const extra = [...got.keys()].filter((k) => !want.has(k));
  const changed = [...want.keys()].filter((k) => got.has(k) && got.get(k) !== want.get(k));
  if (missing.length + extra.length + changed.length === 0) return null;
  const some = (keys: string[]) => keys.slice(0, 8).join(', ');
  return [
    missing.length > 0 ? `${missing.length} on sale in the file save only (${some(missing)})` : '',
    extra.length > 0 ? `${extra.length} on sale in the window save only (${some(extra)})` : '',
    changed.length > 0 ? `${changed.length} with another price or stock (${some(changed)})` : '',
  ]
    .filter((s) => s !== '')
    .join('; ');
}

function describeRead(r: ScraptfWindowRead): string {
  const stored = typeof r.stored === 'number' ? `, stored ${r.stored}` : '';
  return `${r.path}: ${r.items} items${stored}, bank ${r.bank ?? 'none'}${r.warning ? `, warning '${r.warning}'` : ''}`;
}

function describeInput(i: SeenInput): string {
  const mods = [i.control ? 'Ctrl' : '', i.alt ? 'Alt' : '', i.shift ? 'Shift' : '', i.meta ? 'Meta' : ''].filter((m) => m !== '');
  return `${i.type} key '${i.key}'${mods.length > 0 ? ` with ${mods.join('+')}` : ''}${i.isAutoRepeat ? ' (auto-repeat)' : ''}`;
}

/** `report` with the Steam page's sentinel cut out of every string, and whether it was there. */
function withoutSentinel<T>(report: T): { report: T; leaked: boolean } {
  const text = JSON.stringify(report);
  const leaked = text.includes(SMOKE_STEAM_SENTINEL);
  return { report: leaked ? (JSON.parse(text.split(SMOKE_STEAM_SENTINEL).join(SENTINEL_REMOVED)) as T) : report, leaked };
}

function writeReport(file: string, report: unknown): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  } catch (err) {
    console.error('could not write the window test report', err);
  }
}

/** The files under `dir` (recursively) that contain `needle`, relative to `dir`; unreadable files are skipped. */
function filesContaining(dir: string, needle: Buffer, out: string[] = [], base = dir): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) filesContaining(full, needle, out, base);
      else if (st.isFile() && st.size <= MAX_SCANNED_BYTES && readFileSync(full).includes(needle)) out.push(path.relative(base, full));
    } catch {
      // Locked or gone: nothing to read.
    }
  }
  return out;
}

/**
 * Installs the local network for every session but the default one (the window's partitions are the only
 * others), before any of them loads a page, and returns the run. Call before main's start() builds the
 * window manager.
 */
export function prepareSmokeWindow(setup: SmokeWindowSetup): SmokeWindowRun {
  const { log } = setup;
  const fixturesDir = path.join(setup.appPath, 'test', 'fixtures', 'import');
  const fixtures = new Map<SmokeFixtureName, string>();
  const missingFixtures: string[] = [];
  for (const name of SMOKE_FIXTURE_FILES) {
    try {
      fixtures.set(name, readFileSync(path.join(fixturesDir, name), 'utf8'));
    } catch {
      missingFixtures.push(name);
    }
  }
  const fixture = (name: SmokeFixtureName): string | null => fixtures.get(name) ?? null;

  // ----- the local network -----

  const defaultSession = session.defaultSession;
  /** Sessions the hooks have seen: each gets its filter and handlers once. */
  const seenSessions = new Set<Session>();
  const answeredSessions: Session[] = [];
  const networkErrors: string[] = [];
  /** Every request the router answered: 'GET <url> <status>'. */
  const requests: string[] = [];
  const answeredUrls = new Set<string>();
  /** http(s) requests the request filter passed on to the router (to spot one the router never saw). */
  const filteredUrls = new Set<string>();
  const cancelled: string[] = [];
  /** Resource-hint preconnects: a socket no handler answers, so any one fails the run. */
  const preconnects: string[] = [];
  /** Pages the window handed to the user's browser: refused here, and any one fails the run. */
  const outside: string[] = [];
  let unlisted = 0;

  const list = (to: string[], line: string): void => {
    if (to.length < MAX_LISTED) to.push(line);
    else unlisted++;
  };

  const answer = (request: Request): Response => {
    const r = routeSmokeRequest(request.url, request.method, fixture);
    answeredUrls.add(request.url);
    list(requests, `${request.method} ${request.url.slice(0, 300)} ${r.status}`);
    return new Response(r.body === '' ? null : r.body, { status: r.status, headers: r.headers });
  };

  /**
   * Every http(s) request of `ses` goes to the router and every other scheme is cancelled, from now on. Fail
   * closed: the filter goes in first and passes http(s) on only once both handlers are in, so a session whose
   * handlers could not be installed has every request cancelled rather than sent out.
   */
  const answerLocally = (ses: Session): void => {
    if (ses === defaultSession || seenSessions.has(ses)) return;
    seenSessions.add(ses);
    let local = false;
    try {
      // No filter: every request of the session, ws(s) and any other scheme included.
      ses.webRequest.onBeforeRequest((details, callback) => {
        const scheme = schemeOf(details.url);
        if (local && (scheme === 'https:' || scheme === 'http:')) {
          filteredUrls.add(details.url);
          callback({});
          return;
        }
        list(cancelled, details.url.slice(0, 300));
        callback({ cancel: true });
      });
    } catch (err) {
      networkErrors.push(`a window session's request filter could not be installed: ${safeErrorMessage(err)}`);
    }
    try {
      ses.protocol.handle('https', answer);
      ses.protocol.handle('http', answer);
      local = true;
      answeredSessions.push(ses);
    } catch (err) {
      networkErrors.push(`a window session could not be answered locally: ${safeErrorMessage(err)}`);
    }
    // Only noted: Electron cannot refuse a preconnect, and the host rules leave it no name to connect to.
    ses.on('preconnect', (_event, url) => list(preconnects, url.slice(0, 200)));
  };

  // A page the window's policy calls 'external' goes to the user's browser after a click or key in the view,
  // and the harness's synthetic input counts as one. Nothing leaves for the browser in this run: each such
  // page is noted (origin and path only) and fails the run. Checked before the window opens.
  let outsideRefused = false;
  try {
    const refuse = (url: string): Promise<void> => {
      list(outside, windowDisplayUrl(url) ?? `(${schemeOf(url) || 'no'} address)`);
      return Promise.resolve();
    };
    shell.openExternal = refuse;
    outsideRefused = shell.openExternal === refuse;
  } catch (err) {
    networkErrors.push(`the user's browser could not be kept out of the run: ${safeErrorMessage(err)}`);
  }

  // ----- what the window does, watched (never changed) -----

  const events: ViewEvent[] = [];
  const inputs: SeenInput[] = [];
  const pushes: Push[] = [];
  const scriptRuns: { world: number; readScript: boolean; page: string | null }[] = [];
  let pageWorldScripts = 0;

  /** Counts every script run in a window view and passes the call through unchanged: only READ_SCRIPT may run there. */
  const watchScripts = (contents: WebContents): void => {
    const isolated = contents.executeJavaScriptInIsolatedWorld.bind(contents);
    contents.executeJavaScriptInIsolatedWorld = (...args: Parameters<WebContents['executeJavaScriptInIsolatedWorld']>) => {
      const [world, scripts] = args;
      scriptRuns.push({ world, readScript: scripts.length === 1 && scripts[0]?.code === READ_SCRIPT, page: windowDisplayUrl(documentUrl(contents)) });
      return isolated(...args);
    };
    const pageWorld = contents.executeJavaScript.bind(contents);
    contents.executeJavaScript = (...args: Parameters<WebContents['executeJavaScript']>) => {
      pageWorldScripts++;
      return pageWorld(...args);
    };
  };

  /** The view's navigations and the key input before-input-event reports, from its very first load. */
  const watchView = (v: WebContents): void => {
    const note = (kind: ViewEvent['kind'], url: string, code: number | null) => events.push({ kind, url, code, pushAt: pushes.length });
    v.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument) note('start', event.url, null);
    });
    v.on('did-navigate', (_event, url, code) => note('navigate', url, code));
    v.on('did-finish-load', () => note('finish', documentUrl(v), null));
    v.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (isMainFrame) note('fail', url, code);
    });
    v.on('will-navigate', (event) => note('will-navigate', event.url, null));
    v.on('before-input-event', (_event, input) =>
      inputs.push({ type: input.type, key: input.key, alt: input.alt, control: input.control, shift: input.shift, meta: input.meta, isAutoRepeat: input.isAutoRepeat }),
    );
  };

  /** Records what the window manager tells its toolbar (reads, nav and notices) and delivers it unchanged. */
  const tapToolbar = (win: BrowserWindow): void => {
    if (win.getTitle() !== SCRAPTF_WINDOW_TITLE) return;
    const bar = win.webContents;
    const deliver = bar.send.bind(bar);
    bar.send = (channel: string, ...args: unknown[]) => {
      const event = args[0];
      if (channel === 'push' && (event === 'scraptfWindow.read' || event === 'scraptfWindow.nav')) pushes.push({ event, payload: args[1] });
      deliver(channel, ...args);
    };
  };

  app.on('session-created', answerLocally);
  app.on('web-contents-created', (_event, contents) => {
    if (contents.session === defaultSession) return;
    // Also here, in case a window session was made before session-created could see it.
    answerLocally(contents.session);
    watchScripts(contents);
    watchView(contents);
  });
  app.on('browser-window-created', (_event, win) => tapToolbar(win));

  async function run(rt: SmokeWindowRuntime): Promise<void> {
    const startedAt = Date.now();
    const steps: SmokeWindowStep[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    let finished = false;
    // A cast, so the checks after step 1 see the view the step found (not the initial null).
    let view = null as WebContents | null;
    // Its session, read while the view is alive: step 8 destroys the view, and reading a destroyed
    // WebContents' properties throws, which left finish() hanging until its hard stop.
    let viewSession = null as Session | null;
    let importReady = false;
    let importWhy = 'the service did not start';
    const baselines = new Map<ScraptfBank, Baseline>();

    const step = async (name: string, timeoutMs: number, body: () => Promise<StepOutcome>): Promise<StepOutcome> => {
      const t0 = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<StepOutcome>((resolve) => {
        timer = setTimeout(() => resolve(fail(`timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
      });
      let out: StepOutcome;
      try {
        out = await Promise.race([body(), timeout]);
      } catch (err) {
        out = fail(`threw: ${safeErrorMessage(err)}`);
      } finally {
        clearTimeout(timer);
      }
      if (!finished) steps.push({ name, ok: out.status !== 'fail', status: out.status, detail: out.detail, ms: Date.now() - t0 });
      log.info(`window test: ${name}: ${out.status}`);
      return out;
    };

    const readsSince = (from: number): (ScraptfWindowRead | null)[] =>
      pushes.slice(from).flatMap((p) => (p.event === 'scraptfWindow.read' ? [p.payload as ScraptfWindowRead | null] : []));
    const navsSince = (from: number): ScraptfWindowNav[] => pushes.slice(from).flatMap((p) => (p.event === 'scraptfWindow.nav' ? [p.payload as ScraptfWindowNav] : []));
    const navigatedTo = (from: number, url: string): ViewEvent | null => events.slice(from).find((e) => e.kind === 'navigate' && e.url === url) ?? null;
    const batchIds = async (): Promise<number[]> => (await rt.host.call('import.batches', { limit: 50 })).map((b) => b.id);
    const look = async (bank: ScraptfBank) => {
      const r = await rt.host.call('scraptf.bankStock', { bank, limit: BANK_STOCK_MAX_LIMIT });
      return { savedAt: r.savedAt, saves: r.saves, rows: new Map(r.rows.map((row) => [row.key, rowSignature(row)] as const)) };
    };
    const goneEvents = async (bank: ScraptfBank): Promise<number> => (await rt.host.call('scraptf.changes', { bank, kinds: ['gone'], limit: SCRAPTF_CHANGES_MAX_LIMIT })).length;

    /** The view has stopped loading and no automatic read is under way (its settle read included). */
    const quiet = async (): Promise<void> => {
      await until(() => {
        const wc = view;
        if (wc === null || wc.isDestroyed()) return true;
        const nav = navsSince(0).at(-1);
        return !wc.isLoading() && nav?.reading !== true;
      }, 10_000);
      await sleep(300);
    };

    /**
     * Step 1 and 2's check: a toolbar read of the page with items, an import batch with origin 'window' and the
     * page's bank, and the bank's newest save holding exactly the on-sale rows the file save of the same fixture
     * holds (the fixture's on-sale cards as the parser reads them), with no change event between the two.
     */
    const checkWindowRead = async (bank: ScraptfBank, pagePath: string, pushFrom: number, waitMs: number): Promise<StepOutcome> => {
      const base = baselines.get(bank);
      if (base === undefined) return fail(`not checked: no file save of the ${bank} fixture to compare with`);
      const read = await until(() => readsSince(pushFrom).find((r) => r !== null && r.path === pagePath && r.items > 0), waitMs);
      if (read === null) {
        const last = readsSince(pushFrom).filter((r): r is ScraptfWindowRead => r !== null).at(-1);
        const held = rt.scraptfWindow.state().lastRead;
        // The manager keeps its last read even when the toolbar page never loaded to hear it.
        const unheard = last === undefined && held !== null && held.path === pagePath ? `; the manager read it (${describeRead(held)}) but the toolbar never got it: is dist/renderer built?` : '';
        return fail(`no toolbar read of ${pagePath} with items within ${Math.round(waitMs / 1000)} s${last ? ` (last read ${describeRead(last)})` : ''}${unheard}`);
      }
      const batch: ImportBatch | null = (await rt.host.call('import.batches', { limit: 50 })).find((b) => b.origin === 'window' && b.bank === bank && b.id > base.batchId) ?? null;
      if (batch === null) return fail(`read ${describeRead(read)}, but no import batch has origin window and bank ${bank}`);
      const now = await look(bank);
      const events = (await rt.host.call('scraptf.changes', { bank, limit: SCRAPTF_CHANGES_MAX_LIMIT })).filter((e) => e.batchId === batch.id);
      const report = (await rt.host.call('import.report', { limit: 20 })).find((r) => r.batchId === batch.id) ?? null;
      const problems: string[] = [];
      if (now.savedAt !== batch.fileMtime) problems.push(`the newest ${bank} save is not this read's (save ${now.savedAt ?? 'none'}, batch ${batch.fileMtime})`);
      const diff = rowDifference(base.rows, now.rows);
      if (diff !== null) problems.push(diff);
      if (events.length > 0) problems.push(`${events.length} change events against the file save (${[...new Set(events.map((e) => e.kind))].join(', ')})`);
      if (read.items !== base.parsed) problems.push(`the read parsed ${read.items} items, the file ${base.parsed}`);
      if (report !== null && base.cards !== null && report.counts.cards !== base.cards) problems.push(`the page's DOM held ${report.counts.cards} cards, the file ${base.cards}`);
      const facts = `batch ${batch.id} (origin window, bank ${bank}, ${batch.itemCount} items); ${now.rows.size} rows on sale, as in the file save; read ${describeRead(read)}`;
      return problems.length === 0 ? pass(facts) : fail(`${problems.join('; ')}; ${facts}`);
    };

    /**
     * Ends the run whatever happened: the window closed, the service's records, the logs and the database
     * searched for the Steam page's sentinel, the report written, then main's shutdown and the exit code.
     */
    let hardStop: ReturnType<typeof setTimeout> | undefined;
    const finish = async (extra: readonly string[]): Promise<void> => {
      if (finished) return;
      finished = true;
      clearTimeout(watchdog);
      // Its service calls and main's shutdown have their own timeouts; this is the last word if they hang.
      hardStop = setTimeout(() => {
        const errs = [...errors, `the report did not finish within ${FINISH_TIMEOUT_MS / 1000} s`];
        writeReport(setup.reportPath, withoutSentinel({ ok: false, version: setup.version, steps, errors: errs, durationMs: Date.now() - startedAt }).report);
        rt.exit(1);
      }, FINISH_TIMEOUT_MS);
      errors.push(...extra);
      try {
        await finishChecks();
      } catch (err) {
        clearTimeout(hardStop);
        errors.push(`the report's checks failed: ${safeErrorMessage(err)}`);
        writeReport(setup.reportPath, withoutSentinel({ ok: false, version: setup.version, steps, errors, durationMs: Date.now() - startedAt }).report);
        try {
          await Promise.race([rt.shutdown(), sleep(15_000)]);
        } catch {
          // Exiting anyway.
        }
        rt.exit(1);
      }
    };

    /** finish()'s checks, the report and the exit; any throw here is caught by finish(). */
    const finishChecks = async (): Promise<void> => {
      try {
        rt.scraptfWindow.close();
      } catch {
        // Already gone.
      }

      // The network: the router answered every request of the window's sessions.
      const rules = app.commandLine.getSwitchValue('host-resolver-rules');
      const noProxy = app.commandLine.hasSwitch(SMOKE_WINDOW_NO_PROXY);
      const unanswered = [...filteredUrls].filter((u) => !answeredUrls.has(u));
      for (const u of unanswered.slice(0, 20)) warnings.push(`the request filter passed ${u.slice(0, 200)} on, but the local router never saw it`);
      const viewAnswered = viewSession === null || answeredSessions.includes(viewSession);
      const netProblems = [...networkErrors];
      if (rules !== SMOKE_WINDOW_HOST_RULES) netProblems.push(`Chromium's host resolver rules are '${rules}', not '${SMOKE_WINDOW_HOST_RULES}'`);
      if (!noProxy) netProblems.push(`Chromium was not started with --${SMOKE_WINDOW_NO_PROXY}`);
      if (!outsideRefused) netProblems.push("the user's browser was not kept out of the run");
      if (!viewAnswered) netProblems.push("the view's session was not answered locally");
      if (preconnects.length > 0) netProblems.push(`${preconnects.length} preconnects no handler could answer (${preconnects.slice(0, 5).join(', ')})`);
      if (outside.length > 0) netProblems.push(`${outside.length} pages the window would have opened in the user's browser (${outside.slice(0, 5).join(', ')}); none was opened`);
      // Positive proof: every document the view showed over http(s) is one the router served.
      const shown = [...new Set(events.filter((e) => e.kind === 'navigate' && /^https?:/i.test(e.url)).map((e) => e.url.split('#')[0]!))];
      const notServed = shown.filter((u) => !answeredUrls.has(u));
      if (view !== null && shown.length === 0) netProblems.push('the view showed no page, so nothing here proves where pages came from');
      if (notServed.length > 0) netProblems.push(`the view showed ${notServed.length} pages the local router never served (${notServed.slice(0, 5).map((u) => u.slice(0, 120)).join(', ')})`);
      const hosts = [...new Set([...answeredUrls].map(hostOf))].sort();
      steps.push({
        name: 'network: every request of the window answered locally',
        ok: netProblems.length === 0,
        status: netProblems.length === 0 ? 'pass' : 'fail',
        detail: `${netProblems.length > 0 ? `${netProblems.join('; ')}; ` : ''}${answeredSessions.length} sessions answered by the local router; ${answeredUrls.size} distinct URLs (${hosts.join(', ')}); ${cancelled.length} requests of another scheme cancelled; no preconnect; nothing handed to the browser; host resolver rules '${rules}', no proxy`,
        ms: 0,
      });

      // The scripts: READ_SCRIPT in its world, on scrap.tf pages only; nothing in the page's world.
      const bad = scriptRuns.filter((s) => !s.readScript || s.world !== READ_WORLD_ID || s.page === null || hostOf(s.page) !== hostOf(SMOKE_HOME_URL));
      // A read reached the toolbar, so READ_SCRIPT ran: a spy that saw no run would make this check (and
      // step 4's "no script ran") prove nothing.
      const spyBlind = readsSince(0).some((r) => r !== null && r.items > 0) && scriptRuns.length === 0;
      const scriptsOk = bad.length === 0 && pageWorldScripts === 0 && !spyBlind;
      const pages = [...new Set(scriptRuns.map((s) => s.page ?? '?'))];
      steps.push({
        name: 'scripts: only READ_SCRIPT ran in the view, on scrap.tf pages',
        ok: scriptsOk,
        status: scriptsOk ? 'pass' : 'fail',
        detail: `${spyBlind ? 'the toolbar got reads, but the script spy saw no run; ' : ''}${scriptRuns.length} isolated-world runs (${bad.length} not READ_SCRIPT in world ${READ_WORLD_ID} on a scrap.tf page), ${pageWorldScripts} page-world scripts; pages read: ${pages.join(', ') || 'none'}`,
        ms: 0,
      });

      // The Steam page's sentinel: in no read, batch, parser report, log, database or report.
      const places: string[] = [];
      if (JSON.stringify(pushes).includes(SMOKE_STEAM_SENTINEL)) places.push('the toolbar pushes');
      try {
        if (JSON.stringify(await rt.host.call('import.batches', { limit: 500 })).includes(SMOKE_STEAM_SENTINEL)) places.push('the import batches');
        if (JSON.stringify(await rt.host.call('import.report', { limit: 20 })).includes(SMOKE_STEAM_SENTINEL)) places.push('the parser reports');
      } catch (err) {
        warnings.push(`the service's records could not be searched: ${safeErrorMessage(err)}`);
      }
      try {
        await Promise.race([rt.shutdown(), sleep(15_000)]);
      } catch (err) {
        errors.push(`shutdown failed: ${safeErrorMessage(err)}`);
      }
      const needle = Buffer.from(SMOKE_STEAM_SENTINEL, 'utf8');
      for (const f of filesContaining(rt.logDir, needle)) places.push(`logs/${f}`);
      for (const f of filesContaining(rt.dataDir, needle)) places.push(`data/${f}`);
      steps.push({
        name: 'Steam sentinel: in no read, batch, parser report, log or database',
        ok: places.length === 0,
        status: places.length === 0 ? 'pass' : 'fail',
        detail: places.length === 0 ? 'not found in the toolbar pushes, import batches, parser reports, logs or database' : `found in ${places.join(', ')}`,
        ms: 0,
      });

      const reads = readsSince(0)
        .filter((r): r is ScraptfWindowRead => r !== null)
        .map((r) => ({ path: r.path, items: r.items, stored: r.stored ?? null, bank: r.bank, warning: r.warning, pageFlips: r.pageFlips ?? null }));
      const full = {
        ok: false,
        version: setup.version,
        steps,
        requests,
        errors,
        durationMs: Date.now() - startedAt,
        warnings,
        untestable: steps.filter((s) => s.status === 'untestable').map((s) => s.name),
        network: {
          sessionsAnswered: answeredSessions.length,
          urlsAnswered: answeredUrls.size,
          requestsNotListed: unlisted,
          cancelled,
          preconnects,
          openedOutside: outside,
          hostResolverRules: rules,
          noProxy,
        },
        scripts: { runs: scriptRuns.length, notReadScript: bad.length, pageWorld: pageWorldScripts, pages },
        reads,
      };
      // The sentinel never reaches the report file: should anything carry it here, it is cut out and fails the run.
      const { report, leaked } = withoutSentinel(full);
      if (leaked) report.errors.push('the Steam sentinel reached the report (cut out of it)');
      report.ok = report.errors.length === 0 && report.steps.every((s) => s.ok);
      clearTimeout(hardStop);
      writeReport(setup.reportPath, report);
      console.log(`window test ${report.ok ? 'passed' : 'failed'}: ${setup.reportPath}`);
      rt.exit(report.ok ? 0 : 1);
    };

    const watchdog = setTimeout(() => void finish([`the window test did not finish within ${RUN_TIMEOUT_MS / 60_000} minutes`]), RUN_TIMEOUT_MS);

    // A throw outside a step (a bug in the harness) still ends the run with a report.
    try {
      // ----- setup -----

      const ready = await step('setup: fixtures and the local network', 5_000, async () => {
        if (missingFixtures.length > 0) return fail(`fixtures missing from ${fixturesDir}: ${missingFixtures.join(', ')} (a packaged build has none)`);
        if (networkErrors.length > 0) return fail(networkErrors.join('; '));
        const rules = app.commandLine.getSwitchValue('host-resolver-rules');
        if (rules !== SMOKE_WINDOW_HOST_RULES) return fail(`Chromium's host resolver rules are '${rules}', not '${SMOKE_WINDOW_HOST_RULES}'`);
        if (!app.commandLine.hasSwitch(SMOKE_WINDOW_NO_PROXY)) return fail(`Chromium was not started with --${SMOKE_WINDOW_NO_PROXY}`);
        if (!outsideRefused) return fail("the user's browser could not be kept out of the run (shell.openExternal was not replaced)");
        return pass(`${fixtures.size} fixtures loaded; the window's sessions are answered by the local router; Chromium resolves no host name and uses no proxy; nothing is handed to the user's browser`);
      });
      if (ready.status === 'fail') return finish(['stopped before the window opened']);

      const service = await step('setup: the service is ready', SERVICE_READY_MS + 5_000, async () =>
        (await rt.host.whenReady(SERVICE_READY_MS)) ? pass('ready') : fail(`not ready within ${SERVICE_READY_MS / 1000} s`),
      );

      const settingsOk = await step('setup: import and the window on, reading on load, not signed in', 5_000, async () => {
        rt.settings.set(smokeWindowSettings(Date.now()));
        const s = rt.settings.get();
        const ok = s.import.enabled && s.scraptfWindow.enabled && s.scraptfWindow.readOnLoad && !s.scraptfWindow.keepLoggedIn;
        return ok ? pass('set through the settings store of this run\'s own profile') : fail('the settings store did not keep them');
      });
      if (settingsOk.status === 'fail') return finish(['stopped before the window opened']);

      const schema = await step('setup: the item schema loads', SCHEMA_WAIT_MS + 5_000, async () => {
        if (service.status === 'fail') return fail('not checked: the service is not ready');
        const end = Date.now() + SCHEMA_WAIT_MS;
        let why = '';
        for (;;) {
          try {
            const h = await rt.host.call('health.get', undefined);
            if (h.schema.items > 0 && h.schema.loadedAt !== null) return pass(`${h.schema.items} items, ${h.schema.effects} effects`);
            // The connectors' own state says why (offline, the network paused, a host refusing).
            why = h.connectors
              .filter((c) => c.state === 'error' || c.state === 'backoff' || c.state === 'blocked' || c.state === 'paused')
              .map((c) => `${c.id} ${c.state}${c.lastError ? ` (${c.lastError.slice(0, 120)})` : ''}`)
              .join(', ');
          } catch {
            // The service may still be starting up.
          }
          if (Date.now() >= end) return fail(`the item schema did not load within ${SCHEMA_WAIT_MS / 1000} s${why ? `; connectors: ${why}` : ''}`);
          await sleep(1_000);
        }
      });
      importWhy = service.status === 'fail' ? 'the service is not ready' : schema.status === 'fail' ? `the item schema did not load within ${SCHEMA_WAIT_MS / 1000} s` : '';

      const saved = await step('setup: file saves of the hats and unusuals fixtures (each read is compared with one)', 30_000, async () => {
        if (importWhy !== '') return fail(`not done: ${importWhy}`);
        const facts: string[] = [];
        for (const [bank, name] of [['hats', 'buy_hats.html'], ['unusuals', 'unusuals.html']] as const) {
          const html = fixture(name);
          if (html === null) return fail(`no ${name}`);
          // An hour old, so the window's read of the page is the newer save.
          const r = await rt.host.call('import.html', { html, fileName: name, mtimeMs: Date.now() - HOUR });
          const l = await look(bank);
          const report = (await rt.host.call('import.report', { limit: 20 })).find((x) => x.batchId === r.batchId) ?? null;
          if (r.batchId <= 0 || r.stockSave !== 'written' || l.rows.size === 0) return fail(`${name}: batch ${r.batchId}, stock ${r.stockSave ?? '?'}, ${l.rows.size} rows on sale`);
          baselines.set(bank, { batchId: r.batchId, parsed: r.parsed, rows: l.rows, cards: report?.counts.cards ?? null });
          facts.push(`${name}: ${r.parsed} items, ${l.rows.size} on sale`);
        }
        return pass(facts.join('; '));
      });
      importReady = importWhy === '' && saved.status === 'pass';
      if (importWhy === '' && !importReady) importWhy = 'the file saves the reads compare with failed';

      // ----- 1 and 2: reads of two banks -----

      const opened = await step('1 open /buy/hats: read, imported as a window read, the same on-sale items as the file', 50_000, async () => {
        const pushFrom = pushes.length;
        const from = events.length;
        rt.scraptfWindow.open(SMOKE_HATS_URL);
        view = webContents.getAllWebContents().find((c) => rt.scraptfWindow.ownsContents(c)) ?? null;
        viewSession = view === null ? null : view.session;
        if (view === null) return fail('the window opened no view');
        if (!answeredSessions.includes(view.session)) return fail("the view's session is not answered locally");
        if (!importReady) {
          const nav = await until(() => navigatedTo(from, SMOKE_HATS_URL), 15_000);
          return fail(`not checked: ${importWhy}${nav ? '' : '; the page did not load either'}`);
        }
        return checkWindowRead('hats', HATS_PATH, pushFrom, 40_000);
      });
      if (view === null || !answeredSessions.includes(view.session)) return finish([`stopped: ${opened.detail}`]);

      await step('2 go to /unusuals: read, imported as a window read, the same on-sale items as the file', 45_000, async () => {
        await quiet();
        const pushFrom = pushes.length;
        const from = events.length;
        rt.scraptfWindow.go(SMOKE_UNUSUALS_URL);
        if (!importReady) {
          const nav = await until(() => navigatedTo(from, SMOKE_UNUSUALS_URL), 15_000);
          return fail(`not checked: ${importWhy}${nav ? '' : '; the page did not load either'}`);
        }
        return checkWindowRead('unusuals', UNUSUALS_PATH, pushFrom, 40_000);
      });

      // ----- 3: the F21-11 keys, through Electron's real input path -----

      await step('3 keys: the page takes the focus', 6_000, async () => {
        await quiet();
        const wc = view;
        if (wc === null || wc.isDestroyed()) return fail('no view');
        rt.scraptfWindow.focus();
        wc.focus();
        const focused = await until(() => wc.isFocused(), 3_000);
        return focused ? pass('the window is in front and the page has the focus') : untestable('the page did not take the focus (Windows can keep another app in front); the keys below may not reach it');
      });

      const keys: readonly { label: string; keyCode: string; modifiers: ('alt' | 'control')[]; action: WindowKeyAction; expect: string }[] = [
        { label: 'Alt+Left', keyCode: 'Left', modifiers: ['alt'], action: 'back', expect: SMOKE_HATS_URL },
        { label: 'Alt+Right', keyCode: 'Right', modifiers: ['alt'], action: 'forward', expect: SMOKE_UNUSUALS_URL },
        { label: 'F5', keyCode: 'F5', modifiers: [], action: 'reload', expect: SMOKE_UNUSUALS_URL },
        { label: 'Ctrl+R', keyCode: 'R', modifiers: ['control'], action: 'reload', expect: SMOKE_UNUSUALS_URL },
        { label: 'Alt+Home', keyCode: 'Home', modifiers: ['alt'], action: 'home', expect: SMOKE_HOME_URL },
      ];
      for (const k of keys) {
        await step(`3 keys: ${k.label} ${k.action === 'reload' ? 'reloads' : 'goes to'} ${windowDisplayUrl(k.expect)}`, 15_000, async () => {
          await quiet();
          const wc = view;
          if (wc === null || wc.isDestroyed()) return fail('no view');
          const inputFrom = inputs.length;
          const from = events.length;
          // A reload is of the page on screen (/unusuals once Alt+Right worked), so one key that failed does
          // not fail the next.
          const want = k.action === 'reload' ? documentUrl(wc) || k.expect : k.expect;
          wc.sendInputEvent({ type: 'keyDown', keyCode: k.keyCode, modifiers: k.modifiers });
          wc.sendInputEvent({ type: 'keyUp', keyCode: k.keyCode, modifiers: k.modifiers });
          const seen = await until(() => inputs.slice(inputFrom).find((i) => i.type === 'keyDown'), 1_500);
          if (seen === null) {
            const moved = events.slice(from).some((e) => e.kind === 'start');
            return moved
              ? fail(`the view moved although before-input-event never saw the key`)
              : untestable('not testable by synthetic input: Electron did not route sendInputEvent through before-input-event');
          }
          const nav = await until(() => navigatedTo(from, want), 8_000);
          if (nav !== null) return pass(`${k.action === 'reload' ? 'reloaded' : 'moved the view to'} ${windowDisplayUrl(want)}; before-input-event saw ${describeInput(seen)}`);
          if (windowKeyAction(seen) !== k.action) return untestable(`not testable by synthetic input: before-input-event saw ${describeInput(seen)}, which a real ${k.label} would not give`);
          return fail(`before-input-event saw ${describeInput(seen)} (the window's ${k.action}), but the view did not ${k.action === 'reload' ? 'reload' : 'move to'} ${windowDisplayUrl(want)} within 8 s`);
        });
      }

      await step('3 keys: a held key (auto-repeat) moves nothing', 10_000, async () => {
        await quiet();
        const wc = view;
        if (wc === null || wc.isDestroyed()) return fail('no view');
        const inputFrom = inputs.length;
        const from = events.length;
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Left', modifiers: ['alt', 'isautorepeat'] });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Left', modifiers: ['alt'] });
        await sleep(2_000);
        const moved = events.slice(from).some((e) => e.kind === 'start');
        const seen = inputs.slice(inputFrom).find((i) => i.type === 'keyDown');
        if (seen === undefined) return untestable('not testable by synthetic input: Electron did not route sendInputEvent through before-input-event');
        if (!seen.isAutoRepeat) return untestable(`not testable by synthetic input: the key reached before-input-event without its auto-repeat flag (${describeInput(seen)})${moved ? ', so it moved the view as a real press would' : ''}`);
        return moved ? fail(`an auto-repeat ${describeInput(seen)} moved the view`) : pass(`${describeInput(seen)} moved nothing in 2 s`);
      });

      // ----- 4: Steam's sign-in -----

      await step('4 Steam sign-in: the policy allows it, nothing is read or imported', 30_000, async () => {
        await quiet();
        const wc = view;
        if (wc === null || wc.isDestroyed()) return fail('no view');
        if (documentUrl(wc) !== SMOKE_HOME_URL) {
          const from = events.length;
          rt.scraptfWindow.home();
          if ((await until(() => navigatedTo(from, SMOKE_HOME_URL), 8_000)) === null) return fail('the home page with the Steam link did not load');
          await quiet();
        }
        const pushFrom = pushes.length;
        const runsFrom = scriptRuns.length;
        const before = await batchIds();
        const from = events.length;
        // The page's own "Sign in through Steam" link, clicked: a navigation the page starts, which the
        // window's policy is asked about (Electron does not ask it about a loadURL).
        const { x, y } = SMOKE_STEAM_LINK_POINT;
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        const askedPolicy = () => events.slice(from).some((e) => e.kind === 'will-navigate' && e.url === SMOKE_STEAM_LOGIN_URL);
        let via = 'a click on the page\'s link (will-navigate, the policy allowed it)';
        let nav = await until(() => navigatedTo(from, SMOKE_STEAM_LOGIN_URL), 6_000);
        // The click reached the policy and the page did not come: the policy refused Steam's sign-in.
        if (nav === null && askedPolicy()) return fail("the click asked the window's policy (will-navigate), but the Steam sign-in page did not load");
        if (nav === null) {
          // The click never reached the link, so the policy was never asked: its answer for the address is
          // checked directly, and the page loaded as the spec says.
          const decision = topLevelNavigationDecision(SMOKE_STEAM_LOGIN_URL);
          if (decision !== 'allow') return fail(`the click did not reach the link, and the window's policy says '${decision}' for Steam's sign-in`);
          via = "loadURL, after the click did not reach the link (Electron asks no policy about a loadURL; the policy's answer for the address is 'allow')";
          wc.loadURL(SMOKE_STEAM_LOGIN_URL).catch(() => undefined);
          nav = await until(() => navigatedTo(from, SMOKE_STEAM_LOGIN_URL), 8_000);
        }
        if (nav === null) return fail('the Steam sign-in page did not load');
        const asked = askedPolicy();
        // A read would have started at did-finish-load and imported after its settle read.
        await sleep(READ_SETTLE_MS + 2_000);
        const runs = scriptRuns.length - runsFrom;
        const readPushes = readsSince(pushFrom).filter((r) => r !== null).length;
        const after = await batchIds();
        const added = after.filter((id) => !before.includes(id));
        const leak = JSON.stringify(await rt.host.call('import.batches', { limit: 500 })).includes(SMOKE_STEAM_SENTINEL) || JSON.stringify(pushes).includes(SMOKE_STEAM_SENTINEL);
        const problems = [
          runs > 0 ? `${runs} scripts ran in the view` : '',
          readPushes > 0 ? `${readPushes} toolbar reads` : '',
          added.length > 0 ? `${added.length} new import batches` : '',
          leak ? 'the sentinel reached a batch or a toolbar push' : '',
          via.startsWith('a click') && !asked ? 'will-navigate did not fire for the click' : '',
        ].filter((p) => p !== '');
        const facts = `reached by ${via}; HTTP ${nav.code ?? '?'}`;
        return problems.length === 0 ? pass(`${facts}; no script ran, no read, no batch`) : fail(`${problems.join('; ')}; ${facts}`);
      });

      // ----- 5: a Cloudflare-style check page -----

      /**
       * One challenge page, loaded by `load`: its 403 commits, the toolbar gets the challenge notice for this
       * document (a push after its did-navigate, with its address; the last page's notice does not count), and
       * nothing runs in it, is read or is imported (a read would have run at did-finish-load and imported after
       * its settle read).
       */
      const challengeProblems = async (url: string, load: (wc: WebContents) => void): Promise<string[]> => {
        await quiet();
        const wc = view;
        if (wc === null || wc.isDestroyed()) return ['no view'];
        const where = ((u) => `${u.pathname}${u.search}`)(new URL(url));
        const pushFrom = pushes.length;
        const runsFrom = scriptRuns.length;
        const before = await batchIds();
        const from = events.length;
        load(wc);
        const nav = await until(() => navigatedTo(from, url), 8_000);
        if (nav === null) return [`${where} did not load`];
        const shown = windowDisplayUrl(url);
        const notice = await until(() => navsSince(nav.pushAt).find((n) => n.url === shown && n.notice === SCRAPTF_WINDOW_NOTICES.challenge), 5_000);
        await sleep(READ_SETTLE_MS + 1_000);
        const added = (await batchIds()).filter((id) => !before.includes(id));
        const readPushes = readsSince(pushFrom).filter((r) => r !== null).length;
        const runs = scriptRuns.length - runsFrom;
        return [
          nav.code !== 403 ? `${where}: did-navigate reported HTTP ${nav.code ?? '?'}, not 403` : '',
          notice === null ? `${where}: no challenge notice for it reached the toolbar` : '',
          added.length > 0 ? `${where}: ${added.length} new import batches` : '',
          readPushes > 0 ? `${where}: ${readPushes} toolbar reads` : '',
          runs > 0 ? `${where}: ${runs} scripts ran in the view` : '',
        ].filter((p) => p !== '');
      };

      await step('5 challenge page: the toolbar shows its notice, nothing is read or imported, at its own and at the hats address', 60_000, async () => {
        // The spec's address, then the same page at the hats address: /smoke/challenge is no page the import
        // reads (F21-4), so only there does "not read" depend on the window seeing the challenge.
        const problems = [
          ...(await challengeProblems(SMOKE_CHALLENGE_URL, (wc) => void wc.loadURL(SMOKE_CHALLENGE_URL).catch(() => undefined))),
          ...(await challengeProblems(SMOKE_CHALLENGE_AT_HATS_URL, (wc) => void wc.loadURL(SMOKE_CHALLENGE_AT_HATS_URL).catch(() => undefined))),
        ];
        return problems.length === 0
          ? pass(`HTTP 403 with cf-mitigated at /smoke/challenge and /buy/hats?smoke=challenge; notice '${SCRAPTF_WINDOW_NOTICES.challenge}' for each; nothing ran, no read, no batch`)
          : fail(problems.join('; '));
      });

      // ----- 6: a partial look (DM-2) -----

      await step('6 partial look of /buy/hats: no bank stock save, no gone events', 45_000, async () => {
        if (!importReady) return fail(`not checked: ${importWhy}`);
        await quiet();
        const wc = view;
        if (wc === null || wc.isDestroyed()) return fail('no view');
        const stockBefore = await look('hats');
        const goneBefore = await goneEvents('hats');
        // The spec's address first: not a page the import reads (F21-4), so the window must not read it.
        const runsFrom = scriptRuns.length;
        const from = events.length;
        wc.loadURL(SMOKE_PARTIAL_HATS_URL).catch(() => undefined);
        if ((await until(() => events.slice(from).find((e) => e.kind === 'finish' && e.url === SMOKE_PARTIAL_HATS_URL), 8_000)) === null) {
          return fail(`${windowDisplayUrl(SMOKE_PARTIAL_HATS_URL)} did not load`);
        }
        await sleep(1_000);
        const readAtOwnAddress = scriptRuns.length - runsFrom;
        // Then the same page at the hats page's address, which the window reads, and its hint names /buy/hats.
        await quiet();
        const pushFrom = pushes.length;
        wc.loadURL(SMOKE_PARTIAL_AT_HATS_URL).catch(() => undefined);
        const read = await until(() => readsSince(pushFrom).find((r) => r !== null && r.path === HATS_PATH), 25_000);
        if (read === null) return fail(`no toolbar read of ${HATS_PATH} for the partial page within 25 s`);
        const stockAfter = await look('hats');
        const goneAfter = await goneEvents('hats');
        const batch = (await rt.host.call('import.batches', { limit: 20 })).find((b) => b.origin === 'window' && b.bank === 'hats') ?? null;
        const problems = [
          readAtOwnAddress > 0 ? `the window read ${windowDisplayUrl(SMOKE_PARTIAL_HATS_URL)}, which the import does not read` : '',
          read.warning === null || !read.warning.startsWith(PARTIAL_READ) ? `the read's warning is '${read.warning ?? 'none'}', not ${PARTIAL_READ}` : '',
          stockAfter.savedAt !== stockBefore.savedAt || stockAfter.saves !== stockBefore.saves ? `a bank stock save was written (saved ${stockBefore.savedAt} -> ${stockAfter.savedAt}, ${stockBefore.saves} -> ${stockAfter.saves} saves)` : '',
          goneAfter !== goneBefore ? `${goneAfter - goneBefore} new gone events` : '',
        ].filter((p) => p !== '');
        const facts = `read ${describeRead(read)}; newest window batch ${batch?.id ?? 'none'}; ${stockAfter.rows.size} rows on sale kept from the full save`;
        return problems.length === 0 ? pass(`${windowDisplayUrl(SMOKE_PARTIAL_HATS_URL)} not read; ${facts}`) : fail(`${problems.join('; ')}; ${facts}`);
      });

      // ----- 7: Log out & clear -----

      await step('7 Log out & clear: storage cleared, the home page loaded (locally)', 25_000, async () => {
        await quiet();
        const pushFrom = pushes.length;
        const reqFrom = requests.length;
        const from = events.length;
        await rt.scraptfWindow.clear();
        const nav = await until(() => navigatedTo(from, SMOKE_HOME_URL), 8_000);
        const nullRead = readsSince(pushFrom).some((r) => r === null);
        const served = requests.slice(reqFrom).some((r) => r === `GET ${SMOKE_HOME_URL} 200`);
        const lastRead = rt.scraptfWindow.state().lastRead;
        const cache = await Promise.all(answeredSessions.map(async (s) => `${s.isPersistent() ? 'on disk' : 'in memory'} ${await s.getCacheSize()} B`));
        const problems = [
          nav === null ? 'the home page did not load after the clear' : '',
          !served ? 'the local router served no home page after the clear' : '',
          !nullRead ? 'the toolbar was not told to drop its read' : '',
          lastRead !== null ? 'the manager still holds a last read' : '',
        ].filter((p) => p !== '');
        const facts = `both partitions' storage and cache cleared (cache now: ${cache.join(', ')})`;
        return problems.length === 0 ? pass(`${facts}; the toolbar's read dropped; home served locally`) : fail(`${problems.join('; ')}; ${facts}`);
      });

      // ----- 8: close -----

      await step('8 close: the window and its view are gone', 10_000, async () => {
        const wc = view;
        rt.scraptfWindow.close();
        const gone = wc === null || (await until(() => wc.isDestroyed(), 5_000)) === true;
        const st = rt.scraptfWindow.state();
        const problems = [st.open ? 'the manager still reports the window open' : '', !gone ? "the view's page was not closed" : '', wc !== null && rt.scraptfWindow.ownsContents(wc) ? 'the manager still owns the view' : ''].filter(
          (p) => p !== '',
        );
        return problems.length === 0 ? pass('state().open is false and the view is destroyed') : fail(problems.join('; '));
      });

      // ----- 9: the report -----

      await finish([]);
    } catch (err) {
      await finish([`the window test stopped: ${safeErrorMessage(err)}`]);
    }
  }

  return { run };
}
