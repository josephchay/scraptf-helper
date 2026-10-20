// 0.7.3: the Shopping list's group bank link and the Holdings buyer link leave the focus on the grid
// when clicked, as the Live market's scrap.tf button and the Load more buttons do, so j/k, Enter and
// the page's letter keys go on working. The grids take keys only when they themselves have the focus.
// Rendered with react-dom/client into the minimal DOM of domShim.ts (Shopping as the real page inside
// AppProvider against the browser mock, Holdings as its table on the mock's rows); the shim moves no
// focus on a mouse press, so press() does what Chromium does. links.open is answered in the test, so
// nothing leaves the process.

import { act, createElement, useState, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockBridge } from '../../src/renderer/mock';
import type { HoldingsTableProps } from '../../src/renderer/pages/HoldingsPage';
import type { HoldingRow } from '../../src/shared/types';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const hasClass = (e: ShimElement, cls: string) => (e.getAttribute('class') ?? '').split(' ').includes(cls);

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let ShoppingPage: () => ReactNode;
let HoldingsTable: typeof import('../../src/renderer/pages/HoldingsPage').HoldingsTable;
let createMockBridge: typeof import('../../src/renderer/mock').createMockBridge;
const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  // Before react-dom loads: it checks for a DOM once, at import.
  doc = installDomShim();
  const proto = ShimElement.prototype as unknown as Record<string, unknown>;
  if (typeof proto['scrollTo'] !== 'function') proto['scrollTo'] = () => undefined;
  const html = doc.documentElement as unknown as Record<string, unknown>;
  if (!html['dataset']) html['dataset'] = {};
  const g = globalThis as Record<string, unknown>;
  g['HTMLElement'] ??= ShimElement;
  g['Element'] ??= ShimElement;
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ ShoppingPage } = await import('../../src/renderer/pages/ShoppingPage'));
  ({ HoldingsTable } = await import('../../src/renderer/pages/HoldingsPage'));
  ({ createMockBridge } = await import('../../src/renderer/mock'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
  doc.activeElement = doc.body;
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let round = 0; round < 4; round++) {
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** Renders `el` and hands back the grid plus helpers that dispatch where the focus really is. */
function render(el: ReactElement) {
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(el));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  const fire = (target: ShimElement, type: string, init: Record<string, unknown> = {}) => {
    let ev!: ShimEvent;
    act(() => {
      ev = new ShimEvent(type, init);
      target.dispatchEvent(ev);
    });
    return ev;
  };
  const grid = () => container.descendants().find((e) => e.getAttribute('role') === 'grid') as ShimElement;
  return {
    container,
    grid,
    focus: () => {
      grid().focus();
      fire(grid(), 'focusin', { bubbles: true });
    },
    /** A mouse click as Chromium does it: the press focuses the button unless its default is prevented. */
    press: (btn: ShimElement) => {
      const down = fire(btn, 'mousedown', { bubbles: true, cancelable: true, button: 0 });
      if (!down.defaultPrevented) btn.focus();
      fire(btn, 'click', { bubbles: true, cancelable: true, button: 0 });
      return down;
    },
    /** A key goes to whatever has the focus. */
    key: (key: string) => fire(doc.activeElement, 'keydown', { bubbles: true, cancelable: true, key }),
  };
}

describe('Shopping list: the group bank link keeps the keyboard on the grid', () => {
  async function mount() {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    win()['location'] = { hash: '#/shopping' };
    // No simulated feed ticks: nothing reloads the list under the test.
    const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => NOW }));
    const opened: string[] = [];
    const real = b.rpc.bind(b);
    b.rpc = (async (method: string, params: unknown) => {
      if (method === 'links.open') {
        opened.push((params as { url: string }).url);
        return { opened: true, reason: null };
      }
      return real(method as never, params as never);
    }) as typeof b.rpc;
    win()['flipdesk'] = b;
    const t = render(createElement(AppProvider, null, createElement(ShoppingPage)));
    await settle();
    /** The grid's cursor: the row its aria-activedescendant names. */
    const cursor = () => {
      const id = t.grid().getAttribute('aria-activedescendant');
      return id ? (t.container.descendants().find((e) => e.id === id) ?? null) : null;
    };
    return { ...t, opened, cursor };
  }

  it('a click on the bank link opens the page and leaves the focus on the grid; j and o still work', async () => {
    const t = await mount();
    expect(t.grid()).toBeDefined();
    t.focus();
    const first = t.cursor();
    expect(first?.id).toBe('shoprow-0');
    const groups = t.container.descendants().filter((e) => e.getAttribute('role') === 'row' && hasClass(e, 'opp-group'));
    expect(groups.length).toBeGreaterThan(0);
    const group = groups[0]!;
    const link = group.descendants().find((e) => e.tagName === 'BUTTON' && hasClass(e, 'shop-bank'));
    expect(link).toBeDefined();
    expect(link!.getAttribute('tabindex')).toBe('-1');

    const down = t.press(link!);
    expect(down.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(t.grid());
    await settle();
    expect(t.opened).toHaveLength(1);
    expect(t.opened[0]).toMatch(/^https:\/\/scrap\.tf\//);
    expect(t.cursor()).toBe(group);

    // The keys reach the grid: j moves the cursor off the group, o opens that row's bank page.
    t.key('j');
    const next = t.cursor();
    expect(next).not.toBeNull();
    expect(next).not.toBe(group);
    expect(next!.id).toBe(`shoprow-${Number(group.id.slice('shoprow-'.length)) + 1}`);
    t.key('o');
    await settle();
    expect(t.opened).toHaveLength(2);
  });

  it('why the press must not move the focus: with the link focused, j does nothing', async () => {
    const t = await mount();
    t.focus();
    const link = t.container.descendants().find((e) => e.tagName === 'BUTTON' && hasClass(e, 'shop-bank'))!;
    // What a press whose default is not prevented did before 0.7.3: the link took the focus.
    link.focus();
    const before = t.cursor();
    t.key('j');
    expect(t.cursor()).toBe(before);
  });
});

