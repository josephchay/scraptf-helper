import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
    loads = 0;
    position: number[] = [];
    alwaysOnTop: unknown[] = [];
    constructor(public opts: Record<string, any>) {
      super();
      FakeWin.all.push(this);
    }
    loadURL(url: string) {
      this.loaded = url;
      this.loads++;
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

const { createWindowManager, hardenScraptfSession, hardenSession, hardenWebContents, refuseClientCertificate, windowWebPreferences, DARK_BACKGROUND, MAX_CRASH_RELOADS, CRASH_RELOAD_WINDOW_MS } = await import(
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

  // F21: the scrap.tf window's view has its own policy (scraptfWindowPolicy), installed by its module.
  it('leaves only the scrap.tf view to its own navigation policy, asked at event time', () => {
    const view = contents();
    const other = contents();
    let owned: unknown = null;
    const opts = { ownNavigation: (c: unknown) => c === owned };
    hardenWebContents(view as never, log(), opts);
    hardenWebContents(other as never, log(), opts);
    // 'web-contents-created' fires inside the view's constructor; the module registers it afterwards.
    owned = view;
    for (const event of ['will-navigate', 'will-redirect']) {
      const mine = navEvent('https://scrap.tf/buy/hats');
      view.emit(event, mine);
      expect(mine.preventDefault).not.toHaveBeenCalled();
      const theirs = navEvent('https://scrap.tf/buy/hats');
      other.emit(event, theirs);
      expect(theirs.preventDefault).toHaveBeenCalled();
    }
    // Webviews and window.open stay blocked for the view too (its module installs its own open handler).
    const w = navEvent('');
    view.emit('will-attach-webview', w);
    expect(w.preventDefault).toHaveBeenCalled();
    expect(view.openHandler!({ url: 'https://scrap.tf/' })).toEqual({ action: 'deny' });
  });

  it('fails closed when the ownership check throws or is absent', () => {
    const c = contents();
    hardenWebContents(c as never, log(), {
      ownNavigation: () => {
        throw new Error('gone');
      },
    });
    const e = navEvent('https://scrap.tf/');
    c.emit('will-navigate', e);
    expect(e.preventDefault).toHaveBeenCalled();
    const d = contents();
    hardenWebContents(d as never, log(), {});
    const f = navEvent('https://scrap.tf/');
    d.emit('will-redirect', f);
    expect(f.preventDefault).toHaveBeenCalled();
  });
});

describe('hardenScraptfSession (F21)', () => {
  function session() {
    const s: Record<string, any> = new fake.Emitter();
    s.setPermissionRequestHandler = (fn: unknown) => (s.request = fn);
    s.setPermissionCheckHandler = (fn: unknown) => (s.check = fn);
    s.setDevicePermissionHandler = (fn: unknown) => (s.device = fn);
    s.webRequest = { onBeforeRequest: vi.fn() };
    return s;
  }

  it('denies every permission (clipboard included) and every download, and filters no request', () => {
    const s = session();
    hardenScraptfSession(s as never, log());
    for (const p of ['media', 'geolocation', 'notifications', 'openExternal', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'hid', 'pointerLock']) {
      let granted: boolean | null = null;
      s.request({}, p, (g: boolean) => (granted = g), { requestingUrl: 'https://scrap.tf/', isMainFrame: true });
      expect(granted, p).toBe(false);
      expect(s.check({}, p, 'https://scrap.tf', {})).toBe(false);
    }
    expect(s.device({})).toBe(false);
    const dl = { preventDefault: vi.fn() };
    s.emit('will-download', dl);
    expect(dl.preventDefault).toHaveBeenCalled();
    // The page the user browses loads its own resources; the app adds no filter (and no request).
    expect(s.webRequest.onBeforeRequest).not.toHaveBeenCalled();
  });

  it('logs what a page asks for at its own rate once a minute per kind, counting the rest', () => {
    const s = session();
    const l = log();
    let t = 0;
    hardenScraptfSession(s as never, l, () => t);
    const ask = (p: string) => s.request({}, p, () => undefined, { requestingUrl: 'https://scrap.tf/', isMainFrame: true });
    for (let i = 0; i < 10_000; i++) {
      ask('notifications');
      s.emit('will-download', { preventDefault: vi.fn() });
    }
    ask('geolocation');
    expect(l.info.mock.calls.map(([m]) => m)).toEqual(['scrap.tf window: denied permission request: notifications', 'scrap.tf window: denied permission request: geolocation']);
    expect(l.warn.mock.calls.map(([m]) => m)).toEqual(['scrap.tf window: blocked a download']);
    t += 60_000;
    ask('notifications');
    expect(l.info.mock.calls.at(-1)![0]).toBe('scrap.tf window: denied permission request: notifications (and 9999 more like it since the last such line)');
    expect(l.info.mock.calls.length + l.warn.mock.calls.length).toBe(4);
  });
});

