// Live check (F16, spec "F15 Live check"): one piece of text the user copied while browsing scrap.tf
// (read locally by main) or typed, resolved to a TF2 item and judged against the local order book and
// the saved scrap.tf list. No network of any kind: evaluation is item.detail {history:false,
// target:'plain'} over the stored book (R1, no scrap.tf request; nothing new toward backpack.tf either).
//
// Privacy: `text` is never logged, stored or quoted in a result or error. Only the resolved item
// (SKU, name, parsed price) leaves parseCheckText, every reason is fixed text, and only results are
// kept (the recent ring).
//
// F19: main may add a hint { sku } (the item the user opened on scrap.tf from the Live market, while
// its check.arm is unexpired). A text with no item but a price is then checked as that SKU; the
// reason names the resolved item (checkHintedNote), never the text. "A price" is checkHintPriceOf's:
// no id, year or phone number, and from the watcher no bare whole number at all.

import {
  blankCheckResult,
  CHECK_EXTRAS_NOTE,
  CHECK_FUZZY_NOTE,
  CHECK_INCOMPLETE_NOTE,
  CHECK_NOT_ITEM_REASON,
  CHECK_RECENT_MAX,
  CHECK_SCHEMA_LOADING_REASON,
  CHECK_SCRAPTF_LINK_REASON,
  CHECK_SOLD_OUT_NOTE,
  checkHintedNote,
  checkHintPriceOf,
  checkTextRefusal,
} from '../../shared/check';
import { categoryOfSkuOnly } from '../../shared/categories';
import { frictionOf, profitStatus } from '../../shared/ceiling';
import { parsePrice, valueScrap } from '../../shared/currency';
import { scraptfListUsePrice } from '../../shared/scraptfList';
import { fromObject, fromString, isValidSku } from '../../shared/sku';
import type {
  CheckHint,
  CheckPrice,
  CheckResult,
  CheckSource,
  CheckVerdict,
  ConfidenceLevel,
  ItemDetail,
  ItemRevenue,
  KeyPriceState,
  ResolvedItem,
  Scrap,
  ScrapPrice,
  ScraptfListRow,
  Settings,
  UnixMs,
} from '../../shared/types';
import type { Logger, Repo, SchemaService } from '../contracts';
import { looksLikePageContent, parsePriceLine } from '../priceSheetIo';
import { explicitInput } from './engine';
import { DEFAULT_KEY_SCRAP } from './keyprice';
import { evaluateMarketBase, type MarketIndex } from './market';
import { anyEffectBaseOf, matchContext } from './matcher';
import { lookupReferences, referencePrices } from './pricing';
import type { ScraptfListCache } from './scraptfList';
import { buildItemDetail } from './views';

/**
 * Which of the spec's text forms matched: a name/SKU/item URL alone, "<item> <sep> <price>", a copied /items
 * row, or name then price on two lines; 'hinted' (F19): a price alone, checked as main's hinted item.
 */
export type CheckForm = 'name' | 'priced' | 'items-row' | 'two-lines' | 'hinted';

/** A price as copied: keys and metal apart, metal in integer scrap. */
export interface CheckMoney {
  keys: number;
  scrap: Scrap;
}

/** What the parser keeps from the text: the resolved item and the numbers next to it, never the text. */
export interface ParsedCheck {
  form: CheckForm;
  item: ResolvedItem;
  /** The scrap.tf price copied with the item (keys + metal scrap); null when none, zero, or a "Sold out" row. */
  price: CheckMoney | null;
  /** A copied /items row's "Price we pay" column; null otherwise (or when the cell held no price, e.g. "—"). */
  pays: CheckMoney | null;
  /**
   * The copied row had a "Price we pay" cell, priced or not. Then it is what scrap.tf pays now, and an
   * older saved list's pays must not stand in for a dash.
   */
  paysCopied: boolean;
  /** A copied /items row's n/limit; null otherwise. */
  stock: number | null;
  stockLimit: number | null;
  /** The row said "Sold out" (it has no price to buy, so no cost). */
  soldOut: boolean;
  /** The item is a closest-match guess that ParseCheckOptions.confirmFuzzy accepted as unique. */
  fuzzy: boolean;
  /**
   * An exact match the resolver flagged as missing a part (an unusual's effect, a crate's series) or
   * as having dropped one (an unknown paint, an extra quality): the general item is what is checked.
   */
  incomplete: boolean;
}

