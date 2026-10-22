// 0.8 (H3): Settings → Your accounts, rendered with react-dom/client into the minimal DOM in domShim.ts with the
// browser mock as the app bridge. The list of the user's own SteamID64s saves only the user's own edit to a fresh
// read (BlocklistSection's pattern, so an id saved from another window meanwhile stays), refuses what is not a
// SteamID64 and an 11th id, and the section sits after the Blocklist in the table of contents. It only filters
// "Others ask" (R5): the page signs in to nothing.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import type { FlipdeskBridge } from '../../src/shared/rpc';
import type { Settings } from '../../src/shared/types';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const id = (n: number) => `765611980000000${String(n).padStart(2, '0')}`;
const A = id(1);
const B = id(2);
const C = id(3);

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let useApp: typeof import('../../src/renderer/hooks/appContext').useApp;
let OwnAccountsSection: (p: { s: Settings }) => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  if (!('oninput' in doc)) (doc as unknown as Record<string, unknown>)['oninput'] = null;
  win()['location'] = { hash: '#/settings' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider, useApp } = await import('../../src/renderer/hooks/appContext'));
  ({ OwnAccountsSection } = await import('../../src/renderer/pages/SettingsPage'));
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
  return settings ? createElement(OwnAccountsSection, { s: settings }) : null;
}

function Toasts() {
  const { toasts } = useApp();
  return createElement('output', { id: 'toasts' }, toasts.map((t) => t.text).join(' | '));
}

async function mount(stored: string[]) {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  await b.rpc('settings.set', { ownSteamIds: stored });
  const w: FlipdeskBridge = { windowKind: 'dashboard', rpc: (m, p) => b.rpc(m, p), on: (e, fn) => b.on(e, fn) };
  win()['flipdesk'] = w;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(Section), createElement(Toasts))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  for (let i = 0; i < 3; i++) await settle();
  const all = () => container.descendants();
  const area = () => all().find((e) => e.getAttribute('id') === 'own-steamids') as (ShimElement & { value?: string; defaultValue?: string }) | undefined;
  const saveButton = () => all().find((e) => e.tagName === 'BUTTON' && e.textContent === 'Save accounts');
  return {
    b,
    text: () => container.textContent,
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
      act(() => {
        saveButton()!.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
      });
      await settle();
    },
    stored: async () => (await b.rpc('settings.get', undefined)).ownSteamIds,
  };
}

describe('Settings → Your accounts (H3)', () => {
  it('shows the stored ids and says what the list does, and that it signs in to nothing', async () => {
    const t = await mount([A]);
    expect(t.value()).toBe(A);
    expect(t.saveEnabled()).toBe(false);
    expect(t.text()).toContain('Your accounts');
    expect(t.text()).toContain('SteamID64s, one per line');
    expect(t.text()).toContain('left out of “Others ask” on Holdings and in the item panel');
    expect(t.text()).toContain('Flip Desk signs in to nothing and acts for no account; this list never leaves settings.json.');
  });

  it("saves the user's edit to a fresh read: an id saved elsewhere meanwhile stays", async () => {
    const t = await mount([A]);
    await t.type(`${A}\n${C}`);
    expect(t.saveEnabled()).toBe(true);
    // Another window saves B while this edit is pending.
    await t.b.rpc('settings.set', { ownSteamIds: [A, B] });
    await settle();
    await t.save();
    const stored = await t.stored();
    expect([...stored].sort()).toEqual([A, B, C].sort());
    expect(t.text()).toContain('Your accounts saved (3).');
    expect(t.saveEnabled()).toBe(false);
  });

  it('applies a removal typed here', async () => {
    const t = await mount([A, C]);
    await t.type(A);
    await t.save();
    expect(await t.stored()).toEqual([A]);
  });

  it('refuses what is not a SteamID64', async () => {
    const t = await mount([]);
    await t.type(`${A}\n7656`);
    expect(t.text()).toContain('Not a SteamID64: 7656');
    expect(t.saveEnabled()).toBe(false);
    expect(await t.stored()).toEqual([]);
  });

  it('refuses an 11th id (at most 10, as the settings schema)', async () => {
    const t = await mount([]);
    const ten = Array.from({ length: 10 }, (_, i) => id(i + 10));
    await t.type(ten.join('\n'));
    expect(t.text()).not.toContain('At most 10');
    expect(t.saveEnabled()).toBe(true);
    await t.type([...ten, id(42)].join('\n'));
    expect(t.text()).toContain('At most 10');
    expect(t.saveEnabled()).toBe(false);
    await t.type(ten.join('\n'));
    await t.save();
    expect(await t.stored()).toEqual(ten);
  });
});

describe('the Settings page wiring (static)', () => {
  const page = readFileSync(new URL('../../src/renderer/pages/SettingsPage.tsx', import.meta.url), 'utf8');

  it('lists Your accounts right after the Blocklist, in the contents and on the page', () => {
    expect(page).toContain("['set-block', 'Blocklist'],\n  ['set-own', 'Your accounts'],");
    expect(page.indexOf('<BlocklistSection s={settings} />')).toBeLessThan(page.indexOf('<OwnAccountsSection s={settings} />'));
    expect(page.match(/<OwnAccountsSection /g)).toHaveLength(1);
  });

  it('writes only ownSteamIds, through updateSettings after a fresh settings.get', () => {
    const body = page.slice(page.indexOf('export function OwnAccountsSection'), page.indexOf('function useHotkeys'));
    expect(body).toContain("fresh = await rpc('settings.get');");
    expect(body).toContain('updateSettings({ ownSteamIds: applyBlocklistEdit(fresh.ownSteamIds ?? [], draft.base, parsed.ids) })');
    expect(body).not.toMatch(/openOrCopy|links\.open|https?:\/\//);
  });
});
