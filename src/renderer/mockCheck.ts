// Live check (F16) for the browser mock: a simple take on the service's parseCheckText and its
// evaluation, plus the fixed demo results the popup shows at '#/check?demo=flip|over|no-price|not-item'.
// Development only: every number here is fake, and nothing reads a clipboard or leaves the page.

import {
  blankCheckResult,
  CHECK_EXTRAS_NOTE,
  CHECK_NOT_ITEM_REASON,
  CHECK_SCRAPTF_LINK_REASON,
  CHECK_SOLD_OUT_NOTE,
  checkHintPriceOf,
  checkTextRefusal,
} from '../shared/check';
import { frictionOf, maxCostFor, profitStatus } from '../shared/ceiling';
import { parsePrice, refToScrap, type ParsedPrice } from '../shared/currency';
import { fromString } from '../shared/sku';
import type {
  CheckPrice,
  CheckResult,
  CheckSource,
  ConfidenceLevel,
  ItemDetail,
  ItemRevenue,
  OrderSummary,
  ResolvedItem,
  Scrap,
  ScrapPrice,
  Settings,
  UnixMs,
} from '../shared/types';

export interface MockParsedCheck {
  item: ResolvedItem;
  /** The price copied with the item; null when none or "Sold out". */
  price: ParsedPrice | null;
  pays: ParsedPrice | null;
  /** The copied row had a "Price we pay" cell, priced or a dash: it beats the saved list's (as the service). */
  paysCopied: boolean;
  stock: number | null;
  stockLimit: number | null;
  soldOut: boolean;
}

export type MockParseCheck = { ok: true; parsed: MockParsedCheck } | { ok: false; status: 'not-item' | 'refused'; reason: string };

const SEPARATORS = '\t,;=@';
const SOLD_OUT = /^(?:sold\s*out|out\s+of\s+stock)$/i;
const STOCK_PAIR = /^(\d{1,6})\s*(?:\/|of)\s*(\d{1,6})$/i;

/** A zero price is no price, as the service reads it. */
function nonZero(p: ParsedPrice | null): ParsedPrice | null {
  return p !== null && (p.keys > 0 || p.scrap > 0) ? p : null;
}

/** "<item> <sep> <price>", else the last price-looking words (the bulk paste grammar, simplified). */
function splitPriced(line: string): { item: string; price: ParsedPrice } | null {
  for (let i = 0; i < line.length; i++) {
    const width = SEPARATORS.includes(line[i]!) ? 1 : line.startsWith(' - ', i) ? 3 : 0;
    if (width === 0) continue;
    const item = line.slice(0, i).trim();
    const price = parsePrice(line.slice(i + width), 'ref');
    if (item && price) return { item, price };
  }
  const words = line.split(/\s+/);
  for (let n = Math.min(4, words.length - 1); n >= 1; n--) {
    const price = parsePrice(words.slice(words.length - n).join(' '), 'ref');
    if (price) return { item: words.slice(0, words.length - n).join(' '), price };
  }
  return null;
}

/** Only a SKU or an exact name is an item: a fuzzy guess would be a wrong flip. */
function confident(r: ResolvedItem | null): ResolvedItem | null {
  return r !== null && r.match !== 'fuzzy' ? r : null;
}

/**
 * The service's four forms, simply: a copied /items row (tabs or runs of 2+ spaces: name, price to
 * buy or "Sold out", price we pay, n/limit), name then price on two lines, "<item> <sep> <price>",
 * or the item alone. Refusals first; reasons never quote the text.
 */
