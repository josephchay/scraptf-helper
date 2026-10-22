// Live check (F16, spec "F15 Live check"): pure helpers for the check popup (pages/CheckPopup.tsx),
// the Live market's Recent checks panel and Settings → Live check. Kept out of the pages so the
// wording, the action inputs, the keys and the auto-hide timer are unit-tested.
//
// Everything here works on a CheckResult, which holds the resolved item only: the text the user
// copied never reaches the renderer (main reads the clipboard, the service parses it). Nothing
// here contacts scrap.tf (R1).

import { SCRAPTF_BOUNDARY_SHORT } from '../shared/boundaryText';
import { buyerPresenceText, orderSeenRecently } from '../shared/buyerSeen';
import { singleExitText } from '../shared/ceiling';
import {
  CHECK_ARM_NAME_MAX,
  CHECK_COST_BELOW_MARKET_NOTE,
  CHECK_COST_VARIANT_NOTE,
  CHECK_CRAFT_UNSURE_NOTE,
  CHECK_EXTRAS_NOTE,
  CHECK_HINT,
  CHECK_HINTED_NOTE_TAIL,
  CHECK_POPUP_HIDE_MS,
  CHECK_PRICE_TEXT_MAX,
  CHECK_RECENT_MAX,
  CHECK_SOLD_OUT_NOTE,
  checkCraftUndecided,
  checkHintedNote,
  checkMatchedByHint,
  checkPriceIsOtherCopy,
} from '../shared/check';
import { formatKeysMetal } from '../shared/currency';
import type { HotkeyState } from '../shared/rpc';
import { scraptfListFull } from '../shared/scraptfList';
import type { CheckArm, CheckPrice, CheckPriceSource, CheckResult, CheckSettings, CheckSource, JournalInput, ScrapPriceInput, UnixMs } from '../shared/types';
import { accelLabel, categoryLabel, fmtAgo, fmtDateTime, fmtInt, fmtMoney, fmtPct, fmtSignedMoney, type Tone } from './format';
import { exitCostsWords, profitBreakdownText } from './oppModel';
import { BUY_VENUE, buyerCountLabel, noRevenueText, revenueBreakdown } from './quickModel';

/** The note on a price or journal row the popup writes (Save price, Bought it). */
export const LIVE_CHECK_NOTE = 'live check';

/** Shown while a popup has no result yet (it only opens with one, so mostly the browser preview). */
export const CHECK_WAITING_TEXT = 'Copy an item name or a scrap.tf/items row, then press the check hotkey.';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function isItem(r: CheckResult | null | undefined): r is CheckResult & { sku: string } {
  return !!r && r.status === 'item' && typeof r.sku === 'string' && r.sku.trim() !== '';
}

// ---------------------------------------------------------------------------
// Line 1: the scrap.tf price and where it came from
// ---------------------------------------------------------------------------

export const CHECK_PRICE_SOURCE_LABELS: Readonly<Record<CheckPriceSource, string>> = {
  clipboard: 'copied',
  list: 'saved list',
  typed: 'your price',
  import: 'imported page',
};

export const CHECK_SOURCE_LABELS: Readonly<Record<CheckSource, string>> = {
  hotkey: 'hotkey',
  watch: 'clipboard watch',
  manual: 'typed here',
};

/** The price as scrap.tf lists it ("1 key 5.33 ref"): keys and metal as copied, not re-split at our key price. */
export function checkPriceText(price: Pick<CheckPrice, 'keys' | 'scrapRaw'> | null | undefined): string | null {
  if (!price || !finite(price.scrapRaw)) return null;
  const keys = finite(price.keys) && price.keys > 0 ? price.keys : 0;
  return formatKeysMetal(keys, Math.max(0, Math.round(price.scrapRaw)));
}

/** "copied", "saved list 3 min ago", "your price", "imported page 2 h ago". */
export function checkPriceSourceText(price: Pick<CheckPrice, 'source' | 'observedAt'>, now: UnixMs): string {
  const label = CHECK_PRICE_SOURCE_LABELS[price.source] ?? price.source;
  // Copied is "now"; a typed price is the user's own, its age is in the tooltip.
  return price.source === 'list' || price.source === 'import' ? `${label} ${fmtAgo(price.observedAt, now)}` : label;
}

