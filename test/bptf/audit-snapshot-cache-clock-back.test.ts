// Review rv-jobs-net-1: snapshot-watched and the core count a snapshot stamped in the future (the wall
// clock moved back) as stale, but the snapshot itself went through bptfApi's 10-min cache, whose entries
// were stamped with the pre-step clock: `now - at` was negative, so every entry of the hours before the
// step was served again, no request was sent, getSnapshotAt never moved and the job picked the same SKU
// every minute. A cache entry stamped in the future is now fetched again, like a future snapshot stamp;
// and a future "snapshot endpoint unavailable" stamp is due for a probe.

import { afterEach, describe, expect, it } from 'vitest';
import { SNAPSHOT_URL, createBptfApi } from '../../src/service/connectors/bptfApi';
import type { Engine, PriceDb, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { buildJobs, snapshotIsStale, type JobContext } from '../../src/service/scheduler';
import type { SecretName } from '../../src/shared/types';
import { FakeHttp, createLogger, createStubSchema, jsonResponse, loadFixture, settingsWith } from './helpers';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const TOKEN = 'tok_SECRET_0123456789abcdef';
const SKU = '154;11';

const snapshots = loadFixture<{ responses: Record<string, unknown> }>('snapshot-responses.json').responses;

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function harness(opts: { gone?: boolean } = {}) {
  let now = T0;
  const clock = { now: () => now };
  const repo = openRepo(':memory:');
  repos.push(repo);
  const gone = { on: opts.gone ?? false };
  const http = new FakeHttp((c) => {
    if (c.url !== SNAPSHOT_URL) return { status: 404, data: null };
    if (gone.on) return { status: 404, data: null };
    const name = new URL(c.fullUrl).searchParams.get('sku')!;
    return jsonResponse(200, snapshots[name] ?? { id: null, appid: 440, sku: name, createdAt: 1791958000, listings: [] });
  });
  const log = createLogger();
  const settings = settingsWith();
  const secret = (n: SecretName): string | null => (n === 'bptfAccessToken' ? TOKEN : null);
  const api = createBptfApi({ clock, log, repo, http, settings: () => settings, secret, schema: createStubSchema() });
  const snapshotCalls = () => http.calls.filter((c) => c.url === SNAPSHOT_URL).length;
  return {
    api,
    http,
    log,
    repo,
    gone,
    clock,
    snapshotCalls,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

describe('audit: bptfApi snapshot cache after the clock moved back', () => {
  it('fetches again instead of serving an entry cached in the future, then caches the fresh one', async () => {
    const h = harness();
    await h.api.snapshot(SKU);
    expect(h.snapshotCalls()).toBe(1);

    h.advance(40 * MIN);
    await h.api.snapshot(SKU);
    expect(h.snapshotCalls()).toBe(2);
    expect(h.repo.getSnapshotAt(SKU)).toBe(T0 + 40 * MIN);

    // The wall clock steps back 8 h: the stored stamp and the cache entry now lie in the future.
    h.advance(-8 * HOUR);
    expect(snapshotIsStale(h.repo.getSnapshotAt(SKU)!, h.now())).toBe(true);
    await h.api.snapshot(SKU);
    expect(h.snapshotCalls()).toBe(3);
    expect(h.repo.getSnapshotAt(SKU)).toBe(h.now());

    // Fresh again: served from the cache, no request.
    await h.api.snapshot(SKU, 'user');
    expect(h.snapshotCalls()).toBe(3);
    h.advance(5 * MIN);
    await h.api.snapshot(SKU);
    expect(h.snapshotCalls()).toBe(3);
  });

  it('a user Refresh after the step is not answered from the old book', async () => {
    const h = harness();
    h.advance(30 * MIN);
    await h.api.snapshot(SKU);
    h.advance(-2 * HOUR);
    await h.api.snapshot(SKU, 'user');
    expect(h.snapshotCalls()).toBe(2);
    expect(h.http.calls[1]!.opts).toMatchObject({ priority: 'user' });
  });

  it('snapshot-watched refreshes a future-stamped book once, not every idle minute', async () => {
    const h = harness();
    const infos = () => h.log.lines.filter((l) => l.level === 'info' && /served from cache/.test(l.msg));
    const ctx: JobContext = {
      clock: h.clock,
      log: h.log,
      repo: h.repo,
      http: h.http,
      schema: createStubSchema(),
      pricedb: {} as PriceDb,
      bptfApi: h.api,
      engine: { markAllDirty: () => undefined, markDirty: () => undefined } as unknown as Engine,
      settings: () => settingsWith(),
      secret: (n) => (n === 'bptfAccessToken' ? TOKEN : null),
      watchedBaseSkus: () => [SKU],
      nextQueuedSnapshot: () => null,
      // As core.snapshot: a result that did not move the stored stamp came from the cache.
      snapshot: async (base, priority) => {
        const before = h.repo.getSnapshotAt(base);
        await h.api.snapshot(base, priority);
        const after = h.repo.getSnapshotAt(base);
        if (after === null || after === before) h.log.info(`snapshot ${base}: served from cache; order book left to the live feed`);
      },
      keyQuotesChanged: () => undefined,
    };
    const job = buildJobs(ctx).find((j) => j.id === 'snapshot-watched')!;

    await job.run();
    expect(h.snapshotCalls()).toBe(1);
    h.advance(40 * MIN);
    await job.run();
    expect(h.snapshotCalls()).toBe(2);

    h.advance(-8 * HOUR);
    await job.run();
    expect(h.snapshotCalls()).toBe(3);
    expect(h.repo.getSnapshotAt(SKU)).toBe(h.now());
    // Fresh now: the next idle minutes leave it alone and log nothing.
    for (let i = 0; i < 5; i++) {
      h.advance(MIN);
      await job.run();
    }
    expect(h.snapshotCalls()).toBe(3);
    expect(infos()).toHaveLength(0);
  });

  it('a "snapshot endpoint unavailable" stamp in the future is due for a probe', async () => {
    const h = harness({ gone: true });
    await expect(h.api.snapshot(SKU)).rejects.toThrow();
    expect(h.api.snapshotAvailable()).toBe(false);
    h.advance(HOUR);
    expect(h.api.snapshotAvailable()).toBe(false);

    h.advance(-8 * HOUR);
    expect(h.api.snapshotAvailable()).toBe(true);
    h.gone.on = false;
    await h.api.snapshot(SKU);
    expect(h.repo.getSnapshotAt(SKU)).toBe(h.now());
    expect(h.api.snapshotAvailable()).toBe(true);
  });
});
