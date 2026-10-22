// 0.8 (H1): the exit-run writer (createMarkRecorder) over a real in-memory repo. A run goes on while the same
// prices are seen within the gap and the feed stays live, written at most every 10 min with the latest counts;
// anything else closes it at its last sighting and starts the next. Nothing here touches the network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { HOLDING_MARK_EXTEND_MS, createMarkRecorder } from '../../src/service/domain/holdingMarks';
import { HOLDING_MARK_GAP_MS, markExitScrap } from '../../src/shared/holdingAdvice';
import type { HoldingMarkValues } from '../../src/shared/types';
import { HOUR, MIN, T0, recordingLogger } from './helpers';

const openRepos: Repo[] = [];
afterEach(() => {
  while (openRepos.length) openRepos.pop()!.close();
  vi.restoreAllMocks();
});

function newRepo(): Repo {
  const repo = openRepo(':memory:');
  openRepos.push(repo);
  return repo;
}

const BASE = '378;6';
const KEY = 567;

/** A 1-key + 9-scrap revenue order and two buyers. */
function values(over: Partial<HoldingMarkValues> = {}): HoldingMarkValues {
  return {
    revKeys: 1,
    revMetalScrap: 9,
    revIsBot: true,
    revVerified: true,
    bestKeys: 1,
    bestMetalScrap: 9,
    nextKeys: 0,
    nextMetalScrap: 500,
    buyerCount: 2,
    verifiedBuyerCount: 2,
    askKeys: null,
    askMetalScrap: null,
    askCount: null,
    scraptfPaysKeys: null,
    scraptfPaysScrap: null,
    ...over,
  };
}

function setup() {
  const repo = newRepo();
  const log = recordingLogger();
  const rec = createMarkRecorder({ repo, log });
  const seen = (v: HoldingMarkValues = values()) => new Map([[BASE, v]]);
  const stored = () => repo.holdingMarks(BASE, 0, 5000);
  return { repo, log, rec, seen, stored };
}

