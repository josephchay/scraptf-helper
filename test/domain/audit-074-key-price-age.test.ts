// 0.7.4 (F71): backpack.tf's key price is its community price, which can stand unchanged for weeks while
// IGetCurrencies is fetched every hour. The quote keeps its source's own price time (priceAt, key_prices.price_at)
// beside the fetch time, the app shows that real age, and warns when a fresh second source disagrees by 1 ref or
// more. The documented source priority (backpack.tf, then PriceDB) and the 6 h fetch gate are unchanged.

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepo } from '../../src/service/db';
import type { Repo } from '../../src/service/contracts';
import { KEY_PRICE_DIVERGENCE_SCRAP, selectKeyPrice } from '../../src/service/domain/keyprice';
import { keyPriceNotes } from '../../src/renderer/format';
import { KeyPriceTable } from '../../src/renderer/pages/HealthPage';
import type { KeyPriceQuote } from '../../src/shared/types';
import { HOUR, T0, testSettings } from './helpers';

const DAY = 24 * HOUR;
const AUG_9 = 1_786_294_413_000;
const auto = testSettings();
const q = (source: KeyPriceQuote['source'], buyScrap: number, ageMs = 0, priceAt?: number | null): KeyPriceQuote => ({
  source,
  buyScrap,
  sellScrap: buyScrap + 8,
  observedAt: T0 - ageMs,
  ...(priceAt !== undefined ? { priceAt } : {}),
});

describe('key_prices.price_at (V14)', () => {
  let repo: Repo;
  beforeEach(() => {
    repo = openRepo(':memory:');
  });
  afterEach(() => repo.close());

  it('stores and reads the price time; unknown reads as absent, never as the fetch time', () => {
    repo.upsertKeyQuote({ source: 'bptf', buyScrap: 577, sellScrap: 585, observedAt: T0, priceAt: AUG_9 });
    repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 585, sellScrap: 588, observedAt: T0 - 1000 });
    expect(repo.keyQuotes()).toEqual([
      { source: 'bptf', buyScrap: 577, sellScrap: 585, observedAt: T0, priceAt: AUG_9 },
      { source: 'pricedb', buyScrap: 585, sellScrap: 588, observedAt: T0 - 1000 },
    ]);
    // A later quote without one clears it rather than keeping an older price's date.
    repo.upsertKeyQuote({ source: 'bptf', buyScrap: 578, sellScrap: 585, observedAt: T0 + 1000, priceAt: null });
    expect(repo.keyQuotes()[0]).toEqual({ source: 'bptf', buyScrap: 578, sellScrap: 585, observedAt: T0 + 1000 });
  });
});

describe('selectKeyPrice priceAt and divergence', () => {
  it("keeps backpack.tf first and carries its price's own time", () => {
    const r = selectKeyPrice([q('bptf', 577, 11 * 60_000, AUG_9), q('pricedb', 585, 15 * 60_000, T0 - 15 * 60_000)], auto, T0);
    expect(r).toMatchObject({ valueScrap: 577, source: 'bptf', stale: false, observedAt: T0 - 11 * 60_000, priceAt: AUG_9, divergence: null });
  });

  it('reports a fresh second source 1 ref or more apart, on either side', () => {
    expect(KEY_PRICE_DIVERGENCE_SCRAP).toBe(9);
    // The audited profile: 577 against 585 is 8 scrap (0.89 ref), under the warning.
    expect(selectKeyPrice([q('bptf', 577), q('pricedb', 585)], auto, T0).divergence).toBeNull();
    expect(selectKeyPrice([q('bptf', 577), q('pricedb', 586)], auto, T0).divergence).toEqual({ otherSource: 'pricedb', otherScrap: 586, deltaScrap: 9 });
    expect(selectKeyPrice([q('bptf', 590), q('pricedb', 577)], auto, T0).divergence).toEqual({ otherSource: 'pricedb', otherScrap: 577, deltaScrap: -13 });
  });

  it('never compares with a stale quote, and reports nothing in manual mode or on a stale pick', () => {
    expect(selectKeyPrice([q('bptf', 577), q('pricedb', 600, 7 * HOUR)], auto, T0).divergence).toBeNull();
    const manual = testSettings({ keyPrice: { mode: 'manual', manualScrap: 560 } });
    const m = selectKeyPrice([q('bptf', 577), q('pricedb', 600)], manual, T0);
    expect(m.source).toBe('manual');
    expect(m.divergence ?? null).toBeNull();
    const stale = selectKeyPrice([q('bptf', 577, 8 * HOUR, AUG_9), q('pricedb', 600, 9 * HOUR)], auto, T0);
    expect(stale).toMatchObject({ source: 'bptf', stale: true, priceAt: AUG_9 });
    expect(stale.divergence ?? null).toBeNull();
  });

  it('the value in use is unchanged by the new fields (same key price, same engine fingerprint)', () => {
    const before = selectKeyPrice([{ source: 'bptf', buyScrap: 577, sellScrap: 585, observedAt: T0 }], auto, T0);
    const after = selectKeyPrice([{ source: 'bptf', buyScrap: 577, sellScrap: 585, observedAt: T0, priceAt: AUG_9 }], auto, T0);
    expect(after.valueScrap).toBe(before.valueScrap);
    expect(before.priceAt).toBeNull();
  });
});

describe('the real age on screen', () => {
  it('says when the source set the price, beside the fetch age', () => {
    const kp = selectKeyPrice([q('bptf', 577, 11 * 60_000, T0 - 72 * DAY)], auto, T0);
    const n = keyPriceNotes(kp, T0);
    expect(n.priceSet).toBe('set 2 mo ago');
    expect(n.priceSetTitle).toMatch(/^backpack\.tf last changed this price .*; the quote was checked 11 min ago\.$/);
    expect(n.divergence).toBeNull();
  });

  it('says nothing when the price is as fresh as the quote, or its time is unknown', () => {
    expect(keyPriceNotes(selectKeyPrice([q('pricedb', 585, 15 * 60_000, T0 - 15 * 60_000)], auto, T0), T0).priceSet).toBeNull();
    expect(keyPriceNotes(selectKeyPrice([q('bptf', 577)], auto, T0), T0)).toEqual({ priceSet: null, priceSetTitle: null, divergence: null });
  });

  it('words a disagreeing source', () => {
    const kp = selectKeyPrice([q('bptf', 577), q('pricedb', 588)], auto, T0);
    expect(keyPriceNotes(kp, T0).divergence).toBe('PriceDB values a key at 65.33 ref (1.22 ref higher). Set a manual key price in Settings if you trade at that price.');
  });

  it("Data health lists each quote's price time", () => {
    const kp = selectKeyPrice([q('bptf', 577, 11 * 60_000, T0 - 72 * DAY), q('pricedb', 588, 0, T0)], auto, T0);
    const html = renderToString(createElement(KeyPriceTable, { kp, typed: null, now: T0 })).replace(/<!-- -->/g, '');
    expect(html).toContain('Price set</th>');
    expect(html).toContain('2 mo ago</td>');
    expect(html).toContain(', price set 2 mo ago</span>');
    expect(html).toContain('PriceDB values a key at 65.33 ref');
  });
});
