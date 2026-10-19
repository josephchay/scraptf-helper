// Runs the background service (dist/service.cjs) in an Electron utilityProcess
// and speaks the ToService/FromService protocol from src/shared/rpc.ts:
// init on spawn, RPC correlation with timeouts, calls queued until 'ready',
// push fan-out, log piping, restart with exponential backoff (at least 15 min
// apart once it crash-loops) and a graceful shutdown. Also hosts the
// size-capped main log. Electron is injected through `fork`, so this module is
// tested with a fake process.

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Logger } from '../service/contracts';
import { PUSH_EVENTS, type PushContract, type PushEvent, type RpcMethod, type RpcParams, type RpcResult, type ToService } from '../shared/rpc';
import type { AppStatus } from '../shared/types';
import { restartDelayMs, safeErrorMessage } from './paths';

// ---------------------------------------------------------------------------
// Main log
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface MainLog extends Logger {
  write(level: LogLevel, msg: string, meta?: unknown): void;
  /** Values (secrets) replaced with [redacted] in every later line. */
  setRedactions(values: readonly string[]): void;
  flushSync(): void;
  readonly file: string;
}

export interface MainLogOptions {
  file: string;
  /** Rotates to `<file>.1` past this size (default 5 MB). */
  maxBytes?: number;
  minLevel?: LogLevel;
  /** Also print to the console (development). */
  echo?: boolean;
  flushDelayMs?: number;
  now?: () => Date;
}

function formatMeta(meta: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) return ` ${meta.stack ?? meta.message}`;
  try {
    const json = JSON.stringify(meta, (_k, v: unknown) =>
      v instanceof Error ? { name: v.name, message: v.message } : typeof v === 'bigint' ? String(v) : v,
    );
    if (json === undefined) return '';
    return ` ${json.length > 2000 ? `${json.slice(0, 2000)}...` : json}`;
  } catch {
    return ' [unserialisable meta]';
  }
}

export function createMainLog(opts: MainLogOptions): MainLog {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const minLevel = LEVEL_ORDER[opts.minLevel ?? 'info'];
  const flushDelay = opts.flushDelayMs ?? 250;
  const now = opts.now ?? (() => new Date());
  let redactions: string[] = [];
  let buffer: string[] = [];
  let size: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  /** After 20 failed writes in a row, the next write is tried only after this time (not never again). */
  let retryAt = 0;

  const redact = (s: string): string => {
    let out = s;
    for (const v of redactions) if (out.includes(v)) out = out.split(v).join('[redacted]');
    return out;
  };

  function flushSync(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const chunk = buffer.join('');
    buffer = [];
    const t = now().getTime();
    if (failures > 20 && t < retryAt) return;
    try {
      if (size === null) {
        mkdirSync(path.dirname(opts.file), { recursive: true });
        try {
          size = statSync(opts.file).size;
        } catch {
          size = 0;
        }
      }
      const bytes = Buffer.byteLength(chunk);
      if (size > 0 && size + bytes > maxBytes) {
        try {
          rmSync(`${opts.file}.1`, { force: true });
          renameSync(opts.file, `${opts.file}.1`);
        } catch {
          // Keep appending to the current file if rotation is blocked.
        }
        size = 0;
      }
      appendFileSync(opts.file, chunk);
      size += bytes;
      failures = 0;
    } catch (err) {
      failures++;
      size = null;
      if (failures > 20) retryAt = t + 60_000;
      if (opts.echo) console.error('main log write failed', err);
    }
  }

  function write(level: LogLevel, msg: string, meta?: unknown): void {
    if (LEVEL_ORDER[level] < minLevel) return;
    const line = redact(`${now().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${formatMeta(meta)}`).replace(
      /\r?\n/g,
      '\n    ',
    );
    if (opts.echo) (level === 'error' || level === 'warn' ? console.error : console.log)(line);
    buffer.push(`${line}\n`);
    if (!timer) {
      timer = setTimeout(flushSync, flushDelay);
      (timer as { unref?: () => void }).unref?.();
    }
  }

  return {
    file: opts.file,
    write,
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
    setRedactions(values) {
      // Longest first so overlapping secrets are fully covered; very short values would garble the log.
      redactions = [...new Set(values)].filter((v) => v.length >= 6).sort((a, b) => b.length - a.length);
    },
    flushSync,
  };
}

