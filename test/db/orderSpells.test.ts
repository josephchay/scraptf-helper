// 0.9 (history, RESEARCH #6, schema V16): the repo's buy-order spells (order_spells). One spell is one buy order at
// one price as the live feed showed it, with no SteamID, listing id or name. The repo appends spells, ends a followed
// one once (its last_seen_at only moves forward), touches and censors every followed one, reads a book's spells and
// prunes ended ones. Every cut selects on first_seen_at (the spell's entry), never on its end: a cut on the end keeps
// long spells and drops their short siblings, which biases the Kaplan-Meier estimate up (review 0.9).

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openRepo } from '../../src/service/db';
import type { Repo } from '../../src/service/contracts';
import {
  ORDER_SPELLS_DETAIL_MAX,
  ORDER_SPELLS_MAX_AGE_MS,
  ORDER_SPELLS_MAX_ROWS,
  ORDER_SPELLS_PER_BASE_MAX,
  orderSpellSummaryOf,
  spellsEntryCutOf,
} from '../../src/shared/orderPersistence';
import { ORDER_SPELL_ENDS, type OrderSpell, type OrderSpellEnd } from '../../src/shared/types';
import { tempDir } from './helpers';

const T0 = 1_792_496_380_093;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function repo(): Repo {
  const r = openRepo(':memory:');
  cleanups.push(() => r.close());
  return r;
}

/** A followed spell of 378;6 at 1 key + 9 scrap, first seen at T0, with `over` on top. */
const spell = (over: Partial<Omit<OrderSpell, 'id'>> = {}): Omit<OrderSpell, 'id'> => ({
  baseSku: '378;6',
  intent: 'buy',
  isBot: true,
  keys: 1,
  metalScrap: 9,
  listedAt: 1_792_490_000,
  firstSeenAt: T0,
  lastSeenAt: T0,
  endAt: null,
  endKind: null,
  ...over,
});

describe('order_spells: write and read (0.9, V16)', () => {
  it('round-trips a followed spell and an ended one, and returns increasing ids', () => {
    const r = repo();
    const open = spell({ isBot: false, listedAt: null });
    const ended = spell({ keys: 0, metalScrap: 45, firstSeenAt: T0 + MIN, lastSeenAt: T0 + 5 * MIN, endAt: T0 + 5 * MIN, endKind: 'lowered' });
    const a = r.insertOrderSpell(open);
    const b = r.insertOrderSpell(ended);
    expect(b).toBeGreaterThan(a);
    expect(r.orderSpells(['378;6'], 0)).toEqual([
      { id: a, ...open },
      { id: b, ...ended },
    ]);
  });

  it("round-trips every end kind, 'inactive' and 'relisted' included", () => {
    const r = repo();
    for (const [i, kind] of ORDER_SPELL_ENDS.entries()) r.insertOrderSpell(spell({ firstSeenAt: T0 + i, lastSeenAt: T0 + i, endAt: T0 + i, endKind: kind }));
    expect(r.orderSpells(['378;6'], 0).map((s) => s.endKind)).toEqual(['deleted', 'inactive', 'lowered', 'raised', 'relisted', 'unwatched']);
  });

  it('refuses a spell without a base or a finite time, or with an unknown end kind; binds a bad price as 0', () => {
    const r = repo();
    expect(() => r.insertOrderSpell(spell({ baseSku: '' }))).toThrow(TypeError);
    expect(() => r.insertOrderSpell(spell({ firstSeenAt: Number.NaN }))).toThrow(TypeError);
    expect(() => r.insertOrderSpell(spell({ lastSeenAt: Number.POSITIVE_INFINITY }))).toThrow(TypeError);
    expect(() => r.insertOrderSpell(spell({ endAt: Number.NaN, endKind: 'deleted' }))).toThrow(TypeError);
    expect(() => r.insertOrderSpell(spell({ endAt: T0, endKind: 'sold' as OrderSpellEnd }))).toThrow(TypeError);
    expect(r.orderSpells(['378;6'], 0)).toEqual([]);
    r.insertOrderSpell(spell({ keys: Number.NaN, metalScrap: Number.POSITIVE_INFINITY }));
    expect(r.orderSpells(['378;6'], 0)).toMatchObject([{ keys: 0, metalScrap: 0 }]);
  });

  it('reads an end kind it does not know (a newer build, damage) as still followed', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const file = t.file();
    let r = openRepo(file);
    const first = r;
    cleanups.push(() => first.close());
    const id = r.insertOrderSpell(spell());
    r.close();
    const db = new DatabaseSync(file);
    db.prepare("UPDATE order_spells SET end_kind = 'sold', end_at = ? WHERE id = ?").run(T0, id);
    db.close();
    r = openRepo(file);
    cleanups.push(() => r.close());
    expect(r.orderSpells(['378;6'], 0)).toMatchObject([{ id, endKind: null, endAt: T0 }]);
  });
});

