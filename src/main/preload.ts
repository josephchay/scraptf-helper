// Sandboxed preload: exposes window.flipdesk and nothing else. Only 'electron'
// may be required at runtime here (sandbox), so this file imports no Node
// modules and no main-process helpers.

import { contextBridge, ipcRenderer } from 'electron';
import { MAIN_METHODS, PUSH_EVENTS, SERVICE_METHODS, type FlipdeskBridge, type PushContract, type PushEvent } from '../shared/rpc';

// Keep in sync with WINDOW_KIND_ARG in src/main/paths.ts.
const WINDOW_KIND_ARG = '--flipdesk-window=';
const WINDOW_KINDS = ['dashboard', 'quick-entry'];

const pushEvents = new Set<string>(PUSH_EVENTS);

const methods = new Set<string>([...MAIN_METHODS, ...SERVICE_METHODS]);

export function windowKindFromArgv(argv: readonly string[]): string {
  const arg = argv.find((a) => a.startsWith(WINDOW_KIND_ARG));
  const kind = arg?.slice(WINDOW_KIND_ARG.length) ?? '';
  return WINDOW_KINDS.includes(kind) ? kind : 'dashboard';
}

/** Strips Electron's "Error invoking remote method 'rpc': Error: " prefix. */
export function cleanIpcError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  return new Error(raw.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, ''));
}

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

/** An 'ui.openItem' that arrived before the dashboard subscribed (window just created). */
let pendingOpenItem: { payload: unknown } | null = null;

ipcRenderer.on('push', (_event, name: unknown, payload: unknown) => {
  if (typeof name !== 'string') return;
  const set = listeners.get(name);
  if (!set || set.size === 0) {
    if (name === 'ui.openItem') pendingOpenItem = { payload };
    return;
  }
  for (const fn of [...set]) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`flipdesk listener for ${name} failed`, err);
    }
  }
});

/** Unwraps the { ok, result | error } envelope sent by src/main/ipc.ts. */
export function unwrapEnvelope(envelope: unknown): unknown {
  if (typeof envelope === 'object' && envelope !== null && 'ok' in envelope) {
    const e = envelope as { ok: unknown; result?: unknown; error?: unknown };
    if (e.ok === true) return e.result;
    if (e.ok === false) throw new Error(typeof e.error === 'string' && e.error !== '' ? e.error : 'Request failed');
  }
  throw new Error('Malformed response from the main process');
}

const rpc = async (method: unknown, params: unknown): Promise<unknown> => {
  if (typeof method !== 'string' || !methods.has(method)) {
    throw new Error(`Unknown method: ${String(method).slice(0, 64)}`);
  }
  let envelope: unknown;
  try {
    envelope = await ipcRenderer.invoke('rpc', method, params);
  } catch (err) {
    throw cleanIpcError(err);
  }
  return unwrapEnvelope(envelope);
};

const on = (event: unknown, listener: unknown): (() => void) => {
  if (typeof event !== 'string' || !pushEvents.has(event)) throw new Error(`Unknown event: ${String(event)}`);
  if (typeof listener !== 'function') throw new Error('listener must be a function');
  const fn = listener as Listener;
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(fn);
  if (event === 'ui.openItem' && pendingOpenItem) {
    const { payload } = pendingOpenItem;
    pendingOpenItem = null;
    queueMicrotask(() => {
      try {
        fn(payload);
      } catch (err) {
        console.error('flipdesk listener for ui.openItem failed', err);
      }
    });
  }
  return () => {
    listeners.get(event)?.delete(fn);
  };
};

const bridge: FlipdeskBridge = {
  rpc: rpc as FlipdeskBridge['rpc'],
  on: on as <E extends PushEvent>(event: E, listener: (payload: PushContract[E]) => void) => () => void,
  windowKind: windowKindFromArgv(process.argv),
};

contextBridge.exposeInMainWorld('flipdesk', bridge);
