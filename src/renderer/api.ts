// The dashboard's only way to reach the app: window.flipdesk (preload) in
// Electron, or the in-memory mock when the UI runs in a plain browser for
// development. The renderer itself never touches the network.

import type { FlipdeskBridge, PushContract, PushEvent, RpcMethod, RpcParams, RpcResult } from '../shared/rpc';
import { errorMessage } from './format';

type ParamArgs<M extends RpcMethod> = [RpcParams<M>] extends [void] ? [params?: undefined] : [params: RpcParams<M>];

export type WindowKind = 'dashboard' | 'quick-entry';

function nativeBridge(): FlipdeskBridge | null {
  if (typeof window === 'undefined') return null;
  const b = (window as unknown as { flipdesk?: FlipdeskBridge }).flipdesk;
  return b && typeof b.rpc === 'function' && typeof b.on === 'function' ? b : null;
}

// The mock exists for UI development only. Vite replaces import.meta.env.DEV
// at build time, so a production build drops the mock chunk entirely and a
// missing preload bridge fails closed instead of showing fake data.
const loadMock: (() => Promise<FlipdeskBridge>) | null = import.meta.env.DEV ? () => import('./mock').then((m) => m.createMockBridge()) : null;

/** True when running against mock data (development build in a plain browser, no preload). */
export const isMock: boolean = loadMock !== null && nativeBridge() === null;

export const BRIDGE_MISSING_MESSAGE = 'The app bridge failed to load. Restart TF2 Flip Desk; details are in the log.';

/**
 * The preload bridge when present; otherwise the mock in a development build,
 * or a rejection in a packaged one (every RPC then fails with a clear error).
 */
export function resolveBridge(native: FlipdeskBridge | null, mock: (() => Promise<FlipdeskBridge>) | null): Promise<FlipdeskBridge> {
  if (native) return Promise.resolve(native);
  if (!mock) return Promise.reject(new Error(BRIDGE_MISSING_MESSAGE));
  return mock();
}

let mockBridge: Promise<FlipdeskBridge> | null = null;

function bridge(): Promise<FlipdeskBridge> {
  const n = nativeBridge();
  if (n || !loadMock) return resolveBridge(n, null);
  // Loaded lazily and once, so it stays out of the main chunk.
  mockBridge ??= resolveBridge(null, loadMock);
  return mockBridge;
}

export async function rpc<M extends RpcMethod>(method: M, ...args: ParamArgs<M>): Promise<RpcResult<M>> {
  return call(method, args[0] as RpcParams<M>);
}

/** Same as rpc() with the params always passed explicitly (for generic callers). */
export async function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
  const b = await bridge();
  return b.rpc(method, params);
}

/** Subscribes to a push event; returns an unsubscribe function. */
export function on<E extends PushEvent>(event: E, listener: (payload: PushContract[E]) => void): () => void {
  const n = nativeBridge();
  if (n) return n.on(event, listener);
  let off: (() => void) | null = null;
  let cancelled = false;
  bridge()
    .then((b) => {
      if (!cancelled) off = b.on(event, listener);
    })
    .catch(() => {
      // No bridge: RPCs report the error; there is nothing to subscribe to.
    });
  return () => {
    cancelled = true;
    off?.();
  };
}

export function windowKind(): WindowKind {
  if (nativeBridge()?.windowKind === 'quick-entry') return 'quick-entry';
  if (typeof location !== 'undefined' && location.hash.startsWith('#/quick')) return 'quick-entry';
  return 'dashboard';
}

/** Opens an external link through main's allowlist; never window.open. */
export async function openLink(url: string): Promise<{ opened: boolean; reason: string | null }> {
  try {
    return await rpc('links.open', { url });
  } catch (e) {
    return { opened: false, reason: errorMessage(e) };
  }
}

/** Fetches CSV text from the service and hands it to main's save dialog. */
export async function saveCsv(fetchCsv: () => Promise<{ csv: string; suggestedName: string }>): Promise<{ saved: boolean; path: string | null }> {
  const { csv, suggestedName } = await fetchCsv();
  return rpc('file.saveText', { suggestedName, text: csv });
}
