import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAIN_ONLY_PUSH_EVENTS,
  SERVICE_PUSH_EVENTS,
  createMainLog,
  createServiceHost,
  isAppStatus,
  serviceEnv,
  serviceStatePush,
  type ServiceHost,
  type ServiceHostStatus,
  type ServiceHostOptions,
  type ServiceProcessLike,
} from '../../src/main/serviceHost';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { PUSH_EVENTS, type ToService } from '../../src/shared/rpc';

class FakeProc extends EventEmitter implements ServiceProcessLike {
  sent: ToService[] = [];
  pid: number | undefined;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  dead = false;
  /** When false, 'shutdown' is ignored (simulates a hung service). */
  exitsOnShutdown = true;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  postMessage(message: unknown): void {
    if (this.dead) throw new Error('process is gone');
    const m = structuredClone(message) as ToService;
    this.sent.push(m);
    if (m.type === 'shutdown' && this.exitsOnShutdown) setTimeout(() => this.exit(0), 10);
  }
  kill(): boolean {
    this.killed = true;
    setTimeout(() => this.exit(1), 5);
    return true;
  }
  spawn(): void {
    this.emit('spawn');
  }
  reply(msg: unknown): void {
    this.emit('message', msg);
  }
  ready(): void {
    this.reply({ type: 'ready' });
  }
  exit(code: number): void {
    if (this.dead) return;
    this.dead = true;
    this.emit('exit', code);
  }
  rpcs() {
    return this.sent.filter((m): m is Extract<ToService, { type: 'rpc' }> => m.type === 'rpc');
  }
}

const quietLog = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

interface Harness {
  host: ServiceHost;
  procs: FakeProc[];
  log: ReturnType<typeof quietLog>;
  current(): FakeProc;
}

function setup(overrides: Partial<ServiceHostOptions> = {}): Harness {
  const procs: FakeProc[] = [];
  const log = quietLog();
  const host = createServiceHost({
    fork: () => {
      const p = new FakeProc(100 + procs.length);
      procs.push(p);
      return p;
    },
    init: () => ({ dataDir: '/data', version: '0.1.0', settings: DEFAULT_SETTINGS, secrets: { bptfApiKey: 'k' } }),
    log,
    now: () => Date.now(),
    ...overrides,
  });
  return { host, procs, log, current: () => procs[procs.length - 1]! };
}

