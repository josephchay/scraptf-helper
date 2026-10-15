// Client-side checks for Settings fields. Each one matches what main's
// settings schema accepts, so a value that passes here is never rejected
// there (a rejected value would otherwise look saved). Pure: unit tested.

import { isReservedAccelerator, isValidAccelerator } from '../shared/accelerator';
import type { InputKind } from '../shared/types';
import { isValidContactUrl } from './format';

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

export function holdingsNotifyHint(notificationsOn: boolean): string {
  const base =
    'For items in Holdings (journal buys not sold yet): a backpack.tf buyer pays enough over your cost to clear your profit thresholds. Uses the minimum confidence and repeat time above.';
  return notificationsOn ? base : `Desktop notifications are off, so this shows nothing until they are on. ${base}`;
}

export const HOTKEY_HINT_ERROR = 'Needs Ctrl, Alt or Win plus a key (an F-key works alone), e.g. CommandOrControl+Alt+F. Leave it empty to turn the shortcut off.';

/** Empty turns the global shortcut off, as main and the schema allow. */
export function validateHotkey(v: string): string | null {
  const t = v.trim();
  if (isValidAccelerator(t)) return null;
  if (isReservedAccelerator(t)) return 'That is a system or everyday shortcut; a global hotkey would take it from every app. Pick another.';
  return HOTKEY_HINT_ERROR;
}

export const CONTACT_ERROR = 'Use an https:// address or mailto:, in plain ASCII without spaces or parentheses, at most 200 characters.';

export function validateContactUrl(v: string): string | null {
  return !v.trim() || isValidContactUrl(v) ? null : CONTACT_ERROR;
}

/** What the service sends (src/service/net/http.ts buildUserAgent) for a saved contact. */
export function userAgentPreview(version: string, contactUrl: string): string {
  return `TF2FlipDesk/${version} (+${contactUrl.trim() || 'no-contact-set'})`;
}
