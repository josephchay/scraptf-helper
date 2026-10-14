// Electron main process: single instance, app:// protocol, tray, windows,
// settings and secrets, the service host, notifications and the global
// quick-entry hotkey. Flags: --hidden (login item), --user-data-dir=<path>;
// development builds only (or FLIPDESK_DIAGNOSTICS=1): --dev (DevTools),
// --smoke-test=<report.json>, --smoke-wait=<seconds>.

import { mkdirSync, writeFileSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  Notification,
  protocol,
  safeStorage,
  session,
  shell,
  utilityProcess,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import { z } from 'zod';
import { isAllowedExternalUrl } from '../shared/links';
import type { AppInfo, PushContract } from '../shared/rpc';
import type { AppStatus, HealthReport } from '../shared/types';
import { acquireMachineLock, type MachineLock } from './instanceLock';
import { createRpcRouter, registerRpcHandler } from './ipc';
import { APP_USER_MODEL_ID, parseLaunchArgs, readFileBounded, resolveAppPaths, safeErrorMessage, type AppPaths } from './paths';
import { APP_SCHEME_PRIVILEGES, registerAppProtocol } from './protocol';
import { createSecretsStore, type SecretsStore } from './secrets';
import {
  createMainLog,
  createServiceHost,
  isAppStatus,
  serviceEnv,
  serviceStatePush,
  type MainLog,
  type ServiceHost,
} from './serviceHost';
import { createSettingsStore, type HotkeyResult, type HotkeyStatus, type SettingsStore } from './settingsStore';
import { createTray, type TrayController, type TrayState } from './tray';
import { createWindowManager, hardenSession, hardenWebContents, type WindowManager } from './windows';

app.setAppUserModelId(APP_USER_MODEL_ID);

declare const __APP_VERSION__: string;
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : app.getVersion();
const SMOKE_WATCHDOG_MS = 120_000;

// Diagnostic switches (DevTools, smoke-test report paths) are for development builds.
const args = parseLaunchArgs(process.argv, process.cwd(), {
  allowDiagnostics: !app.isPackaged || process.env['FLIPDESK_DIAGNOSTICS'] === '1',
});
if (args.userDataDir) {
  mkdirSync(args.userDataDir, { recursive: true });
  app.setPath('userData', args.userDataDir);
  app.setPath('sessionData', args.userDataDir);
}
protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES]);

interface Runtime {
  paths: AppPaths;
  settings: SettingsStore;
  secrets: SecretsStore;
  windows: WindowManager;
  host: ServiceHost;
  tray: TrayController | null;
}

let log: MainLog;
let runtime: Runtime | null = null;
let quitting = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;
let lastStatus: AppStatus | null = null;
/** Held for the life of the process; the OS frees it on exit. */
let machineLock: MachineLock | null = null;
const liveNotifications = new Set<Notification>();

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function writeReport(file: string, report: unknown): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  } catch (err) {
    console.error('could not write the smoke-test report', err);
  }
}

// ---------------------------------------------------------------------------
// Hotkey and login item (settings side effects)
// ---------------------------------------------------------------------------

function tryRegister(accel: string, onTrigger: () => void): boolean {
  try {
    return globalShortcut.register(accel, onTrigger);
  } catch {
    return false;
  }
}

function applyHotkey(next: string, prev: string | null, onTrigger: () => void): HotkeyResult {
  if (next === '') {
    if (prev) globalShortcut.unregister(prev);
    return { ok: true };
  }
  let ok = tryRegister(next, onTrigger);
  // "Ctrl+Alt+F" -> "CommandOrControl+Alt+F" is the same key combination we already hold.
  if (!ok && prev) {
    globalShortcut.unregister(prev);
    ok = tryRegister(next, onTrigger);
    if (!ok) tryRegister(prev, onTrigger);
    return ok ? { ok: true } : { ok: false, error: `"${next}" is already used by another application or is not a valid shortcut.` };
  }
  if (!ok) return { ok: false, error: `"${next}" is already used by another application or is not a valid shortcut.` };
  if (prev && prev !== next) globalShortcut.unregister(prev);
  return { ok: true };
}

function applyLoginItem(openAtLogin: boolean): void {
  if (!app.isPackaged) {
    log.info(`login item ${openAtLogin ? 'enable' : 'disable'} skipped (development build)`);
    return;
  }
  app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] });
}

