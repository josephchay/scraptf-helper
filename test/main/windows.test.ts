import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DASHBOARD_URL, QUICK_ENTRY_URL, WINDOW_KIND_ARG } from '../../src/main/paths';

const fake = vi.hoisted(() => {
  type Fn = (...args: any[]) => void;
  class Emitter {
    private handlers = new Map<string, Fn[]>();
    on(event: string, fn: Fn) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
      return this;
    }
    once(event: string, fn: Fn) {
      const wrap: Fn = (...args) => {
        this.handlers.set(event, (this.handlers.get(event) ?? []).filter((f) => f !== wrap));
        fn(...args);
      };
      return this.on(event, wrap);
    }
    emit(event: string, ...args: unknown[]) {
      for (const fn of [...(this.handlers.get(event) ?? [])]) fn(...args);
    }
    listeners(event: string) {
      return this.handlers.get(event) ?? [];
    }
  }
  class FakeWebContents extends Emitter {
    sent: unknown[][] = [];
    destroyed = false;
    devtools = false;
    send(...args: unknown[]) {
      this.sent.push(args);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isDevToolsOpened() {
      return this.devtools;
    }
  }
  class FakeWin extends Emitter {
    static all: FakeWin[] = [];
    static fromWebContents(wc: unknown) {
      return FakeWin.all.find((w) => w.webContents === wc) ?? null;
    }
    webContents = new FakeWebContents();
    visible = false;
    focused = false;
    destroyed = false;
    minimized = false;
    loaded: string | null = null;
    position: number[] = [];
    alwaysOnTop: unknown[] = [];
    constructor(public opts: Record<string, any>) {
      super();
      FakeWin.all.push(this);
    }
    loadURL(url: string) {
      this.loaded = url;
      return Promise.resolve();
    }
    show() {
      this.visible = true;
      this.focused = true;
    }
    hide() {
      this.visible = false;
      this.focused = false;
    }
    focus() {
      this.focused = true;
    }
    isVisible() {
      return this.visible;
    }
    isFocused() {
      return this.focused;
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return this.minimized;
    }
    restore() {
      this.minimized = false;
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
    setAlwaysOnTop(...args: unknown[]) {
      this.alwaysOnTop = args;
    }
    getSize() {
      return [this.opts.width, this.opts.height];
    }
    setPosition(x: number, y: number) {
      this.position = [x, y];
    }
    center() {
      this.position = [-1, -1];
    }
  }
  return { FakeWin, FakeWebContents, Emitter };
});

vi.mock('electron', () => ({
  BrowserWindow: fake.FakeWin,
  screen: {
    getCursorScreenPoint: () => ({ x: 3000, y: 100 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 1920, y: 0, width: 2560, height: 1400 } }),
  },
}));

const { createWindowManager, hardenSession, hardenWebContents, windowWebPreferences, DARK_BACKGROUND } = await import(
  '../../src/main/windows'
);

type Win = InstanceType<typeof fake.FakeWin>;
const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

beforeEach(() => {
  fake.FakeWin.all = [];
});

describe('windowWebPreferences', () => {
  it('locks down every renderer', () => {
    const p = windowWebPreferences('quick-entry', 'C:/app/dist/preload.cjs', false);
    expect(p).toMatchObject({
      preload: 'C:/app/dist/preload.cjs',
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
      devTools: false,
      additionalArguments: [`${WINDOW_KIND_ARG}quick-entry`],
    });
    expect(windowWebPreferences('dashboard', 'p', true).devTools).toBe(true);
  });
});

