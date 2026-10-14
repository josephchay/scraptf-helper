// End-to-end through the real HttpClient (fake fetch, fake timers): the access
// token must reach backpack.tf but never the request log or the logger.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { META_TOKEN_METHOD, SNAPSHOT_URL, createBptfApi } from '../../src/service/connectors/bptfApi';
import { openRepo } from '../../src/service/db';
import { SecretRegistry, createHttpClient } from '../../src/service/net';
import type { RequestLogRow } from '../../src/shared/types';
import { createLogger, createStubSchema, loadFixture, settingsWith } from './helpers';

const TOKEN = 'tok_E2E_SECRET_0123456789';
const snapshots = loadFixture<{ responses: Record<string, unknown> }>('snapshot-responses.json').responses;

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 14, 12, 0, 0) });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('bptfApi over the real HttpClient', () => {
  it('falls back from header to query auth with budgets, redaction and honest headers', async () => {
    const requests: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      requests.push({ url, headers });
      const u = new URL(url);
      const body =
        u.searchParams.get('token') === TOKEN
          ? { status: 200, json: snapshots['Strange Pain Train'] }
          : { status: 401, json: { message: 'This access token is not valid.' } };
      return new Response(JSON.stringify(body.json), { status: body.status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const rows: RequestLogRow[] = [];
    const log = createLogger();
    const http = createHttpClient({
      clock: { now: () => Date.now() },
      log,
      sink: { record: (r) => rows.push(r) },
      userAgent: () => 'TF2FlipDesk/0.1.0 (+https://example.test/contact)',
      fetchImpl,
      secrets: new SecretRegistry(),
    });
    const repo = openRepo(':memory:');
    try {
      const api = createBptfApi({
        clock: { now: () => Date.now() },
        log,
        repo,
        http,
        settings: () => settingsWith(),
        secret: (n) => (n === 'bptfAccessToken' ? TOKEN : null),
        schema: createStubSchema(),
      });
      const p = api.snapshot('154;11', 'user');
      await vi.advanceTimersByTimeAsync(10_000);
      const r = await p;
      expect(r.listings).toHaveLength(4);

      expect(requests).toHaveLength(2);
      expect(requests[0]!.headers['x-auth-token']).toBe(TOKEN);
      expect(requests[0]!.url).not.toContain(TOKEN);
      expect(new URL(requests[1]!.url).searchParams.get('token')).toBe(TOKEN);
      expect(requests[1]!.headers['x-auth-token']).toBeUndefined();
      for (const q of requests) {
        expect(q.url.startsWith(`${SNAPSHOT_URL}?`)).toBe(true);
        expect(q.headers['user-agent']).toBe('TF2FlipDesk/0.1.0 (+https://example.test/contact)');
        expect(q.headers['x-app-context']).toBe('440');
      }
      expect(repo.getMeta(META_TOKEN_METHOD)).toBe('query');

      expect(rows).toHaveLength(2);
      expect(rows.map((x) => x.status)).toEqual([401, 200]);
      expect(rows[1]!.path).toContain('token=REDACTED');
      const everything = JSON.stringify(rows) + log.text() + JSON.stringify(api.health());
      expect(everything).not.toContain(TOKEN);
    } finally {
      repo.close();
    }
  });
});