// ---------------------------------------------------------------------------
// Pushes from the service
// ---------------------------------------------------------------------------

const notifySchema = z.looseObject({
  title: z.string().min(1),
  body: z.string(),
  sku: z.string().nullable().catch(null),
});

function showNotification(rt: Runtime, payload: unknown): void {
  const parsed = notifySchema.safeParse(payload);
  if (!parsed.success) {
    log.warn('ignored a malformed notify push');
    return;
  }
  if (args.smokeTest || !rt.settings.get().notifications.enabled || !Notification.isSupported()) return;
  const data: PushContract['notify'] = { title: clip(parsed.data.title, 120), body: clip(parsed.data.body, 400), sku: parsed.data.sku };
  const n = new Notification({ title: data.title, body: data.body, icon: rt.paths.iconPng });
  // Holding a reference keeps the click handler alive until the toast is gone.
  liveNotifications.add(n);
  const release = () => liveNotifications.delete(n);
  n.on('click', () => {
    release();
    if (data.sku) openItemInDashboard(rt, data.sku);
    else rt.windows.showDashboard();
  });
  n.on('close', release);
  n.on('failed', (_e, error) => {
    release();
    log.warn('desktop notification failed', { error });
  });
  n.show();
  if (liveNotifications.size > 25) {
    const oldest = liveNotifications.values().next().value;
    if (oldest) liveNotifications.delete(oldest);
  }
}

/** Shows the dashboard and asks it to open an item's drawer (notification click, quick entry). */
function openItemInDashboard(rt: Runtime, sku: string): void {
  rt.windows.showDashboard();
  rt.windows.sendToDashboard('ui.openItem', { sku });
}

function trayState(rt: Runtime): TrayState {
  const s = rt.settings.get();
  return {
    liveFeedEnabled: s.liveFeed.enabled,
    networkPaused: s.networkPaused,
    status: lastStatus,
    service: rt.host.status(),
    hotkey: rt.settings.hotkeyStatus(),
    now: Date.now(),
  };
}

function refreshTray(rt: Runtime, forceMenu = false): void {
  try {
    rt.tray?.update(trayState(rt), forceMenu);
  } catch (err) {
    log.warn('tray update failed', err);
  }
}

function refreshStatus(rt: Runtime): void {
  rt.host
    .call('status.get', undefined)
    .then((st) => {
      if (isAppStatus(st)) {
        lastStatus = st;
        refreshTray(rt);
      }
    })
    .catch(() => {
      // The tooltip simply keeps its last value.
    });
}

