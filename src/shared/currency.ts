// Money helpers. All amounts are integer scrap (1 ref = 9 scrap); keys are
// converted with an explicit key price so callers always know which one is used.

import type { Scrap } from './types';

export const SCRAP_PER_REF = 9;

/** Refined (as written by traders, e.g. 1.33 or 63.11) to integer scrap. */
export function refToScrap(ref: number): Scrap {
  if (!Number.isFinite(ref)) return 0;
  return Math.round(ref * SCRAP_PER_REF);
}

/** Integer scrap to the traders' refined notation: 12 -> 1.33, 15 -> 1.66. */
export function scrapToRef(scrap: Scrap): number {
  const sign = scrap < 0 ? -1 : 1;
  const s = Math.abs(Math.round(scrap));
  const whole = Math.floor(s / SCRAP_PER_REF);
  const rest = s % SCRAP_PER_REF;
  return sign * Number((whole + rest * 0.11).toFixed(2));
}

export function formatRef(scrap: Scrap): string {
  return `${scrapToRef(scrap).toFixed(2)} ref`;
}

/** keys + metal valued in scrap with key price `keyScrap`. */
export function valueScrap(keys: number, metalScrap: Scrap, keyScrap: Scrap): Scrap {
  return Math.round((keys || 0) * keyScrap) + (metalScrap || 0);
}

/** Splits a scrap total into whole keys plus remaining scrap for display. */
export function splitKeys(total: Scrap, keyScrap: Scrap): { keys: number; scrap: Scrap } {
  if (!keyScrap || keyScrap <= 0 || Math.abs(total) < keyScrap) return { keys: 0, scrap: total };
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const keys = Math.floor(abs / keyScrap);
  return { keys: sign * keys, scrap: sign * (abs - keys * keyScrap) };
}

/**
 * "2 keys 5.11 ref", "5.11 ref", "-1.33 ref". When keyScrap is null or the
 * amount is below one key, only refined is shown.
 */
export function formatScrap(total: Scrap | null | undefined, keyScrap: Scrap | null = null): string {
  if (total === null || total === undefined || !Number.isFinite(total)) return '—';
  if (!keyScrap) return formatRef(total);
  const { keys, scrap } = splitKeys(total, keyScrap);
  if (keys === 0) return formatRef(scrap);
  const sign = total < 0 ? '-' : '';
  const k = Math.abs(keys);
  const r = Math.abs(scrap);
  return r === 0 ? `${sign}${k} key${k === 1 ? '' : 's'}` : `${sign}${k} key${k === 1 ? '' : 's'} ${formatRef(r)}`;
}

/** Formats an explicit keys + metal pair without converting keys. */
export function formatKeysMetal(keys: number, metalScrap: Scrap): string {
  const parts: string[] = [];
  if (keys) parts.push(`${Number(keys.toFixed(2))} key${keys === 1 ? '' : 's'}`);
  if (metalScrap || !keys) parts.push(formatRef(metalScrap));
  return parts.join(' ');
}

export interface ParsedPrice {
  keys: number;
  scrap: Scrap;
  /** Normalised text, e.g. "2 keys 5.11 ref". */
  display: string;
  /** True when a bare number was interpreted with the default unit. */
  ambiguous: boolean;
}

/**
 * Parses prices as traders type them:
 *   "12" (bare -> bareUnit), "1.33", "1.33 ref", "14 scrap", "14s", "3 rec",
 *   "2 keys", "2k", "2 keys 5.11", "2k 5.11 ref", "1 key, 2.33ref", "1.5 keys".
 * Returns null when nothing sensible can be parsed.
 */
export function parsePrice(text: string, bareUnit: 'ref' | 'scrap' | 'keys' = 'ref'): ParsedPrice | null {
  const t = String(text ?? '')
    .toLowerCase()
    // "1,200 keys", "4,583.41 ref": a comma before exactly three digits groups thousands.
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
    // "1,5 keys" is a decimal comma; "1 key, 2.33 ref" is a separator.
    .replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  // Two numbers with no unit between them ("2 000 keys", "1, 5 keys") are
  // ambiguous; reading the first as trailing refined would silently corrupt it.
  if (/\d \.?\d/.test(t)) return null;
  // Negative prices are never valid input.
  if (/(^|[^a-z0-9.])-\s*\.?\d/.test(t)) return null;

  let keys = 0;
  let scrap = 0;
  let matched = false;
  let rest = t;

  const take = (re: RegExp, fn: (n: number) => void) => {
    const m = rest.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) {
        fn(n);
        matched = true;
        rest = (rest.slice(0, m.index) + ' ' + rest.slice((m.index ?? 0) + m[0].length)).trim();
      }
    }
  };

  const NUM = String.raw`(\d*\.?\d+)`;
  take(new RegExp(`${NUM}\\s*(?:keys?|k)\\b`), (n) => (keys += n));
  take(new RegExp(`${NUM}\\s*(?:refined|ref|r)\\b`), (n) => (scrap += refToScrap(n)));
  take(new RegExp(`${NUM}\\s*(?:reclaimed|rec)\\b`), (n) => (scrap += Math.round(n * 3)));
  take(new RegExp(`${NUM}\\s*(?:scrap|s)\\b`), (n) => (scrap += Math.round(n)));

  let ambiguous = false;
  const bare = rest.match(/^(\d*\.?\d+)$/);
  if (bare) {
    const n = Number(bare[1]);
    if (matched) {
      // "2 keys 5.11": a trailing bare number after keys is refined.
      scrap += refToScrap(n);
    } else if (bareUnit === 'scrap') {
      scrap += Math.round(n);
      ambiguous = true;
    } else if (bareUnit === 'keys') {
      keys += n;
      ambiguous = true;
    } else {
      scrap += refToScrap(n);
      ambiguous = !String(bare[1]).includes('.');
    }
    matched = true;
    rest = '';
  }

  if (!matched || rest.replace(/[^a-z0-9.-]/g, '') !== '') return null;
  if (keys < 0 || scrap < 0) return null;
  return { keys, scrap, display: formatKeysMetal(keys, scrap), ambiguous };
}
