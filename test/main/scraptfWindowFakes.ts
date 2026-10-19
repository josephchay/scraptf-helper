// F21: Electron fakes for the scrap.tf window tests: BrowserWindow, WebContentsView and session, with a
// journal of every page move and session clear. The cookies getter throws and setUserAgent, executeJavaScript,
// sendInputEvent, insertCSS and focus are spies, so a call the window module must never make would show.
// executeJavaScriptInIsolatedWorld keeps Electron 44's own wait: asked while the main frame loads, it runs at
// did-stop-loading on whatever document is there then (ranOn records which).
// A test file mocks 'electron' with fakeElectron:
//   vi.mock('electron', async () => (await import('./scraptfWindowFakes')).fakeElectron);

import { vi } from 'vitest';

type Fn = (...args: any[]) => any;

export class Emitter {
  handlers = new Map<string, Fn[]>();
  on(event: string, fn: Fn) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  once(event: string, fn: Fn) {
    const wrap: Fn = (...args) => {
      this.handlers.set(event, (this.handlers.get(event) ?? []).filter((f) => f !== wrap));
      return fn(...args);
    };
    return this.on(event, wrap);
  }
  emit(event: string, ...args: unknown[]) {
    for (const fn of [...(this.handlers.get(event) ?? [])]) fn(...args);
  }
  count(event: string) {
    return (this.handlers.get(event) ?? []).length;
  }
}

/** Everything that moved a page or cleared a session, in order. */
export const journal: string[] = [];

export class FakeContents extends Emitter {
  url = '';
  html: unknown = '<html><head></head><body>hats v1</body></html>';
  loading = false;
  /** isLoadingMainFrame(): a main-frame navigation is under way (it is true before the commit). */
  mainFrameLoading = false;
  destroyed = false;
  closes = 0;
  canBack = false;
  canForward = false;
  sent: [string, string, unknown][] = [];
  loads: unknown[][] = [];
  openHandler: Fn | null = null;
  // Present so a call would be seen; the module must never use any of them.
  setUserAgent = vi.fn();
  executeJavaScript = vi.fn();
  sendInputEvent = vi.fn();
  insertCSS = vi.fn();
  focus = vi.fn();
  /** The documents (main frame URLs) the script actually ran on. */
  ranOn: string[] = [];
  /** What running the script gives on the document then on screen (a test may run READ_SCRIPT itself). */
  runScript: (world: number, scripts: unknown[]) => unknown = () => this.html;
  /**
   * As Electron 44 does it (waitTillCanExecuteJavaScript): with a URL and a main frame not loading, the
   * script runs at once; otherwise it waits for did-stop-loading and then runs on whatever document is
   * there, which may be another page than the one the caller checked.
   */
  executeJavaScriptInIsolatedWorld = vi.fn(async (world: number, scripts: unknown[]): Promise<unknown> => {
    if (!(this.getURL() && !this.isLoadingMainFrame())) await new Promise<void>((resolve) => this.once('did-stop-loading', () => resolve()));
    this.ranOn.push(this.mainFrame.url);
    return this.runScript(world, scripts);
  });
  navigationHistory = {
    canGoBack: () => this.canBack,
    canGoForward: () => this.canForward,
    goBack: vi.fn(() => journal.push(`back ${this.label}`)),
    goForward: vi.fn(() => journal.push(`forward ${this.label}`)),
  };
  reload = vi.fn(() => journal.push(`reload ${this.label}`));
  constructor(public label: string) {
    super();
  }
  /** The document the main frame shows when it differs from getURL() (a toolbar load still pending). */
  frameUrl: string | null = null;
  get mainFrame() {
    return { url: this.frameUrl ?? this.url };
  }
  send(channel: string, event: string, payload: unknown) {
    this.sent.push([channel, event, payload]);
  }
  loadURL(...args: unknown[]) {
    this.loads.push(args);
    journal.push(`load ${this.label} ${String(args[0])}`);
    return Promise.resolve();
  }
  getURL() {
    return this.url;
  }
  isLoading() {
    return this.loading;
  }
  isLoadingMainFrame() {
    return this.mainFrameLoading;
  }
  isDestroyed() {
    return this.destroyed;
  }
  close() {
    this.closes++;
    this.destroyed = true;
  }
  setWindowOpenHandler(fn: Fn) {
    this.openHandler = fn;
  }
}

