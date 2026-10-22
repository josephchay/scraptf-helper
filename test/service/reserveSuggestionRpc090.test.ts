// 0.9 (#12): 'profit.reserveSuggestion' through the real rpc handlers over a real repo (journalRpc's harness). It reads
// only local data: the recorded exit runs (repo.holdingMarksSince), the journal's typical hold and the PriceDB history
// 'item.detail' already cached this session. It never calls the PriceDB connector, so it still answers with the
// network paused or PriceDB off, and it sends nothing.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Engine, Logger, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createRpcHandlers, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { typicalHoldOf } from '../../src/shared/journal';
import { RESERVE_LOOKBACK_MS, RESERVE_MAX_MARKS, reserveSuggestionOf } from '../../src/shared/reserveSuggest';
import type { DeepPartial, HistoryPoint, HoldingMark, JournalSummary, LoadedKeyHistory, ReserveSuggestion, Settings, UnixMs } from '../../src/shared/types';
import { makeDeps, schemaRoute } from '../pricedb/helpers';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KEY = 577;

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(makeDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

/** Ten daily points for each base, between 10 ref and 1 key, ending a day before now. */
function historyOf(base: string): HistoryPoint[] {
  const seed = Number(base.split(';')[0]);
  return Array.from({ length: 10 }, (_, i) => {
    const v = 200 + ((seed * 7 + i * 13) % 23) - 11;
    return { t: Math.floor((NOW - (10 - i) * DAY) / 1000), buyScrap: v, sellScrap: v + 9 };
  });
}

function setup(opts: { settings?: DeepPartial<Settings>; holdings?: unknown; loadedKeyHistory?: () => LoadedKeyHistory | null } = {}) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = { current: mergeSettings(DEFAULT_SETTINGS, { connectors: { pricedb: true, pricedbSocket: false, bptfApi: false, scm: false }, ...opts.settings }) };
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const history = vi.fn(async (base: string): Promise<HistoryPoint[]> => historyOf(base));
  const item = vi.fn(async () => null);
  const paused = { on: false };
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema,
    http: { isPaused: () => paused.on, nextAllowedAt: () => 0, hostBlocked: () => null },
    engine: { keyPrice: () => ({ valueScrap: KEY, source: 'pricedb', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null }), markDirty: quiet } as unknown as Engine,
    market: { markDirty: quiet },
    pricedb: { history, item, ...(opts.loadedKeyHistory ? { loadedKeyHistory: opts.loadedKeyHistory } : {}) },
    scraptfList: { rowFor: () => null },
    bankStock: { detailFor: () => null },
    ...(opts.holdings !== undefined ? { holdings: opts.holdings } : {}),
    settings: () => settings.current,
    secret: () => null,
    push: quiet,
    pricesChanged: quiet,
    journalChanged: quiet,
  } as unknown as HandlerContext;
  const rpc = createRpcHandlers(ctx);
  const call = async <T>(method: string, params?: unknown) => (await rpc(method, params)) as T;
  return { repo, call, history, item, settings, paused };
}

/** Five buy/sell pairs held 1 day each (the journal's typical hold over every sale), one unit still held. */
async function seedJournal(call: <T>(method: string, params?: unknown) => Promise<T>): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const sku = `${100 + i};6`;
    await call('journal.add', { side: 'buy', venue: 'scrap.tf', sku, name: `Hat ${i}`, keys: 0, scrap: 50, ts: NOW - 20 * DAY + i * HOUR });
    await call('journal.add', { side: 'sell', venue: 'backpack.tf', sku, name: `Hat ${i}`, keys: 0, scrap: 60, ts: NOW - 19 * DAY + i * HOUR });
  }
  await call('journal.add', { side: 'buy', venue: 'scrap.tf', sku: '110;6', name: 'Held', keys: 0, scrap: 50, ts: NOW - 3 * DAY });
}

