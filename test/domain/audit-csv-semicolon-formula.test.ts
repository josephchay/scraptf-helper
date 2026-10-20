// Audit holdings-1: Excel set to a ';' list separator (de-DE, fr-FR...) starts a new cell at every
// ';', even inside a quoted cell, so a backpack.tf persona name like "x;=1+1;" must not leave a
// ';'-field that starts with a formula character. Review rv-domain-shared-1: in that mode a quote is
// honoured only at a field start, so a CR or LF inside the quoted cell also ends the record, and the
// text after it ("x\n=1+1") must not start a new row's first field with a formula character either.
import { describe, expect, it } from 'vitest';
import { CSV_BOM, csvCell, journalCsv } from '../../src/service/domain/csv';
import { holdingsCsv } from '../../src/service/domain/holdings';
import { marketCsv } from '../../src/service/domain/market';
import { shoppingCsv } from '../../src/service/domain/shopping';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { HOLDINGS_CSV_COLUMNS, holdingRow } from '../../src/shared/holdings';
import { scraptfLinkFor, scraptfPageFor } from '../../src/shared/links';
import { MARKET_CSV_COLUMNS } from '../../src/shared/market';
import type { JournalEntry, MarketRow, OrderSummary, ShoppingRow } from '../../src/shared/types';
import { T0 } from './helpers';

const K = 567;
/** [persona name, the text a ',' reader gets back]: an apostrophe after each ';' or line break a formula start follows. */
const HOSTILE: readonly (readonly [string, string])[] = [
  ['x;=1+1;', "x;'=1+1;"],
  ["x;=cmd|' /C calc'!A0;", "x;'=cmd|' /C calc'!A0;"],
  ['x;"=1+1";', `x;'"=1+1";`],
  ['a;@SUM(A1)', "a;'@SUM(A1)"],
  ['a; -1', "a;' -1"],
  ['a;+1', "a;'+1"],
  ['a;\t=1', "a;'\t=1"],
  ['x\n=1+1;', "x\n'=1+1;"],
  ['x;\n=1+1;', "x;'\n'=1+1;"],
  ['x\r\n=1+1;', "x\r\n'=1+1;"],
  ['x\r=1+1;', "x\r'=1+1;"],
  ['x\n@SUM(1);', "x\n'@SUM(1);"],
];

/** Minimal RFC 4180 reader (as in csv.test.ts): the ',' reading must be unchanged apart from the guard. */
function parseCsv(text: string): string[][] {
  expect(text.startsWith(CSV_BOM)).toBe(true);
  const s = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && s[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  return rows;
}

/** Excel in ';' mode: splits on ';' and honours a quote only as a field's first character. */
function semicolonFields(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= line.length) {
    let cell = '';
    if (line[i] === '"') {
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          cell += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++;
          break;
        } else cell += line[i++];
      }
    }
    while (i < line.length && line[i] !== ';') cell += line[i++];
    out.push(cell);
    i++;
  }
  return out;
}

function expectNoFormulaFields(csv: string): void {
  // Excel's ';' mode ends a record at every CR, LF or CRLF, inside a quoted cell too.
  const lines = csv.slice(CSV_BOM.length).split(/\r\n|\r|\n/).filter((l) => l !== '');
  for (const line of lines) {
    for (const f of semicolonFields(line)) expect(f.trimStart(), line).not.toMatch(/^[=+\-@]/);
  }
}

function order(userName: string): OrderSummary {
  return {
    listingId: 'l1',
    steamid: '76561198000000001',
    userName,
    keys: 0,
    metalScrap: 520,
    valueScrap: 520,
    isBot: false,
    online: true,
    lastEventAt: T0,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
  };
}

