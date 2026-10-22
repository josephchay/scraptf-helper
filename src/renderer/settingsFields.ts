// Client-side checks for Settings fields. Each one matches what main's
// settings schema accepts, so a value that passes here is never rejected
// there (a rejected value would otherwise look saved). Pure: unit tested.

import { SCRAPTF_BOUNDARY_SHORT } from '../shared/boundaryText';
import { isReservedAccelerator, isValidAccelerator, sameAccelerator } from '../shared/accelerator';
import { BANK_STOCK_MAX_NOTIFICATIONS, BANK_STOCK_NOTIFY_DEDUP_MS } from '../shared/bankStock';
import { CHECK_PRIVACY_SENTENCE } from '../shared/check';
import { parsePrice } from '../shared/currency';
import type { HotkeyState } from '../shared/rpc';
import { SCRAPTF_RESAVE_MAX_MIN } from '../shared/scraptfHistory';
import { SCRAPTF_BANK_IDS } from '../shared/types';
import type { InputKind, ScraptfBank, ScraptfListKey, Settings, UnixMs } from '../shared/types';
import { accelLabel, fmtAgo, fmtDateTime, fmtRefOnly, isValidContactUrl } from './format';

/** Plain decimal text; Number() alone also takes '', '0x10' and '1e3' (and '' becomes 0). */
const DECIMAL = /^\s*[-+]?(\d+\.?\d*|\.\d+)\s*$/;

export function numberValidator(min: number, max: number, allowEmpty = false) {
  return (v: string): string | null => {
    // A cleared field must not commit as 0 (Number('') === 0), which would loosen a threshold.
    if (v.trim() === '') return allowEmpty ? null : 'Enter a number.';
    if (!DECIMAL.test(v)) return 'Enter a number.';
    const n = Number(v);
    if (!Number.isFinite(n)) return 'Enter a number.';
    if (n < min || n > max) return `Between ${min} and ${max}.`;
    return null;
  };
}

