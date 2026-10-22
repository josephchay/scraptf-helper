// F16 Live check popup, rendered with react-dom/client into the minimal DOM in domShim.ts with the
// browser mock as the app bridge. Main's 'ui.checkShow' comes from the test. Checks what each state
// shows and what each button sends; nothing reads a clipboard and nothing leaves the process.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_MATCHED_NOTE } from '../../src/renderer/checkModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { mockCheckDemo } from '../../src/renderer/mockCheck';
import { CHECK_HINT, CHECK_NOT_ITEM_REASON, checkHintedNote } from '../../src/shared/check';
import { CHECKOUT_GUARD_POPUP, checkoutGuardTitle } from '../../src/shared/checkoutGuard';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { FlipdeskBridge, PushContract, PushEvent } from '../../src/shared/rpc';
import type { CheckResult } from '../../src/shared/types';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const K = 540;

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let CheckPopup: () => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  win()['location'] = { hash: '#/check' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ CheckPopup } = await import('../../src/renderer/pages/CheckPopup'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
});

async function settle(rounds = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

const cls = (e: ShimElement) => e.getAttribute('class') ?? '';

async function mount() {
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  const calls: { method: string; params: unknown }[] = [];
  const local = new Map<string, Set<(p: unknown) => void>>();
  const w: FlipdeskBridge = {
    windowKind: 'check',
    rpc: (m, p) => {
      calls.push({ method: m, params: p });
      return b.rpc(m, p);
    },
    on: (e, fn) => {
      const set = local.get(e) ?? new Set();
      local.set(e, set);
      const f = fn as (p: unknown) => void;
      set.add(f);
      const off = b.on(e, fn);
      return () => {
        set.delete(f);
        off();
      };
    },
  };
  win()['flipdesk'] = w;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(CheckPopup))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const all = () => container.descendants();
  const button = (label: string | RegExp) =>
    all().find((e) => e.tagName === 'BUTTON' && (typeof label === 'string' ? e.textContent.trim() === label : label.test(e.textContent.trim()))) ?? null;
  const click = async (target: ShimElement | null) => {
    expect(target).not.toBeNull();
    act(() => {
      target!.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
  };
  const show = async (r: CheckResult) => {
    act(() => {
      for (const fn of local.get('ui.checkShow') ?? []) fn(r);
    });
    await settle();
  };
  const emit = <E extends PushEvent>(e: E, p: PushContract[E]) =>
    act(() => {
      for (const fn of local.get(e) ?? []) fn(p);
    });
  return {
    b,
    calls,
    all,
    button,
    click,
    show,
    emit,
    dialog: () => all().find((e) => e.getAttribute('role') === 'dialog')!,
    text: () => all().find((e) => e.getAttribute('role') === 'dialog')!.textContent,
    callsOf: (m: string) => calls.filter((c) => c.method === m),
  };
}

const demo = (kind: 'flip' | 'over' | 'no-price' | 'not-item') => mockCheckDemo(kind, T0, K, DEFAULT_SETTINGS);

describe('the check popup', () => {
  it('waits for a result, then shows the item, its price line, who buys it, the verdict and Pay up to', async () => {
    const t = await mount();
    expect(t.text()).toContain('Copy an item name or a scrap.tf/items row');
    await t.show(demo('flip'));
    const d = t.dialog();
    expect(d.getAttribute('aria-label')).toBe('Live check: Team Captain');
    expect(cls(d)).toContain('verdict-flip');
    const text = t.text();
    expect(text).toContain('Team Captain');
    expect(text).toContain('Hats');
    expect(text).toContain('scrap.tf1 key 5.33 ref(copied)');
    expect(text).toContain('3/12');
    expect(text).toContain('Sells for1 key 22.00 ref');
    expect(text).toContain('to Demo Trading Bot');
    expect(text).toContain('bot, online');
    expect(text).toContain('6 buyers');
    expect(text).toMatch(/Flip \+/);
    expect(text).toContain('Pay up to');
    // The quality colour comes with ItemName.
    expect(t.all().some((e) => cls(e).includes('item-name') && cls(e).includes('q-6'))).toBe(true);
  });

  it('Save price writes the checked price as a typed price, once', async () => {
    const t = await mount();
    await t.show(demo('flip'));
    await t.click(t.button('Save price'));
    expect(t.callsOf('prices.upsert').map((c) => c.params)).toEqual([
      // 0.7.4 (F80): replaceTyped, so a second check's save updates this row instead of adding one.
      { sku: '378;6', name: 'Team Captain', costKeys: 1, costScrap: 48, source: 'user', observedAt: T0, note: 'live check', replaceTyped: true },
    ]);
    expect(t.button('Saved')?.hasAttribute('disabled')).toBe(true);
    expect(t.text()).toContain('Saved Team Captain at 1 key 5.33 ref as your scrap.tf price.');
    const stored = (await t.b.rpc('prices.list', {})).filter((p) => p.sku === '378;6' && p.note === 'live check');
    expect(stored).toHaveLength(1);
  });

  it('Bought it records a scrap.tf buy with Undo in the toast', async () => {
    const t = await mount();
    await t.show(demo('flip'));
    await t.click(t.button('Bought it'));
    const add = t.callsOf('journal.add');
    expect(add.map((c) => c.params)).toEqual([{ side: 'buy', venue: 'scrap.tf', sku: '378;6', name: 'Team Captain', keys: 1, scrap: 48, note: 'live check' }]);
    expect(t.button('Recorded')?.hasAttribute('disabled')).toBe(true);
    expect(t.text()).toContain('Recorded a buy of Team Captain at 1 key 5.33 ref in your journal.');
    await t.click(t.button('Undo'));
    expect(t.callsOf('journal.delete')).toHaveLength(1);
    expect(t.button('Bought it')?.hasAttribute('disabled')).toBe(false);
    expect((await t.b.rpc('journal.list', {})).some((e) => e.note === 'live check')).toBe(false);
  });

  it('Details opens the item in the dashboard; Quick entry… passes the SKU and price; both hide the popup', async () => {
    const t = await mount();
    await t.show(demo('flip'));
    await t.click(t.button('Details'));
    expect(t.callsOf('app.openItem').map((c) => c.params)).toEqual([{ sku: '378;6' }]);
    expect(t.callsOf('app.hideWindow')).toHaveLength(1);
    await t.click(t.button('Quick entry…'));
    expect(t.callsOf('app.showQuickEntry').map((c) => c.params)).toEqual([{ sku: '378;6', price: '1 key 5.33 ref' }]);
    expect(t.callsOf('app.hideWindow')).toHaveLength(2);
    await t.click(t.all().find((e) => e.getAttribute('aria-label') === 'Hide (Esc)') ?? null);
    expect(t.callsOf('app.hideWindow')).toHaveLength(3);
  });

  it('no scrap.tf price: says so, leads with Pay up to, and only Details and Quick entry work', async () => {
    const t = await mount();
    await t.show(demo('no-price'));
    expect(t.text()).toContain('No scrap.tf price');
    expect(t.all().some((e) => cls(e).includes('cp-pay') && cls(e).includes('prominent'))).toBe(true);
    expect(t.button('Save price')?.hasAttribute('disabled')).toBe(true);
    expect(t.button('Bought it')?.hasAttribute('disabled')).toBe(true);
    expect(t.button('Details')?.hasAttribute('disabled')).toBe(false);
    await t.click(t.button('Quick entry…'));
    expect(t.callsOf('app.showQuickEntry').map((c) => c.params)).toEqual([{ sku: '94;6' }]);
  });

  it('not an item: the reason and the hint, no item actions', async () => {
    const t = await mount();
    await t.show(demo('not-item'));
    expect(t.dialog().getAttribute('aria-label')).toBe('Live check: not an item');
    expect(t.text()).toContain(CHECK_NOT_ITEM_REASON);
    expect(t.text()).toContain(`${CHECK_HINT}.`);
    expect(t.button('Save price')).toBeNull();
    expect(t.button('Details')).toBeNull();
  });

  it('a newer result replaces the shown one and its buttons start fresh', async () => {
    const t = await mount();
    await t.show(demo('flip'));
    await t.click(t.button('Save price'));
    expect(t.button('Saved')).not.toBeNull();
    await t.show(demo('over'));
    expect(t.text()).toContain('Taunt: Conga');
    expect(t.text()).toMatch(/Over by /);
    // The page's clock is the real one; the demo is dated T0.
    expect(t.text()).toMatch(/\(saved list [^)]+\)/);
    expect(t.text()).toContain('Full');
    expect(t.button('Save price')?.hasAttribute('disabled')).toBe(false);
  });

  it('the same result shown again keeps Saved; a restarted service reusing the id starts fresh', async () => {
    const t = await mount();
    const first = demo('flip');
    await t.show(first);
    await t.click(t.button('Save price'));
    await t.click(t.button('Bought it'));
    // Main re-sends the result on each show: still saved and recorded, so nothing writes twice.
    await t.show(structuredClone(first));
    expect(t.button('Saved')?.hasAttribute('disabled')).toBe(true);
    expect(t.button('Recorded')?.hasAttribute('disabled')).toBe(true);
    // Ids restart with the service process: the same id at another time is another check.
    await t.show({ ...structuredClone(first), checkedAt: first.checkedAt + 5_000 });
    expect(t.button('Save price')?.hasAttribute('disabled')).toBe(false);
    expect(t.button('Bought it')?.hasAttribute('disabled')).toBe(false);
    expect(t.callsOf('prices.upsert')).toHaveLength(1);
    expect(t.callsOf('journal.add')).toHaveLength(1);
  });

  it("an item's notes show (all of them in the tooltip) and the key legend gives way, so the buttons fit", async () => {
    const t = await mount();
    // 0.9 (#9): on a flip the checkout guard takes the legend's line; any other verdict keeps the legend.
    await t.show(demo('over'));
    expect(t.all().some((e) => cls(e).includes('cp-keys'))).toBe(true);
    expect(t.all().some((e) => cls(e).includes('cp-guard'))).toBe(false);
    await t.show({ ...demo('flip'), checkedAt: T0 + 500 });
    const guard = t.all().find((e) => cls(e).includes('cp-guard'));
    expect(guard?.textContent).toBe(CHECKOUT_GUARD_POPUP);
    expect(guard?.getAttribute('title')).toBe(checkoutGuardTitle());
    expect(t.all().some((e) => cls(e).includes('cp-keys'))).toBe(false);
    const reason = 'Closest match only: check that this is the item you copied. Sold out on scrap.tf when you copied it, so there is no price to compare.';
    await t.show({ ...demo('flip'), reason, checkedAt: T0 + 1_000 });
    const note = t.all().find((e) => cls(e).includes('cp-note'));
    expect(note?.textContent).toBe(reason);
    expect(note?.getAttribute('title')).toBe(reason);
    // With a note, neither the legend nor the guard.
    expect(t.all().some((e) => cls(e).includes('cp-keys'))).toBe(false);
    expect(t.all().some((e) => cls(e).includes('cp-guard'))).toBe(false);
    expect(t.button('Save price')?.getAttribute('aria-keyshortcuts')).toBe('Enter');
  });

  it('0.9 (#2): on the scrap.tf line the break-even comes after the stock and Full, and it is the part that gives way', async () => {
    const t = await mount();
    // 'over': a saved-list price, 12/12 (Full) and a break-even: the longest scrap.tf line the demos make.
    await t.show(demo('over'));
    const line = t.all().find((e) => cls(e).includes('cp-line') && e.descendants().some((d) => cls(d).includes('cp-be')));
    expect(line).toBeDefined();
    const kids = line!.descendants();
    const at = (pred: (e: ShimElement) => boolean) => kids.findIndex(pred);
    const stock = at((e) => cls(e).includes('cp-stock'));
    const full = at((e) => e.textContent === 'Full');
    const be = at((e) => cls(e).includes('cp-be'));
    expect(stock).toBeGreaterThanOrEqual(0);
    expect(full).toBeGreaterThanOrEqual(0);
    // The nowrap line clips at its end: the stock and Full (0.8's) must come first, the break-even last.
    expect(stock).toBeLessThan(be);
    expect(full).toBeLessThan(be);
    expect(kids[be]!.textContent).toMatch(/^· break-even /);
    expect(kids[be]!.getAttribute('title')).toBeTruthy();
    // It may shrink (ellipsis); the stock may not.
    const css = readFileSync(new URL('../../src/renderer/styles/check.css', import.meta.url), 'utf8');
    const rule = /\.cp-be\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/min-width:\s*0/);
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
  });

  it('ignores check.done (the Recent checks panel uses it), and never reads the clipboard', async () => {
    const t = await mount();
    await t.show(demo('flip'));
    t.emit('check.done', demo('over'));
    await settle();
    expect(t.text()).toContain('Team Captain');
    expect(t.text()).not.toContain('Taunt: Conga');
    const page = readFileSync(new URL('../../src/renderer/pages/CheckPopup.tsx', import.meta.url), 'utf8');
    expect(page).not.toMatch(/clipboard\s*\.\s*read|readText\s*\(|navigator\s*\.\s*clipboard|copyText\(/);
  });
});

describe('F19: a price copied on scrap.tf after "Open on scrap.tf"', () => {
  it('says the price was matched to the item opened, once, with the full sentence in the tooltip', async () => {
    const t = await mount();
    const reason = checkHintedNote('Team Captain');
    await t.show({ ...demo('flip'), reason, checkedAt: T0 + 1_000 });
    const note = t.all().find((e) => cls(e).includes('cp-note'));
    expect(note?.textContent).toBe(CHECK_MATCHED_NOTE);
    expect(cls(note!)).toContain('cp-matched');
    expect(note?.getAttribute('title')).toBe(reason);
    // Not a second time in the price line, which stays "(copied)".
    expect(t.text().split('matched to the item you opened').length - 1).toBe(1);
    expect(t.text()).toContain('scrap.tf1 key 5.33 ref(copied)');
    // The buttons work as for any copied price.
    expect(t.button('Save price')?.hasAttribute('disabled')).toBe(false);
  });

  it('disarms right after Save price and after Bought it, and not on a plain show or Undo', async () => {
    const t = await mount();
    await t.show(demo('flip'));
    expect(t.callsOf('check.arm')).toHaveLength(0);
    await t.click(t.button('Save price'));
    expect(t.callsOf('check.arm').map((c) => c.params)).toEqual([null]);
    expect(t.calls.map((c) => c.method).filter((m) => m === 'prices.upsert' || m === 'check.arm')).toEqual(['prices.upsert', 'check.arm']);
    await t.click(t.button('Bought it'));
    expect(t.callsOf('check.arm').map((c) => c.params)).toEqual([null, null]);
    expect(t.calls.map((c) => c.method).filter((m) => m === 'journal.add' || m === 'check.arm').slice(-2)).toEqual(['journal.add', 'check.arm']);
    await t.click(t.button('Undo'));
    expect(t.callsOf('check.arm')).toHaveLength(2);
  });
});
