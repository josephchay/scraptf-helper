// 0.7.2: the dashboard when this copy of Flip Desk is older than its data. The service answers but
// refuses the database (every service call rejects with SchemaVersionError's message), while main still
// answers its own calls ('app.info', 'settings.get'). The dashboard shows its own screen for that, with
// the running copy's version and folder; any other failure keeps "Can't reach the background service".
// The real App root against the browser mock (main's calls) in the minimal DOM of domShim.ts.

import { act, createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockBridge } from '../../src/renderer/mock';
import { SERVICE_METHODS, type AppInfo, type FlipdeskBridge } from '../../src/shared/rpc';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const NOW = Date.UTC(2026, 9, 20, 5, 41, 31);
const REFUSAL = 'Database schema version 11 is newer than this app supports (10). Update the app or use a different data folder.';
const INFO: AppInfo = {
  version: '0.7.1',
  appDir: 'C:\\Users\\User\\Desktop\\Everything\\Work\\coding\\scraptf-helper',
  dataDir: 'C:\\Users\\User\\AppData\\Roaming\\TF2 Flip Desk\\data',
  logDir: 'C:\\Users\\User\\AppData\\Roaming\\TF2 Flip Desk\\logs',
  platform: 'win32',
  electron: '44.5.0',
  node: '24.21.0',
};

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let Root: typeof import('../../src/renderer/App').Root;
let createMockBridge: typeof import('../../src/renderer/mock').createMockBridge;
const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  win()['location'] = { hash: '#/opportunities' };
  const proto = ShimElement.prototype as unknown as Record<string, unknown>;
  if (typeof proto['scrollTo'] !== 'function') proto['scrollTo'] = () => undefined;
  const html = doc.documentElement as unknown as Record<string, unknown>;
  if (!html['dataset']) html['dataset'] = {};
  const g = globalThis as Record<string, unknown>;
  g['HTMLElement'] ??= ShimElement;
  g['Element'] ??= ShimElement;
  win()['addEventListener'] = () => undefined;
  win()['removeEventListener'] = () => undefined;
  ({ createRoot } = await import('react-dom/client'));
  ({ Root } = await import('../../src/renderer/App'));
  ({ createMockBridge } = await import('../../src/renderer/mock'));
  // Importing the whole dashboard takes about 3 s alone and can pass the default 10 s while the suite is busy.
}, 60_000);

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  for (let round = 0; round < 4; round++) {
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** Every service call rejects with `serviceError`; main's own calls answer (app.info as `info`). */
async function mountApp(serviceError: string, info: AppInfo | Error = INFO) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => NOW }));
  const calls: string[] = [];
  const w: FlipdeskBridge = {
    windowKind: 'dashboard',
    rpc: ((m, p) => {
      calls.push(m);
      if (SERVICE_METHODS.includes(m)) return Promise.reject(new Error(serviceError));
      if (m === 'app.info') return info instanceof Error ? Promise.reject(info) : Promise.resolve(info);
      return b.rpc(m, p);
    }) as FlipdeskBridge['rpc'],
    on: (e, fn) => b.on(e, fn),
  };
  win()['flipdesk'] = w;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(Root)));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const all = () => container.descendants();
  const retry = () => all().find((e) => e.tagName === 'BUTTON' && e.textContent === 'Retry');
  const rows = () => {
    const dl = all().find((e) => e.tagName === 'DL');
    if (!dl) return null;
    const cells = dl.descendants().filter((e) => e.tagName === 'DT' || e.tagName === 'DD');
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < cells.length; i += 2) out[cells[i]!.textContent] = cells[i + 1]!.textContent;
    return out;
  };
  return { calls, all, retry, rows, text: () => container.textContent };
}

describe('the dashboard when this copy is older than its data', () => {
  it('shows its own screen with the running copy, not "Can\'t reach the background service"', async () => {
    const t = await mountApp(REFUSAL);
    const text = t.text();
    expect(text).not.toContain("Can't reach the background service");
    expect(text).not.toMatch(/schema/i);
    expect(text).toContain('This copy of Flip Desk is older than its data');
    expect(text).toContain(`This copy of Flip Desk is older than the data it found in ${INFO.dataDir}.`);
    expect(text).toContain('The data is at version 11. This copy reads up to version 10.');
    expect(text).toContain('Nothing was changed. Your data is safe.');
    expect(text).toContain('Close this copy and start the newer one.');
    expect(text).toContain(`get the latest code into ${INFO.appDir}, then run npm start.`);
    expect(t.rows()).toEqual({ Version: '0.7.1', 'Runs from': INFO.appDir, 'Data folder': INFO.dataDir });
    // No dashboard behind it: the service has no data to show.
    expect(t.all().some((e) => e.tagName === 'NAV')).toBe(false);
  });

  it('keeps Retry, which asks the service again', async () => {
    const t = await mountApp(REFUSAL);
    const before = t.calls.filter((m) => m === 'status.get').length;
    await act(async () => {
      t.retry()!.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(t.calls.filter((m) => m === 'status.get').length).toBe(before + 1);
    expect(t.text()).toContain('This copy of Flip Desk is older than its data');
  });

  it('names no folder when main could not say which copy this is', async () => {
    const t = await mountApp(REFUSAL, new Error('app.info failed'));
    const text = t.text();
    expect(text).toContain('This copy of Flip Desk is older than the data in its data folder.');
    expect(text).toContain('get the latest code into its folder, then run npm start.');
    expect(text).toContain('Flip Desk could not tell which copy this is.');
    expect(text).not.toMatch(/[A-Za-z]:\\/);
    expect(t.rows()).toBeNull();
    expect(t.retry()).toBeDefined();
  });

  it('keeps today\'s message for any other error', async () => {
    const t = await mountApp('The service is not ready (restarting); status.get timed out');
    const text = t.text();
    expect(text).toContain("Can't reach the background service: The service is not ready (restarting); status.get timed out");
    expect(text).not.toContain('older than its data');
    expect(t.retry()).toBeDefined();
  });
});
