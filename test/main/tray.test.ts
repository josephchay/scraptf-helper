import { describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import type { TrayActions, TrayState } from '../../src/main/tray';
import type { AppStatus } from '../../src/shared/types';

const fake = vi.hoisted(() => {
  class FakeTray {
    static last: FakeTray | null = null;
    tooltip = '';
    menu: unknown = null;
    menuSets = 0;
    destroyed = false;
    handlers = new Map<string, () => void>();
    constructor(public image: unknown) {
      FakeTray.last = this;
    }
    on(event: string, fn: () => void) {
      this.handlers.set(event, fn);
    }
    setToolTip(t: string) {
      this.tooltip = t;
    }
    setContextMenu(m: unknown) {
      this.menu = m;
      this.menuSets++;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return { FakeTray, empty: false };
});

vi.mock('electron', () => ({
  Tray: fake.FakeTray,
  Menu: { buildFromTemplate: (t: unknown) => ({ template: t }) },
  nativeImage: { createFromPath: (p: string) => ({ path: p, isEmpty: () => fake.empty }) },
}));

const { createTray, menuKey, trayMenuTemplate, trayTooltip } = await import('../../src/main/tray');

const status = (over: Partial<AppStatus> = {}): AppStatus => ({
  version: '0.1.0',
  networkPaused: false,
  feed: 'live',
  keyPrice: null,
  counts: { opportunities: 12, profitable: 5, highConfidence: 2 },
  lastEngineRunAt: null,
  setupNeeded: [],
  ...over,
});

const state = (over: Partial<TrayState> = {}): TrayState => ({
  liveFeedEnabled: true,
  networkPaused: false,
  status: status(),
  service: { state: 'ready', nextRestartAt: null },
  hotkey: { accelerator: 'CommandOrControl+Alt+F', registered: true, error: null },
  checkWatch: false,
  checkHotkey: { accelerator: 'CommandOrControl+Alt+C', registered: true, error: null },
  scraptfWindow: false,
  now: 1_000_000,
  ...over,
});

const actions = (): TrayActions & Record<string, ReturnType<typeof vi.fn>> => ({
  showDashboard: vi.fn(),
  quickEntry: vi.fn(),
  setLiveFeedPaused: vi.fn(),
  setNetworkPaused: vi.fn(),
  setClipboardWatch: vi.fn(),
  openScraptfWindow: vi.fn(),
  quit: vi.fn(),
});

describe('trayTooltip', () => {
  it('shows counts and the feed state when running', () => {
    expect(trayTooltip(state())).toBe('TF2 Flip Desk\n5 profitable, 2 high confidence\nLive feed live');
  });

  it('covers the service lifecycle', () => {
    expect(trayTooltip(state({ service: { state: 'starting', nextRestartAt: null } }))).toBe('TF2 Flip Desk\nStarting...');
    expect(trayTooltip(state({ service: { state: 'restarting', nextRestartAt: 1_004_100 } }))).toBe(
      `TF2 Flip Desk\nService restarting at ${new Date(1_004_100).toLocaleTimeString()}`,
    );
    expect(trayTooltip(state({ service: { state: 'restarting', nextRestartAt: null } }))).toBe(
      'TF2 Flip Desk\nService restarting',
    );
    expect(trayTooltip(state({ service: { state: 'stopping', nextRestartAt: null } }))).toBe('TF2 Flip Desk\nStopping...');
  });

  it('shows pauses, missing data, setup hints and hotkey problems', () => {
    expect(trayTooltip(state({ networkPaused: true }))).toBe('TF2 Flip Desk\nNetwork paused');
    expect(trayTooltip(state({ liveFeedEnabled: false }))).toContain('Live feed paused');
    expect(trayTooltip(state({ status: null }))).toBe('TF2 Flip Desk\nWaiting for data...');
    expect(trayTooltip(state({ status: status({ setupNeeded: ['bptf-token'] }) }))).toContain('Setup needed');
    expect(trayTooltip(state({ status: status({ feed: 'backoff' }) }))).toContain('Live feed reconnecting');
    expect(
      trayTooltip(state({ hotkey: { accelerator: 'Ctrl+Alt+F', registered: false, error: 'taken' } })),
    ).toContain('hotkey unavailable');
  });

  it('F16: says when the clipboard check is on or paused, and when its hotkey is taken', () => {
    expect(trayTooltip(state())).not.toContain('Clipboard check');
    expect(trayTooltip(state({ checkWatch: true }))).toBe('TF2 Flip Desk\n5 profitable, 2 high confidence\nLive feed live\nClipboard check on');
    expect(trayTooltip(state({ checkWatch: true, networkPaused: true }))).toBe('TF2 Flip Desk\nNetwork paused\nClipboard check paused');
    expect(trayTooltip(state({ checkHotkey: { accelerator: 'Ctrl+Alt+C', registered: false, error: 'taken' } }))).toContain(
      'Live check hotkey unavailable',
    );
    expect(trayTooltip(state())).not.toContain('hotkey unavailable');
  });

  it('never exceeds the Windows limit of 127 characters', () => {
    const big = status({ counts: { opportunities: 1e12, profitable: 1e12, highConfidence: 1e12 }, setupNeeded: ['bptf-token', 'bptf-key', 'contact-url', 'first-price'] });
    const tip = trayTooltip(
      state({
        status: big,
        hotkey: { accelerator: 'x', registered: false, error: 'e' },
        checkWatch: true,
        checkHotkey: { accelerator: 'y', registered: false, error: 'e' },
      }),
    );
    expect(tip.length).toBeLessThanOrEqual(127);
  });
});

describe('trayMenuTemplate', () => {
  it('has the agreed items in order', () => {
    const items = trayMenuTemplate(state(), actions());
    expect(items.map((i) => i.label ?? i.type)).toEqual([
      'Show dashboard',
      'Quick entry',
      'separator',
      'Pause live feed',
      'Pause all network',
      'Clipboard check',
      'separator',
      'Quit TF2 Flip Desk',
    ]);
  });

  it('F16: the clipboard check checkbox follows the setting and turns the watcher on or off', () => {
    const a = actions();
    const off = trayMenuTemplate(state(), a).find((i) => i.label === 'Clipboard check')! as MenuItemConstructorOptions & {
      click: (item: { checked: boolean }) => void;
    };
    expect(off.type).toBe('checkbox');
    expect(off.checked).toBe(false);
    off.click({ checked: true });
    expect(a.setClipboardWatch).toHaveBeenLastCalledWith(true);
    const on = trayMenuTemplate(state({ checkWatch: true }), a).find((i) => i.label === 'Clipboard check')! as MenuItemConstructorOptions & {
      click: (item: { checked: boolean }) => void;
    };
    expect(on.checked).toBe(true);
    on.click({ checked: false });
    expect(a.setClipboardWatch).toHaveBeenLastCalledWith(false);
  });

  it('reflects the toggles and wires the clicks', () => {
    const a = actions();
    const items = trayMenuTemplate(state({ liveFeedEnabled: false, networkPaused: true }), a);
    const byLabel = (l: string) => items.find((i) => i.label === l)! as MenuItemConstructorOptions & {
      click: (item: { checked: boolean }) => void;
    };
    expect(byLabel('Pause live feed').checked).toBe(true);
    expect(byLabel('Pause all network').checked).toBe(true);
    byLabel('Pause live feed').click({ checked: false });
    byLabel('Pause all network').click({ checked: false });
    byLabel('Show dashboard').click({ checked: false });
    byLabel('Quick entry').click({ checked: false });
    byLabel('Quit TF2 Flip Desk').click({ checked: false });
    expect(a.setLiveFeedPaused).toHaveBeenCalledWith(false);
    expect(a.setNetworkPaused).toHaveBeenCalledWith(false);
    expect(a.showDashboard).toHaveBeenCalled();
    expect(a.quickEntry).toHaveBeenCalled();
    expect(a.quit).toHaveBeenCalled();
  });

  it('F21: offers "Open scrap.tf window" only while the user has the window turned on', () => {
    const a = actions();
    expect(trayMenuTemplate(state(), a).some((i) => i.label === 'Open scrap.tf window')).toBe(false);
    const items = trayMenuTemplate(state({ scraptfWindow: true }), a);
    expect(items.map((i) => i.label ?? i.type).slice(0, 4)).toEqual(['Show dashboard', 'Quick entry', 'Open scrap.tf window', 'separator']);
    const item = items.find((i) => i.label === 'Open scrap.tf window')! as MenuItemConstructorOptions & { click: () => void };
    // A plain item: no checkbox, no accelerator; only the click opens the window.
    expect(item.type).toBeUndefined();
    expect(item.accelerator).toBeUndefined();
    expect(a.openScraptfWindow).not.toHaveBeenCalled();
    item.click();
    expect(a.openScraptfWindow).toHaveBeenCalledTimes(1);
  });

  it('shows the hotkey only when it is registered, without registering it again', () => {
    const quick = trayMenuTemplate(state(), actions())[1]!;
    expect(quick.accelerator).toBe('CommandOrControl+Alt+F');
    expect(quick.registerAccelerator).toBe(false);
    const none = trayMenuTemplate(state({ hotkey: { accelerator: 'X', registered: false, error: 'e' } }), actions())[1]!;
    expect(none.accelerator).toBeUndefined();
  });
});

describe('createTray', () => {
  const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

  it('sets the menu and tooltip, opens the dashboard on click', () => {
    const a = actions();
    const tray = createTray('C:/app/assets/tray.png', a, state(), log());
    const t = fake.FakeTray.last!;
    expect(t.tooltip).toContain('5 profitable');
    expect(t.menuSets).toBe(1);
    t.handlers.get('click')!();
    expect(a.showDashboard).toHaveBeenCalled();
    tray.destroy();
    expect(t.destroyed).toBe(true);
    tray.update(state({ networkPaused: true }));
  });

  it('rebuilds the menu only when menu state changes, unless forced', () => {
    const tray = createTray('tray.png', actions(), state(), log());
    const t = fake.FakeTray.last!;
    tray.update(state({ status: status({ counts: { opportunities: 1, profitable: 1, highConfidence: 0 } }) }));
    expect(t.menuSets).toBe(1);
    expect(t.tooltip).toContain('1 profitable');
    tray.update(state({ networkPaused: true }));
    expect(t.menuSets).toBe(2);
    tray.update(state({ networkPaused: true }), true);
    expect(t.menuSets).toBe(3);
  });

  it('F16: rebuilds the menu when the clipboard check turns on or off (the checkbox never goes stale)', () => {
    const tray = createTray('tray.png', actions(), state(), log());
    const t = fake.FakeTray.last!;
    tray.update(state({ checkWatch: true }));
    expect(t.menuSets).toBe(2);
    const item = (t.menu as { template: MenuItemConstructorOptions[] }).template.find((i) => i.label === 'Clipboard check')!;
    expect(item.checked).toBe(true);
    tray.update(state({ checkWatch: true }));
    expect(t.menuSets).toBe(2);
    tray.update(state({ checkWatch: false }));
    expect(t.menuSets).toBe(3);
    expect(menuKey(state({ checkWatch: true }))).not.toBe(menuKey(state({ checkWatch: false })));
  });

  it('F21: rebuilds the menu when the scrap.tf window is turned on or off', () => {
    const tray = createTray('tray.png', actions(), state(), log());
    const t = fake.FakeTray.last!;
    const labels = () => (t.menu as { template: MenuItemConstructorOptions[] }).template.map((i) => i.label);
    expect(labels()).not.toContain('Open scrap.tf window');
    tray.update(state({ scraptfWindow: true }));
    expect(t.menuSets).toBe(2);
    expect(labels()).toContain('Open scrap.tf window');
    tray.update(state({ scraptfWindow: false }));
    expect(t.menuSets).toBe(3);
    expect(labels()).not.toContain('Open scrap.tf window');
    expect(menuKey(state({ scraptfWindow: true }))).not.toBe(menuKey(state({ scraptfWindow: false })));
  });

  it('warns when the icon image is missing', () => {
    fake.empty = true;
    const l = log();
    createTray('missing.png', actions(), state(), l);
    expect(l.warn).toHaveBeenCalled();
    fake.empty = false;
  });
});