// ---------------------------------------------------------------------------
// Service host
// ---------------------------------------------------------------------------

/** The subset of Electron's UtilityProcess that the host uses. */
export interface ServiceProcessLike {
  on(event: 'spawn', listener: () => void): unknown;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  on(event: 'error', listener: (type: string, report: string) => void): unknown;
  postMessage(message: unknown): void;
  kill(): boolean;
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
}

export type ServiceState = 'idle' | 'starting' | 'ready' | 'restarting' | 'stopping' | 'stopped';

export interface ServiceHostStatus {
  state: ServiceState;
  pid: number | null;
  /** Unexpected exits so far. */
  restarts: number;
  lastExitCode: number | null;
  nextRestartAt: number | null;
  lastError: string | null;
  readyAt: number | null;
}

export type ServiceInit = Omit<Extract<ToService, { type: 'init' }>, 'type'>;

export interface ServiceHostOptions {
  fork(): ServiceProcessLike;
  /** Called on every (re)spawn so a restarted service gets current settings and secrets. */
  init(): ServiceInit;
  log: Logger;
  rpcTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** A service that stayed ready this long resets the backoff. */
  stableAfterMs?: number;
  /**
   * Unexpected exits within an hour that count as a crash loop (default 5).
   * From then on every restart waits at least `crashLoopBackoffMs`, so a
   * service that keeps dying cannot hammer the APIs it calls at start-up (R7).
   */
  crashLoopRestarts?: number;
  /** Minimum restart delay during a crash loop (default 15 min). */
  crashLoopBackoffMs?: number;
  now?: () => number;
}

export interface ServiceHost {
  start(): void;
  call<M extends RpcMethod>(method: M, params: RpcParams<M>, opts?: { timeoutMs?: number }): Promise<RpcResult<M>>;
  callRaw(method: RpcMethod, params: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
  sendSettings(settings: ServiceInit['settings']): void;
  /** Secrets travel only over this channel, never to renderers. */
  sendSecrets(secrets: ServiceInit['secrets']): void;
  onPush(listener: (event: PushEvent, payload: unknown) => void): () => void;
  onState(listener: (status: ServiceHostStatus) => void): () => void;
  status(): ServiceHostStatus;
  /** Resolves true once ready, false after `timeoutMs`. */
  whenReady(timeoutMs: number): Promise<boolean>;
  /** Sends 'shutdown', waits `graceMs`, then kills. Pending calls are rejected. */
  shutdown(graceMs?: number): Promise<void>;
}

/** Pushes only main sends (ARCHITECTURE: settings, the dashboard drawer, quick entry, the check popup, the service banner). */
export const MAIN_ONLY_PUSH_EVENTS: readonly PushEvent[] = [
  'settings.changed',
  'ui.openItem',
  'ui.quickPrefill',
  'ui.checkShow',
  'service.state',
  // F21: the scrap.tf window's toolbar hears these from main's window manager only.
  'scraptfWindow.read',
  'scraptfWindow.nav',
];
/** Pushes the service may send; anything else from the service is dropped as unrecognised. */
export const SERVICE_PUSH_EVENTS: readonly PushEvent[] = PUSH_EVENTS.filter((e) => !MAIN_ONLY_PUSH_EVENTS.includes(e));
const pushEvents = new Set<string>(SERVICE_PUSH_EVENTS);

const appStatusSchema = z.looseObject({
  version: z.string(),
  networkPaused: z.boolean(),
  feed: z.string(),
  counts: z.looseObject({ opportunities: z.number(), profitable: z.number(), highConfidence: z.number() }),
  setupNeeded: z.array(z.string()),
});

/** Shape check for a status from the service (push or status.get) before it reaches the tray or a renderer. */
export function isAppStatus(value: unknown): value is AppStatus {
  return appStatusSchema.safeParse(value).success;
}

// Inherited variables that would route the service's fetch() through a proxy
// (Node's NODE_USE_ENV_PROXY / --use-env-proxy) or swap its TLS trust. R5: no
// proxies; the websockets connect directly, so a proxied fetch would also mix IPs.
const STRIPPED_ENV_VARS = /^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy|node_options|node_extra_ca_certs)$/i;

