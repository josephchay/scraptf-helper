// 0.7.3: clicking "Load N more" in the Live market or under an Opportunities group leaves the focus on
// the grid, as the row's scrap.tf button does, so j/k, the arrows and Enter go on working. The grids
// take keys only when they themselves have the focus. Rendered with react-dom/client into the minimal
// DOM in domShim.ts; the shim moves no focus on a mouse press, so press() does what Chromium does.
// No network.

import { act, createElement, useMemo, useState, type ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MarketTableProps } from '../../src/renderer/pages/MarketPage';
import { DEFAULT_MARKET_SORT, marketDisplayRows } from '../../src/renderer/marketModel';
import { flattenGroups, type OppGroup } from '../../src/renderer/oppModel';
import { scraptfLinkFor } from '../../src/shared/links';
import type { MarketRow, Opportunity } from '../../src/shared/types';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const noop = () => undefined;

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let MarketTable: typeof import('../../src/renderer/pages/MarketPage').MarketTable;
let OppTable: typeof import('../../src/renderer/components/OppTable').OppTable;

beforeAll(async () => {
  // Before react-dom loads: it checks for a DOM once, at import.
  doc = installDomShim();
  ({ createRoot } = await import('react-dom/client'));
  ({ MarketTable } = await import('../../src/renderer/pages/MarketPage'));
  ({ OppTable } = await import('../../src/renderer/components/OppTable'));
});

const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  doc.activeElement = doc.body;
});

function marketRow(sku: string): MarketRow {
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

function opp(key: string): Opportunity {
  return {
    key,
    sku: '378;6',
    name: key,
    category: 'hats',
    inputRef: 'price:1',
    inputKind: 'user',
    costKeys: 0,
    costScrapRaw: 100,
    costScrap: 100,
    bestScrap: 130,
    consScrap: 120,
    instantScrap: 110,
    revenueScrap: 120,
    profitScrap: 20,
    margin: 0.2,
    maxCostScrap: null,
    confidence: 60,
    confidenceLevel: 'medium',
    flags: [],
    reasons: [],
    buyerCount: 3,
    bestOrder: null,
    consOrder: null,
    instantOrder: null,
    references: { pricedb: null, community: null },
    profitTier: 'ref2',
    status: 'profitable',
    inputObservedAt: T0,
    firstSeenAt: T0,
    updatedAt: T0,
  };
}

/** Renders `el` and hands back the grid plus helpers that dispatch where the focus really is. */
function render(el: () => ReactElement) {
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(el)));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  const grid = container.descendants().find((e) => e.getAttribute('role') === 'grid') as ShimElement;
  expect(grid).toBeDefined();
  const fire = (target: ShimElement, type: string, init: Record<string, unknown> = {}) => {
    let ev!: ShimEvent;
    act(() => {
      ev = new ShimEvent(type, init);
      target.dispatchEvent(ev);
    });
    return ev;
  };
  return {
    container,
    grid,
    focus: () => {
      grid.focus();
      fire(grid, 'focusin', { bubbles: true });
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
    button: (re: RegExp) => container.descendants().find((e) => e.tagName === 'BUTTON' && re.test(e.textContent)) as ShimElement,
  };
}

describe('Live market: Load more keeps the keyboard on the grid', () => {
  function mount() {
    const ctl = { selected: null as string | null, loads: 0 };
    function Harness(): ReactElement {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      ctl.selected = selectedId;
      // Three rows of 300: the More row offers "Load 200 more".
      const rows = useMemo(() => marketDisplayRows(['a', 'b', 'c'].map(marketRow), 300), []);
      const props: MarketTableProps = {
        rows,
        dataKey: 'q',
        keyScrap: 568,
        now: T0,
        density: 'comfortable',
        selectedId,
        flash: { seq: 0, dirs: new Map() },
        sort: { ...DEFAULT_MARKET_SORT },
        loadingMore: false,
        frozen: false,
        onSelect: setSelectedId,
        onOpen: noop,
        onMenu: noop,
        onLoadMore: () => {
          ctl.loads++;
        },
        onSort: noop,
        onScraptf: noop,
      };
      return createElement(MarketTable, props);
    }
    return { ctl, ...render(Harness) };
  }

  it('a click on "Load N more" leaves the focus on the grid, and k still moves the cursor', () => {
    const t = mount();
    t.focus();
    expect(t.ctl.selected).toBe('a');
    const loadsBefore = t.ctl.loads; // infinite scroll may already have asked once
    const btn = t.button(/^Load .* more$/);
    expect(btn).toBeDefined();
    const down = t.press(btn);
    expect(down.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(t.grid);
    expect(t.ctl.loads).toBe(loadsBefore + 1);
    expect(t.ctl.selected).toBe('market:more');
    t.key('k');
    expect(t.ctl.selected).toBe('c');
  });

  it('the scrap.tf row button keeps the focus the same way', () => {
    const t = mount();
    const stf = t.container.descendants().find((e) => e.tagName === 'BUTTON' && (e.getAttribute('class') ?? '').split(' ').includes('m-stf'));
    expect(stf).toBeDefined();
    t.focus();
    expect(t.press(stf!).defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(t.grid);
  });
});

describe('Opportunities: a group\'s Load more keeps the keyboard on the grid', () => {
  it('a click on "Load N more" leaves the focus on the grid, and k still moves the cursor', () => {
    const group: OppGroup = { key: 'hats', label: 'Hats', count: 600, totalProfitScrap: 60, rows: ['h0', 'h1', 'h2'].map(opp) };
    const rows = flattenGroups([group], new Set());
    expect(rows.at(-1)?.id).toBe('more:hats');
    const ctl = { selected: null as string | null, loads: [] as string[] };
    function Harness(): ReactElement {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      ctl.selected = selectedId;
      return createElement(OppTable, {
        rows,
        keyScrap: 568,
        now: T0,
        staleMs: 3_600_000,
        density: 'comfortable',
        useOrder: 'conservative',
        selectedId,
        onSelect: setSelectedId,
        onOpen: noop,
        onToggleGroup: noop,
        onLoadMore: (key: string) => {
          ctl.loads.push(key);
        },
        loadingMore: new Set<string>(),
        sort: 'profit',
        dir: 'desc',
        onSort: noop,
      });
    }
    const t = render(Harness);
    t.focus();
    expect(ctl.selected).toBe('group:hats');
    const btn = t.button(/^Load .* more$/);
    expect(btn).toBeDefined();
    const down = t.press(btn);
    expect(down.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(t.grid);
    expect(ctl.loads).toEqual(['hats']);
    expect(ctl.selected).toBe('more:hats');
    t.key('k');
    expect(ctl.selected).toBe('h2');
  });
});
