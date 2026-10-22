// 0.9: the Journal's "Unrealised P/L" card. inventoryStat words one holdings read (holdingsValuationOf): an error, no
// read yet, nothing held, the items with no exit, and the signed P/L with the worth now and the read's time. The page
// (react-dom/client into the minimal DOM in domShim.ts, the browser mock as the bridge) reads holdings.list once on
// mount, shows the card after "Holding" and refetches it on journal.changed. A local read: nothing leaves the process.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { DASH, fmtDateTime, fmtMoney, fmtSignedMoney } from '../../src/renderer/format';
import { INVENTORY_TITLE, inventoryStat } from '../../src/renderer/journalModel';
import { holdingsValuationOf } from '../../src/shared/holdings';
import type { FlipdeskBridge } from '../../src/shared/rpc';
import type { HoldingsValuation } from '../../src/shared/types';
import { installDomShim, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const KEY = 568;

const valuation = (over: Partial<HoldingsValuation> = {}): HoldingsValuation => ({
  at: T0,
  keyScrap: KEY,
  worthNowScrap: 900,
  profitNowScrap: 120,
  costScrap: 780,
  items: 3,
  units: 4,
  unpricedItems: 0,
  unpricedUnits: 0,
  lockedItems: 0,
  exitBySku: {},
  ...over,
});

describe('inventoryStat', () => {
  it('an error: a dash, "Holdings could not be read", muted', () => {
    expect(inventoryStat(valuation(), KEY, 'boom')).toEqual({ value: DASH, sub: 'Holdings could not be read', muted: true, title: INVENTORY_TITLE });
  });

  it('no read yet, and nothing held', () => {
    expect(inventoryStat(null, KEY)).toMatchObject({ value: DASH, sub: 'reading Holdings…', title: INVENTORY_TITLE });
    expect(inventoryStat(valuation({ items: 0, units: 0, worthNowScrap: 0, profitNowScrap: 0, costScrap: 0 }), KEY)).toMatchObject({ value: DASH, sub: 'nothing held' });
  });

  it('the signed P/L, the worth now and the as-of time; the title names the read', () => {
    const v = inventoryStat(valuation(), null);
    expect(v).toEqual({
      value: fmtSignedMoney(120, KEY),
      sub: `worth ${fmtMoney(900, KEY)} · as of ${fmtDateTime(T0)}`,
      muted: false,
      title: `${INVENTORY_TITLE} Read ${fmtDateTime(T0)}.`,
    });
    expect(v.value.startsWith('+')).toBe(true);
    expect(inventoryStat(valuation({ profitNowScrap: -30 }), KEY).value).toBe(fmtSignedMoney(-30, KEY));
  });

  it('counts the items with no exit, which are left out of the P/L', () => {
    expect(inventoryStat(valuation({ unpricedItems: 1, unpricedUnits: 2 }), KEY).sub).toBe(`worth ${fmtMoney(900, KEY)} · as of ${fmtDateTime(T0)} · 1 item with no exit`);
    expect(inventoryStat(valuation({ unpricedItems: 2 }), KEY).sub).toContain(' · 2 items with no exit');
  });

  it('README step 15 says what the card does: it counts the items with no exit and names none of them', () => {
    // The card's words for unpriced holdings are a count (inventoryStat reads no item names).
    expect(inventoryStat(valuation({ unpricedItems: 3 }), KEY).sub).toMatch(/ · 3 items with no exit$/);
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    const line = readme.split(/\r?\n/).find((l) => l.includes('an *Unrealised P/L* card beside *Holding*'));
    expect(line).toBeDefined();
    expect(line).toContain('says how many items have no exit to value them at');
    expect(line).not.toMatch(/names the items with no exit/);
  });

  it("values at the read's own key price, else the page's", () => {
    expect(inventoryStat(valuation({ keyScrap: null, profitNowScrap: 1200 }), 600).value).toBe(fmtSignedMoney(1200, 600));
    expect(inventoryStat(valuation({ profitNowScrap: 1200 }), 600).value).toBe(fmtSignedMoney(1200, KEY));
  });

  it('says it is unrealised, how it is valued and where the CSV carries it', () => {
    expect(INVENTORY_TITLE).toContain('Unrealised: nothing is booked until you record a sale.');
    expect(INVENTORY_TITLE).toContain('(worth_now_ref, unrealised_ref, valued_at)');
    expect(INVENTORY_TITLE).not.toMatch(/https?:\/\//);
  });
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let JournalPage: () => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  // Before react-dom loads: it checks for a DOM once, at import.
  doc = installDomShim();
  win()['location'] = { hash: '#/journal' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ JournalPage } = await import('../../src/renderer/pages/JournalPage'));
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

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

const cls = (e: ShimElement) => e.getAttribute('class') ?? '';

describe('the Journal page\'s "Unrealised P/L" card', () => {
  it('shows Holdings\' P/L and its as-of time after "Holding", reads holdings.list once, and refetches on journal.changed', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
    const sent: string[] = [];
    const w: FlipdeskBridge = {
      windowKind: 'dashboard',
      rpc: (m, p) => {
        sent.push(m);
        return b.rpc(m, p);
      },
      on: (e, fn) => b.on(e, fn),
    };
    win()['flipdesk'] = w;
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    act(() => root.render(createElement(AppProvider, null, createElement(JournalPage))));
    unmounts.push(() => {
      act(() => root.unmount());
      doc.body.removeChild(container);
    });
    await settle();
    await settle();

    const res = await b.rpc('holdings.list', {});
    const K = res.keyPrice!.valueScrap;
    const cards = container.descendants().filter((e) => cls(e).split(' ').includes('stat') && cls(e).split(' ').includes('card'));
    const labels = cards.map((c) => c.descendants().find((x) => cls(x) === 'stat-label')?.textContent);
    expect(labels.indexOf('Unrealised P/L')).toBe(labels.indexOf('Holding') + 1);
    const card = cards[labels.indexOf('Unrealised P/L')]!;
    expect(card.descendants().find((x) => cls(x) === 'stat-value')!.textContent).toBe(fmtSignedMoney(res.totals.profitNowScrap, K));
    const sub = card.descendants().find((x) => cls(x) === 'muted small')!.textContent;
    expect(sub).toContain(`as of ${fmtDateTime(T0)}`);
    expect(sub).toContain(`worth ${fmtMoney(res.totals.worthNowScrap, K)}`);
    expect(card.getAttribute('title')).toBe(`${INVENTORY_TITLE} Read ${fmtDateTime(T0)}.`);
    // The same figures holdingsValuationOf gives over the same read.
    expect(holdingsValuationOf(res).profitNowScrap).toBe(res.totals.profitNowScrap);
    expect(sent.filter((m) => m === 'holdings.list')).toHaveLength(1);

    // A recorded trade (journal.changed) refetches it.
    await act(async () => {
      await b.rpc('journal.add', { side: 'buy', venue: 'scrap.tf', sku: '1118;6', name: 'Taunt: Conga', keys: 0, scrap: 90 });
    });
    await settle();
    await settle();
    expect(sent.filter((m) => m === 'holdings.list')).toHaveLength(2);
    const after = await b.rpc('holdings.list', {});
    expect(after.totals.items).toBe(res.totals.items + 1);
    const card2 = container
      .descendants()
      .filter((e) => cls(e).split(' ').includes('stat') && cls(e).split(' ').includes('card'))
      .find((c) => c.descendants().some((x) => cls(x) === 'stat-label' && x.textContent === 'Unrealised P/L'))!;
    expect(card2.descendants().find((x) => cls(x) === 'stat-value')!.textContent).toBe(fmtSignedMoney(after.totals.profitNowScrap, K));
  });
});
