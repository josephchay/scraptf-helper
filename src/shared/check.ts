// Live check (F16, spec "F15 Live check"; F15 in this codebase is the scrap.tf banks page):
// limits, user-facing copy and blank results shared by main (hotkey, clipboard watcher, popup),
// the service (liveCheck.ts, 'check.text') and the dashboard and mock, so all of them refuse
// and word things alike (F19: and read a price copied on its own alike, checkHintPriceOf).
// No zod and no Node modules: the renderer imports this too.
//
// The only input is text the user copied (read locally by main, readText only) or typed. Nothing
// here, or anywhere in the feature, contacts scrap.tf or reads the browser (R1, R3).

import { parsePrice, SCRAP_PER_REF, type ParsedPrice } from './currency';
import type { CheckResult, CheckSource, CheckStatus, Scrap, UnixMs } from './types';

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
 * A plain check priced from the user's only stored copy, which has paint, spells or parts (the Live
 * market flags that row 'has-extras'): not what a plain one costs, so no flip notification and no
 * Bought it at that price.
 */
export const CHECK_EXTRAS_NOTE = 'Your price is for a painted or spelled copy, not a plain one.';

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
