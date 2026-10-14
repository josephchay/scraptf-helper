// v0.2 features in the browser mock (pay-up-to ceilings, shopping list, buyer
// check, bulk paste, backups, prefilled quick entry, reference and margin
// guards, notification input kinds), so the dashboard can be built against it.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { maxCostFor } from '../../src/shared/ceiling';
import type { PushEvent } from '../../src/shared/rpc';
import { CATEGORIES } from '../../src/shared/types';

let bridge: MockBridge | null = null;
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const DAY = 86_400_000;

function make(): MockBridge {
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  return bridge;
}

function collect(b: MockBridge, event: PushEvent): unknown[] {
  const seen: unknown[] = [];
  b.on(event, (p) => seen.push(p));
  return seen;
}

afterEach(() => {
  bridge?.dispose();
  bridge = null;
});

describe('pay-up-to ceilings', () => {
  it('every opportunity carries maxCostFor(revenue, settings.profit), and follows a settings change', async () => {
    const b = make();
    const settings = await b.rpc('settings.get', undefined);
    const { rows } = await b.rpc('opps.list', { limit: 5000 });
    expect(rows.some((o) => (o.maxCostScrap ?? 0) > 0)).toBe(true);
    for (const o of rows) expect(o.maxCostScrap).toBe(maxCostFor(o.revenueScrap, settings.profit));

    await b.rpc('settings.set', { profit: { minProfitScrap: 90 } });
    const after = await b.rpc('opps.list', { limit: 5000 });
    const next = await b.rpc('settings.get', undefined);
    for (const o of after.rows) expect(o.maxCostScrap).toBe(maxCostFor(o.revenueScrap, next.profit));
  });

  it('item.detail has the backpack.tf name and the revenue with its ceiling; history: false skips history', async () => {
    const b = make();
    const settings = await b.rpc('settings.get', undefined);
    const d = await b.rpc('item.detail', { sku: '378;6' });
    expect(d?.bptfName).toBe('Team Captain');
    expect(d?.revenue).toMatchObject({ useOrder: settings.profit.useOrder });
    expect(d!.revenue!.eligibleCount).toBeGreaterThan(0);
    expect(d!.revenue!.maxCostScrap).toBe(maxCostFor(d!.revenue!.revenueScrap, settings.profit));
    expect(d!.revenue!.order?.valueScrap ?? null).toBe(d!.revenue!.revenueScrap);
    expect(d!.history.length).toBeGreaterThan(0);
    const quick = await b.rpc('item.detail', { sku: '378;6', history: false });
    expect(quick?.history).toEqual([]);
    expect(quick?.revenue).toEqual(d?.revenue);
  });
});

