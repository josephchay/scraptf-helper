// scrap.tf banks (F15): the per-bank rules shared by the service's banks summary,
// the dashboard and the mock, so all three count, order and cut the same way.
// Pure functions over local data; nothing here fetches anything (R1).

import { bankForCategory } from './links';
import type { BankStockRow, Category, MarketRow, Opportunity, ScraptfBank, ScraptfBankFlip, ScraptfBankLookFor, ScraptfBankSummary } from './types';

/** ScraptfBankSummary.top holds at most this many flips. */
export const BANK_TOP_FLIPS = 3;
/** ScraptfBankSummary.lookFor holds at most this many items. */
export const BANK_LOOK_FOR = 5;

export type BankFlips = Pick<ScraptfBankSummary, 'flips' | 'flipProfitScrap' | 'top'>;
export type BankLookFor = Pick<ScraptfBankSummary, 'unchecked' | 'lookFor'>;

const byNameThenSku = (a: { name: string; sku: string }, b: { name: string; sku: string }): number =>
  a.name.localeCompare(b.name) || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);

/**
 * Flips per bank: 'profitable' opportunities whose input is an imported price (inputKind 'import') from
 * that bank, as `bankOf` says (the bank of the price behind inputRef, ScrapPrice.bank). The profit is
 * summed; `top` is the BANK_TOP_FLIPS most profitable, ties by name then SKU. Banks without a flip are absent.
 */
export function bankFlips(rows: readonly Opportunity[], bankOf: (o: Opportunity) => ScraptfBank | null): Map<ScraptfBank, BankFlips> {
  const per = new Map<ScraptfBank, Opportunity[]>();
  for (const o of rows) {
    if (o.status !== 'profitable' || o.inputKind !== 'import' || o.profitScrap === null) continue;
    const bank = bankOf(o);
    if (bank === null) continue;
    const list = per.get(bank) ?? [];
    list.push(o);
    per.set(bank, list);
  }
  const out = new Map<ScraptfBank, BankFlips>();
  for (const [bank, list] of per) {
    list.sort((a, b) => (b.profitScrap ?? 0) - (a.profitScrap ?? 0) || byNameThenSku(a, b));
    out.set(bank, {
      flips: list.length,
      flipProfitScrap: list.reduce((n, o) => n + (o.profitScrap ?? 0), 0),
      top: list.slice(0, BANK_TOP_FLIPS).map(
        (o): ScraptfBankFlip => ({
          sku: o.sku,
          name: o.name,
          profitScrap: o.profitScrap ?? 0,
          costScrap: o.costScrap,
          revenueScrap: o.revenueScrap ?? 0,
          confidenceLevel: o.confidenceLevel,
        }),
      ),
    });
  }
  return out;
}

/** A bank with no flips. */
export const NO_BANK_FLIPS: Readonly<BankFlips> = Object.freeze({ flips: 0, flipProfitScrap: 0, top: [] });

/**
 * 0.7.1 (UX-2b): a bank page's card flips from its stock page, so the two agree: `count` is the stock
 * page's Flips chip (BankStockResult.counts.flips) and `rows` its Flips rows, most profit first
 * (BankStockQuery filter 'flips', sort 'profit'). The profit is summed over the rows; `top` is the first
 * BANK_TOP_FLIPS. Each row is a copy, so a painted and a clean copy of one item are two flips, as on the page.
 */
export function bankStockFlips(rows: readonly BankStockRow[], count: number = rows.length): BankFlips {
  const flips = rows.filter((r) => r.change !== 'gone' && r.verdict === 'flip' && r.profitScrap !== null);
  return {
    flips: Number.isFinite(count) && count >= 0 ? Math.floor(count) : flips.length,
    flipProfitScrap: flips.reduce((n, r) => n + (r.profitScrap ?? 0), 0),
    top: flips.slice(0, BANK_TOP_FLIPS).map(
      (r): ScraptfBankFlip => ({
        sku: r.sku,
        name: r.name,
        profitScrap: r.profitScrap ?? 0,
        costScrap: r.costScrap,
        revenueScrap: r.revenueScrap ?? 0,
        confidenceLevel: r.confidenceLevel ?? 'low',
      }),
    ),
  };
}

/**
 * What to look for on a bank page: Live market rows of its categories with the verdict 'unchecked'
 * (buyers, no scrap.tf price of yours, no rule flip; the Live market's "Not checked" filter, which the
 * card's "See all" opens). `lookFor` is the BANK_LOOK_FOR of them with the highest Pay up to (above 0),
 * ties by name then SKU. No categories (the /items list): nothing. 0.7.4 (F36): with `bank`, a row is the
 * bank's when its scrap.tf button opens that page (MarketRow.scraptfLink: where a save showed it, else the
 * bank its kind is sold on, so a strange cosmetic is the hats bank's). 0.7.4 (R26): a row linked to the
 * /items list only goes by the bank its kind is sold on (MarketRow.kindBank, else its category's bank), as
 * the market's uncheckedBy groups it and MarketIndex.bankFor answers; a row with no link by `categories`.
 */
export function bankLookFor(rows: readonly MarketRow[], categories: readonly Category[], bank?: ScraptfBank): BankLookFor {
  if (categories.length === 0) return { unchecked: 0, lookFor: [] };
  let unchecked = 0;
  const priced: MarketRow[] = [];
  const inBank = (r: MarketRow): boolean => {
    const linked = r.scraptfLink?.bank;
    if (bank === undefined || linked === undefined) return categories.includes(r.category);
    if (linked === 'list') return (r.kindBank ?? bankForCategory(r.category)) === bank;
    return linked === bank;
  };
  for (const r of rows) {
    if (r.verdict !== 'unchecked' || !inBank(r)) continue;
    unchecked++;
    if (r.maxCostScrap !== null && r.maxCostScrap > 0 && r.revenueScrap !== null) priced.push(r);
  }
  priced.sort((a, b) => (b.maxCostScrap ?? 0) - (a.maxCostScrap ?? 0) || byNameThenSku(a, b));
  return {
    unchecked,
    lookFor: priced.slice(0, BANK_LOOK_FOR).map((r): ScraptfBankLookFor => ({ sku: r.sku, name: r.name, maxCostScrap: r.maxCostScrap ?? 0, revenueScrap: r.revenueScrap ?? 0 })),
  };
}