/** Percent bounds of the profit fields; the schema stores fractions (minMargin 0..1, minProfitPctOfCost 0..10). */
export const MIN_MARGIN_PCT = { min: 0, max: 100 } as const;
export const MIN_PROFIT_PCT_OF_COST = { min: 0, max: 100 } as const;
/** profit.suspectMargin is a ratio from 0 to 1000 (2 = 200 %); 0 turns the guard off. */
export const SUSPECT_MARGIN_PCT = { min: 0, max: 100_000 } as const;
/** profit.referenceMaxAgeMs, shown in days: the schema allows 0 to 365 days. */
export const REFERENCE_MAX_AGE_DAYS = { min: 0, max: 365 } as const;
/** 0.8 (PC-1): profit.exitReservePct, shown in percent: the schema allows 0 to 0.5. */
export const EXIT_RESERVE_PCT = { min: 0, max: 50 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A stored ratio as the percentage text a field shows ("2" -> "200"). */
export function ratioToPctText(ratio: number): string {
  return String(+(ratio * 100).toFixed(2));
}

/** Field text (already validated) back to the stored ratio. */
export function pctTextToRatio(v: string): number {
  return Number(v) / 100;
}

export function msToDaysText(ms: number): string {
  return String(+(ms / DAY_MS).toFixed(2));
}

/** Days text (already validated) to the integer milliseconds the schema requires. */
export function daysTextToMs(v: string): number {
  return Math.round(Number(v) * DAY_MS);
}

export function suspectMarginHint(ratio: number): string {
  const base = 'With fewer than 3 buyers and no usable reference price, a margin above this is capped at Low confidence and never notified. It usually means a wrong variant or unit.';
  return ratio > 0 ? `${base} 0 turns the check off.` : `Off. ${base}`;
}

/** 0.8 (PC-1): what the price-move reserve does, and that the number is the user's, not measured. */
export function exitReserveHint(ratio: number): string {
  const base =
    "Taken off what the buyer pays, for a price drop between buying on scrap.tf and the buyer accepting. Lowers Profit and Pay up to wherever a buy is judged. A sale into a live buy order (selling what you hold now, or to the next buyer) is judged without it; Holdings' advice includes it for exits nobody pays today (a listing, a recorded high, a reference). Your own allowance: Flip Desk does not measure price swings.";
  return ratio > 0 ? base : `Off. ${base}`;
}

/**
 * 0.7.3: profit.inputStaleMs ("Price is stale after") does more than lower confidence since 0.7.1
 * (confidence.ts, engine.ts, shopping.ts, bankStock.ts). Rule estimates are scored apart.
 */
export const INPUT_STALE_HINT =
  'Typed and imported scrap.tf prices older than this (and over 15 min old) lose confidence, are never notified and are not counted as at or under Pay up to. ' +
  "A bank save newer than this holds back Candidate toasts for items not on it; an older save's new flips come as one summary toast.";

export function referenceAgeHint(ms: number): string {
  const base =
    'PriceDB prices older than this are left out of outlier checks and confidence (flag "Old reference"). Community prices are set by hand, so they always get at least a year.';
  // usableReferences keeps a price whose age is unknown, so 0 does not drop literally every one.
  return ms > 0 ? base : `${base} At 0 every PriceDB price with a known age is ignored.`;
}

/** notifications.inputKinds options, in the order the settings store them. */
export const NOTIFY_INPUT_KINDS: readonly { value: InputKind; label: string; hint: string }[] = [
  { value: 'user', label: 'Typed prices', hint: 'prices you entered' },
  { value: 'import', label: 'Imported pages', hint: 'pages you saved and imported' },
  { value: 'rule', label: 'Rule candidates', hint: 'items your rules match; check scrap.tf by hand' },
];

/** Ticks or unticks one kind; the result is de-duplicated and in a stable order. */
export function setInputKind(current: readonly InputKind[], kind: InputKind, on: boolean): InputKind[] {
  const want = new Set(current);
  if (on) want.add(kind);
  else want.delete(kind);
  return NOTIFY_INPUT_KINDS.map((o) => o.value).filter((k) => want.has(k));
}

export function inputKindsHint(kinds: readonly InputKind[]): string {
  if (!kinds.length) return 'Nothing ticked, so no desktop notifications. Opportunities still appear in the app.';
  return 'Only profitable items from these inputs can notify.';
}

/** notifications.holdings (F11): the sell alert for what the journal says you hold. */
export const HOLDINGS_NOTIFY_LABEL = 'Notify when something you hold can be sold at a profit';

/** 0.7.3: F14's scrap.tf exit notifies too, and minConfidence gates only backpack.tf buyers (holdings.ts). */
export function holdingsNotifyHint(notificationsOn: boolean): string {
  const base =
    "For items in Holdings (journal buys not sold yet): a backpack.tf buyer, or scrap.tf's bank on a price list you saved in the last day (while it is not full), pays enough over your cost to clear your profit thresholds. " +
    'Uses the repeat time above, and the minimum confidence for backpack.tf buyers only (it does not hold back a scrap.tf sale).';
  return notificationsOn ? base : `Desktop notifications are off, so this shows nothing until they are on. ${base}`;
}

/**
 * notifications.newOnScraptf (F17): flips on a scrap.tf bank page the user saved. 0.8 (G2, LC-7): also one a read
 * made cheaper than Pay up to and one back on sale, which take the place of toasts the same find got before.
 */
export const NEW_ON_SCRAPTF_NOTIFY_LABEL = 'New, cheaper or back-in-stock flips on scrap.tf pages you save';

/** "<A>, <B> and <C>, so this shows nothing yet. <base>" for what keeps a switch silent; `base` alone when nothing does. */
function silentHint(missing: readonly string[], base: string): string {
  if (!missing.length) return base;
  const first = missing[0]!;
  const list = [first.charAt(0).toUpperCase() + first.slice(1), ...missing.slice(1)];
  const said = list.length === 1 ? list[0]! : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]!}`;
  return `${said}, so this shows nothing yet. ${base}`;
}

/**
 * The switch's description. The service also needs desktop notifications on, "Imported pages" under
 * Notify for, and saved-page import (behind its acknowledgement): each missing one is said first.
 */
export function newOnScraptfNotifyHint(a: { notificationsOn: boolean; importKind: boolean; importOn: boolean }): string {
  const dedupMin = Math.round(BANK_STOCK_NOTIFY_DEDUP_MS / 60_000);
  const base =
    `When a scrap.tf page you save has new items that are flips: "New on scrap.tf (Hats): <name>"; one a read made cheaper than your Pay up to: "Cheaper on scrap.tf (Hats): <name>"; and one back on sale: "Back on scrap.tf (Hats): <name>". ` +
    `At most ${BANK_STOCK_MAX_NOTIFICATIONS} per save, then one summary that opens the page's stock; each item once per page every ${dedupMin} minutes. A first save of a page notifies nothing. ` +
    `Uses the minimum confidence and profit above. ${SCRAPTF_BOUNDARY_SHORT}`;
  const missing: string[] = [];
  if (!a.notificationsOn) missing.push('Desktop notifications are off');
  if (!a.importKind) missing.push('"Imported pages" is not ticked under Notify for');
  if (!a.importOn) missing.push('saved-page import is off (Import)');
  return silentHint(missing, base);
}