export type ParseCheckResult =
  | { ok: true; parsed: ParsedCheck }
  | { ok: false; status: 'not-item' | 'refused'; reason: string };

export interface ParseCheckOptions {
  /**
   * Whether a closest-match guess (ResolvedItem.match 'fuzzy') for `itemText`, the item part of the
   * text, is unique and confident. Without it every fuzzy match is not-item: a wrong item would be a
   * wrong flip. `itemText` is the user's text: never log it or keep it.
   */
  confirmFuzzy?(itemText: string, item: ResolvedItem): boolean;
}

// The fixed reasons and notes live in shared/check.ts, so the browser mock words them alike.
export { CHECK_EXTRAS_NOTE, CHECK_FUZZY_NOTE, CHECK_INCOMPLETE_NOTE, CHECK_SCHEMA_LOADING_REASON, CHECK_SCRAPTF_LINK_REASON, CHECK_SOLD_OUT_NOTE };

/** Resolver calls one check may make (each can be a database lookup and a fuzzy name scan). */
export const CHECK_MAX_RESOLVES = 8;
/** Extra bulk-paste splits tried for the priced form, after its first one. */
const PRICED_SPARE_SPLITS = 4;
/** Prices are short; a longer field is never parsed. */
const MAX_PRICE_FIELD = 80;

/** Fields of a copied table row: tabs, or runs of 2+ spaces (a plain-text copy of the same row). */
const FIELD_SPLIT = /\t+|\s{2,}/;
const SOLD_OUT = /^(?:sold\s*out|out\s+of\s+stock)$/i;
// "49/50", "49 of 50", or the limits bar's two numbers copied on one line ("49 50").
const STOCK_PAIR = /^(\d{1,6})\s*(?:\/|of|\s)\s*(\d{1,6})$/i;
const STOCK_INT = /^\d{1,6}$/;
/** Optional labels a copy may carry: "Price to buy: 1.33 ref", "We pay 1.22 ref". */
const SELLS_LABEL = /^(?:price\s+to\s+buy|to\s+buy|buy\s+for|sells?(?:\s+for)?|we\s+sell(?:\s+for)?|price)\s*:?\s*/i;
const PAYS_LABEL = /^(?:price\s+we\s+pay|we\s+pay|pays?)\s*:?\s*/i;
/** The /items table's header row, when it was selected along with a row. */
const HEADER_LINE = /price\s+to\s+buy|price\s+we\s+pay|item\s+limits?/i;
/** Resolver notes that do not change which item is meant (as bulk paste reads them). */
const CLOSEST_MATCH_WARNING = /closest match/i;
const INFO_ONLY_WARNING = /BLU twin/i;
/** Characters a browser copy can carry that mean nothing here. */
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff]/g;

type Accepted = { item: ResolvedItem; fuzzy: boolean; incomplete: boolean };

function moneyOf(field: string): CheckMoney | null {
  const t = field.trim();
  if (!t || t.length > MAX_PRICE_FIELD) return null;
  const p = parsePrice(t, 'ref');
  return p ? { keys: p.keys, scrap: p.scrap } : null;
}

/** A zero price is no price ("0 ref" copied, or an empty cell read as 0). */
function nonZero(m: CheckMoney | null): CheckMoney | null {
  return m !== null && (m.keys > 0 || m.scrap > 0) ? m : null;
}

/** A "price to buy" cell: Sold out, or a price. Null when it is neither (or is labelled as what scrap.tf pays). */
function sellsCell(field: string): { soldOut: true; price: null } | { soldOut: false; price: CheckMoney | null } | null {
  if (PAYS_LABEL.test(field)) return null;
  const t = field.replace(SELLS_LABEL, '').trim();
  if (SOLD_OUT.test(t)) return { soldOut: true, price: null };
  const m = moneyOf(t);
  return m ? { soldOut: false, price: nonZero(m) } : null;
}

function isStockCell(field: string): boolean {
  return STOCK_PAIR.test(field) || STOCK_INT.test(field);
}

/**
 * How many leading cells of `rest` (what follows the price to buy) are "Price we pay": scrap.tf writes
 * prices with a unit ("1.22 refined"), so a bare integer is stock, unless an n/limit cell follows it
 * (then it is a pays price typed in ref). Anything else there (a dash) still takes the pays column.
 */
