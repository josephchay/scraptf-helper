// Dashboard and quick-entry windows, plus the hardening applied to every
// webContents and to the default session.

import { BrowserWindow, screen, type Session, type WebContents, type WebPreferences } from 'electron';
import type { Logger } from '../service/contracts';
import type { PushContract, PushEvent } from '../shared/rpc';
import {
  APP_ORIGIN,
  DASHBOARD_URL,
  isAllowedRendererRequest,
  isAppNavigationUrl,
  isTrustedSenderUrl,
  QUICK_ENTRY_URL,
  WINDOW_KIND_ARG,
  type WindowKind,
} from './paths';

/** Window background before the dashboard paints; matches the dark theme. */
export const DARK_BACKGROUND = '#111318';

export interface WindowManagerOptions {
  preloadPath: string;
  iconPath: string;
  devTools: boolean;
  /** Close-to-tray applies (setting on and not quitting). */
  shouldHideOnClose(): boolean;
  isQuitting(): boolean;
  /** The dashboard window was really closed (not hidden to the tray). */
  onDashboardClosed(): void;
  log: Logger;
  /** Clock for the crash-reload cap (tests). */
  now?: () => number;
}

/** Automatic reloads of a crashed dashboard renderer per window of time, so a crash loop cannot spin. */
export const MAX_CRASH_RELOADS = 3;
export const CRASH_RELOAD_WINDOW_MS = 60_000;

export interface WindowManager {
  /** Shows (creating if needed) and focuses the dashboard. */
  showDashboard(): BrowserWindow;
  /** Creates the dashboard if missing; shows it only when `show`. */
  ensureDashboard(show: boolean): BrowserWindow;
  dashboard(): BrowserWindow | null;
  toggleQuickEntry(): void;
  /** With a SKU, pushes 'ui.quickPrefill' to the quick-entry page once it has loaded (the latest SKU wins). */
  showQuickEntry(prefillSku?: string): void;
  hideQuickEntry(): void;
  broadcast<E extends PushEvent>(event: E, payload: PushContract[E]): void;
  /** Delivers to the dashboard after its page has finished loading. */
  sendToDashboard<E extends PushEvent>(event: E, payload: PushContract[E]): void;
  windowFor(contents: WebContents): BrowserWindow | null;
  hideWindowFor(contents: WebContents): void;
  destroyAll(): void;
}

export function windowWebPreferences(kind: WindowKind, preloadPath: string, devTools: boolean): WebPreferences {
  return {
    preload: preloadPath,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    spellcheck: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    devTools,
    additionalArguments: [`${WINDOW_KIND_ARG}${kind}`],
  };
}

/** Applied to every webContents (app 'web-contents-created'). */
export function hardenWebContents(contents: WebContents, log: Logger): void {
  contents.setWindowOpenHandler(({ url }) => {
    log.warn('blocked window.open', { url: url.slice(0, 200) });
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-navigate', (event) => {
    if (isAppNavigationUrl(event.url)) return;
    event.preventDefault();
    log.warn('blocked navigation', { url: event.url.slice(0, 200) });
  });
  contents.on('will-redirect', (event) => {
    if (isAppNavigationUrl(event.url)) return;
    event.preventDefault();
    log.warn('blocked redirect', { url: event.url.slice(0, 200) });
  });
}

/**
 * Denies every permission except sanitized clipboard writes from our own
 * pages (copy-to-clipboard buttons), blocks downloads and any renderer
 * http(s)/ws(s) request other than the CSP image hosts.
 */
export function hardenSession(ses: Session, log: Logger): void {
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const allowed = permission === 'clipboard-sanitized-write' && isTrustedSenderUrl(details.requestingUrl);
    if (!allowed) log.info(`denied permission request: ${permission}`);
    callback(allowed);
  });
  ses.setPermissionCheckHandler(
    (_wc, permission, requestingOrigin) => permission === 'clipboard-sanitized-write' && requestingOrigin === APP_ORIGIN,
  );
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (event) => {
    event.preventDefault();
    log.warn('blocked a download started by a renderer');
  });
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    const allowed = isAllowedRendererRequest(details.url);
    if (!allowed) log.warn('blocked renderer network request', { url: details.url.slice(0, 200) });
    callback({ cancel: !allowed });
  });
}

