// F16 check popup window (window kind 'check'): same webPreferences lockdown and trusted app:// page
// as every window, bottom-right of the cursor's display, 'ui.checkShow' held until the page loads
// (latest wins), focus for the hotkey and showInactive for the watcher; plus the quick-entry prefill
// that now carries price text.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_URL, isAppNavigationUrl, isTrustedSenderUrl, WINDOW_KIND_ARG, WINDOW_KINDS } from '../../src/main/paths';
import { blankCheckResult } from '../../src/shared/check';

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
  }
  class FakeWebContents extends Emitter {
    sent: unknown[][] = [];
    destroyed = false;
    send(...args: unknown[]) {
      this.sent.push(args);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isDevToolsOpened() {
      return false;
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
    loaded: string | null = null;
    position: number[] = [];
    alwaysOnTop: unknown[] = [];
    shows: string[] = [];
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
      this.shows.push('show');
    }
    showInactive() {
      this.visible = true;
      this.shows.push('inactive');
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
      return false;
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
  return { FakeWin };
});

vi.mock('electron', () => ({
  BrowserWindow: fake.FakeWin,
  screen: {
    getCursorScreenPoint: () => ({ x: 3000, y: 100 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 1920, y: 0, width: 2560, height: 1400 } }),
  },
}));

const { createWindowManager, windowWebPreferences, checkPopupPosition, CHECK_POPUP_WIDTH, CHECK_POPUP_HEIGHT, CHECK_POPUP_MARGIN } = await import('../../src/main/windows');

type Win = InstanceType<typeof fake.FakeWin>;

