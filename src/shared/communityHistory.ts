// 0.9 (history, RESEARCH #7): backpack.tf community prices Flip Desk saw replaced (IGetPrices) or reported (the live
// feed), kept as history. Community prices are bp.tf's accepted price suggestions, never sales. Storage only.
//
// Nothing here is a reference: bptf_community is still overwritten as before and the engine never reads the history.
// The same rules serve the service (the prices job, the feed recorder, 'item.bookHistory'), the renderer and the mock.

import { refToScrap } from './currency';
import type { CommunityHistory, CommunityHistoryStep, CommunityPoint, CommunityPointSource, CommunityRow, Scrap, UnixMs } from './types';

const DAY_MS = 86_400_000;
/** Retention: a recorded point older than this by recorded_at goes (Repo.pruneCommunityHistory). */
export const COMMUNITY_HISTORY_MAX_AGE_MS = 365 * DAY_MS; // by recorded_at
/** Retention: at most this many points per SKU. */
export const COMMUNITY_HISTORY_PER_SKU_MAX = 200; // newest by recorded_at, then id
/** Retention: at most this many points in all. */
export const COMMUNITY_HISTORY_MAX_ROWS = 300_000; // whole table, newest kept
/** 'item.bookHistory' reads at most this many points (every book base together); also CommunityHistory.steps' cap. */
export const COMMUNITY_HISTORY_DETAIL_MAX = 200;
/** A stored currency text is lower case and at most this long. */
export const COMMUNITY_CURRENCY_MAX = 16;
/** The feed recorder's per-SKU memo is cleared past this size (the unique index keeps the table right). */
export const COMMUNITY_FEED_MEMO_MAX = 20_000;
/** The drawer's note under the community price chart: what the history is, and where it came from. */
export const COMMUNITY_NOTE =
  "Community prices are backpack.tf's accepted price suggestions, not sales. Recorded from Flip Desk's backpack.tf price updates and, for items you price, hold or watch, the live feed.";

type PriceFields = Pick<CommunityRow, 'currency' | 'value' | 'valueHigh' | 'lastUpdate'>;

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** The stored spelling of a currency: lower case, trimmed, at most COMMUNITY_CURRENCY_MAX ('metal' when empty). */
function currencyOf(c: unknown): string {
  return (String(c || 'metal').trim().toLowerCase() || 'metal').slice(0, COMMUNITY_CURRENCY_MAX);
}

function finiteOrNull(v: unknown): number | null {
  return finite(v) ? v : null;
}

/**
 * A price's high end, or null when it has no range: a valueHigh that is missing, not finite, or equal to value. The
 * live feed always sends valueHigh (equal to value for a single price) where IGetPrices leaves value_high out, so the
 * same price keys, compares and stores the same from both sources.
 */
export function communityHighOf(p: Pick<PriceFields, 'value' | 'valueHigh'>): number | null {
  const high = finiteOrNull(p.valueHigh);
  return high === null || high === p.value ? null : high;
}

/** currency, value, valueHigh (communityHighOf: equal to value is none) and lastUpdate (null-safe) all equal. */
export function sameCommunityPrice(a: PriceFields, b: PriceFields): boolean {
  return (
    currencyOf(a.currency) === currencyOf(b.currency) &&
    a.value === b.value &&
    communityHighOf(a) === communityHighOf(b) &&
    finiteOrNull(a.lastUpdate) === finiteOrNull(b.lastUpdate)
  );
}

/** `${currency lower}|${value}|${communityHighOf ?? ''}|${lastUpdate ?? ''}`: one price, whatever its source or twin SKU. */
export function communityPointKey(p: PriceFields): string {
  return `${currencyOf(p.currency)}|${p.value}|${communityHighOf(p) ?? ''}|${finiteOrNull(p.lastUpdate) ?? ''}`;
}

/** pricing.ts's communityScrap, shared: value null / non-finite / <= 0 null; 'metal' refToScrap; 'keys' round(value * K) with K > 0; else null. */
export function communityValueScrap(currency: string, value: number | null, keyScrap: Scrap | null): Scrap | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  const c = typeof currency === 'string' ? currency.toLowerCase() : '';
  if (c === 'metal') return refToScrap(value);
  if (c === 'keys') return keyScrap !== null && Number.isFinite(keyScrap) && keyScrap > 0 ? Math.round(value * keyScrap) : null;
  return null;
}

