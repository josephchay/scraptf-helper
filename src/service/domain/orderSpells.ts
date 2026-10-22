// 0.9 (history, RESEARCH #6): follows buy orders of watched, held and scrap.tf-priced items' top orders on the live
// feed and writes their spells (order_spells): storage only, from batches already arriving; no request of its own.
// The listing id (which holds the buyer's SteamID) is a key of this module's memory only, never written.
//
// A spell is one order at one price (H1-H5). It opens on a feed update of a followed-worthy order (orderSpellFollows)
// and ends 'lowered' / 'raised' on an update at another price, 'deleted' / 'inactive' on a feed delete or inactive
// report held for ORDER_SPELL_RELIST_GRACE_MS and at least one status tick ('relisted' when the same id comes back at
// the same or a higher price in that time), and 'unwatched' (censored) wherever Flip Desk stopped seeing the feed: a
// new epoch (reconnect, buffer-limit-exceeded), the status tick seeing the feed not live, a clock moved back, the app
// stopping, or a crash (start() ends what it left). Gaps are never filled.

import { ORDER_SPELL_OPEN_MAX, ORDER_SPELL_RELIST_GRACE_MS, ORDER_SPELL_TOUCH_MS, orderSpellEndOf, orderSpellFollows } from '../../shared/orderPersistence';
import type { Scrap, UnixMs } from '../../shared/types';
import type { FeedBatch, Logger, Repo } from '../contracts';

const DAY_MS = 24 * 60 * 60_000;

/** What the tracker reads and writes: order_spells only, the engine's key price and the Live market's top order per base. */
export interface OrderSpellTrackerDeps {
  repo: Pick<Repo, 'transaction' | 'insertOrderSpell' | 'endOrderSpell' | 'touchOpenOrderSpells' | 'endOpenOrderSpells'>;
  log: Logger;
  /** The engine's key price (scrap; 0 or less: unknown). */
  keyScrap(): Scrap;
  /** The base's top non-outlier order now (core: market.entryFor(base)?.consScrap ?? …bestScrap ?? null). */
  topOf(base: string): Scrap | null;
}

/** 0.9 (history): core's buy-order spell tracker (createOrderSpellTracker); every call is storage only and never throws. */
export interface OrderSpellTracker {
  /** Rows a crash left followed end 'unwatched' at their last_seen_at (core.start, before the feed). */
  start(): void;
  /** core.onBatch, after the book write: ends and opens spells from this batch (`tracked`: core's watchedBookSet()). */
  onBatch(b: Pick<FeedBatch, 'upserts' | 'deletes'> & Partial<Pick<FeedBatch, 'inactive' | 'epoch'>>, tracked: ReadonlySet<string>, now: UnixMs): void;
  /** The status tick: not live ends every followed spell 'unwatched' at the stream's last batch; live writes last_seen_at every ORDER_SPELL_TOUCH_MS. */
  tick(live: boolean, now: UnixMs): void;
  /** core.stop (after socket.stop): ends every followed spell 'unwatched'. */
  stop(): void;
  /** Orders followed now (tests). */
  following(): number;
}

/** A followed order's spell: its row and the raw price it is at. */
interface Followed {
  rowId: number;
  keys: number;
  metalScrap: Scrap;
}