/** Day-long runs of three bases' revenue order under 10 ref, recorded while the app ran. */
function seedMarks(repo: Repo): void {
  const runs: Omit<HoldingMark, 'id'>[] = [];
  for (const [b, base] of ['200;6', '201;6', '202;6'].entries()) {
    for (let i = 0; i < 9; i++) {
      runs.push({
        baseSku: base,
        fromAt: NOW - (9 - i) * DAY,
        toAt: NOW - (8 - i) * DAY - 1,
        revKeys: 0,
        revMetalScrap: 50 + ((b * 5 + i * 3) % 7) - 3,
        revIsBot: true,
        revVerified: true,
        bestKeys: null,
        bestMetalScrap: null,
        nextKeys: null,
        nextMetalScrap: null,
        buyerCount: 2,
        verifiedBuyerCount: 2,
        askKeys: null,
        askMetalScrap: null,
        askCount: null,
        scraptfPaysKeys: null,
        scraptfPaysScrap: null,
        keyScrap: KEY,
      });
    }
  }
  for (const r of runs) repo.insertHoldingMark(r);
}

/** What the shared rule gives over the same local data. */
function expected(repo: Repo, summary: JournalSummary, histories: ReadonlyMap<string, readonly HistoryPoint[]>, settingsAt: UnixMs | null): ReserveSuggestion {
  return reserveSuggestionOf({
    marks: repo.holdingMarksSince(NOW - RESERVE_LOOKBACK_MS, RESERVE_MAX_MARKS),
    histories,
    hold: typicalHoldOf(summary.closed, summary.open)(''),
    keyScrap: KEY,
    settingsAt,
    now: NOW,
  });
}

