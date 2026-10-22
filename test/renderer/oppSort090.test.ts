// 0.9 (#3): Opportunities sort by "If this buyer leaves" ('backup') and "Buyers at break-even" ('depth'). The
// renderer's compareOpps (the mock's opps.list and the page's group pages) orders them as the repo's SQL does: missing
// last in both directions, ties by profit (descending, missing last), then name, then key. The page gains a Sort select
// (the keys have no column), the Buyers hover and the drawer's line carry the figures (D11), and no column is added.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { openRepo } from '../../src/service/db';
import type { Repo } from '../../src/service/contracts';
import { OPP_SORTS, type Opportunity } from '../../src/shared/types';
import { OPP_SORT_HELP, OPP_SORT_LABELS, compareOpps, defaultDir, sortOpportunities } from '../../src/renderer/oppModel';
import { makeOpp } from '../db/helpers';

const src = (path: string): string => readFileSync(new URL(`../../src/renderer/${path}`, import.meta.url), 'utf8');

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** One opportunity per price id, so each has its own key. */
const opp = (id: number, over: Partial<Opportunity>): Opportunity => makeOpp({ inputRef: `price:${id}`, ...over });
const ids = (rows: readonly Opportunity[]) => rows.map((o) => o.inputRef);

function seed(field: 'backupProfitScrap' | 'profitableDepth'): Opportunity[] {
  const v = (x: number | null): Partial<Opportunity> => (x === null ? {} : { [field]: x });
  return [
    opp(1, { name: 'Alpha', profitScrap: 80, ...v(5) }),
    opp(2, { name: 'Bravo', profitScrap: 90, ...v(5) }),
    opp(3, { name: 'Charlie', profitScrap: 100, ...v(null) }),
    opp(4, { name: 'Delta', profitScrap: 20, ...v(1) }),
    opp(5, { name: 'echo', profitScrap: 90, ...v(5) }),
    opp(6, { name: 'Foxtrot', profitScrap: null, ...v(null) }),
    opp(7, { name: 'Bravo', profitScrap: 90, ...v(5) }),
    opp(8, { name: 'Golf', profitScrap: null, ...v(5) }),
    // A negative "if this buyer leaves" (or a depth of 0) is a value, not a missing one.
    opp(9, { name: 'Hotel', profitScrap: 10, ...v(field === 'backupProfitScrap' ? -25 : 0) }),
  ];
}

describe("0.9 (#3): compareOpps for 'backup' and 'depth'", () => {
  for (const [sort, field] of [
    ['backup', 'backupProfitScrap'],
    ['depth', 'profitableDepth'],
  ] as const) {
    it(`'${sort}': missing last in both directions; ties by profit (missing last), then name, then key`, () => {
      const rows = seed(field);
      expect(ids(sortOpportunities(rows, sort, 'desc'))).toEqual(['price:2', 'price:7', 'price:5', 'price:1', 'price:8', 'price:4', 'price:9', 'price:3', 'price:6']);
      expect(ids(sortOpportunities(rows, sort, 'asc'))).toEqual(['price:9', 'price:4', 'price:2', 'price:7', 'price:5', 'price:1', 'price:8', 'price:3', 'price:6']);
      expect(defaultDir(sort)).toBe('desc');
    });

    it(`'${sort}': the same order as the repo's SQL (OPP_SORT, oppOrder)`, () => {
      const r: Repo = openRepo(':memory:');
      cleanups.push(() => r.close());
      const rows = seed(field);
      r.upsertOpportunities(rows);
      for (const dir of ['asc', 'desc'] as const) expect(ids(sortOpportunities(rows, sort, dir)), dir).toEqual(ids(r.queryOpportunities({ sort, dir })));
    });
  }

  it('leaves the other keys as they were (no profit tie of their own)', () => {
    const rows = seed('backupProfitScrap');
    const byName = [...rows].sort(compareOpps('name', 'asc'));
    expect(ids(byName)).toEqual(['price:1', 'price:2', 'price:7', 'price:3', 'price:4', 'price:5', 'price:6', 'price:8', 'price:9']);
    // margin ties (every makeOpp margin is the same): name, then key, never profit.
    const a = opp(1, { name: 'Zulu', profitScrap: 999 });
    const b = opp(2, { name: 'Alpha', profitScrap: 1 });
    expect(ids([a, b].sort(compareOpps('margin', 'desc')))).toEqual(['price:2', 'price:1']);
  });
});

