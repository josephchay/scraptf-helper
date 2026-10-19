// F16 service contract: 'check.text' validates with fixed messages (the text is the user's clipboard,
// so no error ever quotes it), pushes 'check.done' for item results only, and hides a failing check's
// cause; 'check.recent' reads the ring. The real core resolves items with the schema (fixture), judges
// them against the local book only, pushes and keeps item results, logs nothing of the text and makes
// no request. The parser and the evaluation are pinned in test/domain/liveCheck*.test.ts.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { createServiceCore, type ServiceCore } from '../../src/service/core';
import { createLiveCheck, parseCheckText, type LiveCheckDeps } from '../../src/service/domain/liveCheck';
import { createLogger } from '../../src/service/logger';
import { CHECK_FAILED_MESSAGE, createRpcHandlers, type HandlerContext } from '../../src/service/rpcHandlers';
import { blankCheckResult, CHECK_MAX_CHARS, CHECK_NOT_ITEM_REASON, CHECK_REFUSALS } from '../../src/shared/check';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { SERVICE_METHODS, type PushEvent } from '../../src/shared/rpc';
import type { CheckResult } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MARKER = 'Zq7-SECRET-MARKER';

function itemResult(id: number): CheckResult {
  return { ...blankCheckResult('not-item', 'x', 'manual', NOW, id), status: 'item', reason: null, sku: '378;6', name: 'Team Captain', category: 'hats', verdict: 'flip' };
}

function handlers(liveCheck: HandlerContext['liveCheck']) {
  const pushes: { event: PushEvent; payload: unknown }[] = [];
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx = {
    clock: { now: () => NOW },
    log,
    liveCheck,
    push: (event: PushEvent, payload: unknown) => pushes.push({ event, payload }),
  } as unknown as HandlerContext;
  return { rpc: createRpcHandlers(ctx), pushes, log };
}

describe("'check.text' handler", () => {
  it('is a service method and passes text, source and the clock to the live check', async () => {
    expect(SERVICE_METHODS).toEqual(expect.arrayContaining(['check.text', 'check.recent']));
    const check = vi.fn((_t: string, source, now: number) => blankCheckResult('not-item', CHECK_NOT_ITEM_REASON, source, now, 1));
    const h = handlers({ check, recent: () => [] });
    const r = (await h.rpc('check.text', { text: 'Team Captain', source: 'hotkey' })) as CheckResult;
    expect(check).toHaveBeenCalledWith('Team Captain', 'hotkey', NOW);
    expect(r.status).toBe('not-item');
    expect(h.pushes).toEqual([]);
  });

  it("pushes 'check.done' for an item result only", async () => {
    const item = itemResult(7);
    const h = handlers({ check: () => item, recent: () => [item] });
    await h.rpc('check.text', { text: 'Team Captain, 1.33 ref', source: 'watch' });
    expect(h.pushes).toEqual([{ event: 'check.done', payload: item }]);
    expect(await h.rpc('check.recent', undefined)).toEqual([item]);
    expect(await h.rpc('check.recent', null)).toEqual([item]);
    await expect(h.rpc('check.recent', { all: true })).rejects.toThrow(/Invalid parameters for check\.recent/);
  });

  it('never quotes the text in a validation error', async () => {
    const check = vi.fn();
    const h = handlers({ check, recent: () => [] });
    const bad: unknown[] = [
      { text: `${MARKER} `.repeat(30), source: 'manual' },
      { text: MARKER, source: MARKER },
      { text: MARKER },
      { text: { value: MARKER }, source: 'manual' },
      MARKER,
      [MARKER],
      undefined,
    ];
    for (const params of bad) {
      const err = await h.rpc('check.text', params).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err, JSON.stringify(params)?.slice(0, 40)).toBeInstanceOf(Error);
      expect(err!.message).toMatch(/^Invalid parameters for check\.text/);
      expect(err!.message).not.toContain('SECRET');
    }
    expect(check).not.toHaveBeenCalled();
    expect((await h.rpc('check.text', { text: 'x'.repeat(CHECK_MAX_CHARS), source: 'manual' }).catch((e: Error) => e.message)) as unknown).not.toMatch(/Invalid/);
  });

  it("hides a failing check's cause, which may quote the text, from the error and the log", async () => {
    const h = handlers({
      check: () => {
        throw new TypeError(`cannot resolve ${MARKER}`);
      },
      recent: () => [],
    });
    await expect(h.rpc('check.text', { text: MARKER, source: 'manual' })).rejects.toThrow(CHECK_FAILED_MESSAGE);
    const logged = JSON.stringify([h.log.debug.mock.calls, h.log.info.mock.calls, h.log.warn.mock.calls, h.log.error.mock.calls]);
    expect(logged).not.toContain('SECRET');
    expect(logged).toContain('TypeError');
  });
});

