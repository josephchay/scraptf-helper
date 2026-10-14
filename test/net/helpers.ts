// Test doubles for the network layer: fake clock + timers, fake fetch, an
// in-memory request-log sink and a recording logger. Nothing here touches the
// network.

import type { Clock, Logger, RequestLogSink } from '../../src/service/contracts';
import type { RequestLogRow } from '../../src/shared/types';
import type { TimerApi } from '../../src/service/net/ratelimit';

export const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

/** Lets pending promise chains settle (several macrotask turns). */
export async function flush(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r));
}

interface PendingTimer {
  at: number;
  seq: number;
  fn: () => void;
}

export class FakeTime implements Clock, TimerApi {
  private t: number;
  private seq = 0;
  private readonly pending = new Map<number, PendingTimer>();

  constructor(start = T0) {
    this.t = start;
  }

  now = (): number => this.t;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.pending.set(id, { at: this.t + Math.max(0, ms), seq: id, fn });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  get timerCount(): number {
    return this.pending.size;
  }

  /** Moves time forward, firing due timers in order and letting promises settle between them. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    await flush();
    for (;;) {
      let nextId: number | null = null;
      let next: PendingTimer | null = null;
      for (const [id, timer] of this.pending) {
        if (timer.at > end) continue;
        if (!next || timer.at < next.at || (timer.at === next.at && timer.seq < next.seq)) {
          next = timer;
          nextId = id;
        }
      }
      if (!next || nextId === null) break;
      this.pending.delete(nextId);
      this.t = Math.max(this.t, next.at);
      next.fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  signal: AbortSignal | null;
  redirect: RequestRedirect | undefined;
  at: number;
}

export type FetchHandler = (call: FetchCall) => Response | Promise<Response>;

function abortError(): DOMException {
  return new DOMException('This operation was aborted', 'AbortError');
}

/** A fetch double that records every call and honours the abort signal like undici does. */
export function createFakeFetch(handler: FetchHandler, clock?: Clock): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
      signal: init?.signal ?? null,
      redirect: init?.redirect,
      at: clock ? clock.now() : Date.now(),
    };
    calls.push(call);
    const signal = call.signal;
    if (signal?.aborted) throw abortError();
    return await new Promise<Response>((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      Promise.resolve()
        .then(() => handler(call))
        .then(resolve, reject);
    });
  };
  return { fetch: impl as typeof fetch, calls };
}

/** A response that never arrives (until the request is aborted). */
export function hang(): Promise<Response> {
  return new Promise<Response>(() => undefined);
}

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

export function textResponse(text: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(text, { status: init.status ?? 200, headers: init.headers ?? {} });
}

export function redirectResponse(location: string, status = 302): Response {
  return new Response('redirecting', { status, headers: { location } });
}

export class MemorySink implements RequestLogSink {
  readonly rows: RequestLogRow[] = [];
  record(row: RequestLogRow): void {
    this.rows.push({ ...row });
  }
}

export interface LogCall {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  meta: unknown;
}

export class RecordingLogger implements Logger {
  readonly calls: LogCall[] = [];
  debug(msg: string, meta?: unknown): void {
    this.calls.push({ level: 'debug', msg, meta });
  }
  info(msg: string, meta?: unknown): void {
    this.calls.push({ level: 'info', msg, meta });
  }
  warn(msg: string, meta?: unknown): void {
    this.calls.push({ level: 'warn', msg, meta });
  }
  error(msg: string, meta?: unknown): void {
    this.calls.push({ level: 'error', msg, meta });
  }
}
