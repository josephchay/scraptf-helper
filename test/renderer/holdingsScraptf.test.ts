// F14 on the Holdings page: "Sells now for" shows the better exit (a backpack.tf buyer, or scrap.tf
// by the user's saved price list) with a scrap.tf pill, a second line naming the other venue
// ("scrap.tf pays Y", "scrap.tf full", "backpack.tf pays X"), and Record sale… prefilled with venue
// scrap.tf and its pays price when it is the better exit. Pure helpers on rows built by the shared
// holdingRow, then the browser mock's rows and the table rendered into the minimal DOM. No network.

import { act, createElement, useState, type ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  HOLDINGS_LAPSE_MAX_DELAY_MS,
  HOLDING_STATUS_HELP,
  holdingExitView,
  holdingSellsForTitle,
  holdingStatusTitle,
  profitNowTitle,
  recordSaleInit,
  recordSaleTitle,
  scraptfExitLapseAt,
  scraptfExitLapsed,
  scraptfLapseDelay,
} from '../../src/renderer/holdingsModel';
import { SCRAPTF_SALE_NOTE, recordSaleInit as drawerSaleInit } from '../../src/renderer/itemMenuModel';
import { createMockBridge } from '../../src/renderer/mock';
import type { HoldingsTableProps } from '../../src/renderer/pages/HoldingsPage';
import { initialTradeForm, typedPrice } from '../../src/renderer/recordTradeModel';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { holdingRow } from '../../src/shared/holdings';
import { SCRAPTF_LIST_FRESH_MS, valueScraptfListRow } from '../../src/shared/scraptfList';
import type { HoldingRow, JournalPosition, OrderSummary, ScraptfListStored } from '../../src/shared/types';
import { installDomShim, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY = 568;
const P = DEFAULT_SETTINGS.profit;

function order(valueScrap: number, over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId: `l${valueScrap}`,
    steamid: '76561198000000001',
    userName: 'Flip Bot',
    keys: 0,
    metalScrap: valueScrap,
    valueScrap,
    isBot: true,
    online: true,
    lastEventAt: T0 - MIN,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

function position(sku: string, lots: number[]): JournalPosition {
  return {
    sku,
    name: `Item ${sku}`,
    qty: lots.length,
    costScrap: lots.reduce((t, c) => t + c, 0),
    lots: lots.map((costScrap, i) => ({ id: i + 1, ts: T0 - (lots.length - i) * 86_400_000, costScrap, keys: 0, scrap: costScrap, keyPriceScrap: KEY })),
  };
}

function list(over: Partial<ScraptfListStored> = {}) {
  // 0.7.4: the row of this very copy (a family row's exit is labelled so, test/renderer/audit-074-list-notes.test.ts).
  const s: ScraptfListStored = { sku: '143;6', name: 'Earbuds', sellsKeys: 0, sellsScrap: 120, paysKeys: 0, paysScrap: 100, stock: 1, stockLimit: 3, batchId: 101, observedAt: T0 - 12 * MIN, craft: 'craftable', ...over };
  return valueScraptfListRow(s, KEY);
}

/** A held row as the service builds it: the buyer at `revenue` (or none) and the saved list row (or none). */
function row(lots: number[], revenue: OrderSummary | null, l: ReturnType<typeof list> | null): HoldingRow {
  const buy = revenue
    ? {
        revenueScrap: revenue.valueScrap,
        bestScrap: revenue.valueScrap,
        instantScrap: revenue.valueScrap,
        revenueOrder: revenue,
        bestOrder: revenue,
        buyerCount: 3,
        confidence: 72,
        confidenceLevel: 'high' as const,
        flags: [],
        lastOrderChangeAt: T0 - 2 * MIN,
      }
    : null;
  return holdingRow(position('143;6', lots), 'hats', buy, P, KEY, { list: l, now: T0 });
}

describe('"Sells now for": the better exit', () => {
  it('shows scrap.tf with its pill when the fresh list pays more, and the buyer on the second line', () => {
    const r = row([50], order(80), list());
    expect(r.bestExit).toBe('scraptf');
    const v = holdingExitView(r, KEY, T0);
    expect(v).toMatchObject({ priceScrap: 100, scraptf: true, sub: { text: 'backpack.tf pays 8.88 ref', tone: 'muted' } });
    expect(v.title).toBe(
      "Sells now for 11.11 ref to scrap.tf's bank (your price list saved 12 min ago). The best backpack.tf buyer pays 8.88 ref. scrap.tf pays more, so status and profit use it; its stock may have changed since the save.",
    );
    // No buyer at all: scrap.tf is the only exit.
    expect(holdingExitView(row([50], null, list()), KEY, T0)).toMatchObject({ priceScrap: 100, scraptf: true, sub: { text: 'no backpack.tf buyer' } });
  });

  it('keeps the buyer when it pays at least as much, naming what scrap.tf pays', () => {
    const r = row([50], order(100), list());
    expect(r.bestExit).toBe('backpack');
    const v = holdingExitView(r, KEY, T0);
    expect(v).toMatchObject({ priceScrap: 100, scraptf: false, sub: { text: 'scrap.tf pays 11.11 ref', tone: 'muted' } });
    expect(v.title.startsWith(holdingSellsForTitle(r, KEY))).toBe(true);
    expect(v.title).toContain('scrap.tf pays 11.11 ref (price list saved 12 min ago).');
  });

  it('says "scrap.tf full" when it is at its limit, and marks a list over a day old', () => {
    const full = holdingExitView(row([50], order(80), list({ stock: 3, stockLimit: 3 })), KEY, T0);
    expect(full).toMatchObject({ scraptf: false, priceScrap: 80, sub: { text: 'scrap.tf full', tone: 'muted' } });
    const old = holdingExitView(row([50], order(80), list({ observedAt: T0 - 30 * HOUR })), KEY, T0);
    expect(old).toMatchObject({ scraptf: false, priceScrap: 80, sub: { text: 'scrap.tf paid 11.11 ref, 1 d ago', tone: 'warn' } });
    expect(old.title).toContain('older than a day, so it is not counted as an exit');
  });

  it('is exactly the 0.3 cell without a list row', () => {
    const r = row([50], order(80), null);
    expect(holdingExitView(r, KEY, T0)).toEqual({ priceScrap: 80, scraptf: false, sub: null, title: holdingSellsForTitle(r, KEY) });
    // A list row without a pays price adds nothing either.
    expect(holdingExitView(row([50], order(80), list({ paysKeys: null, paysScrap: null })), KEY, T0).sub).toBeNull();
  });

  it('names scrap.tf in the profit and status tooltips when it is the exit', () => {
    const r = row([50], order(80), list());
    expect(r.status).toBe('sell');
    expect(profitNowTitle(r, KEY, { frictionScrap: 0 })).toMatch(/^Selling the oldest unit to scrap\.tf now: \+5\.55 ref/);
    expect(holdingStatusTitle(r)).toBe(`Clears target (scrap.tf). ${HOLDING_STATUS_HELP.sell}`);
    expect(holdingStatusTitle(row([50], order(100), list()))).toBe(HOLDING_STATUS_HELP.sell);
  });
});

describe('Record sale… at the better exit', () => {
  it("prefills scrap.tf at what it pays, which the dialog values back to the same amount", () => {
    const r = row([50], order(80), list());
    const init = recordSaleInit(r, KEY);
    expect(init).toEqual({ side: 'sell', sku: '143;6', name: 'Item 143;6', venue: 'scrap.tf', keys: 0, scrap: 100, note: SCRAPTF_SALE_NOTE });
    const f = initialTradeForm(init, T0);
    expect(f.venue).toBe('scrap.tf');
    expect(typedPrice(f, KEY).value).toBe(100);
    expect(recordSaleTitle(r)).toBe("Record a sale in your journal, prefilled for scrap.tf's bank at its saved list price (s)");
  });

  it('books keys and metal as the list shows them, whatever the key price', () => {
    const r = row([500], order(560), list({ paysKeys: 1, paysScrap: 48 }));
    expect(r.scraptfPaysScrap).toBe(KEY + 48);
    expect(r).toMatchObject({ scraptfPaysKeys: 1, scraptfPaysScrapRaw: 48 });
    const init = recordSaleInit(r, KEY);
    expect(init).toMatchObject({ venue: 'scrap.tf', keys: 1, scrap: 48 });
    expect(typedPrice(initialTradeForm(init, T0), KEY).value).toBe(KEY + 48);
    // Without a key price too: what scrap.tf hands over does not depend on it.
    expect(recordSaleInit(r, null)).toMatchObject({ keys: 1, scrap: 48 });
  });

  it('never invents a key scrap.tf does not pay: the same split as the drawer and the item menu (F14-DM-2)', () => {
    // K = 55 ref and scrap.tf pays 56 ref in metal: a value split would book 1 key + 1 ref.
    const K55 = 495;
    const l = valueScraptfListRow({ sku: '143;6', name: 'Earbuds', sellsKeys: 0, sellsScrap: 520, paysKeys: 0, paysScrap: 504, stock: 1, stockLimit: 3, batchId: 101, observedAt: T0 - 12 * MIN }, K55);
    const r = holdingRow(position('143;6', [400]), 'hats', null, P, K55, { list: l, now: T0 });
    expect(r).toMatchObject({ bestExit: 'scraptf', exitScrap: 504 });
    const fromHoldings = recordSaleInit(r, K55);
    expect(fromHoldings).toMatchObject({ venue: 'scrap.tf', keys: 0, scrap: 504, note: SCRAPTF_SALE_NOTE });
    const fromDrawer = drawerSaleInit({ sku: r.sku, name: r.name }, null, { list: l, now: T0 });
    expect(fromHoldings).toEqual(fromDrawer);
    // "3 keys, 42 refined" at K = 40 ref stays 3 keys + 42 ref (not 4 keys + 2 ref).
    const l3 = valueScraptfListRow({ sku: '143;6', name: 'Earbuds', sellsKeys: 4, sellsScrap: 0, paysKeys: 3, paysScrap: 378, stock: 1, stockLimit: 3, batchId: 101, observedAt: T0 - 12 * MIN }, 360);
    const r3 = holdingRow(position('143;6', [400]), 'hats', null, P, 360, { list: l3, now: T0 });
    expect(recordSaleInit(r3, 360)).toMatchObject({ keys: 3, scrap: 378 });
    expect(recordSaleInit(r3, 360)).toEqual(drawerSaleInit({ sku: r3.sku, name: r3.name }, null, { list: l3, now: T0 }));
  });

  it('falls back to the value split at the key price for a row without the listed split', () => {
    const r = row([500], order(560), list({ paysKeys: 1, paysScrap: 48 }));
    const bare = { ...r, scraptfPaysKeys: undefined, scraptfPaysScrapRaw: undefined };
    expect(recordSaleInit(bare, KEY)).toMatchObject({ venue: 'scrap.tf', keys: 1, scrap: 48 });
    expect(recordSaleInit(bare, null)).toMatchObject({ keys: 0, scrap: KEY + 48 });
  });

  it('stays on the buyer otherwise, exactly as before', () => {
    const r = row([50], order(100), list());
    expect(recordSaleInit(r, KEY)).toEqual({ side: 'sell', sku: '143;6', name: 'Item 143;6', venue: 'backpack.tf', keys: 0, scrap: 100, note: 'Sold to Flip Bot' });
    expect(recordSaleTitle(r)).toBe('Record a sale in your journal, prefilled for Flip Bot (s)');
    expect(recordSaleInit(row([50], null, null), KEY)).toEqual({ side: 'sell', sku: '143;6', name: 'Item 143;6', venue: 'backpack.tf' });
    expect(recordSaleTitle(row([50], null, null))).toBe('Record a sale in your journal (s)');
  });
});

describe('a scrap.tf exit that turns a day old between refetches (UI-2)', () => {
  // Judged fresh by the service at T0 (23.9 h old), lapsed two hours later on the page's clock.
  const r = row([50], order(80), list({ observedAt: T0 - 23.9 * HOUR }));
  const LATER = T0 + 2 * HOUR;

  it('is the exit when the rows were built, and lapses at the page clock', () => {
    expect(r).toMatchObject({ bestExit: 'scraptf', status: 'sell', exitScrap: 100 });
    expect(scraptfExitLapsed(r, T0)).toBe(false);
    expect(scraptfExitLapsed(r, LATER)).toBe(true);
    expect(scraptfExitLapsed(r, null)).toBe(false);
    expect(scraptfExitLapsed(row([50], order(100), list({ observedAt: T0 - 30 * HOUR })), LATER)).toBe(false); // not a scrap.tf exit
  });

  it('stops showing scrap.tf as the exit, and says the list is over a day old', () => {
    expect(holdingExitView(r, KEY, T0)).toMatchObject({ scraptf: true, priceScrap: 100 });
    const v = holdingExitView(r, KEY, LATER);
    expect(v).toMatchObject({ scraptf: false, priceScrap: 80, sub: { text: 'scrap.tf paid 11.11 ref, 1 d ago', tone: 'warn' } });
    expect(v.title).toContain('older than a day, so it is not counted as an exit');
    expect(v.title).not.toContain('scrap.tf pays more');
  });

  it('prefills Record sale for the buyer, not scrap.tf at the old list price', () => {
    expect(recordSaleInit(r, KEY, T0)).toMatchObject({ venue: 'scrap.tf', scrap: 100, note: SCRAPTF_SALE_NOTE });
    expect(recordSaleInit(r, KEY, LATER)).toEqual({ side: 'sell', sku: '143;6', name: 'Item 143;6', venue: 'backpack.tf', keys: 0, scrap: 80, note: 'Sold to Flip Bot' });
    // No buyer either: the venue only, as the drawer's prefill gives.
    const alone = row([50], null, list({ observedAt: T0 - 23.9 * HOUR }));
    expect(recordSaleInit(alone, KEY, LATER)).toEqual({ side: 'sell', sku: '143;6', name: 'Item 143;6', venue: 'backpack.tf' });
  });

  it('knows when the first scrap.tf exit lapses, and waits at most a day', () => {
    const later = row([50], null, list({ observedAt: T0 - HOUR }));
    const bp = row([50], order(100), list({ observedAt: T0 - 23.99 * HOUR }));
    expect(scraptfExitLapseAt([later, r, bp])).toBe(T0 - 23.9 * HOUR + SCRAPTF_LIST_FRESH_MS + 1);
    expect(scraptfExitLapseAt([bp, row([50], order(80), null)])).toBeNull();
    expect(scraptfExitLapseAt([])).toBeNull();
    expect(scraptfLapseDelay(T0 + 5000, T0)).toBe(5000);
    expect(scraptfLapseDelay(T0 - 5000, T0)).toBe(0);
    expect(scraptfLapseDelay(T0 + 3 * SCRAPTF_LIST_FRESH_MS, T0)).toBe(HOLDINGS_LAPSE_MAX_DELAY_MS);
  });
});

// ---------------------------------------------------------------------------
// The browser mock's holdings, and the table rendered
// ---------------------------------------------------------------------------

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let HoldingsTable: typeof import('../../src/renderer/pages/HoldingsPage').HoldingsTable;
let useScraptfExitLapse: typeof import('../../src/renderer/pages/HoldingsPage').useScraptfExitLapse;
let rows: HoldingRow[];
let mockKey: number;

beforeAll(async () => {
  doc = installDomShim();
  ({ createRoot } = await import('react-dom/client'));
  ({ HoldingsTable, useScraptfExitLapse } = await import('../../src/renderer/pages/HoldingsPage'));
  const bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  const res = await bridge.rpc('holdings.list', {});
  rows = res.rows;
  mockKey = res.keyPrice!.valueScrap;
  bridge.dispose();
});

const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
});

