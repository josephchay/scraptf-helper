// Live check (F16, spec "F15 Live check"; F15 in this codebase is the scrap.tf banks page):
// limits, user-facing copy and blank results shared by main (hotkey, clipboard watcher, popup),
// the service (liveCheck.ts, 'check.text') and the dashboard and mock, so all of them refuse
// and word things alike (F19: and read a price copied on its own alike, checkHintPriceOf; 0.7.4,
// F41: and decide a plain name's craftability alike, checkCraftCopy and checkDecideCopy; R14: and check the
// price against PriceDB alike, checkCostNote). No zod and no Node modules: the renderer imports this too.
//
// The only input is text the user copied (read locally by main, readText only) or typed. Nothing
// here, or anywhere in the feature, contacts scrap.tf or reads the browser (R1, R3).

import { costSanity, type CostSanity, type PricedbSides } from './ceiling';
import { parsePrice, SCRAP_PER_REF, type ParsedPrice } from './currency';
import { scraptfListCraftProven, scraptfListUsePrice } from './scraptfList';
import { fromObject, fromString, isValidSku, looksLikeSku } from './sku';
import type { CheckResult, CheckSource, CheckStatus, CheckVerdict, Scrap, ScraptfBank, ScraptfListRow, UnixMs } from './types';

/** Longest text checked: 'check.text' rejects more (zod), and the watcher ignores it. */
export const CHECK_MAX_CHARS = 400;
/** More non-blank lines than this is not a single-item check (a list, a document). */
export const CHECK_MAX_LINES = 3;
/** Item results kept in the service's in-memory ring ('check.recent'). */
export const CHECK_RECENT_MAX = 30;
/** The opt-in watcher's poll interval (main, clipboard.readText() only). */
export const CHECK_WATCH_INTERVAL_MS = 700;
/** At most one watcher popup per this long; a newer check replaces the one shown. */
export const CHECK_POPUP_MIN_GAP_MS = 1_500;
/** The popup hides itself after this long unless hovered or focused. */
export const CHECK_POPUP_HIDE_MS = 10_000;
/** A flip notification per SKU at most this often (watcher only). */
export const CHECK_NOTIFY_DEDUP_MS = 60_000;
/** Longest price text 'app.showQuickEntry' passes on to quick entry's price field ('ui.quickPrefill'). */
export const CHECK_PRICE_TEXT_MAX = 60;
/** F19: how long main keeps a 'check.arm' (the item the user opened on scrap.tf); it then lapses on its own. */
export const CHECK_ARM_MS = 10 * 60_000;
/** F19: the longest item name 'check.arm' accepts. */
export const CHECK_ARM_NAME_MAX = 200;
/**
 * F19: the most a price copied on its own may be (checkHintPriceOf). scrap.tf writes a dear item in keys
 * plus under a key of metal, and no bank item costs thousands of keys: a bigger figure is some other number.
 */
export const CHECK_HINT_MAX_KEYS = 5_000;
export const CHECK_HINT_MAX_REF = 50_000;

/** Shown once when the watcher is turned on (Settings) and next to its switch. */
export const CHECK_PRIVACY_SENTENCE = 'Flip Desk reads text you copy and checks it if it is a TF2 item. Nothing is stored or sent.';
/** Shown with a not-item or refused result. */
export const CHECK_HINT = 'Copy an item name, or a row from scrap.tf/items';
/** Settings → Live check → Test. */
export const CHECK_SAMPLE_TEXT = 'Team Captain, 1.33 ref';

/** Refusal reasons (status 'refused'). The texts are fixed: none of them quotes the checked text. */
export const CHECK_REFUSALS = {
  list: 'Looks like a list. Use Price sheet → Paste a list',
  markup: 'That looks like page markup, not an item. Copy the item name or its row instead.',
  tooLong: `That is longer than ${CHECK_MAX_CHARS} characters, so it was not checked.`,
  secret: 'That looks like a password, key or token, so it was not checked.',
  /** main's filter: a long link that is not an item link may carry a token in its path, so it is never sent on. */
  link: 'Only item links from backpack.tf, marketplace.tf and PriceDB are checked. Copy the item name instead.',
  empty: 'The clipboard has no text to check.',
} as const;