/** notifications.watches (0.8, G1/G3): toasts for the items the user watches on scrap.tf. */
export const WATCHES_NOTIFY_LABEL = 'Your scrap.tf watches';

/**
 * notifications.watches' description: "Watch (Hats): <name>" at the user's price or profit, "Back on scrap.tf" for a
 * watch that asked, told on the read that shows it; a watch's profit target is also its item's bar for a typed or
 * imported price, whose toast the engine then titles "Watch: <name>" (not "Profit:"). Desktop
 * notifications and saved-page import must be on (each missing one is said first, as newOnScraptfNotifyHint).
 */
export function watchesNotifyHint(a: { notificationsOn: boolean; importOn: boolean }): string {
  const base =
    `For the items you watch (Watch on scrap.tf… in an item's menu or its details): "Watch (Hats): <name>" when a page you read or save shows one at or under your price, or at or over your profit, and "Back on scrap.tf (Hats): <name>" when one you asked about is on sale again. ` +
    `Told on the read that shows it, not again for the same price. A watch's profit target is also that item's bar for a price you type or import: one that reaches it is told as "Watch: <name>" in place of "Profit: <name>". ` +
    `At most ${BANK_STOCK_MAX_NOTIFICATIONS} per save with the other scrap.tf toasts, then one summary. ${SCRAPTF_BOUNDARY_SHORT}`;
  const missing: string[] = [];
  if (!a.notificationsOn) missing.push('Desktop notifications are off');
  if (!a.importOn) missing.push('saved-page import is off (Import)');
  return silentHint(missing, base);
}

/** notifications.buyTiming (0.8, G4): "Buy now" after Wait, off by default (D25). */
export const BUY_TIMING_NOTIFY_LABEL = 'Buy now after Wait (estimate from your saves)';

/**
 * notifications.buyTiming's description: "Buy now (Hats): <name>" when a flip the user's saves said to wait for turns
 * into a buy after a drop showed or the wait's time ran out; an estimate from the saves, never a forecast; off by
 * default. It also needs everything the scrap.tf flips switch needs (the service's `flips`: that switch and "Imported
 * pages" under Notify for) plus desktop notifications and saved-page import; each missing one is said first.
 */
export function buyTimingNotifyHint(a: { notificationsOn: boolean; newOnScraptfOn: boolean; importKind: boolean; importOn: boolean }): string {
  const base =
    `"Buy now (Hats): <name>" when a page you read or save turns a flip your saves said to wait for into a buy, after a drop showed or the wait's time ran out. ` +
    `An estimate from your own saves, never a forecast; off by default. Needs the scrap.tf flips toggle above. ${SCRAPTF_BOUNDARY_SHORT}`;
  const missing: string[] = [];
  if (!a.notificationsOn) missing.push('Desktop notifications are off');
  if (!a.newOnScraptfOn) missing.push('the scrap.tf flips toggle above is off');
  if (!a.importKind) missing.push('"Imported pages" is not ticked under Notify for');
  if (!a.importOn) missing.push('saved-page import is off (Import)');
  return silentHint(missing, base);
}

// ---------------------------------------------------------------------------
// Re-save reminders (F20 S5/U4): settings.import.resaveReminderMin and resaveBanks. The app cannot
// refresh scrap.tf; a reminder only tells the user to save the page again (SCRAPTF_RESAVE_HELP).
// ---------------------------------------------------------------------------

/** The schema's range: whole minutes, 0 (off) to a day. */
export const RESAVE_MINUTES = { min: 0, max: SCRAPTF_RESAVE_MAX_MIN } as const;

/** Whole minutes 0..1440, as the schema's int; an empty field is not 0 here (it says how to turn reminders off). */
export function validateResaveMinutes(v: string): string | null {
  const t = v.trim();
  if (t === '') return 'Enter the minutes; 0 turns reminders off.';
  if (!/^\d+$/.test(t)) return `Whole minutes, ${RESAVE_MINUTES.min} to ${RESAVE_MINUTES.max}.`;
  if (Number(t) > RESAVE_MINUTES.max) return `At most ${RESAVE_MINUTES.max} minutes (a day).`;
  return null;
}