function paysCells(rest: readonly string[]): 0 | 1 {
  const cell = rest[0];
  if (cell === undefined || STOCK_PAIR.test(cell)) return 0;
  if (STOCK_INT.test(cell)) return rest[1] !== undefined && STOCK_PAIR.test(rest[1]) ? 1 : 0;
  return 1;
}

interface RowCandidate {
  nameField: string;
  sells: NonNullable<ReturnType<typeof sellsCell>>;
  pays: CheckMoney | null;
  paysCopied: boolean;
  stock: number | null;
  stockLimit: number | null;
}

/**
 * The ways `fields` reads as a copied /items row: an item name (the first field, or the second
 * when a leading cell such as the icon's came along), then "Price to buy" (a price or "Sold out"),
 * then optionally "Price we pay" and the n/limit (or n and limit as two cells). A bare
 * "<name> <price>" pair is left to the priced form.
 */
function rowCandidates(fields: readonly string[]): RowCandidate[] {
  const out: RowCandidate[] = [];
  for (let i = 0; i <= 1 && i + 1 < fields.length; i++) {
    const sells = sellsCell(fields[i + 1]!);
    if (!sells) continue;
    const rest = fields.slice(i + 2);
    if (rest.length === 0 && !sells.soldOut) continue;
    const k = paysCells(rest);
    const pays = k === 1 ? nonZero(moneyOf(rest[0]!.replace(PAYS_LABEL, ''))) : null;
    let stock: number | null = null;
    let stockLimit: number | null = null;
    const pair = rest[k] !== undefined ? STOCK_PAIR.exec(rest[k]!) : null;
    if (pair) {
      stock = Number(pair[1]);
      stockLimit = Number(pair[2]);
    } else if (rest[k] !== undefined && STOCK_INT.test(rest[k]!)) {
      stock = Number(rest[k]);
      if (rest[k + 1] !== undefined && STOCK_INT.test(rest[k + 1]!)) stockLimit = Number(rest[k + 1]);
    }
    out.push({ nameField: fields[i]!, sells, pays, paysCopied: k === 1, stock, stockLimit });
  }
  return out;
}

function fieldsOf(line: string): string[] {
  return line
    .split(FIELD_SPLIT)
    .map((f) => f.trim())
    .filter(Boolean);
}

