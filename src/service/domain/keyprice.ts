// Key price used to value keys received from backpack.tf buyers (design brief §5.3).

import type { KeyPriceQuote, KeyPriceSource, KeyPriceState, Scrap, ScraptfListKey, Settings, UnixMs } from '../../shared/types';

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

/** scrap.tf's key prices in effect, and where they come from. */
export interface ScraptfKeyPrices {
  /** What scrap.tf pays for a key; caps the automatic key value. */
  paysScrap: Scrap | null;
  /** What scrap.tf charges for a key (display only). */
  sellsScrap: Scrap | null;
  /** 'list' when the saved scrap.tf/items key row is newer than the typed values (F14). */
  source: 'settings' | 'list' | null;
}

/**
 * The newer of the typed scrap.tf key prices (settings.keyPrice.scraptfSellScrap = what scrap.tf pays,
 * scraptfBuyScrap = what it charges, dated scraptfObservedAt) and the saved list's key row (dated by
 * its observedAt). Typed values without a date count as older than any saved list. A value the newer
 * source lacks comes from the other one.
 */
export function effectiveScraptfKey(settings: Settings, listKey?: ScraptfListKey | null): ScraptfKeyPrices {
  const typedPays = sane(settings.keyPrice?.scraptfSellScrap);
  const typedSells = sane(settings.keyPrice?.scraptfBuyScrap);
  const typedAt = settings.keyPrice?.scraptfObservedAt;
  const listPays = sane(listKey?.paysScrap);
  const listSells = sane(listKey?.sellsScrap);
  const hasList = listKey !== null && listKey !== undefined && (listPays !== null || listSells !== null) && Number.isFinite(listKey.observedAt);
  const hasTyped = typedPays !== null || typedSells !== null;
  if (hasList && (!hasTyped || typeof typedAt !== 'number' || !Number.isFinite(typedAt) || listKey.observedAt > typedAt)) {
    return { paysScrap: listPays ?? typedPays, sellsScrap: listSells ?? typedSells, source: 'list' };
  }
  if (hasTyped) return { paysScrap: typedPays ?? listPays, sellsScrap: typedSells ?? listSells, source: 'settings' };
  return { paysScrap: null, sellsScrap: null, source: null };
}

/**
 * Brief §5.3 "conservative default": an automatic value is capped by what scrap.tf pays for a key
 * (typed, or from the saved list when that is newer), so keys received from buyers are never valued
 * above what the user can actually get for them. Manual values are taken as given.
 */
function capByScraptfPays(v: number, cap: Scrap | null): number {
  return cap !== null && cap < v ? cap : v;
}

/**
 * KeyPriceState.scraptfFromList: the list key row with only the values effectiveScraptfKey would use,
 * so Settings never shows (or calls "in use") a price the cap ignores. Null when none is left.
 */
function shownListKey(listKey: ScraptfListKey | null | undefined): ScraptfListKey | null {
  if (!listKey || typeof listKey.observedAt !== 'number' || !Number.isFinite(listKey.observedAt)) return null;
  const paysScrap = sane(listKey.paysScrap);
  const sellsScrap = sane(listKey.sellsScrap);
  return paysScrap === null && sellsScrap === null ? null : { paysScrap, sellsScrap, observedAt: listKey.observedAt };
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

export function defaultKeyPrice(quotes: KeyPriceQuote[] = [], scraptfFromList: ScraptfListKey | null = null): KeyPriceState {
  return { valueScrap: DEFAULT_KEY_SCRAP, source: 'default', observedAt: null, stale: true, quotes, scraptfFromList };
}

/**
 * Manual mode with a value wins. Otherwise the first fresh source in priority
 * order (backpack.tf, then PriceDB); if every source is stale, the most recent
 * one, marked stale; then a remembered manual value (stale); and if there is
 * nothing at all, 60 ref marked as the default. Automatic (backpack.tf /
 * PriceDB) values are capped by what scrap.tf pays for a key (effectiveScraptfKey).
 * `listKey` is the saved scrap.tf/items key row (F14); without it nothing changes.
 */
export function selectKeyPrice(quotes: KeyPriceQuote[], settings: Settings, now: UnixMs, listKey: ScraptfListKey | null = null): KeyPriceState {
  const valid = validQuotes(quotes);
  const shown = [...valid].sort((a, b) => DISPLAY_ORDER.indexOf(a.source) - DISPLAY_ORDER.indexOf(b.source) || b.observedAt - a.observedAt);
  const scraptfFromList = shownListKey(listKey);
  const cap = effectiveScraptfKey(settings, listKey).paysScrap;

  const manualQuote = valid.filter((x) => x.source === 'manual').sort((a, b) => b.observedAt - a.observedAt)[0] ?? null;
  const manual = sane(settings.keyPrice?.manualScrap) ?? (manualQuote ? quoteValue(manualQuote) : null);
  if (settings.keyPrice?.mode === 'manual' && manual !== null) {
    return { valueScrap: manual, source: 'manual', observedAt: manualQuote?.observedAt ?? null, stale: false, quotes: shown, scraptfFromList };
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
  if (fresh) {
    return { valueScrap: capByScraptfPays(fresh.v, cap), source: fresh.q.source, observedAt: fresh.q.observedAt, stale: false, quotes: shown, scraptfFromList };
  }

  const latest = [...candidates].sort((a, b) => b.q.observedAt - a.q.observedAt)[0];
  if (latest) {
    return { valueScrap: capByScraptfPays(latest.v, cap), source: latest.q.source, observedAt: latest.q.observedAt, stale: true, quotes: shown, scraptfFromList };
  }

  // Brief §5.3 lists the user override last; it still beats a made-up default.
  if (manual !== null) return { valueScrap: manual, source: 'manual', observedAt: manualQuote?.observedAt ?? null, stale: true, quotes: shown, scraptfFromList };

  return defaultKeyPrice(shown, scraptfFromList);
}
