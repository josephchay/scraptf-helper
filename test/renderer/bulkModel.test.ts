// Price-sheet helpers behind PricesPage's "Paste a list" and RulesPanel's
// backup buttons (F7).

import { afterEach, describe, expect, it } from 'vitest';
import {
  BULK_MAX_BYTES,
  BULK_MAX_LINES,
  bulkCommitMessage,
  bulkInputStats,
  bulkPlanSummary,
  checkRulesFile,
  isSkipped,
  planBulkCommit,
  RULES_JSON_MAX_CHARS,
  rulesImportToast,
  stripBom,
} from '../../src/renderer/bulkModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { MAX_BULK_BYTES, MAX_BULK_LINES, parseBulkPrices } from '../../src/service/priceSheetIo';
import { fromString } from '../../src/shared/sku';
import type { BulkPriceRow, ResolvedItem, ScrapPrice } from '../../src/shared/types';
import { EMPTY_SPECIAL } from '../../src/shared/types';

function row(line: number, sku: string | null, costScrap: number, extra: Partial<BulkPriceRow> = {}): BulkPriceRow {
  return { line, raw: `line ${line}`, sku, name: sku ? `Item ${sku}` : null, costKeys: 0, costScrap, error: sku ? null : 'Item not recognised: x', ...extra };
}

function price(id: number, sku: string, extra: Partial<ScrapPrice> = {}): ScrapPrice {
  return {
    id,
    sku,
    name: `Item ${sku}`,
    costKeys: 0,
    costScrap: 10,
    source: 'user',
    observedAt: 1_000,
    note: null,
    importBatch: null,
    special: null,
    assetId: null,
    stock: null,
    ...extra,
  };
}

describe('bulkInputStats', () => {
  it('counts the lines the parser reads, skipping blanks and # comments', () => {
    expect(bulkInputStats('')).toMatchObject({ lines: 0, overLines: false, overBytes: false });
    expect(bulkInputStats('# notes\n\nTeam Captain, 1 key\r\n   \n  # also a comment\nBill\'s Hat = 1.33\n').lines).toBe(2);
  });

  it('counts lines exactly as the service parser does, including bare CR line breaks', () => {
    const resolve = (t: string): ResolvedItem => ({ sku: `${t.length};6`, name: t, skuObject: fromString(`${t.length};6`), category: 'other', match: 'exact', warnings: [] });
    for (const text of ['a, 1\rb, 2\rc, 3', 'a, 1\r\nb, 2\n\n# c, 3\rd, 4', '  \n#\n']) {
      expect(bulkInputStats(text).lines, JSON.stringify(text)).toBe(parseBulkPrices(text, 'ref', resolve).rows.length);
    }
    // One past the limit is refused by the service and blocked by the counter alike.
    const over = Array.from({ length: BULK_MAX_LINES + 1 }, (_, i) => `item ${i}, 1`).join('\r');
    expect(bulkInputStats(over).overLines).toBe(true);
    expect(parseBulkPrices(over, 'ref', resolve).refusal).not.toBeNull();
  });

  it('flags pastes over the service limits, which it mirrors', () => {
    expect(BULK_MAX_LINES).toBe(MAX_BULK_LINES);
    expect(BULK_MAX_BYTES).toBe(MAX_BULK_BYTES);
    const lines = (n: number) => Array.from({ length: n }, () => 'a, 1').join('\n');
    expect(bulkInputStats(lines(500)).overLines).toBe(false);
    expect(bulkInputStats(lines(501)).overLines).toBe(true);
    expect(bulkInputStats('x'.repeat(BULK_MAX_BYTES)).overBytes).toBe(false);
    // Bytes, not characters: 'é' is two bytes in UTF-8.
    const s = bulkInputStats('é'.repeat(BULK_MAX_BYTES / 2 + 1));
    expect(s.bytes).toBe(BULK_MAX_BYTES + 2);
    expect(s.overBytes).toBe(true);
  });
});