/** "3/12", or "stock 3" without a limit; null when unknown. */
export function checkStockText(r: Pick<CheckResult, 'stock' | 'stockLimit'>): string | null {
  if (!finite(r.stock)) return null;
  return finite(r.stockLimit) ? `${fmtInt(r.stock)}/${fmtInt(r.stockLimit)}` : `stock ${fmtInt(r.stock)}`;
}

export interface CheckPriceLine {
  /** "1 key 5.33 ref"; null without a price. */
  price: string | null;
  /** "(copied)" and friends, without the parentheses; null without a price. */
  source: string | null;
  /** "3/12"; null when unknown. */
  stock: string | null;
  /** scrap.tf holds as many as it will take (it may not buy yours; buying from it still works). */
  full: boolean;
  /** Stock 0: nothing to buy at any price. */
  outOfStock: boolean;
  /** What scrap.tf pays, "1 key 1.33 ref" (valued at the result's key price); null when unknown. */
  pays: string | null;
  /** F19: a copied price with no item in it, checked as the item opened from the Live market (checkMatchedByHint). */
  matched: boolean;
  title: string;
}

/** Line 1: "scrap.tf <price> (<source>) · stock n/limit", plus what scrap.tf pays in the tooltip. */
export function checkPriceLine(r: CheckResult, now: UnixMs): CheckPriceLine {
  const k = r.keyScrap ?? null;
  const price = checkPriceText(r.price);
  const source = r.price ? checkPriceSourceText(r.price, now) : null;
  const stock = checkStockText(r);
  const full = scraptfListFull(r.stock, r.stockLimit);
  const outOfStock = finite(r.stock) && r.stock <= 0;
  const pays = finite(r.scraptfPaysScrap) ? fmtMoney(r.scraptfPaysScrap, k) : null;
  const matched = r.price?.source === 'clipboard' && checkMatchedByHint(r);
  const parts: string[] = [];
  if (r.price && price) {
    const p = r.price;
    // 0.7.3: an 'import' is a saved page or a read in the scrap.tf window (F21); the price cannot tell which.
    parts.push(
      matched
        ? `scrap.tf price ${price}, the price you copied, matched to the item you opened from the Live market.`
        : p.source === 'clipboard'
          ? `scrap.tf price ${price}, from the text you copied.`
          : p.source === 'list'
            ? `scrap.tf price ${price}, from the scrap.tf/items list you saved ${fmtDateTime(p.observedAt)}.`
            : p.source === 'typed'
              ? `Your own scrap.tf price ${price}, typed ${fmtDateTime(p.observedAt)}.`
              : `scrap.tf price ${price}, from a scrap.tf page you imported (saved, or read in the Flip Desk window) ${fmtDateTime(p.observedAt)}.`,
    );
    if (checkPriceIsOtherCopy(r)) parts.push(CHECK_EXTRAS_NOTE);
    // 0.7.4 (F41): the price is shown, but neither copy is known to be the one copied.
    if (checkCraftUndecided(r)) parts.push(CHECK_CRAFT_UNSURE_NOTE);
    // 0.7.4 review (R14): PriceDB says the price is probably another copy's (the service's cost check).
    const costNote = [CHECK_COST_VARIANT_NOTE, CHECK_COST_BELOW_MARKET_NOTE].find((n) => typeof r.reason === 'string' && r.reason.includes(n));
    if (costNote) parts.push(costNote);
  } else if (typeof r.reason === 'string' && r.reason.includes(CHECK_SOLD_OUT_NOTE)) {
    // 0.7.3: a copied sold-out row drops every price on purpose, stored ones too. By the note, not by
    // outOfStock: a list-only stock 0 has nothing copied, and a copied "Sold out" row can show stock.
    parts.push('No scrap.tf price: the row you copied was sold out, which is newer than any stored price, so there is nothing to buy now.');
  } else {
    parts.push('No scrap.tf price: none was copied, and neither your saved list nor your price sheet has one to buy.');
  }
  if (stock) parts.push(`Stock ${stock}${full ? ' (full: scrap.tf may not buy more)' : outOfStock ? ' (none to buy)' : ''}.`);
  if (pays) parts.push(`scrap.tf pays ${pays}.`);
  if (finite(r.listAt)) parts.push(`List saved ${fmtAgo(r.listAt, now)}; stock may have changed since.`);
  parts.push(SCRAPTF_BOUNDARY_SHORT);
  return { price, source, stock, full, outOfStock, pays, matched, title: parts.join(' ') };
}