/** The not-item reason when nothing resolved (fuzzy guesses included: a wrong item would be a wrong flip). */
export const CHECK_NOT_ITEM_REASON = 'No TF2 item recognised in that text.';
/**
 * Not-item reason for a scrap.tf link: the check never opens or fetches a link it is handed (R1). 0.7.1 (UX-7):
 * worded so it stays true with the opt-in scrap.tf window on, where the user does browse scrap.tf.
 */
export const CHECK_SCRAPTF_LINK_REASON = 'Flip Desk does not open scrap.tf links you copy; copy the item name or its row instead.';
/** Not-item reason while the item schema has not loaded (names cannot resolve yet; SKUs still do). */
export const CHECK_SCHEMA_LOADING_REASON = 'The item list is still loading, so names cannot be recognised yet. Try again in a moment.';

// Notes on an item result (CheckResult.reason with status 'item'), joined by a space. Fixed texts:
// the resolver's own warnings can quote the text, so they are never passed on.
/** The copied row said "Sold out" (or stock 0), so there is no scrap.tf price to compare. */
export const CHECK_SOLD_OUT_NOTE = 'Sold out on scrap.tf when you copied it, so there is no price to compare.';
/** The name was a unique closest match, not an exact one. */
export const CHECK_FUZZY_NOTE = 'Closest match only: check that this is the item you copied.';
/** The resolver checked the general item (no effect, series or paint it could use). */
export const CHECK_INCOMPLETE_NOTE = 'Part of the name (an effect, crate series or paint) was missing or not recognised, so the general item was checked.';
/**
 * A plain check priced from the user's only stored copy, which has paint, spells, parts or a name or
 * description tag (the Live market flags that row 'has-extras'): not what a plain one costs, so no flip
 * notification and no Bought it at that price. 0.7.3: names every extra, not only paint and spells.
 */
export const CHECK_EXTRAS_NOTE = 'Your price is for a copy with extras (paint, spells, parts or a tag), not a plain one.';

/** The fixed end of checkHintedNote, by which the popup and checkMatchedByHint recognise it. */
export const CHECK_HINTED_NOTE_TAIL = 'the item you opened from the Live market.';

/**
 * F19 item note: copied text with a price and no item, checked as the armed item ('check.text' hint).
 * `name` is the resolved item's name (schema or item detail), never the copied text.
 */
export function checkHintedNote(name: string): string {
  return `Price copied, matched to ${name}, ${CHECK_HINTED_NOTE_TAIL}`;
}

/** The result's item came from the hint, not the text (checkHintedNote): "price copied, matched to the item you opened". */
export function checkMatchedByHint(r: Pick<CheckResult, 'reason'> | null | undefined): boolean {
  return typeof r?.reason === 'string' && r.reason.includes(CHECK_HINTED_NOTE_TAIL);
}

/** The result's price is a copy with extras (CHECK_EXTRAS_NOTE): shown, but never acted on as the plain item's cost. */
export function checkPriceIsOtherCopy(r: Pick<CheckResult, 'reason'> | null | undefined): boolean {
  return typeof r?.reason === 'string' && r.reason.includes(CHECK_EXTRAS_NOTE);
}

/**
 * 0.7.4 (F44): a check the user asked for (the hotkey, a typed check) read a number with no unit after the
 * item as ref. scrap.tf writes every price with a unit, so the number may be a count or keys; from the
 * watcher, which sees copies from any app, such a number is no price and the item is checked alone.
 */
export const CHECK_BARE_REF_NOTE = 'The number after the item has no unit, so it was read as ref.';

