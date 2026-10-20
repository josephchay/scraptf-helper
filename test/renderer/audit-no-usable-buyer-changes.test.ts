// 0.7.3 (r4-wording-2): a scrap.tf change whose base SKU has eligible backpack.tf buyers but no revenue
// (every order an outlier, or Revenue used for profit on Instant and no realistic bot order) showed "No
// eligible backpack.tf buy order for this item right now." under Sells for and "No eligible buy orders, so
// there is no ceiling." under Pay up to: the event carried only the null revenue. scraptfChangeEvent now
// carries the Live market entry's buyerCount and flags (0 and none without an entry), the feed row says why,
// and a re-value that only changes who buys replaces the row. Pure. No network.

import { describe, expect, it } from 'vitest';
import { changeRowView, createChangesFeed, type ChangesFeedState } from '../../src/renderer/changesModel';
import { scraptfChangeEvent } from '../../src/shared/scraptfHistory';
import type { ScraptfChangeEvent, ScraptfEventStored } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const K = 568;

const STORED: ScraptfEventStored = {
  id: 1,
  at: NOW - 60_000,
  bank: 'hats',
  page: '/buy/hats',
  sku: '378;6',
  specialKey: '',
  name: 'Team Captain',
  kind: 'cheaper',
  fromKeys: 0,
  fromScrap: 12,
  toKeys: 0,
  toScrap: 11,
  fromStock: 2,
  toStock: 2,
  batchId: 7,
};

/** A Live market entry (MarketEval, MarketRow) as the service hands it to the event: buyers, no revenue. */
const entry = (flags: string[], buyerCount = 3) => ({ revenueScrap: null, maxCostScrap: null, buyerCount, flags });

describe('scraptfChangeEvent: who buys', () => {
  it("carries the entry's buyers and flags, 0 and none without an entry, and nothing when not known", () => {
    expect(scraptfChangeEvent(STORED, K, entry(['all-outliers']))).toMatchObject({ revenueScrap: null, buyerCount: 3, flags: ['all-outliers'] });
    expect(scraptfChangeEvent(STORED, K, null)).toMatchObject({ revenueScrap: null, buyerCount: 0, flags: [] });
    const unknown = scraptfChangeEvent(STORED, K, { revenueScrap: 18, maxCostScrap: 13 });
    expect('buyerCount' in unknown || 'flags' in unknown).toBe(false);
  });

  it("copies the flags, so the entry's own array is never shared", () => {
    const e = entry(['all-outliers']);
    const ev = scraptfChangeEvent(STORED, K, e);
    expect(ev.flags).toEqual(e.flags);
    expect(ev.flags).not.toBe(e.flags);
  });
});

describe('scrap.tf changes feed row: Sells for and Pay up to without a usable buyer', () => {
  it('names Instant when no flag says every order is an outlier', () => {
    const v = changeRowView(scraptfChangeEvent(STORED, K, entry([])), K, NOW);
    expect(v.sellsTitle).toBe('3 buyers with eligible orders, but no realistic bot order, and Revenue used for profit is Instant (bot orders only), so no sale price is assumed.');
    expect(v.payTitle).toBe('No realistic bot order, and Revenue used for profit is Instant (bot orders only), so there is no ceiling.');
    expect(changeRowView(scraptfChangeEvent(STORED, K, entry([], 1)), K, NOW).sellsTitle).toMatch(/^1 buyer with eligible orders, but/);
  });

  it("says every order looks unrealistic for 'all-outliers'", () => {
    const v = changeRowView(scraptfChangeEvent(STORED, K, entry(['all-outliers'])), K, NOW);
    expect(v.sellsTitle).toBe('Every eligible order looks unrealistic, so no sale price is assumed.');
    expect(v.payTitle).toBe('Every eligible order looks unrealistic, so there is no ceiling.');
  });

  it('is unchanged without buyers, with a revenue, and from an older service that sends no buyers', () => {
    for (const e of [scraptfChangeEvent(STORED, K, null), scraptfChangeEvent(STORED, K, { revenueScrap: null, maxCostScrap: null })]) {
      const v = changeRowView(e, K, NOW);
      expect(v.sellsTitle).toBe('No eligible backpack.tf buy order for this item right now.');
      expect(v.payTitle).toBe('No eligible buy orders, so there is no ceiling.');
    }
    const priced = changeRowView(scraptfChangeEvent(STORED, K, { revenueScrap: 18, maxCostScrap: null, buyerCount: 3, flags: [] }), K, NOW);
    expect(priced.sellsTitle).toMatch(/^Sells for /);
    expect(priced.payTitle).toBe('No scrap.tf price clears your thresholds against these buyers.');
  });
});

describe('a re-value that only changes who buys', () => {
  it('replaces the row, so its hovers follow', async () => {
    let answer: ScraptfChangeEvent[] = [scraptfChangeEvent(STORED, K, null)];
    const states: ChangesFeedState[] = [];
    const feed = createChangesFeed(
      () => Promise.resolve(answer),
      (s) => states.push(s),
    );
    const flush = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    feed.load({ bank: '', kinds: [] });
    await flush();
    const before = states[states.length - 1]!.events[0]!;
    expect(changeRowView(before, K, NOW).sellsTitle).toBe('No eligible backpack.tf buy order for this item right now.');
    // Buyers arrived, none usable: revenue, Pay up to and flip are as they were.
    answer = [scraptfChangeEvent(STORED, K, entry(['all-outliers']))];
    feed.revalue(1);
    await flush();
    const after = states[states.length - 1]!.events[0]!;
    expect(after).not.toBe(before);
    expect(changeRowView(after, K, NOW).sellsTitle).toBe('Every eligible order looks unrealistic, so no sale price is assumed.');
    // Nothing moved: the row keeps its object.
    const n = states.length;
    answer = [scraptfChangeEvent(STORED, K, entry(['all-outliers']))];
    feed.revalue(1);
    await flush();
    expect(states).toHaveLength(n);
    feed.dispose();
  });
});