function handlePush(rt: Runtime, event: keyof PushContract, payload: unknown): void {
  switch (event) {
    case 'status.changed':
      // A malformed status would crash the dashboard (it reads status.counts); keep the last good one.
      if (!isAppStatus(payload)) {
        log.warn('ignored a malformed status.changed push');
        return;
      }
      lastStatus = payload;
      refreshTray(rt);
      rt.windows.broadcast('status.changed', payload);
      return;
    case 'notify':
      showNotification(rt, payload);
      return;
    case 'settings.changed':
    case 'ui.openItem':
    case 'service.state':
      // Main owns these; the service host already drops them (MAIN_ONLY_PUSH_EVENTS).
      return;
    default:
      rt.windows.broadcast(event, payload as never);
  }
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function parentOf(win: unknown): BrowserWindow | null {
  return win instanceof BrowserWindow && !win.isDestroyed() ? win : null;
}

async function pickPath(win: unknown, options: OpenDialogOptions): Promise<string | null> {
  const parent = parentOf(win);
  const r = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return r.canceled ? null : (r.filePaths[0] ?? null);
}

async function pickSavePath(win: unknown, suggestedName: string): Promise<string | null> {
  const parent = parentOf(win);
  // Fixed types: the caller's name never decides what kind of file gets written (ipc.ts checks the result too).
  const options: SaveDialogOptions = {
    title: 'Save export',
    defaultPath: path.join(app.getPath('downloads'), suggestedName),
    filters: [
      { name: 'CSV', extensions: ['csv'] },
      { name: 'Text', extensions: ['txt'] },
    ],
  };
  const r = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  return r.canceled || !r.filePath ? null : r.filePath;
}

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

const healthSummarySchema = z.looseObject({
  connectors: z.array(z.looseObject({ id: z.string(), state: z.string() })).catch([]),
  feed: z.looseObject({ state: z.string() }).nullable().catch(null),
  schema: z.looseObject({ items: z.number() }).nullable().catch(null),
  db: z.looseObject({ sizeBytes: z.number() }).nullable().catch(null),
  budgets: z.array(z.unknown()).catch([]),
});

function summarizeHealth(h: HealthReport | null): unknown {
  if (!h) return null;
  const r = healthSummarySchema.safeParse(h);
  if (!r.success) return { unexpectedShape: true };
  return {
    connectors: r.data.connectors.map((c) => ({ id: c.id, state: c.state })),
    feed: r.data.feed?.state ?? null,
    schemaItems: r.data.schema?.items ?? null,
    dbSizeBytes: r.data.db?.sizeBytes ?? null,
    budgets: r.data.budgets.length,
  };
}

/**
 * --smoke-wait: what the service did while running live for a while. Fails the
 * smoke test when the feed, schema or key price never arrived.
 */
function liveSummary(h: HealthReport | null, st: AppStatus | null, waitedSec: number): { summary: unknown; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!h) return { summary: null, errors: ['health.get failed after the wait'], warnings };
  const feed = h.feed;
  const statuses: Record<string, number> = {};
  for (const r of h.recentRequests ?? []) statuses[String(r.status)] = (statuses[String(r.status)] ?? 0) + 1;
  const connectorProblems = (h.connectors ?? [])
    .filter((c) => c.state === 'error' || c.state === 'blocked' || c.state === 'backoff')
    .map((c) => `${c.id} ${c.state}: ${clip(c.lastError ?? c.detail ?? '', 200)}`);
  const summary = {
    waitedSec,
    feed: {
      state: feed?.state ?? null,
      eventsToday: feed?.eventsToday ?? null,
      bytesToday: feed?.bytesToday ?? null,
      lastFrameAt: feed?.lastFrameAt ?? null,
      listingsTotal: feed?.listingsTotal ?? null,
      buyListings: feed?.buyListings ?? null,
      sellListings: feed?.sellListings ?? null,
      parseFailures: feed?.parseFailures ?? null,
    },
    schema: h.schema ?? null,
    pricedbRows: h.pricedb?.rows ?? null,
    keyPrice: h.keyPrice ? { valueScrap: h.keyPrice.valueScrap, source: h.keyPrice.source, stale: h.keyPrice.stale } : null,
    requestsLastHour: (h.budgets ?? []).reduce((n, b) => n + (b.usedLastHour ?? 0), 0),
    recentRequests: { count: (h.recentRequests ?? []).length, byStatus: statuses, hosts: [...new Set((h.recentRequests ?? []).map((r) => r.host))] },
    engine: h.engine ?? null,
    connectors: (h.connectors ?? []).map((c) => ({ id: c.id, state: c.state })),
    connectorProblems,
    status: st ? { feed: st.feed, counts: st.counts, setupNeeded: st.setupNeeded, lastEngineRunAt: st.lastEngineRunAt } : null,
  };
  if (feed?.state !== 'live') errors.push(`live feed is ${feed?.state ?? 'unknown'} after ${waitedSec} s`);
  if (!((feed?.listingsTotal ?? 0) > 0)) errors.push('no backpack.tf listings were stored');
  if (!((h.schema?.items ?? 0) > 0)) errors.push('the item schema did not load');
  if (!h.keyPrice || h.keyPrice.source === 'default') errors.push('no key price from PriceDB or backpack.tf');
  if (!((h.pricedb?.rows ?? 0) > 0)) warnings.push('no PriceDB reference prices stored yet');
  for (const p of connectorProblems) warnings.push(`connector ${p}`);
  return { summary, errors, warnings };
}

// Console errors that do not indicate a broken dashboard.
const BENIGN_CONSOLE_ERRORS = [/'frame-ancestors' is ignored when delivered via a <meta> element/];

