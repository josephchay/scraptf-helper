// 0.9 (#14): the Steam Web API reports its rate limits in the x-eresult header (25 LimitExceeded, 84
// RateLimitExceeded), even on an HTTP 200. The client counts such an answer as a 429 (the budget pauses, the host
// streak counts) and returns it with ok false and its true status. Only api.steampowered.com is read this way.
// Fake fetch and clock: nothing here reaches the network.

import { describe, expect, it } from 'vitest';
import type { HttpClient } from '../../src/service/contracts';
import { STEAM_RATE_LIMIT_ERESULTS, buildUserAgent, createHttpClient, steamRateLimitEresult } from '../../src/service/net/http';
import { SecretRegistry } from '../../src/service/net/redact';
import { FakeTime, MemorySink, RecordingLogger, T0, createFakeFetch, jsonResponse, type FetchHandler } from './helpers';

const UA = buildUserAgent('0.1.0', 'https://example.invalid/contact');
const MIN = 60_000;
const HOUR = 60 * MIN;
const STEAM = 'https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/';
const PRICEDB = 'https://pricedb.io/api/item/5021;6';

function setup(handler: FetchHandler) {
  const time = new FakeTime();
  const { fetch, calls } = createFakeFetch(handler, time);
  const sink = new MemorySink();
  const log = new RecordingLogger();
  const client: HttpClient = createHttpClient({ clock: time, timers: time, log, sink, userAgent: () => UA, fetchImpl: fetch, secrets: new SecretRegistry() });
  return { time, calls, sink, log, client };
}

const steamBudget = (client: HttpClient) => client.budgets().find((b) => b.id === 'steam-webapi')!;
const eresultAnswer = (eresult: string) => () => jsonResponse({ response: {} }, { status: 200, headers: { 'x-eresult': eresult } });

describe('steamRateLimitEresult', () => {
  it('reads 25 and 84 from api.steampowered.com only', () => {
    expect([...STEAM_RATE_LIMIT_ERESULTS].sort()).toEqual(['25', '84']);
    expect(steamRateLimitEresult('api.steampowered.com', { 'x-eresult': '84' })).toBe('84');
    expect(steamRateLimitEresult('API.SteamPowered.com.', { 'x-eresult': ' 25 ' })).toBe('25');
    expect(steamRateLimitEresult('api.steampowered.com', { 'x-eresult': '1' })).toBeNull();
    expect(steamRateLimitEresult('api.steampowered.com', {})).toBeNull();
    expect(steamRateLimitEresult('pricedb.io', { 'x-eresult': '84' })).toBeNull();
    expect(steamRateLimitEresult('steamcommunity.com', { 'x-eresult': '84' })).toBeNull();
  });
});

describe('x-eresult as a rate limit', () => {
  it.each(['84', '25'])('a 200 with x-eresult %s pauses the budget like a 429 and is not ok', async (eresult) => {
    const { client, sink, log } = setup(eresultAnswer(eresult));
    const res = await client.request(STEAM);
    expect(res.status).toBe(200);
    expect(res.ok).toBe(false);
    expect(res.data).toEqual({ response: {} });
    expect(client.nextAllowedAt('steam-webapi')).toBe(T0 + 60_000);
    expect(steamBudget(client).consecutive429).toBe(1);
    expect(sink.rows[0]!.note).toMatch(new RegExp(`x-eresult ${eresult}`));
    expect(sink.rows[0]!.note).toMatch(/^HTTP 200 \(x-eresult \d+\): steam-webapi paused/);
    expect(log.calls.some((c) => c.level === 'warn' && c.msg.includes(`x-eresult ${eresult}`))).toBe(true);
    // Not a challenge: the host stays enabled.
    expect(client.hostBlocked('api.steampowered.com')).toBeNull();
  });

  it('x-eresult 1 (OK) is a success, with no pause', async () => {
    const { client, sink } = setup(eresultAnswer('1'));
    const res = await client.request(STEAM);
    expect(res).toMatchObject({ status: 200, ok: true });
    expect(client.nextAllowedAt('steam-webapi')).toBe(T0 + 1_000);
    expect(steamBudget(client).consecutive429).toBe(0);
    expect(sink.rows[0]!.note ?? null).toBeNull();
  });

  it('is read on api.steampowered.com only: x-eresult 84 from pricedb.io is an ordinary answer', async () => {
    const { client } = setup(eresultAnswer('84'));
    const res = await client.request(PRICEDB);
    expect(res).toMatchObject({ status: 200, ok: true });
    expect(client.budgets().find((b) => b.id === 'pricedb')!.consecutive429).toBe(0);
    expect(client.budgets().find((b) => b.id === 'pricedb')!.pausedUntil).toBeNull();
  });

  it('three in a row pause the host for an hour', async () => {
    const { client, calls, time, sink } = setup(eresultAnswer('84'));
    await client.request(STEAM);
    const second = client.request(STEAM, { maxWaitMs: HOUR });
    await time.advance(10 * MIN);
    await second;
    const third = client.request(STEAM, { maxWaitMs: HOUR });
    await time.advance(10 * MIN);
    await third;
    expect(calls).toHaveLength(3);
    // The third answer arrived when its request was sent (the fake fetch answers at once).
    const third429At = calls[2]!.at;
    expect(third429At).toBeLessThanOrEqual(time.now());
    expect(sink.rows[2]!.note).toMatch(/HTTP 200 \(x-eresult 84\) x3: api\.steampowered\.com paused 1 h/);
    expect(steamBudget(client).consecutive429).toBe(3);
    expect(steamBudget(client).pausedUntil).toBe(third429At + HOUR);
    expect(client.nextAllowedAt('steam-webapi')).toBe(third429At + HOUR);
  });

  it('an ordinary answer after one ends the streak', async () => {
    let limited = true;
    const { client, time } = setup(() => (limited ? eresultAnswer('84')() : jsonResponse({ response: {} })));
    await client.request(STEAM);
    limited = false;
    const next = client.request(STEAM, { maxWaitMs: HOUR });
    await time.advance(2 * MIN);
    expect((await next).ok).toBe(true);
    expect(steamBudget(client).consecutive429).toBe(0);
  });
});
