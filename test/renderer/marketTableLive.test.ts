// F10 Live market table with its effects running: rendered with react-dom/client
// into the minimal DOM in domShim.ts (the renderer tests have no jsdom). Covers
// what a static render cannot: a keyboard move that changes nothing must not
// leave the table following the cursor, or the next live re-sort jumps the view
// back to the selected row; and Freeze stops infinite scroll. No network.

import { act, createElement, useMemo, useState, type ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MarketTableProps } from '../../src/renderer/pages/MarketPage';
import { DEFAULT_MARKET_SORT, marketDisplayRows } from '../../src/renderer/marketModel';
import { scraptfLinkFor } from '../../src/shared/links';
import type { MarketRow } from '../../src/shared/types';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const ROW_H = 38; // comfortable density
const noop = () => undefined;

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let MarketTable: typeof import('../../src/renderer/pages/MarketPage').MarketTable;

beforeAll(async () => {
  // Before react-dom loads: it checks for a DOM once, at import.
  doc = installDomShim();
  ({ createRoot } = await import('react-dom/client'));
  ({ MarketTable } = await import('../../src/renderer/pages/MarketPage'));
});

function row(sku: string): MarketRow {
  return {
    sku,
    name: `Item ${sku}`,
    category: 'hats',
    revenueScrap: 120,
    bestScrap: 130,
    consScrap: 120,
    instantScrap: 110,
    revenueOrder: null,
    buyerCount: 3,
    maxCostScrap: 100,
    confidence: 60,
    confidenceLevel: 'medium',
    flags: [],
    knownCostScrap: null,
    knownSource: 'none',
    knownObservedAt: null,
    stock: null,
    ruleCostScrap: null,
    profitScrap: null,
    verdict: 'unchecked',
    lastOrderChangeAt: T0 - 60_000,
    evaluatedAt: T0,
    scraptfPaysScrap: null,
    scraptfStock: null,
    scraptfStockLimit: null,
    scraptfFull: false,
    scraptfListAt: null,
    scraptfNewAt: null,
    scraptfListedSince: null,
    scraptfLink: scraptfLinkFor('hats', null),
  };
}

const skus = (n: number, prefix = 's') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

interface Control {
  setRows(rows: MarketRow[]): void;
  setFrozen(on: boolean): void;
  selected: string | null;
}

const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
});

/** The table as the page holds it: selection and rows in state, the window's total fixed. */
function mount(initial: MarketRow[], total: number) {
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const ctl = { selected: null } as Control;
  const selects: (string | null)[] = [];
  let loads = 0;
  function Harness(): ReactElement {
    const [rows, setRows] = useState(initial);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [frozen, setFrozen] = useState(false);
    ctl.setRows = setRows;
    ctl.setFrozen = setFrozen;
    ctl.selected = selectedId;
    const display = useMemo(() => marketDisplayRows(rows, total), [rows]);
    const props: MarketTableProps = {
      rows: display,
      dataKey: 'q',
      keyScrap: 568,
      now: T0,
      density: 'comfortable',
      selectedId,
      flash: { seq: 0, dirs: new Map() },
      sort: { ...DEFAULT_MARKET_SORT },
      loadingMore: false,
      frozen,
      onSelect: (id) => {
        selects.push(id);
        setSelectedId(id);
      },
      onOpen: noop,
      onMenu: noop,
      onLoadMore: () => {
        loads++;
      },
      onSort: noop,
    };
    return createElement(MarketTable, props);
  }
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(Harness)));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  const grid = container.descendants().find((e) => e.getAttribute('role') === 'grid') as ShimElement;
  expect(grid).toBeDefined();
  const fire = (target: ShimElement, type: string, init: Record<string, unknown> = {}) =>
    act(() => {
      target.dispatchEvent(new ShimEvent(type, init));
    });
  return {
    ctl,
    grid,
    selects,
    loads: () => loads,
    focus: () => fire(grid, 'focusin', { bubbles: true }),
    key: (key: string) => fire(grid, 'keydown', { bubbles: true, cancelable: true, key }),
    scrollTo: (top: number) => {
      grid.scrollTop = top;
      fire(grid, 'scroll');
    },
  };
}

describe('MarketTable keyboard cursor and live re-sorts', () => {
  it('a key that does not move the cursor leaves no pending scroll for the next re-sort', async () => {
    const rows = skus(400).map(row);
    const t = mount(rows, rows.length);
    t.focus();
    expect(t.ctl.selected).toBe('s0'); // focusing the grid selects the first row
    t.key('k'); // already at the top: nothing moves
    t.key('Home');

    // The user wheels down to read further.
    t.scrollTo(300 * ROW_H);
    await act(() => new Promise<void>((r) => setTimeout(r, 0)));

    // A live refresh puts a new leader above everything: the rows being read shift down by one,
    // and the anchoring keeps them in place. The selected row (s0) is far above the view.
    act(() => t.ctl.setRows([row('new'), ...rows]));
    expect(t.grid.scrollTop).toBe(301 * ROW_H);
    // The keys that could not move asked for nothing.
    expect(t.selects).toEqual(['s0']);
  });

  it('still keeps the cursor in view when the keyboard really moves it', () => {
    const rows = skus(400).map(row);
    const t = mount(rows, rows.length);
    t.focus();
    t.key('End');
    expect(t.ctl.selected).toBe('s399');
    // The last row is brought into view: its bottom edge at the bottom of the visible area.
    const visible = 600 - 34;
    expect(t.grid.scrollTop).toBe(400 * ROW_H - visible);
    t.key('j'); // at the end: no move, no scroll request
    expect(t.selects).toEqual(['s0', 's399']);
  });
});

describe('MarketTable infinite scroll and Freeze', () => {
  it('does not load more while frozen, and loads once unfrozen', () => {
    // Five rows of 300: the "Load more" row is inside the view at once.
    const t = mount(skus(5).map(row), 300);
    expect(t.loads()).toBe(1);

    const f = mount(skus(5).map(row), 300);
    // Freeze before the rows arrive, as when the user freezes and then scrolls to the end.
    act(() => f.ctl.setFrozen(true));
    act(() => f.ctl.setRows(skus(6).map(row)));
    expect(f.loads()).toBe(1); // only the load from before Freeze
    f.key('End');
    f.key('Enter'); // the More row: Enter would load, but not while frozen
    expect(f.loads()).toBe(1);
    act(() => f.ctl.setFrozen(false));
    expect(f.loads()).toBe(2);
  });
});
