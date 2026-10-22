// 0.9 (history, H11): 'item.bookHistory''s read (src/service/domain/bookHistory.ts) over a real in-memory repo. Every
// base of the item's book is read (a schema double names the twin), the asked orders are looked up in the local book
// (only buy orders of those bases count), and the ids are deduplicated and capped. Local reads only.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { readItemBookHistory } from '../../src/service/domain/bookHistory';
import { BOOK_HISTORY_ORDERS_MAX, ORDER_SPELLS_MAX_AGE_MS } from '../../src/shared/orderPersistence';
import type { OrderSpell } from '../../src/shared/types';
import { HOUR, MIN, T0, makeListing } from './helpers';

const BASE = '205;11;australium';
const TWIN = '18;11;australium';
const DAY = 24 * HOUR;
const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

/** The book of the Strange Australium Rocket Launcher sits under both defindexes (bookTwins.ts). */
const schema: Pick<SchemaService, 'bookBases' | 'bookBase'> = {
  bookBases: (b) => (b === BASE || b === TWIN ? [BASE, TWIN] : [b]),
  bookBase: (b) => (b === TWIN ? BASE : b),
};

const spell = (baseSku: string, firstSeenAt: number, over: Partial<Omit<OrderSpell, 'id'>> = {}): Omit<OrderSpell, 'id'> => ({
  baseSku,
  intent: 'buy',
  isBot: true,
  keys: 2,
  metalScrap: 0,
  listedAt: Math.floor((firstSeenAt - HOUR) / 1000),
  firstSeenAt,
  lastSeenAt: firstSeenAt + 30 * MIN,
  endAt: firstSeenAt + 30 * MIN,
  endKind: 'deleted',
  ...over,
});

function seeded() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.insertOrderSpell(spell(BASE, T0 - 2 * DAY));
  repo.insertOrderSpell(spell(TWIN, T0 - DAY, { endKind: 'inactive' }));
  repo.insertOrderSpell(spell(TWIN, T0 - HOUR, { endAt: null, endKind: null }));
  // Older than the read reaches back, and another item's.
  repo.insertOrderSpell(spell(BASE, T0 - ORDER_SPELLS_MAX_AGE_MS - DAY));
  repo.insertOrderSpell(spell('378;6', T0 - DAY));
  repo.insertCommunityHistory([
    { sku: BASE, source: 'prices', currency: 'keys', value: 30, valueHigh: 32, lastUpdate: 1_791_000_000, recordedAt: T0 - 5 * DAY },
    { sku: TWIN, source: 'feed', currency: 'keys', value: 30, valueHigh: 32, lastUpdate: 1_791_000_000, recordedAt: T0 - 4 * DAY },
    { sku: TWIN, source: 'feed', currency: 'keys', value: 31, valueHigh: null, lastUpdate: 1_791_100_000, recordedAt: T0 - DAY },
    { sku: '378;6', source: 'prices', currency: 'metal', value: 1, valueHigh: null, lastUpdate: 1_791_100_000, recordedAt: T0 - DAY },
  ]);
  repo.upsertCommunity([{ sku: BASE, currency: 'keys', value: 31, valueHigh: null, lastUpdate: 1_791_100_000 }]);
  repo.upsertListings([
    makeListing({ id: 'buy-base', sku: BASE, baseSku: BASE, keys: 2, metalScrap: 0, isBot: true, listedAt: Math.floor((T0 - 3 * HOUR) / 1000) }),
    makeListing({ id: 'buy-twin', sku: TWIN, baseSku: TWIN, keys: 1, metalScrap: 27, isBot: false, listedAt: null }),
    makeListing({ id: 'sell-base', sku: BASE, baseSku: BASE, intent: 'sell', keys: 3, metalScrap: 0 }),
    makeListing({ id: 'buy-other', sku: '378;6', baseSku: '378;6', keys: 0, metalScrap: 27 }),
  ]);
  return repo;
}

describe('readItemBookHistory', () => {
  it("reads every base of the book: the spells, the community points, the base's stored price and the asked buy orders", () => {
    const repo = seeded();
    const h = readItemBookHistory({ repo, schema, base: BASE, orders: ['buy-base', 'sell-base', 'buy-other', 'gone', 'buy-twin'], keyScrap: 500, now: T0 });
    expect(h.sku).toBe(BASE);
    expect(h.bases).toEqual([BASE, TWIN]);
    // Two ended under the two bases and one followed now; the old one and another item's are not read.
    expect(h.summary).toMatchObject({ followed: 3, deleted: 1, inactive: 1, open: 1, since: T0 - 2 * DAY });
    // A sell listing, another item's buy order and an unknown id are left out; the order of the ask is kept.
    expect(h.orders.map((o) => [o.listingId, o.isBot, o.valueScrap, o.listedAt])).toEqual([
      ['buy-base', true, 1000, Math.floor((T0 - 3 * HOUR) / 1000)],
      ['buy-twin', false, 527, null],
    ]);
    expect(h.orders[0]!.persistence.ageMs).toBe(3 * HOUR);
    expect(h.orders[1]!.persistence.short).toBe('no-listed-time');
    // Both twins' points join into one step per price; the stored current price is already among them.
    expect(h.community.steps.map((s) => [s.value, s.sources, s.recordedAt])).toEqual([
      [30, ['feed', 'prices'], T0 - 5 * DAY],
      [31, ['feed'], T0 - DAY],
    ]);
    expect(h.community).toMatchObject({ since: T0 - 5 * DAY, recorded: 3 });
    expect(h).toMatchObject({ keyScrap: 500, generatedAt: T0 });
  });

  it('dedupes the asked ids and reads at most five', () => {
    const repo = seeded();
    const ids = ['buy-base', 'buy-base', 'x1', 'x2', 'x3', 'x4', 'buy-twin'];
    const asked: string[] = [];
    const spy: Pick<Repo, 'orderSpells' | 'communityHistory' | 'getCommunity' | 'getListing'> = {
      orderSpells: (b, s, l) => repo.orderSpells(b, s, l),
      communityHistory: (s, l) => repo.communityHistory(s, l),
      getCommunity: (s) => repo.getCommunity(s),
      getListing: (id) => {
        asked.push(id);
        return repo.getListing(id);
      },
    };
    const h = readItemBookHistory({ repo: spy, schema, base: BASE, orders: ids, keyScrap: 500, now: T0 });
    expect(asked).toEqual(['buy-base', 'x1', 'x2', 'x3', 'x4']);
    expect(asked).toHaveLength(BOOK_HISTORY_ORDERS_MAX);
    expect(h.orders.map((o) => o.listingId)).toEqual(['buy-base']);
  });

  it('reads the base alone without a schema, and answers an item with nothing recorded', () => {
    const repo = seeded();
    const alone = readItemBookHistory({ repo, schema: null, base: BASE, orders: ['buy-twin'], keyScrap: null, now: T0 });
    expect(alone.bases).toEqual([BASE]);
    expect(alone.summary.followed).toBe(1);
    expect(alone.orders).toEqual([]);
    expect(alone.keyScrap).toBeNull();
    const none = readItemBookHistory({ repo, schema, base: '126;6', orders: [], keyScrap: 500, now: T0 });
    expect(none.summary).toMatchObject({ followed: 0, since: null });
    expect(none.community).toEqual({ steps: [], since: null, recorded: 0 });
  });
});