describe('refuseClientCertificate (F21)', () => {
  it('stops Electron handing the first certificate in the store to whoever asks, and goes on without one', () => {
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();
    refuseClientCertificate(event, null, 'https://evil.example/', [{ subjectName: 'CN=Jane Doe' }], callback);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]).toEqual([]);
  });

  it('is registered by main for the whole app', () => {
    const main = readFileSync(fileURLToPath(new URL('../../src/main/main.ts', import.meta.url)), 'utf8');
    expect(main).toContain("app.on('select-client-certificate', refuseClientCertificate);");
    expect(main.indexOf("app.on('select-client-certificate'")).toBeLessThan(main.indexOf('app\n    .whenReady()'));
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
  function manager(over: { hideOnClose?: boolean; quitting?: boolean; now?: () => number } = {}) {
    const onDashboardClosed = vi.fn();
    const wm = createWindowManager({
      now: over.now,
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
      height: 420,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      show: false,
    });
    expect(q.opts.webPreferences.additionalArguments).toEqual([`${WINDOW_KIND_ARG}quick-entry`]);
    expect(q.loaded).toBe(QUICK_ENTRY_URL);
    expect(q.position).toEqual([1920 + (2560 - 460) / 2, (1400 - 420) / 2]);
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

  const gone = (w: Win, reason = 'crashed') => w.webContents.emit('render-process-gone', {}, { reason, exitCode: 1 });

  it('reloads a crashed dashboard renderer and holds pushes for the new page', () => {
    const { wm, onDashboardClosed } = manager({ hideOnClose: false });
    const w = wm.showDashboard() as unknown as Win;
    w.emit('ready-to-show');
    w.webContents.emit('did-finish-load');
    expect(w.loads).toBe(1);

    gone(w, 'oom');
    expect(w.loads).toBe(2);
    expect(w.loaded).toBe(DASHBOARD_URL);
    // Same window: destroying it would quit the app when close-to-tray is off.
    expect(w.destroyed).toBe(false);
    expect(onDashboardClosed).not.toHaveBeenCalled();
    expect(wm.showDashboard()).toBe(w);

    // A notification click right after the crash reaches the reloaded page.
    wm.sendToDashboard('ui.openItem', { sku: '5021;6' });
    expect(w.webContents.sent).toEqual([]);
    w.webContents.emit('did-finish-load');
    expect(w.webContents.sent).toEqual([['push', 'ui.openItem', { sku: '5021;6' }]]);
  });

  it('does not reload after a clean exit', () => {
    const { wm } = manager();
    const w = wm.ensureDashboard(false) as unknown as Win;
    gone(w, 'clean-exit');
    expect(w.loads).toBe(1);
  });

  it('leaves a renderer that dies while the app quits alone', async () => {
    const { wm } = manager({ quitting: true });
    const w = wm.ensureDashboard(false) as unknown as Win;
    gone(w, 'killed');
    expect(w.loads).toBe(1);
    wm.showQuickEntry();
    const q = fake.FakeWin.all[1]!;
    gone(q, 'killed');
    await new Promise((r) => setImmediate(r));
    expect(q.destroyed).toBe(false);
  });

  it('caps automatic reloads of a crash-looping dashboard, then reloads when it is shown again', () => {
    let t = 1_000;
    const { wm } = manager({ now: () => t });
    const w = wm.ensureDashboard(false) as unknown as Win;
    w.emit('ready-to-show');
    for (let i = 0; i < MAX_CRASH_RELOADS; i++) gone(w);
    expect(w.loads).toBe(1 + MAX_CRASH_RELOADS);
    gone(w);
    expect(w.loads).toBe(1 + MAX_CRASH_RELOADS);

    // Showing it is the user's request, not a loop.
    wm.showDashboard();
    expect(w.loads).toBe(2 + MAX_CRASH_RELOADS);
    expect(w.visible).toBe(true);
    wm.showDashboard();
    expect(w.loads).toBe(2 + MAX_CRASH_RELOADS);

    t += CRASH_RELOAD_WINDOW_MS;
    gone(w);
    expect(w.loads).toBe(3 + MAX_CRASH_RELOADS);
  });

  it('shows a dashboard whose renderer died before its first paint', () => {
    const { wm } = manager();
    const w = wm.showDashboard() as unknown as Win;
    expect(w.visible).toBe(false);
    gone(w);
    expect(w.visible).toBe(true);
    expect(w.loads).toBe(2);
  });

  it('replaces a crashed quick-entry window with a fresh one on the next show', async () => {
    const { wm } = manager();
    wm.showQuickEntry();
    const q = fake.FakeWin.all[0]!;
    q.emit('ready-to-show');
    gone(q, 'oom');
    await new Promise((r) => setImmediate(r));
    expect(q.destroyed).toBe(true);

    wm.toggleQuickEntry();
    expect(fake.FakeWin.all).toHaveLength(2);
    const fresh = fake.FakeWin.all[1]!;
    expect(fresh.loaded).toBe(QUICK_ENTRY_URL);
    fresh.emit('ready-to-show');
    expect(fresh.visible).toBe(true);

    gone(fresh, 'clean-exit');
    await new Promise((r) => setImmediate(r));
    expect(fresh.destroyed).toBe(false);
  });

  it('destroys everything on demand', () => {
    const { wm } = manager();
    wm.ensureDashboard(false);
    wm.showQuickEntry();
    wm.destroyAll();
    expect(fake.FakeWin.all.every((w) => w.destroyed)).toBe(true);
    expect(wm.dashboard()).toBeNull();
  });

  it('prefills quick entry: held until the page loads, then sent at once; the latest show wins', () => {
    const { wm } = manager();
    wm.showQuickEntry('378;6');
    const q = fake.FakeWin.all[0]!;
    expect(q.webContents.sent).toEqual([]);
    // A plain show (hotkey) before the page loads drops the waiting prefill.
    wm.showQuickEntry();
    wm.showQuickEntry('5021;6');
    q.emit('ready-to-show');
    q.webContents.emit('did-finish-load');
    expect(q.webContents.sent).toEqual([['push', 'ui.quickPrefill', { sku: '5021;6' }]]);
    q.webContents.emit('did-finish-load');
    expect(q.webContents.sent).toHaveLength(1);

    wm.showQuickEntry('30359;6');
    expect(q.webContents.sent[1]).toEqual(['push', 'ui.quickPrefill', { sku: '30359;6' }]);
    wm.showQuickEntry();
    expect(q.webContents.sent).toHaveLength(2);
    expect(q.visible).toBe(true);

    // A full reload holds the next prefill again.
    q.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    wm.showQuickEntry('378;6');
    expect(q.webContents.sent).toHaveLength(2);
    q.webContents.emit('did-finish-load');
    expect(q.webContents.sent[2]).toEqual(['push', 'ui.quickPrefill', { sku: '378;6' }]);
  });

  it('never sends a prefill to the dashboard', () => {
    const { wm } = manager();
    const d = wm.showDashboard() as unknown as Win;
    d.emit('ready-to-show');
    d.webContents.emit('did-finish-load');
    wm.showQuickEntry('378;6');
    const q = fake.FakeWin.all[1]!;
    q.webContents.emit('did-finish-load');
    expect(d.webContents.sent).toEqual([]);
    expect(q.webContents.sent).toEqual([['push', 'ui.quickPrefill', { sku: '378;6' }]]);
  });
});
