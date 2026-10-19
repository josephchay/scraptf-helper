// F20 additions to the F17 bank stock rules (src/shared/bankStock.ts): a row's listedSince, firstSeenAt
// and changeSinceListed from the runs index, the 'long-listed' and 'dropped' filters with their counts,
// and the 'listed' and 'sinceListed' sorts. Pure; nothing here touches the network or scrap.tf.

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import {
  SCRAPTF_LONG_LISTED_MS,
  bankStockComparator,
  bankStockCounts,
  bankStockDefaultDir,
  bankStockDropped,
  bankStockFilterMatches,
  bankStockLongListed,
  bankStockMatching,
  bankStockMinListedMs,
  bankStockResult,
  bankStockRow,
  bankStockRows,
  diffBankStock,
  scraptfPriceChange,
} from '../../src/shared/bankStock';
import type { BankStockRow, BankStockStored, ScraptfKeyRun } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const HOUR = 3_600_000;
const K = 600;

function stored(sku: string, costScrap: number | null, stock: number | null = 1, costKeys = 0): BankStockStored {
  return { sku, specialKey: '', name: `Item ${sku}`, costKeys: costScrap === null ? null : costKeys, costScrap, stock, assetId: null };
}

function run(over: Partial<ScraptfKeyRun> = {}): ScraptfKeyRun {
  return { key: '1;6|', sku: '1;6', specialKey: '', seenAt: NOW - 50 * HOUR, firstSeenAt: NOW - 48 * HOUR, lastSeenAt: NOW, listedSince: NOW - 30 * HOUR, runStart: { keys: 0, scrap: 30 }, current: { keys: 0, scrap: 27, stock: 1 }, ...over };
}

const args = { category: 'hats' as const, buy: null, keyScrap: K, profit: DEFAULT_SETTINGS.profit };

describe('BankStockRow listed fields (F20)', () => {
  it('fills them from the run: listed since, first seen, the change since listed on the raw prices', () => {
    const [d] = diffBankStock([stored('1;6', 27)], [stored('1;6', 27)], K);
    const r = bankStockRow(d!, { ...args, run: run() })!;
    expect(r).toMatchObject({ listedSince: NOW - 30 * HOUR, firstSeenAt: NOW - 48 * HOUR, changeSinceListed: { fromScrap: 30, toScrap: 27, deltaScrap: -3, since: NOW - 30 * HOUR } });
    expect(r.changeSinceListed!.pct).toBeCloseTo(-0.1);
    // Without a run (a stub, a bank never indexed) they are null.
    expect(bankStockRow(d!, args)).toMatchObject({ listedSince: null, firstSeenAt: null, changeSinceListed: null });
  });

  it('a gone row has no current run; its first sighting stays', () => {
    const [d] = diffBankStock([], [stored('1;6', 27)], K);
    expect(d!.change).toBe('gone');
    expect(bankStockRow(d!, { ...args, run: run() })).toMatchObject({ listedSince: null, firstSeenAt: NOW - 48 * HOUR, changeSinceListed: null });
  });

  it('values keys at the key price now: a key move alone is no change', () => {
    expect(scraptfPriceChange({ keys: 1, scrap: 9 }, { keys: 1, scrap: 9 }, NOW, 640)).toEqual({ fromScrap: 649, toScrap: 649, deltaScrap: 0, pct: 0, since: NOW });
    expect(scraptfPriceChange({ keys: 1, scrap: 0 }, { keys: 0, scrap: 590 }, NOW, K)).toMatchObject({ fromScrap: 600, toScrap: 590, deltaScrap: -10 });
    expect(scraptfPriceChange({ keys: 0, scrap: 0 }, { keys: 0, scrap: 5 }, NOW, K).pct).toBeNull();
  });

  it('bankStockRows passes each key its run', () => {
    const rows = bankStockRows({
      newest: [stored('1;6', 27), stored('2;6', 10)],
      previous: [stored('1;6', 27)],
      keyScrap: K,
      profit: DEFAULT_SETTINGS.profit,
      categoryOf: () => 'hats',
      buySideOf: () => null,
      runOf: (key) => (key === '1;6|' ? run() : null),
    });
    expect(rows.map((r) => [r.sku, r.listedSince])).toEqual([
      ['1;6', NOW - 30 * HOUR],
      ['2;6', null],
    ]);
  });
});

