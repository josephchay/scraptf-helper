// 0.7.3 (follow-up to rmodelsB-1/rmodelsB-2): the Live market's and the bank stock page's "Sells for"
// hover said "Every eligible order looks unrealistic" for every row with buyers but no revenue, also
// with Revenue used for profit set to Instant and only human buyers. A market row tells the two apart
// by its own 'all-outliers' flag (as Holdings does); a bank stock row carries no flags, so the page
// passes Settings' useOrder. The market's Pay up to hover no longer says "no price clears" then
// either. Pure, plus the bank stock table rendered server-side. No network.

import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_BANK_STOCK_VIEW, bankStockSellsTitle } from '../../src/renderer/bankStockModel';
import { marketPayTitle, marketSellsForTitle } from '../../src/renderer/marketModel';
import type { BankStockPageViewProps } from '../../src/renderer/pages/BankStockPage';
import { emptyBankStockCounts } from '../../src/shared/bankStock';
import type { BankStockResult, BankStockRow, MarketRow } from '../../src/shared/types';

const K = 568;
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const noop = () => undefined;

/** The market row fields the two hovers read: three humans buying, no revenue. */
function marketRow(flags: string[], over: Partial<MarketRow> = {}): Pick<MarketRow, 'revenueScrap' | 'bestScrap' | 'consScrap' | 'instantScrap' | 'revenueOrder' | 'buyerCount' | 'maxCostScrap' | 'flags'> {
  return { revenueScrap: null, bestScrap: 130, consScrap: 120, instantScrap: null, revenueOrder: null, buyerCount: 3, maxCostScrap: null, flags, ...over };
}

describe('Live market: Sells for and Pay up to without a usable buyer', () => {
  it('names Instant when no flag says every order is an outlier', () => {
    const r = marketRow([]);
    expect(marketSellsForTitle(r, K)).toBe('3 buyers with eligible orders, but no realistic bot order, and Revenue used for profit is Instant (bot orders only), so no revenue is assumed.');
    expect(marketSellsForTitle(r, K)).not.toContain('unrealistic');
    expect(marketPayTitle(r, K)).toBe('No realistic bot order, and Revenue used for profit is Instant (bot orders only), so there is no ceiling.');
  });

  it("keeps \"looks unrealistic\" for 'all-outliers'", () => {
    const r = marketRow(['all-outliers'], { consScrap: null });
    expect(marketSellsForTitle(r, K)).toBe('Every eligible order looks unrealistic, so no revenue is assumed.');
    expect(marketPayTitle(r, K)).toBe('Every eligible order looks unrealistic, so there is no ceiling.');
  });

  it('is unchanged without buyers, and with a revenue', () => {
    expect(marketSellsForTitle(marketRow([], { buyerCount: 0 }), K)).toBe('No eligible backpack.tf buy orders in the live book.');
    expect(marketPayTitle(marketRow([], { buyerCount: 0 }), K)).toBe('No eligible buy orders, so there is no ceiling.');
    expect(marketPayTitle(marketRow([], { revenueScrap: 110 }), K)).toBe('No scrap.tf price clears your thresholds against these buyers.');
    expect(marketSellsForTitle(marketRow([], { revenueScrap: 120 }), K)).toMatch(/^Sells for .*\. 3 buyers with eligible orders\.$/);
  });
});

describe('Bank stock: Sells for without a usable buyer', () => {
  const row = { revenueScrap: null, revenueOrder: null, buyerCount: 2 };

  it("says why by Settings' Revenue used for profit", () => {
    expect(bankStockSellsTitle(row, K, 'instant')).toBe('2 buyers with eligible orders, but no realistic bot order, and Revenue used for profit is Instant (bot orders only), so no sale price is assumed.');
    expect(bankStockSellsTitle(row, K, 'conservative')).toBe('Every eligible order looks unrealistic, so no sale price is assumed.');
  });

  it('claims neither reason while the setting is unknown', () => {
    for (const u of [undefined, null, 'best'] as const) {
      const t = bankStockSellsTitle(row, K, u);
      expect(t).toBe('2 buyers with eligible orders, but none is usable for Revenue used for profit, so no sale price is assumed.');
    }
  });

  it('is unchanged without buyers', () => {
    expect(bankStockSellsTitle({ ...row, buyerCount: 0 }, K, 'instant')).toBe('No eligible backpack.tf buy orders for this item in the live book.');
  });
});

describe('Bank stock page, rendered', () => {
  let AppProvider: (p: { children: ReactNode }) => ReactNode;
  let BankStockPageView: typeof import('../../src/renderer/pages/BankStockPage').BankStockPageView;

  beforeAll(async () => {
    ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
    ({ BankStockPageView } = await import('../../src/renderer/pages/BankStockPage'));
  });

  const ROW: BankStockRow = {
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
    revenueScrap: null,
    revenueOrder: null,
    buyerCount: 2,
    maxCostScrap: null,
    profitScrap: null,
    margin: null,
    verdict: 'no-buyers',
    confidence: 30,
    confidenceLevel: 'low',
    listedSince: null,
    firstSeenAt: null,
    changeSinceListed: null,
  };
  const RESULT: BankStockResult = {
    bank: 'hats',
    label: 'Hats',
    url: 'https://scrap.tf/buy/hats',
    savedAt: T0 - 60_000,
    previousSavedAt: null,
    saves: 1,
    counts: { ...emptyBankStockCounts(), items: 1, inStock: 1 },
    rows: [ROW],
    total: 1,
    keyPrice: null,
    generatedAt: T0,
  };
  const props = (over: Partial<BankStockPageViewProps>): BankStockPageViewProps => ({
    bank: 'hats',
    result: RESULT,
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
    ...over,
  });
  const sellsTitle = (over: Partial<BankStockPageViewProps>) => {
    const html = renderToString(createElement(AppProvider, null, createElement(BankStockPageView, props(over))));
    return /role="gridcell" class="bs-sells" title="([^"]*)"/.exec(html)?.[1] ?? null;
  };

  it("hands Settings' useOrder down to the row's Sells for hover", () => {
    expect(sellsTitle({ useOrder: 'instant' })).toBe(bankStockSellsTitle(ROW, K, 'instant'));
    expect(sellsTitle({ useOrder: 'conservative' })).toBe(bankStockSellsTitle(ROW, K, 'conservative'));
    expect(sellsTitle({})).toBe(bankStockSellsTitle(ROW, K, null));
  });
});
