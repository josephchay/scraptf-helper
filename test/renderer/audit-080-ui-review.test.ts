// 0.8 review fixes (ui): the bank stock Item cell keeps a floor for the name when the 0.8 timing and watch tags crowd
// it; Holdings keeps Held for (and its typical-hold hover) at the default window; the journal's edit dialog never
// calls a trade unpaired before the journal's summary is read; the watch rows' buttons name their watch; and the
// README describes the Since listed count, the watch's "Watch:" title and "Buy now" as the code does. Pure renders and
// static reads; nothing leaves the process.

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { editComparison, type RecordTradeInit } from '../../src/renderer/recordTradeModel';
import { journalEditInit, journalIndex } from '../../src/renderer/journalModel';
import { watchActionLabels } from '../../src/renderer/watchesModel';
import { journalSummary } from '../../src/shared/journal';
import type { BankStockRow, JournalEntry, ScraptfTimingBrief } from '../../src/shared/types';
import { installDomShim } from './domShim';

const src = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');
const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Bank stock: the Item cell's tags never squeeze the name to nothing
// ---------------------------------------------------------------------------

describe('bank stock Item cell (0.8 tags)', () => {
  const css = readFileSync(new URL('../../src/renderer/styles/bank-stock.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel: string) => new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';

  it('caps the tags at the cell minus the name floor, and lets each tag ellipse', () => {
    // The name keeps at least 64px (and the 6px gap): the tags take at most the rest, never growing past it.
    expect(rule('.bs-tags')).toMatch(/flex: 0 0 auto;/);
    expect(rule('.bs-tags')).toMatch(/max-width: calc\(100% - 70px\);/);
    expect(rule('.bs-tags')).toMatch(/overflow: hidden;/);
    expect(rule('.bs-tags')).toMatch(/min-width: 0;/);
    // Two classes, so it outranks each tag's own flex-shrink: 0 (.bs-was, .bs-watch, …, and .timing-badge).
    const tag = rule('.bs-item > .bs-tags > *');
    for (const d of ['flex-shrink: 1;', 'min-width: 0;', 'overflow: hidden;', 'text-overflow: ellipsis;', 'white-space: nowrap;']) expect(tag).toContain(d);
    // A pill (New, Wait / Buy now) is a flex box whose text cannot ellipse: a block of its height can.
    expect(rule('.bs-item > .bs-tags > .pill')).toMatch(/display: block;\s*line-height: 17px;/);
    // The narrowest Item track still leaves the tags room after the floor.
    const mins = [...css.matchAll(/--bs-cols: minmax\((\d+)px, 1fr\)/g)].map((m) => Number(m[1]));
    expect(Math.min(...mins) - 70).toBeGreaterThanOrEqual(80);
  });

  let BankStockTable: typeof import('../../src/renderer/pages/BankStockPage').BankStockTable;
  beforeAll(async () => {
    installDomShim();
    ({ BankStockTable } = await import('../../src/renderer/pages/BankStockPage'));
  });

  const brief = (over: Partial<ScraptfTimingBrief> = {}): ScraptfTimingBrief => ({
    verdict: 'wait',
    why: 'drop-likely',
    bank: 'hats',
    key: '378;6|[14,[],[],null,null,false,false]',
    dropsThisRun: 1,
    steps: [{ at: T0 - 5 * HOUR, prevAt: T0 - 6 * HOUR, fromScrap: 56, toScrap: 45, pct: -11 / 56 }],
    lastSeenAt: T0 - 12 * MIN,
    horizonMs: DAY,
    pDrop: 0.35,
    pGone: 0.25,
    pRise: 0.15,
    nextDropAt: null,
    n: { states: 41, copies: 6, atRisk: 8, dropCopies: 5 },
    ...over,
  });

  function row(over: Partial<BankStockRow> = {}): BankStockRow {
    return {
      sku: '378;6',
      key: '378;6|[14,[],[],null,null,false,false]',
      name: 'Team Captain',
      category: 'hats',
      hasExtras: true,
      costKeys: 0,
      costScrapRaw: 45,
      costScrap: 45,
      stock: 1,
      change: 'cheaper',
      previousCostScrap: 56,
      previousStock: 1,
      revenueScrap: 60,
      revenueOrder: { listingId: 'l', steamid: '76561198000000001', userName: 'Keybot', keys: 0, metalScrap: 60, valueScrap: 60, isBot: true, online: true, lastEventAt: T0, bumpedAt: null, details: '', flags: [], eligible: true },
      buyerCount: 4,
      maxCostScrap: 50,
      profitScrap: 9,
      margin: 0.2,
      verdict: 'flip',
      confidence: 72,
      confidenceLevel: 'high',
      listedSince: null,
      firstSeenAt: null,
      changeSinceListed: null,
      timing: brief(),
      watch: { id: 1, anyCopy: false, maxCostScrap: 44, minProfitScrap: null, onRestock: false, met: null, overTargetScrap: 1 },
      ...over,
    };
  }

  const html = (rows: BankStockRow[]) =>
    renderToString(
      createElement(BankStockTable, {
        rows,
        dataKey: 'k',
        gone: false,
        previousSavedAt: T0 - 3 * HOUR,
        keyScrap: 568,
        now: T0,
        density: 'comfortable',
        selectedKey: null,
        sort: 'profit',
        dir: 'desc',
        onSort: () => undefined,
        onSelect: () => undefined,
        onOpen: () => undefined,
        onMenu: () => undefined,
      }),
    ).replace(/<!-- -->/g, '');

  it('renders the change, timing, extras and watch tags inside .bs-tags, after the name', () => {
    const h = html([row()]);
    const cell = /<div role="gridcell" class="bs-item">([\s\S]*?)<\/div><div role="gridcell" class="bs-price/.exec(h)![1]!;
    expect(cell).toMatch(/^<span class="item-name-wrap">[\s\S]*?<\/span><span class="bs-tags">/);
    const tags = cell.slice(cell.indexOf('<span class="bs-tags">'));
    expect([...tags.matchAll(/class="(bs-was[^"]*|pill tone-\w+ timing-badge|bs-extras|bs-watch[^"]*)"/g)].map((m) => m[1]!.split(' ')[0])).toEqual(['bs-was', 'pill', 'bs-extras', 'bs-watch']);
    expect(tags).toContain('>Wait ~1 d</span>');
    expect(tags).toMatch(/class="bs-watch tone-text-warn"[^>]*>0\.11 ref over<\/span>/);
    // A row with no tag at all has no empty wrapper; a New row has its pill inside it.
    expect(html([row({ change: null, previousCostScrap: 45, timing: undefined, hasExtras: false, watch: undefined })])).not.toContain('bs-tags');
    expect(html([row({ change: 'new', previousCostScrap: null, timing: undefined, hasExtras: false, watch: undefined })])).toMatch(/<span class="bs-tags"><span class="pill tone-good bs-new"/);
  });
});

// ---------------------------------------------------------------------------
// Holdings: Updated goes before Held for, so the default window keeps Held for
// ---------------------------------------------------------------------------

describe('holdings.css breakpoints', () => {
  const css = readFileSync(new URL('../../src/renderer/styles/holdings.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const tracks = (cols: string) => cols.trim().split(/\s+(?![^(]*\))/).map((t) => Number((/(\d+)px/.exec(t) ?? ['', '0'])[1]));
  const width = (cols: string) => {
    const t = tracks(cols);
    return t.reduce((a, b) => a + b, 0) + (t.length - 1) * 10 + 24;
  };
  const queries = [...css.matchAll(/@container \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g)].map((m) => ({
    max: Number(m[1]),
    cols: /--hold-cols: ([^;]+);/.exec(m[2]!)![1]!,
    hides: [...m[2]!.matchAll(/> \.(h-[a-z]+)(?:,|\s*\{)/g)].map((x) => x[1]!),
  }));
  const full = /\.holdings-scroll \{\s*--hold-cols: ([^;]+);/.exec(css)![1]!;
  /** The cells hidden at a container width: every query whose max-width covers it. */
  const hiddenAt = (w: number) => new Set(queries.filter((q) => w <= q.max).flatMap((q) => q.hides));
  /** The layout in force at a container width: the narrowest query that covers it, else the full tracks. */
  const colsAt = (w: number) => queries.filter((q) => w <= q.max).sort((a, b) => a.max - b.max)[0]?.cols ?? full;

  it('keeps Held for and drops Updated at the default 1360px window (a ~1087px grid)', () => {
    const at = hiddenAt(1087);
    expect(at.has('h-held')).toBe(false);
    expect(at.has('h-updated')).toBe(true);
    expect(at.has('h-buyers') && at.has('h-conf')).toBe(true);
    // Item, Qty, Your cost, Held for, Sells now for, Profit now, Advice, actions.
    expect(tracks(colsAt(1087))).toHaveLength(8);
    expect(width(colsAt(1087))).toBeLessThanOrEqual(1087);
  });

  it('every layout fits the narrowest width its query covers, with tracks for the cells shown', () => {
    const cells = ['h-item', 'h-qty', 'h-cost', 'h-held', 'h-sells', 'h-buyers', 'h-profit', 'h-advice', 'h-conf', 'h-updated', 'h-actions'];
    const bounds = [...queries.map((q) => q.max), 1400].sort((a, b) => a - b);
    for (let i = 0; i < bounds.length; i++) {
      const lo = i === 0 ? 840 : bounds[i - 1]! + 1;
      const cols = colsAt(lo);
      expect(width(cols), `from ${lo}px`).toBeLessThanOrEqual(lo);
      expect(tracks(cols).length, `from ${lo}px`).toBe(cells.filter((c) => !hiddenAt(lo).has(c)).length);
    }
  });
});

// ---------------------------------------------------------------------------
// Journal edit: no "no recorded buy" / "Still held" before the summary is read
// ---------------------------------------------------------------------------

describe('journal edit before the summary is read', () => {
  const entry = (over: Partial<JournalEntry> & Pick<JournalEntry, 'id' | 'side'>): JournalEntry => ({
    ts: T0 - DAY,
    venue: 'scrap.tf',
    sku: '194;11',
    name: 'Strange Knife',
    keys: 0,
    scrap: 90,
    keyPriceScrap: 568,
    note: null,
    ...over,
  });
  const buy = entry({ id: 1, side: 'buy', ts: T0 - 3 * DAY });
  const sale = entry({ id: 2, side: 'sell', scrap: 120, venue: 'backpack.tf' });

  it('marks the pair unknown, not absent, while the summary is missing', () => {
    const init: RecordTradeInit = journalEditInit(sale, null, [sale, buy]);
    expect(init).toMatchObject({ editOf: sale, editPair: null, editPairUnknown: true });
    // With the summary, a trade with no pair is "none", not unknown.
    const idx = journalIndex(journalSummary([sale]));
    expect(journalEditInit(sale, idx, [sale]).editPairUnknown).toBeUndefined();
  });

  it('says the profit is worked out on save, never that the sale has no buy or the buy is still held', () => {
    for (const e of [sale, buy]) {
      const init = journalEditInit(e, null, [sale, buy]);
      const c = editComparison(e, { feeText: '' }, init.editPair ?? null, init.editPairUnknown === true);
      expect(c).toEqual({ tone: 'muted', text: "Your journal's totals have not loaded, so this trade's profit is worked out when you save." });
    }
    // Known to have no pair: the 0.8 texts stand.
    expect(editComparison(sale, { feeText: '' }, null).text).toBe('This sale has no recorded buy before it, so it books no profit yet.');
    expect(editComparison(buy, { feeText: '' }, null, false).text).toMatch(/^Still held/);
  });

  it('the dialog passes the flag through', () => {
    expect(src('components/RecordTradeDialog.tsx')).toContain('editComparison(editing, form, init.editPair ?? null, init.editPairUnknown === true)');
  });
});

// ---------------------------------------------------------------------------
// Watch rows: each Pause/Resume and Remove names its watch
// ---------------------------------------------------------------------------

describe('watch row buttons name their watch', () => {
  it('words the accessible names with the item and the copy', () => {
    const w = { sku: '378;6', name: 'Team Captain', enabled: true };
    expect(watchActionLabels({ ...w, specialKey: null })).toEqual({ toggle: 'Pause the watch of Team Captain (Any copy)', remove: 'Remove the watch of Team Captain (Any copy)' });
    expect(watchActionLabels({ ...w, specialKey: '', enabled: false })).toEqual({ toggle: 'Resume the watch of Team Captain (Clean copy)', remove: 'Remove the watch of Team Captain (Clean copy)' });
    // Two watches of one item (the drawer's "This copy" and "Any copy") get two names.
    expect(watchActionLabels({ ...w, specialKey: null }).remove).not.toBe(watchActionLabels({ ...w, specialKey: '' }).remove);
  });

  it('the Banks card and the drawer both use them', () => {
    for (const file of ['components/WatchesCard.tsx', 'components/WatchSection.tsx']) {
      const s = src(file);
      expect(s, file).toContain('const labels = watchActionLabels(w);');
      expect(s, file).toMatch(/aria-label=\{labels\.toggle\} onClick=\{\(\) => actions\.toggle\(w\)\}/);
      expect(s, file).toMatch(/aria-label=\{labels\.remove\} onClick=\{\(\) => actions\.remove\(w\)\}/);
    }
  });
});

// ---------------------------------------------------------------------------
// README says what the code does
// ---------------------------------------------------------------------------

describe('README', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

  it("Since listed's count shows from one drop (sinceListedDrops: n >= 1)", () => {
    expect(readme).not.toContain('when that took two drops or more');
    expect(readme).toContain('*· 1×*, *· 2×* and so on: how many drops your saves showed in that run');
  });

  it('a typed or imported price of a watched copy is told as "Watch:", not "Profit:"', () => {
    expect(readme).not.toContain("A watch's profit target is also that item's bar for its *Profit:* notification.");
    expect(readme).toContain('one that reaches it is titled *Watch: (item name)* in place of *Profit: (item name)*');
  });

  it('"Buy now" may come when the wait ran out, with no claim that time alone never fires it', () => {
    expect(readme).not.toContain('never just because time passed');
    expect(readme).toContain('after a drop showed or the wait it suggested ran out (not each time the estimate shifts as the listing ages)');
  });
});
