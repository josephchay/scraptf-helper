import { describe, expect, it } from 'vitest';
import type { JournalEntry, Opportunity, OpportunityEvent } from '../../src/shared/types';
import { CSV_BOM, csvCell, eventsCsv, journalCsv, opportunitiesCsv, toCsv } from '../../src/service/domain/csv';
import { JOURNAL_CSV_COLUMNS } from '../../src/shared/journal';
import { T0 } from './helpers';

/** Minimal RFC 4180 reader for round-trip checks. */
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
  expect(cell).toBe('');
  expect(row).toEqual([]);
  return rows;
}

describe('csvCell', () => {
  it('quotes per RFC 4180', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('cr\rhere')).toBe('"cr\rhere"');
  });

  it('guards text that a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1+2')).toBe("'-1+2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
    // 0.7.3: the '=' after the CR starts a new record in Excel's ';' mode, so it is guarded too.
    expect(csvCell('\r=1')).toBe(`"'\r'=1"`);
    expect(csvCell('a=1')).toBe('a=1');
  });

  it('writes our own numbers as plain numbers and blanks for missing values', () => {
    expect(csvCell(-1.33)).toBe('-1.33');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(Number.NaN)).toBe('');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(true)).toBe('true');
  });

  it('joins rows with CRLF after a UTF-8 BOM', () => {
    expect(toCsv([['a', 'b'], [1, 'ünïcödé']])).toBe('﻿a,b\r\n1,ünïcödé\r\n');
  });
});

