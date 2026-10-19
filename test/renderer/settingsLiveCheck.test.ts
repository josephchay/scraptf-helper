// F16 Settings → Live check, rendered with react-dom/client into domShim.ts with the browser mock as the
// app bridge: every check.* setting has its control and saves through settings.set, the hotkey field
// shows main's registration ('app.hotkeys', re-read after each settings change, so a chord another app
// took at start-up reads Unavailable), and Test checks the sample through 'check.text' {source:'manual'}.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { CHECK_PRIVACY_SENTENCE, CHECK_SAMPLE_TEXT } from '../../src/shared/check';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { FlipdeskBridge, HotkeysStatus } from '../../src/shared/rpc';
import type { Settings } from '../../src/shared/types';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let useApp: typeof import('../../src/renderer/hooks/appContext').useApp;
let CheckSection: (p: { s: Settings }) => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  if (!('oninput' in doc)) (doc as unknown as Record<string, unknown>)['oninput'] = null;
  win()['location'] = { hash: '#/settings' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider, useApp } = await import('../../src/renderer/hooks/appContext'));
  ({ CheckSection } = await import('../../src/renderer/pages/SettingsPage'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
  vi.unstubAllGlobals();
});

async function settle(rounds = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

/** The section as SettingsPage mounts it, once the settings have loaded. */
function Section() {
  const { settings } = useApp();
  return settings ? createElement(CheckSection, { s: settings }) : null;
}

/** The toasts' texts (SettingsPage leaves showing them to the app shell's ToastStack). */
function Toasts() {
  const { toasts } = useApp();
  return createElement('output', { id: 'toasts' }, toasts.map((t) => t.text).join(' | '));
}

async function mount(opts: { hotkeys?: (real: HotkeysStatus) => HotkeysStatus } = {}) {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  const calls: { method: string; params: unknown }[] = [];
  const w: FlipdeskBridge = {
    windowKind: 'dashboard',
    rpc: async (m, p) => {
      calls.push({ method: m, params: p });
      const r = await b.rpc(m, p);
      return (m === 'app.hotkeys' && opts.hotkeys ? opts.hotkeys(r as HotkeysStatus) : r) as never;
    },
    on: (e, fn) => b.on(e, fn),
  };
  win()['flipdesk'] = w;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(Section), createElement(Toasts))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  // act() renders once its callback ends: settings.get lands, then the section mounts and asks for
  // 'app.hotkeys', then that answer renders. One settle per step.
  for (let i = 0; i < 3; i++) await settle();
  const all = () => container.descendants();
  const fire = async (target: ShimElement | null | undefined, type: string) => {
    expect(target).toBeTruthy();
    act(() => {
      target!.dispatchEvent(new ShimEvent(type, { bubbles: true, cancelable: true }));
    });
    await settle();
  };
  const switches = () => all().filter((e) => e.tagName === 'INPUT' && e.getAttribute('role') === 'switch') as (ShimElement & { checked: boolean })[];
  /** The switch whose label reads `label`. */
  const switchFor = (label: RegExp) => switches().find((s) => label.test(s.parentNode?.textContent ?? ''));
  return {
    b,
    calls,
    all,
    text: () => container.textContent,
    switchFor,
    flip: async (label: RegExp) => {
      const s = switchFor(label)!;
      expect(s).toBeTruthy();
      s.checked = !s.checked;
      await fire(s, 'click');
    },
    click: (e: ShimElement | null | undefined) => fire(e, 'click'),
    hotkeyInput: () => all().find((e) => e.getAttribute('id') === 'check-hotkey') as (ShimElement & { value: string }) | undefined,
    commitHotkey: async (value: string) => {
      const input = all().find((e) => e.getAttribute('id') === 'check-hotkey') as ShimElement & { value: string };
      input.value = value;
      await fire(input, 'input');
      await fire(input, 'focusout');
    },
    settings: () => b.rpc('settings.get', undefined),
  };
}

describe('Settings → Live check', () => {
  it('has a control for every check.* setting', async () => {
    const t = await mount();
    expect(Object.keys(DEFAULT_SETTINGS.check).sort()).toEqual(['hotkey', 'notifyFlips', 'popup', 'watchClipboard']);
    expect(t.hotkeyInput()?.value).toBe(DEFAULT_SETTINGS.check.hotkey);
    expect(t.switchFor(/Watch the clipboard/)?.checked).toBe(false);
    expect(t.switchFor(/Notify me about flips/)?.checked).toBe(true);
    expect(t.switchFor(/Show the check popup/)?.checked).toBe(true);
    // The watch switch carries the privacy sentence and says it is off by default.
    expect(t.text()).toContain(CHECK_PRIVACY_SENTENCE);
    expect(t.text()).toContain('Off by default.');
  });

  it('each switch saves its own setting, and turning the watcher on repeats the privacy sentence', async () => {
    const t = await mount();
    await t.flip(/Watch the clipboard/);
    await t.flip(/Notify me about flips/);
    await t.flip(/Show the check popup/);
    const sets = t.calls.filter((c) => c.method === 'settings.set').map((c) => c.params);
    expect(sets).toEqual([{ check: { watchClipboard: true } }, { check: { notifyFlips: false } }, { check: { popup: false } }]);
    expect((await t.settings()).check).toEqual({ hotkey: DEFAULT_SETTINGS.check.hotkey, watchClipboard: true, notifyFlips: false, popup: false });
    expect(t.text()).toContain(`Clipboard check is on. ${CHECK_PRIVACY_SENTENCE}`);
  });

  it('saves the hotkey, re-reads its registration, and refuses the quick-entry chord before saving', async () => {
    const t = await mount();
    const before = t.calls.filter((c) => c.method === 'app.hotkeys').length;
    expect(before).toBeGreaterThan(0);
    await t.commitHotkey('CommandOrControl+Alt+J');
    expect(t.calls.filter((c) => c.method === 'settings.set').map((c) => c.params)).toEqual([{ check: { hotkey: 'CommandOrControl+Alt+J' } }]);
    expect((await t.settings()).check.hotkey).toBe('CommandOrControl+Alt+J');
    expect(t.calls.filter((c) => c.method === 'app.hotkeys').length).toBeGreaterThan(before);
    expect(t.text()).toContain('On');

    await t.commitHotkey('Ctrl+Alt+F');
    expect(t.calls.filter((c) => c.method === 'settings.set')).toHaveLength(1);
    expect(t.text()).toContain('That is the quick-entry hotkey.');
  });

  it("shows main's word that the stored hotkey is taken (a start-up failure), not On", async () => {
    const error = '"CommandOrControl+Alt+C" is already used by another application or is not a valid shortcut.';
    const t = await mount({ hotkeys: (real) => ({ ...real, check: { accelerator: real.check.accelerator, registered: false, error } }) });
    expect(t.text()).toContain('Unavailable');
    expect(t.text()).toContain(error);
    expect(t.all().some((e) => e.getAttribute('role') === 'alert' && (e.textContent ?? '').includes('is not working'))).toBe(true);
  });

  it('Test checks the sample through check.text as a manual check and shows the verdict inline', async () => {
    const t = await mount();
    await t.click(t.all().find((e) => e.tagName === 'BUTTON' && e.textContent === 'Test'));
    expect(t.calls.filter((c) => c.method === 'check.text').map((c) => c.params)).toEqual([{ text: CHECK_SAMPLE_TEXT, source: 'manual' }]);
    expect(t.text()).toContain('Team Captain · scrap.tf 1.33 ref (copied) · Pay up to');
    expect(t.text()).toMatch(/Flip \+|Over by|Not profitable|No buyers/);
  });
});
