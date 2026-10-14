// Key price used to value keys received from backpack.tf buyers (design brief §5.3).

import type { KeyPriceQuote, KeyPriceSource, KeyPriceState, Settings, UnixMs } from '../../shared/types';

/** A source is stale after 6 h. */
export const KEY_PRICE_STALE_MS = 6 * 60 * 60 * 1000;
/** Clearly marked fallback when no source has a value: 60 ref. */
export const DEFAULT_KEY_SCRAP = 540;
/** Anything outside 2 ref .. 2000 ref is a broken quote, not a key price. */
const MIN_SANE_SCRAP = 18;
const MAX_SANE_SCRAP = 18_000;

/** Automatic sources in priority order. */
const AUTO_ORDER: readonly KeyPriceSource[] = ['bptf', 'pricedb'];
const DISPLAY_ORDER: readonly KeyPriceSource[] = ['bptf', 'pricedb', 'manual'];

function sane(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= MIN_SANE_SCRAP && v <= MAX_SANE_SCRAP ? Math.round(v) : null;
}

/**
 * Brief §5.3 "conservative default": an automatic value is capped by the
 * user's scrap.tf key sell price (what scrap.tf pays for a key) when one is
 * entered, so keys received from buyers are never valued above what the user
 * can actually get for them. Manual values are taken as given.
 */
function capByScraptfSell(v: number, settings: Settings): number {
  const cap = sane(settings.keyPrice?.scraptfSellScrap);
  return cap !== null && cap < v ? cap : v;
}

/** Buy side first: keys we receive from buyers are worth what buyers pay for keys. */
function quoteValue(q: KeyPriceQuote): number | null {
  return sane(q.buyScrap) ?? sane(q.sellScrap);
}

function validQuotes(quotes: readonly KeyPriceQuote[]): KeyPriceQuote[] {
  if (!Array.isArray(quotes)) return [];
  return quotes.filter(
    (q): q is KeyPriceQuote =>
      q !== null && typeof q === 'object' && DISPLAY_ORDER.includes(q.source) && Number.isFinite(q.observedAt),
  );
}

export function isQuoteStale(q: Pick<KeyPriceQuote, 'observedAt'>, now: UnixMs): boolean {
  return !Number.isFinite(q.observedAt) || now - q.observedAt > KEY_PRICE_STALE_MS;
}

export function defaultKeyPrice(quotes: KeyPriceQuote[] = []): KeyPriceState {
  return { valueScrap: DEFAULT_KEY_SCRAP, source: 'default', observedAt: null, stale: true, quotes };
}

/**
 * Manual mode with a value wins. Otherwise the first fresh source in priority
 * order (backpack.tf, then PriceDB); if every source is stale, the most recent
 * one, marked stale; then a remembered manual value (stale); and if there is
 * nothing at all, 60 ref marked as the default. Automatic (backpack.tf /
 * PriceDB) values are capped by the user's scrap.tf key sell price if entered.
 */
export function selectKeyPrice(quotes: KeyPriceQuote[], settings: Settings, now: UnixMs): KeyPriceState {
  const valid = validQuotes(quotes);
  const shown = [...valid].sort((a, b) => DISPLAY_ORDER.indexOf(a.source) - DISPLAY_ORDER.indexOf(b.source) || b.observedAt - a.observedAt);

  const manualQuote = valid.filter((x) => x.source === 'manual').sort((a, b) => b.observedAt - a.observedAt)[0] ?? null;
  const manual = sane(settings.keyPrice?.manualScrap) ?? (manualQuote ? quoteValue(manualQuote) : null);
  if (settings.keyPrice?.mode === 'manual' && manual !== null) {
    return { valueScrap: manual, source: 'manual', observedAt: manualQuote?.observedAt ?? null, stale: false, quotes: shown };
  }

  const candidates = AUTO_ORDER.flatMap((source) =>
    valid
      .filter((q) => q.source === source)
      .sort((a, b) => b.observedAt - a.observedAt)
      .slice(0, 1)
      .flatMap((q) => {
        const v = quoteValue(q);
        return v === null ? [] : [{ q, v }];
      }),
  );

  const fresh = candidates.find((c) => !isQuoteStale(c.q, now));
  if (fresh) return { valueScrap: capByScraptfSell(fresh.v, settings), source: fresh.q.source, observedAt: fresh.q.observedAt, stale: false, quotes: shown };

  const latest = [...candidates].sort((a, b) => b.q.observedAt - a.q.observedAt)[0];
  if (latest) return { valueScrap: capByScraptfSell(latest.v, settings), source: latest.q.source, observedAt: latest.q.observedAt, stale: true, quotes: shown };

  // Brief §5.3 lists the user override last; it still beats a made-up default.
  if (manual !== null) return { valueScrap: manual, source: 'manual', observedAt: manualQuote?.observedAt ?? null, stale: true, quotes: shown };

  return defaultKeyPrice(shown);
}