/** 0.7.4 (F44): the result's price is a number read as ref without a unit (CHECK_BARE_REF_NOTE): never a flip notification. */
export function checkPriceReadAsRef(r: Pick<CheckResult, 'reason'> | null | undefined): boolean {
  return typeof r?.reason === 'string' && r.reason.includes(CHECK_BARE_REF_NOTE);
}

// 0.7.4 (F41): scrap.tf marks a Non-Craftable copy only with a class on its card or row ("uncraft"), which no
// copied text carries, so a plain copied name resolves to the Craftable copy. When the text does not say, the
// user's own saved scrap.tf data decides (checkCraftCopy): only the Non-Craftable twin matches, it is checked
// as that; both do, the check says so and answers with the copy that sells for less (checkWorseCopy).
// 0.7.4 (R20, R21): a copied price that matches no saved copy, or a saved /items row for every copy (a family
// row), decides nothing either: undecided too, whenever the Non-Craftable twin trades (checkDecideCopy). A
// repriced card of a bank page that never lists Non-Craftable copies (CHECK_NONCRAFT_BANKS) is still the Craftable copy.

/**
 * 0.7.4 (F41): the copied text did not say, and the user's saved scrap.tf data matches only the Non-Craftable copy
 * (the copied price is its saved price, or no price was copied and only it is on sale).
 */
export const CHECK_CRAFT_TWIN_NOTE = 'Checked as the Non-Craftable copy: the copied text does not say, and your saved scrap.tf pages match only that copy.';
/**
 * 0.7.4 (F41, R20, R21): the copied text did not say, and the saved data does not tell the copies apart (both on
 * sale, a copied price no saved copy is at, or only an /items row for every copy): the result is the copy that
 * sells for less, Save price and Bought it are off (neither copy is known to be the one copied) and no flip
 * notification is sent.
 */
export const CHECK_CRAFT_UNSURE_NOTE = 'The copied text does not say whether it is Craftable, and your saved scrap.tf data does not tell the copies apart: checked as the one that sells for less.';

/** 0.7.4 (F41): the result's craftability is undecided (CHECK_CRAFT_UNSURE_NOTE): shown, but never saved, booked or notified. */
export function checkCraftUndecided(r: Pick<CheckResult, 'reason'> | null | undefined): boolean {
  return typeof r?.reason === 'string' && r.reason.includes(CHECK_CRAFT_UNSURE_NOTE);
}

/**
 * 0.7.4 (R14, F22/F70): the checked price is under 0.9x the item's own PriceDB band and within 10% of its
 * craftability twin's (costSanity 'variant-suspect'): most likely the other copy's price. Capped at Low, never a
 * flip notification, as the engine holds back such an opportunity.
 */
export const CHECK_COST_VARIANT_NOTE = 'This price matches the other copy (Craftable or Non-Craftable) on PriceDB, not this one: check its craftability before buying.';
/** 0.7.4 (R14, F22): the checked price is under 0.95x the item's PriceDB buy price by 1 ref or more (costSanity 'cost-below-market'). */
export const CHECK_COST_BELOW_MARKET_NOTE = 'This price is well under what PriceDB says bots pay for this item: check its craftability, quality and kit tier before buying.';

/**
 * 0.7.4 (R14): the cost check of a Live check's price, by the shared costSanity over the item's age-gated
 * PriceDB row and (read only when the price is far under it) its craftability twin's: the note, or null.
 * The service and the mock apply it alike.
 */
export function checkCostNote(costScrap: Scrap | null | undefined, own: PricedbSides | null | undefined, twin: () => PricedbSides | null | undefined): string | null {
  let s: CostSanity = null;
  try {
    s = costSanity(costScrap, own, twin);
  } catch {
    return null;
  }
  return s === null ? null : s.flag === 'variant-suspect' ? CHECK_COST_VARIANT_NOTE : CHECK_COST_BELOW_MARKET_NOTE;
}

