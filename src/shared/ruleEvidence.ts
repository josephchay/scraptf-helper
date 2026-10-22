// 0.7.4 (F78): a price-sheet rule never undercuts a price scrap.tf itself showed. A rule ("unique craftable
// hats cost 1.77 ref") prices every matching item with buy orders and no price of the user's; the audited
// saves showed hundreds of those items at far more (the Smissmas Caribou at 455 keys on the saved /items
// list, Buck Turner All-Stars at 192 scrap on an older /buy/hats save), so a flat rule turned them into
// impossible flips. Where the user's own saves showed the plain copy on sale at a higher price, that price
// is the cost (the row keeps its 'rule' input and is flagged 'rule-under-scraptf'). Shared by the engine's
// rule rows, the Live market's rule verdict and the mock, so all three agree. Local data only: the saved list and the
// retained bank saves already in memory, never a request (R1).

import { formatScrap, valueScrap } from './currency';
import { BANK_STOCK_PLAIN_KEY, bankStockKey } from './bankStock';
import { SCRAPTF_BANKS, SCRAPTF_ITEMS_URL, scraptfBankInfo } from './links';
import type { Scrap, ScraptfBank, ScraptfKeyRun, ScraptfListRow, UnixMs } from './types';

/** One price scrap.tf showed for the plain copy of an item, raw keys and metal as listed. */
export interface ScraptfSeenPrice {
  keys: number;
  scrap: Scrap;
  /** When that save or list showed it on sale. */
  at: UnixMs;
  /** The page: a bank, or 'list' for the saved scrap.tf/items list. */
  where: ScraptfBank;
}

/** What scraptfSeenPriceOf reads: the saved list (exact rows only) and the history's runs index per bank. */
export interface ScraptfSeenSources {
  /** ScraptfListCache.rowFor; a 'family' row (every copy at its price) is no proof for this copy and is skipped. */
  listRow?(base: string): ScraptfListRow | null;
  /** ScraptfHistory.runsFor: each retained save's sightings, keyed by bankStockKey. */
  runsFor?(bank: ScraptfBank): ReadonlyMap<string, ScraptfKeyRun>;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * The highest price (at the key price K; on a tie the newer) scrap.tf showed the plain copy of `base` on sale
 * for: the saved /items list's own row of it (any stock, a sold-out row's price included; never a family row),
 * and the last on-sale price of its run on every retained bank save. Null when neither shows one. A failing
 * source counts as none.
 */
export function scraptfSeenPriceOf(base: string, sources: ScraptfSeenSources, K: Scrap): ScraptfSeenPrice | null {
  const found: ScraptfSeenPrice[] = [];
  try {
    const row = sources.listRow?.(base) ?? null;
    if (row && row.match !== 'family' && row.sku === base && finite(row.sellsScrapRaw) && finite(row.observedAt)) {
      found.push({ keys: finite(row.sellsKeys) ? row.sellsKeys : 0, scrap: row.sellsScrapRaw, at: row.observedAt, where: 'list' });
    }
  } catch {
    // no list evidence
  }
  if (sources.runsFor) {
    const key = bankStockKey(base, BANK_STOCK_PLAIN_KEY);
    for (const info of SCRAPTF_BANKS) {
      if (info.bank === 'list') continue;
      try {
        const run = sources.runsFor(info.bank).get(key);
        // The price on the save at lastSeenAt (kept once it is off sale), else the newest on-sale one.
        const last = run?.lastOnSale ?? run?.current ?? null;
        const at = run?.lastSeenAt ?? null;
        if (run && last && finite(last.scrap) && finite(at)) found.push({ keys: finite(last.keys) ? last.keys : 0, scrap: last.scrap, at, where: info.bank });
      } catch {
        // that bank shows nothing
      }
    }
  }
  let best: ScraptfSeenPrice | null = null;
  let bestCost = 0;
  for (const s of found) {
    const cost = valueScrap(s.keys, s.scrap, K);
    if (best === null || cost > bestCost || (cost === bestCost && s.at > best.at)) {
      best = s;
      bestCost = cost;
    }
  }
  return best;
}

/**
 * A rule's cost for one item, never under what scrap.tf showed (`seen`): the rule's own keys and metal, or
 * the seen price when it is higher at K (`underScraptf` true). Equal or lower seen prices leave the rule.
 */
export function boundRuleCost(
  rule: { costKeys: number; costScrap: Scrap },
  seen: ScraptfSeenPrice | null,
  K: Scrap,
): { costKeys: number; costScrapRaw: Scrap; costScrap: Scrap; underScraptf: boolean } {
  const own = valueScrap(rule.costKeys, rule.costScrap, K);
  if (seen) {
    const shown = valueScrap(seen.keys, seen.scrap, K);
    if (shown > own) return { costKeys: seen.keys, costScrapRaw: seen.scrap, costScrap: shown, underScraptf: true };
  }
  return { costKeys: rule.costKeys, costScrapRaw: rule.costScrap, costScrap: own, underScraptf: false };
}

/**
 * The 'rule-under-scraptf' row's reason: "scrap.tf/buy/hats listed it at 21.33 ref on 2026-10-19, more than your
 * rule's 1.77 ref: that price is the cost". The date is the save's (UTC). The page is a SCRAPTF_BANKS path.
 */
export function ruleUnderScraptfReason(seen: ScraptfSeenPrice, ruleCostScrap: Scrap, keyScrap: Scrap): string {
  const page = (scraptfBankInfo(seen.where)?.url ?? SCRAPTF_ITEMS_URL).replace(/^https:\/\//, '');
  const day = Number.isFinite(seen.at) ? ` on ${new Date(seen.at).toISOString().slice(0, 10)}` : '';
  return `${page} listed it at ${formatScrap(valueScrap(seen.keys, seen.scrap, keyScrap), keyScrap)}${day}, more than your rule's ${formatScrap(ruleCostScrap, keyScrap)}: that price is the cost`;
}
