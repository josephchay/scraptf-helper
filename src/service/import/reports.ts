// 0.7.1 (P4): the parser reports a user can copy into a bug report ('import.report'), so real pages read in
// the scrap.tf window can fix what the parser does not know yet. In memory only: a ring of the newest
// IMPORT_REPORT_RING, never stored, logged or sent anywhere. The parser hands over whitelisted fields only
// (card and row fields, no nav, scripts or avatar, no custom-named title, no gift or receipt lines); every
// text is clipped and scrubbed again here, so a long digit run (a SteamID64, an asset id) or a link never
// lands in a report.

import { IMPORT_REPORT_MAX_ITEMS, IMPORT_REPORT_RING, importWarningCode } from '../../shared/importCodes';
import type { ImportOrigin, ImportPageKind, ImportReport, ImportReportItem, ScraptfBank, UnixMs } from '../../shared/types';
import type { ParseDiagnostics } from './scraptfHtml';

/** A digit run this long is an id (a SteamID64 has 17, asset ids 10 and up), never a price or a count. */
const ID_RUN_RE = /\d{9,}/g;
const LINK_RE = /\b(?:https?:\/\/|www\.)\S*/gi;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/** Report text: no control characters, links or id-length digit runs, whitespace collapsed, at most `max` characters. */
export function scrubReportText(s: string, max: number): string {
  const t = String(s).replace(CONTROL_RE, ' ').replace(LINK_RE, '[link]').replace(ID_RUN_RE, '#').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function scrubOrNull(s: string | null | undefined, max: number): string | null {
  return typeof s === 'string' ? scrubReportText(s, max) : null;
}

function idOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** One record, every text field scrubbed and bounded; the shape is the type's whitelist, nothing else is copied. */
function cleanItem(it: ImportReportItem): ImportReportItem {
  const out: ImportReportItem = {
    defindex: idOrNull(it.defindex),
    classTokens: it.classTokens.slice(0, 20).map((c) => scrubReportText(c, 30)),
    title: scrubOrNull(it.title, 160),
    contentLines: it.contentLines.slice(0, 20).map((l) => scrubReportText(l, 120)),
    indicator: scrubOrNull(it.indicator, 40),
    itemValue: scrubOrNull(it.itemValue, 16),
    numAvailable: scrubOrNull(it.numAvailable, 16),
    numSelected: scrubOrNull(it.numSelected, 16),
    particleId: idOrNull(it.particleId),
    warpaintId: idOrNull(it.warpaintId),
    sku: scrubOrNull(it.sku, 120),
    warnings: it.warnings.slice(0, 20).map((w) => scrubReportText(w, 160)),
  };
  if (it.cells) out.cells = it.cells.slice(0, 12).map((c) => scrubReportText(c, 60));
  if (it.limitAttrs) {
    out.limitAttrs = {
      title: scrubOrNull(it.limitAttrs.title, 40),
      dataOriginalTitle: scrubOrNull(it.limitAttrs.dataOriginalTitle, 40),
      dataBsOriginalTitle: scrubOrNull(it.limitAttrs.dataBsOriginalTitle, 40),
      ariaLabel: scrubOrNull(it.limitAttrs.ariaLabel, 40),
    };
  }
  return out;
}

export interface ImportReportInput {
  at: UnixMs;
  origin: ImportOrigin;
  name: string;
  pageKind: ImportPageKind;
  bank: ScraptfBank | null;
  page: string;
  format: ImportReport['format'];
  batchId: number;
  /** The parse's diagnostics (null: no parse happened, a refused read). */
  diagnostics: ParseDiagnostics | null;
  /** The import's page warnings, and every item's (counted by code). */
  warnings: readonly string[];
  itemWarnings?: readonly (readonly string[])[];
  /** Counts and codes only (a throw, a read that recorded nothing): no item records. */
  countsOnly?: boolean;
}

const ZERO_COUNTS: ImportReport['counts'] = { dataDefindex: 0, cards: 0, rows: 0, selectedSkipped: 0, duplicates: 0, lookalikes: 0 };

let ring: ImportReport[] = [];
let nextId = 1;

/** Records one report as the newest (the oldest beyond IMPORT_REPORT_RING is dropped) and returns it. */
export function recordImportReport(input: ImportReportInput): ImportReport {
  const warningCodes: Record<string, number> = {};
  const count = (w: string) => {
    const code = scrubReportText(importWarningCode(w), 40);
    if (code) warningCodes[code] = (warningCodes[code] ?? 0) + 1;
  };
  for (const w of input.warnings) count(w);
  for (const ws of input.itemWarnings ?? []) for (const w of ws) count(w);
  const d = input.diagnostics;
  const report: ImportReport = {
    id: nextId++,
    at: input.at,
    origin: input.origin,
    name: scrubReportText(input.name, 200),
    pageKind: input.pageKind,
    bank: input.bank,
    // A page of no bank (a profile, the front page) is left out: only an importable page's key is useful.
    page: input.pageKind === 'unknown' ? '' : scrubReportText(input.page, 200),
    format: input.format,
    batchId: Number.isSafeInteger(input.batchId) && input.batchId > 0 ? input.batchId : 0,
    counts: d ? { ...ZERO_COUNTS, ...d.counts } : { ...ZERO_COUNTS },
    headerColumns: d ? d.headerColumns.slice(0, 20).map((h) => scrubReportText(h, 40)) : [],
    warningCodes,
    items: d && input.countsOnly !== true ? d.items.slice(0, IMPORT_REPORT_MAX_ITEMS).map(cleanItem) : [],
  };
  ring = [report, ...ring].slice(0, IMPORT_REPORT_RING);
  return report;
}

/** The newest reports first, at most `limit` (1..IMPORT_REPORT_RING). Copies, so a caller cannot change the ring. */
export function importReports(limit: number = IMPORT_REPORT_RING): ImportReport[] {
  const n = Number.isInteger(limit) ? Math.min(IMPORT_REPORT_RING, Math.max(1, limit)) : IMPORT_REPORT_RING;
  return structuredClone(ring.slice(0, n));
}

/** Empties the ring (tests). */
export function clearImportReports(): void {
  ring = [];
  nextId = 1;
}
