// The production socket factory against a local server that refuses the
// upgrade: the status and headers must reach the connector (R7), not just
// ws's "Unexpected server response: N". Loopback only; nothing leaves the machine.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createBptfSocket, defaultFactory, resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import type { HandshakeRejection, Repo } from '../../src/service/contracts';
import { FakeHttp, createLogger, createStubSchema, settingsWith } from './helpers';

const servers: Server[] = [];
afterEach(async () => {
  resetBptfSocketGuard();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** A server that answers every upgrade with the given raw status line and headers. */
async function refusingServer(statusLine: string, headers: Record<string, string>, body = ''): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  server.on('upgrade', (_req, socket) => {
    const head = Object.entries({ ...headers, 'Content-Length': String(Buffer.byteLength(body)), Connection: 'close' })
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('');
    socket.end(`HTTP/1.1 ${statusLine}\r\n${head}\r\n${body}`);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
}

function connectAndWait(url: string): Promise<{ events: string[]; rejection: HandshakeRejection | null; code: number }> {
  return new Promise((resolve) => {
    const events: string[] = [];
    let rejection: HandshakeRejection | null = null;
    const ws = defaultFactory(url, { 'User-Agent': 'TF2FlipDesk/0.1.0 (+https://example.test/contact)' });
    ws.on('open', () => events.push('open'));
    ws.on('handshake-rejected', (r) => {
      events.push('handshake-rejected');
      rejection = r;
    });
    ws.on('error', () => events.push('error'));
    ws.on('close', (code) => {
      events.push('close');
      resolve({ events, rejection, code });
    });
  });
}

describe('default websocket factory', () => {
  it('reports a 429 upgrade with its Retry-After before error and close', async () => {
    const url = await refusingServer('429 Too Many Requests', { 'Retry-After': '3600', 'Content-Type': 'application/json' }, '{"message":"slow down"}');
    const r = await connectAndWait(url);
    expect(r.events).toEqual(['handshake-rejected', 'error', 'close']);
    expect(r.rejection).toEqual({ status: 429, retryAfter: '3600', cfMitigated: '', contentType: 'application/json' });
    expect(r.code).toBe(1006);
  });

  it('reports a Cloudflare challenge', async () => {
    const url = await refusingServer('403 Forbidden', { 'cf-mitigated': 'challenge', 'Content-Type': 'text/html; charset=UTF-8' }, '<html>Just a moment...</html>');
    const r = await connectAndWait(url);
    expect(r.events).toEqual(['handshake-rejected', 'error', 'close']);
    expect(r.rejection).toEqual({ status: 403, retryAfter: null, cfMitigated: 'challenge', contentType: 'text/html; charset=UTF-8' });
  });

  it('reports a redirect instead of following it', async () => {
    const url = await refusingServer('301 Moved Permanently', { Location: 'https://example.test/' });
    const r = await connectAndWait(url);
    expect(r.events).toEqual(['handshake-rejected', 'error', 'close']);
    expect(r.rejection?.status).toBe(301);
  });
});

describe('live feed with the real client', () => {
  function feedAgainst(url: string) {
    const opened: string[] = [];
    const feed = createBptfSocket({
      clock: { now: () => Date.now() },
      log: createLogger(),
      repo: {} as Repo,
      http: new FakeHttp(),
      settings: () => settingsWith(),
      secret: () => null,
      schema: createStubSchema(),
      onBatch: () => undefined,
      wsFactory: (_url, headers) => {
        opened.push(url);
        return defaultFactory(url, headers);
      },
    });
    return { feed, opened };
  }

  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  }

  it('stops on a challenged upgrade', async () => {
    const url = await refusingServer('403 Forbidden', { 'cf-mitigated': 'challenge', 'Content-Type': 'text/html' }, '<html></html>');
    const { feed, opened } = feedAgainst(url);
    feed.start();
    await until(() => feed.health().state === 'blocked');
    await new Promise((r) => setTimeout(r, 1_200)); // a tick passes; nothing reconnects
    expect(feed.health()).toMatchObject({ state: 'blocked' });
    expect(feed.health().disabledReason).toMatch(/HTTP 403, Cloudflare challenge/);
    expect(opened).toHaveLength(1);
    feed.stop();
  });

  it('waits out Retry-After on a 429 upgrade', async () => {
    const url = await refusingServer('429 Too Many Requests', { 'Retry-After': '3600' });
    const { feed, opened } = feedAgainst(url);
    feed.start();
    await until(() => feed.health().state === 'backoff');
    await new Promise((r) => setTimeout(r, 1_200));
    expect(feed.health()).toMatchObject({ state: 'backoff', lastError: 'backpack.tf refused the live feed connection (HTTP 429)' });
    expect(feed.health().detail).toMatch(/reconnecting in 60 min/);
    expect(opened).toHaveLength(1);
    feed.stop();
  });
});
