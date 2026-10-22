// 0.7.4 (audit: the /items calibration bug, F01, F04, F61): an unmarked scrap.tf/items row is one entry for
// every copy scrap.tf sells at its price (Craftable and Non-Craftable, killstreak and festivized copies), so
// the parser never assumes it is the Craftable copy. The user's own list read keyed "A Distinctive Lack of
// Hue" (5040, 1 key 389 scrap, stock 4) as 5040;6 while /buy/items held only 5040;6;uncraftable at that
// price: a false +52 ref flip. A row is Non-Craftable by its name or an "uncraft" class (as the reference
// helper reads a card), Craftable only beside the item's Non-Craftable row, else 'any' (a family row the
// parser report notes, with its class tokens). Rows that key to one item are collapsed when identical and
// refused when they differ. Real item schema (test/fixtures/pricedb/schema-subset.json); offline.

import { beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { SchemaService } from '../../src/service/contracts';
import { familyRow, isImportableItem, parseScrapTfHtml, warningCode } from '../../src/service/import/scraptfHtml';
import { CRAFT_UNVERIFIED, DUPLICATE_ROW } from '../../src/shared/importCodes';
import { makeDeps, schemaRoute } from '../pricedb/helpers';

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(makeDeps(schemaRoute()));
  await schema.init();
});

interface Row {
  defindex: number;
  name: string;
  price: string;
  stock: string;
  pays?: string;
  quality?: number;
  /** The row's own class (scrap.tf's <tr class>), and its icon's (the <img class="item …">). */
  trClass?: string;
  iconClass?: string;
}

function listPage(rows: readonly Row[]): string {
  const tr = rows
    .map(
      (r) =>
        `<tr${r.trClass ? ` class="${r.trClass}"` : ''} data-quality="${r.quality ?? 6}" data-defindex="${r.defindex}">` +
        `<td><img alt="Icon" class="${r.iconClass ?? `item quality${r.quality ?? 6} rev-banking-background`}"></td>` +
        `<td>${r.name}</td><td>${r.price}</td><td>${r.pays ?? '1 refined'}</td><td><div rel="tooltip" title="${r.stock}"></div></td></tr>`,
    )
    .join('\n');
  return (
    '<!DOCTYPE html><html><head><title>Item Trading - TF2 - Scrap.TF</title><meta property="og:url" content="https://scrap.tf/items" /></head>' +
    '<body id="pid-items"><table><thead><tr><th>Icon</th><th>Item</th><th>Price to buy</th><th>Price we pay</th><th>Item Limits</th></tr></thead>' +
    `<tbody>${tr}</tbody></table></body></html>`
  );
}

const hue = (over: Partial<Row> = {}): Row => ({ defindex: 5040, name: 'A Distinctive Lack of Hue', price: '1 key, 43.22 refined', pays: '1 key, 37 refined', stock: '4/25', ...over });
const parse = (rows: readonly Row[]) => parseScrapTfHtml(listPage(rows), schema, { diagnostics: true });
const codes = (ws: readonly string[]) => ws.map(warningCode);