/** Field text (already validated) to the stored minutes. */
export function resaveMinutesOf(v: string): number {
  const n = Math.round(Number(v.trim()));
  return Number.isFinite(n) ? Math.min(RESAVE_MINUTES.max, Math.max(RESAVE_MINUTES.min, n)) : 0;
}

/** The ticked boxes: [] (the default) means every bank, so every box shows ticked. */
export function resaveBanksShown(stored: readonly ScraptfBank[] | null | undefined): ScraptfBank[] {
  const set = new Set(stored ?? []);
  return set.size === 0 ? [...SCRAPTF_BANK_IDS] : SCRAPTF_BANK_IDS.filter((b) => set.has(b));
}

/**
 * The resaveBanks to save after one box is ticked or unticked, in SCRAPTF_BANKS order, or null when it
 * would leave none: [] means every bank, so the last box stays ticked (minutes 0 turns reminders off).
 * Every box ticked saves [], which also takes in a bank saved for the first time later.
 */
export function setResaveBank(stored: readonly ScraptfBank[] | null | undefined, bank: ScraptfBank, on: boolean): ScraptfBank[] | null {
  const want = new Set(resaveBanksShown(stored));
  if (on) want.add(bank);
  else want.delete(bank);
  const next = SCRAPTF_BANK_IDS.filter((b) => want.has(b));
  if (next.length === 0) return null;
  return next.length === SCRAPTF_BANK_IDS.length ? [] : next;
}

export const RESAVE_LAST_BANK_TITLE = 'Keep at least one bank ticked. To stop the reminders, set the minutes to 0.';

/** Under the bank boxes: what the stored list means. */
export function resaveBanksHint(stored: readonly ScraptfBank[] | null | undefined): string {
  return !stored || stored.length === 0
    ? 'Every bank you have saved at least once, including ones you save later. Never a bank you have not saved.'
    : 'Only the ticked banks, and only once you have saved them at least once.';
}

/**
 * The minutes field's description: what a reminder does, then (first) whatever keeps it silent: import
 * off, desktop notifications off, the network paused, like the service's gates.
 */
export function resaveReminderHint(a: { minutes: number; importOn: boolean; notificationsOn: boolean; networkPaused: boolean }): string {
  if (!Number.isFinite(a.minutes) || a.minutes < 1) {
    return 'Off. Enter the minutes after which a bank you have saved, but not since, gets a desktop notification to save it again.';
  }
  const m = Math.round(a.minutes);
  const base =
    `A desktop notification for each bank below that you have saved, once it has not been saved for ${m} ${m === 1 ? 'minute' : 'minutes'}, then at most once every ${m} ${m === 1 ? 'minute' : 'minutes'} until you save it: ` +
    '"Re-save scrap.tf/buy/hats". Clicking it opens that page in your browser. Silent notifications apply.';
  const missing: string[] = [];
  if (!a.importOn) missing.push('saved-page import is off (Import)');
  if (!a.notificationsOn) missing.push('desktop notifications are off (Notifications)');
  if (a.networkPaused) missing.push('the network is paused');
  if (!missing.length) return base;
  const said = missing.length === 1 ? missing[0]! : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]!}`;
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}, so none come yet. ${base}`;
}

export const HOTKEY_HINT_ERROR = 'Needs Ctrl, Alt or Win plus a key (an F-key works alone), e.g. CommandOrControl+Alt+F. Leave it empty to turn the shortcut off.';

/** Empty turns the global shortcut off, as main and the schema allow. */
export function validateHotkey(v: string): string | null {
  const t = v.trim();
  if (isValidAccelerator(t)) return null;
  if (isReservedAccelerator(t)) return 'That is a system or everyday shortcut; a global hotkey would take it from every app. Pick another.';
  return HOTKEY_HINT_ERROR;
}

// ---------------------------------------------------------------------------
// Live check (F16): its hotkey must not be the quick-entry one (main refuses that too,
// CHECK_HOTKEY_CONFLICT in settingsSchema.ts: one global registration per chord).
// ---------------------------------------------------------------------------

export const CHECK_HOTKEY_CONFLICT_ERROR = 'That is the quick-entry hotkey. The live check needs a shortcut of its own.';
export const QUICK_HOTKEY_CONFLICT_ERROR = 'That is the live check hotkey. Pick another, or change the live check hotkey first.';