describe('createMarkRecorder (H1)', () => {
  it('starts a run and extends it on the same values at most every 10 min', () => {
    const { rec, seen, stored } = setup();
    const live = T0 - HOUR;
    expect(rec.record(seen(), T0, live, KEY)).toMatchObject([{ baseSku: BASE, fromAt: T0, toAt: T0, keyScrap: KEY, revKeys: 1, revMetalScrap: 9 }]);
    expect(rec.record(seen(), T0 + 5 * MIN, live, KEY)).toEqual([]);
    expect(stored()).toMatchObject([{ fromAt: T0, toAt: T0 }]);
    expect(rec.record(seen(), T0 + HOLDING_MARK_EXTEND_MS, live, KEY)).toMatchObject([{ fromAt: T0, toAt: T0 + HOLDING_MARK_EXTEND_MS }]);
    expect(stored()).toMatchObject([{ fromAt: T0, toAt: T0 + HOLDING_MARK_EXTEND_MS }]);
    expect(stored()).toHaveLength(1);
  });

  it('starts no run on a count change alone: the run keeps the latest counts, and flush() writes them', () => {
    const { rec, seen, stored } = setup();
    const live = T0 - HOUR;
    rec.record(seen(), T0, live, KEY);
    expect(rec.record(seen(values({ buyerCount: 5, verifiedBuyerCount: 3, askCount: null })), T0 + MIN, live, KEY)).toEqual([]);
    expect(stored()).toMatchObject([{ buyerCount: 2, verifiedBuyerCount: 2 }]);
    rec.flush();
    expect(stored()).toMatchObject([{ fromAt: T0, toAt: T0 + MIN, buyerCount: 5, verifiedBuyerCount: 3 }]);
    // Extended later with the counts seen last.
    rec.record(seen(values({ buyerCount: 4, verifiedBuyerCount: 3 })), T0 + 11 * MIN, live, KEY);
    expect(stored()).toEqual([expect.objectContaining({ toAt: T0 + 11 * MIN, buyerCount: 4 })]);
  });

  it('stores an unknown key price as NULL, never a default, and a run with keys then reads no exit without one', () => {
    const { rec, seen, stored } = setup();
    rec.record(seen(), T0, T0 - HOUR, null);
    const [run] = stored();
    expect(run!.keyScrap).toBeNull();
    expect(markExitScrap(run!, null)).toBeNull();
    expect(markExitScrap(run!, KEY)).toBe(KEY + 9);
  });

  it('closes a run at its last sighting on a price change and starts the next', () => {
    const { rec, seen, stored } = setup();
    const live = T0 - HOUR;
    rec.record(seen(), T0, live, KEY);
    rec.record(seen(), T0 + 4 * MIN, live, KEY);
    const out = rec.record(seen(values({ revKeys: 1, revMetalScrap: 18 })), T0 + 7 * MIN, live, KEY);
    expect(out).toMatchObject([
      { fromAt: T0, toAt: T0 + 4 * MIN },
      { fromAt: T0 + 7 * MIN, toAt: T0 + 7 * MIN, revMetalScrap: 18 },
    ]);
    expect(stored().map((m) => [m.fromAt, m.toAt])).toEqual([
      [T0, T0 + 4 * MIN],
      [T0 + 7 * MIN, T0 + 7 * MIN],
    ]);
  });

  it('writes nothing while the feed is not live, and a feed that came back after the last sighting starts a new run', () => {
    const { rec, seen, stored } = setup();
    expect(rec.record(seen(), T0, null, KEY)).toEqual([]);
    expect(stored()).toEqual([]);
    rec.record(seen(), T0, T0 - HOUR, KEY);
    rec.record(seen(), T0 + 3 * MIN, T0 - HOUR, KEY);
    // The feed dropped and came back at T0 + 5 min: the same values start a new run.
    rec.record(seen(), T0 + 6 * MIN, T0 + 5 * MIN, KEY);
    expect(stored().map((m) => [m.fromAt, m.toAt])).toEqual([
      [T0, T0 + 3 * MIN],
      [T0 + 6 * MIN, T0 + 6 * MIN],
    ]);
  });

  it('starts a new run after a silence over 60 min', () => {
    const { rec, seen, stored } = setup();
    const live = T0 - HOUR;
    rec.record(seen(), T0, live, KEY);
    rec.record(seen(), T0 + HOLDING_MARK_GAP_MS + 1, live, KEY);
    expect(stored().map((m) => [m.fromAt, m.toAt])).toEqual([
      [T0, T0],
      [T0 + HOLDING_MARK_GAP_MS + 1, T0 + HOLDING_MARK_GAP_MS + 1],
    ]);
  });

  it('reads the same raw order under another key price as no change', () => {
    const { rec, seen, stored } = setup();
    const live = T0 - HOUR;
    rec.record(seen(), T0, live, KEY);
    rec.record(seen(), T0 + 20 * MIN, live, 600);
    expect(stored()).toMatchObject([{ fromAt: T0, toAt: T0 + 20 * MIN, keyScrap: KEY }]);
  });

  it('starts a run when the clock steps back', () => {
    const { rec, seen, stored } = setup();
    const live = T0 - 2 * HOUR;
    rec.record(seen(), T0, live, KEY);
    rec.record(seen(), T0 + 30 * MIN, live, KEY);
    rec.record(seen(), T0 - HOUR, live, KEY);
    expect(stored().map((m) => [m.fromAt, m.toAt])).toEqual([
      [T0 - HOUR, T0 - HOUR],
      [T0, T0 + 30 * MIN],
    ]);
  });

  it("flush() writes each open run's last sighting", () => {
    const { rec, seen, stored } = setup();
    const live = T0 - HOUR;
    rec.record(seen(), T0, live, KEY);
    rec.record(seen(), T0 + 9 * MIN, live, KEY);
    expect(stored()[0]!.toAt).toBe(T0);
    rec.flush();
    expect(stored()[0]!.toAt).toBe(T0 + 9 * MIN);
    // Nothing more to write.
    rec.flush();
    expect(stored()).toHaveLength(1);
  });

  it('continues a stored run after a reset (seeded from the newest run), and replaces a pruned one', () => {
    const { repo, rec, seen, stored } = setup();
    const live = T0 - HOUR;
    rec.record(seen(), T0, live, KEY);
    rec.reset();
    rec.record(seen(), T0 + 15 * MIN, live, KEY);
    expect(stored().map((m) => [m.fromAt, m.toAt])).toEqual([[T0, T0 + 15 * MIN]]);
    // The run is pruned under the recorder: the next extend finds nothing and a new run takes its place.
    expect(repo.pruneHoldingMarks(T0 + 16 * MIN, { maxAgeMs: 0 })).toBe(1);
    const out = rec.record(seen(), T0 + 30 * MIN, live, KEY);
    expect(out).toMatchObject([{ fromAt: T0 + 30 * MIN, toAt: T0 + 30 * MIN }]);
    expect(stored().map((m) => [m.fromAt, m.toAt])).toEqual([[T0 + 30 * MIN, T0 + 30 * MIN]]);
  });

  it('keeps each base apart', () => {
    const { repo, rec } = setup();
    const live = T0 - HOUR;
    rec.record(new Map([[BASE, values()], ['126;6', values({ revKeys: 0, revMetalScrap: 60 })]]), T0, live, KEY);
    expect(repo.holdingMarks('126;6', 0)).toMatchObject([{ revKeys: 0, revMetalScrap: 60 }]);
    expect(repo.holdingMarks(BASE, 0)).toHaveLength(1);
  });

  it('logs a failing repo once per streak and never throws', () => {
    const { repo, log, rec, seen, stored } = setup();
    const insert = vi.spyOn(repo, 'insertHoldingMark').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(rec.record(seen(), T0, T0 - HOUR, KEY)).toEqual([]);
    expect(rec.record(seen(), T0 + MIN, T0 - HOUR, KEY)).toEqual([]);
    expect(() => rec.flush()).not.toThrow();
    const warns = log.lines.filter((l) => l.level === 'warn' && /could not record exit prices/.test(l.msg));
    expect(warns).toHaveLength(1);
    insert.mockRestore();
    expect(rec.record(seen(), T0 + 2 * MIN, T0 - HOUR, KEY)).toHaveLength(1);
    expect(stored()).toHaveLength(1);
  });
});