describe('csvCell guards a formula start after a ";" inside a text cell', () => {
  it('puts an apostrophe after the ";"', () => {
    expect(csvCell('x;=1+1;')).toBe("x;'=1+1;");
    expect(csvCell('a;@SUM(A1)')).toBe("a;'@SUM(A1)");
    expect(csvCell('a;+1')).toBe("a;'+1");
    expect(csvCell('a; -1')).toBe("a;' -1");
    expect(csvCell('a;\t=1')).toBe("a;'\t=1");
    expect(csvCell('x;"=1+1"')).toBe(`"x;'""=1+1"""`);
    expect(csvCell('=a;=b')).toBe("'=a;'=b");
  });

  it('puts an apostrophe after a line break a formula start follows, after the break', () => {
    expect(csvCell('x\n=1+1')).toBe("\"x\n'=1+1\"");
    expect(csvCell('x;\n=1+1')).toBe("\"x;'\n'=1+1\"");
    expect(csvCell('x\r\n=1+1')).toBe("\"x\r\n'=1+1\"");
    expect(csvCell('x\r=1+1')).toBe("\"x\r'=1+1\"");
    expect(csvCell('x\n @SUM(1)')).toBe("\"x\n' @SUM(1)\"");
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('leaves SKUs and ordinary text alone', () => {
    expect(csvCell('5021;6;kt-3;td-205')).toBe('5021;6;kt-3;td-205');
    expect(csvCell('5021;6;u13')).toBe('5021;6;u13');
    expect(csvCell('Bob; the trader')).toBe('Bob; the trader');
    expect(csvCell('a=1')).toBe('a=1');
  });
});

describe('exports with a hostile buyer name', () => {
  it.each(HOSTILE)('holdings: %j', (name, guarded) => {
    const pos = { sku: '5021;6', name: 'Mann Co. Supply Crate Key', qty: 1, costScrap: 500, lots: [{ id: 1, ts: T0, costScrap: 500, keys: 0, scrap: 500, keyPriceScrap: K }] };
    const buy = {
      revenueScrap: 520,
      bestScrap: 520,
      instantScrap: null,
      revenueOrder: order(name),
      bestOrder: order(name),
      buyerCount: 1,
      confidence: 60,
      confidenceLevel: 'medium' as const,
      flags: [],
      lastOrderChangeAt: T0,
    };
    const csv = holdingsCsv([holdingRow(pos, 'hats', buy, DEFAULT_SETTINGS.profit, K)], K);
    expectNoFormulaFields(csv);
    const [header, row] = parseCsv(csv);
    expect(header).toEqual([...HOLDINGS_CSV_COLUMNS]);
    expect(row![0]).toBe('5021;6');
    expect(row![header!.indexOf('buyer')]).toBe(`${guarded} (human)`);
  });

  it.each(HOSTILE)('shopping: %j', (name, guarded) => {
    const r: ShoppingRow = {
      sku: '5021;6',
      name: 'Mann Co. Supply Crate Key',
      category: 'hats',
      bankPageUrl: scraptfPageFor('hats'),
      maxCostScrap: 500,
      revenueScrap: 520,
      revenueOrder: order(name),
      confidence: 60,
      confidenceLevel: 'medium',
      buyerCount: 1,
      knownCostScrap: null,
      knownMaxCostScrap: null,
      underCeiling: null,
      inputKinds: ['user'],
      flags: [],
      updatedAt: T0,
    };
    const csv = shoppingCsv([r], K);
    expectNoFormulaFields(csv);
    const [header, row] = parseCsv(csv);
    expect(row![header!.indexOf('buyer')]).toBe(`${guarded} (human)`);
  });

  it.each(HOSTILE)('Live market: %j', (name, guarded) => {
    const r: MarketRow = {
      sku: '5021;6',
      name: 'Mann Co. Supply Crate Key',
      category: 'hats',
      revenueScrap: 520,
      bestScrap: 520,
      consScrap: 520,
      instantScrap: null,
      revenueOrder: order(name),
      buyerCount: 1,
      maxCostScrap: 500,
      confidence: 60,
      confidenceLevel: 'medium',
      flags: [],
      knownCostScrap: null,
      knownSource: 'none',
      knownObservedAt: null,
      stock: null,
      ruleCostScrap: null,
      profitScrap: null,
      verdict: 'unchecked',
      lastOrderChangeAt: T0,
      evaluatedAt: T0,
      scraptfPaysScrap: null,
      scraptfStock: null,
      scraptfStockLimit: null,
      scraptfFull: false,
      scraptfListAt: null,
      scraptfNewAt: null,
      scraptfListedSince: null,
      scraptfLink: scraptfLinkFor('hats', null),
    };
    const csv = marketCsv([r], K);
    expectNoFormulaFields(csv);
    const [header, row] = parseCsv(csv);
    expect(header).toEqual([...MARKET_CSV_COLUMNS]);
    expect(row![header!.indexOf('buyer')]).toBe(`${guarded} (human)`);
  });

  it.each(HOSTILE)('journal note from the Record-sale prefill: %j', (name, guarded) => {
    const e: JournalEntry = { id: 1, ts: T0, side: 'sell', venue: 'backpack.tf', sku: '5021;6', name: 'Mann Co. Supply Crate Key', keys: 0, scrap: 520, keyPriceScrap: K, note: `Sold to ${name}` };
    const csv = journalCsv([e]);
    expectNoFormulaFields(csv);
    const [header, row] = parseCsv(csv);
    expect(row![header!.indexOf('note')]).toBe(`Sold to ${guarded}`);
  });
});