/** The check hotkey: the quick-entry rules, and never the quick-entry chord ("Ctrl+Alt+C" equals "CommandOrControl+Alt+C"). */
export function validateCheckHotkey(v: string, quickEntryHotkey: string): string | null {
  const base = validateHotkey(v);
  if (base) return base;
  return sameAccelerator(v.trim(), quickEntryHotkey) ? CHECK_HOTKEY_CONFLICT_ERROR : null;
}

/** The quick-entry hotkey, the other way round. */
export function validateQuickEntryHotkey(v: string, checkHotkey: string): string | null {
  const base = validateHotkey(v);
  if (base) return base;
  return sameAccelerator(v.trim(), checkHotkey) ? QUICK_HOTKEY_CONFLICT_ERROR : null;
}

/** The last save of the check hotkey in this session: main registers it before saving, so a failure is never stored. */
export interface CheckHotkeySave {
  hotkey: string;
  error: string | null;
}

export interface CheckHotkeyStatus {
  tone: 'good' | 'bad' | 'muted';
  pill: string;
  text: string;
}

/** `held` is main's registration of `hotkey` itself ('app.hotkeys'): never one left from an older chord. */
function heldFor(hotkey: string, held: HotkeyState | null | undefined): HotkeyState | null {
  if (!held || !hotkey) return null;
  return held.accelerator === hotkey || sameAccelerator(held.accelerator, hotkey) ? held : null;
}

/**
 * Registration status beside the field: on (with the chord), off, why the last change was refused, or
 * main's own word that the stored chord is not held ('app.hotkeys': taken by another app at start-up).
 */
export function checkHotkeyStatus(hotkey: string, last: CheckHotkeySave | null, held: HotkeyState | null = null): CheckHotkeyStatus {
  const current = hotkey.trim();
  const keep = current ? `Still using ${accelLabel(current)}.` : 'The hotkey stays off.';
  if (last?.error && last.hotkey.trim() !== current) {
    return { tone: 'bad', pill: 'Not changed', text: `Could not use ${last.hotkey.trim() ? accelLabel(last.hotkey.trim()) : 'that'}: ${last.error} ${keep}` };
  }
  if (!current) return { tone: 'muted', pill: 'Off', text: 'Off. Enter a shortcut such as CommandOrControl+Alt+C to turn it on.' };
  const reg = heldFor(current, held);
  if (reg && !reg.registered && reg.error) {
    return { tone: 'bad', pill: 'Unavailable', text: `${accelLabel(current)} is not working: ${reg.error} Pick another shortcut; the clipboard check and the box on the Live market still work.` };
  }
  if (reg && !reg.registered) {
    return { tone: 'muted', pill: 'Not active', text: `${accelLabel(current)} is saved but not registered right now. It is registered when the app starts or when you change it.` };
  }
  return {
    tone: 'good',
    pill: 'On',
    text: `Copy an item while you browse, then press ${accelLabel(current)}: the clipboard is read once, on this computer. Electron accelerator format; leave it empty to turn it off.`,
  };
}

/** The quick-entry field's error when main could not register its stored chord (start-up included); null otherwise. */
export function quickHotkeyProblem(hotkey: string, held: HotkeyState | null | undefined): string | null {
  const reg = heldFor(hotkey.trim(), held);
  return reg && !reg.registered && reg.error ? `${accelLabel(hotkey.trim())} is not working: ${reg.error} Pick another shortcut.` : null;
}

export const CHECK_WATCH_LABEL = 'Watch the clipboard';

/** The watch switch's description: the privacy sentence first (it is shown with the switch), then when it pauses. */
export function checkWatchHint(on: boolean, networkPaused: boolean): string {
  const base = `${CHECK_PRIVACY_SENTENCE} Off by default. It only reacts to new text, ignores anything that looks like a password or key and any link that is not an item link, and pauses while the screen is locked. You can also switch it off from the tray menu.`;
  return on && networkPaused ? `${base} Paused now: the network is paused.` : base;
}

export const CHECK_NOTIFY_LABEL = 'Notify me about flips the watcher finds';

/**
 * ACT-7: the watcher sends one alert per check, so this notification is for when the check popup is off
 * (`popupOn`: Show the check popup below); with it on, the popup is that alert.
 */
export function checkNotifyHint(notificationsOn: boolean, popupOn = false): string {
  const base = 'A desktop notification for flips only, while the check popup is off, at most once a minute per item. Silent notifications apply.';
  const popup = popupOn ? ' The check popup is on, so it shows each flip instead and this sends nothing.' : '';
  return notificationsOn ? `${base}${popup}` : `Desktop notifications are off (Notifications above), so this shows nothing until they are on. ${base}${popup}`;
}