function mount(list: HoldingRow[]) {
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const sale = vi.fn();
  function Harness(): ReactElement {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const props: HoldingsTableProps = {
      rows: list,
      keyScrap: mockKey,
      now: T0,
      density: 'compact',
      profit: null,
      selectedId,
      flash: { seq: 0, dirs: new Map() },
      onSelect: setSelectedId,
      onOpen: vi.fn(),
      onMenu: vi.fn(),
      onRecordSale: sale,
      onOpenBuyer: vi.fn(),
    };
    return createElement(HoldingsTable, props);
  }
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(Harness)));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  const rowEl = (sku: string) => container.descendants().filter((e) => e.getAttribute('role') === 'row' && (e.getAttribute('class') ?? '').includes('holding-row'))[list.findIndex((r) => r.sku === sku)]!;
  const cell = (el: ShimElement, cls: string) => el.descendants().find((d) => (d.getAttribute('class') ?? '').split(/\s+/).includes(cls)) ?? null;
  return { rowEl, cell };
}

describe('against the browser mock', () => {
  it('Earbuds sell best to scrap.tf; the prefill is scrap.tf at its pays price', () => {
    const earbuds = rows.find((r) => r.sku === '143;6')!;
    expect(earbuds).toMatchObject({ bestExit: 'scraptf', exitVenue: 'scrap.tf' });
    const init = recordSaleInit(earbuds, mockKey);
    expect(init.venue).toBe('scrap.tf');
    expect(typedPrice(initialTradeForm(init, T0), mockKey).value).toBe(earbuds.scraptfPaysScrap);
  });

  it('renders the scrap.tf pill and the other venue, and keeps the status pills as they were', () => {
    const t = mount(rows);
    const earbuds = t.rowEl('143;6');
    const sells = t.cell(earbuds, 'h-sells')!;
    expect(t.cell(sells, 'exit-pill')?.textContent).toBe('scrap.tf');
    expect(t.cell(sells, 'h-sells-sub')?.textContent).toMatch(/^(backpack\.tf pays .+|no backpack\.tf buyer)$/);
    expect(t.cell(sells, 'buyer-link')).toBeNull();
    const jacket = t.rowEl('30359;6');
    expect(t.cell(t.cell(jacket, 'h-sells')!, 'h-sells-sub')?.textContent).toBe('scrap.tf full');
    expect(t.cell(t.cell(jacket, 'h-sells')!, 'exit-pill')).toBeNull();
    // The scrap.tf pill is not a status pill: every row's first holding-pill is still its status.
    const pills = rows.map((r) => t.cell(t.rowEl(r.sku), 'holding-pill')!.textContent);
    expect(new Set(pills)).toEqual(new Set(['Clears target', 'Below target', 'Loss', 'No buyers']));
  });
});

