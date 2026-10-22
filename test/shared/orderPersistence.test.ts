// 0.9 (history, RESEARCH #6): order persistence (src/shared/orderPersistence.ts). Spells of followed buy orders read by
// Kaplan-Meier with delayed entry: the worked example (computed by hist090/km.mjs), the observation edges, which orders
// are followed, the end kinds, the scope ladder, the summary, the drawer's read, and the review's capped-base check
// that selecting on entry (plus the per-base entry cut) keeps the estimate unbiased. Order persistence, never a fill
// rate. Pure.

import { describe, expect, it } from 'vitest';
import {
  BOOK_HISTORY_ORDERS_MAX,
  ORDER_PERSISTENCE_HORIZONS_MS,
  ORDER_PERSISTENCE_MIN_AT_RISK,
  ORDER_PERSISTENCE_MIN_AT_RISK_END,
  ORDER_PERSISTENCE_NOTE,
  ORDER_PERSISTENCE_VALUE_BAND,
  ORDER_SPELL_FOLLOW_SHARE,
  ORDER_SPELL_RELIST_GRACE_MS,
  ORDER_SPELLS_PER_BASE_MAX,
  itemBookHistoryOf,
  orderPersistenceOf,
  orderSpellEndOf,
  orderSpellFollows,
  orderSpellSummaryOf,
  persistenceWindowOf,
  spellObservationOf,
  spellsEntryCutOf,
  type SpellObservation,
} from '../../src/shared/orderPersistence';
import type { CommunityPoint, OrderSpell, OrderSpellEnd, PersistenceWindow } from '../../src/shared/types';

const H = 3_600_000;
const DAY = 24 * H;
const L = 1_790_000_000; // a listedAt (Unix s)
const ORIGIN = L * 1000;

const obsOf = (entryH: number, exitH: number, event: 0 | 1): SpellObservation => ({ entry: entryH * H, exit: exitH * H, event: event === 1, isBot: true, valueScrap: 100 });

/** hist090/km.mjs's twelve spells (hours; entry, exit, event). */
const KM = [
  obsOf(0, 10, 1), // A
  obsOf(0, 30, 0), // B
  obsOf(5, 20, 1), // C
  obsOf(2, 40, 1), // D
  obsOf(12, 50, 0), // E
  obsOf(1, 60, 0), // F
  obsOf(3, 26, 1), // G
  obsOf(4, 80, 0), // H
  obsOf(6, 36, 1), // I
  obsOf(8, 90, 0), // J
  obsOf(20, 70, 1), // K
  obsOf(24, 100, 0), // L
];

let seq = 0;
/** A spell of base 378;6 listed at L, entered and left at the given hours of age (metal only unless `keys`). */
function spell(entryH: number, exitH: number, endKind: OrderSpellEnd | null, over: Partial<OrderSpell> = {}): OrderSpell {
  seq++;
  return {
    id: seq,
    baseSku: '378;6',
    intent: 'buy',
    isBot: true,
    keys: 0,
    metalScrap: 100,
    listedAt: L,
    firstSeenAt: ORIGIN + entryH * H,
    lastSeenAt: ORIGIN + exitH * H,
    endAt: endKind === null ? null : ORIGIN + exitH * H,
    endKind,
    ...over,
  };
}

const isWindow = (w: unknown): w is PersistenceWindow => typeof w === 'object' && w !== null;

describe('the constants', () => {
  it('mirror the timing gates and the decided shares', () => {
    expect(ORDER_PERSISTENCE_MIN_AT_RISK).toBe(8);
    expect(ORDER_PERSISTENCE_MIN_AT_RISK_END).toBe(3);
    expect(ORDER_PERSISTENCE_VALUE_BAND).toBe(0.15);
    expect(ORDER_SPELL_FOLLOW_SHARE).toBe(0.7);
    expect(ORDER_SPELL_RELIST_GRACE_MS).toBe(60_000);
    expect(ORDER_PERSISTENCE_HORIZONS_MS).toEqual([H, DAY, 7 * DAY]);
    expect(ORDER_PERSISTENCE_NOTE).toMatch(/^Order persistence, not sales/);
    expect(ORDER_PERSISTENCE_NOTE).toMatch(/re-posts the same order within a minute is not counted as an end/);
    expect(ORDER_PERSISTENCE_NOTE).toMatch(/listing time, which a price edit need not reset/);
    expect(ORDER_PERSISTENCE_NOTE).not.toMatch(/fill rate|survival|probability/i);
  });
});