async function startReady(h: Harness): Promise<FakeProc> {
  h.host.start();
  const p = h.current();
  p.spawn();
  p.ready();
  return p;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('service host: startup and RPC', () => {
  it('sends init with current settings and secrets on spawn', () => {
    const h = setup();
    h.host.start();
    expect(h.host.status().state).toBe('starting');
    const p = h.current();
    expect(p.sent).toEqual([]);
    p.spawn();
    expect(p.sent[0]).toEqual({
      type: 'init',
      dataDir: '/data',
      version: '0.1.0',
      settings: DEFAULT_SETTINGS,
      secrets: { bptfApiKey: 'k' },
    });
  });

  it('start() is idempotent', () => {
    const h = setup();
    h.host.start();
    h.host.start();
    expect(h.procs).toHaveLength(1);
  });

  it('queues calls until ready, then sends them in order and resolves by id', async () => {
    const h = setup();
    h.host.start();
    const p = h.current();
    p.spawn();
    const a = h.host.call('status.get', undefined);
    const b = h.host.callRaw('item.search', { q: 'key' });
    expect(p.rpcs()).toEqual([]);
    p.ready();
    expect(h.host.status().state).toBe('ready');
    const [ra, rb] = p.rpcs();
    expect(ra).toMatchObject({ method: 'status.get' });
    expect(rb).toMatchObject({ method: 'item.search', params: { q: 'key' } });
    p.reply({ type: 'rpc-result', id: rb!.id, ok: true, result: ['b'] });
    p.reply({ type: 'rpc-result', id: ra!.id, ok: true, result: { version: 'x' } });
    await expect(a).resolves.toEqual({ version: 'x' });
    await expect(b).resolves.toEqual(['b']);
  });

  it('sends immediately once ready and rejects error results with the service message', async () => {
    const h = setup();
    const p = await startReady(h);
    const call = h.host.callRaw('prices.delete', { id: 1 });
    const msg = p.rpcs()[0]!;
    p.reply({ type: 'rpc-result', id: msg.id, ok: false, error: 'No such price' });
    await expect(call).rejects.toThrow('No such price');
  });

  it('times out after 30 s with a message that says whether the service was ready', async () => {
    const h = setup();
    h.host.start();
    h.current().spawn();
    const early = h.host.callRaw('status.get', undefined);
    const earlyCheck = expect(early).rejects.toThrow(/not ready \(starting\)/);
    await vi.advanceTimersByTimeAsync(30_000);
    await earlyCheck;

    h.current().ready();
    const late = h.host.callRaw('status.get', undefined, { timeoutMs: 5000 });
    const lateCheck = expect(late).rejects.toThrow(/did not answer status\.get within 5 s/);
    await vi.advanceTimersByTimeAsync(5000);
    await lateCheck;
    // A late answer is ignored.
    h.current().reply({ type: 'rpc-result', id: h.current().rpcs()[0]!.id, ok: true, result: 1 });
    expect(h.log.debug).toHaveBeenCalledWith(expect.stringContaining('late or unknown'));
  });

  it('timed-out queued calls are never sent', async () => {
    const h = setup({ rpcTimeoutMs: 1000 });
    h.host.start();
    h.current().spawn();
    const c = h.host.callRaw('status.get', undefined);
    const check = expect(c).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1000);
    await check;
    h.current().ready();
    expect(h.current().rpcs()).toEqual([]);
  });

  it('rejects calls whose params cannot be cloned', async () => {
    const h = setup();
    await startReady(h);
    await expect(h.host.callRaw('item.search', { fn: () => 1 })).rejects.toThrow(/Could not send item\.search/);
  });

  it('whenReady resolves true on ready and false on timeout', async () => {
    const h = setup();
    h.host.start();
    const slow = h.host.whenReady(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(slow).resolves.toBe(false);
    const ok = h.host.whenReady(5000);
    h.current().spawn();
    h.current().ready();
    await expect(ok).resolves.toBe(true);
    await expect(h.host.whenReady(1)).resolves.toBe(true);
  });
});

describe('service host: messages from the service', () => {
  it('forwards known push events and drops unknown ones', async () => {
    const h = setup();
    const p = await startReady(h);
    const seen: unknown[] = [];
    const off = h.host.onPush((e, payload) => seen.push([e, payload]));
    p.reply({ type: 'push', event: 'opps.changed', payload: { appeared: 1 } });
    p.reply({ type: 'push', event: 'notify', payload: { title: 't', body: 'b', sku: null } });
    p.reply({ type: 'push', event: 'evil.event', payload: {} });
    p.reply({ type: 'push', event: '__proto__', payload: {} });
    off();
    p.reply({ type: 'push', event: 'opps.changed', payload: { appeared: 2 } });
    expect(seen).toEqual([
      ['opps.changed', { appeared: 1 }],
      ['notify', { title: 't', body: 'b', sku: null }],
    ]);
    expect(h.log.warn).toHaveBeenCalledWith('service sent an unrecognised message', { type: 'push' });
  });

  it('forwards the scrap.tf banks push (scraptf.banksChanged, F15)', async () => {
    const h = setup();
    const p = await startReady(h);
    const seen: unknown[] = [];
    h.host.onPush((e, payload) => seen.push([e, payload]));
    p.reply({ type: 'push', event: 'scraptf.banksChanged', payload: { at: 42 } });
    expect(seen).toEqual([['scraptf.banksChanged', { at: 42 }]]);
  });

  it('drops the pushes only main may send (settings.changed, ui.openItem, service.state)', async () => {
    const h = setup();
    const p = await startReady(h);
    const seen: unknown[] = [];
    h.host.onPush((e) => seen.push(e));
    p.reply({ type: 'push', event: 'service.state', payload: { state: 'stopped', detail: 'reinstall from https://evil.example' } });
    p.reply({ type: 'push', event: 'ui.openItem', payload: { sku: '5021;6' } });
    p.reply({ type: 'push', event: 'settings.changed', payload: {} });
    p.reply({ type: 'push', event: 'import.done', payload: { stored: 1 } });
    expect(seen).toEqual(['import.done']);
    expect(h.log.warn).toHaveBeenCalledTimes(3);
    expect(SERVICE_PUSH_EVENTS).toEqual(
      expect.arrayContaining(['opps.changed', 'market.changed', 'journal.changed', 'scraptf.listChanged', 'scraptf.banksChanged', 'status.changed', 'import.done', 'notify']),
    );
    for (const e of MAIN_ONLY_PUSH_EVENTS) expect(SERVICE_PUSH_EVENTS).not.toContain(e);
    expect(MAIN_ONLY_PUSH_EVENTS).toContain('ui.quickPrefill');
    expect([...SERVICE_PUSH_EVENTS, ...MAIN_ONLY_PUSH_EVENTS].sort()).toEqual([...PUSH_EVENTS].sort());
  });

  it('isolates failing push listeners', async () => {
    const h = setup();
    const p = await startReady(h);
    const good = vi.fn();
    h.host.onPush(() => {
      throw new Error('bad listener');
    });
    h.host.onPush(good);
    p.reply({ type: 'push', event: 'status.changed', payload: {} });
    expect(good).toHaveBeenCalled();
    expect(h.log.error).toHaveBeenCalled();
  });

  it('pipes log messages at their level and tolerates odd shapes', async () => {
    const h = setup();
    const p = await startReady(h);
    p.reply({ type: 'log', level: 'warn', msg: 'snapshot 429' });
    p.reply({ type: 'log', level: 'nonsense', msg: 'defaults to info' });
    p.reply({ type: 'log', level: 'error', msg: { code: 7 } });
    expect(h.log.warn).toHaveBeenCalledWith('[service] snapshot 429');
    expect(h.log.info).toHaveBeenCalledWith('[service] defaults to info');
    expect(h.log.error).toHaveBeenCalledWith('[service] {"code":7}');
  });

  it('warns on malformed messages without throwing', async () => {
    const h = setup();
    const p = await startReady(h);
    for (const m of [null, 'ready', 42, { type: 'rpc-result', id: 'x', ok: true }, { type: 'bogus' }, {}]) p.reply(m);
    expect(h.log.warn).toHaveBeenCalledTimes(6);
  });

  it('pipes stdout and stderr line by line', async () => {
    vi.useRealTimers();
    const h = setup();
    const p = await startReady(h);
    p.stdout.write('hello ');
    p.stdout.write('world\nsecond line\n');
    p.stderr.write('(node) warning\r\n');
    await new Promise((r) => setImmediate(r));
    expect(h.log.info).toHaveBeenCalledWith('[service:stdout] hello world');
    expect(h.log.info).toHaveBeenCalledWith('[service:stdout] second line');
    expect(h.log.warn).toHaveBeenCalledWith('[service:stderr] (node) warning');
  });
});

describe('service host: settings and secrets', () => {
  it('forwards settings and secrets only after init was sent', async () => {
    const h = setup();
    h.host.sendSettings(DEFAULT_SETTINGS);
    h.host.start();
    const p = h.current();
    h.host.sendSecrets({ bptfApiKey: 'early' });
    expect(p.sent).toEqual([]);
    p.spawn();
    h.host.sendSettings({ ...DEFAULT_SETTINGS, networkPaused: true });
    h.host.sendSecrets({ steamApiKey: 's' });
    expect(p.sent.map((m) => m.type)).toEqual(['init', 'settings', 'secrets']);
    expect(p.sent[2]).toEqual({ type: 'secrets', secrets: { steamApiKey: 's' } });
  });

  it('builds a fresh init message on every restart', async () => {
    let n = 0;
    const h = setup({
      init: () => ({ dataDir: '/d', version: 'v', settings: DEFAULT_SETTINGS, secrets: { bptfApiKey: `k${++n}` } }),
    });
    const p1 = await startReady(h);
    p1.exit(3);
    await vi.advanceTimersByTimeAsync(1000);
    h.current().spawn();
    expect(p1.sent[0]).toMatchObject({ secrets: { bptfApiKey: 'k1' } });
    expect(h.current().sent[0]).toMatchObject({ secrets: { bptfApiKey: 'k2' } });
  });
});

describe('service host: crashes and restarts', () => {
  it('rejects in-flight calls, keeps queued ones and restarts after 1 s', async () => {
    const h = setup();
    const p1 = await startReady(h);
    const inflight = h.host.callRaw('engine.runNow', undefined);
    const inflightCheck = expect(inflight).rejects.toThrow(/stopped while handling engine\.runNow/);
    p1.exit(9);
    await inflightCheck;
    expect(h.host.status()).toMatchObject({ state: 'restarting', lastExitCode: 9, restarts: 1 });
    expect(h.host.status().nextRestartAt).toBe(Date.now() + 1000);

    const queued = h.host.call('status.get', undefined);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.procs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.procs).toHaveLength(2);
    const p2 = h.current();
    p2.spawn();
    p2.ready();
    const msg = p2.rpcs()[0]!;
    expect(msg.method).toBe('status.get');
    p2.reply({ type: 'rpc-result', id: msg.id, ok: true, result: 'fine' });
    await expect(queued).resolves.toBe('fine');
  });

  it('backs off exponentially up to 60 s while the service keeps crashing', async () => {
    const h = setup({ crashLoopRestarts: 100 });
    h.host.start();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      h.current().spawn();
      h.current().exit(1);
      const st = h.host.status();
      delays.push(st.nextRestartAt! - Date.now());
      await vi.advanceTimersByTimeAsync(st.nextRestartAt! - Date.now());
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(h.host.status().restarts).toBe(8);
  });

  it('resets the backoff after the service was ready for a minute', async () => {
    const h = setup();
    h.host.start();
    for (let i = 0; i < 3; i++) {
      h.current().spawn();
      h.current().exit(1);
      await vi.advanceTimersByTimeAsync(h.host.status().nextRestartAt! - Date.now());
    }
    h.current().spawn();
    h.current().ready();
    await vi.advanceTimersByTimeAsync(60_000);
    h.current().exit(1);
    expect(h.host.status().nextRestartAt! - Date.now()).toBe(1000);
  });

  it('waits 15 min between restarts once the service crash-loops, even when each run looked stable', async () => {
    const h = setup();
    h.host.start();
    const delays: number[] = [];
    // Each run is ready for 90 s (past the 60 s "stable" mark), then dies: the reset alone would restart after 1 s forever.
    for (let i = 0; i < 7; i++) {
      h.current().spawn();
      h.current().ready();
      await vi.advanceTimersByTimeAsync(90_000);
      h.current().exit(1);
      const st = h.host.status();
      delays.push(st.nextRestartAt! - Date.now());
      await vi.advanceTimersByTimeAsync(st.nextRestartAt! - Date.now());
    }
    expect(delays).toEqual([1000, 1000, 1000, 1000, 900_000, 900_000, 900_000]);
    expect(h.log.warn).toHaveBeenCalledWith(expect.stringMatching(/restarting in 900 s \(5 unexpected exits in the last hour\)/));
    // The banner gets the restart time and counts down itself; a "900 s" text would stay frozen for 15 min.
    const restartAt = Date.now() + 900_000;
    expect(serviceStatePush({ ...h.host.status(), state: 'restarting', nextRestartAt: restartAt }, Date.now())?.nextAttemptAt).toBe(restartAt);
  });

  it('leaves the crash-loop delay once the exits are more than an hour apart', async () => {
    const h = setup();
    h.host.start();
    for (let i = 0; i < 5; i++) {
      h.current().spawn();
      h.current().ready();
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      h.current().exit(1);
      if (i < 4) await vi.advanceTimersByTimeAsync(h.host.status().nextRestartAt! - Date.now());
    }
    // Five exits 20 min apart: never more than 3 (plus this one) inside any hour.
    expect(h.host.status().nextRestartAt! - Date.now()).toBe(1000);
  });

  it('honours a custom crash-loop threshold and delay', async () => {
    const h = setup({ crashLoopRestarts: 2, crashLoopBackoffMs: 5 * 60_000 });
    h.host.start();
    h.current().spawn();
    h.current().exit(1);
    expect(h.host.status().nextRestartAt! - Date.now()).toBe(1000);
    await vi.advanceTimersByTimeAsync(1000);
    h.current().spawn();
    h.current().exit(1);
    expect(h.host.status().nextRestartAt! - Date.now()).toBe(5 * 60_000);
  });

  it('treats a throwing fork as a crash', async () => {
    let fail = true;
    const procs: FakeProc[] = [];
    const log = quietLog();
    const host = createServiceHost({
      fork: () => {
        if (fail) throw new Error('ENOENT dist/service.cjs');
        const p = new FakeProc(1);
        procs.push(p);
        return p;
      },
      init: () => ({ dataDir: '/d', version: 'v', settings: DEFAULT_SETTINGS, secrets: {} }),
      log,
      now: () => Date.now(),
    });
    host.start();
    expect(host.status()).toMatchObject({ state: 'restarting', lastError: 'ENOENT dist/service.cjs' });
    fail = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(procs).toHaveLength(1);
    expect(host.status().state).toBe('starting');
  });

  it('ignores events from a process it already replaced', async () => {
    const h = setup();
    const p1 = await startReady(h);
    p1.exit(1);
    await vi.advanceTimersByTimeAsync(1000);
    const p2 = h.current();
    p2.spawn();
    p1.emit('message', { type: 'ready' });
    expect(h.host.status().state).toBe('starting');
    p1.emit('exit', 5);
    expect(h.host.status().restarts).toBe(1);
  });

  it('reports state changes to listeners', async () => {
    const h = setup();
    const states: string[] = [];
    h.host.onState((s) => states.push(s.state));
    const p = await startReady(h);
    p.exit(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(states).toEqual(['starting', 'ready', 'restarting', 'starting']);
  });
});

describe('service host: shutdown', () => {
  it('sends shutdown, waits for the exit and does not restart', async () => {
    const h = setup();
    const p = await startReady(h);
    const done = h.host.shutdown(2000);
    expect(p.sent.at(-1)).toEqual({ type: 'shutdown' });
    await vi.advanceTimersByTimeAsync(10);
    await done;
    expect(p.killed).toBe(false);
    expect(h.host.status().state).toBe('stopped');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.procs).toHaveLength(1);
  });

  it('kills a service that ignores shutdown after the grace period', async () => {
    const h = setup();
    const p = await startReady(h);
    p.exitsOnShutdown = false;
    const done = h.host.shutdown(2000);
    await vi.advanceTimersByTimeAsync(1999);
    expect(p.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    await done;
    expect(p.killed).toBe(true);
    expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining('killing'));
  });

  it('does not hang when the exit event never arrives after kill', async () => {
    const h = setup();
    const p = await startReady(h);
    p.exitsOnShutdown = false;
    p.kill = () => true;
    const done = h.host.shutdown(500);
    await vi.advanceTimersByTimeAsync(1500);
    await expect(done).resolves.toBeUndefined();
    expect(h.host.status().state).toBe('stopped');
  });

  it('rejects pending and new calls and is idempotent', async () => {
    const h = setup();
    const p = await startReady(h);
    const pending = h.host.callRaw('engine.runNow', undefined);
    const pendingCheck = expect(pending).rejects.toThrow(/shutting down/);
    const a = h.host.shutdown();
    const b = h.host.shutdown();
    expect(a).toBe(b);
    await pendingCheck;
    await expect(h.host.callRaw('status.get', undefined)).rejects.toThrow(/shutting down/);
    await vi.advanceTimersByTimeAsync(10);
    await a;
    expect(p.sent.filter((m) => m.type === 'shutdown')).toHaveLength(1);
  });

  it('cancels a scheduled restart', async () => {
    const h = setup();
    const p = await startReady(h);
    p.exit(1);
    await h.host.shutdown();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.procs).toHaveLength(1);
    expect(h.host.status().state).toBe('stopped');
  });
});

