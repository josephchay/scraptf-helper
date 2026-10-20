// 0.7.3 (r4-wording-3): on the bank stock page a row with eligible backpack.tf buyers but no revenue
// (every order an outlier, or Revenue used for profit on Instant and no realistic bot order) had a Pay up
// to hover saying "No eligible buy orders, so there is no ceiling." and a "No buyers" verdict pill saying
// "no eligible backpack.tf buy order for this item in the live book", next to its Sells for hover that
// already said why. The row carries no flags, so both read Settings' useOrder as bankStockSellsTitle does:
// the pill reads "No usable buyer" (as the check popup's) with quickModel's noRevenueText, and the Pay up to
// hover words it as the Live market's. Pure, plus the table rendered server-side. No network.

import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_BANK_STOCK_VIEW, bankStockPayTitle, bankStockVerdictPill } from '../../src/renderer/bankStockModel';
import type { BankStockPageViewProps } from '../../src/renderer/pages/BankStockPage';
import { emptyBankStockCounts } from '../../src/shared/bankStock';
import type { BankStockResult, BankStockRow } from '../../src/shared/types';

const K = 568;
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const noop = () => undefined;

/** Two buyers, none usable: no revenue, profit or ceiling, so the verdict is 'no-buyers'. */
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

describe('Bank stock: Pay up to without a usable buyer', () => {
  it("says why by Settings' Revenue used for profit, as the Live market's hover", () => {
    expect(bankStockPayTitle(ROW, K, 'instant')).toBe('No realistic bot order, and Revenue used for profit is Instant (bot orders only), so there is no ceiling.');
    expect(bankStockPayTitle(ROW, K, 'conservative')).toBe('Every eligible order looks unrealistic, so there is no ceiling.');
    expect(bankStockPayTitle({ ...ROW, hasExtras: true }, K, 'conservative')).toBe('Every eligible order looks unrealistic, so there is no ceiling. The ceiling is for a clean copy; this one has extras.');
  });

  it('claims neither reason while the setting is unknown', () => {
    for (const u of [undefined, null, 'best'] as const) {
      expect(bankStockPayTitle(ROW, K, u)).toBe('2 buyers with eligible orders, but none is usable for Revenue used for profit, so there is no ceiling.');
    }
  });

  it('is unchanged without buyers, and with a revenue', () => {
    expect(bankStockPayTitle({ ...ROW, buyerCount: 0 }, K, 'instant')).toBe('No eligible buy orders, so there is no ceiling.');
    expect(bankStockPayTitle({ ...ROW, revenueScrap: 30 }, K, 'instant')).toBe('No scrap.tf price clears your thresholds against these buyers.');
  });
});

describe('Bank stock: the verdict pill without a usable buyer', () => {
  it('reads "No usable buyer" and says why, as the check popup', () => {
    expect(bankStockVerdictPill(ROW, K, 'instant')).toEqual({
      tone: 'muted',
      text: 'No usable buyer',
      title: '2 buyers, but none is a realistic bot order, and Revenue used for profit is Instant (bot orders only), so nothing to sell it to.',
    });
    expect(bankStockVerdictPill(ROW, K, 'conservative').title).toBe('2 buyers, but every eligible order looks unrealistically high, so nothing to sell it to.');
    expect(bankStockVerdictPill(ROW, K, null).title).toBe('2 buyers, but none is usable for Revenue used for profit, so nothing to sell it to.');
  });

  it('keeps the gone-row lead and the clean-copy caveat', () => {
    expect(bankStockVerdictPill({ ...ROW, change: 'gone', hasExtras: true }, K, 'conservative').title).toBe(
      'At its last price: 2 buyers, but every eligible order looks unrealistically high, so nothing to sell it to. Judged as a clean copy: this one has extras.',
    );
  });

  it('is unchanged without buyers', () => {
    const none = bankStockVerdictPill({ ...ROW, buyerCount: 0 }, K, 'instant');
    expect(none).toMatchObject({ tone: 'muted', text: 'No buyers' });
    expect(none.title).toContain('no eligible backpack.tf buy order for this item in the live book.');
  });
});

describe('Bank stock page, rendered', () => {
  let AppProvider: (p: { children: ReactNode }) => ReactNode;
  let BankStockPageView: typeof import('../../src/renderer/pages/BankStockPage').BankStockPageView;

  beforeAll(async () => {
    ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
    ({ BankStockPageView } = await import('../../src/renderer/pages/BankStockPage'));
  });

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
  const render = (over: Partial<BankStockPageViewProps>) => renderToString(createElement(AppProvider, null, createElement(BankStockPageView, props(over))));
  const payTitle = (h: string) => /role="gridcell" class="bs-pay num" title="([^"]*)"/.exec(h)?.[1] ?? null;
  const pill = (h: string) => {
    const m = /class="pill verdict-pill tone-(\w+)" title="([^"]*)">([^<]*)</.exec(h);
    return m ? { tone: m[1], title: m[2], text: m[3] } : null;
  };

  it("hands Settings' useOrder down to the row's Pay up to hover and verdict pill", () => {
    for (const useOrder of ['instant', 'conservative', null] as const) {
      const h = render(useOrder === null ? {} : { useOrder });
      expect(payTitle(h)).toBe(bankStockPayTitle(ROW, K, useOrder));
      expect(pill(h)).toEqual(bankStockVerdictPill(ROW, K, useOrder));
    }
    expect(render({ useOrder: 'instant' })).not.toContain('No eligible buy orders');
  });
});
