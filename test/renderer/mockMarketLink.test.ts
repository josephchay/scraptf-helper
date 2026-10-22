// F19 contract in the browser mock: every Live market row carries scraptfLink (some seen on a saved
// page, some the category's bank), always a static allowlisted page; 'check.arm' validates like main and
// lapses after CHECK_ARM_MS; 'check.text' checks a bare price as the hinted item (its own hint, or main's
// arm on a hotkey or watcher check), while text that names an item wins. No network: all in memory.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { CHECK_ARM_MS, CHECK_ARM_NAME_MAX, CHECK_NOT_ITEM_REASON, checkHintedNote, checkMatchedByHint } from '../../src/shared/check';
import { bankForCategory, isAllowedExternalUrl, scraptfBankInfo } from '../../src/shared/links';
import { MAIN_METHODS } from '../../src/shared/rpc';

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);
let bridge: MockBridge | null = null;
let clock = T0;

function make(): MockBridge {
  clock = T0;
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => clock });
  return bridge;
}

afterEach(() => {
  bridge?.dispose();
  bridge = null;
});

describe('MarketRow.scraptfLink (mock)', () => {
  it('is on every row, a mix of seen and category, always a static bank page', async () => {
    const b = make();
    const all = await b.rpc('market.list', { limit: 2000 });
    expect(all.rows.length).toBeGreaterThan(20);
    for (const r of all.rows) {
      const l = r.scraptfLink;
      expect(scraptfBankInfo(l.bank)?.url, r.sku).toBe(l.url);
      expect(isAllowedExternalUrl(l.url)).toBe(true);
      if (l.source === 'category') {
        expect(l).toEqual({ bank: bankForCategory(r.category), url: scraptfBankInfo(bankForCategory(r.category))!.url, seenAt: null, source: 'category' });
      } else {
        expect(l.seenAt).not.toBeNull();
        expect(l.seenAt!).toBeLessThanOrEqual(T0);
      }
    }
    const sources = new Set(all.rows.map((r) => r.scraptfLink.source));
    expect(sources).toEqual(new Set(['seen', 'category']));
  });
});

describe("'check.arm' (mock of main)", () => {
  it('is a main method that arms for CHECK_ARM_MS and disarms with null', async () => {
    expect(MAIN_METHODS).toContain('check.arm');
    const b = make();
    expect(await b.rpc('check.arm', { sku: '378;6', name: 'Team Captain' })).toEqual({ armedUntil: T0 + CHECK_ARM_MS });
    expect(await b.rpc('check.arm', null)).toEqual({ armedUntil: null });
  });

  it('validates like main, with fixed messages that never quote the name', async () => {
    const b = make();
    const marker = 'Zq7 Name Marker';
    const bad: unknown[] = [
      { sku: 'not a sku', name: marker },
      { sku: '378;6;uncratable', name: marker },
      { sku: '378;6', name: '' },
      { sku: '378;6', name: 'x'.repeat(CHECK_ARM_NAME_MAX + 1) },
      { sku: '378;6', name: `${marker}\nsecond line` },
      { sku: '378;6' },
      marker,
    ];
    for (const p of bad) {
      const err = await b.rpc('check.arm', p as never).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message, JSON.stringify(p).slice(0, 40)).toMatch(/^Invalid parameters for check\.arm: /);
      expect(err?.message).not.toContain('Zq7');
    }
  });
});

describe("'check.text' hint (mock)", () => {
  it('checks a bare price as the hinted item, with the fixed note', async () => {
    const b = make();
    for (const text of ['1.33 ref', '1 key 5.33 ref', '  2 keys 5.11\t']) {
      const r = await b.rpc('check.text', { text, source: 'manual', hint: { sku: '378;6' } });
      expect(r).toMatchObject({ status: 'item', sku: '378;6', name: 'Team Captain', price: { source: 'clipboard' } });
      // The hinted note first (0.7.4 review R14: a price far under PriceDB's buy adds the cost check's note after it).
      expect(r.reason?.startsWith(checkHintedNote('Team Captain'))).toBe(true);
      expect(checkMatchedByHint(r)).toBe(true);
    }
  });

  it('reads the price as the service does: no id or year from any source, no bare whole number from the watcher', async () => {
    const b = make();
    for (const source of ['manual', 'hotkey', 'watch'] as const) {
      for (const text of ['76561198012345678', '2024', '123456', '5001 keys']) {
        const r = await b.rpc('check.text', { text, source, hint: { sku: '378;6' } });
        expect(r, `${source}: ${text}`).toMatchObject({ status: 'not-item', reason: CHECK_NOT_ITEM_REASON, price: null });
      }
    }
    await b.rpc('check.arm', { sku: '378;6', name: 'Team Captain' });
    for (const text of ['5', '49', '5k']) expect(await b.rpc('check.text', { text, source: 'watch' }), text).toMatchObject({ status: 'not-item', price: null });
    expect(await b.rpc('check.text', { text: '1.33', source: 'watch' })).toMatchObject({ status: 'item', sku: '378;6', price: { scrapRaw: 12 } });
    expect(await b.rpc('check.text', { text: '5', source: 'hotkey' })).toMatchObject({ status: 'item', sku: '378;6', price: { scrapRaw: 45 } });
  });

  it('without a hint a bare price is not an item, as before', async () => {
    const b = make();
    expect(await b.rpc('check.text', { text: '1.33 ref', source: 'manual' })).toMatchObject({ status: 'not-item', reason: CHECK_NOT_ITEM_REASON });
  });

  it('text that names an item wins over the hint', async () => {
    const b = make();
    const r = await b.rpc('check.text', { text: 'Team Captain, 1.33 ref', source: 'manual', hint: { sku: '5021;6' } });
    expect(r).toMatchObject({ status: 'item', sku: '378;6' });
    expect(checkMatchedByHint(r)).toBe(false);
  });

  it('refuses an invalid hint SKU without quoting the text', async () => {
    const b = make();
    for (const hint of [{ sku: 'nope' }, { sku: '' }, 'Zq7', { sku: 42 }]) {
      const err = await b.rpc('check.text', { text: 'Zq7 1.33 ref', source: 'manual', hint: hint as never }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toMatch(/^Invalid parameters for check\.text: hint/);
      expect(err?.message).not.toContain('Zq7');
    }
  });

  it("applies main's arm to hotkey and watcher checks only, until it lapses", async () => {
    const b = make();
    await b.rpc('check.arm', { sku: '378;6', name: 'Team Captain' });
    expect(await b.rpc('check.text', { text: '1.33 ref', source: 'manual' })).toMatchObject({ status: 'not-item' });
    expect(await b.rpc('check.text', { text: '1.33 ref', source: 'hotkey' })).toMatchObject({ status: 'item', sku: '378;6' });
    expect(await b.rpc('check.text', { text: '1.33 ref', source: 'watch' })).toMatchObject({ status: 'item', sku: '378;6' });
    clock = T0 + CHECK_ARM_MS;
    expect(await b.rpc('check.text', { text: '1.33 ref', source: 'hotkey' })).toMatchObject({ status: 'not-item' });
    clock = T0;
    await b.rpc('check.arm', { sku: '378;6', name: 'Team Captain' });
    await b.rpc('check.arm', null);
    expect(await b.rpc('check.text', { text: '1.33 ref', source: 'hotkey' })).toMatchObject({ status: 'not-item' });
  });
});