export class FakeWin extends Emitter {
  static all: FakeWin[] = [];
  webContents = new FakeContents('toolbar');
  children: unknown[] = [];
  contentView = {
    addChildView: (v: unknown) => {
      this.children.push(v);
    },
    removeChildView: (v: unknown) => {
      this.children = this.children.filter((c) => c !== v);
    },
  };
  content = { x: 0, y: 0, width: 1280, height: 900 };
  visible = false;
  focused = false;
  destroyed = false;
  minimized = false;
  /** Its normal (not maximised) bounds: from the options, as Electron places it. */
  normal = { x: 0, y: 0, width: 1280, height: 900 };
  maximized = false;
  maximizeCalls = 0;
  constructor(public opts: Record<string, any>) {
    super();
    FakeWin.all.push(this);
    this.normal = { x: opts['x'] ?? 0, y: opts['y'] ?? 0, width: opts['width'] ?? 800, height: opts['height'] ?? 600 };
  }
  getNormalBounds() {
    return { ...this.normal };
  }
  isMaximized() {
    return this.maximized;
  }
  /** As on Windows: maximising a hidden window shows it. */
  maximize() {
    this.maximized = true;
    this.visible = true;
    this.maximizeCalls++;
  }
  loadURL(url: string) {
    return this.webContents.loadURL(url);
  }
  getContentBounds() {
    return { ...this.content };
  }
  show() {
    this.visible = true;
  }
  focus() {
    this.focused = true;
  }
  isMinimized() {
    return this.minimized;
  }
  restore() {
    this.minimized = false;
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
  close() {
    this.destroy();
  }
}

export class FakeView {
  static all: FakeView[] = [];
  webContents = new FakeContents('view');
  bounds: unknown = null;
  background: string | null = null;
  constructor(public opts: Record<string, any>) {
    FakeView.all.push(this);
  }
  setBounds(b: unknown) {
    this.bounds = b;
  }
  setBackgroundColor(c: string) {
    this.background = c;
  }
}

export class FakeSession extends Emitter {
  cookieReads = 0;
  requestHandler: Fn | null = null;
  checkHandler: Fn | null = null;
  deviceHandler: Fn | null = null;
  setUserAgent = vi.fn();
  webRequest = { onBeforeRequest: vi.fn(), onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() };
  constructor(public partition: string) {
    super();
  }
  get cookies(): never {
    this.cookieReads++;
    throw new Error('the app never reads cookies');
  }
  setPermissionRequestHandler(fn: Fn) {
    this.requestHandler = fn;
  }
  setPermissionCheckHandler(fn: Fn) {
    this.checkHandler = fn;
  }
  setDevicePermissionHandler(fn: Fn) {
    this.deviceHandler = fn;
  }
  clearStorageData(...args: unknown[]) {
    journal.push(`storage ${this.partition}${args.length > 0 ? ' (with options)' : ''}`);
    return Promise.resolve();
  }
  clearCache() {
    journal.push(`cache ${this.partition}`);
    return Promise.resolve();
  }
}

export const sessions = new Map<string, FakeSession>();
export const session = {
  fromPartition: vi.fn((p: string) => {
    let s = sessions.get(p);
    if (!s) {
      s = new FakeSession(p);
      sessions.set(p, s);
    }
    return s;
  }),
};

export const fake = { FakeWin, FakeView, FakeSession, FakeContents, sessions, session, journal };

type Rect = { x: number; y: number; width: number; height: number };

/**
 * A screen of displays (work areas), as the window bounds see it (0.7.1, F21-12): the cursor's display is the
 * one whose work area holds the cursor, else the first.
 */
export function fakeScreen(areas: Rect[], cursor = { x: 10, y: 10 }) {
  const holds = (a: Rect, p: { x: number; y: number }) => p.x >= a.x && p.x < a.x + a.width && p.y >= a.y && p.y < a.y + a.height;
  return {
    areas,
    cursor,
    getAllDisplays: () => areas.map((workArea) => ({ workArea })),
    getCursorScreenPoint: () => ({ ...cursor }),
    getDisplayNearestPoint: (p: { x: number; y: number }) => ({ workArea: areas.find((a) => holds(a, p)) ?? areas[0]! }),
  };
}

/** The 'electron' module as the window module (and windows.ts) sees it. */
export const fakeElectron = {
  BrowserWindow: FakeWin,
  WebContentsView: FakeView,
  session,
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
  },
};