describe("'profit.reserveSuggestion' (0.9, #12)", () => {
  it("answers from the recorded runs, the journal's typical hold and the history item.detail cached; PriceDB is asked only by item.detail", async () => {
    const h = setup();
    await seedJournal(h.call);
    seedMarks(h.repo);
    const bases = ['100;6', '101;6', '102;6'];
    for (const sku of bases) await h.call('item.detail', { sku });
    expect(h.history).toHaveBeenCalledTimes(3);
    h.history.mockClear();

    const got = await h.call<ReserveSuggestion>('profit.reserveSuggestion');
    expect(h.history).not.toHaveBeenCalled();
    expect(h.item).not.toHaveBeenCalled();
    const summary = await h.call<JournalSummary>('journal.summary');
    expect(got).toEqual(expected(h.repo, summary, new Map(bases.map((b) => [b, historyOf(b)])), null));
    expect(got).toMatchObject({ holdMs: DAY, holdFrom: 'journal', holdSales: 5, holdStillHeld: 1, keyScrap: KEY, generatedAt: NOW, settingsAt: null });
    const [small, mid] = got.bands;
    expect(small).toMatchObject({ band: 'under-10-ref', source: 'recorded', recorded: { windows: 24, items: 3 } });
    expect(mid).toMatchObject({ band: 'to-1-key', source: 'pricedb', pricedb: { windows: 27, items: 3 } });
  });

  it('still answers from the cache with the network paused or PriceDB turned off, and fetches nothing', async () => {
    const h = setup();
    await h.call('item.detail', { sku: '100;6' });
    expect(h.history).toHaveBeenCalledTimes(1);
    h.history.mockClear();

    h.paused.on = true;
    const paused = await h.call<ReserveSuggestion>('profit.reserveSuggestion');
    h.paused.on = false;
    h.settings.current = mergeSettings(h.settings.current, { connectors: { pricedb: false } });
    const off = await h.call<ReserveSuggestion>('profit.reserveSuggestion');
    expect(h.history).not.toHaveBeenCalled();
    for (const s of [paused, off]) {
      expect(s.bands.find((b) => b.band === 'to-1-key')!.pricedb).toEqual({ windows: 9, items: 1 });
      // No typical hold yet: the 1-day default.
      expect(s).toMatchObject({ holdFrom: 'default', holdMs: DAY });
    }
  });

  it('gives no PriceDB windows before any item.detail (the cache is never filled by the suggestion)', async () => {
    const h = setup();
    const s = await h.call<ReserveSuggestion>('profit.reserveSuggestion');
    expect(h.history).not.toHaveBeenCalled();
    expect(s.bands.every((b) => b.source === null && b.pricedb.windows === 0 && b.recorded.windows === 0)).toBe(true);
  });

  it("reads settingsAt from the holdings' buyerSettingsAt; without one (or a throwing one) it is null", async () => {
    const without = setup({ holdings: { list: () => undefined } });
    expect((await without.call<ReserveSuggestion>('profit.reserveSuggestion')).settingsAt).toBeNull();
    const none = setup();
    expect((await none.call<ReserveSuggestion>('profit.reserveSuggestion')).settingsAt).toBeNull();
    const throwing = setup({
      holdings: {
        buyerSettingsAt: () => {
          throw new Error('settings unreadable');
        },
      },
    });
    expect((await throwing.call<ReserveSuggestion>('profit.reserveSuggestion')).settingsAt).toBeNull();

    const asked: UnixMs[] = [];
    const stamped = setup({
      holdings: {
        buyerSettingsAt: (now: UnixMs) => {
          asked.push(now);
          return NOW - 4.5 * DAY;
        },
      },
    });
    seedMarks(stamped.repo);
    const s = await stamped.call<ReserveSuggestion>('profit.reserveSuggestion');
    expect(asked).toEqual([NOW]);
    expect(s.settingsAt).toBe(NOW - 4.5 * DAY);
    // Review: only the windows from the change on (day -4.5 to -1.5, 4 per item), never one before it.
    expect(s.bands[0]!.recorded).toEqual({ windows: 12, items: 3 });
  });

  it('values recorded exits in keys at the PriceDB key history already in memory (loadedKeyHistory), sending nothing', async () => {
    const keyHistory: LoadedKeyHistory = {
      loadedAt: NOW,
      points: Array.from({ length: 10 }, (_, i) => ({ t: Math.floor((NOW - (9 - i) * DAY) / 1000), buyScrap: 560 - 4 * i, sellScrap: 570 - 4 * i })),
    };
    const loaded = vi.fn(() => keyHistory);
    const h = setup({ loadedKeyHistory: loaded });
    // One 2-key run per base over 9 days: the order never changed, the key price did.
    const seedKeyed = (repo: Repo): void => {
      for (const base of ['300;6', '301;6', '302;6']) {
        repo.insertHoldingMark({
          baseSku: base,
          fromAt: NOW - 9 * DAY,
          toAt: NOW - 1,
          revKeys: 2,
          revMetalScrap: 0,
          revIsBot: true,
          revVerified: true,
          bestKeys: null,
          bestMetalScrap: null,
          nextKeys: null,
          nextMetalScrap: null,
          buyerCount: 2,
          verifiedBuyerCount: 2,
          askKeys: null,
          askMetalScrap: null,
          askCount: null,
          scraptfPaysKeys: null,
          scraptfPaysScrap: null,
          keyScrap: 560,
        });
      }
    };
    seedKeyed(h.repo);
    const s = await h.call<ReserveSuggestion>('profit.reserveSuggestion');
    expect(loaded).toHaveBeenCalled();
    expect(h.history).not.toHaveBeenCalled();
    expect(h.item).not.toHaveBeenCalled();
    const want = reserveSuggestionOf({
      marks: h.repo.holdingMarksSince(NOW - RESERVE_LOOKBACK_MS, RESERVE_MAX_MARKS),
      histories: new Map(),
      hold: null,
      keyScrap: KEY,
      settingsAt: null,
      now: NOW,
      keyHistory,
    });
    expect(s).toEqual(want);
    // 8 one-day windows per base, every one a key fall (the run's own 560 would have read 0).
    expect(s.bands[2]).toMatchObject({ band: 'key-plus', source: 'recorded', recorded: { windows: 24, items: 3 } });
    expect(s.bands[2]!.suggestedPct).toBeGreaterThan(0);
    // No key history loaded (or a throwing read): those ends are not observed.
    const none = setup({ loadedKeyHistory: () => null });
    const throwing = setup({
      loadedKeyHistory: () => {
        throw new Error('no curve');
      },
    });
    for (const x of [none, throwing]) {
      seedKeyed(x.repo);
      const got = await x.call<ReserveSuggestion>('profit.reserveSuggestion');
      expect(got.bands[2]).toMatchObject({ source: null, recorded: { windows: 0, items: 0 } });
    }
  });
});
