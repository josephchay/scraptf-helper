// Test doubles for the schema / PriceDB / SCM connectors. Nothing here touches the network.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clock, HttpClient, HttpRequestOptions, HttpResponse, Logger, Repo, ServiceDeps } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import type { TimerApi } from '../../src/service/net/ratelimit';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { DeepPartial, Settings } from '../../src/shared/types';

export const FIXTURES = fileURLToPath(new URL('../fixtures/pricedb/', import.meta.url));
export const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

const cache = new Map<string, unknown>();
/** Parsed fixture (cached; callers must not mutate it). */
export function fixture<T = unknown>(name: string): T {
  if (!cache.has(name)) cache.set(name, JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')));
  return cache.get(name) as T;
}

export class FakeClock implements Clock {
  constructor(public t = T0) {}
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

interface PendingTimer {
  at: number;
  seq: number;
  fn: () => void;
}

/** Manual timers bound to a FakeClock. */
export class FakeTimers implements TimerApi {
  private seq = 0;
  readonly pending = new Map<number, PendingTimer>();
  constructor(private readonly clock: FakeClock) {}

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.pending.set(id, { at: this.clock.t + Math.max(0, ms), seq: id, fn });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  /** Delays (ms from now) of the pending timers, soonest first. */
  delays(): number[] {
    return [...this.pending.values()].map((t) => t.at - this.clock.t).sort((a, b) => a - b);
  }

  /** Advances the clock, firing due timers in order and letting promises settle. */
  async advance(ms: number): Promise<void> {
    const end = this.clock.t + ms;
    await flush();
    for (;;) {
      let next: PendingTimer | null = null;
      for (const t of this.pending.values()) {
        if (t.at > end) continue;
        if (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq)) next = t;
      }
      if (!next) break;
      this.pending.delete(next.seq);
      this.clock.t = Math.max(this.clock.t, next.at);
      next.fn();
      await flush();
    }
    this.clock.t = end;
    await flush();
  }
}

export async function flush(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r));
}

export class SilentLogger implements Logger {
  readonly lines: string[] = [];
  debug(msg: string): void {
    this.lines.push(`debug ${msg}`);
  }
  info(msg: string): void {
    this.lines.push(`info ${msg}`);
  }
  warn(msg: string): void {
    this.lines.push(`warn ${msg}`);
  }
  error(msg: string): void {
    this.lines.push(`error ${msg}`);
  }
}

export interface HttpCall {
  url: string;
  opts: HttpRequestOptions;
}

export type Route = (url: string, opts: HttpRequestOptions) => HttpResponse | Promise<HttpResponse>;

export function res(data: unknown, init: { status?: number; headers?: Record<string, string>; etag?: string | null } = {}): HttpResponse {
  const status = init.status ?? 200;
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers ?? {}) };
  if (init.etag) headers['etag'] = init.etag;
  return {
    status,
    ok: status >= 200 && status < 300,
    data: status === 304 ? null : (data as unknown),
    text: null,
    headers,
    etag: init.etag ?? null,
    notModified: status === 304,
    bytes: 0,
    ms: 1,
  };
}

/** HttpClient double: routes by URL, records every call. */
export class FakeHttp implements HttpClient {
  readonly calls: HttpCall[] = [];
  paused = false;
  /** Host blocks, as the real client keeps (and persists) them. */
  readonly blocked = new Map<string, string>();
  constructor(public route: Route) {}

  async request<T = unknown>(url: string, opts: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
    this.calls.push({ url, opts });
    return (await this.route(url, opts)) as HttpResponse<T>;
  }
  setPaused(p: boolean): void {
    this.paused = p;
  }
  isPaused(): boolean {
    return this.paused;
  }
  nextAllowedAt(): number {
    return 0;
  }
  budgets() {
    return [];
  }
  hostBlocked(host: string): string | null {
    return this.blocked.get(host) ?? null;
  }
  blockHost(host: string, reason: string): void {
    this.blocked.set(host, reason);
  }
  unblockHost(host: string): void {
    this.blocked.delete(host);
  }
  userAgent(): string {
    return 'TF2FlipDesk/0.1.0 (+test)';
  }
  urls(): string[] {
    return this.calls.map((c) => c.url);
  }
}

export function makeSettings(patch: DeepPartial<Settings> = {}): Settings {
  return mergeSettings(DEFAULT_SETTINGS, patch);
}

export interface TestDeps extends ServiceDeps {
  repo: Repo;
  http: FakeHttp;
  clock: FakeClock;
  log: SilentLogger;
  setSettings(patch: DeepPartial<Settings>): void;
}

export function makeDeps(route: Route, opts: { repo?: Repo; clock?: FakeClock; settings?: DeepPartial<Settings> } = {}): TestDeps {
  let settings = makeSettings(opts.settings);
  const deps: TestDeps = {
    clock: opts.clock ?? new FakeClock(),
    log: new SilentLogger(),
    repo: opts.repo ?? openRepo(':memory:'),
    http: new FakeHttp(route),
    settings: () => settings,
    secret: () => null,
    setSettings(patch) {
      settings = mergeSettings(settings, patch);
    },
  };
  return deps;
}

export const SCHEMA_URL = 'https://sku.pricedb.io/api/schema';
export const PAINT_URL = 'https://sku.pricedb.io/api/paint/list';

/** Route serving the schema subset and paint list fixtures. */
export function schemaRoute(extra?: Route, etag = 'W/"subset-1"'): Route {
  return (url, opts) => {
    if (url === SCHEMA_URL) {
      if (opts.ifNoneMatch && opts.ifNoneMatch === etag) return res(null, { status: 304, etag });
      return res(fixture('schema-subset.json'), { etag });
    }
    if (url === PAINT_URL) return res(fixture('paint-list.json'));
    if (extra) return extra(url, opts);
    return res({ error: 'not found' }, { status: 404 });
  };
}