// ---------------------------------------------------------------------------
// F19: a price copied on scrap.tf after "Open on scrap.tf", matched to that item
// ---------------------------------------------------------------------------

/** The popup's line for a price matched to the item opened from the Live market (the header names the item). */
export const CHECK_MATCHED_NOTE = 'Price copied, matched to the item you opened.';

/** checkHintedNote's text before the name, so its sentence can be cut out whatever the name holds. */
const HINTED_NOTE_HEAD = checkHintedNote('\u0000').split('\u0000')[0]!;

/**
 * The popup's note line: the result's notes as they are, except that the service's "Price copied,
 * matched to <name>, the item you opened from the Live market." becomes CHECK_MATCHED_NOTE, leading.
 * The header already names the item and the 380 px window clips at two lines; the full reason stays
 * in the tooltip. null without a note.
 */
export function checkPopupNote(r: Pick<CheckResult, 'reason'>): string | null {
  const reason = typeof r.reason === 'string' ? r.reason.trim() : '';
  if (!reason) return null;
  if (!checkMatchedByHint(r)) return reason;
  const tailAt = reason.indexOf(CHECK_HINTED_NOTE_TAIL);
  const start = reason.lastIndexOf(HINTED_NOTE_HEAD, tailAt);
  // Not the shared sentence after all: shown as it came.
  if (start < 0) return reason;
  const rest = `${reason.slice(0, start)} ${reason.slice(tailAt + CHECK_HINTED_NOTE_TAIL.length)}`.replace(/\s+/g, ' ').trim();
  return rest ? `${CHECK_MATCHED_NOTE} ${rest}` : CHECK_MATCHED_NOTE;
}

/**
 * 'check.arm' for "Open on scrap.tf": the SKU and exactly the name that is copied (main compares a keyed
 * hash of the trimmed copy with it, M2). null when main's params check would refuse it (blank, longer
 * than CHECK_ARM_NAME_MAX, a control character), so no call is wasted on a refusal.
 */
export function checkArmFor(sku: string, name: string): CheckArm | null {
  const s = typeof sku === 'string' ? sku.trim() : '';
  const n = typeof name === 'string' ? name.trim() : '';
  if (!s || s.length > 300 || !n || n.length > CHECK_ARM_NAME_MAX || /[\u0000-\u001f\u007f]/.test(n)) return null;
  return { sku: s, name };
}

/** How a price copied on scrap.tf comes back to the app: the toast after "Open on scrap.tf" says it. */
export interface CheckReturnPath {
  /** settings.check.hotkey, trimmed ('' = off). */
  hotkey: string;
  /** The opt-in clipboard watcher is on and polling (main's watcher reads nothing while the network is paused). */
  watching: boolean;
  /** Main holds the hotkey (app.hotkeys); null when unknown, and the setting is trusted. */
  registered: boolean | null;
  /** 'check.arm' answered with an expiry: a copied price on its own is checked as the item. */
  armed: boolean;
}

export function checkReturnPath(
  settings: { check?: Pick<CheckSettings, 'hotkey' | 'watchClipboard'> | null; networkPaused?: boolean } | null | undefined,
  hotkey: Pick<HotkeyState, 'accelerator' | 'registered'> | null | undefined,
  armed: boolean,
): CheckReturnPath {
  const check = settings?.check ?? null;
  // Main's answer is IPC data: a malformed one counts as unknown, never as a throw that loses the toast.
  const held = typeof hotkey?.accelerator === 'string' ? hotkey.accelerator.trim() : null;
  // Before the settings load, the chord main holds is the best answer.
  const key = (check ? (typeof check.hotkey === 'string' ? check.hotkey : '') : (held ?? '')).trim();
  // A registration for another chord is stale: the settings changed since.
  const registered = hotkey && typeof hotkey.registered === 'boolean' && held === key ? hotkey.registered : null;
  return { hotkey: key, watching: check?.watchClipboard === true && settings?.networkPaused !== true, registered, armed };
}

