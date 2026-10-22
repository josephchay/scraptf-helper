// 0.8 (H1): the recorded exit runs of held and watched items (holding_marks, schema V15). Writes only what a
// Holdings check or its heartbeat already computed from the local book, the kept sell listings and the in-memory
// saved scrap.tf list, and only while the backpack.tf live feed is up: a gap in the record means "not watched",
// and nothing ever fills one in. No network, no request of its own.
//
// A run is one set of prices seen without a break: a price change, a silence over HOLDING_MARK_GAP_MS, a feed
// restart or a clock moved back starts the next one. The buyer and ask counts are kept as a run's latest seen,
// never a reason for a new run (HOLDING_MARK_VALUE_KEYS). to_at is written at most every HOLDING_MARK_EXTEND_MS.

import { HOLDING_MARK_GAP_MS, HOLDING_MARK_VALUE_KEYS, sameHoldingMarkValues } from '../../shared/holdingAdvice';
import type { HoldingMark, HoldingMarkValues, Scrap, UnixMs } from '../../shared/types';
import type { Logger, Repo } from '../contracts';

/** to_at is written at most this often per run. */
export const HOLDING_MARK_EXTEND_MS = 10 * 60_000;
/** Holdings re-records every held and watched base this often while recording (the heartbeat). */
export const HOLDING_MARK_HEARTBEAT_MS = 30 * 60_000;

export interface MarkRecorderDeps {
  repo: Pick<Repo, 'transaction' | 'latestHoldingMarks' | 'insertHoldingMark' | 'extendHoldingMark'>;
  log: Logger;
}

export interface MarkRecorder {
  /**
   * Records what one check saw at `now` (raw values per base). liveSince null: writes and extends nothing. keyScrap is
   * the engine's key price, null when unknown (stored as NULL, never a default). Returns the runs inserted or extended.
   */
  record(seen: ReadonlyMap<string, HoldingMarkValues>, now: UnixMs, liveSince: UnixMs | null, keyScrap: Scrap | null): HoldingMark[];
  /** Writes each open run's last sighting (Holdings.stop). */
  flush(): void;
  /** Forgets the cached newest runs; re-read on the next record. */
  reset(): void;
}

type Counts = Pick<HoldingMark, 'buyerCount' | 'verifiedBuyerCount' | 'askCount'>;

/** A base's newest run as stored, when it was last seen, and the latest counts seen in it. */
interface Open {
  mark: HoldingMark;
  lastSeenAt: UnixMs;
  counts: Counts;
  /** The latest counts are the stored ones. */
  countsWritten: boolean;
}

function countsOf(v: Counts): Counts {
  return { buyerCount: v.buyerCount, verifiedBuyerCount: v.verifiedBuyerCount, askCount: v.askCount };
}

/** Exactly the HoldingMarkValues fields of `v` (a caller may hand in a wider object). */
function valuesOf(v: HoldingMarkValues): HoldingMarkValues {
  const out = {} as Record<string, unknown>;
  for (const k of HOLDING_MARK_VALUE_KEYS) out[k] = v[k];
  return { ...(out as Omit<HoldingMarkValues, keyof Counts>), ...countsOf(v) };
}

function sameCounts(a: Counts, b: Counts): boolean {
  return a.buyerCount === b.buyerCount && a.verifiedBuyerCount === b.verifiedBuyerCount && a.askCount === b.askCount;
}

/**
 * The H1 writer. Per base: seen again within HOLDING_MARK_GAP_MS of its last sighting, while the feed has been live
 * since before it, at the same prices (sameHoldingMarkValues), the run goes on (to_at written every
 * HOLDING_MARK_EXTEND_MS with the latest counts); otherwise the old run is closed at its last sighting (never at
 * `now`) and a new run starts at `now`. A failure is logged once per streak and never thrown into the check.
 */
export function createMarkRecorder(deps: MarkRecorderDeps): MarkRecorder {
  const { repo, log } = deps;
  const open = new Map<string, Open>();
  let failing = false;

  function close(cur: Open): HoldingMark | null {
    if (!(cur.lastSeenAt > cur.mark.toAt) && cur.countsWritten) return null;
    const toAt = Math.max(cur.mark.toAt, cur.lastSeenAt);
    if (!repo.extendHoldingMark(cur.mark.id, toAt, cur.counts)) return null;
    cur.mark = { ...cur.mark, toAt, ...cur.counts };
    cur.countsWritten = true;
    return cur.mark;
  }

  function fail(err: unknown): void {
    // Once per failure streak, not once per check.
    if (!failing) log.warn('Holdings could not record exit prices', { error: String(err) });
    failing = true;
    open.clear();
  }

  return {
    record(seen, now, liveSince, keyScrap) {
      if (liveSince === null || !Number.isFinite(liveSince) || !Number.isFinite(now) || seen.size === 0) return [];
      const out: HoldingMark[] = [];
      try {
        const missing = [...seen.keys()].filter((b) => !open.has(b));
        if (missing.length > 0) {
          for (const [b, mark] of repo.latestHoldingMarks(missing)) open.set(b, { mark, lastSeenAt: mark.toAt, counts: countsOf(mark), countsWritten: true });
        }
        const K = typeof keyScrap === 'number' && Number.isFinite(keyScrap) && keyScrap > 0 ? keyScrap : null;
        repo.transaction(() => {
          for (const [baseSku, values] of seen) {
            let cur = open.get(baseSku);
            // A clock that moved back (now < lastSeenAt), a silence over the gap, or a feed that came back since the
            // last sighting all start a new run.
            const contiguous = cur !== undefined && cur.lastSeenAt >= liveSince && now >= cur.lastSeenAt && now - cur.lastSeenAt <= HOLDING_MARK_GAP_MS;
            if (cur && contiguous && sameHoldingMarkValues(cur.mark, values)) {
              cur.lastSeenAt = now;
              const counts = countsOf(values);
              if (!sameCounts(counts, cur.counts)) {
                cur.counts = counts;
                cur.countsWritten = false;
              }
              if (now - cur.mark.toAt < HOLDING_MARK_EXTEND_MS) continue;
              if (repo.extendHoldingMark(cur.mark.id, now, cur.counts)) {
                cur.mark = { ...cur.mark, toAt: Math.max(cur.mark.toAt, now), ...cur.counts };
                cur.countsWritten = true;
                out.push(cur.mark);
                continue;
              }
              // Pruned under us: a new run takes its place.
              open.delete(baseSku);
              cur = undefined;
            }
            if (cur) {
              const closed = close(cur);
              if (closed) out.push(closed);
            }
            const row: Omit<HoldingMark, 'id'> = { baseSku, fromAt: now, toAt: now, keyScrap: K, ...valuesOf(values) };
            const mark: HoldingMark = { id: repo.insertHoldingMark(row), ...row };
            open.set(baseSku, { mark, lastSeenAt: now, counts: countsOf(values), countsWritten: true });
            out.push(mark);
          }
        });
        failing = false;
        return out;
      } catch (err) {
        fail(err);
        return [];
      }
    },

    flush() {
      if (open.size === 0) return;
      try {
        repo.transaction(() => {
          for (const cur of open.values()) close(cur);
        });
      } catch (err) {
        fail(err);
      }
    },

    reset() {
      open.clear();
    },
  };
}
