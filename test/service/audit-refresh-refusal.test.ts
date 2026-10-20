// 0.7.3 (audit rmarket-3): 'item.refresh' refused for the snapshot rate limit returns the wait as etaMs only;
// its reason has no frozen "try again in N s", which the drawer would print beside its own live countdown.
// Fakes only; nothing is fetched.

import { describe, expect, it } from 'vitest';
import type { Engine, Logger } from '../../src/service/contracts';
import { createRpcHandlers, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { createStubSchema } from '../import/schemaStub';

const NOW = 1_800_000_000_000;

describe("'item.refresh' over the snapshot rate limit (rmarket-3)", () => {
  it('is refused with the wait in etaMs and none in the reason', async () => {
    const quiet = () => undefined;
    const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
    const settings = mergeSettings(DEFAULT_SETTINGS, { connectors: { bptfApi: true } });
    const snapshots: string[] = [];
    const ctx = {
      clock: { now: () => NOW },
      log,
      schema: createStubSchema(),
      engine: {} as Engine,
      settings: () => settings,
      secret: (name: string) => (name === 'bptfAccessToken' ? 'token' : null),
      http: { isPaused: () => false, hostBlocked: () => null, nextAllowedAt: () => NOW + 120_000 },
      bptfApi: { snapshotAvailable: () => true },
      snapshot: (base: string) => {
        snapshots.push(base);
        return Promise.resolve();
      },
    } as unknown as HandlerContext;
    const r = (await createRpcHandlers(ctx)('item.refresh', { sku: '378;6' })) as { queued: boolean; reason: string | null; etaMs: number | null };
    expect(r).toEqual({ queued: false, reason: 'The snapshot rate limit is reached.', etaMs: 120_000 });
    expect(r.reason).not.toMatch(/\d/);
    expect(snapshots).toEqual([]);
  });
});