/** The toast's last sentence after "Open on scrap.tf": how to check the price there, from Settings → Live check. */
export function scraptfBackHint(p: CheckReturnPath): string {
  // Without an arm a bare price is not an item: the copy needs the name too.
  const what = p.armed ? 'Copy the price there' : 'Copy the name and price there';
  const key = p.hotkey && p.registered !== false ? accelLabel(p.hotkey) : null;
  if (key && p.watching) return `${what}: the clipboard check picks it up, or press ${key}.`;
  if (key) return `${what} and press ${key} to check it here.`;
  if (p.watching) return `${what}: the clipboard check picks it up here.`;
  if (p.hotkey) return `To check a price you copy there, free the check hotkey ${accelLabel(p.hotkey)} or pick another in Settings → Live check.`;
  return 'To check a price you copy there, set a check hotkey in Settings → Live check.';
}

// ---------------------------------------------------------------------------
// Line 2: what it sells for, and to whom
// ---------------------------------------------------------------------------

export interface CheckSellsLine {
  /** The revenue used for profit (Settings: revenue used for profit); null without a usable eligible order. */
  revenue: string | null;
  buyer: string | null;
  kind: 'bot' | 'human' | null;
  /** 0.7.4 (F23): the buyer's online flag while the order was seen in the last 2 h, else null (see `seen`). */
  online: boolean | null;
  /** 0.7.4 (F23): "last seen 4 d ago" when the order's last event is older than 2 h; null otherwise. */
  seen: string | null;
  /** The order's lastEventAt, for the popup's online dot; null without an order. */
  seenAt: UnixMs | null;
  /** "6 buyers". */
  count: string;
  /** In place of a missing revenue: "no eligible buy order", or (0.7.3) "no usable buy order"; null with one. */
  none: string | null;
  title: string;
}

/** 0.7.3: eligible orders exist but none is usable (all outliers, or no bot order for Instant). */
function noUsableOrder(r: CheckResult): boolean {
  return !!r.revenue && !finite(r.revenue.revenueScrap) && finite(r.revenue.eligibleCount) && r.revenue.eligibleCount > 0;
}

/**
 * Line 2: "Sells for <revenue> to <buyer> (bot, online) · 6 buyers". 0.7.4 (F23): past 2 h since the
 * order's last event, "(bot, last seen 4 d ago)" instead of a stale online flag.
 */
export function checkSellsLine(r: CheckResult, now: UnixMs = Date.now()): CheckSellsLine {
  const k = r.keyScrap ?? null;
  const rev = r.revenue;
  const order = rev?.order ?? null;
  const count = buyerCountLabel(finite(rev?.eligibleCount) ? rev.eligibleCount : 0);
  const none = { revenue: null, buyer: null, kind: null, online: null, seen: null, seenAt: null, count };
  if (!rev || !finite(rev.revenueScrap)) {
    // 0.7.3: buyers none of which is usable say why (noRevenueText), not "no eligible buy order".
    if (noUsableOrder(r)) return { ...none, none: 'no usable buy order', title: `${noRevenueText(rev)}.` };
    return { ...none, none: 'no eligible buy order', title: 'No eligible backpack.tf buy order in the live book right now.' };
  }
  const buyer = order?.userName?.trim() ? order.userName.trim() : null;
  const recent = order ? orderSeenRecently(order.lastEventAt, now) : false;
  return {
    revenue: fmtMoney(rev.revenueScrap, k),
    buyer,
    kind: order ? (order.isBot ? 'bot' : 'human') : null,
    online: order && recent ? order.online : null,
    seen: order && !recent && Number.isFinite(order.lastEventAt) ? buyerPresenceText(order, now) : null,
    seenAt: order && Number.isFinite(order.lastEventAt) ? order.lastEventAt : null,
    count,
    none: null,
    title: `${revenueBreakdown(rev, k)}. From the live backpack.tf book on this computer.`,
  };
}

// ---------------------------------------------------------------------------
// Verdict pill and Pay up to
// ---------------------------------------------------------------------------

export interface CheckVerdictView {
  tone: Tone;
  text: string;
  title: string;
}

/**
 * The pill: "Flip +X (margin)", "Over by Y" (the price minus Pay up to), "No buyers" ("No usable buyer"
 * when there are some), or "No scrap.tf price" (the popup then leads with Pay up to). null for a result
 * that is not an item.
 */