/** 0.7.4 (R14): the result's price failed the cost check (checkCostNote): shown at Low, never a flip notification. */
export function checkCostSuspect(r: Pick<CheckResult, 'reason'> | null | undefined): boolean {
  return typeof r?.reason === 'string' && (r.reason.includes(CHECK_COST_VARIANT_NOTE) || r.reason.includes(CHECK_COST_BELOW_MARKET_NOTE));
}

/**
 * 0.7.4 (R22, F13/F47): the order the result's revenue rests on has not been seen for 24 h ('unverified', as the
 * engine's and the bank stock's toasts read it) and may be gone: shown, never a flip notification.
 */
export function checkRevenueUnverified(r: Pick<CheckResult, 'revenue'> | null | undefined): boolean {
  const flags: unknown = r?.revenue?.order?.flags;
  return Array.isArray(flags) && flags.includes('unverified');
}

/** 0.7.4 (F41): a price one copy is on sale at in the user's saved scrap.tf data, keys and metal as listed. */
export interface CheckCopyPrice {
  keys: number;
  scrap: Scrap;
  /**
   * 0.7.4: the bank page whose saved card has this price (bankStockPricesOf); absent for a saved /items row
   * (checkListCopyPrices), which may stand for any bank's item.
   */
  bank?: ScraptfBank;
}

/**
 * 0.7.4: the scrap.tf bank pages that list Non-Craftable copies of an item beside its Craftable one: /buy/items
 * (tools, paints, taunts, australium and killstreak weapons) and /buy/killstreaks (kits). In the user's saved
 * pages every Non-Craftable card is on one of these two; hats, weapons, stranges, unusuals and skins list none.
 * So a card of those pages that scrap.tf repriced since the save is still the Craftable copy (checkCraftCopy).
 */
export const CHECK_NONCRAFT_BANKS: ReadonlySet<ScraptfBank> = new Set<ScraptfBank>(['items', 'killstreaks']);

/**
 * 0.7.4 (F41): the item part of a copied text says which copy it is: a SKU, an item link, or a name with
 * "Craftable", "Non-Craftable" or "Uncraftable" anywhere in it ("Strange Non-Craftable X"). Only the answer
 * leaves it, never the text.
 */
export function checkTextStatesCraft(itemText: string): boolean {
  const t = String(itemText ?? '').trim();
  return looksLikeSku(t) || /^https?:\/\//i.test(t) || /\b(?:non[-\s]?|un)?craftable\b/i.test(t);
}

/**
 * 0.7.4 (F41): the Non-Craftable twin of a Craftable SKU (paint, killstreak, festivizing and the rest kept),
 * for checkCraftCopy; null for a Non-Craftable or unreadable SKU, and for a kit, fabricator or anything else
 * with a target or output, whose craftability is part of the item as the import keys it.
 */
export function checkCraftTwinOf(sku: string): string | null {
  const s = String(sku ?? '').trim();
  if (!isValidSku(s)) return null;
  try {
    const obj = fromString(s);
    if (!obj.craftable || obj.target !== null || obj.output !== null) return null;
    const twin = fromObject({ ...obj, craftable: false });
    return twin !== fromObject(obj) ? twin : null;
  } catch {
    return null;
  }
}

/**
 * 0.7.4 (F41): a saved scrap.tf/items row as evidence of one copy (`craft`: 'craftable' for the Craftable copy,
 * 'uncraftable' for its twin): its price to buy (scraptfListUsePrice) when the row was looked up exactly and is
 * proven to price that very copy (scraptfListCraftProven). A family row ('any': one row for every copy at its
 * price), a sold-out or stock-0 row, or none: no evidence.
 */
export function checkListCopyPrices(
  row: Pick<ScraptfListRow, 'craft' | 'match' | 'sellsKeys' | 'sellsScrapRaw' | 'stock'> | null | undefined,
  craft: 'craftable' | 'uncraftable',
): CheckCopyPrice[] {
  if (!row || !scraptfListCraftProven(row) || row.craft !== craft) return [];
  const p = scraptfListUsePrice(row);
  return p ? [{ keys: p.keys, scrap: p.scrap }] : [];
}