async function runSmokeTest(rt: Runtime, reportPath: string): Promise<void> {
  const startedAt = Date.now();
  const errors: string[] = [];
  const warnings: string[] = [];
  const consoleErrors: string[] = [];
  let finished = false;

  const finish = async (report: Record<string, unknown>, ok: boolean) => {
    if (finished) return;
    finished = true;
    writeReport(reportPath, { ok, ...report, durationMs: Date.now() - startedAt });
    log.info(`smoke test ${ok ? 'passed' : 'failed'}`, { errors: report['errors'] });
    await shutdown();
    app.exit(ok ? 0 : 1);
  };

  const watchdog = setTimeout(() => {
    void finish({ errors: [...errors, 'smoke test timed out'], rendererLoaded: false, status: null, health: null }, false);
  }, SMOKE_WATCHDOG_MS + args.smokeWaitSec * 1000);

  const win = rt.windows.ensureDashboard(false);
  const contents = win.webContents;
  contents.on('console-message', (event) => {
    if (event.level !== 'error') return;
    const message = clip(event.message, 300);
    if (BENIGN_CONSOLE_ERRORS.some((re) => re.test(message))) warnings.push(`renderer console: ${message}`);
    else consoleErrors.push(message);
  });
  contents.on('preload-error', (_e, _p, error) => errors.push(`preload error: ${error.message}`));
  contents.on('render-process-gone', (_e, details) => errors.push(`renderer gone: ${details.reason}`));
  const rendererLoad = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 20_000);
    contents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve(true);
    });
    contents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
      if (!isMainFrame) return;
      errors.push(`dashboard failed to load: ${description} (${code})`);
      clearTimeout(timer);
      resolve(false);
    });
  });

  let status: AppStatus | null = null;
  let health: HealthReport | null = null;
  const ready = await rt.host.whenReady(30_000);
  if (!ready) {
    const s = rt.host.status();
    errors.push(`service not ready after 30 s (state ${s.state}${s.lastError ? `, ${s.lastError}` : ''})`);
  } else {
    try {
      status = await rt.host.call('status.get', undefined);
      if (!isAppStatus(status)) errors.push('status.get returned an unexpected shape');
    } catch (err) {
      errors.push(`status.get failed: ${safeErrorMessage(err)}`);
    }
    try {
      health = await rt.host.call('health.get', undefined);
    } catch (err) {
      errors.push(`health.get failed: ${safeErrorMessage(err)}`);
    }
  }

  let live: unknown = undefined;
  if (ready && args.smokeWaitSec > 0) {
    log.info(`smoke test: running live for ${args.smokeWaitSec} s`);
    await new Promise((r) => setTimeout(r, args.smokeWaitSec * 1000));
    let h2: HealthReport | null = null;
    let s2: AppStatus | null = null;
    try {
      h2 = await rt.host.call('health.get', undefined);
      s2 = await rt.host.call('status.get', undefined);
    } catch (err) {
      errors.push(`live check failed: ${safeErrorMessage(err)}`);
    }
    const r = liveSummary(h2, s2, args.smokeWaitSec);
    live = r.summary;
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    if (s2) status = s2;
    if (h2) health = h2;
  }

  const rendererLoaded = await rendererLoad;
  if (!rendererLoaded && !errors.some((e) => e.startsWith('dashboard failed'))) {
    errors.push('dashboard did not finish loading within 20 s');
  }
  let bridge = false;
  if (rendererLoaded) {
    // Give React a moment to mount so render errors reach the console.
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const kind: unknown = await contents.executeJavaScript(
        "typeof window.flipdesk === 'object' && typeof window.flipdesk.rpc === 'function' ? window.flipdesk.windowKind : null",
      );
      bridge = kind === 'dashboard';
    } catch (err) {
      errors.push(`bridge check failed: ${safeErrorMessage(err)}`);
    }
    if (!bridge) errors.push('window.flipdesk is missing in the dashboard');
  }
  errors.push(...consoleErrors.map((m) => `renderer console error: ${m}`));
  clearTimeout(watchdog);

  await finish(
    {
      version: VERSION,
      status,
      health: summarizeHealth(health),
      ...(live !== undefined ? { live } : {}),
      rendererLoaded,
      bridge,
      service: rt.host.status(),
      errors,
      warnings,
    },
    errors.length === 0,
  );
}

// ---------------------------------------------------------------------------
// Startup and shutdown
// ---------------------------------------------------------------------------