export function checkVerdictView(r: CheckResult): CheckVerdictView | null {
  if (r.status !== 'item' || r.verdict === null) return null;
  const k = r.keyScrap ?? null;
  const ceiling = r.revenue?.maxCostScrap ?? null;
  switch (r.verdict) {
    case 'flip': {
      const profit = fmtSignedMoney(r.profitScrap, k);
      // 0.8 (PC-1, PC-2): the breakdown when the result says what was taken off, and a flip only this buyer makes.
      const rev = r.revenue?.revenueScrap;
      const price = r.price?.valueScrap;
      const breakdown =
        r.exitCosts && finite(rev) && finite(price) && finite(r.profitScrap)
          ? profitBreakdownText({ revenueScrap: rev, costScrap: price, ...r.exitCosts, profitScrap: r.profitScrap }, k)
          : null;
      const head = breakdown ? `Profitable at this price by your profit thresholds. ${breakdown}` : 'Profitable at this price by your profit thresholds, after friction.';
      return {
        tone: 'good',
        text: finite(r.margin) ? `Flip ${profit} (${fmtPct(r.margin)})` : `Flip ${profit}`,
        title: r.singleExit ? `${head} ${singleExitText(r.singleExit, (v) => fmtMoney(v, k))}.` : head,
      };
    }
    case 'over': {
      const cost = r.price?.valueScrap;
      const over = finite(cost) && finite(ceiling) ? cost - ceiling : null;
      if (over !== null && over > 0) {
        return { tone: 'bad', text: `Over by ${fmtMoney(over, k)}`, title: `The price is ${fmtMoney(over, k)} above Pay up to (${fmtMoney(ceiling, k)}), the most that still clears your profit thresholds.` };
      }
      return {
        tone: 'bad',
        text: 'Not profitable',
        title: ceiling === null ? 'No scrap.tf price clears your profit thresholds against this buyer.' : `Profit ${fmtSignedMoney(r.profitScrap, k)} does not clear your thresholds.`,
      };
    }
    case 'no-buyers':
      // 0.7.3: as Quick entry's ceilingVerdict: buyers none of which is usable are not "No buyers".
      if (noUsableOrder(r)) return { tone: 'muted', text: 'No usable buyer', title: `${noRevenueText(r.revenue)}, so nothing to sell it to.` };
      return { tone: 'muted', text: 'No buyers', title: 'No eligible backpack.tf buy order right now, so nothing to sell it to.' };
    case 'no-price':
      return { tone: 'info', text: 'No scrap.tf price', title: 'Copy its row from scrap.tf/items (or type the price in Quick entry) to see the profit. Pay up to is the most to pay.' };
  }
}

export interface CheckPayUpTo {
  text: string;
  /** Leads the popup when there is no scrap.tf price to compare. */
  prominent: boolean;
  title: string;
}

/** "Pay up to Z": always shown; the most to pay that still clears the thresholds. */
export function checkPayUpTo(r: CheckResult): CheckPayUpTo {
  const ceiling = r.revenue?.maxCostScrap ?? null;
  const prominent = r.verdict === 'no-price';
  if (!finite(ceiling)) {
    return {
      text: '—',
      prominent,
      title:
        r.revenue && finite(r.revenue.revenueScrap)
          ? 'No scrap.tf price clears your profit thresholds against this buyer.'
          : noUsableOrder(r)
            ? `${noRevenueText(r.revenue)}, so no price to pay.`
            : 'No eligible buyer, so no price to pay.',
    };
  }
  return {
    text: fmtMoney(ceiling, r.keyScrap ?? null),
    prominent,
    // 0.8 (PC-1): names the price-move reserve when the result applied one; at 0 the 0.7.4 text.
    title: `The most to pay on scrap.tf that still clears your profit thresholds (after ${exitCostsWords(r.exitCosts?.reservePct)}).`,
  };
}

/** Header subtitle: the category label; null without one. */
export function checkCategoryText(r: Pick<CheckResult, 'category'>): string | null {
  return r.category ? categoryLabel(r.category) : null;
}

/** One sentence for screen readers, the Settings test and the Recent checks tooltip. Never quotes the copied text. */
export function checkSummaryText(r: CheckResult, now: UnixMs): string {
  if (r.status !== 'item') {
    const reason = r.reason?.trim() || 'Not checked.';
    return `${/[.!?]$/.test(reason) ? reason : `${reason}.`} ${CHECK_HINT}.`;
  }
  const name = r.name?.trim() || r.sku || 'Item';
  const verdict = checkVerdictView(r);
  const price = checkPriceText(r.price);
  const pay = checkPayUpTo(r);
  const parts = [`${name}: ${verdict ? verdict.text : 'checked'}.`];
  if (price && r.price) parts.push(`scrap.tf ${price} (${checkPriceSourceText(r.price, now)}).`);
  parts.push(`Pay up to ${pay.text}.`);
  // The service's fixed notes (closest match, sold out…): the popup may clip them, the summary does not.
  const note = r.reason?.trim();
  if (note) parts.push(/[.!?]$/.test(note) ? note : `${note}.`);
  return parts.join(' ');
}

