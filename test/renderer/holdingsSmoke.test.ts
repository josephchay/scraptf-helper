// F11 Holdings, rendered server-side (no DOM, so effects do not run): catches a
// render that throws, and checks what the page, the header totals and the
// empty state put on screen, with real totals from the in-memory browser mock.
// No network.

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { holdingsResult } from '../../src/shared/holdings';
import { AppProvider } from '../../src/renderer/hooks/appContext';
import { createMockBridge } from '../../src/renderer/mock';
import { HoldingsPage, HoldingsTotals, NothingHeld } from '../../src/renderer/pages/HoldingsPage';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const strip = (html: string) => html.replace(/<!-- -->/g, '');

describe('HoldingsPage first render', () => {
  it('shows the totals, the search, the Journal link and Export CSV while loading', () => {
    const html = strip(renderToString(createElement(AppProvider, null, createElement(HoldingsPage))));
    expect(html).toContain('aria-label="Totals over everything you hold"');
    for (const label of ['Holding', 'Cost', 'Worth now', 'Unrealised P/L', 'Sellable now']) expect(html).toContain(`<div class="stat-label">${label}</div>`);
    expect(html).toContain('aria-label="Search your holdings"');
    expect(html).toContain('Loading your holdings');
    expect(html).toContain('Export CSV');
    expect(html).toContain('Journal');
    expect(html).toContain('the app never sends offers');
  });
});

describe('HoldingsTotals', () => {
  it('shows items, units, cost, worth, the P/L in its tone and the sellable count, from the mock', async () => {
    const b = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
    try {
      const res = await b.rpc('holdings.list', {});
      const t = res.totals;
      expect(t.items).toBeGreaterThan(0);
      const html = strip(renderToString(createElement(HoldingsTotals, { data: res, keyScrap: 568, profit: DEFAULT_SETTINGS.profit })));
      expect(html).toContain(t.units === t.items ? `${t.items} items` : `${t.items} items (${t.units} units)`);
      expect(html).toContain(`>${t.sellable}</span> <span class="muted small">of ${t.items}</span>`);
      expect(html).toContain(t.profitNowScrap > 0 ? 'holdings-pl tone-good' : t.profitNowScrap < 0 ? 'holdings-pl tone-bad' : 'holdings-pl');
      expect(html).toContain(t.profitNowScrap > 0 ? 'money pos' : 'money');
      expect(html).toContain('holdings-sellable tone-good');
    } finally {
      b.dispose();
    }
  });

  it('shows dashes before the first answer, and no tone at zero', () => {
    const empty = strip(renderToString(createElement(HoldingsTotals, { data: null, keyScrap: null, profit: null })));
    expect(empty.match(/<div class="stat-value">—<\/div>/g)).toHaveLength(5);
    const zero = strip(renderToString(createElement(HoldingsTotals, { data: holdingsResult([], {}, null, T0), keyScrap: 568, profit: null })));
    expect(zero).toContain('0 items');
    expect(zero).not.toContain('tone-good');
    expect(zero).not.toContain('tone-bad');
  });
});

describe('NothingHeld', () => {
  it('explains how to record a buy, with the Journal and quick entry as the ways in', () => {
    const html = strip(renderToString(createElement(AppProvider, null, createElement(NothingHeld))));
    expect(html).toContain('Nothing held');
    expect(html).toContain('When you buy an item on scrap.tf, record it (Quick entry → <em>Bought it</em>, the item panel → <em>Record buy</em>, or Journal)');
    expect(html).toContain('shows here with live');
    expect(html).toContain('Open Journal');
    expect(html).toContain('Quick entry');
  });
});