describe('main log', () => {
  let dir: string;
  beforeEach(() => {
    vi.useRealTimers();
    dir = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-log-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fixedNow = () => new Date('2026-10-14T12:00:00.000Z');

  it('writes formatted lines, filters by level and creates the directory', () => {
    const file = path.join(dir, 'logs', 'main.log');
    const log = createMainLog({ file, minLevel: 'info', now: fixedNow });
    log.debug('hidden');
    log.info('hello', { a: 1 });
    log.error('bad', new Error('boom'));
    log.flushSync();
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('hidden');
    expect(text).toContain('2026-10-14T12:00:00.000Z INFO  hello {"a":1}\n');
    expect(text).toContain('ERROR bad Error: boom');
  });

  it('indents continuation lines so every entry starts with a timestamp', () => {
    const file = path.join(dir, 'main.log');
    const log = createMainLog({ file, now: fixedNow });
    log.warn('line one\nline two');
    log.flushSync();
    expect(readFileSync(file, 'utf8')).toBe('2026-10-14T12:00:00.000Z WARN  line one\n    line two\n');
  });

  it('redacts registered secrets in messages and meta', () => {
    const file = path.join(dir, 'main.log');
    const log = createMainLog({ file, now: fixedNow });
    log.setRedactions(['SUPERSECRETTOKEN123', 'abc', 'SUPERSECRET']);
    log.info('url ?key=SUPERSECRETTOKEN123&x=abc', { token: 'SUPERSECRETTOKEN123', other: 'SUPERSECRET' });
    log.flushSync();
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('SUPERSECRET');
    expect(text).toContain('?key=[redacted]&x=abc');
  });

  it('survives unserialisable meta', () => {
    const file = path.join(dir, 'main.log');
    const log = createMainLog({ file, now: fixedNow });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    log.info('cyclic', cyclic);
    log.info('big', { n: 10n });
    log.flushSync();
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('cyclic [unserialisable meta]');
    expect(text).toContain('big {"n":"10"}');
  });

  it('rotates to main.log.1 when the size cap is reached', () => {
    const file = path.join(dir, 'main.log');
    const log = createMainLog({ file, maxBytes: 2000, now: fixedNow });
    for (let i = 0; i < 60; i++) {
      log.info(`entry ${i} ${'x'.repeat(40)}`);
      log.flushSync();
    }
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(statSync(file).size).toBeLessThanOrEqual(2000);
    expect(statSync(`${file}.1`).size).toBeLessThanOrEqual(2000);
    expect(readFileSync(file, 'utf8')).toContain('entry 59');
  });

  it('flushes on a timer', async () => {
    const file = path.join(dir, 'main.log');
    const log = createMainLog({ file, flushDelayMs: 5, now: fixedNow });
    log.info('later');
    expect(existsSync(file)).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(readFileSync(file, 'utf8')).toContain('later');
  });

  it('tries again after a cooldown instead of giving up for good after 21 failed writes', () => {
    // A regular file where the logs folder should be makes every write fail.
    const blocker = path.join(dir, 'blocked');
    writeFileSync(blocker, 'not a folder');
    const file = path.join(blocker, 'main.log');
    let t = Date.parse('2026-10-14T12:00:00.000Z');
    const log = createMainLog({ file, now: () => new Date(t) });
    for (let i = 0; i < 25; i++) {
      log.info(`lost ${i}`);
      log.flushSync();
    }
    rmSync(blocker, { force: true });
    log.info('too soon');
    log.flushSync();
    expect(existsSync(file)).toBe(false); // still cooling down
    t += 61_000;
    log.info('back again');
    log.flushSync();
    expect(readFileSync(file, 'utf8')).toContain('back again');
  });
});

describe('serviceStatePush', () => {
  const base: ServiceHostStatus = { state: 'ready', pid: 1, restarts: 0, lastExitCode: null, nextRestartAt: null, lastError: null, readyAt: 1 };
  it('maps host states to the dashboard banner states', () => {
    expect(serviceStatePush({ ...base, state: 'starting' }, 0)).toEqual({ state: 'starting', detail: null, nextAttemptAt: null });
    expect(serviceStatePush(base, 0)).toEqual({ state: 'ready', detail: null, nextAttemptAt: null });
    expect(serviceStatePush({ ...base, state: 'restarting', nextRestartAt: 4_000, lastError: 'fatal error: crash' }, 1_000)).toEqual({
      state: 'restarting',
      detail: 'fatal error: crash',
      nextAttemptAt: 4_000,
    });
    expect(serviceStatePush({ ...base, state: 'restarting', nextRestartAt: 900_000 }, 1_000)).toEqual({ state: 'restarting', detail: null, nextAttemptAt: 900_000 });
    expect(serviceStatePush({ ...base, state: 'restarting', nextRestartAt: 500 }, 1_000)?.nextAttemptAt).toBeNull();
    expect(serviceStatePush({ ...base, state: 'stopped' }, 0)).toEqual({ state: 'stopped', detail: null, nextAttemptAt: null });
    expect(serviceStatePush({ ...base, state: 'idle' }, 0)).toBeNull();
    expect(serviceStatePush({ ...base, state: 'stopping' }, 0)).toBeNull();
  });

  it('lists every shared push event, including the main-only ones', async () => {
    const { PUSH_EVENTS } = await import('../../src/shared/rpc');
    expect(PUSH_EVENTS).toEqual(expect.arrayContaining(['ui.openItem', 'service.state', 'opps.changed', 'notify']));
  });
});

describe('isAppStatus', () => {
  const good = {
    version: '0.1.0',
    networkPaused: false,
    feed: 'live',
    keyPrice: null,
    counts: { opportunities: 3, profitable: 1, highConfidence: 0 },
    lastEngineRunAt: null,
    setupNeeded: [],
  };
  it('accepts a full status and rejects ones the dashboard would crash on', () => {
    expect(isAppStatus(good)).toBe(true);
    expect(isAppStatus({ feed: 'live' })).toBe(false);
    expect(isAppStatus({ ...good, counts: undefined })).toBe(false);
    expect(isAppStatus({ ...good, counts: { profitable: '1' } })).toBe(false);
    expect(isAppStatus(null)).toBe(false);
    expect(isAppStatus('status')).toBe(false);
  });
});

describe('serviceEnv', () => {
  it('drops every variable that would put a proxy (or other TLS trust) under fetch()', () => {
    const env = serviceEnv({
      HTTPS_PROXY: 'http://127.0.0.1:8080',
      https_proxy: 'http://127.0.0.1:8080',
      HTTP_PROXY: 'http://127.0.0.1:8080',
      ALL_PROXY: 'socks5://127.0.0.1:1080',
      NO_PROXY: 'localhost',
      no_proxy: 'localhost',
      NODE_USE_ENV_PROXY: '1',
      NODE_OPTIONS: '--use-env-proxy',
      NODE_EXTRA_CA_CERTS: 'C:\\mitm.pem',
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\Windows\\system32',
      TEMP: 'C:\\Temp',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
      UNSET: undefined,
    });
    expect(env).toEqual({
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\Windows\\system32',
      TEMP: 'C:\\Temp',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
    });
  });

  it('keeps look-alike names that are not proxy settings', () => {
    expect(serviceEnv({ MY_HTTPS_PROXY_NOTE: 'x', PROXY: 'y', NODE_ENV: 'production' })).toEqual({
      MY_HTTPS_PROXY_NOTE: 'x',
      PROXY: 'y',
      NODE_ENV: 'production',
    });
  });
});
