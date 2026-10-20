// Settings → Blocklist with the item drawer open over it (a notification or quick entry's "Open in
// dashboard" opens the drawer without leaving Settings). A buyer blocked in the drawer must show in the
// textarea when nothing is being edited, must not light up Save, and a later Settings save must apply
// only the user's own edits to a fresh read, never drop the drawer's block (arrays replace whole).

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { rpc } from '../../src/renderer/api';
import { blockBuyer, unblockBuyer, type BlocklistDeps } from '../../src/renderer/itemMenuModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { applyBlocklistEdit } from '../../src/renderer/settingsFields';
import type { FlipdeskBridge } from '../../src/shared/rpc';
import type { Settings } from '../../src/shared/types';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const A = '76561198000000001';
const B = '76561198000000002';
const C = '76561198000000003';

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let useApp: typeof import('../../src/renderer/hooks/appContext').useApp;
let BlocklistSection: (p: { s: Settings }) => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  if (!('oninput' in doc)) (doc as unknown as Record<string, unknown>)['oninput'] = null;
  win()['location'] = { hash: '#/settings' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider, useApp } = await import('../../src/renderer/hooks/appContext'));
  ({ BlocklistSection } = await import('../../src/renderer/pages/SettingsPage'));
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

function Section() {
  const { settings } = useApp();
  return settings ? createElement(BlocklistSection, { s: settings }) : null;
}

function Toasts() {
  const { toasts } = useApp();
  return createElement('output', { id: 'toasts' }, toasts.map((t) => t.text).join(' | '));
}

/** The drawer's Block buyer and Undo, wired as ItemDrawer's useBuyerActions wires them. */
let drawer: { block(id: string): Promise<unknown>; unblock(id: string): Promise<unknown> } | null = null;
function Drawer() {
  const { updateSettings } = useApp();
  const deps: BlocklistDeps = { getSettings: () => rpc('settings.get'), save: (patch) => updateSettings(patch) };
  drawer = { block: (id) => blockBuyer(id, deps), unblock: (id) => unblockBuyer(id, deps) };
  return null;
}

async function mount(stored: string[]) {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  await b.rpc('settings.set', { blocklist: stored });
  const fail = { get: false };
  const w: FlipdeskBridge = {
    windowKind: 'dashboard',
    rpc: async (m, p) => {
      if (m === 'settings.get' && fail.get) throw new Error('bridge down');
      return b.rpc(m, p);
    },
    on: (e, fn) => b.on(e, fn),
  };
  win()['flipdesk'] = w;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(Section), createElement(Drawer), createElement(Toasts))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  for (let i = 0; i < 3; i++) await settle();
  const all = () => container.descendants();
  const area = () => all().find((e) => e.getAttribute('id') === 'blocklist') as (ShimElement & { value?: string; defaultValue?: string }) | undefined;
  const saveButton = () => all().find((e) => e.tagName === 'BUTTON' && e.textContent === 'Save blocklist');
  return {
    fail,
    text: () => container.textContent,
    /** The textarea's text (React sets defaultValue on mount and value on updates). */
    value: () => {
      const t = area();
      expect(t).toBeTruthy();
      return t!.value ?? t!.defaultValue ?? '';
    },
    type: async (value: string) => {
      const t = area()!;
      t.value = value;
      act(() => {
        t.dispatchEvent(new ShimEvent('input', { bubbles: true, cancelable: true }));
      });
      await settle();
    },
    saveEnabled: () => {
      const s = saveButton();
      expect(s).toBeTruthy();
      return !s!.hasAttribute('disabled');
    },
    save: async () => {
      const s = saveButton();
      expect(s).toBeTruthy();
      act(() => {
        s!.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
      });
      await settle();
    },
    drawerBlock: async (id: string) => {
      await act(async () => {
        await drawer!.block(id);
      });
      await settle();
    },
    drawerUnblock: async (id: string) => {
      await act(async () => {
        await drawer!.unblock(id);
      });
      await settle();
    },
    stored: async () => (await b.rpc('settings.get', undefined)).blocklist,
  };
}

describe('applyBlocklistEdit: the Settings edit applied to a fresh read', () => {
  it('keeps what was added elsewhere, applies the user\'s additions and removals, and drops duplicates', () => {
    expect(applyBlocklistEdit([A, B], [A], [A, C])).toEqual([A, B, C]);
    expect(applyBlocklistEdit([A, B, C], [A, C], [A])).toEqual([A, B]);
    expect(applyBlocklistEdit([A, B], [A], [A, B, C, C])).toEqual([A, B, C]);
    expect(applyBlocklistEdit([A, A, B], [A], [A])).toEqual([A, B]);
    // Removed elsewhere since the textarea was seeded, and not touched by the user: stays removed.
    expect(applyBlocklistEdit([A], [A, B], [A, B, C])).toEqual([A, C]);
  });
});

describe('Settings → Blocklist with the drawer open over it', () => {
  it('re-syncs to a buyer blocked in the drawer when nothing is being edited, and Save stays off', async () => {
    const t = await mount([A]);
    expect(t.value()).toBe(A);
    expect(t.saveEnabled()).toBe(false);
    await t.drawerBlock(B);
    expect(await t.stored()).toEqual([A, B]);
    expect(t.value()).toBe(`${A}\n${B}`);
    expect(t.saveEnabled()).toBe(false);
  });

  it("keeps the user's edit while the drawer blocks someone, and saving keeps both (the finding's scenario)", async () => {
    const t = await mount([A]);
    await t.type(`${A}\n${C}`);
    await t.drawerBlock(B);
    expect(t.value()).toBe(`${A}\n${C}`);
    expect(t.saveEnabled()).toBe(true);
    await t.save();
    const stored = await t.stored();
    expect(stored).toContain(A);
    expect(stored).toContain(B);
    expect(stored).toContain(C);
    expect(t.text()).toContain('Blocklist saved (3).');
    // After the save the textarea shows the stored list and nothing is pending.
    expect(t.value().split('\n').sort()).toEqual([A, B, C].sort());
    expect(t.saveEnabled()).toBe(false);
  });

  it('applies a removal typed in Settings to a fresh read', async () => {
    const t = await mount([A, C]);
    await t.type(A);
    await t.drawerBlock(B);
    await t.save();
    expect(await t.stored()).toEqual([A, B]);
  });

  it('a block and its Undo in the drawer while editing leave only the edit', async () => {
    const t = await mount([A]);
    await t.type(`${A}\n${C}`);
    await t.drawerBlock(B);
    await t.drawerUnblock(B);
    await t.save();
    expect(await t.stored()).toEqual([A, C]);
  });

  it('never wipes a half-typed id', async () => {
    const t = await mount([A]);
    await t.type(`${A}\n7656`);
    await t.drawerBlock(B);
    expect(t.value()).toBe(`${A}\n7656`);
    expect(t.text()).toContain('Not a SteamID64: 7656');
    expect(t.saveEnabled()).toBe(false);
  });

  it('says so and changes nothing when the fresh read fails', async () => {
    const t = await mount([A]);
    await t.type(`${A}\n${C}`);
    t.fail.get = true;
    await t.save();
    t.fail.get = false;
    expect(t.text()).toContain('Could not save settings: bridge down');
    expect(await t.stored()).toEqual([A]);
    expect(t.value()).toBe(`${A}\n${C}`);
  });
});
