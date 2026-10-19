// F17 navigation in the real dashboard (App.tsx's Root against the browser mock, in the minimal DOM of
// domShim.ts): the scrap.tf banks page's View stock on every card leads to that bank's stock page at
// #/banks/<bank>/stock, its "All scrap.tf banks" leads back to the card, and #/banks alone is still the
// banks page. The browser's hashchange is played by hand (the shim's window has no event loop of its
// own). Nothing leaves the process; nothing here contacts scrap.tf.

import { act, createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockBridge } from '../../src/renderer/mock';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import type { ScraptfBank } from '../../src/shared/types';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let Root: typeof import('../../src/renderer/App').Root;
let createMockBridge: typeof import('../../src/renderer/mock').createMockBridge;
const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;
/** The hashchange listeners the app subscribed, so a test can play the browser's event. */
const hashListeners = new Set<() => void>();

beforeAll(async () => {
  doc = installDomShim();
  win()['location'] = { hash: '#/banks' };
  // What the shim leaves out and the shell uses: scrolling the content back to the top, the
  // window kind on <html>, and hash listeners worth keeping.
  const proto = ShimElement.prototype as unknown as Record<string, unknown>;
  if (typeof proto['scrollTo'] !== 'function') proto['scrollTo'] = () => undefined;
  const html = doc.documentElement as unknown as Record<string, unknown>;
  if (!html['dataset']) html['dataset'] = {};
  const g = globalThis as Record<string, unknown>;
  g['HTMLElement'] ??= ShimElement;
  g['Element'] ??= ShimElement;
  // The stock page's sort picker is a <select>: React marks its options (as bankStockPage.test.ts).
  if (!Object.getOwnPropertyDescriptor(ShimElement.prototype, 'options')) {
    Object.defineProperty(ShimElement.prototype, 'options', {
      configurable: true,
      get(this: ShimElement) {
        return this.tagName === 'SELECT' ? this.descendants().filter((e) => e.tagName === 'OPTION') : undefined;
      },
    });
  }
  win()['addEventListener'] = (type: string, fn: () => void) => {
    if (type === 'hashchange') hashListeners.add(fn);
  };
  win()['removeEventListener'] = (type: string, fn: () => void) => {
    if (type === 'hashchange') hashListeners.delete(fn);
  };
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
  win()['location'] = { hash: '#/banks' };
  hashListeners.clear();
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

function fire(target: ShimElement, type: string) {
  act(() => {
    target.dispatchEvent(new ShimEvent(type, { bubbles: true, cancelable: true }));
  });
}

async function mountApp(hash: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  win()['location'] = { hash };
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => NOW }));
  await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: NOW, watchFolder: 'D:\\saves' } });
  const rpc = vi.spyOn(b, 'rpc');
  win()['flipdesk'] = b;
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
  const card = (bank: ScraptfBank) => all().find((e) => e.tagName === 'SECTION' && e.getAttribute('data-bank') === bank);
  const button = (within: ShimElement, label: RegExp) => within.descendants().find((e) => e.tagName === 'BUTTON' && label.test(e.textContent));
  const title = () => all().find((e) => e.tagName === 'H1')?.textContent ?? '';
  /** The browser's part: the address changed, so tell the app (hashchange). */
  const followHash = async () => {
    act(() => {
      for (const fn of [...hashListeners]) fn();
    });
    await settle();
  };
  const stockReads = () => rpc.mock.calls.filter((c) => c[0] === 'scraptf.bankStock').map((c) => (c[1] as { bank: ScraptfBank }).bank);
  return { container, all, card, button, title, followHash, stockReads, content: () => container.textContent };
}

describe('from the scrap.tf banks page to a bank stock page and back (App routes)', () => {
  it('#/banks is the banks page, with a View stock button on every card', async () => {
    const t = await mountApp('#/banks');
    expect(t.title()).toBe('scrap.tf banks');
    for (const b of SCRAPTF_BANKS) expect(t.button(t.card(b.bank)!, /^View stock$/), b.bank).toBeDefined();
    expect(t.stockReads()).toEqual([]);
  });

  it.each(SCRAPTF_BANKS.map((b) => [b.bank, b.label] as const))('View stock on %s opens its stock page, and Back returns to its card', async (bank, label) => {
    const t = await mountApp('#/banks');
    fire(t.button(t.card(bank)!, /^View stock$/)!, 'click');
    expect(win()['location']).toEqual({ hash: `#/banks/${bank}/stock` });
    await t.followHash();
    // The stock page, under the scrap.tf banks nav entry, reading that bank only.
    expect(t.title()).toBe('scrap.tf banks');
    expect(t.content()).toContain(`${label} stock`);
    expect(t.card(bank)).toBeUndefined();
    expect(new Set(t.stockReads())).toEqual(new Set([bank]));
    // Back to the banks page, focused on the card it came from.
    fire(t.button(t.container, /All scrap\.tf banks/)!, 'click');
    expect(win()['location']).toEqual({ hash: `#/banks/${bank}` });
    await t.followHash();
    expect(t.card(bank)).toBeDefined();
    expect(t.content()).not.toContain(`${label} stock`);
  });

  it('an unknown bank in the address stays on the banks page', async () => {
    const t = await mountApp('#/banks/__proto__/stock');
    expect(t.card('hats')).toBeDefined();
    expect(t.stockReads()).toEqual([]);
  });
});