/** The environment for the service process: main's, minus anything that enables a proxy. */
export function serviceEnv(src: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) if (v !== undefined && !STRIPPED_ENV_VARS.test(k)) out[k] = v;
  return out;
}

/**
 * The 'service.state' push for the dashboard banner; null for internal states ('idle', 'stopping').
 * The next attempt goes out as a time, not as "in N s": the push is sent once per state change,
 * so a relative countdown would stay frozen (up to 15 min in the crash-loop delay).
 */
export function serviceStatePush(s: ServiceHostStatus, now: number): PushContract['service.state'] | null {
  const err = s.lastError ? clip(s.lastError, 160) : null;
  switch (s.state) {
    case 'starting':
    case 'ready':
      return { state: s.state, detail: null, nextAttemptAt: null };
    case 'restarting':
      return { state: 'restarting', detail: err, nextAttemptAt: s.nextRestartAt !== null && s.nextRestartAt > now ? s.nextRestartAt : null };
    case 'stopped':
      return { state: 'stopped', detail: err, nextAttemptAt: null };
    default:
      return null;
  }
}

const fromServiceSchema = z.union([
  z.looseObject({ type: z.literal('ready') }),
  z.looseObject({ type: z.literal('rpc-result'), id: z.number().int(), ok: z.literal(true), result: z.unknown() }),
  z.looseObject({ type: z.literal('rpc-result'), id: z.number().int(), ok: z.literal(false), error: z.unknown() }),
  z.looseObject({
    type: z.literal('push'),
    event: z.string().refine((e) => pushEvents.has(e)),
    payload: z.unknown(),
  }),
  z.looseObject({
    type: z.literal('log'),
    level: z.enum(['debug', 'info', 'warn', 'error']).catch('info'),
    msg: z.unknown(),
  }),
]);

interface PendingCall {
  id: number;
  method: RpcMethod;
  params: unknown;
  sent: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(err: Error): void;
}

function clip(s: string, max = 4000): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