/** Next to the verdict pill (Settings → Test): "Team Captain · scrap.tf 1.33 ref (copied) · Pay up to 2.11 ref". */
export function checkBriefText(r: CheckResult, now: UnixMs): string {
  if (r.status !== 'item') return checkSummaryText(r, now);
  const price = checkPriceText(r.price);
  return [r.name?.trim() || r.sku || 'Item', price && r.price ? `scrap.tf ${price} (${checkPriceSourceText(r.price, now)})` : 'no scrap.tf price', `Pay up to ${checkPayUpTo(r).text}`].join(' · ');
}

// ---------------------------------------------------------------------------
// Actions: Save price, Bought it, Details, Quick entry…
// ---------------------------------------------------------------------------

export interface CheckActionView {
  enabled: boolean;
  title: string;
}

export interface CheckActions {
  save: CheckActionView;
  bought: CheckActionView;
  details: CheckActionView;
  quick: CheckActionView;
}

/** 0.7.4 (F41): Save price's and Bought it's tooltip while the copy is undecided (checkCraftUndecided). */
export const CHECK_CRAFT_UNDECIDED_ACTION =
  'The copied text does not say whether this is the Craftable or the Non-Craftable copy. Check its card on scrap.tf, then use Quick entry….';

/**
 * Which buttons work for this result, each with its tooltip. 0.7.4 (F41): an undecided craftability
 * (checkCraftUndecided) turns Save price and Bought it off: neither copy is known to be the one copied.
 */
export function checkActions(r: CheckResult | null | undefined): CheckActions {
  const off = (title: string): CheckActionView => ({ enabled: false, title });
  if (!isItem(r)) {
    const none = off('Check an item first.');
    return { save: none, bought: none, details: none, quick: none };
  }
  const price = checkPriceText(r.price);
  const noPrice = 'No scrap.tf price to use. Copy its row from scrap.tf/items, or use Quick entry….';
  const undecided = checkCraftUndecided(r);
  let save: CheckActionView;
  if (!r.price || !price) save = off(noPrice);
  else if (undecided) save = off(CHECK_CRAFT_UNDECIDED_ACTION);
  else if (r.price.source === 'typed') save = off('This is already your saved price.');
  else if (r.price.source === 'import') save = off('This price is already in your price sheet, from a scrap.tf page you imported.');
  else
    save = {
      enabled: true,
      title: `Save ${price} as your scrap.tf price (note "${LIVE_CHECK_NOTE}")${r.price.source === 'list' ? ", dated when you saved the list" : ''} (Enter).`,
    };
  // A price for a copy with extras is not what this plain one cost: Holdings would book it wrong.
  const bought: CheckActionView = !r.price || !price
    ? off(noPrice)
    : undecided
      ? off(CHECK_CRAFT_UNDECIDED_ACTION)
      : checkPriceIsOtherCopy(r)
        ? off('This price is for a copy with extras (paint, spells, parts or a tag), not a plain one. Record the buy with Quick entry… or from the dashboard instead.')
        : { enabled: true, title: `Record that you bought it on scrap.tf at ${price}: a journal buy, shown in Holdings. Nothing is bought. (B)` };
  return {
    save,
    bought,
    details: { enabled: true, title: 'Open the item in the dashboard (D).' },
    quick: { enabled: true, title: price && quickTakesPrice(r) ? `Open Quick entry with this item and ${price}` : 'Open Quick entry with this item' },
  };
}

/**
 * Quick entry… may take the checked price: not one for a copy with extras (it would be saved as the plain
 * item's), nor, 0.7.4 (F41), one whose copy is undecided (it would be saved as whichever copy is open).
 */
function quickTakesPrice(r: CheckResult): boolean {
  return !checkPriceIsOtherCopy(r) && !checkCraftUndecided(r);
}

