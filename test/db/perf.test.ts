import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openRepo } from '../../src/service/db';
import type { Repo } from '../../src/service/contracts';
import type { Listing } from '../../src/shared/types';
import { makeListing, tempDir } from './helpers';

const N = 100_000;
const BASE_SKUS = 2_000;

function buildListings(): Listing[] {
  const rows: Listing[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const base = `${i % BASE_SKUS};6`;
    const painted = i % 10 === 0;
    rows[i] = makeListing({
      id: `440_${1_000_000 + i}`,
      sku: painted ? `${base};p3100495` : base,
      baseSku: base,
      // Every base SKU gets 40 buy orders and 10 sell listings.
      intent: Math.floor(i / BASE_SKUS) % 5 === 0 ? 'sell' : 'buy',
      steamid: `7656119800${String(i % 50_000).padStart(7, '0')}`,
      keys: i % 7,
      metalScrap: i % 90,
      isBot: i % 3 === 0,
      userOnline: i % 5 === 0 ? null : i % 2 === 0,
      special: painted
        ? { paint: 3100495, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false }
        : makeListing().special,
      details: i % 2 ? 'buying for keys and metal, send offer' : '',
      lastEventAt: 1_791_958_000_000 + i,
    });
  }
  return rows;
}

describe('performance (file database)', () => {
  const t = tempDir('flipdesk-perf-');
  let repo: Repo;
  let rows: Listing[];

  beforeAll(() => {
    repo = openRepo(t.file());
    rows = buildListings();
  });

  afterAll(() => {
    repo.close();
    t.cleanup();
  });

  it(`upserts ${N} listings in one call well under 5 s`, () => {
    const t0 = performance.now();
    repo.upsertListings(rows);
    const ms = performance.now() - t0;
    console.info(`[perf] insert ${N} listings: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(5000);
    expect(repo.listingCounts()).toEqual({ total: N, buy: N * 0.8, sell: N * 0.2 });
  });

  it(`re-upserts (updates) ${N} existing listings well under 5 s`, () => {
    const updated = rows.map((l) => ({ ...l, metalScrap: l.metalScrap + 1, lastEventAt: l.lastEventAt + 1 }));
    const t0 = performance.now();
    repo.upsertListings(updated);
    const ms = performance.now() - t0;
    console.info(`[perf] update ${N} listings: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(5000);
    expect(repo.getListing(rows[1]!.id)!.metalScrap).toBe(rows[1]!.metalScrap + 1);
    expect(repo.listingCounts().total).toBe(N);
  });

  it('loads buy listings for 1000 base SKUs quickly', () => {
    const skus = Array.from({ length: 1000 }, (_, i) => `${i};6`);
    const t0 = performance.now();
    const m = repo.buyListingsByBaseSkus(skus);
    const ms = performance.now() - t0;
    const total = [...m.values()].reduce((n, l) => n + l.length, 0);
    console.info(`[perf] buyListingsByBaseSkus(1000) -> ${total} rows: ${ms.toFixed(0)} ms`);
    expect(m.size).toBe(1000);
    expect(total).toBe(40 * 1000);
    expect(ms).toBeLessThan(1500);
  });

  it('answers per-SKU lookups and maintenance queries quickly', () => {
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) repo.listingsByBaseSku(`${i};6`, 'buy');
    const lookups = performance.now() - t0;
    const t1 = performance.now();
    const skus = repo.baseSkusWithBuyOrders();
    const distinct = performance.now() - t1;
    const t2 = performance.now();
    const purged = repo.purgeListingsOlderThan(1_791_958_000_000 + 1 + 1000);
    const purge = performance.now() - t2;
    console.info(
      `[perf] 1000 listingsByBaseSku: ${lookups.toFixed(0)} ms; baseSkusWithBuyOrders: ${distinct.toFixed(0)} ms; purge: ${purge.toFixed(0)} ms`,
    );
    expect(skus).toHaveLength(BASE_SKUS);
    expect(purged).toBe(1000);
    expect(lookups).toBeLessThan(2000);
    expect(distinct).toBeLessThan(1000);
  });
});