describe('planBulkCommit', () => {
  it('adds new items as typed prices and skips lines with errors', () => {
    const plan = planBulkCommit([row(1, '378;6', 45), row(2, null, 0), row(4, '126;6', 12, { costKeys: 1 })], []);
    expect(plan.inputs).toEqual([
      { sku: '378;6', name: 'Item 378;6', costKeys: 0, costScrap: 45, source: 'user' },
      { sku: '126;6', name: 'Item 126;6', costKeys: 1, costScrap: 12, source: 'user' },
    ]);
    expect(plan).toMatchObject({ added: 2, updated: 0, skipped: 1 });
    expect(plan.states.get(2)).toEqual({ kind: 'error', message: 'Item not recognised: x' });
    expect(plan.states.get(1)).toEqual({ kind: 'add' });
    // observedAt is left to the service, so every saved line counts as seen now.
    for (const i of plan.inputs) expect(i).not.toHaveProperty('observedAt');
  });

  it("updates the user's newest typed price for the same item instead of adding a duplicate", () => {
    const existing = [price(1, '378;6', { observedAt: 5_000, costScrap: 40 }), price(2, '378;6', { observedAt: 9_000, costScrap: 44 }), price(3, '378;6', { observedAt: 9_000, costScrap: 45 })];
    const plan = planBulkCommit([row(1, '378;6', 45)], existing);
    // Same observedAt: the higher id is the newer row.
    expect(plan.inputs).toEqual([{ id: 3, sku: '378;6', name: 'Item 378;6', costKeys: 0, costScrap: 45, source: 'user' }]);
    expect(plan.states.get(1)).toEqual({ kind: 'update', id: 3, previous: { costKeys: 0, costScrap: 45 }, samePrice: true });
    expect(plan).toMatchObject({ added: 0, updated: 1, skipped: 0 });
  });

  it('leaves imported prices alone (their page provenance is kept)', () => {
    const plan = planBulkCommit([row(1, '378;6', 45)], [price(7, '378;6', { source: 'import', importBatch: 3 })]);
    expect(plan.inputs[0]).not.toHaveProperty('id');
    expect(plan.states.get(1)).toEqual({ kind: 'add' });
  });

  it('matches painted items on base SKU plus paint, as the service stores them', () => {
    const painted = price(5, '378;6', { special: { ...EMPTY_SPECIAL, spells: [], parts: [], paint: 3100495 } });
    const plain = price(6, '378;6', { costScrap: 30 });
    const plan = planBulkCommit([row(1, '378;6;p3100495', 60), row(2, '378;6', 33), row(3, '378;6;p8208497', 70)], [painted, plain]);
    expect(plan.states.get(1)).toMatchObject({ kind: 'update', id: 5 });
    expect(plan.states.get(2)).toMatchObject({ kind: 'update', id: 6, previous: { costKeys: 0, costScrap: 30 }, samePrice: false });
    expect(plan.states.get(3)).toEqual({ kind: 'add' });
    expect(plan).toMatchObject({ added: 1, updated: 2 });
  });

  it('saves only the last line when an item is pasted twice', () => {
    const plan = planBulkCommit([row(1, '378;6', 40), row(2, '126;6', 12), row(5, '378;6', 45), row(6, null, 0)], []);
    expect(plan.states.get(1)).toEqual({ kind: 'superseded', byLine: 5 });
    expect(plan.inputs.map((i) => [i.sku, i.costScrap])).toEqual([
      ['126;6', 12],
      ['378;6', 45],
    ]);
    expect(plan).toMatchObject({ added: 2, updated: 0, skipped: 2 });
    expect([1, 2, 5, 6].map((l) => isSkipped(plan.states.get(l)))).toEqual([true, false, false, true]);
    expect(isSkipped(undefined)).toBe(false);
  });

  it('treats two spellings of one stored item (paint in the SKU) as a repeat', () => {
    // Different SKU strings the service would store under the same base SKU and paint.
    const plan = planBulkCommit([row(1, '378;6;p3100495', 60), row(2, '378;6;p3100495;', 70)], []);
    expect(plan.states.get(1)).toEqual({ kind: 'superseded', byLine: 2 });
    expect(plan.inputs).toEqual([{ sku: '378;6;p3100495;', name: 'Item 378;6;p3100495;', costKeys: 0, costScrap: 70, source: 'user' }]);
  });

  it('dedupes repeats the service parser leaves saveable, so one bulkUpsert row per item', () => {
    const resolve = (t: string): ResolvedItem => ({ sku: '378;6', name: t, skuObject: fromString('378;6'), category: 'hats', match: 'exact', warnings: [] });
    const parsed = parseBulkPrices('Team Captain, 40\nTeam Captain, 45', 'scrap', resolve);
    const plan = planBulkCommit(parsed.rows, []);
    expect(plan.inputs.map((i) => i.costScrap)).toEqual([45]);
    expect(plan.states.get(1)).toEqual({ kind: 'superseded', byLine: 2 });
  });

  it('never sends more rows than a paste can hold', () => {
    const rows = Array.from({ length: BULK_MAX_LINES }, (_, i) => row(i + 1, `${1000 + i};6`, i));
    expect(planBulkCommit(rows, []).inputs).toHaveLength(BULK_MAX_LINES);
  });
});