describe('0.9 (#3): the Sort select', () => {
  it('labels every OPP_SORTS key, in its order', () => {
    expect(Object.keys(OPP_SORT_LABELS)).toEqual([...OPP_SORTS]);
    expect(OPP_SORT_LABELS.backup).toBe('If this buyer leaves');
    expect(OPP_SORT_LABELS.depth).toBe('Buyers at break-even');
    expect(OPP_SORT_HELP).toContain('Buyer counts show demand, not sales.');
    expect(OPP_SORT_HELP).not.toMatch(/\bchance\b|probabilit|\bwill\b|seen in the last day/i);
  });

  it('OpportunitiesPage sorts by every OPP_SORTS key and renders the select after the toolbar spacer', () => {
    const page = src('pages/OpportunitiesPage.tsx');
    expect(page).toContain('const SORTS: readonly SortKey[] = OPP_SORTS;');
    // sanitizeSort reads SORTS, so a persisted 'backup' or 'depth' restores.
    expect(OPP_SORTS).toContain('backup');
    expect(OPP_SORTS).toContain('depth');
    const sanitize = page.slice(page.indexOf('function sanitizeSort('), page.indexOf('function sanitizeCollapsed('));
    expect(sanitize).toContain("SORTS.includes(o['sort'] as SortKey)");
    const picker = page.slice(page.indexOf('function OppSortPicker('), page.indexOf('export function OpportunitiesPage('));
    expect(picker).toContain('id="opps-sort"');
    expect(picker).toContain('className="market-sort" title={OPP_SORT_HELP}');
    expect(picker).toContain('{SORTS.map((s) => (');
    expect(picker).toContain('{OPP_SORT_LABELS[s]}');
    expect(picker).toContain('onChange({ sort, dir: defaultDir(sort) });');
    const spacer = page.indexOf('<div className="toolbar-spacer" />');
    const use = page.indexOf('<OppSortPicker value={sort} onChange={setSort} />');
    expect(spacer).toBeGreaterThan(0);
    expect(use).toBeGreaterThan(spacer);
    expect(page.indexOf('<Segmented ariaLabel="Group by"')).toBeGreaterThan(use);
  });

  it('adds no column: the Buyers header and cell carry the hover', () => {
    const table = src('components/OppTable.tsx');
    // Review: with the table's useOrder, so the hover names who the depth counts (bot buyers under Instant).
    expect(table).toContain('title={oppBuyersTitle(o, keyScrap, useOrder)}');
    expect(table).toContain('title="Distinct buyers with eligible orders. Hover a value for buyers at break-even and the profit if this buyer leaves."');
    expect(table).not.toContain('k="backup"');
    expect(table).not.toContain('k="depth"');
  });

  it('the Live market hovers carry the figures (no header change)', () => {
    const market = src('pages/MarketPage.tsx');
    // Recheck: with the user's useOrder, so the hovers name who the depth counts (bot buyers under Instant).
    expect(market).toContain('<div role="gridcell" className="m-sells" title={marketSellsTitle(r, keyScrap, undefined, useOrder)}>');
    expect(market).toContain('title={marketRiskTitle(r, keyScrap, useOrder) ?? undefined}');
    expect(market).toContain('useOrder={settings?.profit.useOrder ?? null}');
  });

  it("the drawer's line reads Buyers at break-even (D11), under exits' Break-even and the Next buyer line", () => {
    const drawer = src('pages/ItemDrawer.tsx');
    expect(drawer).toContain('>Buyers at break-even</dt>');
    expect(drawer).toContain('const risk = drawerRiskLine(o, buyOrders, profit, keyScrap);');
    const card = drawer.slice(drawer.indexOf('function InputCard('));
    const be = card.indexOf('<dt>Break-even</dt>');
    const next = card.indexOf('>Next buyer</dt>');
    const risk = card.indexOf('>Buyers at break-even</dt>');
    expect(be).toBeGreaterThan(0);
    expect(next).toBeGreaterThan(be);
    expect(risk).toBeGreaterThan(next);
    expect(card.indexOf('<dt>Confidence</dt>')).toBeGreaterThan(risk);
  });

  it('Settings shows the suggested reserve under the profit grid, as text that never sets the reserve', () => {
    const page = src('pages/SettingsPage.tsx');
    const profit = page.slice(page.indexOf('function ProfitSection('), page.indexOf('function ReserveSuggestionNote('));
    const firstGrid = profit.indexOf('<div className="form-grid three">');
    const note = profit.indexOf('<ReserveSuggestionNote />');
    expect(firstGrid).toBeGreaterThan(0);
    expect(note).toBeGreaterThan(profit.indexOf('htmlFor="p-mptf-fee"'));
    expect(note).toBeLessThan(profit.indexOf('<div className="form-grid two">'));
    const component = page.slice(page.indexOf('function ReserveSuggestionNote('), page.indexOf('export function NotifySection('));
    expect(component).toContain("useRpcQuery('profit.reserveSuggestion', undefined)");
    expect(component).toContain("usePush('journal.changed'");
    expect(component).toContain('reserveSuggestionView(q.data)');
    for (const banned of ['updateSettings', 'exitReservePct', 'settings.set', 'onCommit']) expect(component, banned).not.toContain(banned);
  });
});