describe('persistenceWindowOf: the Kaplan-Meier worked example (delayed entry)', () => {
  it('(9 h, 24 h): 32/45 still up, 9 followed at the age, at least 8 through the window, 3 ended', () => {
    const w = persistenceWindowOf(KM, 9 * H, 24 * H);
    expect(isWindow(w)).toBe(true);
    if (!isWindow(w)) return;
    expect(w).toEqual({ horizonMs: 24 * H, p: w.p, atRisk: 9, minAtRisk: 8, ended: 3 });
    expect(w.p).toBeCloseTo(32 / 45, 12);
  });

  it('(9 h, 1 h): 8/9, one ended', () => {
    const w = persistenceWindowOf(KM, 9 * H, H);
    expect(isWindow(w) && w.atRisk).toBe(9);
    expect(isWindow(w) && w.ended).toBe(1);
    expect(isWindow(w) && w.p).toBeCloseTo(8 / 9, 12);
  });

  it('(30 h, 24 h): 0.75, 8 at the age, at least 5 through the window, 2 ended', () => {
    const w = persistenceWindowOf(KM, 30 * H, 24 * H);
    expect(w).toEqual({ horizonMs: 24 * H, p: 0.75, atRisk: 8, minAtRisk: 5, ended: 2 });
  });

  it("(0, 24 h): too few followed at age 0 ('few-at-risk')", () => {
    expect(persistenceWindowOf(KM, 0, 24 * H)).toBe('few-at-risk');
  });

  it("eight entered at 0 and censored at 30 h: a 7 d window from 1 h is 'past-the-data'", () => {
    const eight = Array.from({ length: 8 }, () => obsOf(0, 30, 0));
    expect(persistenceWindowOf(eight, H, 7 * DAY)).toBe('past-the-data');
    // The same pool answers a window it covers: nothing ended, so everything is still up.
    expect(persistenceWindowOf(eight, H, DAY)).toEqual({ horizonMs: DAY, p: 1, atRisk: 8, minAtRisk: 8, ended: 0 });
  });

  it('ignores the order of its input and counts tied event exits together', () => {
    const shuffled = [...KM].reverse();
    expect(persistenceWindowOf(shuffled, 9 * H, 24 * H)).toEqual(persistenceWindowOf(KM, 9 * H, 24 * H));
    const tied = [...Array.from({ length: 10 }, () => obsOf(0, 50, 0)), obsOf(0, 5, 1), obsOf(0, 5, 1)];
    const w = persistenceWindowOf(tied, H, DAY);
    expect(w).toEqual({ horizonMs: DAY, p: 1 - 2 / 12, atRisk: 12, minAtRisk: 10, ended: 2 });
  });
});

describe('spellObservationOf: the edges', () => {
  it('is null without a listedAt, or for a zero-length observation', () => {
    expect(spellObservationOf(spell(1, 5, 'deleted', { listedAt: null }), 0)).toBeNull();
    expect(spellObservationOf(spell(3, 3, null), 0)).toBeNull();
    // Ended before it entered (a clock step): nothing to read.
    expect(spellObservationOf(spell(5, 4, 'deleted'), 0)).toBeNull();
  });

  it('enters at age 0 when it was first seen before backpack.tf’s listing time', () => {
    const o = spellObservationOf(spell(-2, 5, 'deleted'), 0)!;
    expect(o.entry).toBe(0);
    expect(o.exit).toBe(5 * H);
  });

  it("counts 'deleted', 'inactive' and 'lowered' as events; 'raised', 'relisted', 'unwatched' and open as censored", () => {
    const kinds: (OrderSpellEnd | null)[] = ['deleted', 'inactive', 'lowered', 'raised', 'relisted', 'unwatched', null];
    expect(kinds.map((k) => spellObservationOf(spell(1, 5, k), 0)!.event)).toEqual([true, true, true, false, false, false, false]);
  });

  it('prefers endAt for an ended spell, and lastSeenAt for a followed one', () => {
    // A touch can leave last_seen_at past the end; the end is when it stopped being up.
    expect(spellObservationOf(spell(1, 5, 'deleted', { lastSeenAt: ORIGIN + 9 * H }), 0)!.exit).toBe(5 * H);
    expect(spellObservationOf(spell(1, 5, null, { endAt: ORIGIN + 2 * H }), 0)!.exit).toBe(5 * H);
  });

  it('values keys at the key price (none: keys count 0)', () => {
    expect(spellObservationOf(spell(1, 5, null, { keys: 2, metalScrap: 9 }), 500)!.valueScrap).toBe(1009);
    expect(spellObservationOf(spell(1, 5, null, { keys: 2, metalScrap: 9 }), 0)!.valueScrap).toBe(9);
  });
});