describe('order_spells: ending, touching and censoring', () => {
  it("endOrderSpell sets the end once; an ended spell's last_seen_at is its end", () => {
    const r = repo();
    const id = r.insertOrderSpell(spell({ lastSeenAt: T0 + 10 * MIN }));
    // Review: a confirmation past the end (a touch that reached a held row) never outlives it.
    expect(r.endOrderSpell(id, T0 + 5 * MIN, 'deleted')).toBe(true);
    expect(r.orderSpells(['378;6'], 0)).toMatchObject([{ id, endAt: T0 + 5 * MIN, endKind: 'deleted', lastSeenAt: T0 + 5 * MIN }]);
    // An ended spell is never ended again.
    expect(r.endOrderSpell(id, T0 + 20 * MIN, 'lowered')).toBe(false);
    expect(r.orderSpells(['378;6'], 0)).toMatchObject([{ endKind: 'deleted', endAt: T0 + 5 * MIN }]);
    const later = r.insertOrderSpell(spell({ firstSeenAt: T0 + MIN, lastSeenAt: T0 + MIN }));
    expect(r.endOrderSpell(later, T0 + 30 * MIN, 'inactive')).toBe(true);
    expect(r.orderSpells(['378;6'], 0)[1]).toMatchObject({ id: later, endAt: T0 + 30 * MIN, endKind: 'inactive', lastSeenAt: T0 + 30 * MIN });
  });

  it('endOrderSpell: false for a missing id, a TypeError for a bad time or kind', () => {
    const r = repo();
    expect(r.endOrderSpell(999, T0, 'deleted')).toBe(false);
    const id = r.insertOrderSpell(spell());
    expect(() => r.endOrderSpell(id, Number.NaN, 'deleted')).toThrow(TypeError);
    expect(() => r.endOrderSpell(id, T0, 'filled' as OrderSpellEnd)).toThrow(TypeError);
    expect(r.orderSpells(['378;6'], 0)).toMatchObject([{ id, endKind: null }]);
  });

  it('touchOpenOrderSpells moves only followed spells, and never back', () => {
    const r = repo();
    const open = r.insertOrderSpell(spell({ lastSeenAt: T0 + 2 * MIN }));
    const ahead = r.insertOrderSpell(spell({ firstSeenAt: T0 + MIN, lastSeenAt: T0 + 30 * MIN }));
    const ended = r.insertOrderSpell(spell({ firstSeenAt: T0 + 2 * MIN, lastSeenAt: T0 + 3 * MIN, endAt: T0 + 3 * MIN, endKind: 'deleted' }));
    expect(r.touchOpenOrderSpells(T0 + 10 * MIN)).toBe(2);
    const byId = new Map(r.orderSpells(['378;6'], 0).map((s) => [s.id, s]));
    expect(byId.get(open)!.lastSeenAt).toBe(T0 + 10 * MIN);
    expect(byId.get(ahead)!.lastSeenAt).toBe(T0 + 30 * MIN);
    expect(byId.get(ended)!.lastSeenAt).toBe(T0 + 3 * MIN);
    expect(() => r.touchOpenOrderSpells(Number.NaN)).toThrow(TypeError);
  });

  it('touchOpenOrderSpells skips the rows it is told to (the tracker\'s held deletes), past one IN list too', () => {
    const r = repo();
    const held = r.insertOrderSpell(spell());
    const open = r.insertOrderSpell(spell());
    const many = [held, ...Array.from({ length: 600 }, (_, i) => 10_000 + i), Number.NaN];
    expect(r.touchOpenOrderSpells(T0 + 10 * MIN, many)).toBe(1);
    const byId = new Map(r.orderSpells(['378;6'], 0).map((s) => [s.id, s]));
    expect(byId.get(held)!.lastSeenAt).toBe(T0);
    expect(byId.get(open)!.lastSeenAt).toBe(T0 + 10 * MIN);
    // An empty list skips nothing.
    expect(r.touchOpenOrderSpells(T0 + 20 * MIN, [])).toBe(2);
  });

  it("endOpenOrderSpells censors every followed spell 'unwatched' at its last_seen_at", () => {
    const r = repo();
    const a = r.insertOrderSpell(spell({ lastSeenAt: T0 + 4 * MIN }));
    const b = r.insertOrderSpell(spell({ baseSku: '5021;6', firstSeenAt: T0 + MIN, lastSeenAt: T0 + 9 * MIN }));
    const ended = r.insertOrderSpell(spell({ firstSeenAt: T0 + 2 * MIN, lastSeenAt: T0 + 3 * MIN, endAt: T0 + 3 * MIN, endKind: 'raised' }));
    expect(r.endOpenOrderSpells()).toBe(2);
    expect(r.endOpenOrderSpells()).toBe(0);
    const rows = new Map(r.orderSpells(['378;6', '5021;6'], 0).map((s) => [s.id, s]));
    expect(rows.get(a)).toMatchObject({ endKind: 'unwatched', endAt: T0 + 4 * MIN, lastSeenAt: T0 + 4 * MIN });
    expect(rows.get(b)).toMatchObject({ endKind: 'unwatched', endAt: T0 + 9 * MIN });
    expect(rows.get(ended)).toMatchObject({ endKind: 'raised', endAt: T0 + 3 * MIN });
    expect(r.touchOpenOrderSpells(T0 + DAY)).toBe(0);
  });
});