export const CHECK_POPUP_LABEL = 'Show the check popup';
export const CHECK_POPUP_HINT =
  'A small window at the bottom right with the price, what it sells for and Pay up to. It hides itself after 10 s unless you point at it. When off, the watcher only notifies; the hotkey still shows its result.';

export const CONTACT_ERROR = 'Use an https:// address or mailto:, in plain ASCII without spaces or parentheses, at most 200 characters.';

export function validateContactUrl(v: string): string | null {
  return !v.trim() || isValidContactUrl(v) ? null : CONTACT_ERROR;
}

/** What the service sends (src/service/net/http.ts buildUserAgent) for a saved contact. */
export function userAgentPreview(version: string, contactUrl: string): string {
  return `TF2FlipDesk/${version} (+${contactUrl.trim() || 'no-contact-set'})`;
}

// ---------------------------------------------------------------------------
// Blocklist
// ---------------------------------------------------------------------------

/** Same ids in the same order (the Save button's dirty check). */
export function sameIdList(a: readonly string[], b: readonly string[]): boolean {
  return a.join(',') === b.join(',');
}

/**
 * 0.7.3: the list Settings saves. Arrays replace whole in mergeSettings, so only the user's own edit
 * (`edited` against `base`, the list the textarea was seeded from) is applied to a fresh read, as
 * blockBuyer and unblockBuyer do (itemMenuModel.ts): a buyer blocked in the drawer meanwhile stays blocked.
 */
export function applyBlocklistEdit(fresh: readonly string[], base: readonly string[], edited: readonly string[]): string[] {
  const was = new Set(base);
  const now = new Set(edited);
  return [...new Set([...fresh.filter((x) => !was.has(x) || now.has(x)), ...edited.filter((x) => !was.has(x))])];
}

// ---------------------------------------------------------------------------
// Key price: scrap.tf's key prices from the saved scrap.tf/items list (F14)
// ---------------------------------------------------------------------------

/** keyprice.ts's sanity range: a key outside 2..2000 ref is a broken value, not a key price. */
export const KEY_SANE_SCRAP = { min: 18, max: 18_000 } as const;

function saneKey(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= KEY_SANE_SCRAP.min && v <= KEY_SANE_SCRAP.max ? Math.round(v) : null;
}

export const REF_TEXT_ERROR = 'Enter refined, e.g. 1.33 or 14 scrap.';
export const KEY_PRICE_RANGE_ERROR = 'A key price is between 2 and 2000 ref.';

/**
 * 0.7.3: the key price fields. The schema takes any scrap, but the service ignores a key outside
 * KEY_SANE_SCRAP (Manual mode then falls back to backpack.tf), so such a value is refused here.
 * Compares the parsed scrap, as sane() does; empty clears the field.
 */
export function validateKeyPriceRef(v: string): string | null {
  if (!v.trim()) return null;
  const p = parsePrice(v, 'ref');
  if (!p || p.keys) return REF_TEXT_ERROR;
  return p.scrap >= KEY_SANE_SCRAP.min && p.scrap <= KEY_SANE_SCRAP.max ? null : KEY_PRICE_RANGE_ERROR;
}

/** A key field's hint, plus a note when its saved value (from before that check) is one the service ignores. */
export function keyPriceHint(scrap: number | null, base?: string): string | undefined {
  if (scrap === null || saneKey(scrap) !== null) return base;
  const note = `${KEY_PRICE_RANGE_ERROR.slice(0, -1)}, so the saved value is ignored.`;
  return base ? `${base} ${note}` : note;
}

type TypedScraptfKey = Pick<Settings['keyPrice'], 'scraptfBuyScrap' | 'scraptfSellScrap' | 'scraptfObservedAt'>;

/**
 * Whether the saved list's key row supplies scrap.tf's key prices: the service's effectiveScraptfKey
 * rule (keyprice.ts), replicated because the dashboard cannot import service code. The list wins
 * when it has a usable price and the typed values are missing, undated or older.
 */
export function scraptfListKeyInUse(list: ScraptfListKey | null | undefined, typed: TypedScraptfKey): boolean {
  if (!list || !Number.isFinite(list.observedAt) || (saneKey(list.paysScrap) === null && saneKey(list.sellsScrap) === null)) return false;
  const hasTyped = saneKey(typed.scraptfSellScrap) !== null || saneKey(typed.scraptfBuyScrap) !== null;
  const at = typed.scraptfObservedAt;
  return !hasTyped || typeof at !== 'number' || !Number.isFinite(at) || list.observedAt > at;
}

