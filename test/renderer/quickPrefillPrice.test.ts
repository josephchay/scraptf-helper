// F16: the live check popup's "Quick entry…" opens quick entry with the item and the price it checked
// ('ui.quickPrefill' { sku, price }). Quick entry fills the price field only when a readable price
// comes with the push. Rendered with react-dom/client into domShim.ts with the browser mock.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { prefillPriceText } from '../../src/renderer/quickModel';
import { CHECK_PRICE_TEXT_MAX } from '../../src/shared/check';
import type { FlipdeskBridge, PushContract } from '../../src/shared/rpc';
import { installDomShim, type ShimDocument, type ShimElement } from './domShim';

describe('prefillPriceText', () => {
  it('passes a readable price through, trimmed', () => {
    expect(prefillPriceText('1 key 5.33 ref')).toBe('1 key 5.33 ref');
    expect(prefillPriceText('  1.33 ref ')).toBe('1.33 ref');
    expect(prefillPriceText('2 keys')).toBe('2 keys');
  });

  it('drops anything else, so nothing odd lands in the field', () => {
    for (const v of [undefined, null, 12, '', '   ', 'Team Captain', '<b>1 ref</b>', '1 ref\n2 ref', '1\u0007 ref', `${'9'.repeat(CHECK_PRICE_TEXT_MAX)} ref`]) {
      expect(prefillPriceText(v)).toBe('');
    }
  });
});

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let QuickEntry: () => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  if (!('oninput' in doc)) (doc as unknown as Record<string, unknown>)['oninput'] = null;
  win()['location'] = { hash: '' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ QuickEntry } = await import('../../src/renderer/pages/QuickEntry'));
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

async function mount() {
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  const local = new Set<(p: unknown) => void>();
  const w: FlipdeskBridge = {
    windowKind: 'quick-entry',
    rpc: (m, p) => b.rpc(m, p),
    on: (e, fn) => {
      const f = fn as (p: unknown) => void;
      if (e === 'ui.quickPrefill') local.add(f);
      const off = b.on(e, fn);
      return () => {
        local.delete(f);
        off();
      };
    },
  };
  win()['flipdesk'] = w;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(QuickEntry))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const priceInput = () => container.descendants().find((e) => e.getAttribute('id') === 'q-price') as (ShimElement & { value?: string }) | undefined;
  return {
    prefill: async (p: PushContract['ui.quickPrefill']) => {
      act(() => {
        for (const fn of local) fn(p);
      });
      await settle();
    },
    price: () => priceInput()?.value ?? '',
    text: () => container.textContent,
  };
}

describe('quick entry prefilled from the check popup', () => {
  it('picks the item and fills the price it checked', async () => {
    const t = await mount();
    await t.prefill({ sku: '378;6', price: '1 key 5.33 ref' });
    expect(t.text()).toContain('Team Captain');
    expect(t.price()).toBe('1 key 5.33 ref');
  });

  it('leaves the price empty without one (the F8 prefill), and clears an old one', async () => {
    const t = await mount();
    await t.prefill({ sku: '378;6', price: '1 key 5.33 ref' });
    await t.prefill({ sku: '378;6' });
    expect(t.price()).toBe('');
  });

  it('ignores price text the field could not read', async () => {
    const t = await mount();
    await t.prefill({ sku: '378;6', price: 'not a price' });
    expect(t.text()).toContain('Team Captain');
    expect(t.price()).toBe('');
  });
});