describe("order_spells: a book's read selects on entry", () => {
  it('filters by the base set and first_seen_at, keeps the newest `limit` by entry, oldest first', () => {
    const r = repo();
    const ids: number[] = [];
    // Inserted out of entry order: the read orders by first_seen_at, then id.
    for (const at of [T0 + 3 * MIN, T0, T0 + 2 * MIN, T0 + MIN]) ids.push(r.insertOrderSpell(spell({ firstSeenAt: at, lastSeenAt: at + DAY })));
    const twin = r.insertOrderSpell(spell({ baseSku: '378;6;uncraftable', firstSeenAt: T0 + MIN, lastSeenAt: T0 + MIN }));
    r.insertOrderSpell(spell({ baseSku: '5021;6', firstSeenAt: T0 }));
    const firsts = (rows: OrderSpell[]) => rows.map((s) => s.firstSeenAt - T0);
    expect(firsts(r.orderSpells(['378;6'], 0))).toEqual([0, MIN, 2 * MIN, 3 * MIN]);
    // The book's twin base is read with it; ties on entry go by id.
    expect(r.orderSpells(['378;6', '378;6;uncraftable', '378;6'], 0).map((s) => s.id)).toEqual([ids[1], ids[3], twin, ids[2], ids[0]]);
    expect(firsts(r.orderSpells(['378;6'], T0 + MIN))).toEqual([MIN, 2 * MIN, 3 * MIN]);
    // The newest two by entry (not by end: every spell here ends a day later), oldest first.
    expect(firsts(r.orderSpells(['378;6'], 0, 2))).toEqual([2 * MIN, 3 * MIN]);
    expect(r.orderSpells([], 0)).toEqual([]);
    expect(r.orderSpells(['', 'nope'], 0)).toEqual([]);
  });

  it('clamps the limit (at least 1, default ORDER_SPELLS_DETAIL_MAX)', () => {
    const r = repo();
    for (let i = 0; i < 4; i++) r.insertOrderSpell(spell({ firstSeenAt: T0 + i }));
    expect(r.orderSpells(['378;6'], 0, 0)).toHaveLength(1);
    expect(r.orderSpells(['378;6'], 0, Number.NaN)).toHaveLength(4);
    expect(ORDER_SPELLS_DETAIL_MAX).toBe(2_000);
  });
});