describe('preview and toast wording', () => {
  it('summarises a plan', () => {
    expect(bulkPlanSummary({ added: 9, updated: 3, skipped: 2 })).toBe('12 prices ready (9 new, 3 updates), 2 lines skipped');
    expect(bulkPlanSummary({ added: 0, updated: 1, skipped: 0 })).toBe('1 price ready (0 new, 1 update)');
    expect(bulkPlanSummary({ added: 0, updated: 0, skipped: 1 })).toBe('0 prices ready, 1 line skipped');
  });

  it('reports what bulkUpsert saved', () => {
    expect(bulkCommitMessage({ added: 9, updated: 3 }, 2)).toBe('Added 9 prices and updated 3. 2 lines skipped.');
    expect(bulkCommitMessage({ added: 1, updated: 0 }, 0)).toBe('Added 1 price.');
    expect(bulkCommitMessage({ added: 0, updated: 2 }, 1)).toBe('Updated 2 prices. 1 line skipped.');
    expect(bulkCommitMessage({ added: 0, updated: 0 }, 0)).toBe('Nothing was saved.');
  });

  it('lists the first skipped rules in the import toast', () => {
    expect(rulesImportToast({ added: 3, skipped: [] })).toEqual({ text: 'Imported 3 rules.', tone: 'good' });
    expect(rulesImportToast({ added: 0, skipped: [] })).toEqual({ text: 'No rules imported.', tone: 'warn' });
    expect(rulesImportToast({ added: 1, skipped: ['Rule 2: a rule needs a name'] })).toEqual({ text: 'Imported 1 rule, skipped 1: Rule 2: a rule needs a name', tone: 'warn' });
    const many = rulesImportToast({ added: 0, skipped: ['a', 'b', 'c', 'd'] });
    expect(many).toEqual({ text: 'No rules imported, skipped 4: a; b (+2 more)', tone: 'warn' });
  });
});

describe('rules backup file', () => {
  it('accepts a .json (or .txt) file up to the import limit', () => {
    expect(checkRulesFile({ name: 'flipdesk-rules-2026-10-15.json', size: 2_000 })).toBeNull();
    expect(checkRulesFile({ name: 'RULES.JSON', size: 2_000 })).toBeNull();
    expect(checkRulesFile({ name: 'rules.txt', size: RULES_JSON_MAX_CHARS })).toBeNull();
    expect(checkRulesFile({ name: 'page.html', size: 10 })).toMatch(/\.json/);
    expect(checkRulesFile({ name: 'rules.json', size: RULES_JSON_MAX_CHARS + 1 })).toMatch(/5 MB/);
  });

  it('drops a UTF-8 byte-order mark so JSON.parse accepts a Notepad save', () => {
    expect(JSON.parse(stripBom('﻿{"rules":[]}'))).toEqual({ rules: [] });
    expect(stripBom('{"a":1}')).toBe('{"a":1}');
    expect(stripBom('')).toBe('');
  });
});

describe('paste flow against the mock service contract', () => {
  let bridge: MockBridge | null = null;
  afterEach(() => {
    bridge?.dispose();
    bridge = null;
  });

  it('preview, plan and commit update an existing typed price and add the rest in one call', async () => {
    const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => Date.UTC(2026, 9, 14, 12) }));
    // A typed price the paste should update rather than duplicate.
    const mine = await b.rpc('prices.upsert', { sku: '126;6', costScrap: 10, source: 'user' });
    const before = await b.rpc('prices.list', {});
    const text = ["Bill's Hat = 1.33", 'Team Captain, 1 key 5 ref', 'Not An Item @ 2 ref', 'Team Captain, 1 key 6 ref'].join('\n');
    const parsed = await b.rpc('prices.parseBulk', { text, bareUnit: 'ref' });
    const plan = planBulkCommit(parsed.rows, before);
    expect(plan.states.get(1)).toMatchObject({ kind: 'update', id: mine.id });
    expect(plan.states.get(2)).toEqual({ kind: 'superseded', byLine: 4 });
    expect(plan.states.get(3)?.kind).toBe('error');

    const r = await b.rpc('prices.bulkUpsert', { rows: plan.inputs });
    // The service counts exactly what the preview promised.
    expect(r).toEqual({ added: plan.added, updated: plan.updated });
    expect(plan.inputs).toHaveLength(2);
    const after = await b.rpc('prices.list', {});
    expect(after).toHaveLength(before.length + plan.added);
    const captains = after.filter((p) => p.sku === '378;6' && p.source === 'user');
    expect(captains.filter((p) => p.costKeys === 1 && p.costScrap === 54)).toHaveLength(1);
    // The earlier, repeated line was not saved.
    expect(captains.filter((p) => p.costKeys === 1 && p.costScrap === 45)).toHaveLength(0);
    expect(after.find((p) => p.id === mine.id)).toMatchObject({ costScrap: 12, source: 'user' });
    expect(bulkCommitMessage(r, plan.skipped)).toMatch(/2 lines skipped/);
  });
});
