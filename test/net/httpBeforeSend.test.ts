import { describe, expect, it, vi } from 'vitest';
import { buildUserAgent, createHttpClient } from '../../src/service/net/http';
import { SecretRegistry } from '../../src/service/net/redact';
import { FakeTime, MemorySink, RecordingLogger, createFakeFetch, jsonResponse, redirectResponse } from './helpers';

const UA = buildUserAgent('0.1.0', 'https://example.invalid/contact');
const KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

function setup(onBeforeSend: Parameters<typeof createHttpClient>[0]['onBeforeSend'], handler = () => jsonResponse({ ok: true })) {
  const time = new FakeTime();
  const { fetch, calls } = createFakeFetch(handler, time);
  const sink = new MemorySink();
  const log = new RecordingLogger();
  const client = createHttpClient({ clock: time, timers: time, log, sink, userAgent: () => UA, fetchImpl: fetch, secrets: new SecretRegistry(), onBeforeSend });
  return { time, calls, sink, log, client };
}

describe('onBeforeSend', () => {
  it('reports each request before it is sent, with the start time and redacted path of its log row', async () => {
    const seen: { budget: string; ts: number; host: string; path: string; sentYet: number }[] = [];
    const h = setup((s) => seen.push({ ...s, sentYet: h.calls.length }));
    await h.client.request('https://api.backpack.tf/api/IGetCurrencies/v1', {
      query: { key: KEY, raw: 1 },
      secretQuery: ['key'],
      budget: 'bptf-currencies',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ budget: 'bptf-currencies', host: 'api.backpack.tf', sentYet: 0 });
    expect(seen[0]!.path).not.toContain(KEY);
    const row = h.sink.rows[0]!;
    expect({ ts: seen[0]!.ts, host: seen[0]!.host, path: seen[0]!.path }).toEqual({ ts: row.ts, host: row.host, path: row.path });
  });

  it('reports every redirect hop', async () => {
    const seen: string[] = [];
    let n = 0;
    const h = setup(
      (s) => seen.push(s.path),
      () => (n++ === 0 ? redirectResponse('https://pricedb.io/api/item/5021;6') : jsonResponse({ ok: true })),
    );
    await h.client.request('https://pricedb.io/api/item/old');
    expect(seen).toEqual(['/api/item/old', '/api/item/5021;6']);
  });

  it('never fails a request when the hook throws', async () => {
    const hook = vi.fn(() => {
      throw new Error('database is closed');
    });
    const h = setup(hook);
    const res = await h.client.request('https://pricedb.io/api/item/5021;6');
    expect(res.ok).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(h.log.calls.some((c) => c.level === 'warn' && /could not record the start/.test(c.msg))).toBe(true);
  });
});
