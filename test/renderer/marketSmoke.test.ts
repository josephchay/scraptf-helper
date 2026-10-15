// F10 Live market, rendered server-side: the renderer tests run in node without
// a DOM, so effects do not run here (the model tests cover the live logic).
// Catches a render that throws, and checks what the page and the table put on
// screen for real rows from the in-memory browser mock. No network.

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../../src/renderer/hooks/appContext';
import { BOUNDARY_NOTE, COVERAGE_TIP, DEFAULT_MARKET_SORT, marketDisplayRows, type FlashDir } from '../../src/renderer/marketModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { CoverageStrip, MarketPage, MarketStrip, MarketTable, type MarketTableProps } from '../../src/renderer/pages/MarketPage';
import { SCRAPTF_BANK_PAGES } from '../../src/shared/links';
import type { MarketListResult, MarketRow, MarketStats, ScraptfCoverage } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const noop = () => undefined;

describe('MarketPage first render', () => {
  it('shows the strip, the boundary note, the filters and the verdict chips', () => {
    const html = renderToString(createElement(AppProvider, null, createElement(MarketPage)));
    expect(html).toContain('aria-label="Live market status"');
    expect(html).toContain(BOUNDARY_NOTE);
    expect(html).toContain('aria-label="Search the live market"');
    for (const label of ['Flip', 'Rule flip', 'Not checked', 'Over', 'No buyers']) expect(html).toContain(`${label}<span class="chip-count">`);
    expect(html).toContain('Loading the live market');
    expect(html).toContain('Export CSV');
    expect(html).toContain('Freeze');
  });
});

describe('MarketStrip (H1, F13)', () => {
  const NOW = T0;
  const stats = (over: Partial<MarketStats> = {}): MarketStats => ({
    entries: 0,
    building: false,
    progress: 0,
    lastFullAt: null,
    lastChangeAt: null,
    pendingDirty: 0,
    lastError: null,
    retryAt: null,
    ...over,
  });
  const coverage = (savedAgo: (number | null)[]): ScraptfCoverage[] =>
    SCRAPTF_BANK_PAGES.map((p, i) => ({ category: p.category, label: p.label, url: p.url, lastSavedAt: savedAgo[i] == null ? null : NOW - savedAgo[i]!, items: savedAgo[i] == null ? 0 : 40 + i }));
  const side = (over: Partial<MarketListResult['scraptf']> = {}): MarketListResult['scraptf'] => ({
    typed: 3,
    pages: 40,
    newestPageAt: NOW - 4 * 60_000,
    importEnabled: true,
    watchFolder: true,
    coverage: coverage([4 * 60_000, 30 * 60_000, 5 * 3_600_000, null, null, null, null]),
    ...over,
  });
  const strip = (props: { stats: MarketStats | null; scraptf: MarketListResult['scraptf'] | null }) =>
    renderToString(
      createElement(
        AppProvider,
        null,
        createElement(MarketStrip, {
          live: { state: 'live', label: 'Live', title: '' },
          lastAt: null,
          rate: { text: '0 updates/min', title: '' },
          now: NOW,
          onImport: noop,
          ...props,
        }),
      ),
    );

  it('shows the database error and its retry instead of "Building 0 %"', () => {
    const html = strip({ stats: stats({ lastError: 'database is locked', retryAt: Date.now() + 30_000 }), scraptf: side() });
    expect(html).toContain('Could not read the local database (database is locked). Retrying in ');
    expect(html).toContain('market-index error');
    expect(html).not.toContain('Building');
    // Fine again: the usual index line.
    expect(strip({ stats: stats({ entries: 12 }), scraptf: side() })).toContain('12 items with buyers');
    expect(strip({ stats: stats({ building: true, progress: 0.5 }), scraptf: side() })).toContain('Building 50 %');
  });

  it('lists one chip per bank page with its freshness, and hides them while import is off', () => {
    const html = strip({ stats: stats(), scraptf: side() });
    expect(html).toContain('aria-label="scrap.tf pages you saved"');
    expect(html.match(/class="chip coverage-chip /g)).toHaveLength(7);
    expect(html).toContain('chip coverage-chip tone-good');
    expect(html).toContain('chip coverage-chip tone-warn');
    expect(html).toContain('chip coverage-chip tone-muted');
    expect(html).toMatch(/saved 4 min ago · 40 items/);
    expect(html).toContain('never saved');
    expect(html).toContain(`title="${COVERAGE_TIP}"`);
    // Import off: no strip, and the way in is still there.
    const off = strip({ stats: stats(), scraptf: side({ importEnabled: false }) });
    expect(off).not.toContain('coverage-chip');
    expect(off).toContain('Set up Import');
    expect(strip({ stats: null, scraptf: null })).not.toContain('coverage-chip');
  });

  it('renders the coverage the mock reports', async () => {
    const b = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => NOW });
    try {
      const res = await b.rpc('market.list', {});
      const html = renderToString(createElement(AppProvider, null, createElement(CoverageStrip, { scraptf: { ...res.scraptf, importEnabled: true }, now: NOW })));
      for (const p of SCRAPTF_BANK_PAGES) expect(html).toContain(`>${p.label}</span>`);
    } finally {
      b.dispose();
    }
  });
});