export function createWindowManager(opts: WindowManagerOptions): WindowManager {
  const { log } = opts;
  let dashboardWin: BrowserWindow | null = null;
  let dashboardLoaded = false;
  // Before ready-to-show, a show request is remembered instead of showing a blank window.
  let dashboardPainted = false;
  let dashboardWantShow = false;
  let dashboardQueue: [PushEvent, unknown][] = [];
  // Renderer died and the reload cap stopped the automatic reload; the next show reloads it.
  let dashboardCrashed = false;
  let crashReloads: number[] = [];
  let quickWin: BrowserWindow | null = null;
  // A prefill asked for before the quick-entry page finished loading is sent on 'did-finish-load'.
  let quickLoaded = false;
  let quickPrefill: string | null = null;
  const now = opts.now ?? Date.now;

  function live(win: BrowserWindow | null): win is BrowserWindow {
    return win !== null && !win.isDestroyed();
  }

  function reloadDashboard(win: BrowserWindow): void {
    dashboardCrashed = false;
    dashboardLoaded = false;
    win.loadURL(DASHBOARD_URL).catch((err: unknown) => log.error('dashboard failed to reload', err));
  }

  function onDashboardGone(win: BrowserWindow, reason: string): void {
    // While quitting the renderer may be torn down on purpose; reloading would only slow the exit.
    if (reason === 'clean-exit' || opts.isQuitting() || dashboardWin !== win || win.isDestroyed()) return;
    // Electron keeps the window: without a reload it stays blank and pushes go to a dead page.
    // Not destroyed instead, because 'closed' quits the app when close-to-tray is off.
    dashboardLoaded = false;
    if (!dashboardPainted) {
      // ready-to-show may never come for the dead page; show the (dark) window while it reloads.
      dashboardPainted = true;
      if (dashboardWantShow) win.show();
    }
    const t = now();
    crashReloads = crashReloads.filter((at) => t - at < CRASH_RELOAD_WINDOW_MS);
    if (crashReloads.length >= MAX_CRASH_RELOADS) {
      dashboardCrashed = true;
      log.error('dashboard renderer keeps crashing; it reloads when the dashboard is shown again');
      return;
    }
    crashReloads.push(t);
    reloadDashboard(win);
  }

  function send(win: BrowserWindow | null, event: PushEvent, payload: unknown): void {
    if (!live(win) || win.webContents.isDestroyed()) return;
    try {
      win.webContents.send('push', event, payload);
    } catch (err) {
      log.warn(`could not deliver ${event} to a window`, err);
    }
  }

  function ensureDashboard(show: boolean): BrowserWindow {
    if (live(dashboardWin)) {
      // A user asking for the window is not a crash loop, so this ignores the reload cap.
      if (show && dashboardCrashed) reloadDashboard(dashboardWin);
      if (show) reveal(dashboardWin);
      return dashboardWin;
    }
    const win = new BrowserWindow({
      width: 1360,
      height: 860,
      minWidth: 960,
      minHeight: 620,
      show: false,
      title: 'TF2 Flip Desk',
      backgroundColor: DARK_BACKGROUND,
      icon: opts.iconPath,
      autoHideMenuBar: true,
      webPreferences: windowWebPreferences('dashboard', opts.preloadPath, opts.devTools),
    });
    dashboardWin = win;
    dashboardLoaded = false;
    dashboardPainted = false;
    dashboardWantShow = show;
    dashboardCrashed = false;

    win.once('ready-to-show', () => {
      if (dashboardWin !== win) return;
      dashboardPainted = true;
      if (dashboardWantShow && !win.isDestroyed()) win.show();
    });
    win.webContents.on('did-start-navigation', (event) => {
      // Hash-route changes are same-document and keep the page (and its listeners) alive.
      if (event.isMainFrame && !event.isSameDocument) dashboardLoaded = false;
    });
    win.webContents.on('did-finish-load', () => {
      dashboardLoaded = true;
      const queued = dashboardQueue;
      dashboardQueue = [];
      for (const [event, payload] of queued) send(win, event, payload);
    });
    win.on('close', (event) => {
      if (opts.shouldHideOnClose()) {
        event.preventDefault();
        win.hide();
      }
    });
    win.on('closed', () => {
      if (dashboardWin === win) {
        dashboardWin = null;
        dashboardLoaded = false;
        dashboardQueue = [];
      }
      opts.onDashboardClosed();
    });
    win.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (isMainFrame) log.error(`dashboard failed to load: ${description} (${code})`, { url: url.slice(0, 200) });
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      log.error(`dashboard renderer gone: ${details.reason}`, { exitCode: details.exitCode });
      onDashboardGone(win, details.reason);
    });
    win.webContents.on('preload-error', (_e, _path, error) => {
      log.error('dashboard preload error', { message: error.message });
    });

    win.loadURL(DASHBOARD_URL).catch((err: unknown) => log.error('dashboard failed to load', err));
    return win;
  }

  function reveal(win: BrowserWindow): void {
    if (!dashboardPainted) {
      dashboardWantShow = true;
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function ensureQuick(): { win: BrowserWindow; fresh: boolean } {
    if (live(quickWin)) return { win: quickWin, fresh: false };
    const win = new BrowserWindow({
      width: 460,
      // Room for the live preview (sells for, pay up to, profit, links) below the form.
      height: 420,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      title: 'Quick entry',
      backgroundColor: DARK_BACKGROUND,
      icon: opts.iconPath,
      webPreferences: windowWebPreferences('quick-entry', opts.preloadPath, opts.devTools),
    });
    win.setAlwaysOnTop(true, 'floating');
    win.on('blur', () => {
      if (!win.isDestroyed() && !win.webContents.isDevToolsOpened()) win.hide();
    });
    win.on('close', (event) => {
      if (!opts.isQuitting()) {
        event.preventDefault();
        win.hide();
      }
    });
    win.on('closed', () => {
      if (quickWin === win) {
        quickWin = null;
        quickLoaded = false;
        quickPrefill = null;
      }
    });
    win.webContents.on('did-start-navigation', (event) => {
      if (quickWin === win && event.isMainFrame && !event.isSameDocument) quickLoaded = false;
    });
    win.webContents.on('did-finish-load', () => {
      if (quickWin !== win) return;
      quickLoaded = true;
      const sku = quickPrefill;
      quickPrefill = null;
      if (sku !== null) send(win, 'ui.quickPrefill', { sku });
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      log.error(`quick-entry renderer gone: ${details.reason}`, { exitCode: details.exitCode });
      if (details.reason === 'clean-exit' || opts.isQuitting()) return;
      // A dead page can be neither used nor hidden with Esc. The next show builds a fresh
      // window (only on a user's hotkey or click, so a crash loop cannot spin).
      if (quickWin === win) {
        quickWin = null;
        quickLoaded = false;
        quickPrefill = null;
      }
      setImmediate(() => {
        if (!win.isDestroyed()) win.destroy();
      });
    });
    quickWin = win;
    quickLoaded = false;
    win.loadURL(QUICK_ENTRY_URL).catch((err: unknown) => log.error('quick entry failed to load', err));
    return { win, fresh: true };
  }

  function centreOnCursorDisplay(win: BrowserWindow): void {
    try {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const [w = 460, h = 420] = win.getSize();
      win.setPosition(Math.round(area.x + (area.width - w) / 2), Math.round(area.y + (area.height - h) / 2));
    } catch {
      win.center();
    }
  }

  function showQuickEntry(prefillSku?: string): void {
    const { win, fresh } = ensureQuick();
    centreOnCursorDisplay(win);
    const reveal = () => {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
    };
    if (fresh) win.once('ready-to-show', reveal);
    else reveal();
    const sku = typeof prefillSku === 'string' && prefillSku !== '' ? prefillSku : null;
    // The latest show wins: a plain show (hotkey) drops a prefill still waiting for the page.
    if (!quickLoaded) quickPrefill = sku;
    else if (sku !== null) send(win, 'ui.quickPrefill', { sku });
  }

  function hideQuickEntry(): void {
    if (live(quickWin) && quickWin.isVisible()) quickWin.hide();
  }

  return {
    showDashboard: () => ensureDashboard(true),
    ensureDashboard,
    dashboard: () => (live(dashboardWin) ? dashboardWin : null),
    toggleQuickEntry() {
      if (live(quickWin) && quickWin.isVisible() && quickWin.isFocused()) hideQuickEntry();
      else showQuickEntry();
    },
    showQuickEntry,
    hideQuickEntry,
    broadcast(event, payload) {
      send(dashboardWin, event, payload);
      send(quickWin, event, payload);
    },
    sendToDashboard(event, payload) {
      if (live(dashboardWin) && dashboardLoaded) send(dashboardWin, event, payload);
      else if (live(dashboardWin)) dashboardQueue.push([event, payload]);
    },
    windowFor(contents) {
      return BrowserWindow.fromWebContents(contents);
    },
    hideWindowFor(contents) {
      const win = BrowserWindow.fromWebContents(contents);
      if (win && !win.isDestroyed()) win.hide();
    },
    destroyAll() {
      for (const win of [quickWin, dashboardWin]) if (live(win)) win.destroy();
      quickWin = null;
      dashboardWin = null;
    },
  };
}