describe('order_spells: retention (ended spells only, cut on entry)', () => {
  it('prunes by age on first_seen_at, never a followed spell', () => {
    const r = repo();
    const now = T0 + 100 * DAY;
    const old = now - ORDER_SPELLS_MAX_AGE_MS - MIN;
    r.insertOrderSpell(spell({ firstSeenAt: old, lastSeenAt: old + MIN, endAt: old + MIN, endKind: 'deleted' }));
    // Started before the cut but ended after it: the entry decides, so it goes too.
    r.insertOrderSpell(spell({ firstSeenAt: old, lastSeenAt: now - DAY, endAt: now - DAY, endKind: 'lowered' }));
    const followed = r.insertOrderSpell(spell({ firstSeenAt: old, lastSeenAt: now - MIN }));
    const recent = r.insertOrderSpell(spell({ firstSeenAt: now - DAY, lastSeenAt: now - DAY, endAt: now - DAY, endKind: 'deleted' }));
    expect(r.pruneOrderSpells(now)).toBe(2);
    expect(r.orderSpells(['378;6'], 0).map((s) => s.id).sort((a, b) => a - b)).toEqual([followed, recent]);
    expect(ORDER_SPELLS_MAX_AGE_MS).toBe(60 * DAY);
  });

  it('caps each base by entry: of two ended spells, the long one that started first and ended last goes', () => {
    const r = repo();
    const long = r.insertOrderSpell(spell({ firstSeenAt: T0, lastSeenAt: T0 + 3 * DAY, endAt: T0 + 3 * DAY, endKind: 'deleted' }));
    const short = r.insertOrderSpell(spell({ firstSeenAt: T0 + DAY, lastSeenAt: T0 + DAY + MIN, endAt: T0 + DAY + MIN, endKind: 'deleted' }));
    const followed = r.insertOrderSpell(spell({ firstSeenAt: T0 - DAY, lastSeenAt: T0 + 4 * DAY }));
    const other = r.insertOrderSpell(spell({ baseSku: '5021;6', firstSeenAt: T0 - 2 * DAY, lastSeenAt: T0, endAt: T0, endKind: 'lowered' }));
    expect(r.pruneOrderSpells(T0 + 5 * DAY, { perBaseMax: 1 })).toBe(1);
    const left = r.orderSpells(['378;6', '5021;6'], 0).map((s) => s.id);
    expect(left).not.toContain(long);
    expect(left.sort((a, b) => a - b)).toEqual([short, followed, other].sort((a, b) => a - b));
  });

  it('caps the whole table by entry, newest kept, followed spells not counted (nor read once first seen before the cut)', () => {
    const r = repo();
    const a = r.insertOrderSpell(spell({ baseSku: 'a', firstSeenAt: T0, lastSeenAt: T0 + 9 * DAY, endAt: T0 + 9 * DAY, endKind: 'deleted' }));
    const b = r.insertOrderSpell(spell({ baseSku: 'b', firstSeenAt: T0 + DAY, lastSeenAt: T0 + DAY, endAt: T0 + DAY, endKind: 'deleted' }));
    const c = r.insertOrderSpell(spell({ baseSku: 'c', firstSeenAt: T0 + 2 * DAY, lastSeenAt: T0 + 2 * DAY, endAt: T0 + 2 * DAY, endKind: 'unwatched' }));
    const followed = r.insertOrderSpell(spell({ baseSku: 'a', firstSeenAt: T0 - DAY, lastSeenAt: T0 + 9 * DAY }));
    expect(r.pruneOrderSpells(T0 + 10 * DAY, { maxRows: 2 })).toBe(1);
    // The followed spell stays in the table (the tracker still ends it) but is no longer read: it was first seen
    // before the newest entry the cap deleted.
    expect(r.orderSpells(['a', 'b', 'c'], 0).map((s) => s.id).sort((x, y) => x - y)).toEqual([b, c]);
    expect(r.touchOpenOrderSpells(T0 + 9 * DAY)).toBe(1);
    expect(a).toBeLessThan(b);
    expect(r.pruneOrderSpells(T0 + 10 * DAY, { maxRows: 0 })).toBe(2);
    expect(r.orderSpells(['a', 'b', 'c'], 0)).toEqual([]);
    expect(r.endOrderSpell(followed, T0 + 9 * DAY, 'deleted')).toBe(true);
  });

  it("review: the whole-table cap leaves no survivor in a base's read, even once that survivor has ended", () => {
    const r = repo();
    // Base A: one followed spell and 20 siblings first seen one minute apart, each deleted a minute later.
    const survivor = r.insertOrderSpell(spell({ baseSku: 'A', firstSeenAt: T0, lastSeenAt: T0 + DAY }));
    for (let i = 0; i < 20; i++) r.insertOrderSpell(spell({ baseSku: 'A', firstSeenAt: T0 + i * MIN, lastSeenAt: T0 + (i + 1) * MIN, endAt: T0 + (i + 1) * MIN, endKind: 'deleted' }));
    // Base B's 50 newer spells push the table over a 55-row cap: A's siblings first seen at T0 .. T0 + 14 min go.
    for (let i = 0; i < 50; i++) r.insertOrderSpell(spell({ baseSku: 'B', firstSeenAt: T0 + HOUR + i * MIN, lastSeenAt: T0 + 2 * HOUR, endAt: T0 + 2 * HOUR, endKind: 'deleted' }));
    expect(r.pruneOrderSpells(T0 + DAY, { maxRows: 55 })).toBe(15);
    const read = r.orderSpells(['A'], 0);
    expect(read.map((s) => s.firstSeenAt - T0)).toEqual([15, 16, 17, 18, 19].map((m) => m * MIN));
    expect(spellsEntryCutOf(read).some((s) => s.id === survivor)).toBe(false);
    expect(orderSpellSummaryOf(spellsEntryCutOf(read))).toMatchObject({ followed: 5, open: 0, deleted: 5 });
    // The survivor ends: it is still first seen before the cut, so still not read.
    r.endOrderSpell(survivor, T0 + DAY, 'deleted');
    expect(r.orderSpells(['A'], 0)).toHaveLength(5);
    // A later cap that deletes it (an older entry) never moves the cut back.
    expect(r.pruneOrderSpells(T0 + DAY, { maxRows: 55 })).toBe(1);
    r.insertOrderSpell(spell({ baseSku: 'A', firstSeenAt: T0 + 10 * MIN, lastSeenAt: T0 + DAY }));
    expect(r.orderSpells(['A'], 0)).toHaveLength(5);
  });

  it('review: with spellsEntryCutOf, a batch opened at the per-base boundary instant goes whole', () => {
    const r = repo();
    // One feed batch at T0 opened four spells: three later deleted, one still followed; 298 newer ended spells.
    for (let i = 0; i < 3; i++) r.insertOrderSpell(spell({ firstSeenAt: T0, lastSeenAt: T0 + MIN, endAt: T0 + MIN, endKind: 'deleted' }));
    r.insertOrderSpell(spell({ firstSeenAt: T0, lastSeenAt: T0 + DAY }));
    for (let i = 1; i <= ORDER_SPELLS_PER_BASE_MAX - 2; i++) {
      r.insertOrderSpell(spell({ firstSeenAt: T0 + i * MIN, lastSeenAt: T0 + (i + 1) * MIN, endAt: T0 + (i + 1) * MIN, endKind: 'deleted' }));
    }
    // The cap keeps 300 ended: two of the batch's three deletes (by id) and its followed spell.
    expect(r.pruneOrderSpells(T0 + DAY)).toBe(1);
    const read = r.orderSpells(['378;6'], 0, 5_000);
    expect(read.filter((s) => s.firstSeenAt === T0).map((s) => s.endKind)).toEqual(['deleted', 'deleted', null]);
    const kept = spellsEntryCutOf(read);
    expect(kept.some((s) => s.firstSeenAt === T0)).toBe(false);
    expect(kept).toHaveLength(ORDER_SPELLS_PER_BASE_MAX - 2);
  });

  it('defaults: 60 days, 300 per base, 400,000 in all; nothing to prune is 0', () => {
    expect([ORDER_SPELLS_PER_BASE_MAX, ORDER_SPELLS_MAX_ROWS]).toEqual([300, 400_000]);
    const r = repo();
    for (let i = 0; i < ORDER_SPELLS_PER_BASE_MAX + 2; i++) {
      r.insertOrderSpell(spell({ firstSeenAt: T0 + i, lastSeenAt: T0 + i, endAt: T0 + i, endKind: 'deleted' }));
    }
    expect(r.pruneOrderSpells(T0 + DAY)).toBe(2);
    expect(r.orderSpells(['378;6'], 0, 5000)[0]!.firstSeenAt).toBe(T0 + 2);
    expect(r.pruneOrderSpells(T0 + DAY)).toBe(0);
  });
});