describe('exports', () => {
  const opp: Opportunity = {
    key: '378;6|price:1',
    sku: '378;6',
    name: '=cmd|"/c calc"!A1, the "Captain"',
    category: 'hats',
    inputRef: 'price:1',
    inputKind: 'user',
    costKeys: 1,
    costScrapRaw: 12,
    costScrap: 579,
    bestScrap: 700,
    consScrap: 650,
    instantScrap: null,
    revenueScrap: 650,
    profitScrap: 71,
    margin: 0.12262,
    maxCostScrap: null,
    confidence: 72,
    confidenceLevel: 'high',
    flags: ['outlier-best', 'notes-flag'],
    reasons: [],
    buyerCount: 3,
    bestOrder: null,
    consOrder: {
      listingId: 'x',
      steamid: '1',
      userName: null,
      keys: 1,
      metalScrap: 83,
      valueScrap: 650,
      isBot: true,
      online: true,
      lastEventAt: T0,
      bumpedAt: null,
      details: '',
      flags: [],
      eligible: true,
    },
    instantOrder: null,
    references: { pricedb: null, community: null },
    profitTier: 'ref2',
    status: 'profitable',
    inputObservedAt: T0,
    firstSeenAt: T0,
    updatedAt: T0,
  };

  it('exports opportunities with refined values and an injection-safe name', () => {
    const rows = parseCsv(opportunitiesCsv([opp, { ...opp, key: 'k2', profitScrap: -9, margin: null, revenueScrap: null, consOrder: null }], 567));
    const [header, first, second] = rows;
    const col = (name: string) => header!.indexOf(name);
    expect(rows).toHaveLength(3);
    expect(first![col('name')]).toBe(`'=cmd|"/c calc"!A1, the "Captain"`);
    expect(first![col('cost_ref')]).toBe('64.33');
    expect(first![col('cost_metal_ref')]).toBe('1.33');
    expect(first![col('profit_ref')]).toBe('7.88');
    expect(first![col('profit')]).toBe('7.88 ref');
    expect(first![col('margin_pct')]).toBe('12.26');
    expect(first![col('buyer')]).toBe('bot');
    expect(first![col('flags')]).toBe('outlier-best notes-flag');
    expect(first![col('key_price_ref')]).toBe('63');
    expect(first![col('updated_at')]).toBe(new Date(T0).toISOString());
    expect(second![col('profit_ref')]).toBe('-1');
    expect(second![col('profit')]).toBe("'-1.00 ref");
    expect(second![col('margin_pct')]).toBe('');
    expect(second![col('buyer')]).toBe('');
  });

  it('carries the pay-up-to ceiling as a number and as scrap.tf shows it (F1)', () => {
    const rows = parseCsv(opportunitiesCsv([{ ...opp, maxCostScrap: 650 }, { ...opp, key: 'k2', maxCostScrap: 81 }, { ...opp, key: 'k3', maxCostScrap: null }], 567));
    const [header, ...body] = rows;
    const col = (name: string) => header!.indexOf(name);
    expect(header!.slice(col('margin_pct'), col('buyers') + 1)).toEqual(['margin_pct', 'pay_up_to_ref', 'pay_up_to', 'buyers']);
    expect(body.map((r) => [r[col('pay_up_to_ref')], r[col('pay_up_to')]])).toEqual([
      ['72.22', '1 key 9.22 ref'],
      ['9', '9.00 ref'],
      ['', ''],
    ]);
  });

  it('exports events', () => {
    const ev: OpportunityEvent = {
      id: 7,
      key: 'k',
      sku: '378;6',
      name: 'Team Captain',
      category: 'hats',
      kind: 'changed',
      profitScrap: 18,
      costScrap: 90,
      revenueScrap: 108,
      confidence: 80,
      summary: 'profit 1.00 ref -> 2.00 ref (bot, online)',
      ts: T0,
    };
    const rows = parseCsv(eventsCsv([ev]));
    expect(rows[0]).toEqual(['id', 'time', 'kind', 'sku', 'name', 'category', 'profit_ref', 'cost_ref', 'revenue_ref', 'confidence', 'summary']);
    expect(rows[1]).toEqual(['7', new Date(T0).toISOString(), 'changed', '378;6', 'Team Captain', 'hats', '2', '10', '12', '80', 'profit 1.00 ref -> 2.00 ref (bot, online)']);
  });

  it('exports the journal oldest first with each row valued at its key price', () => {
    const j = (id: number, ts: number, over: Partial<JournalEntry> = {}): JournalEntry => ({
      id,
      ts,
      side: 'buy',
      venue: 'scrap.tf',
      sku: '378;6',
      name: 'Team Captain',
      keys: 0,
      scrap: 12,
      keyPriceScrap: 567,
      note: null,
      ...over,
    });
    const rows = parseCsv(journalCsv([j(2, T0 + 1000, { side: 'sell', keys: 1, scrap: 3, note: '@admin, "quoted"' }), j(1, T0)]));
    expect(rows.map((r) => r[0])).toEqual(['id', '1', '2']);
    expect(rows[0]).toEqual([...JOURNAL_CSV_COLUMNS]);
    // 0.8 (J5): the earlier 11 cells unchanged, then the fee (none recorded), the FIFO state and the booked pair.
    expect(rows[2]).toEqual([
      '2',
      new Date(T0 + 1000).toISOString(),
      'sell',
      'scrap.tf',
      '378;6',
      'Team Captain',
      '1',
      '0.33',
      '63',
      '63.33',
      `'@admin, "quoted"`,
      '',
      '',
      'closed',
      '1',
      '1.33',
      '63.33',
      '',
      '62',
      '0',
    ]);
    // The buy it closed carries its state and no pair.
    expect(rows[1]!.slice(11)).toEqual(['', '', 'closed', '', '', '', '', '', '']);
  });

  it('0.8 (J5): lists a same-minute buy before its sale, marks waiting sales, and still guards text cells', () => {
    const j = (id: number, ts: number, over: Partial<JournalEntry> = {}): JournalEntry => ({
      id,
      ts,
      side: 'buy',
      venue: 'scrap.tf',
      sku: '378;6',
      name: 'Team Captain',
      keys: 0,
      scrap: 12,
      keyPriceScrap: 567,
      note: null,
      ...over,
    });
    const rows = parseCsv(
      journalCsv([
        // The sale was recorded first (lower id) at the buy's own minute: FIFO order puts the buy first.
        j(1, T0, { side: 'sell', scrap: 10, venue: '@bp', feeKeys: 0, feeScrap: 1 }),
        j(2, T0, { feeScrap: 2 }),
        // A sale of an item with no buy before it waits.
        j(3, T0 + 1000, { side: 'sell', sku: '5021;6', venue: '=venue', note: '-note' }),
      ]),
    );
    expect(rows.map((r) => r[0])).toEqual(['id', '2', '1', '3']);
    const at = (r: string[], col: string): string => r[JOURNAL_CSV_COLUMNS.indexOf(col)]!;
    // The buy: its fee recorded, open until the sale closed it.
    expect(at(rows[1]!, 'fee_metal_ref')).toBe('0.22');
    expect(at(rows[1]!, 'fifo')).toBe('closed');
    // The sale: cost 12 + 2 fee, proceeds 10 - 1 fee, a negative profit written as a plain number.
    expect(rows[2]!.slice(11)).toEqual(['0', '0.11', 'closed', '2', '1.55', '1', '0.33', '-0.55', '0']);
    expect(at(rows[2]!, 'venue')).toBe(`'@bp`);
    // The waiting sale: no pair, and its venue and note keep their formula guard.
    expect(rows[3]!.slice(11)).toEqual(['', '', 'waiting', '', '', '', '', '', '']);
    expect(at(rows[3]!, 'venue')).toBe(`'=venue`);
    expect(at(rows[3]!, 'note')).toBe(`'-note`);
  });

  it('writes a header even with no rows', () => {
    expect(parseCsv(opportunitiesCsv([], 567))).toHaveLength(1);
    expect(parseCsv(eventsCsv([]))).toHaveLength(1);
    expect(parseCsv(journalCsv([]))).toHaveLength(1);
  });
});
