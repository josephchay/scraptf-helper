// Client-side checks for Settings fields. Each one matches what main's
// settings schema accepts, so a value that passes here is never rejected
// there (a rejected value would otherwise look saved). Pure: unit tested.

import { isReservedAccelerator, isValidAccelerator } from '../shared/accelerator';
import { isValidContactUrl } from './format';

export function numberValidator(min: number, max: number, allowEmpty = false) {
  return (v: string): string | null => {
    if (allowEmpty && v.trim() === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return 'Enter a number.';
    if (n < min || n > max) return `Between ${min} and ${max}.`;
    return null;
  };
}

/** Percent bounds of the profit fields; the schema stores fractions (minMargin 0..1, minProfitPctOfCost 0..10). */
export const MIN_MARGIN_PCT = { min: 0, max: 100 } as const;
export const MIN_PROFIT_PCT_OF_COST = { min: 0, max: 100 } as const;

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
