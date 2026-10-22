// 0.9 (#13): scrap.tf's own price-drop wording on a bank stock row: the shared bankStockRow carries the newest save's
// `markdown` on an on-sale row only (never a gone or an /items family row), bankStockMarkdownTag words it as a tag
// ("Drops soon" / "Marked down", evidence only), and the bank stock table renders the pill inside .bs-tags, right
// after the timing badge. Pure, then rendered server-side; nothing leaves the process.

import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_BANK_STOCK_VIEW, bankStockMarkdownTag } from '../../src/renderer/bankStockModel';
import type { BankStockPageViewProps } from '../../src/renderer/pages/BankStockPage';
import { bankStockRows, emptyBankStockCounts } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { BankStockResult, BankStockRow, BankStockStored, ScraptfBank, ScraptfTimingBrief } from '../../src/shared/types';
import { installDomShim, ShimElement, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const K = 568;
const noop = () => undefined;

describe('0.9 (#13): bankStockMarkdownTag', () => {
  it("reads 'Drops soon' for 'soon' (also with 'off'), 'Marked down' for 'off' only, tone info", () => {
    expect(bankStockMarkdownTag({ markdown: ['soon'] })).toMatchObject({ text: 'Drops soon', tone: 'info' });
    expect(bankStockMarkdownTag({ markdown: ['off'] })).toMatchObject({ text: 'Marked down', tone: 'info' });
    expect(bankStockMarkdownTag({ markdown: ['off', 'soon'] })).toMatchObject({ text: 'Drops soon', tone: 'info' });
  });

  it('quotes what the card said, and says the wording is evidence only that nothing uses', () => {
    const tail =
      ' on your newest save. Evidence only: Flip Desk has not seen this wording on a real save yet, does not know when or by how much the price changes, and buy timing, profit and alerts do not use it. The parser report (Import page) shows the card.';
    expect(bankStockMarkdownTag({ markdown: ['soon'] })!.title).toBe(`scrap.tf's card said "This item will decrease in price shortly."${tail}`);
    expect(bankStockMarkdownTag({ markdown: ['off'] })!.title).toBe(`scrap.tf's card said that it is marked down from an original price${tail}`);
    expect(bankStockMarkdownTag({ markdown: ['off', 'soon'] })!.title).toBe(
      `scrap.tf's card said "This item will decrease in price shortly." and that it is marked down from an original price${tail}`,
    );
    // Never a forecast of its own.
    for (const m of [['soon'], ['off']] as const) expect(bankStockMarkdownTag({ markdown: [...m] })!.title).not.toMatch(/\bforecast\b|\bexpect/i);
  });

  it('is null without wording (absent, empty, or words this build does not know)', () => {
    expect(bankStockMarkdownTag({})).toBeNull();
    expect(bankStockMarkdownTag({ markdown: [] })).toBeNull();
    expect(bankStockMarkdownTag({ markdown: ['later'] as unknown as BankStockRow['markdown'] })).toBeNull();
    expect(bankStockMarkdownTag({ markdown: 'soon' as unknown as BankStockRow['markdown'] })).toBeNull();
  });
});

const stored = (over: Partial<BankStockStored> = {}): BankStockStored => ({
  sku: '378;6',
  specialKey: '',
  name: 'Team Captain',
  costKeys: 0,
  costScrap: 27,
  stock: 2,
  assetId: null,
  ...over,
});
const rowsOf = (newest: BankStockStored[], previous: BankStockStored[] | null, bank: ScraptfBank = 'hats') =>
  bankStockRows({ newest, previous, keyScrap: K, profit: DEFAULT_SETTINGS.profit, categoryOf: () => 'hats', buySideOf: () => null, bank });

describe('0.9 (#13): the shared bankStockRow carries markdown on an on-sale current row only', () => {
  it("copies the newest save's wording onto an on-sale row (a copy, not the stored array)", () => {
    const cur = stored({ markdown: ['soon'] });
    const [r] = rowsOf([cur], null);
    expect(r!.markdown).toEqual(['soon']);
    expect(r!.markdown).not.toBe(cur.markdown);
    const [both] = rowsOf([stored({ markdown: ['off', 'soon'] })], [stored()]);
    expect(both!.markdown).toEqual(['off', 'soon']);
  });

  it('leaves it off a gone row (even when the previous save had it), a row without it, and an /items family row', () => {
    const gone = rowsOf([], [stored({ markdown: ['soon'] })]);
    expect(gone).toHaveLength(1);
    expect(gone[0]!.change).toBe('gone');
    expect(gone[0]).not.toHaveProperty('markdown');
    // Sold out now: the row is gone, and the wording on the sold-out card is not shown either.
    const soldOut = rowsOf([stored({ stock: 0, markdown: ['off'] })], [stored()]);
    expect(soldOut[0]!.change).toBe('gone');
    expect(soldOut[0]).not.toHaveProperty('markdown');
    expect(rowsOf([stored()], null)[0]).not.toHaveProperty('markdown');
    expect(rowsOf([stored({ markdown: [] })], null)[0]).not.toHaveProperty('markdown');
    expect(rowsOf([stored({ markdown: null })], null)[0]).not.toHaveProperty('markdown');
    // An /items family row (craft not proven) never shows it; a proven list row would (none stores one: the parser
    // marks bank page cards only).
    expect(rowsOf([stored({ craft: 'any', markdown: ['soon'] })], null, 'list')[0]).not.toHaveProperty('markdown');
    expect(rowsOf([stored({ craft: 'craftable', markdown: ['soon'] })], null, 'list')[0]!.markdown).toEqual(['soon']);
  });
});

// ---------------------------------------------------------------------------
// The bank stock table, rendered
// ---------------------------------------------------------------------------

function row(over: Partial<BankStockRow> = {}): BankStockRow {
  return {
    sku: '378;6',
    key: '378;6|',
    name: 'Team Captain',
    category: 'hats',
    hasExtras: false,
    costKeys: 0,
    costScrapRaw: 27,
    costScrap: 27,
    stock: 3,
    change: null,
    previousCostScrap: 27,
    previousStock: 3,
    revenueScrap: 45,
    revenueOrder: { listingId: 'l', steamid: '76561198000000001', userName: 'Keybot', keys: 0, metalScrap: 45, valueScrap: 45, isBot: true, online: true, lastEventAt: T0, bumpedAt: null, details: '', flags: [], eligible: true },
    buyerCount: 4,
    maxCostScrap: 36,
    profitScrap: 9,
    margin: 1 / 3,
    verdict: 'flip',
    confidence: 72,
    confidenceLevel: 'high',
    listedSince: null,
    firstSeenAt: null,
    changeSinceListed: null,
    ...over,
  };
}
const brief = (over: Partial<ScraptfTimingBrief> = {}): ScraptfTimingBrief => ({
  verdict: 'buy-now',
  why: 'flip-now',
  bank: 'hats',
  key: '378;6|',
  dropsThisRun: 0,
  steps: [],
  lastSeenAt: T0 - 12 * MIN,
  horizonMs: 24 * HOUR,
  pDrop: 0.2,
  pGone: 0.4,
  pRise: 0.15,
  nextDropAt: null,
  n: { states: 41, copies: 6, atRisk: 8, dropCopies: 5 },
  ...over,
});

let doc: ShimDocument;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let BankStockPageView: typeof import('../../src/renderer/pages/BankStockPage').BankStockPageView;
const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  win()['location'] = { hash: '#/banks/hats/stock' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  const g = globalThis as Record<string, unknown>;
  g['HTMLElement'] ??= ShimElement;
  g['Element'] ??= ShimElement;
  if (!Object.getOwnPropertyDescriptor(ShimElement.prototype, 'options')) {
    Object.defineProperty(ShimElement.prototype, 'options', {
      configurable: true,
      get(this: ShimElement) {
        return this.tagName === 'SELECT' ? this.descendants().filter((e) => e.tagName === 'OPTION') : undefined;
      },
    });
  }
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ BankStockPageView } = await import('../../src/renderer/pages/BankStockPage'));
});

