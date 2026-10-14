// Manual trade journal with FIFO profit (design brief §5.9). Each row is one
// item and stores the key price that applied when it was logged. A matched
// buy/sell pair is netted in keys and metal separately and the difference is
// valued at the sell row's key price, so a flip bought and sold for the same
// number of keys makes 0 whatever keys did in between, and later key price
// moves do not rewrite past profit.

import { valueScrap } from '../../shared/currency';
import type { JournalEntry, JournalPosition, JournalSummary, Scrap } from '../../shared/types';
import { DEFAULT_KEY_SCRAP } from './keyprice';

function validKeyPrice(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function finite(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Value of one row in scrap. A row without a usable key price borrows the nearest earlier one. */
export function journalValue(e: Pick<JournalEntry, 'keys' | 'scrap' | 'keyPriceScrap'>, fallbackKeyScrap: Scrap = DEFAULT_KEY_SCRAP): Scrap {
  return valueScrap(finite(e.keys), finite(e.scrap), validKeyPrice(e.keyPriceScrap) ? e.keyPriceScrap : fallbackKeyScrap);
}

/** One row's price in its own currencies, plus the key price that applied to it. */
interface Lot {
  keys: number;
  scrap: Scrap;
  k: Scrap;
}

/** Sell minus buy, netted per currency and valued at the sell row's key price. */
function pairProfit(sell: Lot, buy: Lot): Scrap {
  return valueScrap(sell.keys - buy.keys, sell.scrap - buy.scrap, sell.k);
}

/**
 * FIFO per SKU in time order: a sell closes the oldest open buy. A sell with no
 * open buy (the buy was never logged, or logged later) waits and is matched
 * against the next buy of that SKU; sells still unmatched at the end are not
 * counted as profit or as holdings. Open positions are valued at their buy rows'
 * own key prices.
 */
export function journalSummary(entries: JournalEntry[]): JournalSummary {
  const rows = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.sku === 'string' && e.sku !== '' && (e.side === 'buy' || e.side === 'sell'))
    .sort((a, b) => finite(a.ts) - finite(b.ts) || finite(a.id) - finite(b.id));

  const lots = new Map<string, Lot[]>();
  const pendingSells = new Map<string, Lot[]>();
  const names = new Map<string, string>();
  const bySku = new Map<string, { sku: string; name: string; realizedProfitScrap: Scrap; trades: number }>();
  let realized = 0;
  let trades = 0;
  let lastKeyPrice: Scrap = DEFAULT_KEY_SCRAP;

  const realize = (sku: string, profit: Scrap): void => {
    realized += profit;
    trades++;
    let s = bySku.get(sku);
    if (!s) bySku.set(sku, (s = { sku, name: '', realizedProfitScrap: 0, trades: 0 }));
    s.realizedProfitScrap += profit;
    s.trades++;
  };

  for (const e of rows) {
    if (validKeyPrice(e.keyPriceScrap)) lastKeyPrice = e.keyPriceScrap;
    const lot: Lot = { keys: finite(e.keys), scrap: finite(e.scrap), k: lastKeyPrice };
    const name = typeof e.name === 'string' && e.name.trim() ? e.name : names.get(e.sku) ?? e.sku;
    names.set(e.sku, name);

    if (e.side === 'buy') {
      const sell = pendingSells.get(e.sku)?.shift();
      if (sell !== undefined) {
        realize(e.sku, pairProfit(sell, lot));
        continue;
      }
      let queue = lots.get(e.sku);
      if (!queue) lots.set(e.sku, (queue = []));
      queue.push(lot);
    } else {
      const buy = lots.get(e.sku)?.shift();
      if (buy !== undefined) {
        realize(e.sku, pairProfit(lot, buy));
        continue;
      }
      let waiting = pendingSells.get(e.sku);
      if (!waiting) pendingSells.set(e.sku, (waiting = []));
      waiting.push(lot);
    }
  }

  const open: JournalPosition[] = [];
  for (const [sku, queue] of lots) {
    if (queue.length === 0) continue;
    open.push({ sku, name: names.get(sku) ?? sku, qty: queue.length, costScrap: queue.reduce((t, l) => t + valueScrap(l.keys, l.scrap, l.k), 0) });
  }
  open.sort((a, b) => b.costScrap - a.costScrap || a.sku.localeCompare(b.sku));

  const breakdown = [...bySku.values()]
    .map((s) => ({ ...s, name: names.get(s.sku) ?? s.sku }))
    .sort((a, b) => b.realizedProfitScrap - a.realizedProfitScrap || a.sku.localeCompare(b.sku));

  return { realizedProfitScrap: realized, realizedTrades: trades, open, bySku: breakdown };
}
