// F11 Holdings page: the wiring checked statically (nav entry right after the
// Shopping list, route, title, icon; the only app methods the page and the
// Record trade dialog call; the live refetch; the stylesheet's tokens and
// reduced motion), then the table rendered with react-dom/client into the
// minimal DOM in domShim.ts, against rows from the browser mock: order, status
// pills, the row keys, and the row buttons. No network.

import { readFileSync } from 'node:fs';
import { act, createElement, useState, type ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HoldingsTableProps } from '../../src/renderer/pages/HoldingsPage';
import { createMockBridge } from '../../src/renderer/mock';
import { MAIN_METHODS, SERVICE_METHODS } from '../../src/shared/rpc';
import type { HoldingRow } from '../../src/shared/types';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

describe('navigation', () => {
  const app = read('App.tsx');

  it('lists Holdings right after the Shopping list, once', () => {
    const ids = [...app.matchAll(/\{ id: '([a-z]+)', label: '([^']+)', icon: '([A-Za-z]+)' \}/g)].map((m) => [m[1], m[2], m[3]]);
    const at = ids.findIndex(([id]) => id === 'shopping');
    expect(ids[at + 1]).toEqual(['holdings', 'Holdings', 'holdings']);
    expect(ids.filter(([id]) => id === 'holdings')).toHaveLength(1);
  });

  it('routes and titles the page, with its own icon', () => {
    expect(app).toMatch(/type RouteId = [^;]*'holdings'/);
    expect(app).toMatch(/holdings: 'Holdings',/);
    expect(app).toMatch(/case 'holdings':\s*return <HoldingsPage \/>;/);
    expect(read('components/Icon.tsx')).toMatch(/\n {2}holdings: \(/);
  });
});

describe('the page', () => {
  const page = read('pages/HoldingsPage.tsx');

  it('reads holdings.list, exports through opps.exportCsv and opens quick entry: no new traffic', () => {
    const methods = new Set([...page.matchAll(/rpc\('([a-zA-Z.]+)'/g)].map((m) => m[1]));
    expect([...methods].sort()).toEqual(['app.showQuickEntry', 'opps.exportCsv']);
    expect(page).toContain("useRpcQuery('holdings.list', query)");
    for (const m of [...methods, 'holdings.list']) expect([...SERVICE_METHODS, ...MAIN_METHODS]).toContain(m);
    expect(page).toContain("kind: 'holdings'");
    expect(page).toContain('saveCsv(');
    expect(page).not.toMatch(/https?:\/\//);
    expect(page).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket/);
  });

  it("opens the buyer's profile only through links.open (openOrCopy), built from the SteamID64", () => {
    expect(page).toContain('openOrCopy(url, toastRef.current)');
    expect(page).toContain('buyerProfileUrl(r)');
  });

  it('refetches on market.changed throttled to 2 s while shown, and on journal and price changes', () => {
    expect(page).toMatch(/const reload = useThrottled\(\(\) => void list\.reload\(\), 2000\);/);
    expect(page).toContain("useVisiblePush('market.changed', reload)");
    expect(page).toContain("useVisiblePush('prices.changed', reload)");
    expect(page).toContain("useVisiblePush('journal.changed', reloadSoon)");
  });

  it('refetches on scraptf.listChanged: a saved list or its 30-day purge moves scrap.tf exits (F14)', () => {
    expect(page).toContain("useVisiblePush('scraptf.listChanged', reload)");
  });

  it('refetches when a scrap.tf exit turns a day old, which no push announces (UI-2)', () => {
    expect(page).toContain('useScraptfExitLapse(data?.rows, list.reload);');
    expect(page).toContain('scraptfLapseDelay(lapseAt, now)');
  });

  it('refetches when the profit thresholds or the blocklist change (status and Pay up to follow them)', () => {
    expect(page).toMatch(/useEffect\(\(\) => \{\s*if \(!profitSettings\) return;\s*if \(settingsSeen\.current\) reloadSoon\(\);/);
    expect(page).toContain('}, [profitSettings, blocklist, reloadSoon]);');
  });

  it('answers the buyer key on a row without a buyer profile, instead of doing nothing', () => {
    expect(page).toContain("else toastRef.current(noBuyerProfileText(r), 'info');");
  });

  it('records a sale through the Record trade dialog, rendered once', () => {
    expect(page).toContain('const trade = useRecordTrade();');
    // F14: at the key price the rows are valued at (a row without the listed split splits at it), and at the
    // click's time, so a scrap.tf exit that lapsed since the last refetch is not prefilled.
    expect(page).toContain('tradeRef.current(recordSaleInit(r, keyRef.current, Date.now()))');
    expect(page).toContain('keyRef.current = keyScrap;');
    expect(page.match(/\{trade\.element\}/g)).toHaveLength(1);
    expect(page.match(/\{menu\.element\}/g)).toHaveLength(1);
  });

  it('shows the how-to when nothing is held, linking to the Journal', () => {
    expect(page).toContain('title="Nothing held"');
    expect(page).toMatch(/Quick entry → <em>Bought it<\/em>, the item panel → <em>Record buy<\/em>, or Journal/);
    expect(page).toContain("navigate('journal')");
  });
});

describe('the Record trade dialog', () => {
  const dialog = read('components/RecordTradeDialog.tsx');

  it('reads item.detail (no history) and holdings.list, and writes only journal.add / journal.delete', () => {
    const methods = new Set([...dialog.matchAll(/rpc\('([a-zA-Z.]+)'/g)].map((m) => m[1]));
    expect([...methods].sort()).toEqual(['holdings.list', 'item.detail', 'journal.add', 'journal.delete']);
    expect(dialog).toContain("rpc('item.detail', detailParams(init.sku))");
    expect(dialog).not.toMatch(/https?:\/\//);
    expect(dialog).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket/);
  });

  it('is a labelled modal, and its toast offers Undo', () => {
    expect(dialog).toMatch(/role="dialog" aria-modal="true" aria-labelledby=\{ids\.title\}/);
    expect(dialog).toContain("{ action: { label: 'Undo', onClick: undo } }");
  });
});

describe('the Journal page', () => {
  it("refreshes on 'journal.changed'", () => {
    const journal = read('pages/JournalPage.tsx');
    expect(journal).toContain("useVisiblePush('journal.changed', reload)");
  });

  it('links to Holdings beside the "Still holding" heading, not inside it (the section keeps its name)', () => {
    const journal = read('pages/JournalPage.tsx');
    expect(journal).toContain('<h2 id="open-title">Still holding</h2>');
    expect(journal).toContain("onClick={() => navigate('holdings')}");
  });
});

describe('holdings.css', () => {
  const css = readFileSync(new URL('../../src/renderer/styles/holdings.css', import.meta.url), 'utf8');

  it('takes every colour from the tokens', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\brgba?\(/);
  });

  it('turns the flash animation off for reduced motion', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.holding-row\.flash-up,\s*\.holding-row\.flash-down\s*\{\s*animation: none !important;/);
  });

  it('is imported after every earlier sheet by index.css (only the F14 price-list, F15 banks, F16 live check, F17 bank stock and F20 history sheets follow it)', () => {
    const index = read('styles/index.css').trim().split('\n');
    expect(index[index.length - 1]).toBe("@import './scraptf-history.css';");
    expect(index[index.length - 2]).toBe("@import './bank-stock.css';");
    expect(index[index.length - 3]).toBe("@import './check.css';");
    expect(index[index.length - 4]).toBe("@import './banks.css';");
    expect(index[index.length - 5]).toBe("@import './scraptf-list.css';");
    expect(index[index.length - 6]).toBe("@import './holdings.css';");
  });
});

// ---------------------------------------------------------------------------
// The table, rendered
// ---------------------------------------------------------------------------

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let HoldingsTable: typeof import('../../src/renderer/pages/HoldingsPage').HoldingsTable;
let rows: HoldingRow[];

beforeAll(async () => {
  // Before react-dom loads: it checks for a DOM once, at import.
  doc = installDomShim();
  ({ createRoot } = await import('react-dom/client'));
  ({ HoldingsTable } = await import('../../src/renderer/pages/HoldingsPage'));
  const bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  rows = (await bridge.rpc('holdings.list', {})).rows;
  bridge.dispose();
});

const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
});

function mount(list: HoldingRow[], flash: HoldingsTableProps['flash'] = { seq: 0, dirs: new Map() }) {
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const calls = { open: vi.fn(), menu: vi.fn(), sale: vi.fn(), buyer: vi.fn() };
  const state = { selected: null as string | null };
  function Harness(): ReactElement {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    state.selected = selectedId;
    const props: HoldingsTableProps = {
      rows: list,
      keyScrap: 568,
      now: T0,
      density: 'comfortable',
      profit: null,
      selectedId,
      flash,
      onSelect: setSelectedId,
      onOpen: calls.open,
      onMenu: calls.menu,
      onRecordSale: calls.sale,
      onOpenBuyer: calls.buyer,
    };
    return createElement(HoldingsTable, props);
  }
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(Harness)));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  const all = () => container.descendants();
  const grid = all().find((e) => e.getAttribute('role') === 'grid') as ShimElement;
  const fire = (target: ShimElement, type: string, init: Record<string, unknown> = {}) =>
    act(() => {
      target.dispatchEvent(new ShimEvent(type, init));
    });
  const rowEls = () => all().filter((e) => e.getAttribute('role') === 'row' && (e.getAttribute('class') ?? '').includes('holding-row'));
  return {
    calls,
    state,
    grid,
    rowEls,
    fire,
    key: (key: string, more: Record<string, unknown> = {}) => fire(grid, 'keydown', { bubbles: true, cancelable: true, key, ...more }),
    buttonsIn: (el: ShimElement) => el.descendants().filter((e) => e.tagName === 'BUTTON'),
  };
}