describe('the Holdings page refetches when a scrap.tf exit lapses (UI-2)', () => {
  /** A held row the service built just now, whose scrap.tf list row turns a day old `inMs` from now. */
  const lapsingRow = (inMs: number): HoldingRow => {
    const now = Date.now();
    return holdingRow(position('143;6', [50]), 'hats', null, P, KEY, { list: list({ observedAt: now - SCRAPTF_LIST_FRESH_MS + inMs }), now });
  };
  const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

  function mountLapse(initial: HoldingRow[]) {
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const reload = vi.fn(async () => {});
    function Harness({ list: shown }: { list: HoldingRow[] }): ReactElement | null {
      useScraptfExitLapse(shown, reload);
      return null;
    }
    const root = createRoot(container as unknown as Element);
    act(() => root.render(createElement(Harness, { list: initial })));
    unmounts.push(() => {
      act(() => root.unmount());
      doc.body.removeChild(container);
    });
    const answer = (next: HoldingRow[]) => act(() => root.render(createElement(Harness, { list: next })));
    return { reload, answer };
  }

  it('refetches once when the list turns a day old, with no push to say so', async () => {
    const r = lapsingRow(60);
    expect(r.bestExit).toBe('scraptf');
    const t = mountLapse([r]);
    expect(t.reload).not.toHaveBeenCalled();
    await wait(200);
    expect(t.reload).toHaveBeenCalledTimes(1);
    // The service answers with the same row (another clock): the same lapse is not chased again.
    t.answer([{ ...r }]);
    await wait(150);
    expect(t.reload).toHaveBeenCalledTimes(1);
    // A later scrap.tf exit is waited for in turn.
    t.answer([lapsingRow(60)]);
    await wait(200);
    expect(t.reload).toHaveBeenCalledTimes(2);
  });

  it('schedules nothing without a scrap.tf exit', async () => {
    const t = mountLapse([row([50], order(80), null), row([50], order(100), list())]);
    await wait(100);
    expect(t.reload).not.toHaveBeenCalled();
  });
});