describe('orderSpellFollows (H1, D9)', () => {
  const order = { intent: 'buy' as const, isMarketplace: false, userBanned: false, keys: 0, metalScrap: 0 };

  it('follows an order worth at least ceil(0.7 x top), and not one scrap less', () => {
    for (const top of [10, 99, 100, 133, 1_000]) {
      const need = Math.ceil(ORDER_SPELL_FOLLOW_SHARE * top);
      expect(orderSpellFollows({ ...order, metalScrap: need }, top, 0), `top ${top}`).toBe(true);
      expect(orderSpellFollows({ ...order, metalScrap: need - 1 }, top, 0), `top ${top}`).toBe(false);
    }
    // Keys valued at the key price.
    expect(orderSpellFollows({ ...order, keys: 1, metalScrap: 0 }, 700, 500)).toBe(true);
    expect(orderSpellFollows({ ...order, keys: 1, metalScrap: 0 }, 800, 500)).toBe(false);
  });

  it('refuses a sell order, a marketplace order, a banned buyer and an impersonator', () => {
    expect(orderSpellFollows({ ...order, metalScrap: 100, intent: 'sell' }, 100, 0)).toBe(false);
    expect(orderSpellFollows({ ...order, metalScrap: 100, isMarketplace: true }, 100, 0)).toBe(false);
    expect(orderSpellFollows({ ...order, metalScrap: 100, userBanned: true }, 100, 0)).toBe(false);
    expect(orderSpellFollows({ ...order, metalScrap: 100, userImpersonated: true }, 100, 0)).toBe(false);
    expect(orderSpellFollows({ ...order, metalScrap: 100, userImpersonated: false }, 100, 0)).toBe(true);
  });

  it('refuses an order with no price, a keyed order without a key price and an order without a top', () => {
    expect(orderSpellFollows(order, 100, 500)).toBe(false);
    expect(orderSpellFollows({ ...order, keys: 2 }, 100, 0)).toBe(false);
    expect(orderSpellFollows({ ...order, keys: 2 }, 100, Number.NaN)).toBe(false);
    for (const top of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(orderSpellFollows({ ...order, metalScrap: 100 }, top, 0)).toBe(false);
  });
});

describe('orderSpellEndOf (H2)', () => {
  it('is the same at the same raw price, else lowered or raised', () => {
    expect(orderSpellEndOf({ keys: 1, metalScrap: 9 }, { keys: 1, metalScrap: 9 }, 500)).toBe('same');
    expect(orderSpellEndOf({ keys: 1, metalScrap: 9 }, { keys: 1, metalScrap: 8 }, 500)).toBe('lowered');
    expect(orderSpellEndOf({ keys: 1, metalScrap: 9 }, { keys: 1, metalScrap: 10 }, 500)).toBe('raised');
  });

  it('compares keys against metal at the key price, and by keys without one', () => {
    expect(orderSpellEndOf({ keys: 1, metalScrap: 0 }, { keys: 0, metalScrap: 60 }, 55)).toBe('raised');
    expect(orderSpellEndOf({ keys: 1, metalScrap: 0 }, { keys: 0, metalScrap: 60 }, 70)).toBe('lowered');
    expect(orderSpellEndOf({ keys: 1, metalScrap: 0 }, { keys: 0, metalScrap: 60 }, 0)).toBe('lowered');
    expect(orderSpellEndOf({ keys: 0, metalScrap: 60 }, { keys: 1, metalScrap: 0 }, 0)).toBe('raised');
  });
});

describe('orderPersistenceOf: the scope ladder (H6)', () => {
  const now = (ageH: number) => ORIGIN + ageH * H;
  /** Ten followed from age 0: five deleted at 30 h, five still up when last seen at 50 h. */
  const ten = (over: Partial<OrderSpell> = {}) => [
    ...Array.from({ length: 5 }, () => spell(0, 30, 'deleted', over)),
    ...Array.from({ length: 5 }, () => spell(0, 50, 'unwatched', over)),
  ];

  it("answers in 'like' (the same kind, within 15 %) when it has enough, with every horizon it covers", () => {
    const r = orderPersistenceOf([...ten(), ...ten({ isBot: false, metalScrap: 300 })], { valueScrap: 110, isBot: true, listedAt: L }, 0, now(1));
    expect(r.scope).toBe('like');
    expect(r.short).toBeNull();
    expect(r.ageMs).toBe(H);
    // 1 h and 1 d pass; 7 d runs past the data (everything left by 50 h).
    expect(r.windows.map((w) => w.horizonMs)).toEqual([H, DAY]);
    expect(r.windows.map((w) => w.atRisk)).toEqual([10, 10]);
    expect(r.windows[1]!.p).toBe(1);
  });

  it("falls to 'band' (value only) when too few of its kind, and to 'all' when too few near its price", () => {
    const band = orderPersistenceOf([...ten({ isBot: false }), spell(0, 50, 'unwatched')], { valueScrap: 100, isBot: true, listedAt: L }, 0, now(1));
    expect(band.scope).toBe('band');
    expect(band.windows[0]!.atRisk).toBe(11);
    const all = orderPersistenceOf(ten({ metalScrap: 200 }), { valueScrap: 100, isBot: true, listedAt: L }, 0, now(1));
    expect(all.scope).toBe('all');
    expect(all.windows[0]!.atRisk).toBe(10);
    // A value of 0 is in no band: 'all' only.
    expect(orderPersistenceOf(ten(), { valueScrap: 0, isBot: true, listedAt: L }, 0, now(1)).scope).toBe('all');
  });

  it("says why with no scope: 'few-at-risk', 'past-the-data' (the 'all' scope's 1 h) and 'no-listed-time'", () => {
    const few = orderPersistenceOf(ten().slice(0, 5), { valueScrap: 100, isBot: true, listedAt: L }, 0, now(1));
    expect(few).toEqual({ ageMs: H, scope: null, windows: [], short: 'few-at-risk' });
    const past = orderPersistenceOf(Array.from({ length: 10 }, () => spell(0, 1.5, 'unwatched')), { valueScrap: 100, isBot: true, listedAt: L }, 0, now(1));
    expect(past).toEqual({ ageMs: H, scope: null, windows: [], short: 'past-the-data' });
    expect(orderPersistenceOf(ten(), { valueScrap: 100, isBot: true, listedAt: null }, 0, now(1))).toEqual({ ageMs: null, scope: null, windows: [], short: 'no-listed-time' });
  });

  it('measures the age from listedAt, clamped at 0, and leaves spells without a listedAt out', () => {
    const r = orderPersistenceOf([...ten(), ...Array.from({ length: 20 }, () => spell(0, 50, 'deleted', { listedAt: null }))], { valueScrap: 100, isBot: true, listedAt: L + 3600 }, 0, now(0.5));
    expect(r.ageMs).toBe(0);
    expect(r.windows[0]!.atRisk).toBe(10);
  });
});

describe('orderSpellSummaryOf', () => {
  it('counts every end kind, inactive and relisted included, the spells without a listedAt, the oldest entry and the time observed', () => {
    const spells = [
      spell(0, 2, null),
      spell(1, 3, 'deleted'),
      spell(2, 4, 'inactive'),
      spell(3, 5, 'lowered', { listedAt: null }),
      spell(4, 6, 'raised'),
      spell(5, 7, 'relisted'),
      spell(6, 8, 'unwatched'),
      spell(7, 6, 'deleted'), // a clock step: no negative time
    ];
    expect(orderSpellSummaryOf(spells)).toEqual({
      followed: 8,
      open: 1,
      deleted: 2,
      inactive: 1,
      lowered: 1,
      raised: 1,
      relisted: 1,
      unwatched: 1,
      noListedTime: 1,
      since: ORIGIN,
      observedMs: 14 * H,
    });
    expect(orderSpellSummaryOf([])).toMatchObject({ followed: 0, since: null, observedMs: 0 });
  });
});

describe('spellsEntryCutOf (review: a capped base keeps no open survivor)', () => {
  const ended = (base: string, n: number, fromH: number) => Array.from({ length: n }, (_, i) => spell(fromH + i, fromH + i + 1, 'deleted', { baseSku: base }));

  it('passes a base under the cap unchanged', () => {
    const list = [spell(0, 500, null), ...ended('378;6', ORDER_SPELLS_PER_BASE_MAX - 1, 10)];
    expect(spellsEntryCutOf(list)).toEqual(list);
  });

  it("drops, at the cap, only that base's spells first seen at or before its 300th newest ended spell", () => {
    const oldOpen = spell(0, 500, null);
    const oldOtherBase = spell(0, 500, null, { baseSku: '126;6' });
    const capped = ended('378;6', ORDER_SPELLS_PER_BASE_MAX, 10);
    const youngOpen = spell(400, 500, null);
    const out = spellsEntryCutOf([oldOpen, oldOtherBase, ...capped, youngOpen]);
    // The boundary spell goes too: the cap may have split its instant by id.
    expect(out).toEqual([oldOtherBase, ...capped.slice(1), youngOpen]);
  });

  it('review: drops a batch opened at the boundary instant whole (the cap kept its open spells, not all its ended ones)', () => {
    const batch = [spell(5, 6, 'deleted'), spell(5, 6, 'deleted'), spell(5, 500, null)];
    const newer = ended('378;6', ORDER_SPELLS_PER_BASE_MAX - 2, 10);
    const out = spellsEntryCutOf([...batch, ...newer]);
    expect(out).toEqual(newer);
  });

  it('review: keeps the cut where the cap drew it once a survivor it left has ended (the oldest ended spell is no cut)', () => {
    const survivorEnded = spell(2, 400, 'deleted');
    const survivorOpen = spell(4, 500, null);
    const kept = ended('378;6', ORDER_SPELLS_PER_BASE_MAX, 10);
    // Ended since the prune, first seen after its boundary: still in.
    const newer = spell(350, 360, 'deleted');
    const out = spellsEntryCutOf([survivorEnded, survivorOpen, ...kept, newer]);
    expect(out).toEqual([...kept.slice(2), newer]);
    expect(out.some((s) => s.endKind === null)).toBe(false);
  });
});

describe('no upward bias on a capped base (review: kmcap3/kmcap5)', () => {
  /** review090's LCG and generator: 30 spells a day on one base for 120 days, exponential lives with a 5-day mean. */
  function generate(seed0: number): { spells: OrderSpell[]; now: number } {
    let seed = seed0;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const now = 120 * DAY;
    const spells: OrderSpell[] = [];
    let id = 0;
    for (let d = 0; d < 120; d += 1 / 30) {
      const start = d * DAY;
      const end = start - Math.log(1 - rnd()) * 5 * DAY;
      const done = end <= now;
      spells.push({
        id: ++id,
        baseSku: '378;6',
        intent: 'buy',
        isBot: true,
        keys: 0,
        metalScrap: 100,
        listedAt: start / 1000,
        firstSeenAt: start,
        lastSeenAt: done ? end : now,
        endAt: done ? end : null,
        endKind: done ? 'deleted' : null,
      });
    }
    return { spells, now };
  }
  /** The per-base cap keeps the newest 300 ended by `by`, open ones all; the read keeps the newest 2,000 by `by`. */
  function select(spells: OrderSpell[], by: 'firstSeenAt' | 'lastSeenAt'): OrderSpell[] {
    const newest = (a: OrderSpell, b: OrderSpell) => b[by] - a[by];
    const kept = spells.filter((s) => s.endKind !== null).sort(newest).slice(0, ORDER_SPELLS_PER_BASE_MAX);
    return [...kept, ...spells.filter((s) => s.endKind === null)].sort(newest).slice(0, 2_000);
  }
  const estimate = (spells: OrderSpell[], horizon: number): number => {
    const obs = spells.map((s) => spellObservationOf(s, 0)).filter((o): o is SpellObservation => o !== null);
    const w = persistenceWindowOf(obs, 0, horizon);
    if (!isWindow(w)) throw new Error(`no window: ${w}`);
    return w.p;
  };

  it('reads 7 d within 0.02 of exp(-7/5) and 1 d within 0.02 of exp(-1/5) when selected on entry and cut', () => {
    let d7 = 0;
    let d1 = 0;
    let old = 0;
    const R = 40;
    for (let s = 1; s <= R; s++) {
      const { spells } = generate(s * 7919);
      const chosen = spellsEntryCutOf(select(spells, 'firstSeenAt'));
      d7 += estimate(chosen, 7 * DAY);
      d1 += estimate(chosen, DAY);
      // The old rule (newest by when they ended, no cut) keeps long spells and drops their short siblings.
      old += estimate(select(spells, 'lastSeenAt'), 7 * DAY);
    }
    expect(Math.abs(d7 / R - Math.exp(-7 / 5))).toBeLessThan(0.02);
    expect(Math.abs(d1 / R - Math.exp(-1 / 5))).toBeLessThan(0.02);
    expect(old / R).toBeGreaterThan(0.33);
  });
});

describe('itemBookHistoryOf', () => {
  const buy = (metalScrap: number, over: Record<string, unknown> = {}) => ({ intent: 'buy' as const, keys: 0, metalScrap, isBot: true, listedAt: L, ...over });

  it('reads the first five asked buy orders, skipping a missing or sell listing, over the cut spells', () => {
    const spells = Array.from({ length: 10 }, () => spell(0, 50, 'unwatched'));
    const point: CommunityPoint = { sku: '378;6', source: 'feed', currency: 'metal', value: 11.11, valueHigh: 11.22, lastUpdate: L, recordedAt: ORIGIN + 5_000 };
    const orders = [
      { listingId: 'gone', listing: null },
      { listingId: 'sell', listing: buy(100, { intent: 'sell' }) },
      ...Array.from({ length: 6 }, (_, i) => ({ listingId: `b${i}`, listing: buy(100 + i) })),
    ];
    const r = itemBookHistoryOf({ sku: '378;6', bases: ['378;6', '378;600'], spells, points: [point], current: null, orders, keyScrap: 0, now: ORIGIN + H });
    expect(r.orders.map((o) => o.listingId)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4']);
    expect(r.orders).toHaveLength(BOOK_HISTORY_ORDERS_MAX);
    expect(r.orders[0]).toMatchObject({ isBot: true, valueScrap: 100, listedAt: L, persistence: { scope: 'like', ageMs: H } });
    expect(r.summary.followed).toBe(10);
    expect(r.community.steps).toHaveLength(1);
    expect(r).toMatchObject({ sku: '378;6', bases: ['378;6', '378;600'], keyScrap: null, generatedAt: ORIGIN + H });
  });

  it('values keyed orders at a known key price and counts every spell in the summary, cut or not', () => {
    const capped = Array.from({ length: ORDER_SPELLS_PER_BASE_MAX }, (_, i) => spell(10 + i, 11 + i, 'deleted'));
    const survivor = spell(0, 900, null);
    const r = itemBookHistoryOf({
      sku: '378;6',
      bases: ['378;6'],
      spells: [survivor, ...capped],
      points: [],
      current: null,
      orders: [{ listingId: 'k', listing: buy(9, { keys: 1, listedAt: null }) }],
      keyScrap: 500,
      now: ORIGIN + H,
    });
    expect(r.keyScrap).toBe(500);
    expect(r.orders[0]).toMatchObject({ valueScrap: 509, listedAt: null, persistence: { short: 'no-listed-time' } });
    expect(r.summary.followed).toBe(ORDER_SPELLS_PER_BASE_MAX + 1);
    expect(r.summary.open).toBe(1);
  });
});