/** One IGetPrices row as a history point (null for a row without a SKU or a finite value of 0 or more). */
function pricesPointOf(row: CommunityRow | null | undefined, recordedAt: UnixMs): CommunityPoint | null {
  if (!row || typeof row.sku !== 'string' || row.sku.trim() === '' || !finite(row.value) || row.value < 0) return null;
  return {
    sku: row.sku,
    source: 'prices',
    currency: currencyOf(row.currency),
    value: row.value,
    valueHigh: communityHighOf(row),
    lastUpdate: finiteOrNull(row.lastUpdate),
    recordedAt,
  };
}

/**
 * H7: IGetPrices rows -> history points (source 'prices', recordedAt = opts.recordedAt). Per incoming row with a SKU and
 * a finite value >= 0: unchanged against its stored row (sameCommunityPrice) gives none; changed gives [stored, incoming];
 * no stored row gives [incoming] on a delta only (a full fetch with nothing stored is the first fetch: no baseline yet).
 */
export function communityHistoryPointsOf(
  before: ReadonlyMap<string, CommunityRow>,
  incoming: readonly CommunityRow[],
  opts: { delta: boolean; recordedAt: UnixMs },
): CommunityPoint[] {
  const out: CommunityPoint[] = [];
  for (const row of incoming) {
    const next = pricesPointOf(row, opts.recordedAt);
    if (!next) continue;
    const stored = before.get(row.sku);
    if (stored) {
      if (sameCommunityPrice(stored, row)) continue;
      // The price this answer replaces, then the one replacing it (the unique index makes a repeat a no-op).
      const old = pricesPointOf({ ...stored, sku: row.sku }, opts.recordedAt);
      if (old) out.push(old);
      out.push(next);
    } else if (opts.delta) {
      out.push(next);
    }
  }
  return out;
}

/**
 * 'item.bookHistory''s community part: one step per communityPointKey over `points` (twin SKUs and both sources joined;
 * sources sorted, recordedAt min), plus `current` (sources ['prices'], recordedAt null) when its key is not there and it
 * has a lastUpdate; sorted by at, then recordedAt (null last); the newest COMMUNITY_HISTORY_DETAIL_MAX.
 */
export function communityHistoryOf(points: readonly CommunityPoint[], current: CommunityRow | null): CommunityHistory {
  const steps = new Map<string, CommunityHistoryStep>();
  let since: UnixMs | null = null;
  for (const p of points) {
    if (!p || !finite(p.value)) continue;
    const recordedAt = finite(p.recordedAt) ? p.recordedAt : null;
    if (recordedAt !== null && (since === null || recordedAt < since)) since = recordedAt;
    const key = communityPointKey(p);
    const source: CommunityPointSource = p.source === 'feed' ? 'feed' : 'prices';
    const had = steps.get(key);
    if (had) {
      if (!had.sources.includes(source)) had.sources = [...had.sources, source].sort();
      if (recordedAt !== null && (had.recordedAt === null || recordedAt < had.recordedAt)) {
        had.recordedAt = recordedAt;
        if (had.lastUpdate === null) had.at = recordedAt;
      }
      continue;
    }
    const lastUpdate = finiteOrNull(p.lastUpdate);
    steps.set(key, {
      at: lastUpdate !== null ? lastUpdate * 1000 : (recordedAt ?? 0),
      currency: currencyOf(p.currency),
      value: p.value,
      valueHigh: communityHighOf(p),
      lastUpdate,
      sources: [source],
      recordedAt,
    });
  }
  if (current && finite(current.value) && finite(current.lastUpdate)) {
    const key = communityPointKey(current);
    if (!steps.has(key)) {
      steps.set(key, {
        at: current.lastUpdate * 1000,
        currency: currencyOf(current.currency),
        value: current.value,
        valueHigh: communityHighOf(current),
        lastUpdate: current.lastUpdate,
        sources: ['prices'],
        recordedAt: null,
      });
    }
  }
  const sorted = [...steps.values()].sort(
    (a, b) => a.at - b.at || (a.recordedAt === null ? (b.recordedAt === null ? 0 : 1) : b.recordedAt === null ? -1 : a.recordedAt - b.recordedAt),
  );
  return { steps: sorted.slice(-COMMUNITY_HISTORY_DETAIL_MAX), since, recorded: points.length };
}
