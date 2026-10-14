// Saved pages are untrusted: no regex in the parser may take super-linear time
// on a crafted title, style attribute, item name or page address. The parse runs
// synchronously in the service process, so a slow regex freezes every RPC and
// the live feed (and the folder watch would retry the file after a restart).

import { describe, expect, it } from 'vitest';
import { cssColorToHex, pageKindFromUrl, parseScrapTfHtml } from '../../src/service/import';
import { createStubSchema } from './schemaStub';

const CANONICAL_BUY = '<link rel="canonical" href="https://scrap.tf/buy/hats">';
const card = (title: string, inner = '') =>
  `<div class="item hoverable quality6 rarity app440" data-appid="440" data-defindex="126" data-quality="6" data-title="${title}" data-content="Level 1" data-item-value="9">${inner}</div>`;
const page = (title: string, body: string, head = '') => `<!DOCTYPE html><html><head><title>${title}</title>${head}</head><body>${body}</body></html>`;

/** Parse time in ms (the old regexes took seconds to hours on these inputs). */
function timed(html: string): { ms: number; result: ReturnType<typeof parseScrapTfHtml> } {
  const schema = createStubSchema();
  const t = performance.now();
  const result = parseScrapTfHtml(html, schema);
  return { ms: performance.now() - t, result };
}

describe('parser time stays linear on crafted pages', () => {
  it('a huge <title> full of keywords without "trading" (was quadratic: 200 KB took ~6 s)', () => {
    const { ms, result } = timed(page(`scrap.tf ${'hat '.repeat(250_000)}`, card('Bill&#39;s Hat')));
    expect(ms).toBeLessThan(1_500);
    expect(result.pageKind).toBe('unknown');
  });

  it('still guesses a buy page from a normal title', () => {
    const { result } = timed(page('Hats - Scrap.TF Hat Trading', card('Bill&#39;s Hat')));
    expect(result.pageKind).toBe('buy');
    expect(timed(page('Scrap.TF - Weapons Bank', card('Bill&#39;s Hat'))).result.pageKind).toBe('buy');
    expect(timed(page('Scrap.TF - trading hats', card('Bill&#39;s Hat'))).result.pageKind).toBe('unknown');
  });

  it('a paintcolor style of unclosed url( or a long run of spaces inside rgb( (was quadratic)', () => {
    const urls = timed(page('x', card('Bill&#39;s Hat', `<div class="paintcolor" style="background: ${'url('.repeat(250_000)}"></div>`), CANONICAL_BUY));
    expect(urls.ms).toBeLessThan(1_500);
    const spaces = timed(page('x', card('Bill&#39;s Hat', `<div class="paintcolor" style="background: rgb(1${' '.repeat(1_000_000)}x"></div>`), CANONICAL_BUY));
    expect(spaces.ms).toBeLessThan(1_500);
  });

  it('keeps reading real paint colours', () => {
    expect(cssColorToHex('rgb(125, 64, 113)')).toBe('#7d4071');
    expect(cssColorToHex('rgb(125 64 113)')).toBe('#7d4071');
    expect(cssColorToHex('rgb(1  2  3)')).toBe('#010203');
    expect(cssColorToHex('rgba(37,109,141,0.5)')).toBe('#256d8d');
    expect(cssColorToHex('rgb( 50% ,0%, 100% )')).toBe('#7f00ff');
    const painted = timed(page('x', card('Bill&#39;s Hat', '<div class="paintcolor" style="background: url(x.png) no-repeat, #7D4071;"></div>'), CANONICAL_BUY));
    expect(painted.result.items[0]?.special.paint).toBe(8208497); // url(...) is stripped, the colour after it is read
  });

  it('item names of unclosed quotes, in cards and in /items rows (was quadratic: ~2.5 s per card)', () => {
    const cards = timed(page('x', card('“'.repeat(60_000)).repeat(5), CANONICAL_BUY));
    expect(cards.ms).toBeLessThan(1_500);
    const row = `<table><tr><th>Item</th><th>Price to buy</th></tr><tr data-quality="6" data-defindex="126"><td>${'“'.repeat(1_000_000)}</td><td>1 ref</td></tr></table>`;
    const rows = timed(page('x', row, '<link rel="canonical" href="https://scrap.tf/items">'));
    expect(rows.ms).toBeLessThan(1_500);
  });

  it('still reads a quoted custom name', () => {
    const { result } = timed(page('x', card('&quot;My Lucky Hat&quot; Bill&#39;s Hat'), CANONICAL_BUY));
    expect(result.items[0]?.special.customName).toBe(true);
    expect(result.items[0]?.sku).toBe('126;6');
  });

  it('ignores absurdly long or deeply nested archive addresses instead of recursing on them', () => {
    const nested = `${'https://web.archive.org/web/1/'.repeat(20_000)}https://scrap.tf/buy/hats`;
    const t = performance.now();
    expect(pageKindFromUrl(nested)).toBeNull();
    expect(performance.now() - t).toBeLessThan(100);
    // One level of archive.org nesting still works.
    expect(pageKindFromUrl('https://web.archive.org/web/20240101000000/https://scrap.tf/buy/hats')).toMatchObject({ kind: 'buy', scrapTf: true });
  });
});