/** prices.upsert for Save price: the checked price as a typed price, dated when it was seen. null when it cannot be saved. */
export function checkSaveInput(r: CheckResult | null | undefined, now: UnixMs): ScrapPriceInput | null {
  if (!isItem(r) || !checkActions(r).save.enabled || !r.price) return null;
  const observed = finite(r.price.observedAt) ? Math.min(r.price.observedAt, now) : now;
  return {
    sku: r.sku,
    ...(r.name?.trim() ? { name: r.name.trim() } : {}),
    costKeys: finite(r.price.keys) && r.price.keys > 0 ? r.price.keys : 0,
    costScrap: Math.max(0, Math.round(r.price.scrapRaw)),
    source: 'user',
    observedAt: observed,
    note: LIVE_CHECK_NOTE,
  };
}

/** journal.add for Bought it: a buy on scrap.tf at the checked price, keys and metal as listed. */
export function checkBoughtInput(r: CheckResult | null | undefined): JournalInput | null {
  if (!isItem(r) || !r.price || checkPriceText(r.price) === null || !checkActions(r).bought.enabled) return null;
  return {
    side: 'buy',
    venue: BUY_VENUE,
    sku: r.sku,
    ...(r.name?.trim() ? { name: r.name.trim() } : {}),
    keys: finite(r.price.keys) && r.price.keys > 0 ? r.price.keys : 0,
    scrap: Math.max(0, Math.round(r.price.scrapRaw)),
    note: LIVE_CHECK_NOTE,
  };
}

/** app.showQuickEntry for Quick entry…: the SKU, plus the price as text its price field reads (units included). */
export function checkQuickEntryParams(r: CheckResult | null | undefined): { sku: string; price?: string } | null {
  if (!isItem(r)) return null;
  // A price for a copy with extras would be saved as the plain item's, and (0.7.4, F41) one of an undecided
  // copy as whichever copy is open: quick entry gets the item only.
  const price = quickTakesPrice(r) ? checkPriceText(r.price) : null;
  return price && price.length <= CHECK_PRICE_TEXT_MAX ? { sku: r.sku, price } : { sku: r.sku };
}

/** The Save price button for one result: idle, saving or saved (once per result). */
export type CheckSaveState = { id: number; status: 'saving' | 'done' };