describe("filters 'long-listed' and 'dropped', their counts and sorts", () => {
  const base = bankStockRow(diffBankStock([stored('1;6', 27)], [stored('1;6', 27)], K)[0]!, args)!;
  const row = (over: Partial<BankStockRow>): BankStockRow => ({ ...base, ...over });
  const change = (deltaScrap: number, pct: number | null = deltaScrap / 30) => ({ fromScrap: 30, toScrap: 30 + deltaScrap, deltaScrap, pct, since: NOW - HOUR });
  const rows: BankStockRow[] = [
    row({ key: 'a', name: 'A', listedSince: NOW - 30 * HOUR, changeSinceListed: change(-3) }),
    row({ key: 'b', name: 'B', listedSince: NOW - 2 * HOUR, changeSinceListed: change(0) }),
    row({ key: 'c', name: 'C', listedSince: NOW - SCRAPTF_LONG_LISTED_MS, changeSinceListed: change(6) }),
    row({ key: 'd', name: 'D', listedSince: null, changeSinceListed: null }),
    row({ key: 'e', name: 'E', change: 'gone', listedSince: NOW - 90 * HOUR, changeSinceListed: change(-9) }),
    row({ key: 'f', name: 'F', listedSince: NOW - 70 * HOUR, changeSinceListed: change(-1, null) }),
  ];
  const keys = (rs: readonly BankStockRow[]) => rs.map((r) => r.key);

  it('long-listed: on sale and listed at least minListedMs (24 h by default); dropped: cheaper since listed', () => {
    expect(bankStockMinListedMs({})).toBe(24 * HOUR);
    expect(bankStockMinListedMs({ minListedMs: 2 * HOUR })).toBe(2 * HOUR);
    expect(bankStockMinListedMs({ minListedMs: -1 })).toBe(24 * HOUR);
    expect(keys(rows.filter((r) => bankStockLongListed(r, NOW)))).toEqual(['a', 'c', 'f']);
    expect(keys(rows.filter((r) => bankStockLongListed(r, NOW, 2 * HOUR)))).toEqual(['a', 'b', 'c', 'f']);
    expect(keys(rows.filter(bankStockDropped))).toEqual(['a', 'f']);
    // Without `now`, 'long-listed' matches nothing; 'dropped' needs none.
    expect(rows.some((r) => bankStockFilterMatches(r, 'long-listed'))).toBe(false);
    expect(keys(rows.filter((r) => bankStockFilterMatches(r, 'long-listed', { now: NOW })))).toEqual(['a', 'c', 'f']);
    expect(keys(rows.filter((r) => bankStockFilterMatches(r, 'dropped')))).toEqual(['a', 'f']);
  });

  it('counts both chips over the whole bank', () => {
    expect(bankStockCounts(rows, 6, { now: NOW })).toMatchObject({ inStock: 5, gone: 1, longListed: 3, dropped: 2 });
    expect(bankStockCounts(rows, 6, { now: NOW, minListedMs: 2 * HOUR }).longListed).toBe(4);
    expect(bankStockCounts(rows, 6).longListed).toBe(0);
  });

  it("sorts by time listed (longest first) and by the change since listed (biggest drop first), missing values last", () => {
    expect(bankStockDefaultDir('listed')).toBe('desc');
    expect(bankStockDefaultDir('sinceListed')).toBe('asc');
    const live = rows.filter((r) => r.change !== 'gone');
    expect(keys([...live].sort(bankStockComparator('listed', undefined)))).toEqual(['f', 'a', 'c', 'b', 'd']);
    expect(keys([...live].sort(bankStockComparator('listed', 'asc')))).toEqual(['b', 'c', 'a', 'f', 'd']);
    // A drop with no percentage (from 0) reads as missing, except a 0 change.
    expect(keys([...live].sort(bankStockComparator('sinceListed', undefined)))).toEqual(['a', 'b', 'c', 'd', 'f']);
    expect(keys([...live].sort(bankStockComparator('sinceListed', 'desc')))).toEqual(['c', 'b', 'a', 'd', 'f']);
  });

  it('a whole answer filters with the time it was asked at', () => {
    const r = bankStockResult({ q: { bank: 'hats', filter: 'long-listed', minListedMs: 40 * HOUR }, rows, items: 6, savedAt: NOW, previousSavedAt: NOW - HOUR, saves: 2, keyPrice: null, now: NOW });
    expect(keys(r.rows)).toEqual(['f']);
    expect(r.counts).toMatchObject({ longListed: 1, dropped: 2 });
    expect(keys(bankStockMatching(rows, { filter: 'long-listed' }, NOW))).toEqual(['a', 'c', 'f']);
    expect(bankStockMatching(rows, { filter: 'long-listed' })).toEqual([]);
  });
});