function manager(quitting = false) {
  return createWindowManager({
    preloadPath: 'C:/app/dist/preload.cjs',
    iconPath: 'C:/app/assets/icon.png',
    devTools: false,
    shouldHideOnClose: () => true,
    isQuitting: () => quitting,
    onDashboardClosed: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

const result = (id: number) => ({ ...blankCheckResult('not-item', 'No TF2 item recognised in that text.', 'watch', 1_000, id), id });

beforeEach(() => {
  fake.FakeWin.all = [];
});

describe('window kind check', () => {
  it('is a known kind whose page is a trusted app:// page', () => {
    // F21 adds the scrap.tf window's toolbar page ('scraptf').
    expect(WINDOW_KINDS).toEqual(['dashboard', 'quick-entry', 'check', 'scraptf']);
    expect(CHECK_URL).toBe('app://app/index.html#/check');
    expect(isTrustedSenderUrl(CHECK_URL)).toBe(true);
    expect(isAppNavigationUrl(CHECK_URL)).toBe(true);
    expect(isTrustedSenderUrl('https://scrap.tf/#/check')).toBe(false);
  });

  it('gets the same locked-down webPreferences as every window', () => {
    const quick = windowWebPreferences('quick-entry', 'p', false);
    const check = windowWebPreferences('check', 'p', false);
    expect({ ...check, additionalArguments: [] }).toEqual({ ...quick, additionalArguments: [] });
    expect(check).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false });
    expect(check.additionalArguments).toEqual([`${WINDOW_KIND_ARG}check`]);
  });
});

describe('checkPopupPosition', () => {
  it('puts the popup in the bottom-right of the work area, inside it', () => {
    expect(checkPopupPosition({ x: 1920, y: 0, width: 2560, height: 1400 }, 380, 220)).toEqual({ x: 1920 + 2560 - 380 - 16, y: 1400 - 220 - 16 });
    expect(checkPopupPosition({ x: 0, y: 40, width: 300, height: 100 }, 380, 220)).toEqual({ x: 0, y: 40 });
  });
});

describe('check popup', () => {
  it('is small, frameless, always on top and off the taskbar, placed bottom-right of the cursor display', () => {
    const wm = manager();
    wm.showCheck(result(1), { focus: false });
    const w = fake.FakeWin.all[0]!;
    expect(w.opts).toMatchObject({
      width: CHECK_POPUP_WIDTH,
      height: CHECK_POPUP_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
    });
    expect(w.opts.webPreferences.additionalArguments).toEqual([`${WINDOW_KIND_ARG}check`]);
    expect(w.loaded).toBe(CHECK_URL);
    expect(w.position).toEqual([1920 + 2560 - CHECK_POPUP_WIDTH - CHECK_POPUP_MARGIN, 1400 - CHECK_POPUP_HEIGHT - CHECK_POPUP_MARGIN]);
    expect(wm.checkWindow()).toBe(w);
  });

  it('waits for the first paint, then shows inactive for the watcher and focused for the hotkey', () => {
    const wm = manager();
    wm.showCheck(result(1), { focus: false });
    const w = fake.FakeWin.all[0]!;
    expect(w.visible).toBe(false);
    w.emit('ready-to-show');
    expect(w.shows).toEqual(['inactive']);
    expect(w.focused).toBe(false);
    wm.showCheck(result(2), { focus: true });
    expect(w.shows).toEqual(['inactive', 'show']);
    expect(w.focused).toBe(true);
    expect(fake.FakeWin.all).toHaveLength(1);
  });

  it('a hotkey show before the first paint still focuses it', () => {
    const wm = manager();
    wm.showCheck(result(1), { focus: true });
    wm.showCheck(result(2), { focus: false });
    const w = fake.FakeWin.all[0]!;
    w.emit('ready-to-show');
    expect(w.shows).toEqual(['show']);
  });

  it('holds ui.checkShow until the page loads (the latest wins), then sends at once', () => {
    const wm = manager();
    wm.showCheck(result(1), { focus: false });
    wm.showCheck(result(2), { focus: false });
    const w = fake.FakeWin.all[0]!;
    expect(w.webContents.sent).toEqual([]);
    w.webContents.emit('did-finish-load');
    expect(w.webContents.sent).toEqual([['push', 'ui.checkShow', result(2)]]);
    wm.showCheck(result(3), { focus: false });
    expect(w.webContents.sent[1]).toEqual(['push', 'ui.checkShow', result(3)]);
    w.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    wm.showCheck(result(4), { focus: false });
    expect(w.webContents.sent).toHaveLength(2);
    w.webContents.emit('did-finish-load');
    expect(w.webContents.sent[2]).toEqual(['push', 'ui.checkShow', result(4)]);
  });

  it('never sends ui.checkShow to the dashboard or quick entry, but broadcasts reach it', () => {
    const wm = manager();
    const d = wm.ensureDashboard(false) as unknown as Win;
    d.webContents.emit('did-finish-load');
    wm.showQuickEntry();
    const q = fake.FakeWin.all[1]!;
    q.webContents.emit('did-finish-load');
    wm.showCheck(result(1), { focus: false });
    const c = fake.FakeWin.all[2]!;
    c.webContents.emit('did-finish-load');
    expect(d.webContents.sent).toEqual([]);
    expect(q.webContents.sent).toEqual([]);
    wm.broadcast('prices.changed', { at: 5 });
    expect(c.webContents.sent.at(-1)).toEqual(['push', 'prices.changed', { at: 5 }]);
  });

  it('hides on request and on close, never on blur; is rebuilt after its renderer dies', async () => {
    const wm = manager();
    wm.showCheck(result(1), { focus: true });
    const w = fake.FakeWin.all[0]!;
    w.emit('ready-to-show');
    w.emit('blur');
    expect(w.visible).toBe(true);
    const ev = { preventDefault: vi.fn() };
    w.emit('close', ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(w.visible).toBe(false);
    wm.showCheck(result(2), { focus: true });
    wm.hideCheck();
    expect(w.visible).toBe(false);

    w.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await new Promise((r) => setImmediate(r));
    expect(w.destroyed).toBe(true);
    expect(wm.checkWindow()).toBeNull();
    wm.showCheck(result(3), { focus: false });
    expect(fake.FakeWin.all).toHaveLength(2);
  });

  it('is destroyed with everything else', () => {
    const wm = manager();
    wm.showCheck(result(1), { focus: false });
    wm.destroyAll();
    expect(fake.FakeWin.all.every((w) => w.destroyed)).toBe(true);
    expect(wm.checkWindow()).toBeNull();
  });
});

describe('quick entry prefill with price text (F16)', () => {
  it('sends { sku, price } when a price rides along, and exactly { sku } otherwise', () => {
    const wm = manager();
    wm.showQuickEntry('378;6', '1 key 5.33 ref');
    const q = fake.FakeWin.all[0]!;
    q.webContents.emit('did-finish-load');
    expect(q.webContents.sent).toEqual([['push', 'ui.quickPrefill', { sku: '378;6', price: '1 key 5.33 ref' }]]);
    wm.showQuickEntry('378;6');
    expect(q.webContents.sent[1]).toEqual(['push', 'ui.quickPrefill', { sku: '378;6' }]);
    expect(Object.keys(q.webContents.sent[1]![2] as object)).toEqual(['sku']);
    // A price alone means nothing: it is dropped.
    wm.showQuickEntry(undefined, '5 ref');
    expect(q.webContents.sent).toHaveLength(2);
  });
});