describe('parser and ring basics', () => {
  const resolve = vi.fn(() => null);

  it('parseCheckText refuses markup and lists with the shared reasons, else not-item when nothing resolves', () => {
    expect(parseCheckText('<b>Team Captain</b>', resolve)).toEqual({ ok: false, status: 'refused', reason: CHECK_REFUSALS.markup });
    expect(parseCheckText('a\nb\nc\nd', resolve)).toEqual({ ok: false, status: 'refused', reason: CHECK_REFUSALS.list });
    expect(parseCheckText('Team Captain', resolve)).toEqual({ ok: false, status: 'not-item', reason: CHECK_NOT_ITEM_REASON });
  });

  it('createLiveCheck numbers results, values money at the key price and keeps only item results', () => {
    const deps = {
      schema: { resolve },
      keyPrice: () => ({ valueScrap: 568 }),
    } as unknown as LiveCheckDeps;
    const lc = createLiveCheck(deps);
    const a = lc.check('Team Captain', 'manual', NOW);
    const b = lc.check('<i>x</i>', 'hotkey', NOW + 1);
    expect([a.id, a.status, a.keyScrap, a.checkedAt]).toEqual([1, 'not-item', 568, NOW]);
    expect([b.id, b.status, b.source]).toEqual([2, 'refused', 'hotkey']);
    expect(lc.recent()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Real core
// ---------------------------------------------------------------------------

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const requested: string[] = [];
const fetchImpl = (async (input: RequestInfo | URL) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  requested.push(u.hostname + u.pathname);
  if (u.hostname === 'sku.pricedb.io' && u.pathname === '/api/schema') return json(schemaSubset);
  if (u.hostname === 'sku.pricedb.io' && u.pathname === '/api/paint/list') return json(paintList);
  if (u.hostname === 'sku.pricedb.io') return json({ success: false }, 404);
  throw new TypeError(`fetch failed: the test refuses ${u.hostname}`);
}) as typeof fetch;

const temps: string[] = [];
const cores: ServiceCore[] = [];
afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  requested.length = 0;
});

describe('core wiring', () => {
  async function startCore() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-check-'));
    temps.push(root);
    const dataDir = path.join(root, 'data');
    const log = createLogger({ dataDir });
    const core = createServiceCore({
      dataDir,
      version: '0.5.0',
      settings: mergeSettings(DEFAULT_SETTINGS, {
        contactUrl: 'https://github.com/flipdesk-test',
        liveFeed: { enabled: false },
        connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
      }),
      secrets: {},
      log,
      fetchImpl,
      wsFactory: (url, headers) => new FakeSocket(url, headers),
    });
    cores.push(core);
    const pushes: { event: PushEvent; payload: unknown }[] = [];
    core.onPush((event, payload) => pushes.push({ event, payload }));
    await core.start();
    requested.length = 0;
    const logs = async (): Promise<string> => {
      await core.stop();
      log.flush();
      const logDir = path.join(root, 'logs');
      return readdirSync(logDir)
        .map((f) => readFileSync(path.join(logDir, f), 'utf8'))
        .join('\n');
    };
    return { core, pushes, logs };
  }

  it("answers 'check.text' locally, keeps nothing of the text and makes no request", async () => {
    const { core, pushes, logs } = await startCore();

    const r = (await core.handle('check.text', { text: `Team Captain ${MARKER}`, source: 'manual' })) as CheckResult;
    expect(r).toMatchObject({ status: 'not-item', source: 'manual', id: 1 });
    expect(JSON.stringify(r)).not.toContain('SECRET');
    const refused = (await core.handle('check.text', { text: `<b>${MARKER}</b>`, source: 'watch' })) as CheckResult;
    expect(refused).toMatchObject({ status: 'refused', reason: CHECK_REFUSALS.markup });
    await expect(core.handle('check.text', { text: MARKER.repeat(40), source: 'manual' })).rejects.toThrow(/at most 400 characters/);
    expect(await core.handle('check.recent', undefined)).toEqual([]);
    expect(pushes.map((p) => p.event)).not.toContain('check.done');
    expect(requested).toEqual([]);
    expect(await logs()).not.toContain('SECRET');
  });

  it('checks a copied scrap.tf/items row against the local book, pushes and keeps the result, and logs none of it', async () => {
    const { core, pushes, logs } = await startCore();
    const row = 'Team Captain\t1.33 refined\t1.22 refined\t3/5';

    const r = (await core.handle('check.text', { text: row, source: 'watch' })) as CheckResult;
    expect(r).toMatchObject({
      id: 1,
      status: 'item',
      source: 'watch',
      sku: '378;6',
      // The schema's name (it has the proper-name article).
      name: 'The Team Captain',
      price: { keys: 0, scrapRaw: 12, valueScrap: 12, source: 'clipboard' },
      scraptfPaysScrap: 11,
      stock: 3,
      stockLimit: 5,
      // No feed in this test: nobody buys it, so "Pay up to" is unknown too.
      verdict: 'no-buyers',
      revenue: { eligibleCount: 0, revenueScrap: null, maxCostScrap: null },
    });
    // The same result as 'item.detail' {history:false, target:'plain'} for the revenue and links.
    const detail = (await core.handle('item.detail', { sku: '378;6', history: false, target: 'plain' })) as { revenue: unknown; links: unknown };
    expect(r.revenue).toEqual(detail.revenue);
    expect(r.links).toEqual(detail.links);

    const done = pushes.filter((p) => p.event === 'check.done');
    expect(done).toEqual([{ event: 'check.done', payload: r }]);
    expect(await core.handle('check.recent', undefined)).toEqual([r]);
    const two = (await core.handle('check.text', { text: 'Team Captain\n2 keys', source: 'hotkey' })) as CheckResult;
    expect(two).toMatchObject({ id: 2, status: 'item', price: { keys: 2, source: 'clipboard' } });
    expect(((await core.handle('check.recent', null)) as CheckResult[]).map((x) => x.id)).toEqual([2, 1]);
    expect(requested).toEqual([]);

    const written = await logs();
    for (const piece of ['1.33 refined', '1.22 refined', '3/5', '2 keys']) expect(written).not.toContain(piece);
  });
});
