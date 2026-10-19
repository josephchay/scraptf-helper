// F20 S1: bank_stock retention as a pure policy (bankStockThinning in src/shared/bankStock.ts), table
// driven (tiers 0.7.1): every save of the last 2 h (at most 300 per page), the newest per 10 minutes to
// 24 h, the newest per UTC hour to 7 days, the newest per UTC day to 90 days, nothing older; a page's
// newest save, the one it is compared with and its session baseline are never deleted. Pure; nothing
// here touches a database or the network. test/shared/bankStockThinningTiers.test.ts covers heavy use.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BANK_STOCK_HOURLY_MS,
  BANK_STOCK_KEEP_ALL_MS,
  BANK_STOCK_MAX_AGE_MS,
  BANK_STOCK_MAX_SAVES_PER_PAGE,
  BANK_STOCK_RECENT_BUCKET_MS,
  BANK_STOCK_RECENT_TIER_MS,
  bankStockThinning,
  type BankStockThinSave,
} from '../../src/shared/bankStock';
import type { ScraptfBank } from '../../src/shared/types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Noon UTC: "30 h 10 min ago" is 05:50 the day before, so the clock-hour buckets are easy to read.
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

/** One save per age (ms before NOW), batch ids 1, 2, 3… in the order given; [page, bank] optional. */
type Row = number | [age: number, page: string] | [age: number, page: string, bank: ScraptfBank];

function savesOf(rows: readonly Row[]): BankStockThinSave[] {
  return rows.map((r, i) => {
    const [age, page, bank] = typeof r === 'number' ? [r, '/buy/hats', 'hats' as ScraptfBank] : [r[0], r[1], r[2] ?? ('hats' as ScraptfBank)];
    return { batchId: i + 1, savedAt: NOW - age, bank, page };
  });
}

const CASES: { name: string; saves: Row[]; dropped: number[]; opts?: { maxSaves?: number; maxAgeMs?: number } }[] = [
  { name: 'keeps every save of the last 2 h, and one per 10 minutes to 24 h', saves: [0, MIN, 2 * HOUR, DAY - MIN], dropped: [] },
  {
    name: 'from 2 h to 24 h keeps the newest per clock-aligned 10 minutes',
    // 08:58 and 08:51 share 08:50-09:00; 09:00 and 08:49 are alone in theirs.
    saves: [0, 3 * HOUR, 3 * HOUR + 2 * MIN, 3 * HOUR + 9 * MIN, 3 * HOUR + 11 * MIN],
    dropped: [4],
  },
  {
    name: 'from 24 h to 7 d keeps the newest per clock hour',
    // 05:50, 05:40 and 05:00 the day before share an hour; 04:59 does not.
    saves: [0, MIN, 30 * HOUR + 10 * MIN, 30 * HOUR + 20 * MIN, 31 * HOUR, 31 * HOUR + MIN],
    dropped: [4, 5],
  },
  {
    name: 'from 7 d to 90 d keeps the newest per UTC day',
    // 13:00, 11:00 and 10:00 eight days ago share a day.
    saves: [0, MIN, 8 * DAY - HOUR, 8 * DAY + HOUR, 8 * DAY + 2 * HOUR, 9 * DAY],
    dropped: [4, 5],
  },
  { name: 'drops anything older than 90 d', saves: [0, MIN, 89 * DAY, BANK_STOCK_MAX_AGE_MS + 1, 400 * DAY], dropped: [4, 5] },
  { name: "never drops a page's newest save or the one it is compared with", saves: [100 * DAY, 200 * DAY, 300 * DAY], dropped: [3] },
  {
    name: 'the previous save is the newest from strictly before: an older copy of the newest look is not protected',
    // Ids 1 and 2 are one file imported twice; the higher id is the newest (as bankStockSaves orders).
    saves: [91 * DAY, 91 * DAY, 95 * DAY],
    dropped: [1],
  },
  {
    name: "a protected save takes its bucket: another save in that hour goes",
    saves: [0, 30 * HOUR + 10 * MIN, 30 * HOUR + 20 * MIN],
    dropped: [3],
  },
  {
    name: 'thins each page of a bank on its own',
    saves: [[0, '/items'], [30 * HOUR + 10 * MIN, '/items'], [30 * HOUR + 20 * MIN, '/items'], [30 * HOUR + 15 * MIN, '/items/2'], [400 * DAY, '/items/3']],
    dropped: [3],
  },
  {
    name: 'and each bank on its own (the same page key in two banks)',
    saves: [[0, '', 'hats'], [100 * DAY, '', 'hats'], [200 * DAY, '', 'hats'], [100 * DAY, '', 'weapons']],
    dropped: [3],
  },
  {
    name: "never drops a page's session baseline: the save before a burst of window reads",
    // Reads a minute apart (one session), then the save from 100 days ago that "What's new" compares with.
    saves: [0, MIN, 2 * MIN, 100 * DAY, 101 * DAY],
    dropped: [5],
  },
  { name: 'keeps a save dated in the future (a clock that moved)', saves: [-5 * MIN, 0, 2 * MIN], dropped: [] },
  { name: 'takes another cap', saves: [0, MIN, 2 * MIN, 3 * MIN, 4 * MIN, 5 * MIN], dropped: [4, 5, 6], opts: { maxSaves: 3 } },
  { name: 'takes another horizon', saves: [0, 3 * DAY, 4 * DAY, 5 * DAY], dropped: [3, 4], opts: { maxAgeMs: 2 * DAY } },
];

