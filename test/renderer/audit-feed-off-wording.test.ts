// Settings → Live feed: with the feed off, the 'snapshot-watched' job still refreshes the items you
// price or hold from backpack.tf (one SKU a minute, only one older than SNAPSHOT_STALE_MS) whenever
// the backpack.tf API switch is on and an access token is saved. The switch's description says so,
// and the job is pinned here so the wording is revisited if the behaviour changes.

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../../src/renderer/hooks/appContext';
import { FeedSection } from '../../src/renderer/pages/SettingsPage';
import type { BptfApi, Engine, HttpClient, PriceDb, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { buildJobs, SNAPSHOT_STALE_MS, type JobContext } from '../../src/service/scheduler';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { Settings } from '../../src/shared/types';
import { FakeTime, T0 } from '../net/helpers';

const MIN = 60_000;
const FEED_OFF: Settings = { ...DEFAULT_SETTINGS, liveFeed: { ...DEFAULT_SETTINGS.liveFeed, enabled: false } };
const OLD_TEXT = 'buy orders only update when you refresh an item';

describe('the Live feed switch describes what still updates with the feed off', () => {
  it('names the background refresh of the items you price or hold, and how to stop it', () => {
    const html = renderToString(createElement(AppProvider, null, createElement(FeedSection, { s: FEED_OFF }))).replace(/<!-- -->/g, '');
    expect(html).toContain('for the items you price or hold');
    expect(html).toContain('one a minute at most, each at most every 30 minutes');
    expect(html).toContain('turn off backpack.tf API under Data sources');
    expect(html).not.toContain(OLD_TEXT);
  });

  it('the access token help names the same refresh', () => {
    const page = readFileSync(new URL('../../src/renderer/pages/SettingsPage.tsx', import.meta.url), 'utf8');
    expect(page).not.toContain(OLD_TEXT);
    const token = page.slice(page.indexOf('name="bptfAccessToken"'), page.indexOf('name="bptfApiKey"'));
    expect(token).toContain('items you price or hold');
  });
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

describe("the behaviour the wording describes ('snapshot-watched')", () => {
  it('runs with the feed off and snapshots the oldest stale watched SKU', async () => {
    expect(SNAPSHOT_STALE_MS).toBe(30 * MIN);
    const time = new FakeTime(T0);
    const repo = openRepo(':memory:');
    repos.push(repo);
    const snapshots: string[] = [];
    const ctx: JobContext = {
      clock: time,
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      repo,
      http: { nextAllowedAt: () => 0, hostBlocked: () => null } as unknown as HttpClient,
      schema: {} as SchemaService,
      pricedb: {} as PriceDb,
      bptfApi: { snapshotAvailable: () => true, credentialRejected: () => null } as unknown as BptfApi,
      engine: { markAllDirty: () => undefined, markDirty: () => undefined } as unknown as Engine,
      settings: () => FEED_OFF,
      secret: () => 'secret-value',
      watchedBaseSkus: () => ['200;11;australium', '211;11;australium'],
      nextQueuedSnapshot: () => null,
      snapshot: async (base) => {
        snapshots.push(base);
        repo.setSnapshotAt(base, time.now());
      },
      keyQuotesChanged: () => undefined,
    };
    repo.setSnapshotAt('200;11;australium', T0 - 40 * MIN);
    repo.setSnapshotAt('211;11;australium', T0 - 90 * MIN);
    const job = buildJobs(ctx).find((j) => j.id === 'snapshot-watched')!;
    expect(job.blockedReason?.()).toBeNull();
    await job.run();
    expect(snapshots).toEqual(['211;11;australium']);
    await job.run();
    expect(snapshots).toEqual(['211;11;australium', '200;11;australium']);
    // Both fresh now: nothing until one is SNAPSHOT_STALE_MS old again.
    await job.run();
    expect(snapshots).toHaveLength(2);
  });
});