function shutdown(): Promise<void> {
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      quitting = true;
      try {
        globalShortcut.unregisterAll();
      } catch {
        // not ready yet
      }
      runtime?.tray?.destroy();
      try {
        await runtime?.host.shutdown(2000);
      } catch (err) {
        log.warn('service shutdown failed', err);
      }
      log.info('main process shut down');
      log.flushSync();
      shutdownComplete = true;
    })();
  }
  return shutdownPromise;
}

function start(): void {
  const paths = resolveAppPaths(app.getAppPath(), app.getPath('userData'));
  mkdirSync(paths.dataDir, { recursive: true });
  log.info(`TF2 Flip Desk ${VERSION} starting`, {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    packaged: app.isPackaged,
    pid: process.pid,
    hidden: args.hidden,
    smokeTest: args.smokeTest !== null,
  });

  if (!args.dev) Menu.setApplicationMenu(null);
  hardenSession(session.defaultSession, log);
  registerAppProtocol(protocol, paths.rendererRoot, log);

  const secrets = createSecretsStore({ file: paths.secretsFile, safeStorage, log });
  log.setRedactions(Object.values(secrets.getAll()));
  if (!secrets.available()) log.warn('secure storage is not available; API keys cannot be saved');

  // Assigned below; the hotkey effect only fires after startup.
  let windows: WindowManager | null = null;
  const toggleQuick = () => windows?.toggleQuickEntry();
  const settings = createSettingsStore({
    file: paths.settingsFile,
    log,
    effects: args.smokeTest
      ? undefined
      : { applyHotkey: (next, prev) => applyHotkey(next, prev, toggleQuick), applyLoginItem },
  });

  windows = createWindowManager({
    preloadPath: paths.preload,
    iconPath: paths.iconPng,
    devTools: args.dev,
    shouldHideOnClose: () => !quitting && args.smokeTest === null && settings.get().app.closeToTray,
    isQuitting: () => quitting,
    onDashboardClosed: () => {
      if (!quitting && !settings.get().app.closeToTray) app.quit();
    },
    log,
  });

  const host = createServiceHost({
    fork: () =>
      utilityProcess.fork(paths.serviceEntry, [], {
        serviceName: 'TF2 Flip Desk service',
        stdio: 'pipe',
        // R5: no proxy variables, so fetch() leaves from the same IP as the websockets.
        env: serviceEnv(process.env),
      }),
    init: () => ({ dataDir: paths.dataDir, version: VERSION, settings: settings.get(), secrets: secrets.getAll() }),
    log,
  });

  const rt: Runtime = { paths, settings, secrets, windows, host, tray: null };
  runtime = rt;

  settings.onChange((next) => {
    host.sendSettings(next);
    rt.windows.broadcast('settings.changed', next);
    refreshTray(rt);
  });
  secrets.onChange((all) => {
    log.setRedactions(Object.values(all));
    host.sendSecrets(all);
  });
  host.onPush((event, payload) => handlePush(rt, event, payload));
  host.onState((s) => {
    refreshTray(rt);
    if (s.state === 'ready') refreshStatus(rt);
    const push = serviceStatePush(s, Date.now());
    if (push) rt.windows.broadcast('service.state', push);
  });

  const appInfo = (): AppInfo => ({
    version: VERSION,
    dataDir: paths.dataDir,
    logDir: paths.logDir,
    platform: process.platform,
    electron: process.versions.electron ?? '',
    node: process.versions.node,
  });

  registerRpcHandler(
    ipcMain,
    createRpcRouter({
      settings,
      secrets,
      service: host,
      showQuickEntry: () => rt.windows.showQuickEntry(),
      openItemInDashboard: (sku) => {
        rt.windows.hideQuickEntry();
        openItemInDashboard(rt, sku);
      },
      appInfo,
      isAllowedExternalUrl,
      openExternal: (url) => shell.openExternal(url),
      dialogs: {
        openHtmlFile: (win) =>
          pickPath(win, {
            title: 'Import a saved scrap.tf page',
            properties: ['openFile'],
            filters: [{ name: 'Saved web pages', extensions: ['html', 'htm'] }],
          }),
        openFolder: (win) =>
          pickPath(win, { title: 'Choose the folder you save pages into', properties: ['openDirectory', 'createDirectory'] }),
        saveFile: pickSavePath,
      },
      files: {
        stat: (f) => stat(f),
        readBytes: (f, maxBytes) => readFileBounded(f, maxBytes),
        writeText: (f, text) => writeFile(f, text, 'utf8'),
      },
      log,
    }),
    (event) => ({
      window: BrowserWindow.fromWebContents(event.sender),
      hideWindow: () => rt.windows.hideWindowFor(event.sender),
    }),
    log,
  );

  const trySet = (patch: unknown) => {
    try {
      settings.set(patch);
    } catch (err) {
      log.warn(`tray toggle refused: ${safeErrorMessage(err)}`);
      refreshTray(rt, true);
    }
  };
  try {
    rt.tray = createTray(
      paths.trayPng,
      {
        showDashboard: () => rt.windows.showDashboard(),
        quickEntry: () => rt.windows.showQuickEntry(),
        setLiveFeedPaused: (paused) => trySet({ liveFeed: { enabled: !paused } }),
        setNetworkPaused: (paused) => trySet({ networkPaused: paused }),
        quit: () => app.quit(),
      },
      trayState(rt),
      log,
    );
  } catch (err) {
    log.error('could not create the tray icon', err);
  }

  host.start();

  if (args.smokeTest) {
    void runSmokeTest(rt, args.smokeTest);
    return;
  }

  const hotkey: HotkeyStatus = settings.applyStartupEffects();
  refreshTray(rt);
  if (hotkey.error && Notification.isSupported()) {
    new Notification({
      title: 'Quick-entry hotkey unavailable',
      body: `${hotkey.accelerator} is already in use. Choose another shortcut in Settings.`,
      icon: paths.iconPng,
    }).show();
  }

  if (!(args.hidden || settings.get().app.startHidden)) rt.windows.showDashboard();
}

