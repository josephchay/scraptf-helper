// Audit bptfnet-2: Settings > Test of the API key answers from the last accepted call while the
// key-price slot is busy. A response that rejected the key must never count as that acceptance,
// and a later rejection must forget an earlier one.

import { afterEach, describe, expect, it } from 'vitest';
import { BptfCredentialError, createBptfApi } from '../../src/service/connectors/bptfApi';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { FakeHttp, createLogger, createStubSchema, jsonResponse, loadFixture, settingsWith, type HttpHandler } from './helpers';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const KEY = 'key_SECRET_fedcba9876543210';
const MIN = 60_000;

const currencies = loadFixture<{ objectForm: unknown; failure: unknown }>('igetcurrencies-v1.json');
const prices = loadFixture('igetprices-v4.json');

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function harness(handler: HttpHandler) {
  let now = T0;
  const repo = openRepo(':memory:');
  repos.push(repo);
  const http = new FakeHttp(handler);
  const settings = settingsWith();
  const api = createBptfApi({
    clock: { now: () => now },
    log: createLogger(),
    repo,
    http,
    settings: () => settings,
    secret: (n) => (n === 'bptfApiKey' ? KEY : null),
    schema: createStubSchema(),
  });
  return {
    api,
    http,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    /** The scheduled call just used the IGetCurrencies slot (5 min spacing), as the real limiter reports it. */
    slotBusy: () => http.next.set('bptf-currencies', now + 5 * MIN),
    health: (id: string) => api.health().find((x) => x.id === id)!,
  };
}

describe('audit: a rejected API key is never vouched for by the key test', () => {
  it('a 200 success:0 key rejection is not remembered as accepted', async () => {
    const h = harness(() => jsonResponse(200, currencies.failure));
    await expect(h.api.currencies()).rejects.toBeInstanceOf(BptfCredentialError);
    h.slotBusy();
    h.advance(MIN);
    const r = await h.api.test('bptfApiKey');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/used recently .* Test again after/);
    expect(h.http.calls).toHaveLength(1);
  });

  it('a later 403 rejection forgets an earlier acceptance', async () => {
    const h = harness(() => jsonResponse(200, currencies.objectForm));
    await h.api.currencies();
    h.advance(30 * MIN);
    h.http.handler = () => jsonResponse(403, { response: { success: 0, message: 'This API key is not valid.' } });
    await expect(h.api.currencies()).rejects.toBeInstanceOf(BptfCredentialError);
    expect(h.health('bptf-currencies').state).toBe('blocked');
    h.slotBusy();
    h.advance(MIN);
    const r = await h.api.test('bptfApiKey');
    expect(r.ok).toBe(false);
    expect(r.message).not.toMatch(/accepted it/);
    expect(h.http.calls).toHaveLength(2);
  });

  it('the same through IGetPrices', async () => {
    const h = harness(() => jsonResponse(200, prices));
    await h.api.prices();
    h.advance(10 * MIN);
    h.http.handler = () => jsonResponse(200, { response: { success: 0, message: 'API key does not exist.' } });
    await expect(h.api.prices()).rejects.toBeInstanceOf(BptfCredentialError);
    h.slotBusy();
    h.advance(MIN);
    const r = await h.api.test('bptfApiKey');
    expect(r.ok).toBe(false);
    expect(r.message).not.toMatch(/accepted it/);
    expect(h.http.calls).toHaveLength(2);
  });

  it('still answers from a real acceptance while the slot is busy', async () => {
    const h = harness(() => jsonResponse(200, currencies.objectForm));
    await h.api.currencies();
    h.slotBusy();
    h.advance(30_000);
    expect(await h.api.test('bptfApiKey')).toEqual({ ok: true, message: 'API key works: backpack.tf accepted it just now.' });
    expect(h.http.calls).toHaveLength(1);
  });
});
