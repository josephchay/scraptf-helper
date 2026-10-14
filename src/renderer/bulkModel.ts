// Pure helpers for the price sheet: bulk paste preview and commit plan (F7)
// and rules backup import (F7). The pages stay thin; everything here is unit tested.

import { baseSku, fromString } from '../shared/sku';
import type { BulkPriceRow, Scrap, ScrapPrice, ScrapPriceInput } from '../shared/types';

/** The service limits (src/service/priceSheetIo.ts), mirrored so the counter can warn before Preview. */
export const BULK_MAX_LINES = 500;
export const BULK_MAX_BYTES = 100 * 1024;
/** 'rules.importJson' refuses a longer backup. */
export const RULES_JSON_MAX_CHARS = 5_000_000;

export interface BulkInputStats {
  /** Lines the parser reads: not blank and not a # comment. */
  lines: number;
  bytes: number;
  overLines: boolean;
  overBytes: boolean;
}

export function bulkInputStats(text: string): BulkInputStats {
  let lines = 0;
  // Same line breaks as the service's parser, so the counter never passes a paste it refuses.
  for (const l of text.split(/\r\n|\n|\r/)) {
    const t = l.trim();
    if (t && !t.startsWith('#')) lines++;
  }
  const bytes = new TextEncoder().encode(text).length;
  return { lines, bytes, overLines: lines > BULK_MAX_LINES, overBytes: bytes > BULK_MAX_BYTES };
}

// ---------------------------------------------------------------------------
// Commit plan
// ---------------------------------------------------------------------------

export type BulkLineState =
  | { kind: 'error'; message: string }
  /** The same item appears again later in the paste; the later line is saved. */
  | { kind: 'superseded'; byLine: number }
  | { kind: 'add' }
  | { kind: 'update'; id: number; previous: { costKeys: number; costScrap: Scrap }; samePrice: boolean };

export interface BulkPlan {
  /** What saving does with each previewed line, by line number. */
  states: Map<number, BulkLineState>;
  /** The 'prices.bulkUpsert' rows, in paste order. */
  inputs: ScrapPriceInput[];
  added: number;
  updated: number;
  /** Lines that are not saved (errors and earlier repeats). */
  skipped: number;
}

/**
 * The service stores a price under its base SKU with the paint in `special`
 * (rpcHandlers priceRow), so a pasted painted SKU matches on both.
 */
function pastedKey(sku: string): string {
  const paint = fromString(sku.trim()).paint;
  return `${baseSku(sku.trim())}|${paint ?? ''}`;
}

function storedKey(p: ScrapPrice): string {
  return `${baseSku(p.sku)}|${p.special?.paint ?? ''}`;
}

/**
 * Turns a parse preview into 'prices.bulkUpsert' rows. A line updates the
 * user's own typed price for the same item (newest one) instead of adding a
 * duplicate, which the engine would evaluate as a second input; imported
 * prices are left alone so their page provenance is kept. When an item is
 * pasted twice the later line wins, like a sheet edit; the service's parser
 * leaves repeats saveable and relies on this. Two spellings of one stored item
 * (base SKU plus paint) count as a repeat too. `observedAt` is left to the
 * service, so every saved price counts as seen now.
 */
export function planBulkCommit(rows: readonly BulkPriceRow[], existing: readonly ScrapPrice[]): BulkPlan {
  const own = new Map<string, ScrapPrice>();
  for (const p of existing) {
    if (p.source !== 'user') continue;
    const k = storedKey(p);
    const cur = own.get(k);
    if (!cur || p.observedAt > cur.observedAt || (p.observedAt === cur.observedAt && p.id > cur.id)) own.set(k, p);
  }

  const lastLine = new Map<string, number>();
  for (const r of rows) if (r.error === null && r.sku) lastLine.set(pastedKey(r.sku), r.line);

  const states = new Map<number, BulkLineState>();
  const inputs: ScrapPriceInput[] = [];
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const r of rows) {
    if (r.error !== null || !r.sku) {
      states.set(r.line, { kind: 'error', message: r.error ?? 'Item not recognised' });
      skipped++;
      continue;
    }
    const k = pastedKey(r.sku);
    const winner = lastLine.get(k)!;
    if (winner !== r.line) {
      states.set(r.line, { kind: 'superseded', byLine: winner });
      skipped++;
      continue;
    }
    const prev = own.get(k);
    const input: ScrapPriceInput = { sku: r.sku, costKeys: r.costKeys, costScrap: r.costScrap, source: 'user' };
    if (r.name) input.name = r.name;
    if (prev) {
      input.id = prev.id;
      states.set(r.line, {
        kind: 'update',
        id: prev.id,
        previous: { costKeys: prev.costKeys, costScrap: prev.costScrap },
        samePrice: prev.costKeys === r.costKeys && prev.costScrap === r.costScrap,
      });
      updated++;
    } else {
      states.set(r.line, { kind: 'add' });
      added++;
    }
    inputs.push(input);
  }
  return { states, inputs, added, updated, skipped };
}

/** Lines that saving leaves out: errors and earlier repeats of a later line. */
export function isSkipped(state: BulkLineState | undefined): boolean {
  return state?.kind === 'error' || state?.kind === 'superseded';
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One-line preview summary above the Save button. */
export function bulkPlanSummary(plan: Pick<BulkPlan, 'added' | 'updated' | 'skipped'>): string {
  const ready = plan.added + plan.updated;
  const parts = [`${plural(ready, 'price')} ready`];
  if (ready) parts[0] += ` (${plan.added} new, ${plan.updated} ${plan.updated === 1 ? 'update' : 'updates'})`;
  if (plan.skipped) parts.push(`${plural(plan.skipped, 'line')} skipped`);
  return parts.join(', ');
}

/** Toast after 'prices.bulkUpsert'. */
export function bulkCommitMessage(r: { added: number; updated: number }, skipped: number): string {
  const what =
    r.added && r.updated
      ? `Added ${plural(r.added, 'price')} and updated ${r.updated}`
      : r.added
        ? `Added ${plural(r.added, 'price')}`
        : r.updated
          ? `Updated ${plural(r.updated, 'price')}`
          : 'Nothing was saved';
  return skipped ? `${what}. ${plural(skipped, 'line')} skipped.` : `${what}.`;
}

// ---------------------------------------------------------------------------
// Rules backup import
// ---------------------------------------------------------------------------

/** Checked before reading a picked file, so a wrong pick is not loaded into memory. */
export function checkRulesFile(file: { name: string; size: number }): string | null {
  if (!/\.(json|txt)$/i.test(file.name)) return 'Pick a rules backup (.json), as saved by Export rules.';
  if (file.size > RULES_JSON_MAX_CHARS) return 'That file is larger than 5 MB, so it is not a rules backup.';
  return null;
}

/** Notepad saves UTF-8 with a byte-order mark, which JSON.parse rejects. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Toast after 'rules.importJson'; the reasons for skipped rules are listed separately too. */
export function rulesImportToast(r: { added: number; skipped: readonly string[] }): { text: string; tone: 'good' | 'warn' } {
  const head = r.added ? `Imported ${plural(r.added, 'rule')}` : 'No rules imported';
  if (!r.skipped.length) return { text: `${head}.`, tone: r.added ? 'good' : 'warn' };
  const shown = r.skipped.slice(0, 2).join('; ');
  const more = r.skipped.length > 2 ? ` (+${r.skipped.length - 2} more)` : '';
  return { text: `${head}, skipped ${r.skipped.length}: ${shown}${more}`, tone: 'warn' };
}
