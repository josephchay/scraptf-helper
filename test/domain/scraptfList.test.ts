// F14: the in-memory scrap.tf price list cache (src/service/domain/scraptfList.ts). It reads the
// saved list once and on refresh(), values rows at the caller's key price (else the engine's, read
// once until keyPriceChanged), and its key row never reads the key price. No network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createScraptfListCache } from '../../src/service/domain/scraptfList';
import { KEY_SKU, type KeyPriceState, type ScraptfListStored } from '../../src/shared/types';
import { T0, recordingLogger, testSettings } from './helpers';

const MIN = 60_000;
const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function row(over: Partial<ScraptfListStored> & { sku: string }): ScraptfListStored {
  return { name: over.sku, sellsKeys: 0, sellsScrap: 30, paysKeys: 0, paysScrap: 24, stock: 1, stockLimit: 5, batchId: 1, observedAt: T0, ...over };
}

function setup(rows: ScraptfListStored[] = []) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertScraptfList(rows);
  const log = recordingLogger();
  let K = 568;
  let keyReads = 0;
  const keyPrice = (): KeyPriceState => {
    keyReads++;
    return { valueScrap: K, source: 'pricedb', observedAt: T0, stale: false, quotes: [], scraptfFromList: null };
  };
  const reads = { n: 0 };
  const counted: Pick<Repo, 'scraptfList'> = {
    scraptfList: () => {
      reads.n++;
      return repo.scraptfList();
    },
  };
  const cache = createScraptfListCache({ repo: counted, log, keyPrice });
  return { repo, log, cache, reads, setK: (v: number) => (K = v), keyReads: () => keyReads };
}

