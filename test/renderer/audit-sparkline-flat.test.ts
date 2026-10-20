// Audit rcomponents-3: the drawer's PriceDB "Price history" sparkline padded a flat series by one
// scrap each way to draw it, then showed the padded bounds as the range: "4.33 ref – 4.55 ref" for
// a constant 4.44 ref, and "-0.11 ref – 0.11 ref" for 0. Only the y scale is padded now, and a
// flat history reads as its one value (as the F20 scrap.tf history chart does).

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Sparkline } from '../../src/renderer/components/Sparkline';
import { fmtMoney } from '../../src/renderer/format';
import type { HistoryPoint } from '../../src/shared/types';

const KEY = 600;
const series = (n: number, buy: number | null, sell: number | null): HistoryPoint[] =>
  Array.from({ length: n }, (_, i) => ({ t: 1_700_000_000 + i * 86_400, buyScrap: buy, sellScrap: sell }));

function render(history: HistoryPoint[]) {
  const html = renderToStaticMarkup(createElement(Sparkline, { history, keyScrap: KEY }));
  const caption = /<figcaption[^>]*><span>[^<]*<\/span><span>([^<]*)<\/span>/.exec(html)?.[1];
  const label = /<svg[^>]*aria-label="([^"]*)"/.exec(html)?.[1];
  const ys = [...html.matchAll(/<path d="([^"]*)"/g)].flatMap((m) => [...m[1]!.matchAll(/[ML][\d.-]+,([^ML]+)/g)].map((p) => p[1]!));
  const grid = [...html.matchAll(/<line[^>]*y1="([^"]+)"[^>]*class="spark-grid"/g)].map((m) => m[1]);
  return { html, caption, label, ys, grid };
}

describe('PriceDB sparkline over a flat history', () => {
  it('shows the one price, not a padded range that never happened', () => {
    const r = render(series(3, 40, 40));
    expect(r.caption).toBe(fmtMoney(40, KEY));
    expect(r.caption).toBe('4.44 ref');
    expect(r.label).toMatch(/, at 4\.44 ref$/);
    for (const bad of ['4.33 ref', '4.55 ref', 'between']) expect(r.html).not.toContain(bad);
  });

  it('never shows a negative price for a flat 0', () => {
    const r = render(series(2, 0, 0));
    expect(r.caption).toBe(fmtMoney(0, KEY));
    expect(r.label).toMatch(new RegExp(`, at ${fmtMoney(0, KEY).replace(/[.]/g, '\\.')}$`));
    expect(r.html).not.toContain('-0.11');
    expect(r.html).not.toMatch(/-[\d.,]+ (ref|keys?)/);
  });

  it('reads a buy-only constant history the same way', () => {
    const r = render(series(2, 40, null));
    expect(r.caption).toBe('4.44 ref');
    expect(r.label).toMatch(/, at 4\.44 ref$/);
  });

  it('still draws the flat line mid-chart between the grid lines', () => {
    const r = render(series(3, 40, 40));
    expect(r.ys.length).toBeGreaterThan(0);
    for (const y of r.ys) expect(y).toBe('45.0');
    expect(r.grid).toEqual(['8', '82']);
  });
});

describe('PriceDB sparkline over a moving history (unchanged)', () => {
  it('shows the low – high range and spans the chart', () => {
    const r = render(series(3, 36, 40));
    expect(r.caption).toBe(`${fmtMoney(36, KEY)} – ${fmtMoney(40, KEY)}`);
    expect(r.label).toContain(`, between ${fmtMoney(36, KEY)} and ${fmtMoney(40, KEY)}`);
    expect(new Set(r.ys)).toEqual(new Set(['8.0', '82.0']));
    expect(r.grid).toEqual(['8', '82']);
  });
});