function props(rows: BankStockRow[]): BankStockPageViewProps {
  const result: BankStockResult = {
    bank: 'hats',
    label: 'Hats',
    url: 'https://scrap.tf/buy/hats',
    savedAt: T0 - 12 * MIN,
    previousSavedAt: T0 - 3 * HOUR,
    saves: 2,
    counts: { ...emptyBankStockCounts(), items: rows.length, inStock: rows.length },
    rows,
    total: rows.length,
    keyPrice: null,
    generatedAt: T0,
  };
  return {
    bank: 'hats',
    result,
    answered: { filter: 'all', sort: 'profit', dir: 'desc' },
    error: null,
    busy: false,
    status: null,
    view: { ...DEFAULT_BANK_STOCK_VIEW },
    now: T0,
    keyScrap: K,
    density: 'comfortable',
    selectedKey: null,
    picking: false,
    onView: noop,
    onRetry: noop,
    onOpenPage: noop,
    onBack: noop,
    onGoImport: noop,
    onPickFolder: noop,
    onCopyPath: noop,
    onExport: noop,
    onLoadMore: noop,
    onSelect: noop,
    onOpen: noop,
    onMenu: noop,
  };
}
const html = (rows: BankStockRow[]) => renderToString(createElement(AppProvider, null, createElement(BankStockPageView, props(rows)))).replace(/<!-- -->/g, '');

describe('0.9 (#13): the bank stock table renders the tag', () => {
  it('as a pill inside .bs-tags, right after the timing badge; none without wording', () => {
    const rows = [
      row({ markdown: ['soon'], timing: brief() }),
      row({ sku: '30;6', key: '30;6|', name: 'Hat B', markdown: ['off'] }),
      row({ sku: '31;6', key: '31;6|', name: 'Hat C' }),
    ];
    const h = html(rows);
    const cell = (i: number) => new RegExp(`<div id="bsrow-${i}"[\\s\\S]*?(?=<div id="bsrow-${i + 1}"|$)`).exec(h)![0];
    const soon = bankStockMarkdownTag(rows[0]!)!;
    expect(cell(0)).toMatch(
      /<span class="bs-tags"><span class="pill tone-good timing-badge" title="[^"]*">Buy now<\/span><span class="pill tone-info bs-markdown" title="[^"]*">Drops soon<\/span>/,
    );
    expect(cell(0)).toContain(`title="${soon.title.replace(/"/g, '&quot;').replace(/'/g, '&#x27;')}">Drops soon</span>`);
    // Without a timing tag, the pill alone opens the tags.
    expect(cell(1)).toMatch(/<span class="bs-tags"><span class="pill tone-info bs-markdown" title="[^"]*">Marked down<\/span><\/span>/);
    expect(cell(2)).not.toContain('bs-markdown');
    expect(cell(2)).not.toContain('bs-tags');
    expect(h.match(/bs-markdown/g)).toHaveLength(2);
  });
});