/**
 * 0.7.4 (R20): the item's saved scrap.tf/items row (rowFor of the Craftable SKU) is a family row with something
 * to buy: one row for every copy scrap.tf sells at its price ('any', or another copy's row read as 'family'), so
 * it says scrap.tf has some copy of the item, never which. A proven row, a sold-out one or none: false.
 */
export function checkListFamilyOnSale(row: Pick<ScraptfListRow, 'craft' | 'match' | 'sellsKeys' | 'sellsScrapRaw' | 'stock'> | null | undefined): boolean {
  return !!row && !scraptfListCraftProven(row) && scraptfListUsePrice(row) !== null;
}

/**
 * 0.7.4 (F41, R20, R21): the copy checkCraftCopy chose. 'keep': the Craftable copy as written; 'twin': the
 * Non-Craftable twin; 'unsure': undecided, the twin being on sale in the saved data; 'unknown': the saved data
 * decides nothing and has no twin on sale, though a page or list row it comes from may list one
 * (checkDecideCopy: undecided only when the twin trades).
 */
export type CheckCraftChoice = 'keep' | 'twin' | 'unsure' | 'unknown';

/**
 * 0.7.4 (F41): which copy a check whose text does not say its craftability is, from the prices the user's saved
 * scrap.tf data has each copy on sale at (`craftable`: the copy the name resolved to; `twin`: its Non-Craftable
 * twin; empty: none on sale) and (R20) whether the item's /items row is a family row on sale (`familyOnSale`,
 * checkListFamilyOnSale):
 * - a copied price only one copy is on sale at: that copy ('keep' or 'twin'); both at it: 'unsure';
 * - R21: a copied price no saved copy is at decides nothing: 'unsure' when the twin is on sale, 'unknown' when
 *   only the Craftable copy is (scrap.tf may have listed the other copy since that save). 0.7.4: but when every
 *   saved Craftable price is a card of a bank page that never lists Non-Craftable copies (not CHECK_NONCRAFT_BANKS:
 *   hats, weapons, stranges, unusuals, skins), there is no other copy to have been listed: the card was repriced,
 *   'keep'. A /buy/items or /buy/killstreaks card, or a proven /items row (no bank), stays 'unknown';
 * - no copied price, by what is on sale: only the twin, 'twin'; both, 'unsure'; only the Craftable copy, 'keep';
 * - R20: nothing proven saved but a family row on sale, 'unknown' (the row is for every copy, never the
 *   Craftable one); nothing saved at all, 'keep' (as before 0.7.4).
 * Local data only: nothing is fetched to decide (R1).
 */
export function checkCraftCopy(a: {
  price: CheckCopyPrice | null;
  craftable: readonly CheckCopyPrice[];
  twin: readonly CheckCopyPrice[];
  familyOnSale?: boolean;
}): CheckCraftChoice {
  const price = a.price;
  const at = (prices: readonly CheckCopyPrice[]): boolean => price !== null && prices.some((p) => p.keys === price.keys && p.scrap === price.scrap);
  const craftableAt = at(a.craftable);
  const twinAt = at(a.twin);
  if (craftableAt !== twinAt) return twinAt ? 'twin' : 'keep';
  if (craftableAt) return 'unsure';
  if (a.twin.length > 0) return price === null && a.craftable.length === 0 ? 'twin' : 'unsure';
  if (a.craftable.length > 0) {
    if (price === null) return 'keep';
    // 0.7.4: only a page that lists Non-Craftable copies (or a list row, which may be any bank's) leaves room for one.
    const twinPossible = a.craftable.some((p) => p.bank === undefined || p.bank === 'list' || CHECK_NONCRAFT_BANKS.has(p.bank));
    return twinPossible ? 'unknown' : 'keep';
  }
  return a.familyOnSale === true ? 'unknown' : 'keep';
}