describe('createScraptfListCache', () => {
  it('loads once on first use and answers rows by SKU without further reads', () => {
    const h = setup([row({ sku: '378;6', sellsKeys: 1, sellsScrap: 9 }), row({ sku: '126;6' })]);
    expect(h.reads.n).toBe(0);
    expect(h.cache.rowFor('378;6')).toMatchObject({ sku: '378;6', sellsScrap: 568 + 9, sellsScrapRaw: 9, sellsKeys: 1 });
    expect(h.cache.rowFor('126;6')).toMatchObject({ sellsScrap: 30, paysScrap: 24 });
    expect(h.cache.rowFor('999;6')).toBeNull();
    expect(h.cache.all().map((r) => r.sku)).toEqual(['126;6', '378;6']);
    expect(h.reads.n).toBe(1);
  });

  it('finds a painted or uncanonical SKU under its base row', () => {
    const h = setup([row({ sku: '378;6' })]);
    expect(h.cache.rowFor('378;6;p15185211')?.sku).toBe('378;6');
    expect(h.cache.rowFor(' 378;6 ')?.sku).toBe('378;6');
    expect(h.cache.rowFor('not a sku')).toBeNull();
    expect(h.cache.rowFor(42 as unknown as string)).toBeNull();
    expect(h.cache.has('378;6;p15185211')).toBe(true);
    expect(h.cache.has('126;6')).toBe(false);
  });

  it("values at the caller's key price, else the engine's, read once until keyPriceChanged", () => {
    const h = setup([row({ sku: '378;6', sellsKeys: 1, sellsScrap: 0, paysKeys: 0, paysScrap: 400 })]);
    expect(h.cache.rowFor('378;6', 600)!.sellsScrap).toBe(600);
    expect(h.keyReads()).toBe(0);
    expect(h.cache.rowFor('378;6')!.sellsScrap).toBe(568);
    expect(h.cache.rowFor('378;6')!.sellsScrap).toBe(568);
    expect(h.keyReads()).toBe(1);
    h.setK(580);
    expect(h.cache.rowFor('378;6')!.sellsScrap).toBe(568);
    const v = h.cache.version();
    h.cache.keyPriceChanged();
    expect(h.cache.version()).toBeGreaterThan(v);
    expect(h.cache.rowFor('378;6')!.sellsScrap).toBe(580);
    expect(h.keyReads()).toBe(2);
  });

  it('hands out copies', () => {
    const h = setup([row({ sku: '378;6' })]);
    const a = h.cache.rowFor('378;6')!;
    a.sellsScrap = -1;
    expect(h.cache.rowFor('378;6')!.sellsScrap).toBe(30);
  });

  it('summarises rows, ages and pages', () => {
    const h = setup([row({ sku: 'a;6', batchId: 4, observedAt: T0 - 10 * MIN }), row({ sku: 'b;6', batchId: 5, observedAt: T0 - 2 * MIN })]);
    expect(h.cache.summary()).toEqual({ items: 2, newestAt: T0 - 2 * MIN, oldestAt: T0 - 10 * MIN, batches: 2 });
    expect(setup().cache.summary()).toEqual({ items: 0, newestAt: null, oldestAt: null, batches: 0 });
  });

  it('re-reads on refresh and tells its listeners, which can unsubscribe', () => {
    const h = setup([row({ sku: 'a;6' })]);
    const seen: number[] = [];
    const off = h.cache.onChanged((s) => seen.push(s.items));
    expect(h.cache.summary().items).toBe(1);
    h.repo.upsertScraptfList([row({ sku: 'b;6' })]);
    // Not re-read until refresh: the import tells the cache.
    expect(h.cache.rowFor('b;6')).toBeNull();
    const v = h.cache.version();
    h.cache.refresh();
    expect(h.cache.version()).toBeGreaterThan(v);
    expect(h.cache.rowFor('b;6')?.sku).toBe('b;6');
    expect(seen).toEqual([2]);
    off();
    h.cache.refresh();
    expect(seen).toEqual([2]);
  });

  it('keeps the last good rows when a read fails, logs once per streak and tells nobody', () => {
    const repo = openRepo(':memory:');
    repos.push(repo);
    repo.upsertScraptfList([row({ sku: 'a;6' })]);
    let fail = false;
    const log = recordingLogger();
    const cache = createScraptfListCache({
      repo: {
        scraptfList: () => {
          if (fail) throw new Error('database is locked');
          return repo.scraptfList();
        },
      },
      log,
      keyPrice: () => selectKeyPrice([], testSettings(), T0),
    });
    const seen: number[] = [];
    cache.onChanged((s) => seen.push(s.items));
    expect(cache.rowFor('a;6')).not.toBeNull();
    fail = true;
    cache.refresh();
    cache.refresh();
    expect(cache.rowFor('a;6')).not.toBeNull();
    expect(seen).toEqual([]);
    expect(log.lines.filter((l) => l.level === 'warn')).toHaveLength(1);
    fail = false;
    cache.refresh();
    expect(seen).toEqual([1]);
  });

  it('answers an empty list when the first read fails, without reading again per row', () => {
    let reads = 0;
    const cache = createScraptfListCache({
      repo: {
        scraptfList: () => {
          reads++;
          throw new Error('no such table');
        },
      },
      log: recordingLogger(),
      keyPrice: () => selectKeyPrice([], testSettings(), T0),
    });
    expect(cache.rowFor('378;6')).toBeNull();
    expect(cache.rowFor('126;6')).toBeNull();
    expect(cache.all()).toEqual([]);
    expect(cache.keyRow()).toBeNull();
    expect(reads).toBe(1);
  });

  it('gives the key row raw without reading the key price', () => {
    const h = setup([row({ sku: KEY_SKU, sellsScrap: 573, paysScrap: 561, observedAt: T0 - MIN })]);
    expect(h.cache.keyRow()).toEqual({ sellsScrap: 573, paysScrap: 561, observedAt: T0 - MIN });
    expect(h.keyReads()).toBe(0);
    expect(setup([row({ sku: '378;6' })]).cache.keyRow()).toBeNull();
  });

  it('lets the key price read the key row while valuing rows (no cycle)', () => {
    const repo = openRepo(':memory:');
    repos.push(repo);
    repo.upsertScraptfList([row({ sku: KEY_SKU, sellsScrap: 560, paysScrap: 550 }), row({ sku: '378;6', sellsKeys: 1, sellsScrap: 0 })]);
    const settings = testSettings();
    const quotes = [{ source: 'pricedb' as const, buyScrap: 600, sellScrap: 610, observedAt: T0 }];
    // As core wires it: the engine's key price reads the cache's key row.
    const cache = createScraptfListCache({ repo, log: recordingLogger(), keyPrice: () => selectKeyPrice(quotes, settings, T0, cache.keyRow()) });
    // The list pays 550 for a key, so the 600 quote is capped and a 1-key row is worth 550.
    expect(cache.rowFor('378;6')!.sellsScrap).toBe(550);
  });
});
