// F20 U5: the Live market's "Listed on scrap.tf > 24 h" source filter. It starts off, is persisted with
// the other filters (off for filters saved before it), counts on the Source button, goes out as
// MarketQuery.listedOnScraptf only when on, and the mock answers it by the shared rule
// (marketListedSideMatches): rows the user's saves have listed on sale for a day or more. The switch sits
// in the Source popover, so the grid's pinned width budget is untouched. Nothing contacts scrap.tf.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MARKET_FILTERS,
  DEFAULT_MARKET_SORT,
  LISTED_ON_SCRAPTF_HINT,
  LISTED_ON_SCRAPTF_LABEL,
  LISTED_ON_SCRAPTF_TITLE,
  activeMarketFilterCount,
  defaultMarketFilters,
  emptyFiltersText,
  marketExportQuery,
  marketListParams,
  marketQuery,
  marketRouteIntent,
  marketSourceCount,
  marketWindowQuery,
  sanitizeMarketFilters,
  type MarketFilters,
} from '../../src/renderer/marketModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { MARKET_MAX_LIMIT } from '../../src/shared/market';
import { SCRAPTF_LONG_LISTED_MS } from '../../src/shared/scraptfHistory';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');
const filters = (over: Partial<MarketFilters> = {}): MarketFilters => ({ ...defaultMarketFilters(), ...over });

describe('"Listed on scrap.tf > 24 h" (F20 U5)', () => {
  it('starts off, restores only a real true, and is off for filters saved before it', () => {
    expect(DEFAULT_MARKET_FILTERS.listedOnScraptf).toBe(false);
    expect(defaultMarketFilters().listedOnScraptf).toBe(false);
    expect(sanitizeMarketFilters({ listedOnScraptf: true }).listedOnScraptf).toBe(true);
    for (const v of [1, 'true', null, {}, undefined]) expect(sanitizeMarketFilters({ listedOnScraptf: v }).listedOnScraptf).toBe(false);
    const old = { search: 'hat', categories: ['hats'], verdicts: ['flip'], sources: ['page'], minCeiling: '2 ref', onlyBotBuyers: true, minBuyers: 3, onScraptfList: true, newOnScraptf: true };
    expect(sanitizeMarketFilters(old)).toEqual({ ...old, listedOnScraptf: false });
    expect(marketRouteIntent(['market', 'bank', 'hats'])!.filters.listedOnScraptf).toBe(false);
  });

  it('counts once among the active filters and on the Source button', () => {
    expect(activeMarketFilterCount(filters({ listedOnScraptf: true }))).toBe(1);
    expect(activeMarketFilterCount(filters({ listedOnScraptf: true, newOnScraptf: true, onScraptfList: true }))).toBe(3);
    expect(marketSourceCount(filters({ listedOnScraptf: true }))).toBe(1);
    expect(marketSourceCount(filters({ listedOnScraptf: true, newOnScraptf: true, sources: ['page'] }))).toBe(3);
    // A caller without the F20 key still counts.
    expect(marketSourceCount({ sources: [], onScraptfList: true, newOnScraptf: false })).toBe(1);
  });

  it('is sent as MarketQuery.listedOnScraptf only when on, through the window, the request and the export', () => {
    expect(marketQuery(filters(), null, DEFAULT_MARKET_SORT)).toEqual({ sort: 'ceiling', dir: 'desc' });
    expect(marketQuery(filters({ listedOnScraptf: true }), null, DEFAULT_MARKET_SORT)).toEqual({ sort: 'ceiling', dir: 'desc', listedOnScraptf: true });
    const params = marketListParams({ ...marketWindowQuery(filters({ listedOnScraptf: true }), null, DEFAULT_MARKET_SORT), limit: 200, offset: 0 }, 568);
    expect(params).toMatchObject({ listedOnScraptf: true, limit: 200 });
    expect(marketExportQuery(params)).toEqual({ sort: 'ceiling', dir: 'desc', listedOnScraptf: true });
  });

  it('says what it keeps, from saved pages only, and the empty table how to get rows back', () => {
    expect(LISTED_ON_SCRAPTF_LABEL).toBe('Listed on scrap.tf > 24 h');
    expect(LISTED_ON_SCRAPTF_HINT).toBe('in your saves');
    expect(LISTED_ON_SCRAPTF_TITLE).toMatch(/at least a day, without a break/);
    expect(LISTED_ON_SCRAPTF_TITLE).toMatch(/the app never visits scrap\.tf\.$/);
    const t = emptyFiltersText(filters({ listedOnScraptf: true }));
    expect(t).toMatch(/^Listed on scrap\.tf > 24 h \(under Source\) keeps only items your saves have listed on sale for a day or more\./);
    expect(t).toContain('or untick it.');
    expect(t).toMatch(/Clear the search or the verdict chips/);
    // Both switches on: both said, F17's first.
    const both = emptyFiltersText(filters({ listedOnScraptf: true, newOnScraptf: true }));
    expect(both.indexOf('New on scrap.tf (under Source)')).toBe(0);
    expect(both).toContain('Listed on scrap.tf > 24 h (under Source)');
    expect(emptyFiltersText(filters())).not.toContain('under Source');
  });
});

describe('against the mock', () => {
  let bridge: MockBridge | null = null;
  afterEach(() => {
    bridge?.dispose();
    bridge = null;
  });

  it('keeps only rows listed on sale for a day or more across the saves', async () => {
    const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
    const all = await b.rpc('market.list', { limit: MARKET_MAX_LIMIT });
    const only = await b.rpc('market.list', marketListParams({ ...marketWindowQuery(filters({ listedOnScraptf: true }), null, DEFAULT_MARKET_SORT), limit: MARKET_MAX_LIMIT, offset: 0 }, 568));
    expect(only.rows.length).toBeGreaterThan(0);
    expect(only.rows.length).toBeLessThan(all.rows.length);
    for (const r of only.rows) expect(T0 - r.scraptfListedSince!).toBeGreaterThanOrEqual(SCRAPTF_LONG_LISTED_MS);
    const want = all.rows.filter((r) => r.scraptfListedSince !== null && T0 - r.scraptfListedSince >= SCRAPTF_LONG_LISTED_MS).map((r) => r.sku).sort();
    expect(only.rows.map((r) => r.sku).sort()).toEqual(want);
  });
});

describe('wiring (static)', () => {
  const page = read('pages/MarketPage.tsx');

  it('offers the switch in the Source popover after "New on scrap.tf", persisted with the other filters', () => {
    const source = page.slice(page.indexOf('<Popover label={<>Source'), page.indexOf('<Popover label={<>Pay up to'));
    expect(source).toContain("<input type=\"checkbox\" checked={filters.listedOnScraptf} onChange={() => set('listedOnScraptf', !filters.listedOnScraptf)} />");
    expect(source).toContain('<span>{LISTED_ON_SCRAPTF_LABEL}</span>');
    expect(source).toContain('title={LISTED_ON_SCRAPTF_TITLE}');
    expect(source.indexOf('filters.newOnScraptf')).toBeLessThan(source.indexOf('filters.listedOnScraptf'));
    expect(page.match(/set\('listedOnScraptf'/g)).toHaveLength(1);
    // No new column: the grid's pinned width budget is unchanged.
    expect(page).not.toMatch(/scraptfListedSince/);
  });
});
