// F21 for the browser mock: the scrap.tf window's main methods, validated as main validates them, over a
// fake history of static start pages. Nothing is loaded, fetched or read: there is no scrap.tf view in a
// plain browser, and every "read" is a made-up status line for the toolbar demo at '#/scraptf-bar'.

import type { PushContract, PushEvent, RpcResult } from '../shared/rpc';
import { SCRAPTF_BANKS, SCRAPTF_HOME_URL } from '../shared/links';
import { scraptfImportablePath } from '../shared/scraptfPaths';
import {
  isAllowedWindowStart,
  READ_MANUAL_MIN_GAP_MS,
  SCRAPTF_READ_REASONS,
  SCRAPTF_WINDOW_OFF,
  scraptfPathOf,
  shouldReadUrl,
  windowDisplayUrl,
} from '../shared/scraptfWindowPolicy';
import type { ScraptfReadOutcome, ScraptfWindowRead, ScraptfWindowState, Settings, UnixMs } from '../shared/types';

/** The mock never parses a page; the status line says so. */
export const MOCK_WINDOW_READ_WARNING = 'Mock mode: nothing is read in the browser preview.';
const START_REFUSAL = 'not a scrap.tf page the window opens';

export interface MockScraptfWindowDeps {
  now(): UnixMs;
  settings(): Settings;
  emit<E extends PushEvent>(event: E, payload: PushContract[E]): void;
  /** Fake item counts per page, so the demo's status line varies. */
  itemsOn?(url: string): number;
  /** 0.7.1: the demo's best flip on a page (an item of the mock's own data), or null. */
  bestFlipOn?(url: string): ScraptfWindowRead['bestFlip'];
}

export interface MockScraptfWindow {
  open(p: { start?: string } | void | null | undefined): RpcResult<'scraptfWindow.open'>;
  back(): RpcResult<'scraptfWindow.back'>;
  forward(): RpcResult<'scraptfWindow.forward'>;
  reload(): RpcResult<'scraptfWindow.reload'>;
  home(): RpcResult<'scraptfWindow.home'>;
  go(p: { url?: unknown } | null | undefined): RpcResult<'scraptfWindow.go'>;
  read(): ScraptfReadOutcome;
  clear(): RpcResult<'scraptfWindow.clear'>;
  state(): ScraptfWindowState;
  /** links.open with openLinksInWindow: true when the mock window took the URL. */
  openFromLink(url: string): boolean;
}

export function createMockScraptfWindow(deps: MockScraptfWindowDeps): MockScraptfWindow {
  let open = false;
  let history: string[] = [];
  let at = -1;
  let lastRead: ScraptfWindowRead | null = null;
  let lastManualAt = Number.NEGATIVE_INFINITY;

  const requireOn = (): void => {
    if (!deps.settings().scraptfWindow.enabled) throw new Error(SCRAPTF_WINDOW_OFF);
  };
  const startUrl = (method: string, key: string, v: unknown): string => {
    if (!isAllowedWindowStart(v)) throw new Error(`Invalid parameters for ${method}: ${key}: ${START_REFUSAL}`);
    return v;
  };
  const current = (): string | null => (at >= 0 ? (history[at] ?? null) : null);

  function emitNav(): void {
    const url = current();
    // Like main (F21-4): Read page now is offered only on pages the import reads.
    deps.emit('scraptfWindow.nav', { url: windowDisplayUrl(url), canGoBack: at > 0, canGoForward: at < history.length - 1, loading: false, importable: url !== null && scraptfImportablePath(url), notice: null });
  }

  function takeRead(url: string): ScraptfWindowRead {
    const bank = SCRAPTF_BANKS.find((b) => b.url === url)?.bank ?? null;
    const items = deps.itemsOn?.(url) ?? (bank === null ? 0 : 24);
    const newFlips = bank === null ? 0 : Math.min(3, Math.floor(items / 12));
    // Made up like the rest: a few more flips on the page than new ones, and the mock's own best item.
    const pageFlips = bank === null ? 0 : Math.min(items, newFlips + Math.floor(items / 8));
    const read: ScraptfWindowRead = {
      at: deps.now(),
      path: scraptfPathOf(url),
      items,
      bank,
      newFlips,
      warning: MOCK_WINDOW_READ_WARNING,
      stored: items,
      pageFlips,
      bestFlip: pageFlips > 0 ? (deps.bestFlipOn?.(url) ?? null) : null,
    };
    lastRead = read;
    deps.emit('scraptfWindow.read', read);
    return read;
  }

  /** Main reads after a load the user made when readOnLoad is on, on pages the import reads; the mock too, at once. */
  function loaded(): void {
    emitNav();
    const url = current();
    if (url !== null && deps.settings().scraptfWindow.readOnLoad && shouldReadUrl(url) && scraptfImportablePath(url)) takeRead(url);
  }

  function navigate(url: string): void {
    open = true;
    history = [...history.slice(0, at + 1), url];
    at = history.length - 1;
    loaded();
  }

  return {
    open(p) {
      requireOn();
      const start = p && typeof p === 'object' && p.start !== undefined ? startUrl('scraptfWindow.open', 'start', p.start) : null;
      // Like main (F21-7): the page already on screen is not loaded again.
      if (start !== null && !(open && current() === start)) navigate(start);
      else if (!open) navigate(SCRAPTF_HOME_URL);
      return { ok: true };
    },
    back() {
      requireOn();
      if (open && at > 0) {
        at--;
        loaded();
      }
      return { ok: true };
    },
    forward() {
      requireOn();
      if (open && at < history.length - 1) {
        at++;
        loaded();
      }
      return { ok: true };
    },
    reload() {
      requireOn();
      if (open) loaded();
      return { ok: true };
    },
    home() {
      requireOn();
      navigate(SCRAPTF_HOME_URL);
      return { ok: true };
    },
    go(p) {
      requireOn();
      navigate(startUrl('scraptfWindow.go', 'url', p && typeof p === 'object' ? p.url : undefined));
      return { ok: true };
    },
    read() {
      requireOn();
      const url = current();
      if (!open || url === null) return { read: null, reason: SCRAPTF_READ_REASONS.notOpen };
      if (!shouldReadUrl(url)) return { read: null, reason: SCRAPTF_READ_REASONS.notScraptf };
      if (!scraptfImportablePath(url)) return { read: null, reason: SCRAPTF_READ_REASONS.notImportable };
      const t = deps.now();
      if (t - lastManualAt < READ_MANUAL_MIN_GAP_MS) return { read: null, reason: SCRAPTF_READ_REASONS.tooSoon };
      lastManualAt = t;
      return { read: takeRead(url), reason: null };
    },
    clear() {
      lastRead = null;
      // Like main: the toolbar drops its read, whichever page asked for the clear.
      deps.emit('scraptfWindow.read', null);
      if (open) {
        history = [SCRAPTF_HOME_URL];
        at = 0;
        emitNav();
      }
      return { ok: true };
    },
    state() {
      const url = current();
      return { open, url: windowDisplayUrl(url), canGoBack: at > 0, canGoForward: at < history.length - 1, lastRead };
    },
    openFromLink(url) {
      const s = deps.settings().scraptfWindow;
      if (!s.enabled || !s.openLinksInWindow || !isAllowedWindowStart(url)) return false;
      // Like main (F21-7): a link to the page on screen only brings the window up.
      if (!(open && current() === url)) navigate(url);
      return true;
    },
  };
}