/** Where each of scrap.tf's key prices comes from: the saved list, the typed values, or nowhere. */
export interface ScraptfListKeySources {
  /** What scrap.tf pays for a key (caps the automatic key price). */
  pays: 'list' | 'settings' | null;
  /** What scrap.tf charges for a key (display only). */
  sells: 'list' | 'settings' | null;
}

/**
 * Per price, effectiveScraptfKey's pick (keyprice.ts): the newer source supplies what it has and a
 * price it lacks comes from the other. So a list older than the typed values still supplies what
 * scrap.tf pays when none is typed, and that one caps the automatic key price.
 */
export function scraptfListKeySources(list: ScraptfListKey | null | undefined, typed: TypedScraptfKey): ScraptfListKeySources {
  const listPays = list ? saneKey(list.paysScrap) : null;
  const listSells = list ? saneKey(list.sellsScrap) : null;
  const typedPays = saneKey(typed.scraptfSellScrap);
  const typedSells = saneKey(typed.scraptfBuyScrap);
  const pick = (first: 'list' | 'settings', a: number | null, b: number | null): 'list' | 'settings' | null =>
    a !== null ? first : b !== null ? (first === 'list' ? 'settings' : 'list') : null;
  if (scraptfListKeyInUse(list, typed)) return { pays: pick('list', listPays, typedPays), sells: pick('list', listSells, typedSells) };
  if (typedPays === null && typedSells === null) return { pays: null, sells: null };
  return { pays: pick('settings', typedPays, listPays), sells: pick('settings', typedSells, listSells) };
}

/**
 * 0.7.3: the patch for the typed key buy price, which is display only. The typed pair shares one date,
 * so it re-dates them only while no usable sell price is typed: saving it never lets an older typed
 * sell price beat a newer saved list, and never changes the cap (effectiveScraptfKey's paysScrap).
 */
export function scraptfKeyBuyPatch(buyScrap: number | null, typed: TypedScraptfKey, now: UnixMs): { keyPrice: Partial<Settings['keyPrice']> } {
  return { keyPrice: saneKey(typed.scraptfSellScrap) === null ? { scraptfBuyScrap: buyScrap, scraptfObservedAt: now } : { scraptfBuyScrap: buyScrap } };
}

/** One of Data health's key price rows for scrap.tf's own key prices (F14). */
export interface ScraptfKeyHealthRow {
  /** The values typed in Settings, or the saved scrap.tf/items list's key row. */
  source: 'settings' | 'list';
  label: string;
  /** What scrap.tf charges for a key (the table's Buy column). */
  buyScrap: number | null;
  /** What scrap.tf pays for a key (the Sell column). */
  sellScrap: number | null;
  observedAt: UnixMs | null;
  /** This row's pays price is the one in effect: it caps the automatic key value. */
  caps: boolean;
}

/**
 * Data health's scrap.tf rows: the typed values and the saved list's key row (KeyPriceState.scraptfFromList),
 * each labelled by what effectiveScraptfKey takes from it (scraptfListKeySources). A newer list replaces the
 * typed values, so the table must not go on calling the typed price the cap once the list sets it.
 */
export function scraptfKeyHealthRows(list: ScraptfListKey | null | undefined, typed: TypedScraptfKey): ScraptfKeyHealthRow[] {
  const src = scraptfListKeySources(list, typed);
  const label = (who: string, from: 'settings' | 'list'): string => {
    if (src.pays === from) return `scrap.tf (${who}; sell caps the automatic value)`;
    if (src.sells === from) return `scrap.tf (${who}; buy price only)`;
    const other = from === 'list' ? 'settings' : 'list';
    if (src.pays === other || src.sells === other) return `scrap.tf (${who}; not in use: ${from === 'list' ? 'your typed values are newer' : 'your saved list is newer'})`;
    return `scrap.tf (${who}; not in use)`;
  };
  const rows: ScraptfKeyHealthRow[] = [];
  if (typed.scraptfBuyScrap || typed.scraptfSellScrap) {
    rows.push({
      source: 'settings',
      label: label('yours', 'settings'),
      buyScrap: typed.scraptfBuyScrap ?? null,
      sellScrap: typed.scraptfSellScrap ?? null,
      observedAt: typed.scraptfObservedAt ?? null,
      caps: src.pays === 'settings',
    });
  }
  if (list && Number.isFinite(list.observedAt) && (saneKey(list.paysScrap) !== null || saneKey(list.sellsScrap) !== null)) {
    rows.push({ source: 'list', label: label('saved list', 'list'), buyScrap: saneKey(list.sellsScrap), sellScrap: saneKey(list.paysScrap), observedAt: list.observedAt, caps: src.pays === 'list' });
  }
  return rows;
}