describe('MarketTable', () => {
  let bridge: MockBridge | null = null;
  afterEach(() => {
    bridge?.dispose();
    bridge = null;
  });

  it('renders every kind of row the mock has, with flashes and Load more', async () => {
    const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
    const all = (await b.rpc('market.list', { limit: 500 })).rows;
    // The table virtualises, so put one row of each kind first.
    const pick = (f: (r: MarketRow) => boolean) => all.find(f);
    const picked = [
      pick((r) => r.verdict === 'flip'),
      pick((r) => r.verdict === 'over'),
      pick((r) => r.verdict === 'unchecked'),
      pick((r) => r.verdict === 'no-buyers'),
      pick((r) => r.knownSource === 'page'),
      pick((r) => r.knownSource === 'typed'),
      pick((r) => r.knownSource === 'none' && r.ruleCostScrap !== null),
      pick((r) => r.revenueOrder?.isBot === false),
    ].filter((r): r is MarketRow => r !== undefined);
    const rows = [...new Map(picked.map((r) => [r.sku, r])).values()];
    expect(rows.length).toBeGreaterThanOrEqual(5);
    const dirs = new Map<string, FlashDir>([
      [rows[0]!.sku, 'up'],
      [rows[1]!.sku, 'down'],
    ]);
    const props: MarketTableProps = {
      rows: marketDisplayRows(rows, rows.length + 300),
      dataKey: 'q',
      keyScrap: 568,
      now: T0,
      density: 'comfortable',
      selectedId: rows[2]!.sku,
      flash: { seq: 1, dirs },
      sort: { ...DEFAULT_MARKET_SORT },
      loadingMore: false,
      frozen: false,
      onSelect: noop,
      onOpen: noop,
      onMenu: noop,
      onLoadMore: noop,
      onSort: noop,
    };
    const html = renderToString(createElement(MarketTable, props));
    expect(html).toContain('role="grid"');
    for (const r of rows) expect(html).toContain(`SKU ${r.sku}`);
    expect(html).toContain('flash-up flash-b');
    expect(html).toContain('flash-down flash-b');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-sort="descending"');
    expect(html).toMatch(/Load <!-- -->200<!-- --> more|Load 200 more/);
    expect(html).toContain('src-badge src-page');
    expect(html).toContain('src-badge src-typed');
    expect(html).toContain('No buyers');
    expect(html).toContain('Not checked');
    if (rows.some((r) => r.verdict === 'flip')) expect(html).toMatch(/verdict-pill tone-good[^>]*>Flip \+/);
    if (rows.some((r) => r.knownSource === 'none' && r.ruleCostScrap !== null)) expect(html).toContain('rule-est');

    // Frozen, the More row offers no load: more rows would come from the live order, not the held one.
    const frozen = renderToString(createElement(MarketTable, { ...props, frozen: true }));
    expect(frozen).not.toMatch(/Load <!-- -->200<!-- --> more|Load 200 more/);
    expect(frozen).toMatch(/Unfreeze to load more/);
  });
});
