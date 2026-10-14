// backpack.tf live feed: one websocket to wss://ws.backpack.tf/events
// (DESIGN_BRIEF §2.1). Frames are mapped to Listings and handed to onBatch once
// per second. Exactly one connection per process; the server closes extra ones
// with `client-limit-exceeeded`, which stops the feed until the user turns the
// live feed off and on again (or restarts the app).
//
// A refused upgrade is handled like an HTTP answer (R7, §2.0): a Cloudflare
// challenge, 401/403 or an HTML 503 stops the feed the same way; 429/503 honour
// Retry-After (at least 60 s, 1 h after three 429s in a row); any other non-101
// answer backs off 60 s, doubling to 15 min.

import WebSocket from 'ws';
import { z } from 'zod';
import type { BptfNameRow, BptfSocket, FeedBatch, HandshakeRejection, SchemaService, ServiceDeps, WebSocketLike } from '../contracts';
import type { ConnState, ConnectorHealth, Listing, UnixMs } from '../../shared/types';
import { CONSECUTIVE_429_LIMIT, LONG_PAUSE_MS, assertAllowed, backoffMs, parseRetryAfter, scrubText } from '../net';
import { createMapStats, mapWsPayload, type BptfMapStats } from './bptfItem';

export const BPTF_WS_URL = 'wss://ws.backpack.tf/events';
export const FLUSH_INTERVAL_MS = 1_000;
export const BACKOFF_INITIAL_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
export const SILENCE_TIMEOUT_MS = 120_000;
/** A connection that stayed open this long resets the backoff. */
export const STABLE_CONNECTION_MS = 30_000;
/** A polite close that gets no answer is terminated after this long. */
export const CLOSE_GRACE_MS = 5_000;
/** Shortest wait after backpack.tf refuses the websocket upgrade (§2.0). */
export const REJECTED_MIN_DELAY_MS = 60_000;

export interface SocketTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const globalTimers: SocketTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export type BptfSocketDeps = ServiceDeps & {
  schema: SchemaService;
  onBatch(b: FeedBatch): void;
  wsFactory?: (url: string, headers: Record<string, string>) => WebSocketLike;
  timers?: SocketTimers;
};

/** Extra counters for the Data health page and tests. */
export interface BptfSocketDetail {
  framesToday: number;
  bufferLimitEvents: number;
  unknownEvents: number;
  reconnects: number;
  mapStats: BptfMapStats;
}

function headerText(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v.join(', ') : (v ?? '');
}

/** The production socket factory (exported for tests against a local server). */
export function defaultFactory(url: string, headers: Record<string, string>): WebSocketLike {
  const ws = new WebSocket(url, {
    headers,
    perMessageDeflate: true,
    handshakeTimeout: 20_000,
    followRedirects: false,
  });
  // Without this listener `ws` reduces a non-101 answer to "Unexpected server
  // response: N", losing the status and headers R7 needs (Retry-After, cf-mitigated).
  ws.on('unexpected-response', (_req, res) => {
    const h = res.headers;
    const rejection: HandshakeRejection = {
      status: res.statusCode ?? 0,
      retryAfter: headerText(h['retry-after']) || null,
      cfMitigated: headerText(h['cf-mitigated']),
      contentType: headerText(h['content-type']),
    };
    res.resume(); // discard the body
    try {
      ws.emit('handshake-rejected', rejection);
    } finally {
      ws.terminate(); // still CONNECTING: emits 'error' and 'close' (1006)
    }
  });
  return ws as unknown as WebSocketLike;
}

function formatDelay(ms: number): string {
  return ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
}

// Process-wide guard: a second connection from this process would trip the
// server's per-IP limit and could get both closed.
let liveOwner: object | null = null;

/** Test hook: forget a connection owner left behind by a failed test. */
export function resetBptfSocketGuard(): void {
  liveOwner = null;
}

const envelopeSchema = z.looseObject({
  id: z.unknown().optional(),
  event: z.string(),
  payload: z.unknown().optional(),
});
const deletePayloadSchema = z.looseObject({
  id: z.union([z.string().min(1), z.number().transform((n) => String(n))]),
  appid: z.unknown().optional(),
});

const DELETE = Symbol('delete');