export function checkSaveButton(state: CheckSaveState | null, id: number): { label: string; disabled: boolean; done: boolean } {
  const s = state && state.id === id ? state : null;
  if (s?.status === 'saving') return { label: 'Saving…', disabled: true, done: false };
  if (s?.status === 'done') return { label: 'Saved', disabled: true, done: true };
  return { label: 'Save price', disabled: false, done: false };
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export type CheckPopupAction = 'save' | 'bought' | 'details' | 'hide';

interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

/**
 * Enter = Save price, B = Bought it, D = Details, Esc = hide. Enter on a focused button or link is
 * that control's own click, and nothing but Esc fires from a text field; held keys and Ctrl/Alt/Win
 * chords do nothing (Ctrl+C must stay a copy).
 */
export function checkPopupKey(e: KeyLike, target: { tagName?: string; isContentEditable?: boolean } | null | undefined): CheckPopupAction | null {
  if (e.defaultPrevented || e.isComposing) return null;
  if (e.key === 'Escape') return 'hide';
  if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return null;
  const tag = (target?.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return null;
  if (e.key === 'Enter') return tag === 'BUTTON' || tag === 'A' ? null : 'save';
  const k = e.key.toLowerCase();
  if (k === 'b') return 'bought';
  if (k === 'd') return 'details';
  return null;
}

// ---------------------------------------------------------------------------
// Auto-hide: 10 s after each result, paused while hovered, focused or an Undo toast is up
// ---------------------------------------------------------------------------

export type CheckHideHold = 'hover' | 'focus' | 'toast';

/** After a hold ends, at least this long before the popup hides, so it never vanishes under a moving pointer. */
export const CHECK_HIDE_RESUME_MIN_MS = 3_000;

export interface CheckHideTimer {
  /** A new result was shown: the full countdown again (it waits while something holds it). */
  restart(): void;
  hold(why: CheckHideHold, on: boolean): void;
  /** The popup was hidden (by the timer, Esc, main): nothing pending. */
  stop(): void;
  /** True while a countdown is pending or held. */
  armed(): boolean;
}

export interface CheckHideTimerOpts {
  ms?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

/** The popup's countdown. Main never hides the popup on blur, so this (and Esc) is what hides it. */
export function createCheckHideTimer(onHide: () => void, opts: CheckHideTimerOpts = {}): CheckHideTimer {
  const total = opts.ms ?? CHECK_POPUP_HIDE_MS;
  const now = opts.now ?? Date.now;
  const setT = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = opts.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const holds = new Set<CheckHideHold>();
  let armed = false;
  let handle: unknown = null;
  let deadline = 0;
  let remaining = total;

  const cancel = () => {
    if (handle !== null) clearT(handle);
    handle = null;
  };
  const schedule = (ms: number) => {
    cancel();
    deadline = now() + ms;
    handle = setT(() => {
      handle = null;
      armed = false;
      onHide();
    }, ms);
  };

  return {
    restart() {
      armed = true;
      remaining = total;
      if (holds.size === 0) schedule(total);
      else cancel();
    },
    hold(why, on) {
      const had = holds.size > 0;
      if (on) holds.add(why);
      else holds.delete(why);
      if (!armed) return;
      if (!had && holds.size > 0 && handle !== null) {
        remaining = Math.max(0, deadline - now());
        cancel();
      } else if (had && holds.size === 0) {
        schedule(Math.max(remaining, CHECK_HIDE_RESUME_MIN_MS));
      }
    },
    stop() {
      armed = false;
      cancel();
    },
    armed: () => armed,
  };
}

// ---------------------------------------------------------------------------
// Recent checks (Live market)
// ---------------------------------------------------------------------------

/** Identity of one check: ids restart with the service process, so the time is part of it. */
export function checkKey(r: Pick<CheckResult, 'id' | 'checkedAt'>): string {
  return `${r.id}@${r.checkedAt}`;
}

/**
 * The panel's list: item results only, each once (a manual check is both returned and pushed as
 * 'check.done'), newest first, at most CHECK_RECENT_MAX.
 */
export function mergeRecentChecks(current: readonly CheckResult[], incoming: readonly CheckResult[]): CheckResult[] {
  const byKey = new Map<string, CheckResult>();
  for (const r of [...current, ...incoming]) {
    if (!isItem(r) || !finite(r.id) || !finite(r.checkedAt)) continue;
    byKey.set(checkKey(r), r);
  }
  return [...byKey.values()].sort((a, b) => b.checkedAt - a.checkedAt || b.id - a.id).slice(0, CHECK_RECENT_MAX);
}

export interface RecentCheckRow {
  key: string;
  sku: string;
  name: string;
  /** "3 min ago" (the exact time is in the tooltip). */
  ago: string;
  price: string | null;
  priceSource: string | null;
  verdict: CheckVerdictView | null;
  payUpTo: string;
  title: string;
}

/** One row of the panel: time, item, price and its source, verdict, Pay up to. */
export function recentCheckRow(r: CheckResult, now: UnixMs): RecentCheckRow {
  const sku = r.sku ?? '';
  return {
    key: checkKey(r),
    sku,
    name: r.name?.trim() || sku,
    ago: fmtAgo(r.checkedAt, now),
    price: checkPriceText(r.price),
    priceSource: r.price ? checkPriceSourceText(r.price, now) : null,
    verdict: checkVerdictView(r),
    payUpTo: checkPayUpTo(r).text,
    title: `${checkSummaryText(r, now)} Checked ${fmtDateTime(r.checkedAt)} by ${CHECK_SOURCE_LABELS[r.source] ?? r.source}. Click to open it.`,
  };
}

/** The panel's open state is a remembered UI preference; anything but true is the default, collapsed. */
export function sanitizeRecentOpen(v: unknown): boolean {
  return v === true;
}

/** The manual box's own check before sending: empty text is not worth a round trip. */
export function manualCheckProblem(text: string): string | null {
  return text.trim() === '' ? 'Paste or type an item name, or a row from scrap.tf/items.' : null;
}

/** The panel header's one-line how-to, from Settings → Live check. */
export function recentChecksHint(hotkey: string, watching: boolean): string {
  const key = hotkey.trim();
  if (key && watching) return `Copy an item on scrap.tf: clipboard check is on, or press ${accelLabel(key)}. Or paste one here.`;
  if (key) return `Copy an item on scrap.tf and press ${accelLabel(key)}, or paste it here.`;
  if (watching) return 'Copy an item on scrap.tf: clipboard check is on. Or paste one here.';
  return 'Paste an item here, or set a check hotkey in Settings → Live check.';
}
