// CSV exports: RFC 4180 quoting, CRLF line ends and a UTF-8 BOM (so Excel
// detects the encoding). Text cells that a spreadsheet could run as a formula
// get a leading apostrophe; numbers we produce ourselves are written as plain
// numbers so they stay numeric.

import { formatScrap, scrapToRef } from '../../shared/currency';
import type { JournalEntry, Opportunity, OpportunityEvent, OrderSummary, Scrap, UnixMs } from '../../shared/types';
import { journalValue } from './journal';

export type CsvCell = string | number | boolean | null | undefined;

export const CSV_BOM = '﻿';
const CRLF = '\r\n';
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

export function csvCell(v: CsvCell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  let s = String(v);
  if (FORMULA_START.test(s)) s = `'${s}`;
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

function revenueOrder(o: Opportunity): OrderSummary | null {
  if (o.revenueScrap === null) return null;
  return [o.consOrder, o.bestOrder, o.instantOrder].find((x) => x !== null && x.valueScrap === o.revenueScrap) ?? null;
}

export function opportunitiesCsv(rows: readonly Opportunity[], keyScrap: Scrap): string {
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
      'buyers',
      'buyer',
      'flags',
      'key_price_ref',
      'input_observed_at',
      'first_seen_at',
      'updated_at',
    ],
  ];
  const keyRef = ref(keyScrap);
  for (const o of rows) {
    const order = revenueOrder(o);
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
      o.buyerCount,
      order ? (order.isBot ? 'bot' : 'human') : '',
      o.flags.join(' '),
      keyRef,
      iso(o.inputObservedAt),
      iso(o.firstSeenAt),
      iso(o.updatedAt),
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

/** Oldest first, the order FIFO profit is worked out in. */
export function journalCsv(entries: readonly JournalEntry[]): string {
  const out: CsvCell[][] = [['id', 'time', 'side', 'venue', 'sku', 'name', 'keys', 'metal_ref', 'key_price_ref', 'value_ref', 'note']];
  const sorted = [...entries].sort((a, b) => a.ts - b.ts || a.id - b.id);
  for (const e of sorted) {
    out.push([e.id, iso(e.ts), e.side, e.venue, e.sku, e.name, e.keys, ref(e.scrap), ref(e.keyPriceScrap), ref(journalValue(e)), e.note]);
  }
  return toCsv(out);
}