describe('HoldingsTable', () => {
  it('lists every holding sell first, with its status pill and the buyer', () => {
    const t = mount(rows);
    const els = t.rowEls();
    expect(els).toHaveLength(rows.length);
    expect(els.map((e) => e.getAttribute('id'))).toEqual(rows.map((_, i) => `holdrow-${i}`));
    expect(els[0]!.getAttribute('class')).toContain('status-sell');
    const heads = t.grid.descendants().filter((e) => e.getAttribute('role') === 'columnheader');
    expect(heads.map((h) => h.textContent)).toEqual(['Item', 'Qty', 'Your cost', 'Held for', 'Sells now for', 'Buyers', 'Profit now', 'Confidence', 'Updated', 'Actions']);
    const pills = els.map((e) => e.descendants().find((d) => (d.getAttribute('class') ?? '').includes('holding-pill'))!.textContent);
    expect(new Set(pills)).toEqual(new Set(['Sell now', 'Hold', 'Loss', 'No buyers']));
    const sell = els[0]!;
    expect(sell.textContent).toContain(rows[0]!.name);
    expect(sell.textContent).toContain('Record sale…');
  });

  it('moves with j/k and acts on the selected row: Enter opens, s records a sale, b opens the buyer, Shift+F10 the menu', () => {
    const t = mount(rows);
    t.fire(t.grid, 'focusin', { bubbles: true });
    expect(t.state.selected).toBe(rows[0]!.sku);
    t.key('j');
    expect(t.state.selected).toBe(rows[1]!.sku);
    t.key('k');
    expect(t.state.selected).toBe(rows[0]!.sku);
    t.key('Enter');
    expect(t.calls.open).toHaveBeenCalledWith(rows[0]);
    t.key('s');
    expect(t.calls.sale).toHaveBeenCalledWith(rows[0]);
    t.key('b');
    expect(t.calls.buyer).toHaveBeenCalledWith(rows[0]);
    t.key('s', { ctrlKey: true });
    expect(t.calls.sale).toHaveBeenCalledTimes(1);
    t.key('F10', { shiftKey: true });
    expect(t.calls.menu).toHaveBeenCalledTimes(1);
    expect(t.calls.menu.mock.calls[0]![0]).toBe(rows[0]);
    t.key('End');
    expect(t.state.selected).toBe(rows[rows.length - 1]!.sku);
  });

  it("the row's Record sale and buyer buttons act on that row without opening the drawer", () => {
    const t = mount(rows);
    const i = rows.findIndex((r) => r.revenueOrder !== null && r.status !== 'sell');
    expect(i).toBeGreaterThan(0);
    const el = t.rowEls()[i]!;
    const [buyer, sale] = t.buttonsIn(el);
    expect(buyer!.getAttribute('class')).toContain('buyer-link');
    expect(sale!.textContent).toBe('Record sale…');
    t.fire(sale!, 'click', { bubbles: true });
    expect(t.calls.sale).toHaveBeenCalledWith(rows[i]);
    expect(t.state.selected).toBe(rows[i]!.sku);
    t.fire(buyer!, 'click', { bubbles: true });
    expect(t.calls.buyer).toHaveBeenCalledWith(rows[i]);
    expect(t.calls.open).not.toHaveBeenCalled();
    t.fire(el, 'click', { bubbles: true });
    expect(t.calls.open).toHaveBeenCalledWith(rows[i]);
  });

  it('a row without a buyer has no buyer link, only Record sale', () => {
    const t = mount(rows);
    const i = rows.findIndex((r) => r.status === 'no-buyers');
    expect(t.buttonsIn(t.rowEls()[i]!).map((b) => b.textContent)).toEqual(['Record sale…']);
  });

  it('flashes the rows whose profit moved, with an arrow', () => {
    const t = mount(rows, { seq: 1, dirs: new Map([[rows[0]!.sku, 'up']]) });
    const [first, second] = t.rowEls();
    expect(first!.getAttribute('class')).toMatch(/flash-up flash-b/);
    expect(first!.descendants().some((d) => (d.getAttribute('class') ?? '').includes('flash-arrow'))).toBe(true);
    expect(second!.getAttribute('class')).not.toMatch(/flash-/);
  });
});