/** 0.7.4 (R20, R21): the check found an eligible buy order (a revenue figure): its copy trades on backpack.tf. */
export function checkHasRevenue(r: Pick<CheckResult, 'revenue'> | null | undefined): boolean {
  const v = r?.revenue?.revenueScrap;
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 0.7.4 (F41, R20, R21): the check as the copy `choice` names, shared by the service's judge and the mock's
 * mockJudgeCheck. `evaluate` checks one copy ('craftable': as written; 'twin': its Non-Craftable twin) with the
 * craft note given. 'keep': the Craftable copy. 'twin': the twin with CHECK_CRAFT_TWIN_NOTE. 'unsure': both with
 * CHECK_CRAFT_UNSURE_NOTE, answered by the one that sells for less (checkWorseCopy), never the Craftable book
 * alone. 'unknown': the same when the twin trades (an eligible buy order, checkHasRevenue); else only the
 * Craftable copy trades and it is kept as written (an ordinary hat is not shown as "no buyers"). A twin that
 * cannot be read leaves the Craftable copy, noted undecided unless 'unknown'.
 */
export function checkDecideCopy<T extends Pick<CheckResult, 'status' | 'verdict' | 'profitScrap' | 'revenue'>>(
  choice: CheckCraftChoice,
  evaluate: (copy: 'craftable' | 'twin', craftNote: string | null) => T,
): T {
  if (choice === 'keep') return evaluate('craftable', null);
  if (choice === 'twin') {
    const twin = evaluate('twin', CHECK_CRAFT_TWIN_NOTE);
    return twin.status === 'item' ? twin : evaluate('craftable', CHECK_CRAFT_UNSURE_NOTE);
  }
  const twin = evaluate('twin', CHECK_CRAFT_UNSURE_NOTE);
  if (twin.status !== 'item') return evaluate('craftable', choice === 'unknown' ? null : CHECK_CRAFT_UNSURE_NOTE);
  if (choice === 'unknown' && !checkHasRevenue(twin)) return evaluate('craftable', null);
  const craftable = evaluate('craftable', CHECK_CRAFT_UNSURE_NOTE);
  if (craftable.status !== 'item') return twin;
  return checkWorseCopy(craftable, twin);
}

/** 0.7.4 (F41): how good a verdict is for a buy, for checkWorseCopy: a flip most, no buyers least. */
const VERDICT_RANK: Readonly<Record<CheckVerdict, number>> = { flip: 3, 'no-price': 2, over: 1, 'no-buyers': 0 };

/**
 * 0.7.4 (F41): of two checks of one item's copies (the Craftable copy and its Non-Craftable twin), the one that
 * sells for less, for an undecided craftability (CHECK_CRAFT_UNSURE_NOTE): the worse verdict (no buyers, over,
 * no price, flip), then the lower profit, then the lower revenue (none is lowest). A tie keeps `a`.
 */
export function checkWorseCopy<T extends Pick<CheckResult, 'verdict' | 'profitScrap' | 'revenue'>>(a: T, b: T): T {
  const rank = (r: T): number => (r.verdict ? (VERDICT_RANK[r.verdict] ?? -1) : -1);
  if (rank(a) !== rank(b)) return rank(b) < rank(a) ? b : a;
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (fin(a.profitScrap) && fin(b.profitScrap) && a.profitScrap !== b.profitScrap) return b.profitScrap < a.profitScrap ? b : a;
  const revenue = (r: T): number => (fin(r.revenue?.revenueScrap) ? r.revenue.revenueScrap : Number.NEGATIVE_INFINITY);
  return revenue(b) < revenue(a) ? b : a;
}

/** settings.set's refusal when the check hotkey and the quick-entry hotkey are one chord (settingsSchema.ts, and the mock). */
export const CHECK_HOTKEY_CONFLICT = 'check.hotkey: the live check needs its own shortcut, not the quick-entry one';

/** Non-blank lines of `text` (any line break). */
export function checkLineCount(text: string): number {
  return String(text ?? '')
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim() !== '').length;
}

