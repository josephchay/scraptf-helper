// F12 "Bought it" in the quick-entry window: after a successful Save, one click
// writes a journal buy at the saved price (venue scrap.tf) and the toast offers
// Undo. The rules are pure (quickModel.ts); the last block drives the in-memory
// browser mock, so the row the button writes is one the service contract takes
// and Holdings picks it up. No network.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { BUY_VENUE, afterBoughtUndo, boughtButton, boughtItInput, boughtItText, savedItemSku, type BoughtState } from '../../src/renderer/quickModel';
import type { ScrapPrice } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

function price(over: Partial<ScrapPrice> = {}): ScrapPrice {
  return {
    id: 7,
    sku: '378;6',
    name: 'Team Captain',
    costKeys: 1,
    costScrap: 12,
    source: 'user',
    observedAt: T0,
    note: 'two in stock',
    importBatch: null,
    special: null,
    assetId: null,
    stock: null,
    ...over,
  };
}

describe('the journal row', () => {
  it('is a buy on scrap.tf at the saved price, keys and metal as typed', () => {
    expect(BUY_VENUE).toBe('scrap.tf');
    expect(boughtItInput(price())).toEqual({ side: 'buy', venue: 'scrap.tf', sku: '378;6', name: 'Team Captain', keys: 1, scrap: 12 });
    // The price's own note is about the listing, not the trade; the time is the service's now.
    expect(boughtItInput(price())).not.toHaveProperty('note');
    expect(boughtItInput(price())).not.toHaveProperty('ts');
  });

  it('records the painted item the user saved, not its base (prices.upsert moved the paint into the extras)', () => {
    const special = { paint: 15185211, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false };
    expect(savedItemSku(price({ special }))).toBe('378;6;p15185211');
    expect(boughtItInput(price({ special })).sku).toBe('378;6;p15185211');
    // Already on the SKU (the mock keeps it there): not added twice.
    expect(savedItemSku(price({ sku: '378;6;p15185211', special }))).toBe('378;6;p15185211');
    // No paint, or extras unknown: the saved SKU as it is.
    expect(savedItemSku(price({ special: { ...special, paint: null } }))).toBe('378;6');
    expect(savedItemSku(price({ special: null }))).toBe('378;6');
    expect(savedItemSku({ sku: '378;6' })).toBe('378;6');
  });

  it('confirms what was recorded', () => {
    expect(boughtItText({ name: 'Team Captain', sku: '378;6', keys: 1, scrap: 12 })).toBe('Recorded a buy of Team Captain at 1 key 1.33 ref in your journal.');
    expect(boughtItText({ name: ' ', sku: '378;6', keys: 0, scrap: 9 })).toBe('Recorded a buy of 378;6 at 1.00 ref in your journal.');
  });
});

describe('the button', () => {
  it('records once per save: idle, recording, recorded', () => {
    expect(boughtButton(null, 7)).toEqual({ label: 'Bought it', disabled: false, done: false });
    expect(boughtButton({ priceId: 7, status: 'saving' }, 7)).toEqual({ label: 'Recording…', disabled: true, done: false });
    expect(boughtButton({ priceId: 7, status: 'done', entryId: 41 }, 7)).toEqual({ label: 'Recorded', disabled: true, done: true });
    // A newer save is a new button.
    expect(boughtButton({ priceId: 7, status: 'done', entryId: 41 }, 8)).toEqual({ label: 'Bought it', disabled: false, done: false });
  });

  it('is armed again after Undo removed that very row, and only then', () => {
    const done: BoughtState = { priceId: 7, status: 'done', entryId: 41 };
    expect(afterBoughtUndo(done, 41)).toBeNull();
    expect(afterBoughtUndo(done, 40)).toBe(done);
    expect(afterBoughtUndo({ priceId: 7, status: 'saving' }, 41)).toEqual({ priceId: 7, status: 'saving' });
    expect(afterBoughtUndo(null, 41)).toBeNull();
  });
});

describe('quick entry wiring', () => {
  const page = readFileSync(new URL('../../src/renderer/pages/QuickEntry.tsx', import.meta.url), 'utf8');

  it('offers Bought it only on the saved result, and the toast carries Undo (journal.delete)', () => {
    const result = page.slice(page.indexOf('aria-label="Saved price"'));
    expect(result).toContain('onClick={() => void boughtIt(result.price)}');
    expect(page.slice(0, page.indexOf('aria-label="Saved price"'))).not.toContain('boughtIt(');
    expect(page).toContain("rpc('journal.add', boughtItInput(price))");
    expect(page).toMatch(/toast\(boughtItText\(entry\), 'good', \{ action: \{ label: 'Undo', onClick: \(\) => void undoBought\(entry\.id\) \} \}\)/);
    expect(page).toContain("rpc('journal.delete', { id: entryId })");
    // A double click must not record two units.
    expect(page).toMatch(/if \(boughtBusy\.current\) return;/);
  });
});

describe('against the browser mock', () => {
  let bridge: MockBridge | null = null;
  afterEach(() => {
    bridge?.dispose();
    bridge = null;
  });

  it('writes a buy that Holdings counts, and Undo takes it back out', async () => {
    const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
    const pushes: number[] = [];
    b.on('journal.changed', (p) => pushes.push(p.at));
    const qtyOf = async (sku: string) => (await b.rpc('holdings.list', {})).rows.find((r) => r.sku === sku)?.qty ?? 0;

    const saved = await b.rpc('prices.upsert', { sku: '378;6', name: 'Team Captain', costKeys: 0, costScrap: 40, source: 'user', observedAt: T0, note: null });
    const before = await qtyOf(saved.sku);
    const entry = await b.rpc('journal.add', boughtItInput(saved));
    expect(entry).toMatchObject({ side: 'buy', venue: 'scrap.tf', sku: '378;6', keys: 0, scrap: 40 });
    expect(await qtyOf(saved.sku)).toBe(before + 1);

    await b.rpc('journal.delete', { id: entry.id });
    expect(await qtyOf(saved.sku)).toBe(before);
    expect(pushes.length).toBe(2);
  });
});