describe('shopping list', () => {
  it('has one row per SKU with a positive ceiling, sorted by category then ceiling', async () => {
    const b = make();
    const res = await b.rpc('shopping.list', {});
    expect(res.total).toBeGreaterThan(10);
    expect(res.rows).toHaveLength(res.total);
    expect(new Set(res.rows.map((r) => r.sku)).size).toBe(res.rows.length);
    for (const r of res.rows) {
      expect(r.maxCostScrap).toBeGreaterThan(0);
      expect(r.bankPageUrl).toMatch(/^https:\/\/scrap\.tf\//);
      expect(r.underCeiling).toBe(r.knownCostScrap === null ? null : r.knownMaxCostScrap !== null && r.knownCostScrap <= r.knownMaxCostScrap);
    }
    for (let i = 1; i < res.rows.length; i++) {
      const a = res.rows[i - 1]!;
      const c = res.rows[i]!;
      const byCat = CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(c.category);
      expect(byCat < 0 || (byCat === 0 && a.maxCostScrap >= c.maxCostScrap)).toBe(true);
    }
    expect(res.groups.reduce((n, g) => n + g.count, 0)).toBe(res.total);
    expect(res.rows.some((r) => r.knownCostScrap === null)).toBe(true);
  });

  it('filters and pages', async () => {
    const b = make();
    const all = await b.rpc('shopping.list', {});
    const hats = await b.rpc('shopping.list', { categories: ['hats'], minCeilingScrap: 20, onlyBotBuyers: true });
    expect(hats.rows.every((r) => r.category === 'hats' && r.maxCostScrap >= 20 && r.revenueOrder?.isBot === true)).toBe(true);
    const page = await b.rpc('shopping.list', { limit: 5, offset: 5 });
    expect(page.rows).toEqual(all.rows.slice(5, 10));
    expect(page.total).toBe(all.total);
  });

  it('exports the shopping list as CSV with the agreed columns', async () => {
    const b = make();
    const res = await b.rpc('shopping.list', {});
    const { csv, suggestedName } = await b.rpc('opps.exportCsv', { kind: 'shopping', shopping: { limit: 3 } });
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('sku,name,category,pay_up_to,revenue,buyer,confidence,known_cost,under_ceiling,bank_page');
    // Paging does not apply to the file.
    expect(lines).toHaveLength(res.total + 1);
    expect(suggestedName).toMatch(/^flipdesk-shopping-.*\.csv$/);
  });
});

describe('buyer.check', () => {
  it('needs the access token, then answers deterministically and from the cache', async () => {
    const b = make();
    const d = await b.rpc('item.detail', { sku: '378;6' });
    const steamid = d!.buyOrders[0]!.steamid;
    const none = await b.rpc('buyer.check', { steamid });
    expect(none).toMatchObject({ steamid, bptfBanned: null, error: 'Add a backpack.tf access token in Settings' });

    await b.rpc('secrets.set', { name: 'bptfAccessToken', value: 'token' });
    const first = await b.rpc('buyer.check', { steamid });
    expect(first.error).toBeNull();
    expect(typeof first.bptfBanned).toBe('boolean');
    expect(first.cached).toBe(false);
    expect(first.name).toBe(d!.buyOrders[0]!.userName);
    const again = await b.rpc('buyer.check', { steamid });
    expect(again).toEqual({ ...first, cached: true });
    await expect(b.rpc('buyer.check', { steamid: 'abc' })).rejects.toThrow(/steamid/);

    // A cached answer costs no request, so pausing the network still serves it (as the service does).
    await b.rpc('settings.set', { networkPaused: true });
    expect(await b.rpc('buyer.check', { steamid })).toEqual({ ...first, cached: true });
    const other = d!.buyOrders.find((o) => o.steamid !== steamid)!.steamid;
    expect((await b.rpc('buyer.check', { steamid: other })).error).toMatch(/paused/);
  });
});

describe('bulk paste and backups', () => {
  it('previews item + price lines with any separator, a trailing price, comments and errors', async () => {
    const b = make();
    const text = [
      '# copied from my notes',
      'Team Captain, 1 key 5 ref',
      'Taunt: Rock, Paper, Scissors\t28.66',
      "Bill's Hat = 1.33",
      '',
      'Strange Minigun 3.66 ref',
      'Not An Item @ 2 ref',
      'Brigade Helm - lots',
    ].join('\n');
    const r = await b.rpc('prices.parseBulk', { text });
    expect(r.rows.map((x) => [x.line, x.sku, x.costKeys, x.costScrap])).toEqual([
      [2, '378;6', 1, 45],
      [3, '1110;6', 0, 258],
      [4, '126;6', 0, 12],
      [6, '202;11', 0, 33],
      [7, null, 0, 18],
      [8, null, 0, 0],
    ]);
    expect(r.rejected).toBe(2);
    expect(r.rows.filter((x) => x.error !== null).map((x) => x.line)).toEqual([7, 8]);
  });

  it('keeps a sku only on saveable rows, like the service: no guesses, no zero prices', async () => {
    const b = make();
    const r = await b.rpc('prices.parseBulk', { text: "team capt, 1 ref\r378;6, 0 ref\rBill's Hat, 2 ref" });
    expect(r.rows.map((x) => [x.line, x.sku])).toEqual([
      [1, null],
      [2, null],
      [3, '126;6'],
    ]);
    expect(r.rows[0]!.error).toMatch(/^Closest match only/);
    expect(r.rows[1]!.error).toBe('The price is 0');
    expect(r.rejected).toBe(2);
  });

  it('refuses pasted page content as a whole (R10)', async () => {
    const b = make();
    for (const text of ['<div class="item">Team Captain</div> 1.33', 'https://scrap.tf/buy/hats Team Captain 1.33']) {
      await expect(b.rpc('prices.parseBulk', { text })).rejects.toThrow('This looks like page content. Use Import for saved pages.');
    }
    await expect(b.rpc('prices.parseBulk', { text: Array.from({ length: 501 }, () => 'Team Captain, 1 ref').join('\n') })).rejects.toThrow(/500/);
  });

  it('bulk-upserts as typed prices with one prices.changed push', async () => {
    const b = make();
    const pushes = collect(b, 'prices.changed');
    const existing = (await b.rpc('prices.list', {}))[0]!;
    const r = await b.rpc('prices.bulkUpsert', {
      rows: [
        { sku: '30359;6', costScrap: 16 },
        { sku: '378;6', costKeys: 1, costScrap: 9 },
        { id: existing.id, sku: existing.sku, costScrap: 3 },
      ],
    });
    expect(r).toEqual({ added: 2, updated: 1 });
    expect(pushes).toHaveLength(1);
    const after = await b.rpc('prices.list', {});
    expect(after.find((p) => p.id === existing.id)).toMatchObject({ costScrap: 3, source: 'user' });
    expect(after.find((p) => p.sku === '30359;6')).toMatchObject({ name: 'Juggernaut Jacket', source: 'user' });
    await expect(b.rpc('prices.bulkUpsert', { rows: [{ sku: '378;6', costScrap: 1 }, { id: 999_999, sku: '378;6', costScrap: 1 }] })).rejects.toThrow(/999999/);
    expect(await b.rpc('prices.list', {})).toHaveLength(after.length);
  });

  it('exports the price sheet and round-trips rules through a JSON backup without deleting any', async () => {
    const b = make();
    const prices = await b.rpc('prices.list', {});
    const sheet = await b.rpc('prices.exportCsv', undefined);
    expect(sheet.csv.trim().split('\r\n')).toHaveLength(prices.length + 1);
    expect(sheet.suggestedName).toMatch(/^flipdesk-prices-.*\.csv$/);

    const before = await b.rpc('rules.list', undefined);
    const backup = await b.rpc('rules.exportJson', undefined);
    expect(backup.suggestedName).toMatch(/\.json$/);
    // Like the service: a lost rule comes back, the ones still there are skipped (never doubled or deleted).
    const lost = before[0]!;
    await b.rpc('rules.delete', { id: lost.id });
    const r = await b.rpc('rules.importJson', { json: backup.json });
    expect(r.added).toBe(1);
    expect(r.skipped).toEqual(before.slice(1).map((x) => `"${x.name}": already in your rules`));
    const after = await b.rpc('rules.list', undefined);
    expect(after).toHaveLength(before.length);
    expect(after.map((x) => x.name).sort()).toEqual(before.map((x) => x.name).sort());
    const twice = await b.rpc('rules.importJson', { json: JSON.stringify({ rules: [{ name: 'dup', filter: {}, costScrap: 2 }, { name: 'dup', filter: {}, costScrap: 2 }] }) });
    expect(twice).toEqual({ added: 1, skipped: ['"dup": repeated in this backup'] });

    const mixed = await b.rpc('rules.importJson', { json: JSON.stringify({ rules: [{ name: '', filter: {}, costScrap: 1 }, { name: 'ok', filter: {}, costScrap: 2 }] }) });
    expect(mixed.added).toBe(1);
    expect(mixed.skipped).toHaveLength(1);
    await expect(b.rpc('rules.importJson', { json: 'not json' })).rejects.toThrow(/JSON/);
  });
});

describe('prefilled quick entry', () => {
  it('holds ui.quickPrefill for the quick-entry page until it subscribes, then sends it at once', async () => {
    const b = make();
    await b.rpc('app.showQuickEntry', { sku: '378;6' });
    const seen: unknown[] = [];
    b.on('ui.quickPrefill', (p) => seen.push(p));
    await Promise.resolve();
    expect(seen).toEqual([{ sku: '378;6' }]);
    await b.rpc('app.showQuickEntry', { sku: '5021;6' });
    await b.rpc('app.showQuickEntry', undefined);
    expect(seen).toEqual([{ sku: '378;6' }, { sku: '5021;6' }]);
    await expect(b.rpc('app.showQuickEntry', { sku: 'javascript:alert(1)' })).rejects.toThrow(/not a SKU/);
  });

  it('lower-cases the SKU like main, so an upper-case effect keeps the effect', async () => {
    const b = make();
    const seen: unknown[] = [];
    b.on('ui.quickPrefill', (p) => seen.push(p));
    await b.rpc('app.showQuickEntry', { sku: ' 378;5;U17 ' });
    await Promise.resolve();
    expect(seen).toEqual([{ sku: '378;5;u17' }]);
  });
});

describe('reference age, suspect margins and notification input kinds', () => {
  it('ignores references older than profit.referenceMaxAgeMs, with a reason', async () => {
    const b = make();
    const { rows } = await b.rpc('opps.list', { limit: 5000 });
    const stale = rows.filter((o) => o.flags.includes('stale-reference'));
    expect(stale.length).toBeGreaterThan(0);
    for (const o of stale) expect(o.reasons.some((r) => / days old, ignored$/.test(r))).toBe(true);

    await b.rpc('settings.set', { profit: { referenceMaxAgeMs: 365 * DAY } });
    const relaxed = await b.rpc('opps.list', { limit: 5000 });
    expect(relaxed.rows.some((o) => o.flags.includes('stale-reference'))).toBe(false);
  });

  it('caps suspect margins at Low; 0 turns the guard off', async () => {
    const b = make();
    await b.rpc('settings.set', { profit: { suspectMargin: 0.01 } });
    const { rows } = await b.rpc('opps.list', { limit: 5000 });
    const suspect = rows.filter((o) => o.flags.includes('suspect-margin'));
    expect(suspect.length).toBeGreaterThan(0);
    for (const o of suspect) {
      expect(o.confidence).toBeLessThanOrEqual(44);
      expect(o.confidenceLevel).toBe('low');
      expect(o.reasons.some((r) => r.startsWith('Margin over 1% with no reference and few buyers'))).toBe(true);
    }
    await b.rpc('settings.set', { profit: { suspectMargin: 0 } });
    expect((await b.rpc('opps.list', { limit: 5000 })).rows.some((o) => o.flags.includes('suspect-margin'))).toBe(false);
  });

  it('notifies only the input kinds the user kept', async () => {
    const b = make();
    await b.rpc('settings.set', { notifications: { minConfidence: 0, minProfitScrap: 0, inputKinds: ['import'] }, profit: { suspectMargin: 0 } });
    const muted = await b.rpc('prices.upsert', { sku: '378;6', costScrap: 1 });
    const notified = async (ref: string) => (await b.rpc('opps.events', { kinds: ['notified'], limit: 2000 })).some((e) => e.key === `378;6|${ref}`);
    expect(await notified(`price:${muted.id}`)).toBe(false);
    await b.rpc('settings.set', { notifications: { inputKinds: ['user'] } });
    const heard = await b.rpc('prices.upsert', { sku: '378;6', costScrap: 2 });
    expect(await notified(`price:${heard.id}`)).toBe(true);
  });
});
