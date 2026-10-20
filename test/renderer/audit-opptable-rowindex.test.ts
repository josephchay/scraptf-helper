// 0.7.3: the Opportunities grid renders only a window of its rows, so every row it does render says
// where it sits in the whole list (aria-rowindex), as the Live market grid does; otherwise a screen
// reader numbers rows by their place in the DOM ("row 3 of 3001" for item 400). Rendered server-side,
// and once with react-dom/client in the minimal DOM of domShim.ts to scroll deep into a long list.
// No network.

import { act, createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { flattenGroups, type DisplayRow, type OppGroup } from '../../src/renderer/oppModel';
import type { Opportunity } from '../../src/shared/types';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const ROW_H = 38; // comfortable density
const noop = () => undefined;

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let renderToString: typeof import('react-dom/server').renderToString;
let OppTable: typeof import('../../src/renderer/components/OppTable').OppTable;

beforeAll(async () => {
  // Before react-dom loads: it checks for a DOM once, at import.
  doc = installDomShim();
  ({ createRoot } = await import('react-dom/client'));
  ({ renderToString } = await import('react-dom/server'));
  ({ OppTable } = await import('../../src/renderer/components/OppTable'));
});

const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
});

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

const group = (key: string, loaded: number, count: number): OppGroup => ({
  key,
  label: key,
  count,
  totalProfitScrap: 20 * loaded,
  rows: Array.from({ length: loaded }, (_, i) => opp(`${key}${i}`)),
});

const props = (rows: DisplayRow[]) => ({
  rows,
  keyScrap: 568,
  now: T0,
  staleMs: 3_600_000,
  density: 'comfortable' as const,
  useOrder: 'conservative' as const,
  selectedId: null,
  onSelect: noop,
  onOpen: noop,
  onToggleGroup: noop,
  sort: 'profit' as const,
  dir: 'desc' as const,
  onSort: noop,
});

/** Each role="row" opening tag: its class, id and aria-rowindex. */
function rowTags(html: string) {
  return [...html.matchAll(/<div\b[^>]*\brole="row"[^>]*>/g)].map(([tag]) => ({
    cls: /\bclass="([^"]*)"/.exec(tag)?.[1] ?? '',
    id: /\bid="([^"]*)"/.exec(tag)?.[1] ?? null,
    rowIndex: /\baria-rowindex="([^"]*)"/.exec(tag)?.[1] ?? null,
  }));
}

describe('Opportunities grid row positions (aria-rowindex)', () => {
  it('numbers the header 1 and each row by its place in the whole list, for group, item and More rows', () => {
    // A collapsed group, a complete expanded one, and one with more matches than it has loaded.
    const rows = flattenGroups([group('a', 2, 2), group('b', 2, 2), group('c', 1, 10)], new Set(['a']));
    expect(rows.map((r) => r.type)).toEqual(['group', 'group', 'opp', 'opp', 'group', 'opp', 'more']);
    const html = renderToString(createElement(OppTable, props(rows))).replace(/<!-- -->/g, '');
    expect(html).toContain(`aria-rowcount="${rows.length + 1}"`);
    const tags = rowTags(html);
    const head = tags.find((t) => t.cls.split(' ').includes('opp-head'));
    expect(head?.rowIndex).toBe('1');
    const body = tags.filter((t) => t.id !== null);
    expect(body).toHaveLength(rows.length);
    for (const t of body) expect(t.rowIndex).toBe(String(Number(/^opprow-(\d+)$/.exec(t.id!)![1]) + 2));
    for (const kind of ['opp-group', 'opp-item', 'opp-more']) expect(body.some((t) => t.cls.split(' ').includes(kind))).toBe(true);
    expect(tags.every((t) => t.rowIndex !== null)).toBe(true);
    expect((html.match(/\baria-rowindex="/g) ?? []).length).toBe((html.match(/\brole="row"/g) ?? []).length);
  });

  it('a long list renders only some rows, and every one of them still carries its position', () => {
    const rows = flattenGroups(
      Array.from({ length: 3000 }, (_, i) => group(`g${i}`, 1, 1)),
      new Set(Array.from({ length: 3000 }, (_, i) => `g${i}`)),
    );
    const html = renderToString(createElement(OppTable, props(rows)));
    expect(html).toContain('aria-rowcount="3001"');
    const tags = rowTags(html);
    expect(tags.length).toBeLessThan(3001);
    expect(tags.every((t) => t.rowIndex !== null)).toBe(true);
  });

  it('scrolled deep into the list, row 400 says 402 (the header is 1)', async () => {
    const rows = flattenGroups(
      Array.from({ length: 3000 }, (_, i) => group(`g${i}`, 1, 1)),
      new Set(Array.from({ length: 3000 }, (_, i) => `g${i}`)),
    );
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    act(() => root.render(createElement(OppTable, props(rows))));
    unmounts.push(() => {
      act(() => root.unmount());
      doc.body.removeChild(container);
    });
    const grid = container.descendants().find((e) => e.getAttribute('role') === 'grid') as ShimElement;
    grid.scrollTop = 400 * ROW_H;
    act(() => {
      grid.dispatchEvent(new ShimEvent('scroll'));
    });
    // The scroll handler reads the position on the next animation frame.
    await act(() => new Promise<void>((r) => setTimeout(r, 0)));
    expect(container.descendants().some((e) => e.id === 'opprow-0')).toBe(false);
    const deep = container.descendants().find((e) => e.id === 'opprow-400');
    expect(deep?.getAttribute('aria-rowindex')).toBe('402');
  });
});
