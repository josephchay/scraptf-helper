// 0.9 (history, H8): the live feed's community price recorder (src/service/domain/communityFeed.ts) over a real
// in-memory repo. It writes only tracked bases, only when a SKU's price changes (a memo plus the table's unique index),
// keeps its memo bounded, and on a failure logs once and retries the price on its next report. Storage only.

import { afterEach, describe, expect, it } from 'vitest';
import type { FeedCommunityPrice, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createCommunityFeedRecorder } from '../../src/service/domain/communityFeed';
import { COMMUNITY_FEED_MEMO_MAX } from '../../src/shared/communityHistory';
import type { CommunityPoint } from '../../src/shared/types';
import { createLogger } from '../bptf/helpers';

const T = 1_792_000_000_000;
const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function repo(): Repo {
  const r = openRepo(':memory:');
  repos.push(r);
  return r;
}

const price = (sku: string, value: number, seenAt = T, over: Partial<FeedCommunityPrice> = {}): FeedCommunityPrice => ({
  sku,
  currency: 'metal',
  value,
  valueHigh: null,
  lastUpdate: 1_791_000_000,
  seenAt,
  ...over,
});

describe('createCommunityFeedRecorder', () => {
  it("writes only tracked bases, as source 'feed' recorded at the event's time", () => {
    const r = repo();
    const rec = createCommunityFeedRecorder({ repo: r, log: createLogger() });
    expect(rec.record([price('378;6', 11.55), price('126;6', 2)], new Set(['378;6']))).toBe(1);
    expect(r.communityHistory(['378;6', '126;6'])).toEqual([
      { sku: '378;6', source: 'feed', currency: 'metal', value: 11.55, valueHigh: null, lastUpdate: 1_791_000_000, recordedAt: T },
    ]);
  });

  it('writes a SKU again only when its price changes', () => {
    const r = repo();
    const calls: number[] = [];
    const rec = createCommunityFeedRecorder({
      repo: {
        insertCommunityHistory: (p) => {
          calls.push(p.length);
          return r.insertCommunityHistory(p);
        },
      },
      log: createLogger(),
    });
    const tracked = new Set(['378;6']);
    expect(rec.record([price('378;6', 11.55)], tracked)).toBe(1);
    // The same price reported again (another listing of the item, a later event): no write at all.
    expect(rec.record([price('378;6', 11.55, T + 1_000)], tracked)).toBe(0);
    expect(calls).toEqual([1]);
    expect(rec.record([price('378;6', 11.66, T + 2_000)], tracked)).toBe(1);
    expect(rec.record([price('378;6', 11.66, T + 3_000, { lastUpdate: 1_791_000_500 })], tracked)).toBe(1);
    expect(rec.record([], tracked)).toBe(0);
    expect(r.communityHistory(['378;6']).map((p) => [p.value, p.lastUpdate, p.recordedAt])).toEqual([
      [11.55, 1_791_000_000, T],
      [11.66, 1_791_000_000, T + 2_000],
      [11.66, 1_791_000_500, T + 3_000],
    ]);
  });

  it('adds no row when a new recorder (a restart) writes a point the table holds (the unique index)', () => {
    const r = repo();
    const tracked = new Set(['378;6']);
    expect(createCommunityFeedRecorder({ repo: r, log: createLogger() }).record([price('378;6', 11.55)], tracked)).toBe(1);
    expect(createCommunityFeedRecorder({ repo: r, log: createLogger() }).record([price('378;6', 11.55, T + 60_000)], tracked)).toBe(0);
    expect(r.communityHistory(['378;6'])).toHaveLength(1);
  });

  it(`clears its memo past ${COMMUNITY_FEED_MEMO_MAX.toLocaleString('en-US')} SKUs (the price is offered to the table again)`, () => {
    const written: CommunityPoint[][] = [];
    const rec = createCommunityFeedRecorder({
      repo: {
        insertCommunityHistory: (p) => {
          written.push([...p]);
          return p.length;
        },
      },
      log: createLogger(),
    });
    const skus = Array.from({ length: COMMUNITY_FEED_MEMO_MAX }, (_, i) => `${i + 1};6`);
    const tracked = new Set([...skus, 'extra;6']);
    rec.record(skus.map((s) => price(s, 1)), tracked);
    // Within the cap the memo holds the first SKU.
    expect(rec.record([price('1;6', 1)], tracked)).toBe(0);
    // One more SKU passes the cap: the memo starts over, so the first SKU's same price is offered again.
    rec.record([price('extra;6', 1)], tracked);
    expect(rec.record([price('1;6', 1)], tracked)).toBe(1);
    expect(written.map((w) => w.length)).toEqual([COMMUNITY_FEED_MEMO_MAX, 1, 1]);
  });

  it('logs a failure once per streak, returns 0, and retries the same price on its next report', () => {
    const r = repo();
    const log = createLogger();
    let broken = true;
    const rec = createCommunityFeedRecorder({
      repo: {
        insertCommunityHistory: (p) => {
          if (broken) throw new Error('disk I/O error');
          return r.insertCommunityHistory(p);
        },
      },
      log,
    });
    const tracked = new Set(['378;6']);
    expect(rec.record([price('378;6', 11.55)], tracked)).toBe(0);
    expect(rec.record([price('378;6', 11.55)], tracked)).toBe(0);
    expect(log.lines.filter((l) => l.level === 'warn' && /Could not record backpack\.tf community prices from the live feed/.test(l.msg))).toHaveLength(1);
    broken = false;
    expect(rec.record([price('378;6', 11.55)], tracked)).toBe(1);
    expect(r.communityHistory(['378;6'])).toHaveLength(1);
  });
});
