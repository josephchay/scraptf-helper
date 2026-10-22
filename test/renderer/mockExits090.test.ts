// 0.9 (#2, #11) mock parity: the browser mock answers break-even with the shared breakEvensOf / breakEvenFor as the
// service does (the Live check's breakEven, the popup demos, the Opportunities CSV's break_even column), follows the
// user's marketplace.tf fee, gives no confidence for the online flag, and answers item.scm in Steam's "$" text so the
// drawer's net line shows. The mock sets no botService and flags no impersonator (E-D8). Nothing leaves the page.

import { afterEach, describe, expect, it } from 'vitest';
import { scmNetView } from '../../src/renderer/breakEvenModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { mockCheckDemo } from '../../src/renderer/mockCheck';
import { breakEvenFor, breakEvensOf, grossBeforeFee } from '../../src/shared/ceiling';
import { CHECK_SAMPLE_TEXT } from '../../src/shared/check';
import { formatScrap } from '../../src/shared/currency';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';

let bridge: MockBridge | null = null;
const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);

function make(): MockBridge {
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  return bridge;
}

afterEach(() => {
  bridge?.dispose();
  bridge = null;
});

/** Minimal RFC 4180 reader (the mock's CSV has no BOM). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

describe('0.9 (#2): break-even in the mock, by the shared rule', () => {
  it("check.text carries breakEvensOf the price, at the settings' fees", async () => {
    const b = make();
    const settings = await b.rpc('settings.get', undefined);
    const r = await b.rpc('check.text', { text: CHECK_SAMPLE_TEXT, source: 'manual' });
    expect(r.status).toBe('item');
    expect(r.price).not.toBeNull();
    expect(r.breakEven).toEqual(breakEvensOf(r.price!.valueScrap, settings.profit, 'buy'));
    expect(r.breakEven!.mode).toBe('buy');
  });

  it('follows the marketplace.tf fee, friction and the reserve the user sets', async () => {
    const b = make();
    const settings = await b.rpc('settings.set', { profit: { marketplaceFeePct: 0.2, exitReservePct: 0.05, frictionScrap: 1 } });
    expect(settings.profit.marketplaceFeePct).toBe(0.2);
    const r = await b.rpc('check.text', { text: CHECK_SAMPLE_TEXT, source: 'manual' });
    const be = r.breakEven!;
    expect(be).toEqual(breakEvensOf(r.price!.valueScrap, settings.profit, 'buy'));
    expect(be.marketplaceFeePct).toBe(0.2);
    expect(be.marketplaceScrap).toBe(grossBeforeFee(be.backpackScrap, 0.2));
    expect(be.frictionScrap).toBe(1);
    expect(be.reserveScrap).toBeGreaterThan(0);
  });

  it('a check with no price carries no break-even; one with a price always does', async () => {
    const b = make();
    let unpriced = 0;
    for (const text of ['Rocket Launcher', 'Team Captain', 'Texas Ten Gallon', 'Taunt: Conga', "Bill's Hat", CHECK_SAMPLE_TEXT]) {
      const r = await b.rpc('check.text', { text, source: 'manual' });
      if (r.status !== 'item') continue;
      if (r.price === null) {
        unpriced++;
        expect('breakEven' in r, text).toBe(false);
      } else expect(r.breakEven, text).toBeDefined();
    }
    expect(unpriced).toBeGreaterThan(0);
  });

  it('the popup demos with a price carry their break-even; the others none', () => {
    const K = 567;
    const s = { ...DEFAULT_SETTINGS, profit: { ...DEFAULT_SETTINGS.profit, exitReservePct: 0.05, frictionScrap: 1 } };
    for (const kind of ['flip', 'over'] as const) {
      const r = mockCheckDemo(kind, T0, K, s);
      expect(r.price, kind).not.toBeNull();
      expect(r.breakEven, kind).toEqual(breakEvensOf(r.price!.valueScrap, s.profit, 'buy'));
    }
    for (const kind of ['no-price', 'not-item'] as const) expect(mockCheckDemo(kind, T0, K, s).breakEven, kind).toBeUndefined();
  });

  it("the Opportunities CSV's break_even column is breakEvenFor each row's cost", async () => {
    const b = make();
    const settings = await b.rpc('settings.set', { profit: { exitReservePct: 0.05, frictionScrap: 2 } });
    const kp = (await b.rpc('status.get', undefined)).keyPrice!.valueScrap;
    const { csv } = await b.rpc('opps.exportCsv', { kind: 'opportunities' });
    const [head, ...rows] = parseCsv(csv);
    // Assert the column's place, not "last": ranking appends four after it in Wave 2 (D10).
    expect(head!.indexOf('break_even')).toBe(head!.indexOf('status') + 1);
    const at = head!.indexOf('break_even');
    const skuAt = head!.indexOf('sku');
    const costAt = head!.indexOf('cost');
    const { rows: opps } = await b.rpc('opps.list', { limit: 5000 });
    expect(rows.length).toBeGreaterThan(0);
    let checked = 0;
    for (const row of rows) {
      const o = opps.find((x) => x.sku === row[skuAt] && formatScrap(x.costScrap, kp) === row[costAt]);
      expect(o, row.join(',')).toBeDefined();
      expect(row[at], o!.key).toBe(formatScrap(breakEvenFor(o!.costScrap, settings.profit, 'buy'), kp));
      checked++;
    }
    expect(checked).toBe(rows.length);
  });
});

describe('0.9 (#11): buyer signals in the mock', () => {
  it('no opportunity reason gives confidence for the online flag', async () => {
    const b = make();
    const { rows } = await b.rpc('opps.list', { limit: 5000 });
    expect(rows.length).toBeGreaterThan(0);
    for (const o of rows) for (const reason of o.reasons) expect(reason, o.key).not.toContain('Buyer is online');
  });

  it('sets no botService and flags no impersonator (it has no client text and no flag)', async () => {
    const b = make();
    const { rows } = await b.rpc('opps.list', { limit: 200 });
    for (const o of rows.slice(0, 20)) {
      const d = (await b.rpc('item.detail', { sku: o.sku }))!;
      for (const order of d.buyOrders) {
        expect('botService' in order, order.listingId).toBe(false);
        expect(order.flags, order.listingId).not.toContain('impersonator');
      }
    }
  });
});

describe("0.9 (#2): item.scm answers in Steam's dollar text", () => {
  it('so the drawer net line reads it', async () => {
    const b = make();
    await b.rpc('settings.set', { connectors: { scm: true } });
    const r = (await b.rpc('item.scm', { sku: '378;6' }))!;
    expect(r.lowest).toMatch(/^\$\d+\.\d{2}$/);
    expect(r.median).toMatch(/^\$\d+\.\d{2}$/);
    expect(scmNetView(r)!.text).toMatch(/^You get \$\d+\.\d{2} of the \$\d+\.\d{2} lowest /);
  });
});