function localDayKey(ms: UnixMs): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function frameText(data: unknown): { text: string; bytes: number } | null {
  if (typeof data === 'string') return { text: data, bytes: Buffer.byteLength(data, 'utf8') };
  if (Buffer.isBuffer(data)) return { text: data.toString('utf8'), bytes: data.byteLength };
  if (data instanceof ArrayBuffer) return { text: Buffer.from(data).toString('utf8'), bytes: data.byteLength };
  if (ArrayBuffer.isView(data)) {
    const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return { text: b.toString('utf8'), bytes: b.byteLength };
  }
  if (Array.isArray(data) && data.every((c) => Buffer.isBuffer(c))) {
    const b = Buffer.concat(data as Buffer[]);
    return { text: b.toString('utf8'), bytes: b.byteLength };
  }
  return null;
}

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

export function createBptfSocket(deps: BptfSocketDeps): BptfSocket & { detail(): BptfSocketDetail } {
  const { clock, log, schema } = deps;
  const timers = deps.timers ?? globalTimers;
  const factory = deps.wsFactory ?? defaultFactory;
  const owner = {};

  let started = false;
  let ws: WebSocketLike | null = null;
  let tick: unknown = null;
  let reconnectTimer: unknown = null;
  let attempts = 0;
  let openedAt: UnixMs | null = null;
  let lastActivityAt: UnixMs | null = null;

  let state: ConnState = 'off';
  let detailText = 'Not started';
  let lastOkAt: UnixMs | null = null;
  let lastErrorAt: UnixMs | null = null;
  let lastError: string | null = null;
  let disabledReason: string | null = null;
  /**
   * Set by client-limit, refused-upgrade and policy refusals. Cleared only by a
   * start() after a stop() that ran with the live feed turned off in Settings,
   * so a network pause / resume does not retry a refused connection.
   */
  let blocked = false;
  /** stop() ran while the live feed was turned off in Settings (the user's way to re-enable a blocked feed). */
  let feedTurnedOff = false;
  /** Refused upgrades in a row, and how many of them were 429; reset when a connection opens. */
  let rejections = 0;
  let consecutive429 = 0;
  /** No connection attempt before this time (Retry-After / backoff after a refused upgrade). */
  let retryNotBefore: UnixMs = 0;
  let retryWhy = '';

  let dayKey = localDayKey(clock.now());
  let eventsToday = 0;
  let bytesToday = 0;
  let framesToday = 0;
  let capReached = false;
  let lastFrameAt: UnixMs | null = null;
  let parseFailures = 0;
  let bufferLimitEvents = 0;
  let unknownEvents = 0;
  let reconnects = 0;
  const mapStats = createMapStats();

  const pending = new Map<string, Listing | typeof DELETE>();
  const names = new Map<string, BptfNameRow>();

  const setState = (s: ConnState, detail: string): void => {
    state = s;
    detailText = detail;
  };

  const noteError = (msg: string): void => {
    lastErrorAt = clock.now();
    lastError = scrubText(msg).slice(0, 300);
  };

  // ----- gate -----

  const capBytes = (): number => {
    const cap = deps.settings().liveFeed.dailyCapBytes;
    return typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : Number.POSITIVE_INFINITY;
  };

  /** Why the feed may not run right now, or null when it may. */
  const gateReason = (): { state: ConnState; detail: string } | null => {
    rolloverIfNewDay(clock.now());
    const s = deps.settings();
    if (!s.liveFeed.enabled) return { state: 'off', detail: 'Live feed is turned off in Settings' };
    if (s.networkPaused || deps.http.isPaused()) return { state: 'paused', detail: 'Network is paused' };
    // Compared live (not latched) so raising or clearing the cap resumes the feed at once.
    if (bytesToday >= capBytes()) {
      return {
        state: 'paused',
        detail: `Daily data cap reached (${formatBytes(bytesToday)} of ${formatBytes(capBytes())}); resumes at local midnight`,
      };
    }
    return null;
  };

  // ----- batching -----

  const flush = (): void => {
    if (pending.size === 0 && names.size === 0) return;
    const batch: FeedBatch = { upserts: [], deletes: [], names: [...names.values()] };
    for (const [id, v] of pending) {
      if (v === DELETE) batch.deletes.push(id);
      else batch.upserts.push(v);
    }
    pending.clear();
    names.clear();
    try {
      deps.onBatch(batch);
    } catch (err) {
      log.error(`bp.tf feed: onBatch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // ----- connection -----

  const clearReconnect = (): void => {
    if (reconnectTimer !== null) {
      timers.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  /** Sockets still in their closing handshake; no new connection until they are gone. */
  let closing = 0;

  const releaseGuard = (): void => {
    if (ws === null && closing === 0 && liveOwner === owner) liveOwner = null;
  };

  const closeSocket = (hard: boolean, reason: string): void => {
    const s = ws;
    if (!s) return;
    ws = null;
    openedAt = null;
    if (hard) {
      try {
        s.terminate();
      } catch {
        // already closed
      }
      releaseGuard();
      return;
    }
    closing++;
    let done = false;
    let killTimer: unknown = null;
    const finish = (): void => {
      if (done) return;
      done = true;
      closing--;
      if (killTimer !== null) timers.clearTimeout(killTimer);
      releaseGuard();
    };
    s.on('close', finish);
    try {
      s.close(1000, reason);
    } catch {
      finish();
    }
    if (!done) {
      killTimer = timers.setTimeout(() => {
        try {
          s.terminate();
        } catch {
          // already gone
        }
        finish();
      }, CLOSE_GRACE_MS);
    }
  };

  /** `delayMs` overrides the 1 s -> 60 s schedule (used after a refused upgrade). */
  const scheduleReconnect = (why: string, delayMs?: number): void => {
    if (!started || blocked || reconnectTimer !== null) return;
    const delay = delayMs ?? Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** Math.min(attempts, 16));
    attempts++;
    reconnects++;
    setState('backoff', `${why}; reconnecting in ${formatDelay(delay)}`);
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const block = (reason: string): void => {
    blocked = true;
    feedTurnedOff = false;
    disabledReason = reason;
    noteError(reason);
    clearReconnect();
    closeSocket(true, 'blocked');
    setState('blocked', reason);
    log.warn(`bp.tf feed stopped: ${reason}`);
  };

  /** The server answered the upgrade with something other than 101 (R7, §2.0 Errors). */
  const onRejected = (socket: WebSocketLike, r: HandshakeRejection): void => {
    if (socket !== ws) return;
    const now = clock.now();
    const status = typeof r?.status === 'number' && Number.isFinite(r.status) ? r.status : 0;
    const challenged = /challenge/i.test(String(r?.cfMitigated ?? ''));
    const html = /html/i.test(String(r?.contentType ?? ''));
    if (challenged || status === 401 || status === 403 || (status === 503 && html)) {
      // Never retried automatically: stays off until the user turns the live feed off and on.
      const what = challenged ? ', Cloudflare challenge' : html ? ', HTML page' : '';
      block(
        `backpack.tf refused the live feed connection (HTTP ${status}${what}). ` +
          'Check backpack.tf in a browser, then turn the live feed off and on again in Settings.',
      );
      return;
    }
    rejections++;
    if (status === 429) consecutive429++;
    const hinted = status === 429 || status === 503 ? parseRetryAfter(r?.retryAfter ?? null, now) : null;
    let delay = Math.max(REJECTED_MIN_DELAY_MS, hinted ?? backoffMs(rejections));
    if (consecutive429 >= CONSECUTIVE_429_LIMIT) delay = Math.max(delay, LONG_PAUSE_MS);
    const why = `backpack.tf refused the live feed connection (HTTP ${status})`;
    noteError(why);
    log.warn(`bp.tf feed: ${why}; next attempt in ${formatDelay(delay)}`);
    retryNotBefore = now + delay;
    retryWhy = why;
    closeSocket(true, 'rejected');
    scheduleReconnect(why, delay);
  };

  const handleClientLimit = (): void => {
    block(
      'backpack.tf reported too many connections from this IP (client-limit-exceeeded). ' +
        'Another app on this network is probably connected already; the feed stays off until you turn it off and on again.',
    );
  };

  const handleEvent = (ev: unknown, now: UnixMs): void => {
    const env = envelopeSchema.safeParse(ev);
    if (!env.success) {
      parseFailures++;
      return;
    }
    const name = env.data.event.trim().toLowerCase();
    switch (name) {
      case 'listing-update': {
        eventsToday++;
        const r = mapWsPayload(env.data.payload, schema, now, mapStats);
        if (r.ok) {
          pending.set(r.listing.id, r.listing);
          if (r.name.name.trim() !== '') names.set(r.name.sku, r.name);
        } else if (r.reason === 'invalid') {
          parseFailures++;
        }
        return;
      }
      case 'listing-delete': {
        eventsToday++;
        const d = deletePayloadSchema.safeParse(env.data.payload);
        if (!d.success) {
          parseFailures++;
          return;
        }
        const appid = d.data.appid;
        if (appid !== undefined && Number(appid) !== 440) return;
        pending.set(d.data.id, DELETE);
        return;
      }
      case 'buffer-limit-exceeded':
        bufferLimitEvents++;
        log.warn('bp.tf feed: buffer-limit-exceeded; some events were dropped by the server');
        return;
      case 'client-limit-exceeeded':
      case 'client-limit-exceeded':
        handleClientLimit();
        return;
      default:
        unknownEvents++;
    }
  };

  const onMessage = (socket: WebSocketLike, data: unknown): void => {
    if (socket !== ws) return;
    const now = clock.now();
    lastActivityAt = now;
    lastFrameAt = now;
    lastOkAt = now;
    rolloverIfNewDay(now);
    framesToday++;
    const frame = frameText(data);
    if (!frame) {
      parseFailures++;
      return;
    }
    bytesToday += frame.bytes;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.text);
    } catch {
      parseFailures++;
      parsed = undefined;
    }
    if (parsed !== undefined) {
      const events = Array.isArray(parsed) ? parsed : [parsed];
      for (const ev of events) {
        handleEvent(ev, now);
        if (blocked) return;
      }
      if (state !== 'live') setState('live', 'Receiving events');
    }
    if (bytesToday >= capBytes()) {
      capReached = true;
      flush();
      closeSocket(true, 'daily cap');
      const g = gateReason();
      setState('paused', g ? g.detail : 'Daily data cap reached');
      log.warn(`bp.tf feed paused: daily data cap of ${formatBytes(capBytes())} reached`);
    }
  };

  const onClose = (socket: WebSocketLike, code: number): void => {
    if (socket !== ws) return;
    const stableFor = openedAt !== null ? clock.now() - openedAt : 0;
    ws = null;
    openedAt = null;
    releaseGuard();
    if (stableFor >= STABLE_CONNECTION_MS) attempts = 0;
    if (!started || blocked) return;
    const g = gateReason();
    if (g) {
      setState(g.state, g.detail);
      return;
    }
    scheduleReconnect(`Connection closed (code ${code})`);
  };

  function connect(): void {
    if (!started || blocked || ws !== null) return;
    const g = gateReason();
    if (g) {
      setState(g.state, g.detail);
      return;
    }
    // A pause / resume or stop() + start() clears the reconnect timer; the server's wait still holds.
    const waitMs = retryNotBefore - clock.now();
    if (waitMs > 0) {
      setState('backoff', `${retryWhy}; reconnecting in ${formatDelay(waitMs)}`);
      return;
    }
    if (closing > 0) {
      setState('connecting', 'Waiting for the previous connection to close');
      return;
    }
    if (liveOwner !== null && liveOwner !== owner) {
      noteError('Another backpack.tf feed connection is already open in this process');
      setState('error', 'Another backpack.tf feed connection is already open in this process');
      return;
    }
    try {
      assertAllowed(BPTF_WS_URL, 'ws');
    } catch (err) {
      block(`Network policy refused the feed URL: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    let ua: string;
    try {
      ua = deps.http.userAgent();
    } catch (err) {
      noteError(err instanceof Error ? err.message : String(err));
      setState('error', 'No valid User-Agent; set a contact URL in Settings');
      return;
    }

    let socket: WebSocketLike;
    try {
      socket = factory(BPTF_WS_URL, { 'User-Agent': ua });
    } catch (err) {
      noteError(err instanceof Error ? err.message : String(err));
      scheduleReconnect('Could not open the connection');
      return;
    }
    ws = socket;
    liveOwner = owner;
    lastActivityAt = clock.now();
    setState('connecting', 'Connecting to wss://ws.backpack.tf/events');

    socket.on('open', () => {
      if (socket !== ws) return;
      openedAt = clock.now();
      lastActivityAt = openedAt;
      rejections = 0;
      consecutive429 = 0;
      setState('live', 'Connected; waiting for events');
      log.info('bp.tf feed connected');
    });
    socket.on('handshake-rejected', (r: HandshakeRejection) => onRejected(socket, r));
    socket.on('message', (data: unknown) => onMessage(socket, data));
    socket.on('ping', () => {
      if (socket === ws) lastActivityAt = clock.now();
    });
    socket.on('error', (err: Error) => {
      if (socket !== ws) return;
      noteError(err?.message ?? 'websocket error');
      log.warn(`bp.tf feed error: ${lastError ?? ''}`);
    });
    socket.on('close', (code: number) => onClose(socket, code));
  }

  // ----- periodic tick: flush, day rollover, gate, watchdog -----

  function rolloverIfNewDay(now: UnixMs): void {
    const key = localDayKey(now);
    if (key === dayKey) return;
    dayKey = key;
    eventsToday = 0;
    bytesToday = 0;
    framesToday = 0;
    if (capReached) {
      capReached = false;
      log.info('bp.tf feed: new day, data cap reset');
    }
  }

  const onTick = (): void => {
    const now = clock.now();
    rolloverIfNewDay(now);
    if (capReached && bytesToday < capBytes()) {
      capReached = false;
      log.info('bp.tf feed: daily data cap raised or removed; resuming');
    }
    flush();
    if (!started || blocked) return;
    const g = gateReason();
    if (g) {
      if (ws) {
        flush();
        closeSocket(false, 'paused');
      }
      clearReconnect();
      setState(g.state, g.detail);
      return;
    }
    if (ws) {
      if (lastActivityAt !== null && now - lastActivityAt >= SILENCE_TIMEOUT_MS) {
        noteError(`No frames for ${Math.round(SILENCE_TIMEOUT_MS / 1000)} s`);
        log.warn('bp.tf feed silent for 120 s; reconnecting');
        closeSocket(true, 'silence');
        scheduleReconnect('No data for 120 s');
      }
      return;
    }
    if (reconnectTimer === null) connect();
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      if (blocked && feedTurnedOff) {
        blocked = false;
        disabledReason = null;
        log.info('bp.tf feed re-enabled by the user');
      }
      feedTurnedOff = false;
      attempts = 0;
      tick = timers.setInterval(onTick, FLUSH_INTERVAL_MS);
      if (blocked) {
        setState('blocked', disabledReason ?? 'Blocked');
        return;
      }
      connect();
    },

    stop(): void {
      // core stops the feed both for a network pause and for the Settings toggle;
      // only the toggle may clear a block on the next start().
      if (!deps.settings().liveFeed.enabled) feedTurnedOff = true;
      if (!started) return;
      started = false;
      clearReconnect();
      if (tick !== null) {
        timers.clearInterval(tick);
        tick = null;
      }
      flush();
      closeSocket(false, 'stopped');
      if (!blocked) setState('off', 'Stopped');
    },

    health(): ConnectorHealth {
      let s = state;
      let d = detailText;
      if (!started && !blocked) {
        s = 'off';
        d = detailText === 'Not started' ? d : 'Stopped';
      } else if (s === 'live') {
        d = `${eventsToday.toLocaleString('en-US')} events today, ${formatBytes(bytesToday)}`;
      }
      return {
        id: 'bptf-ws',
        label: 'backpack.tf live feed',
        state: s,
        detail: d,
        lastOkAt,
        lastErrorAt,
        lastError,
        disabledReason,
      };
    },

    stats() {
      rolloverIfNewDay(clock.now());
      return { eventsToday, bytesToday, lastFrameAt, parseFailures };
    },

    detail(): BptfSocketDetail {
      return { framesToday, bufferLimitEvents, unknownEvents, reconnects, mapStats: { ...mapStats, unknownShapes: { ...mapStats.unknownShapes } } };
    },
  };
}
