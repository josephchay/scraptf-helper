// Audit rpagesB-2: the Journal page's Holding stat and "Still holding" Cost column value each open
// lot at today's key price from its own keys and metal (positionCostAt, lotCostAt per lot), exactly
// as Holdings does. The stored JournalPosition.costScrap is valued at each buy row's own key price;
// split at today's key price it read "1 key 58.00 ref" for a lot bought for 2 keys, while Holdings
// and the trade list said "2 keys". The page part renders with react-dom/client into the minimal
// DOM in domShim.ts, with the browser mock as the bridge. Nothing leaves the process.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { fmtMoney } from '../../src/renderer/format';
import { journalSummary } from '../../src/service/domain/journal';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { holdingRow, positionCostAt } from '../../src/shared/holdings';
import type { JournalEntry } from '../../src/shared/types';
import { installDomShim, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

const buy = (id: number, keys: number, scrap: number, keyPriceScrap: number, sku = '5021;6'): JournalEntry => ({
  id,
  ts: id,
  side: 'buy',
  venue: 'scrap.tf',
  sku,
  name: 'X',
  keys,
  scrap,
  keyPriceScrap,
  note: null,
});

describe('positionCostAt (audit rpagesB-2)', () => {
  it('values a key-paid lot in keys at today’s key price, whatever the key price was when bought', () => {
    const pos = journalSummary([buy(1, 2, 0, 540)]).open[0]!;
    expect(pos.costScrap).toBe(1080);
    // The bug: the buy-time total split at today's key price.
    expect(fmtMoney(pos.costScrap, 558)).toBe('1 key 58.00 ref');
    expect(positionCostAt(pos, 558)).toBe(1116);
    expect(fmtMoney(positionCostAt(pos, 558), 558)).toBe('2 keys');
    expect(fmtMoney(positionCostAt(pos, 530), 530)).toBe('2 keys');
    // No key price yet: the buy-time cost.
    expect(positionCostAt(pos, null)).toBe(1080);
  });

  it('is the cost Holdings shows for the same position', () => {
    const pos = journalSummary([buy(1, 2, 0, 540), buy(2, 0, 270, 540)]).open[0]!;
    expect(pos.qty).toBe(2);
    expect(positionCostAt(pos, 558)).toBe(1116 + 270);
    expect(holdingRow(pos, 'hats', null, DEFAULT_SETTINGS.profit, 558).costScrap).toBe(positionCostAt(pos, 558));
    expect(holdingRow(pos, 'hats', null, DEFAULT_SETTINGS.profit, null).costScrap).toBe(positionCostAt(pos, null));
  });

  it('keeps the stored total when the lots do not match qty', () => {
    const pos = { sku: 'a', name: 'A', qty: 2, costScrap: 30, lots: [] };
    expect(positionCostAt(pos, 558)).toBe(30);
    expect(positionCostAt({ ...pos, lots: journalSummary([buy(1, 2, 0, 540)]).open[0]!.lots }, 558)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let JournalPage: () => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  // Before react-dom loads: it checks for a DOM once, at import.
  doc = installDomShim();
  win()['location'] = { hash: '#/journal' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ JournalPage } = await import('../../src/renderer/pages/JournalPage'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

const cls = (e: ShimElement) => e.getAttribute('class') ?? '';

describe('Journal page holding cost (audit rpagesB-2)', () => {
  it('shows key-paid holdings in whole keys at today’s key price, matching Holdings, ordered by that cost', async () => {
    const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
    // The mock's seeded journal paid its keys at 568; today's key price moves to 558.
    const KEY = 558;
    await b.rpc('settings.set', { keyPrice: { mode: 'manual', manualScrap: KEY } });
    win()['flipdesk'] = b;
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    act(() => root.render(createElement(AppProvider, null, createElement(JournalPage))));
    unmounts.push(() => {
      act(() => root.unmount());
      doc.body.removeChild(container);
    });
    await settle();

    const holdings = await b.rpc('holdings.list', {});
    const expected = [...holdings.rows].sort((x, y) => y.costScrap - x.costScrap || x.sku.localeCompare(y.sku));
    expect(expected.length).toBeGreaterThan(1);

    const section = container.descendants().find((e) => e.tagName === 'SECTION' && e.getAttribute('aria-labelledby') === 'open-title')!;
    const rows = section.descendants().filter((e) => e.tagName === 'TR' && (e.parentNode as ShimElement | null)?.tagName === 'TBODY');
    expect(rows).toHaveLength(expected.length);
    rows.forEach((tr, i) => {
      const cells = tr.descendants().filter((e) => e.tagName === 'TD');
      expect(cells[0]!.textContent).toContain(expected[i]!.name);
      expect(cells[2]!.textContent).toBe(fmtMoney(expected[i]!.costScrap, KEY));
    });
    // Bought for 2 and 21 keys: whole keys, not a key-and-ref split.
    const costOf = (name: string) => rows.find((tr) => tr.textContent.includes(name))!.descendants().filter((e) => e.tagName === 'TD')[2]!.textContent;
    expect(costOf('Earbuds')).toBe('2 keys');
    expect(costOf('Isotope Dark Falkirk Helm')).toBe('21 keys');

    const stat = container.descendants().find((e) => cls(e).split(' ').includes('stat') && e.descendants().some((c) => cls(c) === 'stat-label' && c.textContent === 'Holding'))!;
    const money = stat.descendants().find((e) => cls(e).split(' ').includes('money'))!;
    expect(money.textContent).toBe(fmtMoney(holdings.totals.costScrap, KEY));
  });
});