/**
 * The key price tip's scrap.tf line: what scrap.tf pays for a key, from whichever source effectiveScraptfKey
 * takes it from (that price caps the automatic value), with the list's age; null when neither has one.
 */
export function scraptfKeyTipText(list: ScraptfListKey | null | undefined, typed: TypedScraptfKey, now: UnixMs): string | null {
  const src = scraptfListKeySources(list, typed);
  if (src.pays === 'list' && list) return `scrap.tf sell (saved list, ${fmtAgo(list.observedAt, now)}): ${fmtRefOnly(saneKey(list.paysScrap))}`;
  if (src.pays === 'settings') return `scrap.tf sell (yours): ${fmtRefOnly(saneKey(typed.scraptfSellScrap))}`;
  return null;
}

export interface ScraptfListKeyView {
  /** "From your saved scrap.tf list (3 min ago): scrap.tf sells a key for 63.33 ref, pays 62.11 ref." */
  text: string;
  title: string;
  /** At least one of the list's key prices is used. */
  inUse: boolean;
  /** The pill: 'In use', 'Partly in use' (the typed values are newer but lack one the list has) or 'Not in use'. */
  pill: 'In use' | 'Partly in use' | 'Not in use';
  /** Why it is (or is not) in use, next to the pill. */
  status: string;
}

/**
 * Settings → Key price's line for KeyPriceState.scraptfFromList (null without a key row). Naming
 * trap: the list's `sells` is what scrap.tf charges (the typed "key buy price"), `pays` is what it
 * pays you (the typed "key sell price", which caps the automatic value).
 */
export function scraptfListKeyView(list: ScraptfListKey | null | undefined, typed: TypedScraptfKey & Pick<Settings['keyPrice'], 'mode'>, now: UnixMs): ScraptfListKeyView | null {
  if (!list || !Number.isFinite(list.observedAt)) return null;
  const sells = saneKey(list.sellsScrap);
  const pays = saneKey(list.paysScrap);
  if (sells === null && pays === null) return null;
  const listWins = scraptfListKeyInUse(list, typed);
  const src = scraptfListKeySources(list, typed);
  const fromList = Number(src.pays === 'list') + Number(src.sells === 'list');
  const available = Number(pays !== null) + Number(sells !== null);
  const pill: ScraptfListKeyView['pill'] = fromList === 0 ? 'Not in use' : fromList < available ? 'Partly in use' : 'In use';
  const hasTyped = saneKey(typed.scraptfSellScrap) !== null || saneKey(typed.scraptfBuyScrap) !== null;
  const text = `From your saved scrap.tf list (${fmtAgo(list.observedAt, now)}): ${sells !== null ? `scrap.tf sells a key for ${fmtRefOnly(sells)}` : 'scrap.tf has no keys to sell (sold out)'}, pays ${pays !== null ? fmtRefOnly(pays) : '—'}.`;
  let status: string;
  if (listWins) {
    status = hasTyped ? 'Newer than the values typed below, so it replaces them.' : 'No values are typed below, so these are used.';
    // The list lacks a price the typed values have: that one is still the typed one.
    if (src.pays === 'settings') status += ' What scrap.tf pays for a key still comes from the value typed below.';
    if (src.sells === 'settings') status += ' What scrap.tf charges for a key still comes from the value typed below.';
  } else if (fromList > 0) {
    status = `The values typed below are newer, but none says what scrap.tf ${src.pays === 'list' ? 'pays' : 'charges'} for a key, so that comes from this list.`;
  } else {
    status = 'The values typed below are newer, so they are used instead.';
  }
  // Only what scrap.tf pays caps the key value, and only the automatic one.
  if (src.pays === 'list') status += typed.mode === 'auto' ? ' What scrap.tf pays caps the automatic key price.' : ' In Manual mode your own key price is used as typed.';
  return {
    text,
    title: `Read from the Mann Co. Supply Crate Key row of the scrap.tf/items page you saved ${fmtDateTime(list.observedAt)}. ${SCRAPTF_BOUNDARY_SHORT}`,
    inUse: fromList > 0,
    pill,
    status,
  };
}
