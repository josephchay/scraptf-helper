// F19 S2 in the service: 'check.text' passes main's hint (zod-checked under the SKU rule) on to the live
// check only when one was sent, pushes 'check.done' for a hinted item result like any other, and the real
// core checks a price-only copy as the hinted item with the matched note, while text naming an item wins
// and no hint changes nothing. Nothing of the text reaches a result, an error or the log files on disk;
// no request is made after start (R1: nothing here contacts scrap.tf).

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import { createServiceCore, type ServiceCore } from '../../src/service/core';
import { createLogger } from '../../src/service/logger';
import { createRpcHandlers, type HandlerContext } from '../../src/service/rpcHandlers';
import { blankCheckResult, CHECK_NOT_ITEM_REASON, checkHintedNote, checkMatchedByHint } from '../../src/shared/check';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushEvent } from '../../src/shared/rpc';
import type { CheckResult } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const MARKER = 'Zq7-SECRET-MARKER';

function hintedItem(id: number): CheckResult {
  return {
    ...blankCheckResult('not-item', 'x', 'hotkey', NOW, id),
    status: 'item',
    reason: checkHintedNote('Team Captain'),
    sku: '378;6',
    name: 'Team Captain',
    category: 'hats',
    verdict: 'flip',
  };
}

function handlers(check: HandlerContext['liveCheck']['check']) {
  const pushes: { event: PushEvent; payload: unknown }[] = [];
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx = {
    clock: { now: () => NOW },
    log,
    liveCheck: { check, recent: () => [] },
    push: (event: PushEvent, payload: unknown) => pushes.push({ event, payload }),
  } as unknown as HandlerContext;
  return { rpc: createRpcHandlers(ctx), pushes, log };
}

describe("'check.text' handler with a hint (F19)", () => {
  it('passes the cleaned hint on only when main sent one', async () => {
    const check = vi.fn((_t: string, source, now: number) => blankCheckResult('not-item', CHECK_NOT_ITEM_REASON, source, now, 1));
    const h = handlers(check);
    await h.rpc('check.text', { text: '1.33 ref', source: 'hotkey', hint: { sku: ' 378;6;P3100495 ' } });
    expect(check).toHaveBeenLastCalledWith('1.33 ref', 'hotkey', NOW, { sku: '378;6;p3100495' });
    await h.rpc('check.text', { text: '1.33 ref', source: 'watch' });
    expect(check.mock.calls[1]).toEqual(['1.33 ref', 'watch', NOW]);
    // Unknown keys of the hint are dropped, never passed on.
    await h.rpc('check.text', { text: '1 ref', source: 'watch', hint: { sku: '378;6', name: MARKER } });
    expect(check.mock.calls[2]).toEqual(['1 ref', 'watch', NOW, { sku: '378;6' }]);
    expect(h.pushes).toEqual([]);
  });

  it("pushes 'check.done' for a hinted item result, like any item result", async () => {
    const item = hintedItem(4);
    const h = handlers(() => item);
    const r = await h.rpc('check.text', { text: '1.33 ref', source: 'watch', hint: { sku: '378;6' } });
    expect(r).toBe(item);
    expect(h.pushes).toEqual([{ event: 'check.done', payload: item }]);
  });

  it('rejects an invalid hint before the check, with a fixed message that never quotes the text', async () => {
    const check = vi.fn();
    const h = handlers(check);
    for (const hint of [{ sku: MARKER }, { sku: '' }, { sku: 5 }, MARKER, null]) {
      const err = await h.rpc('check.text', { text: `${MARKER} 1.33 ref`, source: 'hotkey', hint }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message, JSON.stringify(hint)).toMatch(/^Invalid parameters for check\.text: hint/);
      expect(err?.message).not.toContain('SECRET');
    }
    expect(check).not.toHaveBeenCalled();
    expect(JSON.stringify([h.log.debug.mock.calls, h.log.info.mock.calls, h.log.warn.mock.calls, h.log.error.mock.calls])).not.toContain('SECRET');
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

async function startCore() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-checkhint-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  const log = createLogger({ dataDir });
  const core = createServiceCore({
    dataDir,
    version: '0.6.0',
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

describe('core wiring (F19 S2)', () => {
  it('checks a price-only copy as the hinted item, pushes and keeps it, and logs none of the text', async () => {
    const { core, pushes, logs } = await startCore();
    const text = '  1.33   refined  ';

    const r = (await core.handle('check.text', { text, source: 'hotkey', hint: { sku: '378;6' } })) as CheckResult;
    expect(r).toMatchObject({
      id: 1,
      status: 'item',
      source: 'hotkey',
      sku: '378;6',
      // The schema's name, never the text.
      name: 'The Team Captain',
      price: { keys: 0, scrapRaw: 12, valueScrap: 12, source: 'clipboard' },
      verdict: 'no-buyers',
    });
    expect(r.reason).toBe(checkHintedNote('The Team Captain'));
    expect(checkMatchedByHint(r)).toBe(true);
    expect(pushes.filter((p) => p.event === 'check.done')).toEqual([{ event: 'check.done', payload: r }]);
    expect(await core.handle('check.recent', undefined)).toEqual([r]);

    // Without the hint: not an item, as before.
    expect(await core.handle('check.text', { text, source: 'watch' })).toMatchObject({ status: 'not-item', reason: CHECK_NOT_ITEM_REASON });
    // Text naming an item wins over the hint.
    const named = (await core.handle('check.text', { text: 'Team Captain, 2 keys', source: 'watch', hint: { sku: '205;6' } })) as CheckResult;
    expect(named).toMatchObject({ status: 'item', sku: '378;6', price: { keys: 2, source: 'clipboard' } });
    expect(checkMatchedByHint(named)).toBe(false);
    // An invalid hint is refused with a fixed message.
    await expect(core.handle('check.text', { text, source: 'hotkey', hint: { sku: MARKER } })).rejects.toThrow(/^Invalid parameters for check\.text: hint/);
    expect(((await core.handle('check.recent', null)) as CheckResult[]).map((x) => x.id)).toEqual([3, 1]);
    expect(requested).toEqual([]);

    const written = await logs();
    for (const piece of [text.trim(), 'Team Captain, 2 keys', 'SECRET']) expect(written).not.toContain(piece);
  });

  it('F19-PRIV-1 / F19-HINT-BARE-NUMBER: a number copied elsewhere while armed is no item, so nothing is pushed or kept', async () => {
    const { core, pushes, logs } = await startCore();
    // A SteamID64 (fails Luhn, so main's filter lets it through), a year, a code, a stock count, a lone 1.
    const texts = ['76561198012345678', '2024', '482913', '49', '1'];
    for (const text of texts) {
      const r = (await core.handle('check.text', { text, source: 'watch', hint: { sku: '378;6' } })) as CheckResult;
      expect(r, text).toMatchObject({ status: 'not-item', reason: CHECK_NOT_ITEM_REASON, sku: null, price: null, verdict: null });
    }
    for (const text of texts.slice(0, 3)) {
      expect(await core.handle('check.text', { text, source: 'hotkey', hint: { sku: '378;6' } }), text).toMatchObject({ status: 'not-item', price: null });
    }
    expect(pushes.filter((p) => p.event === 'check.done')).toEqual([]);
    expect(await core.handle('check.recent', undefined)).toEqual([]);
    expect(requested).toEqual([]);
    // Only the long one: a short number could turn up in a log line's own timestamp.
    expect(await logs()).not.toContain(texts[0]);
  });
});