function bootstrap(): void {
  log = createMainLog({
    file: path.join(app.getPath('userData'), 'logs', 'main.log'),
    minLevel: args.dev ? 'debug' : 'info',
    echo: !app.isPackaged,
  });

  process.on('uncaughtException', (err) => log.error('uncaught exception in main', err));
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection in main', reason));

  app.on('second-instance', () => {
    if (runtime && !args.smokeTest) runtime.windows.showDashboard();
  });
  // Keep running in the tray when every window is closed or hidden.
  app.on('window-all-closed', () => undefined);
  app.on('web-contents-created', (_e, contents) => hardenWebContents(contents, log));
  app.on('child-process-gone', (_e, details) => {
    log.warn(`child process gone: ${details.type} ${details.reason}`, { name: details.name, exitCode: details.exitCode });
  });
  app.on('before-quit', (event) => {
    quitting = true;
    if (shutdownComplete) return;
    event.preventDefault();
    void shutdown().then(() => app.quit());
  });

  // The userData lock above does not cover another data directory or Windows account (§2.0: one feed per IP).
  const lock = acquireMachineLock(`${APP_USER_MODEL_ID}.instance`, { log });

  app
    .whenReady()
    .then(async () => {
      machineLock = await lock;
      if (!machineLock) {
        const reason = 'another TF2 Flip Desk instance is running on this machine';
        log.warn(`not starting: ${reason}`);
        log.flushSync();
        if (args.smokeTest) {
          writeReport(args.smokeTest, { ok: false, errors: [reason] });
        } else {
          dialog.showErrorBox(
            'TF2 Flip Desk is already running',
            'Another copy is running on this computer (for another Windows user or data folder). Only one copy may run at a time, because backpack.tf allows one live connection per IP address.',
          );
        }
        // Skips before-quit: nothing was started.
        app.exit(args.smokeTest ? 1 : 0);
        return;
      }
      start();
    })
    .catch((err: unknown) => {
      log.error('startup failed', err);
      log.flushSync();
      if (args.smokeTest) {
        writeReport(args.smokeTest, { ok: false, errors: [`startup failed: ${safeErrorMessage(err)}`] });
      } else {
        dialog.showErrorBox('TF2 Flip Desk could not start', safeErrorMessage(err));
      }
      app.exit(1);
    });
}

if (!app.requestSingleInstanceLock()) {
  if (args.smokeTest) {
    writeReport(args.smokeTest, { ok: false, errors: ['another instance is already using this user data directory'] });
    app.exit(1);
  } else {
    app.quit();
  }
} else {
  bootstrap();
}