describe('hardenWebContents', () => {
  function contents() {
    const c = new fake.Emitter() as InstanceType<typeof fake.Emitter> & { openHandler?: (d: { url: string }) => unknown };
    (c as any).setWindowOpenHandler = (fn: (d: { url: string }) => unknown) => {
      c.openHandler = fn;
    };
    return c;
  }
  const navEvent = (url: string) => ({ url, preventDefault: vi.fn() });

  it('denies window.open and webview attachment', () => {
    const c = contents();
    hardenWebContents(c as never, log());
    expect(c.openHandler!({ url: 'https://backpack.tf/' })).toEqual({ action: 'deny' });
    const e = navEvent('');
    c.emit('will-attach-webview', e);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('allows navigation inside app://app/ only', () => {
    const c = contents();
    const l = log();
    hardenWebContents(c as never, l);
    const inside = navEvent('app://app/index.html#/journal');
    c.emit('will-navigate', inside);
    expect(inside.preventDefault).not.toHaveBeenCalled();
    for (const url of ['https://scrap.tf/', 'file:///C:/x.html', 'app://evil/', 'javascript:alert(1)']) {
      const e = navEvent(url);
      c.emit('will-navigate', e);
      expect(e.preventDefault).toHaveBeenCalled();
      const r = navEvent(url);
      c.emit('will-redirect', r);
      expect(r.preventDefault).toHaveBeenCalled();
    }
    expect(l.warn).toHaveBeenCalled();
  });
});

describe('hardenSession', () => {
  function session() {
    const s: Record<string, any> = new fake.Emitter();
    s.setPermissionRequestHandler = (fn: unknown) => (s.request = fn);
    s.setPermissionCheckHandler = (fn: unknown) => (s.check = fn);
    s.setDevicePermissionHandler = (fn: unknown) => (s.device = fn);
    s.webRequest = { onBeforeRequest: (filter: unknown, fn: unknown) => Object.assign(s, { filter, before: fn }) };
    return s;
  }

  it('denies permissions except clipboard writes from the app', () => {
    const s = session();
    hardenSession(s as never, log());
    const ask = (perm: string, url: string) => {
      let granted: boolean | null = null;
      s.request({}, perm, (g: boolean) => (granted = g), { requestingUrl: url, isMainFrame: true });
      return granted;
    };
    for (const p of ['media', 'geolocation', 'notifications', 'openExternal', 'clipboard-read', 'fullscreen', 'hid']) {
      expect(ask(p, 'app://app/index.html')).toBe(false);
    }
    expect(ask('clipboard-sanitized-write', 'app://app/index.html')).toBe(true);
    expect(ask('clipboard-sanitized-write', 'https://evil.example/')).toBe(false);
    expect(s.check({}, 'media', 'app://app', {})).toBe(false);
    expect(s.check({}, 'clipboard-sanitized-write', 'app://app', {})).toBe(true);
    expect(s.check({}, 'clipboard-sanitized-write', 'https://evil.example', {})).toBe(false);
    expect(s.device({})).toBe(false);
  });

  it('cancels downloads and renderer requests to hosts outside the image allowlist', () => {
    const s = session();
    hardenSession(s as never, log());
    const dl = { preventDefault: vi.fn() };
    s.emit('will-download', dl);
    expect(dl.preventDefault).toHaveBeenCalled();
    expect(s.filter).toEqual({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] });
    const decide = (url: string) => {
      let res: unknown;
      s.before({ url }, (r: unknown) => (res = r));
      return res;
    };
    expect(decide('https://steamcdn-a.akamaihd.net/apps/440/x.png')).toEqual({ cancel: false });
    expect(decide('https://scrap.tf/api')).toEqual({ cancel: true });
    expect(decide('wss://ws.backpack.tf/events')).toEqual({ cancel: true });
  });
});

describe('window manager', () => {
  function manager(over: { hideOnClose?: boolean; quitting?: boolean } = {}) {
    const onDashboardClosed = vi.fn();
    const wm = createWindowManager({
      preloadPath: 'C:/app/dist/preload.cjs',
      iconPath: 'C:/app/assets/icon.png',
      devTools: false,
      shouldHideOnClose: () => over.hideOnClose ?? true,
      isQuitting: () => over.quitting ?? false,
      onDashboardClosed,
      log: log(),
    });
    return { wm, onDashboardClosed };
  }

  it('creates the dashboard with the agreed geometry and shows it on ready-to-show', () => {
    const { wm } = manager();
    wm.showDashboard();
    const w = fake.FakeWin.all[0]!;
    expect(w.opts).toMatchObject({
      width: 1360,
      height: 860,
      minWidth: 960,
      minHeight: 620,
      show: false,
      backgroundColor: DARK_BACKGROUND,
    });
    expect(w.opts.webPreferences.additionalArguments).toEqual([`${WINDOW_KIND_ARG}dashboard`]);
    expect(w.loaded).toBe(DASHBOARD_URL);
    expect(w.visible).toBe(false);
    w.emit('ready-to-show');
    expect(w.visible).toBe(true);
    expect(wm.showDashboard()).toBe(w);
    expect(fake.FakeWin.all).toHaveLength(1);
  });

  it('can create the dashboard hidden and reveal it later', () => {
    const { wm } = manager();
    const w = wm.ensureDashboard(false) as unknown as Win;
    w.emit('ready-to-show');
    expect(w.visible).toBe(false);
    w.minimized = true;
    wm.showDashboard();
    expect(w.visible).toBe(true);
    expect(w.minimized).toBe(false);
  });

  it('remembers a show request made before the first paint', () => {
    const { wm } = manager();
    const w = wm.ensureDashboard(false) as unknown as Win;
    wm.showDashboard();
    expect(w.visible).toBe(false);
    w.emit('ready-to-show');
    expect(w.visible).toBe(true);
  });

  it('hides to the tray on close when configured, otherwise closes', () => {
    const hide = manager({ hideOnClose: true });
    const w = hide.wm.showDashboard() as unknown as Win;
    const ev = { preventDefault: vi.fn() };
    w.visible = true;
    w.emit('close', ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(w.visible).toBe(false);

    fake.FakeWin.all = [];
    const quit = manager({ hideOnClose: false });
    const w2 = quit.wm.showDashboard() as unknown as Win;
    const ev2 = { preventDefault: vi.fn() };
    w2.emit('close', ev2);
    expect(ev2.preventDefault).not.toHaveBeenCalled();
    w2.destroy();
    expect(quit.onDashboardClosed).toHaveBeenCalled();
    expect(quit.wm.dashboard()).toBeNull();
  });

  it('queues dashboard pushes until the page has loaded', () => {
    const { wm } = manager();
    const w = wm.ensureDashboard(false) as unknown as Win;
    wm.sendToDashboard('notify', { title: 't', body: 'b', sku: '5021;6' });
    expect(w.webContents.sent).toEqual([]);
    w.webContents.emit('did-finish-load');
    expect(w.webContents.sent).toEqual([['push', 'notify', { title: 't', body: 'b', sku: '5021;6' }]]);
    wm.sendToDashboard('opps.changed', { appeared: 1, changed: 0, gone: 0, at: 1 });
    expect(w.webContents.sent).toHaveLength(2);

    // A hash-route change keeps delivering; a reload queues until the next load.
    w.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    wm.sendToDashboard('opps.changed', { appeared: 2, changed: 0, gone: 0, at: 2 });
    expect(w.webContents.sent).toHaveLength(3);
    w.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    wm.sendToDashboard('opps.changed', { appeared: 3, changed: 0, gone: 0, at: 3 });
    expect(w.webContents.sent).toHaveLength(3);
    w.webContents.emit('did-finish-load');
    expect(w.webContents.sent).toHaveLength(4);
  });

  it('broadcasts pushes to every live window', () => {
    const { wm } = manager();
    const d = wm.ensureDashboard(false) as unknown as Win;
    wm.showQuickEntry();
    const q = fake.FakeWin.all[1]!;
    wm.broadcast('status.changed', { version: 'x' } as never);
    expect(d.webContents.sent).toEqual([['push', 'status.changed', { version: 'x' }]]);
    expect(q.webContents.sent).toEqual([['push', 'status.changed', { version: 'x' }]]);
    q.webContents.destroyed = true;
    wm.broadcast('opps.changed', { appeared: 0, changed: 0, gone: 0, at: 0 });
    expect(q.webContents.sent).toHaveLength(1);
  });

  it('creates a frameless, always-on-top quick-entry window centred on the cursor display', () => {
    const { wm } = manager();
    wm.showQuickEntry();
    const q = fake.FakeWin.all[0]!;
    expect(q.opts).toMatchObject({
      width: 460,
      height: 380,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      show: false,
    });
    expect(q.opts.webPreferences.additionalArguments).toEqual([`${WINDOW_KIND_ARG}quick-entry`]);
    expect(q.loaded).toBe(QUICK_ENTRY_URL);
    expect(q.position).toEqual([1920 + (2560 - 460) / 2, (1400 - 380) / 2]);
    expect(q.visible).toBe(false);
    q.emit('ready-to-show');
    expect(q.visible).toBe(true);
  });

  it('toggles quick entry, hides it on blur and keeps it alive on close', () => {
    const { wm } = manager();
    wm.toggleQuickEntry();
    const q = fake.FakeWin.all[0]!;
    q.emit('ready-to-show');
    expect(q.visible).toBe(true);
    wm.toggleQuickEntry();
    expect(q.visible).toBe(false);
    wm.toggleQuickEntry();
    expect(q.visible).toBe(true);
    q.emit('blur');
    expect(q.visible).toBe(false);
    wm.showQuickEntry();
    const ev = { preventDefault: vi.fn() };
    q.emit('close', ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(fake.FakeWin.all).toHaveLength(1);
  });

  it('does not hide quick entry on blur while DevTools is open', () => {
    const { wm } = manager();
    wm.showQuickEntry();
    const q = fake.FakeWin.all[0]!;
    q.emit('ready-to-show');
    q.webContents.devtools = true;
    q.emit('blur');
    expect(q.visible).toBe(true);
  });

  it('hides the window that made a call', () => {
    const { wm } = manager();
    wm.showQuickEntry();
    const q = fake.FakeWin.all[0]!;
    q.emit('ready-to-show');
    wm.hideWindowFor(q.webContents as never);
    expect(q.visible).toBe(false);
    expect(wm.windowFor(q.webContents as never)).toBe(q);
  });

  it('destroys everything on demand', () => {
    const { wm } = manager();
    wm.ensureDashboard(false);
    wm.showQuickEntry();
    wm.destroyAll();
    expect(fake.FakeWin.all.every((w) => w.destroyed)).toBe(true);
    expect(wm.dashboard()).toBeNull();
  });
});
