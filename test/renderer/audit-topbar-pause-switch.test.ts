// 0.7.3: the top bar's Pause/Resume network button shows the user's switch (settings.networkPaused),
// the value its click flips, as the tray and Settings do. It used to show the service's status, which
// lags while the service restarts: main saves the switch, but status.get fails and no status push
// comes, so the label stayed "Pause network" and a second click paused again instead of resuming.
// The real App root against the browser mock (main's calls) in the minimal DOM of domShim.ts.

import { act, createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockBridge } from '../../src/renderer/mock';
import { SERVICE_METHODS, type FlipdeskBridge } from '../../src/shared/rpc';
import type { DeepPartial, Settings } from '../../src/shared/types';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

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
});

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

/** The dashboard on the mock; `down()` makes the service unreachable, as during a restart wait. */
async function mountApp() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => NOW }));
  let isDown = false;
  const patches: DeepPartial<Settings>[] = [];
  const w: FlipdeskBridge = {
    windowKind: 'dashboard',
    rpc: ((m, p) => {
      if (m === 'settings.set') patches.push(p as DeepPartial<Settings>);
      if (isDown && SERVICE_METHODS.includes(m)) return Promise.reject(new Error('The service is not ready (restarting)'));
      return b.rpc(m, p);
    }) as FlipdeskBridge['rpc'],
    // Main forwards only the service's own pushes, and a stopped service sends none.
    on: (e, fn) =>
      b.on(e, (p) => {
        if (isDown && e === 'status.changed') return;
        fn(p);
      }),
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
  const button = () => container.descendants().find((e) => e.tagName === 'BUTTON' && /(Pause|Resume) network/.test(e.textContent));
  const label = () => button()?.textContent ?? null;
  const click = async () => {
    await act(async () => {
      button()!.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
  };
  return { patches, label, click, down: () => void (isDown = true) };
}

describe('the top bar network kill switch', () => {
  it('follows the switch it flips while the service is restarting', async () => {
    const t = await mountApp();
    expect(t.label()).toBe('Pause network');
    t.down();
    await t.click();
    expect(t.label()).toBe('Resume network');
    await t.click();
    expect(t.label()).toBe('Pause network');
    expect(t.patches).toEqual([{ networkPaused: true }, { networkPaused: false }]);
  });

  it('still pauses and resumes with the service up', async () => {
    const t = await mountApp();
    expect(t.label()).toBe('Pause network');
    await t.click();
    expect(t.label()).toBe('Resume network');
    await t.click();
    expect(t.label()).toBe('Pause network');
    expect(t.patches).toEqual([{ networkPaused: true }, { networkPaused: false }]);
  });
});