/** A followed order whose delete or inactive report waits out the relist grace (H2, review). */
interface Held extends Followed {
  at: UnixMs;
  kind: 'deleted' | 'inactive';
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * The buy-order spell tracker (H1-H5). Never throws into the feed: a failed write is logged once per failure streak,
 * forgets what it followed and marks the rows dirty, and the next batch ends them 'unwatched' before following again.
 */
export function createOrderSpellTracker(deps: OrderSpellTrackerDeps): OrderSpellTracker {
  const { repo, log } = deps;
  /** Listing id -> its followed spell. Memory only: the id is never written. */
  const open = new Map<string, Followed>();
  /** Listing id -> a followed spell whose delete or inactive report is held for the relist grace. Memory only. */
  const held = new Map<string, Held>();
  /** Spells inserted since the last daily log line (review: the real churn sets the effective retention). */
  let writtenToday = 0;
  let dayStart: UnixMs | null = null;
  let epoch: number | null = null;
  /** The stream's newest batch. */
  let lastAt: UnixMs | null = null;
  let touchedAt: UnixMs | null = null;
  let failing = false;
  /** A failed write may have left rows followed that memory no longer knows. */
  let dirty = false;
  let capped = false;

  function fail(err: unknown): void {
    if (!failing) log.warn('Could not record how long buy orders stay', { error: String(err) });
    failing = true;
    open.clear();
    dirty = true;
  }

  function keyScrapNow(): Scrap {
    try {
      const k = deps.keyScrap();
      return finite(k) && k > 0 ? k : 0;
    } catch {
      return 0;
    }
  }

  function topNow(base: string): Scrap | null {
    try {
      const t = deps.topOf(base);
      return finite(t) ? t : null;
    } catch {
      return null;
    }
  }

  /**
   * Every followed spell ends 'unwatched' (censored): a held one at its delete (its grace was not watched to the end),
   * the rest at the stream's last batch.
   */
  function endAll(): void {
    if (open.size === 0 && held.size === 0 && !dirty) return;
    repo.transaction(() => {
      for (const h of held.values()) repo.endOrderSpell(h.rowId, h.at, 'unwatched');
      if (lastAt !== null) repo.touchOpenOrderSpells(lastAt);
      repo.endOpenOrderSpells();
    });
    open.clear();
    held.clear();
    dirty = false;
    touchedAt = null;
  }

  /** H2: a held delete or inactive report whose grace has passed ends at the delete's own time. */
  function settleHeld(now: UnixMs): void {
    const due = [...held].filter(([, h]) => now - h.at >= ORDER_SPELL_RELIST_GRACE_MS);
    if (due.length === 0) return;
    repo.transaction(() => {
      for (const [, h] of due) repo.endOrderSpell(h.rowId, h.at, h.kind);
    });
    for (const [id] of due) held.delete(id);
  }

  return {
    start() {
      try {
        repo.endOpenOrderSpells();
      } catch (err) {
        fail(err);
      }
    },

    onBatch(b, tracked, now) {
      if (!finite(now)) return;
      try {
        if (dirty) endAll();
        // H3: a new stream; what the old one followed was last seen at its last batch.
        if (b.epoch !== undefined && b.epoch !== epoch) {
          if (epoch !== null) endAll();
          epoch = b.epoch;
        }
        // A clock moved back cannot measure durations.
        if (lastAt !== null && now < lastAt) endAll();
        lastAt = now;
        const K = keyScrapNow();
        const inactive = new Set(b.inactive ?? []);
        const deletes = b.deletes.filter((id) => open.has(id));
        // R-3: only buy updates that can end or open a spell (followed, held, or of a tracked base) open a transaction.
        const buys = b.upserts.filter((l) => l.intent === 'buy' && (open.has(l.id) || held.has(l.id) || tracked.has(l.baseSku)));
        if (deletes.length === 0 && buys.length === 0) {
          failing = false;
          return;
        }
        repo.transaction(() => {
          // H2 (review): a delete or inactive report is held, not ended: a bot relists under the same id seconds later.
          for (const id of deletes) {
            const f = open.get(id);
            if (!f) continue;
            open.delete(id);
            held.set(id, { ...f, at: now, kind: inactive.has(id) ? 'inactive' : 'deleted' });
          }
          for (const l of buys) {
            const h = held.get(l.id);
            if (h) {
              // Back inside the grace: at the same or a higher price it never left (censored at the delete); lower, it was lowered.
              repo.endOrderSpell(h.rowId, h.at, orderSpellEndOf(h, l, K) === 'lowered' ? 'lowered' : 'relisted');
              held.delete(l.id);
            }
            const f = open.get(l.id);
            if (f) {
              const end = orderSpellEndOf(f, l, K);
              // A new listedAt or a bump at the same price continues the spell.
              if (end === 'same') continue;
              repo.endOrderSpell(f.rowId, now, end);
              open.delete(l.id);
            }
            if (!tracked.has(l.baseSku)) continue;
            if (!orderSpellFollows(l, topNow(l.baseSku), K)) continue;
            if (open.size >= ORDER_SPELL_OPEN_MAX) {
              if (!capped) log.info('Buy-order persistence follows at most 20,000 orders at once; more are not followed.');
              capped = true;
              continue;
            }
            const rowId = repo.insertOrderSpell({
              baseSku: l.baseSku,
              intent: 'buy',
              isBot: l.isBot,
              keys: l.keys,
              metalScrap: l.metalScrap,
              listedAt: l.listedAt,
              firstSeenAt: now,
              lastSeenAt: now,
              endAt: null,
              endKind: null,
            });
            open.set(l.id, { rowId, keys: l.keys, metalScrap: l.metalScrap });
            writtenToday++;
          }
        });
        failing = false;
      } catch (err) {
        fail(err);
      }
    },

    tick(live, now) {
      if (!finite(now)) return;
      try {
        if (!live) {
          endAll();
          epoch = null;
          lastAt = null;
        } else {
          // The first tick at least the grace after a held delete settles it, so the grace always spans a tick.
          settleHeld(now);
          if (open.size > 0 && lastAt !== null && (touchedAt === null || now - touchedAt >= ORDER_SPELL_TOUCH_MS)) {
            // Review: a held row was reported gone at h.at; touching it past that would let a crash in the grace censor
            // it after its delete.
            repo.touchOpenOrderSpells(
              lastAt,
              [...held.values()].map((h) => h.rowId),
            );
            touchedAt = now;
          }
        }
      } catch (err) {
        fail(err);
      }
      if (dayStart === null || now < dayStart) dayStart = now;
      else if (now - dayStart >= DAY_MS) {
        log.info(`Buy-order persistence: ${writtenToday} spells written in the last day, ${open.size} followed now`);
        writtenToday = 0;
        dayStart = now;
      }
    },

    stop() {
      try {
        endAll();
      } catch (err) {
        fail(err);
      }
      epoch = null;
    },

    following() {
      return open.size;
    },
  };
}