export function mockParseCheck(text: string, resolve: (text: string) => ResolvedItem | null): MockParseCheck {
  const refusal = checkTextRefusal(text);
  if (refusal !== null) return { ok: false, status: 'refused', reason: refusal };
  // As the service: a scrap.tf address is never opened, so it names no item (R1).
  if (/scrap\.tf\//i.test(text)) return { ok: false, status: 'not-item', reason: CHECK_SCRAPTF_LINK_REASON };
  const lines = text
    .split(/\r\n|\n|\r/)
    .map((l) => l.trim())
    .filter(Boolean);
  const none = { pays: null, paysCopied: false, stock: null, stockLimit: null, soldOut: false };

  if (lines.length === 1) {
    const fields = lines[0]!.split(/\t+| {2,}/).map((f) => f.trim()).filter(Boolean);
    if (fields.length >= 2) {
      const item = confident(resolve(fields[0]!));
      if (item) {
        const soldOut = SOLD_OUT.test(fields[1]!);
        const stockField = fields.slice(2).map((f) => STOCK_PAIR.exec(f)).find((m) => m !== null) ?? null;
        // A third cell that is not n/limit is "Price we pay": a dash there means scrap.tf pays nothing now.
        const paysCopied = fields[2] !== undefined && !STOCK_PAIR.test(fields[2]);
        return {
          ok: true,
          parsed: {
            item,
            price: soldOut ? null : nonZero(parsePrice(fields[1]!, 'ref')),
            pays: paysCopied ? nonZero(parsePrice(fields[2]!, 'ref')) : null,
            paysCopied,
            stock: stockField ? Number(stockField[1]) : null,
            stockLimit: stockField ? Number(stockField[2]) : null,
            soldOut,
          },
        };
      }
    }
  }
  if (lines.length === 2) {
    const item = confident(resolve(lines[0]!));
    const soldOut = SOLD_OUT.test(lines[1]!);
    const price = soldOut ? null : parsePrice(lines[1]!, 'ref');
    if (item && (price || soldOut)) return { ok: true, parsed: { item, ...none, price: nonZero(price), soldOut } };
  }
  if (lines.length === 1) {
    const split = splitPriced(lines[0]!);
    const item = split ? confident(resolve(split.item)) : null;
    if (split && item) return { ok: true, parsed: { item, ...none, price: nonZero(split.price) } };
    const alone = confident(resolve(lines[0]!));
    if (alone) return { ok: true, parsed: { item: alone, price: null, ...none } };
  }
  return { ok: false, status: 'not-item', reason: CHECK_NOT_ITEM_REASON };
}

/**
 * F19, as the service reads a 'check.text' hint: text that is one price and nothing else ("1.33 ref",
 * "2 keys 5.11", a copied price cell) is checked as the hinted item, by the shared checkHintPriceOf
 * (no id or year, and from the watcher no bare whole number). null for anything else; a text that names
 * an item never gets here, since the text wins.
 */
export function mockHintedParse(text: string, item: ResolvedItem, source: CheckSource): MockParsedCheck | null {
  const price = checkHintPriceOf(text, source);
  return price ? { item, price, pays: null, paysCopied: false, stock: null, stockLimit: null, soldOut: false } : null;
}

/** A price row with paint or other extras (mockData's rule): not what a plain copy costs. */
function hasExtras(p: ScrapPrice): boolean {
  if (fromString(p.sku).paint) return true;
  const s = p.special;
  return s !== null && (s.paint !== null || s.spells.length > 0 || s.parts.length > 0 || s.sheen !== null || s.killstreaker !== null || s.customName || s.customDesc);
}

const valueOf = (p: { keys: number; scrap: Scrap }, keyScrap: Scrap): Scrap => Math.round(p.keys * keyScrap) + Math.round(p.scrap);

/**
 * A parsed check judged like the service (chooseCheckPrice in src/service/domain/liveCheck.ts): a copied
 * "Sold out" or stock-0 row has no price at all (it is newer than anything stored); else the copied
 * price, else the saved list's price to buy (not sold out, not stock 0, and only for a plain copy: the
 * list prices plain copies), else the newest stored price (a clean copy first for a plain SKU, and
 * CHECK_EXTRAS_NOTE when only a painted or spelled copy is stored). Profit
 * and verdict by profitStatus; a copied pays cell, even a dash, beats the list's.
 */
export function mockCheckResult(a: {
  id: number;
  source: CheckSource;
  now: UnixMs;
  parsed: MockParsedCheck;
  detail: ItemDetail | null;
  keyScrap: Scrap;
  settings: Settings;
  confidence: { value: number; level: ConfidenceLevel } | null;
}): CheckResult {
  const { parsed, detail, keyScrap, now } = a;
  const list = detail?.scraptfList ?? null;
  const soldOut = parsed.soldOut || parsed.stock === 0;
  let plain = true;
  try {
    plain = !fromString(parsed.item.sku).paint;
  } catch {
    // an unparseable SKU counts as plain
  }
  let price: CheckPrice | null = null;
  /** A plain check priced from a copy with extras (the service's CHECK_EXTRAS_NOTE). */
  let otherCopy = false;
  if (soldOut) {
    price = null;
  } else if (parsed.price && (parsed.price.keys > 0 || parsed.price.scrap > 0)) {
    price = { keys: parsed.price.keys, scrapRaw: parsed.price.scrap, valueScrap: valueOf(parsed.price, keyScrap), source: 'clipboard', observedAt: now };
  } else if (plain && list && list.sellsScrap !== null && list.stock !== 0) {
    price = { keys: list.sellsKeys ?? 0, scrapRaw: list.sellsScrapRaw ?? 0, valueScrap: list.sellsScrap, source: 'list', observedAt: list.observedAt };
  } else {
    const stored = detail?.scrapPrices ?? [];
    const p = (plain ? stored.find((s) => !hasExtras(s)) : undefined) ?? stored[0];
    if (p) price = { keys: p.costKeys, scrapRaw: p.costScrap, valueScrap: valueOf({ keys: p.costKeys, scrap: p.costScrap }, keyScrap), source: p.source === 'import' ? 'import' : 'typed', observedAt: p.observedAt };
    otherCopy = plain && !!p && hasExtras(p);
  }
  const listPays = list?.paysScrap ?? null;
  const pays = parsed.paysCopied ? (parsed.pays ? valueOf(parsed.pays, keyScrap) : null) : listPays;
  const stock = parsed.stock ?? list?.stock ?? null;
  const stockLimit = parsed.stockLimit ?? list?.stockLimit ?? null;
  const listUsed =
    list !== null &&
    (price?.source === 'list' ||
      (!parsed.paysCopied && listPays !== null) ||
      (parsed.stock === null && list.stock !== null) ||
      (parsed.stockLimit === null && list.stockLimit !== null));

  const revenue = detail?.revenue ?? null;
  const rev = revenue?.revenueScrap ?? null;
  const profitScrap = price && rev !== null ? rev - price.valueScrap - frictionOf(a.settings.profit) : null;
  const status = price ? profitStatus(profitScrap, price.valueScrap, a.settings.profit) : null;
  return {
    id: a.id,
    status: 'item',
    source: a.source,
    reason: soldOut ? CHECK_SOLD_OUT_NOTE : otherCopy ? CHECK_EXTRAS_NOTE : null,
    sku: parsed.item.sku,
    name: detail?.name ?? parsed.item.name,
    category: detail?.category ?? parsed.item.category,
    price,
    scraptfPaysScrap: pays,
    stock,
    stockLimit,
    listAt: listUsed && list ? list.observedAt : null,
    revenue,
    profitScrap,
    margin: profitScrap !== null && price && price.valueScrap > 0 ? profitScrap / price.valueScrap : null,
    verdict: price === null ? 'no-price' : status === 'no-buyers' ? 'no-buyers' : status === 'profitable' ? 'flip' : 'over',
    confidence: a.confidence?.value ?? null,
    confidenceLevel: a.confidence?.level ?? null,
    links: detail?.links ?? [],
    keyScrap,
    checkedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Popup demos ('#/check?demo=…')
// ---------------------------------------------------------------------------

export type CheckDemo = 'flip' | 'over' | 'no-price' | 'not-item';
export const CHECK_DEMOS: readonly CheckDemo[] = ['flip', 'over', 'no-price', 'not-item'];

/** The demo named in a '#/check?demo=…' hash, or null. */
export function checkDemoFromHash(hash: string): CheckDemo | null {
  if (!hash.startsWith('#/check')) return null;
  const q = hash.indexOf('?');
  const v = q < 0 ? null : new URLSearchParams(hash.slice(q + 1)).get('demo');
  return (CHECK_DEMOS as readonly string[]).includes(v ?? '') ? (v as CheckDemo) : null;
}

function demoOrder(valueScrap: Scrap, keyScrap: Scrap, now: UnixMs, isBot: boolean): OrderSummary {
  const keys = Math.floor(valueScrap / keyScrap);
  return {
    listingId: `demo-${valueScrap}`,
    steamid: '76561198000000001',
    userName: isBot ? 'Demo Trading Bot' : 'demo trader',
    keys,
    metalScrap: valueScrap - keys * keyScrap,
    valueScrap,
    isBot,
    online: true,
    lastEventAt: now - 4 * 60_000,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
  };
}

function demoRevenue(valueScrap: Scrap, keyScrap: Scrap, now: UnixMs, settings: Settings, buyers: number, isBot: boolean): ItemRevenue {
  return {
    bestScrap: valueScrap + 4,
    consScrap: valueScrap,
    instantScrap: valueScrap,
    useOrder: settings.profit.useOrder,
    revenueScrap: valueScrap,
    order: demoOrder(valueScrap, keyScrap, now, isBot),
    maxCostScrap: maxCostFor(valueScrap, settings.profit),
    eligibleCount: buyers,
  };
}

/** Fixed results for the popup in a plain browser, valued at `keyScrap` with `settings.profit`. */
export function mockCheckDemo(kind: CheckDemo, now: UnixMs, keyScrap: Scrap, settings: Settings): CheckResult {
  if (kind === 'not-item') return blankCheckResult('not-item', CHECK_NOT_ITEM_REASON, 'hotkey', now, 9001, keyScrap);
  const friction = frictionOf(settings.profit);
  const base = { status: 'item' as const, reason: null, links: [], keyScrap, checkedAt: now };
  if (kind === 'flip') {
    const revenue = demoRevenue(keyScrap + refToScrap(22), keyScrap, now, settings, 6, true);
    const cost = keyScrap + refToScrap(5.33);
    const profitScrap = revenue.revenueScrap! - cost - friction;
    return {
      ...base,
      id: 9002,
      source: 'watch',
      sku: '378;6',
      name: 'Team Captain',
      category: 'hats',
      price: { keys: 1, scrapRaw: refToScrap(5.33), valueScrap: cost, source: 'clipboard', observedAt: now },
      scraptfPaysScrap: keyScrap - refToScrap(2),
      stock: 3,
      stockLimit: 12,
      listAt: now - 3 * 60_000,
      revenue,
      profitScrap,
      margin: profitScrap / cost,
      verdict: 'flip',
      confidence: 74,
      confidenceLevel: 'high',
    };
  }
  if (kind === 'over') {
    const revenue = demoRevenue(refToScrap(11.22), keyScrap, now, settings, 2, false);
    const cost = refToScrap(12.66);
    const profitScrap = revenue.revenueScrap! - cost - friction;
    return {
      ...base,
      id: 9003,
      source: 'hotkey',
      sku: '1118;6',
      name: 'Taunt: Conga',
      category: 'taunts',
      price: { keys: 0, scrapRaw: cost, valueScrap: cost, source: 'list', observedAt: now - 42 * 60_000 },
      scraptfPaysScrap: refToScrap(10.44),
      stock: 12,
      stockLimit: 12,
      listAt: now - 42 * 60_000,
      revenue,
      profitScrap,
      margin: profitScrap / cost,
      verdict: 'over',
      confidence: 51,
      confidenceLevel: 'medium',
    };
  }
  const revenue = demoRevenue(refToScrap(1.66), keyScrap, now, settings, 4, true);
  return {
    ...base,
    id: 9004,
    source: 'watch',
    sku: '94;6',
    name: 'Texas Ten Gallon',
    category: 'hats',
    price: null,
    scraptfPaysScrap: null,
    stock: null,
    stockLimit: null,
    listAt: null,
    revenue,
    profitScrap: null,
    margin: null,
    verdict: 'no-price',
    confidence: 63,
    confidenceLevel: 'medium',
  };
}
