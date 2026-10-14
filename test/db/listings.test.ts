import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepo } from '../../src/service/db';
import type { Repo } from '../../src/service/contracts';
import type { Listing } from '../../src/shared/types';
import { emptySpecial, makeListing } from './helpers';

let repo: Repo;
beforeEach(() => {
  repo = openRepo(':memory:');
});
afterEach(() => repo.close());

const ids = (rows: Listing[]) => rows.map((l) => l.id);

describe('listings', () => {
  it('round-trips every field, including nulls, booleans and special attributes', () => {
    const full = makeListing({
      id: '440_123456789',
      sku: '378;6;p3100495',
      baseSku: '378;6',
      intent: 'sell',
      steamid: '76561198012345678',
      userName: null,
      keys: 1.5,
      metalScrap: 13,
      isBot: true,
      uaClient: 'tf2autobot',
      uaLastPulse: 1_791_958_700,
      userOnline: false,
      userBanned: true,
      isMarketplace: true,
      special: {
        paint: 3100495,
        spells: ['Exorcism', 'Halloween Fire'],
        parts: ['Kills While Explosive-Jumping'],
        sheen: 3,
        killstreaker: 2007,
        customName: true,
        customDesc: false,
      },
      details: 'Painted; 100% clean_name',
      listedAt: null,
      bumpedAt: 1_791_958_000,
      lastEventAt: 1_791_958_123_456,
      origin: 'snapshot',
      itemName: 'Team Captain',
      marketName: 'The Team Captain',
    });
    const minimal = makeListing({ id: 'buy-1', userOnline: true, uaClient: null, marketName: null });

    repo.upsertListings([full, minimal]);
    expect(repo.getListing(full.id)).toEqual(full);
    expect(repo.getListing(minimal.id)).toEqual(minimal);
    expect(repo.getListing('missing')).toBeNull();
  });

  it('returns a fresh empty special object for listings without extras', () => {
    repo.upsertListings([makeListing({ id: 'a' }), makeListing({ id: 'b' })]);
    const a = repo.getListing('a')!;
    const b = repo.getListing('b')!;
    expect(a.special).toEqual(emptySpecial());
    a.special.spells.push('mutated');
    expect(b.special.spells).toEqual([]);
    expect(repo.getListing('a')!.special.spells).toEqual([]);
  });

  it('upsert replaces an existing listing', () => {
    repo.upsertListings([makeListing({ id: 'x', metalScrap: 10, details: 'old' })]);
    repo.upsertListings([makeListing({ id: 'x', metalScrap: 20, details: 'new', userOnline: true })]);
    const l = repo.getListing('x')!;
    expect(l.metalScrap).toBe(20);
    expect(l.details).toBe('new');
    expect(l.userOnline).toBe(true);
    expect(repo.listingCounts().total).toBe(1);
  });

  it('keeps the last copy when a batch repeats an id', () => {
    repo.upsertListings([makeListing({ id: 'x', metalScrap: 1 }), makeListing({ id: 'x', metalScrap: 2 })]);
    expect(repo.getListing('x')!.metalScrap).toBe(2);
  });

  it('never persists trade tokens pasted into listing notes', () => {
    const details = 'Send offer: https://steamcommunity.com/tradeoffer/new/?partner=12345&token=AbC-d_9x thanks';
    repo.upsertListings([makeListing({ id: 't', details })]);
    const stored = repo.getListing('t')!.details;
    expect(stored).not.toContain('AbC-d_9x');
    expect(stored).toBe('Send offer: https://steamcommunity.com/tradeoffer/new/?partner=12345&token=[removed] thanks');
    repo.upsertListings([makeListing({ id: 'u', details: 'TOKEN=xyz and tokens are fine' })]);
    expect(repo.getListing('u')!.details).toBe('token=[removed] and tokens are fine');
  });

  it('coerces non-finite prices to 0 instead of failing the batch', () => {
    repo.upsertListings([makeListing({ id: 'bad', keys: Number.NaN, metalScrap: Number.POSITIVE_INFINITY }), makeListing({ id: 'ok' })]);
    expect(repo.getListing('bad')).toMatchObject({ keys: 0, metalScrap: 0 });
    expect(repo.getListing('ok')).not.toBeNull();
  });

  it('lists by base SKU, best buy orders first and cheapest sells first', () => {
    repo.upsertListings([
      makeListing({ id: 'b-low', keys: 0, metalScrap: 20 }),
      makeListing({ id: 'b-key', keys: 1, metalScrap: 0 }),
      makeListing({ id: 'b-high', keys: 0, metalScrap: 40 }),
      makeListing({ id: 'b-painted', sku: '378;6;p123', keys: 0, metalScrap: 30 }),
      makeListing({ id: 's-high', intent: 'sell', keys: 2, metalScrap: 0 }),
      makeListing({ id: 's-low', intent: 'sell', keys: 0, metalScrap: 50 }),
      makeListing({ id: 'other', baseSku: '5021;6', sku: '5021;6' }),
    ]);
    expect(ids(repo.listingsByBaseSku('378;6', 'buy'))).toEqual(['b-key', 'b-high', 'b-painted', 'b-low']);
    expect(ids(repo.listingsByBaseSku('378;6', 'sell'))).toEqual(['s-low', 's-high']);
    expect(ids(repo.listingsByBaseSku('378;6'))).toEqual(['b-key', 'b-high', 'b-painted', 'b-low', 's-low', 's-high']);
    expect(repo.listingsByBaseSku('nope')).toEqual([]);
  });

  it('buyListingsByBaseSkus returns a key per requested SKU and only buy orders', () => {
    repo.upsertListings([
      makeListing({ id: 'a1', baseSku: 'A', metalScrap: 5 }),
      makeListing({ id: 'a2', baseSku: 'A', metalScrap: 9 }),
      makeListing({ id: 'a3', baseSku: 'A', intent: 'sell' }),
      makeListing({ id: 'b1', baseSku: 'B' }),
      makeListing({ id: 'c1', baseSku: 'C' }),
    ]);
    const m = repo.buyListingsByBaseSkus(['A', 'B', 'missing', 'A']);
    expect([...m.keys()].sort()).toEqual(['A', 'B', 'missing']);
    expect(ids(m.get('A')!)).toEqual(['a2', 'a1']);
    expect(ids(m.get('B')!)).toEqual(['b1']);
    expect(m.get('missing')).toEqual([]);
    expect(m.has('C')).toBe(false);
    expect(repo.buyListingsByBaseSkus([]).size).toBe(0);
  });

  it('buyListingsByBaseSkus handles more SKUs than one IN list holds', () => {
    const rows: Listing[] = [];
    for (let i = 0; i < 1234; i++) rows.push(makeListing({ id: `l${i}`, baseSku: `${i};6`, sku: `${i};6` }));
    repo.upsertListings(rows);
    const m = repo.buyListingsByBaseSkus(rows.map((r) => r.baseSku));
    expect(m.size).toBe(1234);
    for (const r of rows) expect(ids(m.get(r.baseSku)!)).toEqual([r.id]);
  });

  it('baseSkusWithBuyOrders lists distinct base SKUs that have buy orders', () => {
    repo.upsertListings([
      makeListing({ id: '1', baseSku: 'B' }),
      makeListing({ id: '2', baseSku: 'A' }),
      makeListing({ id: '3', baseSku: 'A' }),
      makeListing({ id: '4', baseSku: 'S', intent: 'sell' }),
    ]);
    expect(repo.baseSkusWithBuyOrders()).toEqual(['A', 'B']);
  });

  it('deletes listings by id, ignoring unknown ids', () => {
    repo.upsertListings([makeListing({ id: '1' }), makeListing({ id: '2' }), makeListing({ id: '3' })]);
    repo.deleteListings(['1', '3', 'nope']);
    repo.deleteListings([]);
    expect(repo.getListing('1')).toBeNull();
    expect(repo.getListing('2')).not.toBeNull();
    expect(repo.listingCounts().total).toBe(1);
  });

  describe('deleteListingsNotIn', () => {
    beforeEach(() => {
      repo.upsertListings([
        makeListing({ id: 'a', baseSku: 'X' }),
        makeListing({ id: 'b', baseSku: 'X' }),
        makeListing({ id: 'c', baseSku: 'X' }),
        makeListing({ id: 's', baseSku: 'X', intent: 'sell' }),
        makeListing({ id: 'y', baseSku: 'Y' }),
      ]);
    });

    it('removes only listings of that base SKU and intent missing from keepIds', () => {
      expect(repo.deleteListingsNotIn('X', 'buy', ['a', 'zzz', 'y', 's'])).toBe(2);
      expect(ids(repo.listingsByBaseSku('X', 'buy'))).toEqual(['a']);
      expect(repo.getListing('s')).not.toBeNull();
      expect(repo.getListing('y')).not.toBeNull();
    });

    it('with an empty keep list deletes every listing of that base SKU and intent', () => {
      expect(repo.deleteListingsNotIn('X', 'buy', [])).toBe(3);
      expect(repo.listingsByBaseSku('X', 'buy')).toEqual([]);
      expect(repo.listingsByBaseSku('X', 'sell')).toHaveLength(1);
    });

    it('returns 0 when nothing needs deleting', () => {
      expect(repo.deleteListingsNotIn('X', 'buy', ['a', 'b', 'c'])).toBe(0);
      expect(repo.deleteListingsNotIn('nothing', 'sell', [])).toBe(0);
    });

    it('handles keep lists larger than an IN list', () => {
      const keep = Array.from({ length: 2000 }, (_, i) => `k${i}`).concat('b');
      expect(repo.deleteListingsNotIn('X', 'buy', keep)).toBe(2);
      expect(ids(repo.listingsByBaseSku('X', 'buy'))).toEqual(['b']);
    });
  });

  it('purges listings not seen since a timestamp and returns the count', () => {
    repo.upsertListings([
      makeListing({ id: 'old1', lastEventAt: 100 }),
      makeListing({ id: 'old2', lastEventAt: 199 }),
      makeListing({ id: 'edge', lastEventAt: 200 }),
      makeListing({ id: 'new', lastEventAt: 300 }),
    ]);
    expect(repo.purgeListingsOlderThan(200)).toBe(2);
    expect(repo.purgeListingsOlderThan(200)).toBe(0);
    expect(repo.getListing('edge')).not.toBeNull();
  });

  it('counts listings by intent', () => {
    expect(repo.listingCounts()).toEqual({ total: 0, buy: 0, sell: 0 });
    repo.upsertListings([
      makeListing({ id: '1' }),
      makeListing({ id: '2' }),
      makeListing({ id: '3', intent: 'sell' }),
    ]);
    expect(repo.listingCounts()).toEqual({ total: 3, buy: 2, sell: 1 });
  });

  it('upsertListings is atomic when part of an outer transaction that fails', () => {
    expect(() =>
      repo.transaction(() => {
        repo.upsertListings([makeListing({ id: 'tx' })]);
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(repo.getListing('tx')).toBeNull();
  });
});