describe('what an /items row prices (0.7.4)', () => {
  it('keys an unmarked row by its family, proven neither Craftable nor Non-Craftable', () => {
    const r = parse([hue()]);
    expect(r.pageKind).toBe('items-list');
    const [item] = r.items;
    expect(item).toMatchObject({ sku: '5040;6', listCraft: 'any', stock: 4, stockLimit: 25 });
    // A note for the parser report only: it is no warning of the row, and the row stays importable.
    expect(item!.warnings).toEqual([]);
    expect(isImportableItem(item!)).toBe(true);
    expect(familyRow(item!)).toBe(true);
    // The parser report keeps it, with its allowlisted row and icon class tokens (and, review R46, any naming
    // "craft" or a bare "nc"), so a read shows a marker scrap.tf may put on a list row that the parser does not read.
    const rep = r.diagnostics!.items.find((i) => i.sku === '5040;6')!;
    expect(codes(rep.warnings)).toEqual([CRAFT_UNVERIFIED]);
    expect(rep.classTokens).toEqual(expect.arrayContaining(['item', 'quality6']));
  });

  // 0.7.4 (R46): a marker class the parser does not read yet still shows in the report: any class naming
  // "craft", or a bare "nc", on the row or its icon. Other page classes stay out (P4).
  it.each([
    ['the icon', { iconClass: 'item quality6 noncraftable rev-banking-background' }, ['noncraftable']],
    ['the icon, several', { iconClass: 'item quality6 craftable-0 no-craft nc' }, ['craftable-0', 'no-craft', 'nc']],
    ['the row', { trClass: 'nc-row Craft_No' }, ['Craft_No']],
  ])('reports an unread craft marker on %s on a family row', (_, over, kept) => {
    const r = parse([hue(over)]);
    expect(r.items[0]).toMatchObject({ sku: '5040;6', listCraft: 'any' });
    const rep = r.diagnostics!.items.find((i) => i.sku === '5040;6')!;
    expect(codes(rep.warnings)).toEqual([CRAFT_UNVERIFIED]);
    expect(rep.classTokens).toEqual(expect.arrayContaining([...kept, 'item', 'quality6']));
    expect(rep.classTokens).not.toContain('rev-banking-background');
    expect(rep.classTokens).not.toContain('nc-row');
  });

  it('reads "Non-Craftable" in the name as the Non-Craftable copy', () => {
    const [item] = parse([hue({ name: 'Non-Craftable A Distinctive Lack of Hue' })]).items;
    expect(item).toMatchObject({ sku: '5040;6;uncraftable', listCraft: 'uncraftable' });
  });

  it.each([
    ['the icon', { iconClass: 'item quality6 uncraft rev-banking-background' }],
    ['the icon, any token containing it', { iconClass: 'item quality6 is-uncraftable' }],
    ['the row', { trClass: 'uncraft' }],
  ])('reads an "uncraft" class on %s as the Non-Craftable copy, as the reference helper reads a card', (_, over) => {
    const r = parse([hue(over)]);
    expect(r.items[0]).toMatchObject({ sku: '5040;6;uncraftable', listCraft: 'uncraftable', warnings: [] });
    expect(r.diagnostics!.items).toEqual([]);
  });

  it('never reads a class elsewhere in the row (a cell, not the icon) as a mark', () => {
    const html = listPage([hue()]).replace('<td>A Distinctive Lack of Hue</td>', '<td class="uncraft-note">A Distinctive Lack of Hue</td>');
    expect(parseScrapTfHtml(html, schema).items[0]).toMatchObject({ sku: '5040;6', listCraft: 'any' });
  });

  it('proves an unmarked row Craftable when the page also lists the item Non-Craftable, in either order', () => {
    for (const rows of [
      [hue({ price: '2 keys, 20 refined' }), hue({ name: 'Non-Craftable A Distinctive Lack of Hue' })],
      [hue({ name: 'Non-Craftable A Distinctive Lack of Hue' }), hue({ price: '2 keys, 20 refined' })],
    ]) {
      const r = parse(rows);
      expect(r.items.map((i) => [i.sku, i.listCraft])).toEqual(
        expect.arrayContaining([
          ['5040;6', 'craftable'],
          ['5040;6;uncraftable', 'uncraftable'],
        ]),
      );
      expect(r.diagnostics!.items).toEqual([]);
    }
  });

  it("never proves a row by another item's or another quality's Non-Craftable row", () => {
    const r = parse([hue(), { defindex: 126, name: "Non-Craftable Bill's Hat", price: '1 refined', stock: '1/5' }, { defindex: 126, name: "Vintage Bill's Hat", price: '2 refined', stock: '1/5', quality: 3 }]);
    expect(r.items.map((i) => [i.sku, i.listCraft])).toEqual([
      ['5040;6', 'any'],
      ['126;6;uncraftable', 'uncraftable'],
      ['126;3', 'any'],
    ]);
  });
});

describe('rows that key to one item (0.7.4, F04/F61)', () => {
  it('reads an identical repeat once, with no warning', () => {
    const r = parse([hue(), hue()]);
    expect(r.items).toHaveLength(1);
    expect(r.warnings.some((w) => w.startsWith(DUPLICATE_ROW))).toBe(false);
    expect(r.diagnostics!.counts.duplicates).toBe(1);
  });

  it('refuses rows that differ, each with a warning the report keeps, and says so once for the page', () => {
    // scrap.tf's Non-Craftable copy on a row its name does not mark: both key alike, at different prices.
    const r = parse([hue({ price: '2 keys, 20 refined', stock: '3/25' }), hue()]);
    expect(r.items).toHaveLength(2);
    for (const item of r.items) {
      expect(item.sku).toBe('5040;6');
      expect(codes(item.warnings)).toContain(DUPLICATE_ROW);
      expect(isImportableItem(item)).toBe(false);
    }
    expect(r.warnings).toContainEqual(expect.stringMatching(/^duplicate-rows: 2 rows share an item/));
    expect(r.diagnostics!.items.filter((i) => codes(i.warnings).includes(DUPLICATE_ROW))).toHaveLength(2);
  });

  it('no longer collides once the Non-Craftable copy is marked: two items, no warning', () => {
    const r = parse([hue({ price: '2 keys, 20 refined', stock: '3/25' }), hue({ iconClass: 'item quality6 uncraft' })]);
    expect(r.items.map((i) => [i.sku, i.listCraft])).toEqual([
      ['5040;6', 'craftable'],
      ['5040;6;uncraftable', 'uncraftable'],
    ]);
    expect(r.items.every((i) => i.warnings.length === 0)).toBe(true);
  });
});

describe('the parser report (P4) with family rows', () => {
  it('lists every refused row before the family rows, so the cap never drops a refusal', () => {
    // 260 family rows (more than the report holds), then one row whose price cannot be read.
    const rows: Row[] = Array.from({ length: 260 }, (_, i) => ({ defindex: 40_000 + i, name: 'A Distinctive Lack of Hue', price: '1 refined', stock: '1/5' }));
    rows.push(hue({ price: 'a lot' }));
    const r = parse(rows);
    const reps = r.diagnostics!.items;
    expect(reps.length).toBeLessThanOrEqual(200);
    expect(codes(reps[0]!.warnings)).toContain('unparsed-price');
    expect(reps.slice(1).every((i) => codes(i.warnings).includes(CRAFT_UNVERIFIED))).toBe(true);
  });
});
