// F16 Live check on the Live market: the Recent checks panel, rendered with react-dom/client into
// domShim.ts with the browser mock as the app bridge. Collapsed by default (remembered), loaded from
// 'check.recent', live through 'check.done', a manual box that sends 'check.text' {source:'manual'},
// and a click that opens the drawer. The pasted text never leaves the field except to that call.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { CHECK_HINT, CHECK_MAX_CHARS, CHECK_NOT_ITEM_REASON, CHECK_SAMPLE_TEXT } from '../../src/shared/check';
import type { FlipdeskBridge } from '../../src/shared/rpc';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const OPEN_KEY = 'flipdesk.ui.market.recentChecksOpen';

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let useApp: typeof import('../../src/renderer/hooks/appContext').useApp;
let RecentChecks: () => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  if (!('oninput' in doc)) (doc as unknown as Record<string, unknown>)['oninput'] = null;
  win()['location'] = { hash: '#/market' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider, useApp } = await import('../../src/renderer/hooks/appContext'));
  ({ RecentChecks } = await import('../../src/renderer/pages/MarketPage'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
let store: Map<string, string>;
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

/** Shows which item the drawer would open (AppProvider's itemSku). */
function Probe() {
  const { itemSku } = useApp();
  return createElement('output', { id: 'opened' }, itemSku ?? '');
}

async function mount(opts: { before?: (b: MockBridge) => Promise<void>; open?: boolean } = {}) {
  store = new Map(opts.open ? [[OPEN_KEY, 'true']] : []);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  if (opts.before) await opts.before(b);
  const calls: { method: string; params: unknown }[] = [];
  const w: FlipdeskBridge = {
    windowKind: 'dashboard',
    rpc: (m, p) => {
      calls.push({ method: m, params: p });
      return b.rpc(m, p);
    },
    on: (e, fn) => b.on(e, fn),
  };
  win()['flipdesk'] = w;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(RecentChecks), createElement(Probe))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const all = () => container.descendants();
  const fire = async (target: ShimElement | null | undefined, type: string, init: Record<string, unknown> = {}) => {
    expect(target).toBeTruthy();
    act(() => {
      target!.dispatchEvent(new ShimEvent(type, { bubbles: true, cancelable: true, ...init }));
    });
    await settle();
  };
  const toggle = () => all().find((e) => e.tagName === 'BUTTON' && e.getAttribute('class') === 'rc-toggle');
  const box = () => all().find((e) => e.tagName === 'TEXTAREA') as (ShimElement & { value: string }) | undefined;
  return {
    b,
    calls,
    all,
    toggle,
    box,
    rows: () => all().filter((e) => e.tagName === 'BUTTON' && (e.getAttribute('class') ?? '').startsWith('rc-row')),
    text: () => container.textContent,
    opened: () => all().find((e) => e.getAttribute('id') === 'opened')?.textContent ?? '',
    click: (e: ShimElement | null | undefined) => fire(e, 'click'),
    /** Dispatches without letting the mock answer yet. */
    dispatch: (e: ShimElement, type: string) =>
      act(() => {
        e.dispatchEvent(new ShimEvent(type, { bubbles: true, cancelable: true }));
      }),
    check: async (value: string) => {
      const input = box()!;
      input.value = value;
      await fire(input, 'input');
      await fire(all().find((e) => e.tagName === 'FORM'), 'submit');
    },
  };
}

describe('Recent checks', () => {
  it('is collapsed by default, and remembers being opened', async () => {
    const t = await mount();
    expect(t.toggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(t.box()).toBeUndefined();
    expect(t.text()).toContain('Recent checks, 0');
    await t.click(t.toggle());
    expect(t.toggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(t.box()?.getAttribute('maxlength')).toBe(String(CHECK_MAX_CHARS));
    expect(store.get(OPEN_KEY)).toBe('true');
    expect(t.text()).toContain('No checks yet.');
  });

  it('loads the service ring on mount, even collapsed', async () => {
    const t = await mount({
      before: async (b) => {
        await b.rpc('check.text', { text: CHECK_SAMPLE_TEXT, source: 'hotkey' });
      },
    });
    expect(t.calls.some((c) => c.method === 'check.recent')).toBe(true);
    expect(t.text()).toContain('Recent checks, 1');
  });

  it('checks pasted text as a manual check, lists it once and clears the box', async () => {
    const t = await mount({ open: true });
    await t.check(CHECK_SAMPLE_TEXT);
    expect(t.calls.filter((c) => c.method === 'check.text').map((c) => c.params)).toEqual([{ text: CHECK_SAMPLE_TEXT, source: 'manual' }]);
    // Returned and pushed as 'check.done': one row.
    expect(t.rows()).toHaveLength(1);
    const row = t.rows()[0]!;
    expect(row.textContent).toContain('Team Captain');
    expect(row.textContent).toContain('1.33 ref');
    expect(row.textContent).toContain('copied');
    expect(row.textContent).toContain('Pay up to');
    expect(row.getAttribute('class')).toContain('just-checked');
    expect(t.box()!.value).toBe('');
  });

  it('shows why a text is not an item, and keeps it in the box to fix', async () => {
    const t = await mount({ open: true });
    await t.check('definitely not a hat');
    expect(t.text()).toContain(CHECK_NOT_ITEM_REASON);
    expect(t.text()).toContain(CHECK_HINT);
    expect(t.rows()).toHaveLength(0);
    expect(t.box()!.value).toBe('definitely not a hat');
  });

  it('keeps text typed while a check was on its way', async () => {
    const t = await mount({ open: true });
    const input = t.box()!;
    input.value = CHECK_SAMPLE_TEXT;
    t.dispatch(input, 'input');
    t.dispatch(t.all().find((e) => e.tagName === 'FORM')!, 'submit');
    input.value = 'Texas Ten Gallon';
    t.dispatch(input, 'input');
    await settle();
    expect(t.rows()).toHaveLength(1);
    expect(t.box()!.value).toBe('Texas Ten Gallon');
  });

  it('needs some text before it asks the service', async () => {
    const t = await mount({ open: true });
    await t.check('   ');
    expect(t.calls.some((c) => c.method === 'check.text')).toBe(false);
    expect(t.text()).toContain('Paste or type an item name');
  });

  it('adds checks from the hotkey or the watcher as they are pushed, newest first', async () => {
    const t = await mount({ open: true });
    await act(async () => {
      await t.b.rpc('check.text', { text: 'Team Captain', source: 'watch' });
    });
    await settle();
    await act(async () => {
      await t.b.rpc('check.text', { text: CHECK_SAMPLE_TEXT, source: 'hotkey' });
    });
    await settle();
    expect(t.rows()).toHaveLength(2);
    expect(t.rows()[0]!.getAttribute('title')).toContain('by hotkey');
    expect(t.rows()[1]!.getAttribute('title')).toContain('by clipboard watch');
  });

  it('says when the clipboard check is on, and when the network-paused switch pauses it', async () => {
    const t = await mount({
      before: async (b) => {
        await b.rpc('settings.set', { check: { watchClipboard: true } });
      },
    });
    expect(t.text()).toContain('Clipboard check on');
    expect(t.text()).toContain('clipboard check is on');
    // Main's watcher reads nothing while the network is paused.
    await act(async () => {
      await t.b.rpc('settings.set', { networkPaused: true });
    });
    await settle();
    expect(t.text()).toContain('Clipboard check paused');
    expect(t.text()).not.toContain('Clipboard check on');
    expect(t.text()).not.toContain('clipboard check is on');
  });

  it('a click opens the item in the drawer', async () => {
    const t = await mount({ open: true });
    await t.check(CHECK_SAMPLE_TEXT);
    await t.click(t.rows()[0]);
    expect(t.opened()).toBe('378;6');
  });

  it('is mounted on the Live market and styled in check.css', () => {
    const page = readFileSync(new URL('../../src/renderer/pages/MarketPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('<RecentChecks />');
    expect(page).toContain("usePersistentState<boolean>('market.recentChecksOpen', false, sanitizeRecentOpen)");
    const css = readFileSync(new URL('../../src/renderer/styles/check.css', import.meta.url), 'utf8');
    expect(css).toContain('.recent-checks');
    expect(css).toContain('.rc-row');
  });
});
