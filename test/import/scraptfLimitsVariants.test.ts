// 0.7.1 (P1): the /items "Item Limits" bar read from the live page. scrap.tf renders n/limit in `title`;
// once its tooltip script has run (a page read in the scrap.tf window after the user hovered the list),
// Bootstrap 3 leaves title="" and keeps it in data-original-title, Bootstrap 5 keeps it in
// data-bs-original-title with no title (or as aria-label). Every variant reads the same stock as the saved
// page; a bar nothing can be read from warns no-stock-limit, and that row is never stored as a price (a
// sold-out row would otherwise read as buyable). Local fixtures only; nothing is fetched.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isImportableItem, parseScrapTfHtml, warningCode } from '../../src/service/import';
import type { ParsedScrapItem } from '../../src/shared/types';
import { createStubSchema } from './schemaStub';

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)), 'utf8');

const ORIGINAL = fixture('items_list.html');
const schema = createStubSchema();
const rowsOf = (html: string) => parseScrapTfHtml(html, schema).items;
/** What a row says about stock, by its title (each row of the fixture names a different item). */
const stockOf = (items: readonly ParsedScrapItem[]) => items.map((i) => [i.title, i.stock, i.stockLimit, i.sku, i.costKeys, i.costScrap]);

describe('the Item Limits bar after its tooltip ran (P1)', () => {
  const original = rowsOf(ORIGINAL);

  it('the saved page itself reads every row (the reference)', () => {
    expect(original).toHaveLength(13);
    expect(original.every((i) => i.stock !== null && i.stockLimit !== null)).toBe(true);
    expect(original.flatMap((i) => i.warnings).map(warningCode)).not.toContain('no-stock-limit');
  });

  it.each(['items_list_bs3.html', 'items_list_bs5.html'])('%s reads the same stock and limit on every row as the saved page', (name) => {
    const html = fixture(name);
    // The variant really moved the attribute: no bar keeps "n/limit" in title.
    expect(html).not.toMatch(/\stitle="\d+\/\d+"/);
    const items = rowsOf(html);
    expect(stockOf(items)).toEqual(stockOf(original));
    const earbuds = items.find((i) => i.title === 'Earbuds')!;
    expect([earbuds.stock, earbuds.stockLimit]).toEqual([0, 5]);
    expect(items.flatMap((i) => i.warnings).map(warningCode)).not.toContain('no-stock-limit');
    // Every row importable on the saved page is importable on the variant, and no more.
    expect(items.map(isImportableItem)).toEqual(original.map(isImportableItem));
  });

  it('reads the bar\'s own numbers when no attribute carries them, never the cell\'s text run together ("4950")', () => {
    const bare = ORIGINAL.replace(/<div rel="tooltip" title="\d+\/\d+"/g, '<div rel="tooltip"');
    expect(bare).not.toMatch(/\stitle="\d+\/\d+"/);
    const items = rowsOf(bare);
    expect(stockOf(items)).toEqual(stockOf(original));
    const key = items.find((i) => i.title === 'Tough Break Key')!;
    expect([key.stock, key.stockLimit]).toEqual([49, 50]);
  });

  it('warns no-stock-limit for a bar nothing can be read from, and that row is no price', () => {
    // The Earbuds bar (sold out, 0/5) with its attribute and numbers gone.
    const earbudsBar = /<div rel="tooltip" title="0\/5"[^\n]*<\/div><\/div><\/div>/;
    const at = ORIGINAL.indexOf('FIXTURE-earbuds');
    const head = ORIGINAL.slice(0, at);
    const tail = ORIGINAL.slice(at).replace(earbudsBar, '<div rel="tooltip" style="position:relative"><div style="width:100%"></div></div>');
    const items = rowsOf(head + tail);
    const earbuds = items.find((i) => i.title === 'Earbuds')!;
    expect(earbuds.stock).toBeNull();
    expect(earbuds.warnings.map(warningCode)).toEqual(['no-stock-limit']);
    expect(isImportableItem(earbuds)).toBe(false);
    // It still has its SKU and both prices: the saved list keeps it, its stock unknown.
    expect(earbuds.sku).toBe('143;6');
    expect(earbuds.pays).not.toBeNull();
    // Every other row is read as before.
    expect(stockOf(items.filter((i) => i.title !== 'Earbuds'))).toEqual(stockOf(original.filter((i) => i.title !== 'Earbuds')));
  });

  it('a list without an Item Limits column warns nothing about stock (as before)', () => {
    const noLimits = ORIGINAL.replace('<th width="200px;">Item Limits</th>', '<th>Notes</th>').replace(/<div rel="tooltip" title="\d+\/\d+"[^\n]*<\/div><\/div><\/div>/g, '');
    const items = rowsOf(noLimits);
    expect(items.every((i) => i.stock === null)).toBe(true);
    expect(items.flatMap((i) => i.warnings).map(warningCode)).not.toContain('no-stock-limit');
  });
});