describe('Holdings: the buyer link keeps the keyboard on the grid', () => {
  let rows: HoldingRow[];
  beforeAll(async () => {
    const b = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => NOW });
    rows = (await b.rpc('holdings.list', {})).rows;
    b.dispose();
  });

  function mount() {
    const calls = { open: vi.fn(), menu: vi.fn(), sale: vi.fn(), buyer: vi.fn() };
    const state = { selected: null as string | null };
    function Harness(): ReactElement {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      state.selected = selectedId;
      const props: HoldingsTableProps = {
        rows,
        keyScrap: 568,
        now: NOW,
        density: 'comfortable',
        profit: null,
        selectedId,
        flash: { seq: 0, dirs: new Map() },
        onSelect: setSelectedId,
        onOpen: calls.open,
        onMenu: calls.menu,
        onRecordSale: calls.sale,
        onOpenBuyer: calls.buyer,
      };
      return createElement(HoldingsTable, props);
    }
    return { calls, state, ...render(createElement(Harness)) };
  }

  it('a click on the buyer link opens the profile and leaves the focus on the grid; j and b still work', () => {
    const t = mount();
    // A row with a buyer link and a row after it for j to move to.
    const rowEls = t.container.descendants().filter((e) => e.getAttribute('role') === 'row' && hasClass(e, 'holding-row'));
    const i = rowEls.findIndex((el, n) => n < rowEls.length - 1 && el.descendants().some((d) => d.tagName === 'BUTTON' && hasClass(d, 'buyer-link')));
    expect(i).toBeGreaterThanOrEqual(0);
    const link = rowEls[i]!.descendants().find((d) => d.tagName === 'BUTTON' && hasClass(d, 'buyer-link'))!;
    expect(link.getAttribute('tabindex')).toBe('-1');
    t.focus();
    expect(t.state.selected).toBe(rows[0]!.sku);

    const down = t.press(link);
    expect(down.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(t.grid());
    expect(t.calls.buyer).toHaveBeenCalledTimes(1);
    expect(t.calls.buyer).toHaveBeenCalledWith(rows[i]);
    expect(t.calls.open).not.toHaveBeenCalled();
    expect(t.state.selected).toBe(rows[i]!.sku);

    t.key('j');
    expect(t.state.selected).toBe(rows[i + 1]!.sku);
    t.key('b');
    expect(t.calls.buyer).toHaveBeenCalledTimes(2);
    expect(t.calls.buyer).toHaveBeenLastCalledWith(rows[i + 1]);
  });
});