describe('bankStockThinning (F20 S1)', () => {
  it('uses the spec limits', () => {
    expect([BANK_STOCK_KEEP_ALL_MS, BANK_STOCK_RECENT_BUCKET_MS, BANK_STOCK_RECENT_TIER_MS, BANK_STOCK_HOURLY_MS, BANK_STOCK_MAX_AGE_MS, BANK_STOCK_MAX_SAVES_PER_PAGE]).toEqual([
      2 * HOUR,
      10 * MIN,
      DAY,
      7 * DAY,
      90 * DAY,
      300,
    ]);
  });

  it.each(CASES)('$name', ({ saves, dropped, opts }) => {
    const input = savesOf(saves);
    expect([...bankStockThinning(input, NOW, opts)].sort((a, b) => a - b)).toEqual(dropped);
    // Order in does not matter.
    expect([...bankStockThinning([...input].reverse(), NOW, opts)].sort((a, b) => a - b)).toEqual(dropped);
  });

  it('caps the last 2 h of a page at 300, keeping the newest', () => {
    // A save every 20 s: 305 of them inside 2 h.
    const input = savesOf(Array.from({ length: BANK_STOCK_MAX_SAVES_PER_PAGE + 5 }, (_, i) => i * 20_000));
    expect([...bankStockThinning(input, NOW)].sort((a, b) => a - b)).toEqual([301, 302, 303, 304, 305]);
  });

  it('is stable: what it keeps, it keeps at the next run and an hour later', () => {
    const input = savesOf(Array.from({ length: 400 }, (_, i) => i * 37 * MIN));
    const drop = bankStockThinning(input, NOW);
    const kept = input.filter((s) => !drop.has(s.batchId));
    expect(bankStockThinning(kept, NOW).size).toBe(0);
    // An hour on, a save goes only when a newer one crossed into its tier and shares its bucket: right
    // past 2 h (same 10 minutes), 24 h (same clock hour) or 7 d (same UTC day). Nothing in the middle of a
    // tier moves.
    const later = bankStockThinning(kept, NOW + HOUR);
    expect(later.size).toBeGreaterThan(0);
    for (const id of later) {
      const age = NOW + HOUR - kept.find((k) => k.batchId === id)!.savedAt;
      const nearTwoHours = age >= 2 * HOUR && age <= 3 * HOUR + 10 * MIN;
      const nearDay = age >= DAY && age <= DAY + 2 * HOUR;
      const nearWeek = age >= 7 * DAY && age <= 8 * DAY + HOUR;
      expect(nearTwoHours || nearDay || nearWeek, `${age / HOUR} h`).toBe(true);
    }
  });

  it('keeps nothing it was not given and drops nothing of an empty list', () => {
    expect(bankStockThinning([], NOW).size).toBe(0);
  });
});

describe("the retention the user is told of (F20-C3)", () => {
  it("keeps a page's newest save and its compare save past 90 days, and the README's data table says so", () => {
    // Saved once 200 days ago, then 150 and 120 days ago: only the oldest goes.
    const input = savesOf([200 * DAY, 150 * DAY, 120 * DAY]);
    expect([...bankStockThinning(input, NOW)]).toEqual([1]);
    const readme = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8');
    // The "Where your data lives" row: the privacy disclosure of what is stored on disk.
    const row = readme.split('\n').find((l) => l.startsWith('| `data\\flipdesk.sqlite` |'));
    expect(row).toBeDefined();
    // 0.7.1 (DM-3, CQ-1, CQ-2): the tiers, the 2 h tier's cap and the session baseline that also stays.
    expect(row).toContain('every one of the last 2 hours, at most 300 per page, then thinned to one per 10 minutes for the rest of the day, one an hour up to a week and one a day after that');
    expect(row).toContain("for up to 90 days, except each page's newest save, the one it is compared with and your last save before the current session, which stay until newer saves replace them");
    // No other line promises a plain 90-day limit on the snapshots without the exception.
    const snapshotLines = readme.split('\n').filter((l) => /snapshot/i.test(l) && /90 days/.test(l));
    expect(snapshotLines.length).toBeGreaterThan(0);
    for (const l of snapshotLines) expect(l, l.slice(0, 80)).toMatch(/newest save(,| and) the one it is compared with/);
  });
});
