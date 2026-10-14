// Budgets survive a service restart, including a request the previous process
// died during (its request-log row is only written when the exchange ends).

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { DB_FILE_NAME, META_BUDGET_SENT_PREFIX, createServiceCore, unloggedStarts, type ServiceCore } from '../../src/service/core';
import { openRepo } from '../../src/service/db';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { HealthReport } from '../../src/shared/types';

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const PRICES_PATH = '/api/IGetPrices/v4?key=REDACTED&raw=1';
const CURRENCIES_PATH = '/api/IGetCurrencies/v1?key=REDACTED&raw=1';

const temps: string[] = [];
const cores: ServiceCore[] = [];
afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function dataDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-budgets-'));
  temps.push(root);
  const dir = path.join(root, 'data');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const sentMeta = (ts: number, p: string) => JSON.stringify({ ts, host: 'api.backpack.tf', path: p });

describe('unloggedStarts', () => {
  const now = Date.UTC(2026, 9, 14, 12);
  const meta = (m: Record<string, string>) => ({ getMeta: (k: string) => m[k] ?? null });

  it('returns a saved slow-budget start that has no request-log row', () => {
    const repo = meta({ [`${META_BUDGET_SENT_PREFIX}bptf-prices`]: sentMeta(now - 60_000, PRICES_PATH) });
    expect(unloggedStarts(repo, [], now - 86_400_000)).toEqual([{ ts: now - 60_000, host: 'api.backpack.tf', path: PRICES_PATH }]);
  });

  it('skips starts whose request finished (same start time in the log), old starts and garbage', () => {
    const repo = meta({
      [`${META_BUDGET_SENT_PREFIX}bptf-prices`]: sentMeta(now - 60_000, PRICES_PATH),
      [`${META_BUDGET_SENT_PREFIX}bptf-currencies`]: sentMeta(now - 2 * 86_400_000, CURRENCIES_PATH),
      [`${META_BUDGET_SENT_PREFIX}mannco-prices`]: '{not json',
      [`${META_BUDGET_SENT_PREFIX}mannco`]: JSON.stringify({ ts: 'soon', host: 'api.mannco.store', path: '/x' }),
    });
    const logged = [{ ts: now - 60_000, host: 'api.backpack.tf', path: PRICES_PATH }];
    expect(unloggedStarts(repo, logged, now - 86_400_000)).toEqual([]);
  });

  it('does not let a log row of another budget cover the start', () => {
    const repo = meta({ [`${META_BUDGET_SENT_PREFIX}bptf-prices`]: sentMeta(now - 60_000, PRICES_PATH) });
    const logged = [{ ts: now - 30_000, host: 'api.backpack.tf', path: CURRENCIES_PATH }];
    expect(unloggedStarts(repo, logged, now - 86_400_000)).toHaveLength(1);
  });
});

describe('budget restore at service start', () => {
  it('counts logged requests and a request the last process died during, once each', async () => {
    const dir = dataDir();
    const now = Date.now();
    const repo = openRepo(path.join(dir, DB_FILE_NAME));
    // IGetCurrencies finished (logged) and its start was also saved: one request.
    repo.appendRequestLog({ ts: now - 120_000, host: 'api.backpack.tf', path: CURRENCIES_PATH, method: 'GET', status: 200, ms: 300, bytes: 900, note: null });
    repo.setMeta(`${META_BUDGET_SENT_PREFIX}bptf-currencies`, sentMeta(now - 120_000, CURRENCIES_PATH));
    // IGetPrices was in flight when the process died: only the saved start exists.
    repo.setMeta(`${META_BUDGET_SENT_PREFIX}bptf-prices`, sentMeta(now - 60_000, PRICES_PATH));
    repo.close();

    const calls: string[] = [];
    const core = createServiceCore({
      dataDir: dir,
      version: '0.1.0',
      settings: mergeSettings(DEFAULT_SETTINGS, { contactUrl: 'https://github.com/flipdesk-test' }),
      secrets: { bptfApiKey: KEY },
      log: quiet,
      fetchImpl: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        throw new TypeError('fetch failed: offline test');
      }) as typeof fetch,
    });
    cores.push(core);
    const health = (await core.handle('health.get', undefined)) as HealthReport;
    const used = (id: string) => health.budgets.find((b) => b.id === id)?.usedLastHour;
    expect(used('bptf-currencies')).toBe(1);
    expect(used('bptf-prices')).toBe(1);

    // The key test cannot reach IGetCurrencies again within 5 min of the last call.
    const r = (await core.handle('secrets.test', { name: 'bptfApiKey' })) as { ok: boolean; message: string };
    expect(r.ok).toBe(false);
    expect(calls.filter((u) => u.includes('IGetCurrencies'))).toEqual([]);
  });

  it('saves the start of a slow-budget request before sending it', async () => {
    const dir = dataDir();
    const core = createServiceCore({
      dataDir: dir,
      version: '0.1.0',
      settings: mergeSettings(DEFAULT_SETTINGS, { contactUrl: 'https://github.com/flipdesk-test' }),
      secrets: { bptfApiKey: KEY },
      log: quiet,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed: offline test');
      }) as typeof fetch,
    });
    await core.handle('secrets.test', { name: 'bptfApiKey' }).catch(() => undefined);
    await core.stop();

    const repo = openRepo(path.join(dir, DB_FILE_NAME));
    try {
      const saved = JSON.parse(repo.getMeta(`${META_BUDGET_SENT_PREFIX}bptf-currencies`) ?? 'null') as { ts: number; host: string; path: string };
      expect(saved).toMatchObject({ host: 'api.backpack.tf' });
      expect(saved.path).toMatch(/^\/api\/IGetCurrencies\/v1\?/);
      expect(saved.path).not.toContain(KEY);
      // Fast budgets are not written on every request.
      expect(repo.getMeta(`${META_BUDGET_SENT_PREFIX}pricedb`)).toBeNull();
    } finally {
      repo.close();
    }
  });
});
