// F10 Live market wiring, checked statically (the renderer tests run in node,
// without a DOM): the nav entry and route, the only app methods the page
// calls, and the stylesheet's use of tokens and reduced motion. 0.8 (T7): the table rendered server-side
// for the Wait / Buy now tag in the Item cell.

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MARKET_SORT, marketDisplayRows } from '../../src/renderer/marketModel';
import type { MarketTableProps } from '../../src/renderer/pages/MarketPage';
import { scraptfLinkFor } from '../../src/shared/links';
import { SERVICE_METHODS, MAIN_METHODS } from '../../src/shared/rpc';
import type { MarketRow, ScraptfTimingBrief } from '../../src/shared/types';

const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');

describe('navigation', () => {
  const app = read('App.tsx');

  it('lists Live market second, right after Opportunities', () => {
    const ids = [...app.matchAll(/\{ id: '([a-z]+)', label: '([^']+)', icon: '([A-Za-z]+)' \}/g)].map((m) => [m[1], m[2], m[3]]);
    expect(ids[0]).toEqual(['opportunities', 'Opportunities', 'opps']);
    expect(ids[1]).toEqual(['market', 'Live market', 'market']);
    expect(ids.filter(([id]) => id === 'market')).toHaveLength(1);
  });

  it('routes and titles the page', () => {
    expect(app).toMatch(/type RouteId = [^;]*'market'/);
    expect(app).toMatch(/market: 'Live market',/);
    expect(app).toMatch(/case 'market':\s*return <MarketPage \/>;/);
    expect(read('components/Icon.tsx')).toMatch(/\n {2}market: \(/);
  });
});

describe('the page', () => {
  const page = read('pages/MarketPage.tsx');

  it('only reads the local index, exports and opens quick entry: no new traffic', () => {
    const methods = new Set([...page.matchAll(/rpc\('([a-zA-Z.]+)'/g)].map((m) => m[1]));
    // F16: the Recent checks panel reads the service's in-memory ring and checks pasted text, both local.
    expect([...methods].sort()).toEqual(['app.showQuickEntry', 'check.recent', 'check.text', 'market.list', 'opps.exportCsv']);
    for (const m of methods) expect([...SERVICE_METHODS, ...MAIN_METHODS]).toContain(m);
    expect(page).toContain("kind: 'market'");
    expect(page).not.toMatch(/https?:\/\//);
    // F15: a coverage chip opens its card on the scrap.tf banks page (the card hands the page to the
    // user's browser). Nothing on this page fetches an address.
    expect(page).toContain('onClick={() => navigate(banksPath(c.bank))}');
    expect(page).not.toMatch(/links\.open|openLink|fetch\(|XMLHttpRequest|new WebSocket/);
    // F19: it hands exactly two addresses to the user's browser, both static SCRAPTF_BANKS pages from
    // the model, never one built from a row: a row's bank page (arm, copy, open) and the one-bank header's.
    expect(page.match(/openOnScraptf\(/g)).toHaveLength(1);
    expect(page).toContain('const b = marketScraptfButton(r, Date.now());');
    expect(page).toContain('void openOnScraptf(b.url, b.name, (text, tone) => toastRef.current(text, tone), { sku: r.sku, settings: settingsRef.current })');
    expect(page.match(/openOrCopy\(/g)).toHaveLength(1);
    // F21: worded for the user's scrap.tf window when main sends Flip Desk's scrap.tf links there.
    expect(page).toContain('const bankLink = marketBankLink(filters.categories, scraptfInWindow);');
    expect(page).toContain('const scraptfInWindow = scraptfLinksInWindow(settings);');
    expect(page).toContain('onClick={() => void openOrCopy(bankLink.url, toast, { allowWindow: true })}');
    expect(page).not.toMatch(/scraptfLink\.url/);
  });

  it('F15: applies a bank card\'s "See all" route while rendering, then drops it from the history', () => {
    expect(page).toContain('const intent = marketRouteIntent(segments);');
    // Set during render, so the first market.list already carries the bank's filters.
    expect(page).toMatch(/if \(intentKey !== appliedIntent\) \{\s*setAppliedIntent\(intentKey\);\s*if \(intent\) \{\s*setFilters\(intent\.filters\);\s*setSort\(intent\.sort\);/);
    expect(page).toMatch(/if \(intentKey !== null\) replaceRoute\('market'\);/);
    const replace = page.slice(page.indexOf('function replaceRoute'), page.indexOf('function newest'));
    expect(replace).toContain('window.history.replaceState(');
    expect(replace).toContain("window.dispatchEvent(new Event('hashchange'))");
    expect(replace).not.toMatch(/location\.hash\s*=/);
  });

  it('H2: reads the loaded window in one call; no chunked refresh, no snapshot pinning', () => {
    const model = read('marketModel.ts');
    const win = model.slice(model.indexOf('export function createMarketWindow'));
    expect(win).toContain('const readWindow = (q: Q, n: number): Promise<MarketListResult> => call({ ...q, ...windowRequest(n) });');
    expect(win).not.toMatch(/Promise\.all|windowRequests\(|mergeMarketPages/);
    expect(model).not.toMatch(/mergeMarketPages/);
    for (const src of [page, model]) expect(src).not.toMatch(/\bpin\b|repinned|\.version\b/);
  });

  it('H1: polls while a failed rebuild waits for its retry, and shows the error instead of "Building 0 %"', () => {
    expect(page).toContain('const pollMs = marketPollMs(result?.stats);');
    expect(page).toMatch(/useInterval\([\s\S]*?pollMs \?\? 0,\s*pollMs !== null && !frozen,\s*\);/);
    expect(page).toContain("case 'error':");
    expect(page).toMatch(/index && stats && index\.error \? \(\s*<IndexError/);
  });

  it('refetches on market.changed and prices.changed, throttled to 2 s and only while shown', () => {
    expect(page).toContain("usePush('market.changed'");
    expect(page).toContain("usePush('prices.changed'");
    expect(page).toMatch(/useThrottled\(\(\) => \{\s*if \(!frozenRef\.current\) win\.refresh\(\);\s*\}, 2000\)/);
    expect(page).toContain('createHiddenPushGate');
  });

  it('holds the window on Freeze (queued and in-flight refreshes too) and gates loading on it', () => {
    const toggle = page.slice(page.indexOf('const toggleFreeze'), page.indexOf('const onOpen'));
    expect(toggle).toMatch(/setFrozen\(true\);[\s\S]*win\.hold\(true\);[\s\S]*return;/);
    expect(toggle).toMatch(/win\.hold\(false\);\s*(\/\/.*\s*)*win\.refresh\(\);/);
    expect(page).toContain('frozen={frozen}');
  });

  it('keys the window on the minimum as typed, converting it with the key price per request', () => {
    // A key price move must not turn "1 key" into a new query (top of the list, Freeze bypassed).
    expect(page).not.toMatch(/readMinCeiling\(minText/);
    expect(page).toMatch(/readMinPrice\(minText\)/);
    expect(page).toMatch(/marketWindowQuery\(\{ \.\.\.filters, search \}, minPrice, sort\)/);
    expect(page).toContain("rpc('market.list', marketListParams(q, keyRef.current))");
  });
});

describe('market.css', () => {
  const css = readFileSync(new URL('../../src/renderer/styles/market.css', import.meta.url), 'utf8');

  it('takes every colour from the tokens', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\brgba?\(/);
  });

  it('turns the flash animation off for reduced motion', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced.length).toBeGreaterThan(40);
    expect(reduced).toMatch(/\.market-row\.flash-up,\s*\.market-row\.flash-down\s*\{\s*animation: none !important;/);
  });
});

// The grid's width budget with F14's "scrap.tf pays" and Stock columns, read from market.css itself:
// every layout has exactly one track per visible cell and fits its whole width range, and the common
// window sizes keep a readable item name.
describe('market.css width budget', () => {
  const css = readFileSync(new URL('../../src/renderer/styles/market.css', import.meta.url), 'utf8');
  const page = read('pages/MarketPage.tsx');
  const GAP = 10; // .opp-row column-gap
  const PAD = 24; // .opp-row padding, both sides
  // The opp-scroll container at a window width: the nav (208px, 58px up to 1100px), the page padding
  // (40px, 28px up to 1040px; layout.css), the table border (2px) and the 11px scrollbar.
  const container = (w: number) => w - (w <= 1100 ? 58 : 208) - (w <= 1040 ? 28 : 40) - 2 - 11;
  // From the 960px minimum window up: the narrowest container is just above the nav's breakpoint.
  const NARROWEST = Math.min(...[960, 1000, 1040, 1041, 1100, 1101, 1140].map(container));

  interface Layout {
    max: number;
    tracks: { min: number; flex: boolean }[];
    hidden: string[];
  }
  const tracksOf = (v: string) => [...v.matchAll(/minmax\((\d+)px, 1fr\)|(\d+)px/g)].map((m) => ({ min: Number(m[1] ?? m[2]), flex: m[1] !== undefined }));
  const layouts: Layout[] = [{ max: Infinity, tracks: tracksOf(/\.market-scroll \{\s*--market-cols: ([^;]+);/.exec(css)![1]!), hidden: [] }];
  for (const m of css.matchAll(/@container \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g)) {
    const body = m[2]!;
    const cols = /--market-cols: ([^;]+);/.exec(body);
    if (!cols) continue;
    const prev = layouts[layouts.length - 1]!;
    const hiddenHere = [...body.matchAll(/\.opp-row > \.(m-[a-z]+)/g)].map((h) => h[1]!);
    layouts.push({ max: Number(m[1]), tracks: tracksOf(cols[1]!), hidden: [...prev.hidden, ...hiddenHere] });
  }
  const need = (l: Layout) => l.tracks.reduce((s, t) => s + t.min, 0) + (l.tracks.length - 1) * GAP + PAD;
  /** The layout a container width gets: the narrowest query that still applies. */
  const layoutAt = (w: number) => [...layouts].reverse().find((l) => w <= l.max) ?? layouts[0]!;
  const nameWidth = (w: number) => {
    const l = layoutAt(w);
    return w - need(l) + l.tracks.find((t) => t.flex)!.min;
  };

  it('has the header cells in the row cells\' order, with the two list columns before Verdict', () => {
    const head = [...page.slice(page.indexOf('const HEAD'), page.indexOf('function HeadCell')).matchAll(/cls: '(m-[a-z]+)/g)].map((m) => m[1]);
    const row = page.slice(page.indexOf('const ItemRow = memo'));
    const cells = [...row.matchAll(/role="gridcell" className=\{?[`'"](m-[a-z]+)/g)].map((m) => m[1]);
    expect(head).toEqual(['m-item', 'm-cat', 'm-sells', 'm-buyers', 'm-pay', 'm-yours', 'm-list', 'm-stock', 'm-verdict', 'm-conf', 'm-updated']);
    expect(cells).toEqual(head);
    expect(layouts[0]!.tracks).toHaveLength(head.length);
  });

  it('gives every layout one track per visible cell and fits its whole range', () => {
    const cells = 11;
    expect(layouts.length).toBeGreaterThanOrEqual(5);
    layouts.forEach((l, i) => {
      expect(l.tracks.filter((t) => t.flex), `layout ≤${l.max}`).toHaveLength(1);
      expect(l.tracks.length, `layout ≤${l.max}`).toBe(cells - new Set(l.hidden).size);
      // A layout applies from just above the next query's width (or the narrowest window) up to its own.
      const lowest = i + 1 < layouts.length ? layouts[i + 1]!.max + 1 : NARROWEST;
      expect(need(l), `layout ≤${l.max} at ${lowest}px`).toBeLessThanOrEqual(lowest);
    });
    expect(NARROWEST).toBe(container(1101));
    expect(NARROWEST).toBe(840);
    expect(need(layouts[0]!)).toBe(1400);
    // Category goes first, the new list columns are never both gone, and Pay up to and Verdict always stay.
    expect(layouts[1]!.hidden).toEqual(['m-cat']);
    for (const l of layouts) {
      expect(l.hidden).not.toContain('m-list');
      expect(l.hidden).not.toContain('m-pay');
      expect(l.hidden).not.toContain('m-verdict');
    }
  });

  it('keeps a readable item name and both list columns at 1440 and 1280 px windows', () => {
    for (const w of [1280, 1360, 1440, 1920]) {
      for (const scrollbar of [0, 11]) {
        const c = container(w) + 11 - scrollbar;
        expect(nameWidth(c), `${w}px window`).toBeGreaterThanOrEqual(200);
        expect(layoutAt(c).hidden, `${w}px window`).not.toContain('m-stock');
      }
    }
    // A 1440 px window keeps Confidence and Updated (only Category and Buyers go).
    expect(layoutAt(container(1440)).hidden).toEqual(['m-cat', 'm-buyers']);
    for (const w of [960, 1040, 1100, 1101]) expect(nameWidth(container(w)), `${w}px window`).toBeGreaterThanOrEqual(130);
  });

  it('folds Stock into scrap.tf pays as a Full pill only where the Stock column is hidden', () => {
    expect(css).toMatch(/\.m-list \.list-full-inline \{\s*display: none;/);
    const narrow = css.slice(css.indexOf('@container (max-width: 950px)'));
    expect(narrow).toMatch(/\.opp-row > \.m-stock/);
    expect(narrow).toMatch(/\.market-scroll \.m-list \.list-full-inline \{\s*display: inline-flex;/);
  });
});

describe('the scrap.tf list filter (F14)', () => {
  const page = read('pages/MarketPage.tsx');

  it('offers onScraptfList under the Source choices (the toolbar already fills a 1280 px window), counted on the Source button', () => {
    const source = page.slice(page.indexOf('<Popover label={<>Source'), page.indexOf('<Popover label={<>Pay up to'));
    expect(source).toContain("<input type=\"checkbox\" checked={filters.onScraptfList} onChange={() => set('onScraptfList', !filters.onScraptfList)} />");
    expect(source).toContain('On scrap.tf&apos;s list');
    expect(source).toContain('active={sourceCount > 0}');
    // F17: marketSourceCount also counts "New on scrap.tf" (marketBankStock.test.ts).
    expect(page).toContain('const sourceCount = marketSourceCount(filters);');
    expect(page.match(/set\('onScraptfList'/g)).toHaveLength(1);
  });

  it("refetches the window on 'scraptf.listChanged' like a price change (throttled, hidden-gated, counted while frozen)", () => {
    // A maintenance purge pushes only this: the list cells, the filter and the "All items" chip must follow.
    expect(page).toContain("usePush('scraptf.listChanged', () => onLiveChange(1));");
  });
});

describe('0.8 (T7): the buy-timing tag in the Item cell', () => {
  const page = read('pages/MarketPage.tsx');
  const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
  const HOUR = 3_600_000;
  const brief = (over: Partial<ScraptfTimingBrief> = {}): ScraptfTimingBrief => ({
    verdict: 'wait',
    why: 'drop-likely',
    bank: 'hats',
    key: '378;6|',
    dropsThisRun: 1,
    steps: [],
    lastSeenAt: T0 - 3 * HOUR,
    horizonMs: 24 * HOUR,
    pDrop: 0.4,
    pGone: 0.2,
    pRise: 0.1,
    nextDropAt: null,
    n: { states: 30, copies: 5, atRisk: 9, dropCopies: 4 },
    ...over,
  });
  function row(sku: string, over: Partial<MarketRow> = {}): MarketRow {
    return {
      sku,
      name: `Item ${sku}`,
      category: 'hats',
      revenueScrap: 120,
      bestScrap: 130,
      consScrap: 120,
      instantScrap: 110,
      revenueOrder: null,
      buyerCount: 3,
      maxCostScrap: 100,
      confidence: 60,
      confidenceLevel: 'medium',
      flags: [],
      knownCostScrap: null,
      knownSource: 'none',
      knownObservedAt: null,
      stock: null,
      ruleCostScrap: null,
      profitScrap: null,
      verdict: 'unchecked',
      lastOrderChangeAt: T0 - HOUR,
      evaluatedAt: T0,
      scraptfPaysScrap: null,
      scraptfStock: null,
      scraptfStockLimit: null,
      scraptfFull: false,
      scraptfListAt: null,
      scraptfNewAt: null,
      scraptfListedSince: null,
      scraptfLink: scraptfLinkFor('hats', { bank: 'hats', at: T0 - 3 * HOUR }),
      ...over,
    };
  }

  it('sits after the New pill, from the row\'s scraptfTiming (no grid track of its own)', () => {
    expect(page).toContain('const timing = timingBadge(r.scraptfTiming, now, keyScrap);');
    const cell = page.slice(page.indexOf('<div role="gridcell" className="m-item">'), page.indexOf('<div role="gridcell" className="m-cat'));
    expect(cell.indexOf('market-new')).toBeLessThan(cell.indexOf('timing-badge'));
    expect(read('styles/market.css')).not.toContain('timing');
  });

  it("shows 'Wait ~1 d' for a wait row and 'Buy now' for a buy-now row, nothing for the other verdicts", async () => {
    const { MarketTable } = await import('../../src/renderer/pages/MarketPage');
    const rows = [
      row('378;6', { scraptfTiming: brief() }),
      row('30;6', { scraptfTiming: brief({ key: '30;6|', verdict: 'buy-now', why: 'gone-risk' }) }),
      row('31;6', { scraptfTiming: brief({ key: '31;6|', verdict: 'over', why: 'over' }) }),
      row('32;6'),
    ];
    const props: MarketTableProps = {
      rows: marketDisplayRows(rows, rows.length),
      dataKey: 'q',
      keyScrap: 568,
      now: T0,
      density: 'comfortable',
      selectedId: null,
      flash: { seq: 0, dirs: new Map() },
      sort: { ...DEFAULT_MARKET_SORT },
      loadingMore: false,
      frozen: false,
      onSelect: () => undefined,
      onOpen: () => undefined,
      onMenu: () => undefined,
      onLoadMore: () => undefined,
      onSort: () => undefined,
    };
    const h = renderToString(createElement(MarketTable, props)).replace(/<!-- -->/g, '');
    const tags = [...h.matchAll(/<span class="pill tone-(\w+) timing-badge" title="([^"]*)">([^<]+)<\/span>/g)].map((m) => [m[1], m[3]]);
    expect(tags).toEqual([
      ['warn', 'Wait ~1 d'],
      ['good', 'Buy now'],
    ]);
    expect(h).toContain('Of the 9 prices on scrap.tf/buy/hats still at their price at this age (from 30 prices of 5 items in your saves), 40 % dropped within 1 d');
    expect(h).toContain('From your save 3 h ago; an estimate, not a forecast.');
  });
});
