// 0.7.4 review (R14): the check popup shows the cost check's note (a price PriceDB says is another copy's, or far
// under what bots pay) as a warning, like an undecided craftability, not as a muted aside. Mock bridge and DOM shim
// only: no network, no clipboard.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { mockCheckDemo } from '../../src/renderer/mockCheck';
import { CHECK_COST_BELOW_MARKET_NOTE, CHECK_COST_VARIANT_NOTE } from '../../src/shared/check';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { FlipdeskBridge } from '../../src/shared/rpc';
import type { CheckResult } from '../../src/shared/types';
import { installDomShim, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 21, 12, 0, 0);
const K = 567;

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let CheckPopup: () => ReactNode;
const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  win()['location'] = { hash: '#/check' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ CheckPopup } = await import('../../src/renderer/pages/CheckPopup'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
});

async function settle(rounds = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

const cls = (e: ShimElement) => e.getAttribute('class') ?? '';

async function mount() {
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  const show = new Set<(p: unknown) => void>();
  const w: FlipdeskBridge = {
    windowKind: 'check',
    rpc: (m, p) => b.rpc(m, p),
    on: (e, fn) => {
      const f = fn as (p: unknown) => void;
      if (e === 'ui.checkShow') show.add(f);
      const off = b.on(e, fn);
      return () => {
        show.delete(f);
        off();
      };
    },
  };
  win()['flipdesk'] = w;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(CheckPopup))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  return {
    show: async (r: CheckResult) => {
      act(() => {
        for (const fn of show) fn(r);
      });
      await settle();
    },
    note: () => container.descendants().find((e) => cls(e).includes('cp-note')) ?? null,
  };
}

describe('the cost check note in the popup (R14)', () => {
  it('is a warning for either cost note, and a plain note stays muted', async () => {
    const t = await mount();
    const flip = mockCheckDemo('flip', T0, K, DEFAULT_SETTINGS);
    for (const [i, reason] of [CHECK_COST_VARIANT_NOTE, CHECK_COST_BELOW_MARKET_NOTE].entries()) {
      await t.show({ ...flip, reason, confidence: 44, confidenceLevel: 'low', checkedAt: T0 + i + 1 });
      expect(t.note()?.textContent).toBe(reason);
      expect(cls(t.note()!)).toContain('cp-craft');
    }
    await t.show({ ...flip, reason: 'Closest match only: check that this is the item you copied.', checkedAt: T0 + 9 });
    expect(cls(t.note()!)).toContain('muted');
  });
});