/** A name with only letters and digits, lower case, without a leading "The" (the schema's proper-name article). */
function squashName(s: string): string {
  return String(s ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/^\s*the\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The same name but for case, spacing, punctuation and accents ("Bills Hat" and "Bill's Hat"). */
export function looselySameName(text: string, name: string): boolean {
  const a = squashName(text);
  return a.length > 0 && a === squashName(name);
}

/**
 * Pure. Resolves `text` to one item with `resolve` (schema.resolve). A fuzzy match is accepted only
 * when it is unique and confident (the item's own name but for case and punctuation, or
 * `opts.confirmFuzzy`); otherwise not-item. Exact matches the resolver flagged are kept, marked
 * `incomplete`. Refusals (markup, a list,
 * too long, empty) come first and use the fixed CHECK_REFUSALS texts; a scrap.tf link is not-item and
 * is never resolved or fetched. Never puts `text` into a reason. At most CHECK_MAX_RESOLVES resolver
 * calls per text, so the watcher cannot turn one copy into many database scans.
 *
 * Forms, in this order:
 * 1. a copied /items row (tabs or runs of 2+ spaces: name, price to buy or "Sold out", price we pay,
 *    n/limit; n and limit may wrap onto the next lines, and a selected header line is ignored);
 * 2. the item alone: a name, SKU or backpack.tf / marketplace.tf item URL (exact matches first);
 * 3. `<item> <sep> <price>`: the bulk paste grammar (parsePriceLine), bare numbers in ref (tried
 *    before form 2 for a link followed by more text, which the URL parse would swallow);
 * 4. two lines: name, then price (or "Sold out").
 */
export function parseCheckText(text: string, resolve: (text: string) => ResolvedItem | null, opts: ParseCheckOptions = {}): ParseCheckResult {
  const refusal = checkTextRefusal(text);
  if (refusal !== null) return { ok: false, status: 'refused', reason: refusal };
  const notItem = (reason: string = CHECK_NOT_ITEM_REASON): ParseCheckResult => ({ ok: false, status: 'not-item', reason });
  const src = String(text).replace(INVISIBLE, '');
  // Never followed or fetched: a scrap.tf address names no item we could check (R1).
  if (looksLikePageContent(src)) return notItem(CHECK_SCRAPTF_LINK_REASON);

  // One budget and one memo per text: repeated item parts cost one lookup.
  const memo = new Map<string, ResolvedItem | null>();
  let left = CHECK_MAX_RESOLVES;
  const lookup = (t: string): ResolvedItem | null => {
    const key = t.replace(/\s+/g, ' ').trim();
    if (!key) return null;
    if (memo.has(key)) return memo.get(key)!;
    if (left <= 0) return null;
    left--;
    let r: ResolvedItem | null = null;
    try {
      r = resolve(key);
    } catch {
      r = null;
    }
    memo.set(key, r);
    return r;
  };
  const confirm = (itemText: string, item: ResolvedItem): boolean => {
    try {
      return opts.confirmFuzzy?.(itemText, item) === true;
    } catch {
      return false;
    }
  };
  /**
   * Exact or SKU matches always (flagged incomplete when the resolver noted more than a BLU twin). A
   * fuzzy one only with nothing else wrong, and then either the item's own name but for case and
   * punctuation (scrap.tf writes "Bills Hat": no guess at all) or confirmFuzzy's yes.
   */
  const accept = (item: ResolvedItem | null, itemText: string, allowFuzzy: boolean): Accepted | null => {
    if (!item) return null;
    if (item.match !== 'fuzzy') return { item, fuzzy: false, incomplete: item.warnings.some((w) => !INFO_ONLY_WARNING.test(w)) };
    const onlyGuess = item.warnings.every((w) => CLOSEST_MATCH_WARNING.test(w) || INFO_ONLY_WARNING.test(w));
    if (!onlyGuess) return null;
    if (looselySameName(itemText, item.name)) return { item, fuzzy: false, incomplete: false };
    if (!allowFuzzy) return null;
    return confirm(itemText, item) ? { item, fuzzy: true, incomplete: false } : null;
  };
  const parsed = (form: CheckForm, a: Accepted, extra: Partial<Omit<ParsedCheck, 'form' | 'item' | 'fuzzy' | 'incomplete'>> = {}): ParseCheckResult => ({
    ok: true,
    parsed: {
      form,
      item: a.item,
      price: null,
      pays: null,
      paysCopied: false,
      stock: null,
      stockLimit: null,
      soldOut: false,
      fuzzy: a.fuzzy,
      incomplete: a.incomplete,
      ...extra,
    },
  });
  const asRow = (fields: readonly string[]): ParseCheckResult | null => {
    for (const allowFuzzy of [false, true]) {
      for (const c of rowCandidates(fields)) {
        const a = accept(lookup(c.nameField), c.nameField, allowFuzzy);
        if (a) {
          return parsed('items-row', a, {
            price: c.sells.price,
            soldOut: c.sells.soldOut,
            pays: c.pays,
            paysCopied: c.paysCopied,
            stock: c.stock,
            stockLimit: c.stockLimit,
          });
        }
      }
    }
    return null;
  };

  let lines = src
    .split(/\r\n|\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length > 1) lines = lines.filter((l) => !(HEADER_LINE.test(l) && !/\d/.test(l)));
  if (lines.length === 0) return notItem();

  const first = lines[0]!;
  const firstFields = fieldsOf(first);

  if (lines.length > 1) {
    // A copied row whose n/limit cell wrapped onto its own lines ("49" / "50"): one row again.
    if (firstFields.length >= 2 && lines.slice(1).every(isStockCell)) {
      const row = asRow([...firstFields, ...lines.slice(1)]);
      if (row) return row;
    }
    if (lines.length !== 2) return notItem();
    const sells = sellsCell(lines[1]!);
    if (!sells) return notItem();
    for (const allowFuzzy of [false, true]) {
      const a = accept(lookup(first), first, allowFuzzy);
      if (a) return parsed('two-lines', a, { price: sells.price, soldOut: sells.soldOut });
    }
    return notItem();
  }

  if (firstFields.length >= 2) {
    const row = asRow(firstFields);
    if (row) return row;
  }
  // Read once, on first use: every split after the first draws on the resolver budget.
  let line: ReturnType<typeof parsePriceLine> | undefined;
  const priced = (allowFuzzy: boolean): ParseCheckResult | null => {
    if (line === undefined) {
      try {
        line = parsePriceLine(first, 'ref', lookup, { left: PRICED_SPARE_SPLITS });
      } catch {
        line = null;
      }
    }
    const l = line;
    const a = l ? accept(l.item, l.itemText, allowFuzzy) : null;
    return a && l ? parsed('priced', a, { price: nonZero({ keys: l.price.keys, scrap: l.price.scrap }) }) : null;
  };
  // A copied link never holds raw whitespace (browsers percent-encode it), so a link followed by more
  // text is "<link> <sep> <price>". Read that before the whole line: parsed as one URL, the price would
  // end up in the link's last path segment and be dropped (and a Non-Craftable link read as craftable).
  if (/^https?:\/\/\S+\s+\S/i.test(first)) {
    const linkPriced = priced(false);
    if (linkPriced) return linkPriced;
  }
  // The whole line first: a name may end in a number ("Mann Co. Supply Crate Series #30") and an item
  // link may hold a separator (marketplace.tf/items/tf2/378;6). A fuzzy guess waits for the priced form.
  const whole = lookup(first);
  const exact = accept(whole, first, false);
  if (exact) return parsed('name', exact);
  const cleanPriced = priced(false);
  if (cleanPriced) return cleanPriced;
  const guessed = accept(whole, first, true);
  if (guessed) return parsed('name', guessed);
  return priced(true) ?? notItem();
}

/**
 * F19. Pure: the price when the text is only a price ("1.33 ref", "2 keys 5.11", a copied price cell),
 * by the shared checkHintPriceOf (the mock's mockHintedParse reads it alike): a short bare number is ref,
 * a long one (an id, a year, a phone number) is no price, and for the watcher, which sees copies from any
 * app, a bare whole number or a one-letter unit is none either. Null for anything else, a refused text
 * included. Only the numbers leave it.
 */
export function checkHintPrice(text: string, source: CheckSource): CheckMoney | null {
  const p = checkHintPriceOf(text, source);
  return p ? { keys: p.keys, scrap: p.scrap } : null;
}

/** The hint's SKU under the service's SKU rule (trimmed, lower case, isValidSku), else null: an invalid hint is no hint. */
function hintSkuOf(hint: CheckHint | null | undefined): string | null {
  const raw: unknown = hint?.sku;
  if (typeof raw !== 'string') return null;
  const sku = raw.trim().toLowerCase();
  return sku.length > 0 && sku.length <= 300 && isValidSku(sku) ? sku : null;
}

/**
 * F19. Pure: `text` checked as the hinted item ('check.text' hint: the item the user opened on scrap.tf
 * from the Live market) when it is only a price (checkHintPrice, by `source`); null without a valid hint
 * or for any other text. Only for text parseCheckText found no item in: text that names an item wins. The
 * SKU is the app's own (main's arm), so it is taken as is: never resolved by name, never fuzzy or incomplete.
 */
export function hintedCheck(text: string, hint: CheckHint | null | undefined, source: CheckSource): ParsedCheck | null {
  const sku = hintSkuOf(hint);
  if (sku === null) return null;
  const price = checkHintPrice(text, source);
  if (price === null) return null;
  let item: ResolvedItem;
  try {
    const skuObject = fromString(sku);
    // Only `sku` is read by the evaluation; the name and category come from the item detail.
    item = { sku: fromObject(skuObject), name: sku, skuObject, category: categoryOfSkuOnly(skuObject), match: 'sku', warnings: [] };
  } catch {
    return null;
  }
  return { form: 'hinted', item, price, pays: null, paysCopied: false, stock: null, stockLimit: null, soldOut: false, fuzzy: false, incomplete: false };
}

export interface LiveCheckDeps {
  repo: Repo;
  schema: SchemaService;
  log: Logger;
  settings(): Settings;
  /** The engine's key price: every money figure of a result is valued at it (CheckResult.keyScrap). */
  keyPrice(): KeyPriceState;
  /** Buyer confidence: the market entry's when the base has one. */
  market: Pick<MarketIndex, 'entryFor'>;
  /** The saved scrap.tf/items row: price, what scrap.tf pays, stock, limit, age. */
  scraptfList: Pick<ScraptfListCache, 'rowFor'>;
}

export interface LiveCheck {
  /**
   * Checks one text (at most CHECK_MAX_CHARS; 'check.text' validated it). Item results go into the
   * recent ring; the caller pushes 'check.done' for them. Never throws for any text (a failing
   * database read does, and the handler hides its cause). F19: with main's `hint`, a text that is only
   * a price is checked as the hinted item (hintedCheck), its reason checkHintedNote; text naming an
   * item ignores the hint, and without one (or with an invalid one) nothing changes.
   */
  check(text: string, source: CheckSource, now: UnixMs, hint?: CheckHint): CheckResult;
  /** The last CHECK_RECENT_MAX item results, newest first (copies). */
  recent(): CheckResult[];
}

/** schema.search calls one check may make to confirm fuzzy matches. */
const MAX_FUZZY_SEARCHES = 2;
const NO_SNAPSHOT: ItemDetail['snapshot'] = { lastAt: null, available: false, nextAllowedAt: null };

function attempt<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

function canonicalBase(sku: string): string | null {
  return attempt(() => fromObject({ ...fromString(sku), paint: null }), null);
}

/**
 * The user's newest typed or imported price usable as a cost (the engine's explicitInput), newest by
 * observedAt then id. For a plain SKU a copy without extras wins: a painted or spelled copy's price is
 * not what a plain one costs (the Live market flags those rows 'has-extras' instead).
 */
export function newestStoredPrice(prices: readonly ScrapPrice[], plain: boolean): ScrapPrice | null {
  const usable = prices
    .map((p) => ({ p, input: attempt(() => explicitInput(p), null) }))
    .filter((x): x is { p: ScrapPrice; input: NonNullable<ReturnType<typeof explicitInput>> } => x.input !== null)
    .sort((a, b) => b.p.observedAt - a.p.observedAt || b.p.id - a.p.id);
  if (plain) {
    const clean = usable.find((x) => !x.input.target.hasExtras);
    if (clean) return clean.p;
  }
  return usable[0]?.p ?? null;
}

/** The stored price is for a copy with paint, spells or parts (the engine's target.hasExtras). */
export function storedPriceHasExtras(p: ScrapPrice): boolean {
  return attempt(() => explicitInput(p)?.target.hasExtras === true, false);
}

/** A copied row with nothing to buy: "Sold out", or stock 0 (as scraptfListUsePrice and the saved-page import read it). */
export function copiedSoldOut(parsed: Pick<ParsedCheck, 'soldOut' | 'stock'>): boolean {
  return parsed.soldOut || parsed.stock === 0;
}

/**
 * The price the check compares (spec F15/F16): the copied price first, else the saved list's price to
 * buy (scraptfListUsePrice: not sold out, not stock 0), else the newest typed or imported price. A
 * copied "Sold out" (or stock 0) row has no price at all: it is newer than anything stored. The list
 * prices plain copies only, so a painted check (`plain` false) never takes its price.
 */
export function chooseCheckPrice(a: {
  parsed: Pick<ParsedCheck, 'price' | 'soldOut' | 'stock'>;
  list: ScraptfListRow | null;
  stored: ScrapPrice | null;
  keyScrap: Scrap;
  now: UnixMs;
  /** The checked SKU has no paint (default true). */
  plain?: boolean;
}): CheckPrice | null {
  const K = a.keyScrap;
  if (copiedSoldOut(a.parsed)) return null;
  if (a.parsed.price) {
    const { keys, scrap } = a.parsed.price;
    return { keys, scrapRaw: scrap, valueScrap: valueScrap(keys, scrap, K), source: 'clipboard', observedAt: a.now };
  }
  const use = a.list && a.plain !== false ? scraptfListUsePrice(a.list) : null;
  if (use && a.list) return { keys: use.keys, scrapRaw: use.scrap, valueScrap: valueScrap(use.keys, use.scrap, K), source: 'list', observedAt: a.list.observedAt };
  const p = a.stored;
  if (!p) return null;
  const keys = Number.isFinite(p.costKeys) ? p.costKeys : 0;
  return { keys, scrapRaw: p.costScrap, valueScrap: valueScrap(keys, p.costScrap, K), source: p.source === 'import' ? 'import' : 'typed', observedAt: p.observedAt };
}

/** flip / over / no-buyers by profitStatus against the chosen price, as the engine and the Live market judge it; no-price without one. */
export function checkVerdict(profitScrap: Scrap | null, price: CheckPrice | null, settings: Settings): CheckVerdict {
  if (price === null) return 'no-price';
  const status = profitStatus(profitScrap, price.valueScrap, settings.profit);
  return status === 'profitable' ? 'flip' : status === 'no-buyers' ? 'no-buyers' : 'over';
}

export function createLiveCheck(deps: LiveCheckDeps): LiveCheck {
  let seq = 0;
  // Results only, never text; newest first, in memory (gone on restart).
  let ring: CheckResult[] = [];

  const keyScrapOf = (): Scrap | null => {
    try {
      const v = deps.keyPrice().valueScrap;
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  };

  /** Unique: schema.search finds exactly one item for the text, and it is the guessed one. */
  const fuzzyConfirmer = (): ParseCheckOptions['confirmFuzzy'] => {
    let searches = 0;
    return (itemText, item) => {
      if (searches >= MAX_FUZZY_SEARCHES) return false;
      searches++;
      const hits = attempt(() => deps.schema.search(itemText, 2), []);
      if (hits.length !== 1) return false;
      const hit = canonicalBase(hits[0]!.sku);
      return hit !== null && hit === canonicalBase(item.sku);
    };
  };

  /**
   * Buy-side confidence: the Live market entry's. Without one (the index has not built yet, a painted
   * copy's base, an effect only the generic book buys) but with an eligible revenue order, the market's
   * own evaluation of the base on demand: the revenue order's bot, online and age signals and flags,
   * scored exactly as the entry would be. Local reads only.
   */
  const confidenceOf = (base: string, revenue: ItemRevenue | null, settings: Settings, K: Scrap, now: UnixMs): { value: number; level: ConfidenceLevel } | null => {
    const entry = attempt(() => deps.market.entryFor(base), null);
    if (entry) return { value: entry.confidence, level: entry.confidenceLevel };
    if (!revenue || revenue.order === null) return null;
    try {
      const generic = anyEffectBaseOf(base);
      const other = generic !== null && generic !== base ? generic : null;
      const books = deps.repo.buyListingsByBaseSkus(other ? [base, other] : [base]);
      const own = books.get(base) ?? [];
      const gen = other ? (books.get(other) ?? []) : [];
      const obj = fromString(base);
      const ev = evaluateMarketBase({
        base,
        listings: gen.length > 0 ? [...own, ...gen] : own,
        references: referencePrices(lookupReferences(deps.repo, base), K, now),
        isUnusual: obj.quality === 5 || (typeof obj.effect === 'number' && obj.effect > 0),
        settings,
        keyScrap: K,
        now,
        match: matchContext(settings, now),
      });
      return ev ? { value: ev.confidence, level: ev.confidenceLevel } : null;
    } catch (err) {
      // The SKU is the resolved item's, never the text; the error is named by class only.
      deps.log.warn('Live check could not score buyer confidence', { sku: base, error: errorName(err) });
      return null;
    }
  };

  const evaluate = (parsed: ParsedCheck, source: CheckSource, now: UnixMs, id: number): CheckResult => {
    const settings = deps.settings();
    const keyPrice = attempt<KeyPriceState | null>(() => deps.keyPrice(), null);
    // The value buildItemDetail prices the book at, so cost and revenue share one key price.
    const K = keyPrice && Number.isFinite(keyPrice.valueScrap) && keyPrice.valueScrap > 0 ? keyPrice.valueScrap : DEFAULT_KEY_SCRAP;
    const obj = fromString(parsed.item.sku);
    const sku = fromObject(obj);
    const base = fromObject({ ...obj, paint: null });
    // The list shows plain copies and is keyed by base SKU (a painted check reads its plain row).
    const list = attempt(() => deps.scraptfList.rowFor(base, K), null);
    // item.detail {history:false, target:'plain'}: the stored book only, no PriceDB request.
    const detail = buildItemDetail({ repo: deps.repo, schema: deps.schema, sku, keyPrice, settings, now, snapshot: NO_SNAPSHOT, history: [], target: 'plain', scraptfList: list });
    if (!detail) return blankCheckResult('not-item', CHECK_NOT_ITEM_REASON, source, now, id, keyScrapOf());

    const plain = typeof obj.paint !== 'number' || obj.paint <= 0;
    const stored = newestStoredPrice(detail.scrapPrices, plain);
    const price = chooseCheckPrice({ parsed, list, stored, keyScrap: K, now, plain });
    // No clean copy stored: the fallback is a painted or spelled copy's price. Said so, as the Live
    // market flags it 'has-extras', so it is not taken for what a plain one costs.
    const otherCopy = plain && stored !== null && (price?.source === 'typed' || price?.source === 'import') && storedPriceHasExtras(stored);
    const listPays = list?.paysScrap ?? null;
    // A copied pays cell is what scrap.tf pays now, even a dash (nothing): newer than the saved list.
    const scraptfPaysScrap = parsed.paysCopied ? (parsed.pays ? valueScrap(parsed.pays.keys, parsed.pays.scrap, K) : null) : listPays;
    const stock = parsed.stock ?? list?.stock ?? null;
    const stockLimit = parsed.stockLimit ?? list?.stockLimit ?? null;
    const listUsed =
      list !== null &&
      (price?.source === 'list' ||
        (!parsed.paysCopied && listPays !== null) ||
        (parsed.stock === null && list.stock !== null) ||
        (parsed.stockLimit === null && list.stockLimit !== null));

    const revenue = detail.revenue;
    const revenueScrap = revenue?.revenueScrap ?? null;
    const profitScrap = price !== null && revenueScrap !== null ? revenueScrap - price.valueScrap - frictionOf(settings.profit) : null;
    const margin = profitScrap !== null && price !== null && price.valueScrap > 0 ? profitScrap / price.valueScrap : null;
    const confidence = confidenceOf(base, revenue, settings, K, now);
    const notes = [
      // F19: named from the item detail (the resolved item), never from the copied text.
      parsed.form === 'hinted' ? checkHintedNote(detail.name) : null,
      parsed.fuzzy ? CHECK_FUZZY_NOTE : null,
      parsed.incomplete ? CHECK_INCOMPLETE_NOTE : null,
      copiedSoldOut(parsed) ? CHECK_SOLD_OUT_NOTE : null,
      otherCopy ? CHECK_EXTRAS_NOTE : null,
    ].filter((n): n is string => n !== null);

    return {
      id,
      status: 'item',
      source,
      reason: notes.length > 0 ? notes.join(' ') : null,
      sku: detail.sku,
      name: detail.name,
      category: detail.category,
      price,
      scraptfPaysScrap,
      stock,
      stockLimit,
      listAt: listUsed ? list.observedAt : null,
      revenue,
      profitScrap,
      margin,
      verdict: checkVerdict(profitScrap, price, settings),
      confidence: confidence?.value ?? null,
      confidenceLevel: confidence?.level ?? null,
      links: detail.links,
      keyScrap: K,
      checkedAt: now,
    };
  };

  const kept = (result: CheckResult): CheckResult => {
    if (result.status === 'item') ring = [structuredClone(result), ...ring].slice(0, CHECK_RECENT_MAX);
    return result;
  };

  return {
    check(text, source, now, hint) {
      const id = ++seq;
      const parsed = parseCheckText(text, (t) => deps.schema.resolve(t), { confirmFuzzy: fuzzyConfirmer() });
      if (!parsed.ok) {
        const noItem = parsed.status === 'not-item' && parsed.reason === CHECK_NOT_ITEM_REASON;
        // F19: no item in the text but a price, while main says which item the user opened on scrap.tf.
        // The hint is a SKU, so it needs no names: it is tried before the schema-loading reason. The
        // source matters: the watcher sees copies from any app, so it takes only a price written as one.
        const hinted = noItem ? hintedCheck(text, hint, source) : null;
        if (hinted) {
          const result = evaluate(hinted, source, now, id);
          if (result.status === 'item') return kept(result);
        }
        // Names cannot resolve before the schema has loaded; say so instead of "not an item".
        const loading = noItem && !attempt(() => deps.schema.isLoaded(), true);
        return blankCheckResult(parsed.status, loading ? CHECK_SCHEMA_LOADING_REASON : parsed.reason, source, now, id, keyScrapOf());
      }
      return kept(evaluate(parsed.parsed, source, now, id));
    },
    recent: () => ring.map((r) => structuredClone(r)),
  };
}
