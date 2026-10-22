// CSV exports: RFC 4180 quoting, CRLF line ends and a UTF-8 BOM (so Excel
// detects the encoding). Text cells that a spreadsheet could run as a formula
// get a leading apostrophe, and so does a formula start after a ';' or a line
// break inside a text cell (Excel set to a ';' list separator starts a new
// cell or record there); numbers we produce ourselves are written as plain
// numbers so they stay numeric.

import { formatScrap, scrapToRef } from '../../shared/currency';
import type { JournalEntry, Opportunity, OpportunityEvent, Scrap, UnixMs } from '../../shared/types';
import { JOURNAL_CSV_COLUMNS, journalCsvCells, journalLedger } from '../../shared/journal';
import type { JournalLotValuer } from '../../shared/journal';
import { revenueOrderByValue } from './engine';
import { breakEvenFor, type BreakEvenSettings } from '../../shared/ceiling';
import { liquidityTagOf } from '../../shared/exitRisk';

export type CsvCell = string | number | boolean | null | undefined;

export const CSV_BOM = '﻿';
const CRLF = '\r\n';
const FORMULA_START = /^[=+\-@\t\r]/;
// 0.7.3: Excel set to a ';' list separator starts a new cell at every ';', even inside a quoted cell,
// so a ';' followed (after optional spaces or quotes) by a formula start gets the apostrophe too.
// Quoting would not help: a quote mid-field is not honoured. SKUs never put = + - @ after a ';'.
// For the same reason a CR, LF or CRLF inside the quoted cell ends the record there, so the text after
// it starts a new row's first cell: a formula start after a line break gets the apostrophe as well,
// placed after the break (CRLF is matched as one break).
const FORMULA_AFTER_SEPARATOR = /(;|\r\n|\r|\n)(?=[\t\r]|[\s"]*[=+\-@])/g;
const NEEDS_QUOTES = /[",\r\n]/;

export function csvCell(v: CsvCell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  let s = String(v);
  if (FORMULA_START.test(s)) s = `'${s}`;
  s = s.replace(FORMULA_AFTER_SEPARATOR, "$1'");
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: readonly (readonly CsvCell[])[]): string {
  return CSV_BOM + rows.map((r) => r.map(csvCell).join(',')).join(CRLF) + CRLF;
}

function ref(scrap: Scrap | null | undefined): number | null {
  return typeof scrap === 'number' && Number.isFinite(scrap) ? scrapToRef(scrap) : null;
}

function iso(ts: UnixMs | null | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** The Opportunities CSV; 0.9 (#2): `profit` (the buy settings) fills break_even_ref, empty without it. */
export function opportunitiesCsv(rows: readonly Opportunity[], keyScrap: Scrap, profit: BreakEvenSettings | null = null): string {
  const out: CsvCell[][] = [
    [
      'sku',
      'name',
      'category',
      'input',
      'input_ref',
      'status',
      'profit_tier',
      'confidence',
      'confidence_level',
      'cost_keys',
      'cost_metal_ref',
      'cost_ref',
      'best_ref',
      'conservative_ref',
      'instant_ref',
      'revenue_ref',
      'profit_ref',
      'profit',
      'margin_pct',
      // F1: the highest scrap.tf price that still clears the thresholds, as a number and as scrap.tf shows it.
      'pay_up_to_ref',
      'pay_up_to',
      'buyers',
      'buyer',
      'flags',
      'key_price_ref',
      'input_observed_at',
      'first_seen_at',
      'updated_at',
      // 0.9 (#2): the lowest backpack.tf sale price that loses nothing at this cost (friction and reserve); empty without settings.
      'break_even_ref',
      // 0.9 (#3): the risk keys (exitRiskAt); blank on a row stored before V16 until the engine rewrites it (D10 names).
      'backup_profit_ref',
      'profitable_depth',
      'book_depth',
      'book_depth_tag',
    ],
  ];
  const keyRef = ref(keyScrap);
  for (const o of rows) {
    const order = revenueOrderByValue(o);
    const ceiling = typeof o.maxCostScrap === 'number' && Number.isFinite(o.maxCostScrap) ? o.maxCostScrap : null;
    out.push([
      o.sku,
      o.name,
      o.category,
      o.inputKind,
      o.inputRef,
      o.status,
      o.profitTier,
      o.confidence,
      o.confidenceLevel,
      o.costKeys,
      ref(o.costScrapRaw),
      ref(o.costScrap),
      ref(o.bestScrap),
      ref(o.consScrap),
      ref(o.instantScrap),
      ref(o.revenueScrap),
      ref(o.profitScrap),
      o.profitScrap === null ? '' : formatScrap(o.profitScrap, keyScrap),
      o.margin === null || !Number.isFinite(o.margin) ? null : Math.round(o.margin * 10_000) / 100,
      ref(ceiling),
      ceiling === null ? '' : formatScrap(ceiling, keyScrap),
      o.buyerCount,
      order ? (order.isBot ? 'bot' : 'human') : '',
      o.flags.join(' '),
      keyRef,
      iso(o.inputObservedAt),
      iso(o.firstSeenAt),
      iso(o.updatedAt),
      ref(profit ? breakEvenFor(o.costScrap, profit, 'buy') : null),
      ref(o.backupProfitScrap ?? null),
      typeof o.profitableDepth === 'number' ? o.profitableDepth : null,
      typeof o.bookDepth === 'number' ? o.bookDepth : null,
      liquidityTagOf(o.bookDepth) ?? '',
    ]);
  }
  return toCsv(out);
}

export function eventsCsv(events: readonly OpportunityEvent[]): string {
  const out: CsvCell[][] = [
    ['id', 'time', 'kind', 'sku', 'name', 'category', 'profit_ref', 'cost_ref', 'revenue_ref', 'confidence', 'summary'],
  ];
  for (const e of events) {
    out.push([e.id, iso(e.ts), e.kind, e.sku, e.name, e.category, ref(e.profitScrap), ref(e.costScrap), ref(e.revenueScrap), e.confidence, e.summary]);
  }
  return toCsv(out);
}

/**
 * 0.8 (J5): the ledger in FIFO order (journalOrder; before, (ts, id) listed a same-minute sale before its buy), each
 * row with its fee and FIFO state and, on a sale, the buy it closed, its cost, proceeds, fees, profit and hold.
 * 0.9: three appended columns, worth_now_ref, unrealised_ref and valued_at, value each open buy with `valuer`
 * (shared/holdings.ts journalValuerOf over a holdings read); blank on other rows and without a valuer.
 */
export function journalCsv(entries: readonly JournalEntry[], valuer: JournalLotValuer | null = null): string {
  return toCsv([JOURNAL_CSV_COLUMNS, ...journalLedger(entries, valuer).map(journalCsvCells)]);
}