/**
 * The refusal every path applies before parsing (service, mock, main's hotkey): page markup ("<",
 * HTML formats are never read either), more than CHECK_MAX_LINES lines, more than CHECK_MAX_CHARS
 * characters, or no text at all. null when the text may be parsed. Secrets are main's filter
 * (src/main/clipboardWatch.ts) and run before any text leaves main.
 */
export function checkTextRefusal(text: string): string | null {
  const t = String(text ?? '');
  if (t.trim() === '') return CHECK_REFUSALS.empty;
  if (t.length > CHECK_MAX_CHARS) return CHECK_REFUSALS.tooLong;
  if (t.includes('<')) return CHECK_REFUSALS.markup;
  if (checkLineCount(t) > CHECK_MAX_LINES) return CHECK_REFUSALS.list;
  return null;
}

/** Characters a browser copy can carry that mean nothing here (as the service's parser drops them). */
const HINT_INVISIBLE = /[​-‍⁠﻿]/g;
/** Prices are short; a longer line is never read as one. */
const HINT_PRICE_LINE_MAX = 80;
/** A price without a unit, read as ref: a short ref figure ("5", "1.33", "63.11"), never an id, a year or a phone number. */
const HINT_BARE_REF = /^\d{1,3}(?:[.,]\d{1,2})?$/;
/** A one-letter unit ("5k", "3s", "2r"): common outside TF2 ("a 5k run"), so the watcher wants the word. */
const HINT_LETTER_UNIT = /\d\s*[krs]\b/i;

/**
 * F19: the price in a text that is only a price ("1.33 ref", "2 keys 5.11", a copied price cell), as the
 * service and the mock read it for a 'check.text' hint; null for anything else, a refused text included.
 * One non-blank line holding one non-zero price, at most CHECK_HINT_MAX_KEYS keys and CHECK_HINT_MAX_REF
 * ref. A number without a unit is ref only when short (HINT_BARE_REF). The watcher reads whatever the user
 * copies in any app, so for source 'watch' a bare whole number ("49", a code) and a one-letter unit are no
 * price: scrap.tf writes its prices with a unit word. Only the numbers leave it.
 */
export function checkHintPriceOf(text: string, source: CheckSource): ParsedPrice | null {
  if (checkTextRefusal(text) !== null) return null;
  const lines = String(text)
    .replace(HINT_INVISIBLE, '')
    .split(/\r\n|\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length !== 1 || lines[0]!.length > HINT_PRICE_LINE_MAX) return null;
  const line = lines[0]!;
  const p = parsePrice(line, 'ref');
  if (p === null || !(p.keys > 0 || p.scrap > 0)) return null;
  if (!Number.isFinite(p.keys) || !Number.isSafeInteger(p.scrap) || p.keys > CHECK_HINT_MAX_KEYS || p.scrap > CHECK_HINT_MAX_REF * SCRAP_PER_REF) return null;
  if (!/\p{L}/u.test(line) && !HINT_BARE_REF.test(line)) return null;
  if (source === 'watch' && (p.ambiguous || HINT_LETTER_UNIT.test(line))) return null;
  return p;
}

/**
 * A result without an item: status 'not-item' or 'refused' with its user-facing reason. Main builds
 * one for a hotkey press its filter refused (the text never reaches the service), the service and
 * the mock for everything that did not resolve. `id` 0 marks a result the service never saw.
 */
export function blankCheckResult(
  status: Exclude<CheckStatus, 'item'>,
  reason: string,
  source: CheckSource,
  checkedAt: UnixMs,
  id = 0,
  keyScrap: Scrap | null = null,
): CheckResult {
  return {
    id,
    status,
    source,
    reason,
    sku: null,
    name: null,
    category: null,
    price: null,
    scraptfPaysScrap: null,
    stock: null,
    stockLimit: null,
    listAt: null,
    revenue: null,
    profitScrap: null,
    margin: null,
    verdict: null,
    confidence: null,
    confidenceLevel: null,
    links: [],
    keyScrap,
    checkedAt,
  };
}