export function createServiceHost(opts: ServiceHostOptions): ServiceHost {
  const log = opts.log;
  const now = opts.now ?? Date.now;
  const rpcTimeoutMs = opts.rpcTimeoutMs ?? 30_000;
  const minBackoff = opts.minBackoffMs ?? 1000;
  const maxBackoff = opts.maxBackoffMs ?? 60_000;
  const stableAfter = opts.stableAfterMs ?? 60_000;
  const crashLoopRestarts = opts.crashLoopRestarts ?? 5;
  const crashLoopBackoff = opts.crashLoopBackoffMs ?? 15 * 60_000;
  /** Times of unexpected exits in the last hour. */
  let recentExits: number[] = [];

  let child: ServiceProcessLike | null = null;
  let state: ServiceState = 'idle';
  let initSent = false;
  let ready = false;
  let readyAt: number | null = null;
  let failures = 0;
  let restarts = 0;
  let lastExitCode: number | null = null;
  let lastError: string | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let nextRestartAt: number | null = null;
  let stopping = false;
  let shutdownPromise: Promise<void> | null = null;
  let exitWaiters: (() => void)[] = [];
  let nextId = 1;

  const pending = new Map<number, PendingCall>();
  const pushListeners = new Set<(event: PushEvent, payload: unknown) => void>();
  const stateListeners = new Set<(s: ServiceHostStatus) => void>();
  const readyWaiters = new Set<() => void>();

  function status(): ServiceHostStatus {
    return { state, pid: child?.pid ?? null, restarts, lastExitCode, nextRestartAt, lastError, readyAt };
  }

  function setState(next: ServiceState): void {
    state = next;
    const s = status();
    for (const fn of stateListeners) {
      try {
        fn(s);
      } catch (err) {
        log.error('service state listener failed', err);
      }
    }
  }

  function post(proc: ServiceProcessLike, msg: ToService): boolean {
    try {
      proc.postMessage(msg);
      return true;
    } catch (err) {
      log.warn(`could not post '${msg.type}' to the service`, { error: safeErrorMessage(err) });
      return false;
    }
  }

  function sendRpc(p: PendingCall): void {
    if (!child) return;
    try {
      child.postMessage({ type: 'rpc', id: p.id, method: p.method, params: p.params } satisfies ToService);
      p.sent = true;
    } catch (err) {
      pending.delete(p.id);
      clearTimeout(p.timer);
      p.reject(new Error(`Could not send ${p.method} to the service: ${safeErrorMessage(err)}`));
    }
  }

  function flushQueue(): void {
    for (const p of [...pending.values()]) if (!p.sent) sendRpc(p);
  }

  function pipeStream(stream: NodeJS.ReadableStream | null, name: 'stdout' | 'stderr'): void {
    if (!stream) return;
    let partial = '';
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk: unknown) => {
      partial += String(chunk);
      const lines = partial.split(/\r?\n/);
      partial = lines.pop() ?? '';
      if (partial.length > 16_384) {
        lines.push(partial);
        partial = '';
      }
      for (const line of lines) {
        if (line.trim() === '') continue;
        const text = `[service:${name}] ${clip(line)}`;
        if (name === 'stderr') log.warn(text);
        else log.info(text);
      }
    });
    stream.on('error', () => {
      // The pipe closes with the process; exit handling covers it.
    });
  }

  function handleMessage(raw: unknown): void {
    const parsed = fromServiceSchema.safeParse(raw);
    if (!parsed.success) {
      const type = typeof raw === 'object' && raw !== null ? String((raw as { type?: unknown }).type) : typeof raw;
      log.warn('service sent an unrecognised message', { type: clip(type, 100) });
      return;
    }
    const m = parsed.data;
    switch (m.type) {
      case 'ready': {
        ready = true;
        readyAt = now();
        lastError = null;
        log.info('service ready');
        setState('ready');
        flushQueue();
        for (const w of [...readyWaiters]) w();
        return;
      }
      case 'rpc-result': {
        const p = pending.get(m.id);
        if (!p) {
          log.debug(`late or unknown rpc result ${m.id}`);
          return;
        }
        pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.result);
        else p.reject(new Error(typeof m.error === 'string' && m.error !== '' ? clip(m.error, 1000) : `${p.method} failed`));
        return;
      }
      case 'push': {
        for (const fn of pushListeners) {
          try {
            fn(m.event as PushEvent, m.payload);
          } catch (err) {
            log.error(`push listener for ${m.event} failed`, err);
          }
        }
        return;
      }
      case 'log': {
        const msg = typeof m.msg === 'string' ? m.msg : formatMeta(m.msg).trim();
        log[m.level](`[service] ${clip(msg)}`);
        return;
      }
    }
  }

  function scheduleRestart(): void {
    const t = now();
    const stable = readyAt !== null && t - readyAt >= stableAfter;
    failures = stable ? 1 : failures + 1;
    readyAt = null;
    restarts++;
    recentExits = [...recentExits.filter((x) => t - x < 3_600_000), t];
    let delay = restartDelayMs(failures, minBackoff, maxBackoff);
    // Every start runs the start-up jobs again; a process that keeps dying after a
    // minute would otherwise restart every few seconds, forever.
    const crashLoop = recentExits.length >= crashLoopRestarts;
    if (crashLoop) delay = Math.max(delay, crashLoopBackoff);
    nextRestartAt = t + delay;
    log.warn(
      `service stopped unexpectedly (exit code ${lastExitCode ?? 'n/a'}); restarting in ${Math.round(delay / 1000)} s` +
        (crashLoop ? ` (${recentExits.length} unexpected exits in the last hour)` : ''),
    );
    setState('restarting');
    restartTimer = setTimeout(spawn, delay);
  }

  function onExit(proc: ServiceProcessLike | null, code: number): void {
    if (proc !== null && proc !== child) return;
    child = null;
    ready = false;
    initSent = false;
    lastExitCode = code;
    for (const p of [...pending.values()]) {
      if (!p.sent) continue;
      pending.delete(p.id);
      clearTimeout(p.timer);
      p.reject(new Error(`The service stopped while handling ${p.method}`));
    }
    const waiters = exitWaiters;
    exitWaiters = [];
    for (const w of waiters) w();
    if (stopping) {
      readyAt = null;
      setState('stopped');
      return;
    }
    scheduleRestart();
  }

  function spawn(): void {
    restartTimer = null;
    nextRestartAt = null;
    initSent = false;
    ready = false;
    setState('starting');
    let proc: ServiceProcessLike;
    try {
      proc = opts.fork();
    } catch (err) {
      lastError = safeErrorMessage(err);
      log.error('could not start the service process', err);
      onExit(null, -1);
      return;
    }
    child = proc;
    proc.on('spawn', () => {
      if (child !== proc) return;
      let init: ServiceInit;
      try {
        init = opts.init();
      } catch (err) {
        lastError = safeErrorMessage(err);
        log.error('could not build the service init message', err);
        proc.kill();
        return;
      }
      initSent = post(proc, { type: 'init', ...init });
      log.info(`service process started (pid ${proc.pid ?? '?'})`);
    });
    proc.on('message', (msg: unknown) => {
      if (child === proc) handleMessage(msg);
    });
    proc.on('exit', (code: number) => onExit(proc, code));
    proc.on('error', (type: string, report: string) => {
      lastError = `fatal error: ${type}`;
      log.error(`service process error: ${type}`, { report: clip(String(report)) });
    });
    pipeStream(proc.stdout, 'stdout');
    pipeStream(proc.stderr, 'stderr');
  }

  function callRaw(method: RpcMethod, params: unknown, callOpts?: { timeoutMs?: number }): Promise<unknown> {
    if (stopping) return Promise.reject(new Error('The service is shutting down'));
    const timeoutMs = callOpts?.timeoutMs ?? rpcTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            ready
              ? `The service did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`
              : `The service is not ready (${state}); ${method} timed out`,
          ),
        );
      }, timeoutMs);
      const p: PendingCall = { id, method, params, sent: false, timer, resolve, reject };
      pending.set(id, p);
      if (ready && child) sendRpc(p);
    });
  }

  return {
    start() {
      if (stopping || child || restartTimer) return;
      spawn();
    },
    call<M extends RpcMethod>(method: M, params: RpcParams<M>, callOpts?: { timeoutMs?: number }) {
      return callRaw(method, params, callOpts) as Promise<RpcResult<M>>;
    },
    callRaw,
    sendSettings(settings) {
      if (child && initSent) post(child, { type: 'settings', settings });
    },
    sendSecrets(secrets) {
      if (child && initSent) post(child, { type: 'secrets', secrets });
    },
    onPush(listener) {
      pushListeners.add(listener);
      return () => pushListeners.delete(listener);
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    status,
    whenReady(timeoutMs) {
      if (ready) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const waiter = () => {
          readyWaiters.delete(waiter);
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          readyWaiters.delete(waiter);
          resolve(false);
        }, timeoutMs);
        readyWaiters.add(waiter);
      });
    },
    shutdown(graceMs = 2000) {
      if (shutdownPromise) return shutdownPromise;
      stopping = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      nextRestartAt = null;
      for (const p of [...pending.values()]) {
        clearTimeout(p.timer);
        p.reject(new Error('The service is shutting down'));
      }
      pending.clear();
      const proc = child;
      if (!proc) {
        setState('stopped');
        shutdownPromise = Promise.resolve();
        return shutdownPromise;
      }
      setState('stopping');
      shutdownPromise = new Promise<void>((resolve) => {
        let killTimer: ReturnType<typeof setTimeout> | null = null;
        let finalTimer: ReturnType<typeof setTimeout> | null = null;
        const finish = () => {
          if (killTimer) clearTimeout(killTimer);
          if (finalTimer) clearTimeout(finalTimer);
          resolve();
        };
        exitWaiters.push(finish);
        post(proc, { type: 'shutdown' });
        killTimer = setTimeout(() => {
          log.warn(`service did not exit within ${graceMs} ms; killing it`);
          try {
            proc.kill();
          } catch {
            // already gone
          }
          // Do not hang the quit if the exit event never arrives.
          finalTimer = setTimeout(() => {
            exitWaiters = exitWaiters.filter((w) => w !== finish);
            if (child === proc) {
              child = null;
              setState('stopped');
            }
            resolve();
          }, 1000);
        }, graceMs);
      });
      return shutdownPromise;
    },
  };
}
