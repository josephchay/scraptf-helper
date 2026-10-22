// 0.7.4 (F81): the price sheet CSV is a complete record, not a backup. Each copy of one SKU (a kit stored once
// per sheen/killstreaker combo) writes its own sheen, killstreaker, name and description tags and copy key,
// appended after the older columns so a sheet read by position keeps its meaning. Pasting its sku and cost back
// makes typed prices dated now (documented in pricesCsv and ARCHITECTURE "Backups"), nothing more.

import { describe, expect, it } from 'vitest';
import { CSV_BOM } from '../../src/service/domain/csv';
import { pricesCsv } from '../../src/service/priceSheetIo';
import { bankStockSpecialKey } from '../../src/shared/bankStock';
import type { ScrapPrice, SpecialAttrs } from '../../src/shared/types';

const T = Date.UTC(2026, 9, 20, 11, 42, 40);
const KIT = '6526;6;uncraftable;kt-3;td-205';

function special(over: Partial<SpecialAttrs>): SpecialAttrs {
  return { paint: null, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false, ...over };
}

function price(id: number, sp: SpecialAttrs | null, costKeys = 5): ScrapPrice {
  return { id, sku: KIT, name: 'Non-Craftable Professional Killstreak Rocket Launcher Kit', costKeys, costScrap: 27, source: 'import', observedAt: T, note: null, importBatch: 30, special: sp, assetId: null, stock: 1 };
}

function rows(csv: string): Record<string, string>[] {
  const lines = csv.slice(CSV_BOM.length).split('\r\n').filter(Boolean);
  const head = lines[0]!.split(',');
  // Cells with commas are quoted; split on commas outside quotes.
  return lines.slice(1).map((l) => {
    const cells = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? '']));
  });
}

describe('pricesCsv keeps every copy apart (F81)', () => {
  it('writes each kit copy with its own sheen, killstreaker and copy key', () => {
    const a = special({ sheen: 1, killstreaker: 2008 });
    const b = special({ sheen: 3 });
    const out = rows(pricesCsv([price(1, a), price(2, b, 6), price(3, special({ customName: true, customDesc: true }))], 567));
    expect(out.map((r) => [r['id'], r['sheen'], r['killstreaker'], r['name_tag'], r['description_tag']])).toEqual([
      ['1', '1', '2008', 'false', 'false'],
      ['2', '3', '', 'false', 'false'],
      ['3', '', '', 'true', 'true'],
    ]);
    expect(out[0]!['copy_key']).toBe(bankStockSpecialKey(a));
    expect(out[1]!['copy_key']).toBe(bankStockSpecialKey(b));
    expect(new Set(out.map((r) => r['copy_key'])).size).toBe(3);
    // The older columns are where they were.
    expect(Object.keys(out[0]!).slice(0, 16)).toEqual(['id', 'sku', 'name', 'cost', 'cost_keys', 'cost_metal_ref', 'cost_ref', 'key_price_ref', 'source', 'observed_at', 'note', 'stock', 'asset_id', 'paint', 'spells', 'parts']);
  });

  it('a plain or typed copy writes empty extras and an empty copy key', () => {
    const [r] = rows(pricesCsv([price(9, null)], 567));
    expect([r!['sheen'], r!['killstreaker'], r!['name_tag'], r!['description_tag'], r!['copy_key']]).toEqual(['', '', '', '', '']);
  });
});
