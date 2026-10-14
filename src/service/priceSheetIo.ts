// Price-sheet bulk paste and backup (feature F7). Pure helpers: the RPC
// handlers in rpcHandlers.ts do the reading, writing and pushing.
//
// Bulk paste must never become a path around the opt-in saved-page import
// (R10): pasted page content ("<" or a scrap.tf link) is refused as a whole.

import { formatKeysMetal, parsePrice, scrapToRef, valueScrap, type ParsedPrice } from '../shared/currency';
import { fromObject, fromString } from '../shared/sku';
import type { BulkPriceRow, PriceRule, PriceRuleInput, ResolvedItem, Scrap, ScrapPrice, UnixMs } from '../shared/types';
import { toCsv, type CsvCell } from './domain/csv';
import { ruleInputSchema } from './rpcSchemas';

export type BareUnit = 'ref' | 'scrap' | 'keys';

/** Most lines one paste may hold. */
export const MAX_BULK_LINES = 500;
/** Largest paste accepted, in bytes (UTF-8). */
export const MAX_BULK_BYTES = 100 * 1024;
/** Refusal for anything that looks like a saved page (R10). */
export const PAGE_CONTENT_REFUSAL = 'This looks like page content. Use Import for saved pages.';
/** Longest line read. Names and item links are far shorter; this bounds the separator search. */
export const MAX_BULK_LINE_CHARS = 600;
/** Rules one backup may add. More would slow every engine run for no real use. */
export const MAX_IMPORT_RULES = 1000;
export const RULES_BACKUP_FORMAT = 'tf2-flip-desk-rules';
export const RULES_BACKUP_VERSION = 1;
/** Reasons listed one by one; the rest are counted, so a broken file cannot flood the dashboard. */
export const MAX_SKIP_REASONS = 200;

const SEPARATOR_CHARS = '\t,;=@';
const SPACED_DASH = ' - ';
/** "2 keys 5.11 ref" is 4 words; a longer price-looking suffix is part of the name. */
const MAX_PRICE_WORDS = 4;
/** Prices are short; longer right-hand sides are never parsed (bounds the work per line). */
const MAX_PRICE_CHARS = 80;
/** Split points tried per line, so a line full of commas cannot cost hundreds of lookups. */
const MAX_CANDIDATES = 6;
/** Resolver notes that do not change which item is meant. */
const INFO_ONLY_WARNING = /BLU twin/i;

// ---------------------------------------------------------------------------
// Bulk paste
// ---------------------------------------------------------------------------

/** "<" (HTML) or any scrap.tf link, including a bare "https://scrap.tf" without a path. */
export function looksLikePageContent(text: string): boolean {
  return text.includes('<') || /scrap\.tf\//i.test(text) || /:\/\/(?:[a-z0-9-]+\.)*scrap\.tf(?![a-z0-9.-])/i.test(text);
}

/** Text copied out of a CSV export can start with its byte-order mark. */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Spreadsheet and CSV copies quote cells that hold a separator: `"Rock, Paper, Scissors",5 ref`. */
function unquote(s: string): string {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/""/g, '"').trim() : t;
}

function priceOf(text: string, bareUnit: BareUnit): ParsedPrice | null {
  const t = unquote(text);
  return t && t.length <= MAX_PRICE_CHARS ? parsePrice(t, bareUnit) : null;
}

interface Split {
  item: string;
  price: ParsedPrice;
}

/**
 * Every way to read the line as `<item> <sep> <price>`, best first: separators
 * left to right (names may hold commas, "1 key, 5 ref" may too), then the
 * longest price-looking suffix when no separator gives a price.
 */
function splitsOf(line: string, bareUnit: BareUnit): Split[] {
  const out: Split[] = [];
  for (let i = 0; i < line.length && out.length < MAX_CANDIDATES; i++) {
    const width = SEPARATOR_CHARS.includes(line[i]!) ? 1 : line.startsWith(SPACED_DASH, i) ? SPACED_DASH.length : 0;
    if (width === 0) continue;
    const item = unquote(line.slice(0, i));
    if (!item) continue;
    const price = priceOf(line.slice(i + width), bareUnit);
    if (price) out.push({ item, price });
  }
  const words = line.split(/\s+/);
  for (let k = Math.min(MAX_PRICE_WORDS, words.length - 1); k >= 1 && out.length < MAX_CANDIDATES; k--) {
    const item = unquote(words.slice(0, words.length - k).join(' '));
    const price = item ? priceOf(words.slice(words.length - k).join(' '), bareUnit) : null;
    if (item && price && !out.some((s) => s.item === item)) out.push({ item, price });
  }
  return out;
}

/** Why a resolved item cannot be saved unattended: a guess or an incomplete SKU would price the wrong item. */
function itemProblem(r: ResolvedItem): string | null {
  if (r.match === 'fuzzy') return `Closest match only ("${r.name}"). Use the exact name, a SKU or an item link`;
  const w = r.warnings.find((x) => !INFO_ONLY_WARNING.test(x));
  return w ?? null;
}

interface Pick {
  split: Split;
  item: ResolvedItem | null;
  problem: string | null;
}

/**
 * The first split whose item resolves cleanly; else the first that resolves at all; else the first.
 * Every split after a line's first one draws on `spare`, so a paste of odd lines cannot run
 * thousands of fuzzy name searches on the service thread.
 */
function pickSplit(splits: readonly Split[], resolve: (text: string) => ResolvedItem | null, spare: { left: number }): Pick | null {
  let best: Pick | null = null;
  let bestScore = -1;
  for (const [n, split] of splits.entries()) {
    if (n > 0) {
      if (spare.left <= 0) break;
      spare.left--;
    }
    let item: ResolvedItem | null = null;
    try {
      item = resolve(split.item);
    } catch {
      item = null;
    }
    const problem = item ? itemProblem(item) : `Item not recognised: ${split.item.slice(0, 80)}`;
    const score = item === null ? 0 : problem === null ? 2 : 1;
    if (score > bestScore) {
      best = { split, item, problem };
      bestScore = score;
    }
    if (score === 2) break;
  }
  return best;
}

/**
 * One row per non-blank, non-comment line: `<item> <sep> <price>`, the item
 * resolved with `resolve` (schema.resolve), the price with parsePrice. A
 * refusal (page content, too many lines, too large) rejects the whole paste:
 * `rows` is then empty and `refusal` says why. `rejected` counts rows with an error.
 * A row's `sku` is set only when the row can be saved (`error` null), so a
 * preview row with an error can never be written by mistake. An item pasted
 * twice gives two saveable rows; the dashboard keeps the later one.
 */
export function parseBulkPrices(
  text: string,
  bareUnit: BareUnit,
  resolve: (text: string) => ResolvedItem | null,
): { rows: BulkPriceRow[]; rejected: number; refusal: string | null } {
  const refuse = (refusal: string) => ({ rows: [], rejected: 0, refusal });
  const src = stripBom(String(text ?? ''));
  if (looksLikePageContent(src)) return refuse(PAGE_CONTENT_REFUSAL);
  if (utf8Bytes(src) > MAX_BULK_BYTES) return refuse('That paste is larger than 100 KB. Split it into smaller pastes.');
  const lines = src.split(/\r\n|\n|\r/);
  const isItemLine = (raw: string): boolean => {
    const t = raw.trim();
    return t !== '' && !t.startsWith('#');
  };
  const count = lines.filter(isItemLine).length;
  if (count > MAX_BULK_LINES) return refuse(`That paste has ${count} lines; at most ${MAX_BULK_LINES} per paste.`);

  const rows: BulkPriceRow[] = [];
  const spare = { left: MAX_BULK_LINES * 2 };
  lines.forEach((raw, i) => {
    if (!isItemLine(raw)) return;
    const line = raw.trim();
    const row: BulkPriceRow = { line: i + 1, raw, sku: null, name: null, costKeys: 0, costScrap: 0, error: null };
    if (line.length > MAX_BULK_LINE_CHARS) {
      rows.push({ ...row, error: `Line is longer than ${MAX_BULK_LINE_CHARS} characters` });
      return;
    }
    const pick = pickSplit(splitsOf(line, bareUnit), resolve, spare);
    if (!pick) {
      rows.push({ ...row, error: 'No price found (e.g. "Team Captain, 1 key 5 ref")' });
      return;
    }
    const { price } = pick.split;
    const priced: BulkPriceRow = { ...row, name: pick.item?.name ?? null, costKeys: price.keys, costScrap: price.scrap };
    if (pick.problem !== null || pick.item === null) {
      rows.push({ ...priced, error: pick.problem ?? 'Item not recognised' });
      return;
    }
    if (price.keys === 0 && price.scrap === 0) {
      rows.push({ ...priced, error: 'The price is 0' });
      return;
    }
    // A repeated item stays saveable: the preview (bulkModel planBulkCommit) uses its last line, like a sheet edit.
    rows.push({ ...priced, sku: pick.item.sku });
  });
  return { rows, rejected: rows.filter((r) => r.error !== null).length, refusal: null };
}

// ---------------------------------------------------------------------------
// Price sheet CSV
// ---------------------------------------------------------------------------

function iso(ts: UnixMs): string {
  const d = new Date(ts);
  return Number.isFinite(ts) && !Number.isNaN(d.getTime()) ? d.toISOString() : '';
}

/** The SKU the user priced: stored prices keep the paint in `special`, the SKU carries it as `;p<decimal>`. */
function pricedSku(p: ScrapPrice): string {
  const paint = p.special?.paint;
  if (typeof paint !== 'number' || !Number.isInteger(paint) || paint <= 0) return p.sku;
  const obj = fromString(p.sku);
  return obj.paint ? p.sku : fromObject({ ...obj, paint });
}

/**
 * The price sheet as CSV (csv.ts conventions: BOM, CRLF, formula-safe cells).
 * `cost` is written the way parsePrice reads it ("2 keys 5.11 ref") and `sku`
 * includes the paint, so the sku and cost columns pasted back into bulk paste
 * restore the sheet. `cost_ref` values keys at `keyScrap`; it is empty when
 * keys are involved and no key price is known.
 */
export function pricesCsv(prices: readonly ScrapPrice[], keyScrap: Scrap | null): string {
  const key = typeof keyScrap === 'number' && Number.isFinite(keyScrap) && keyScrap > 0 ? keyScrap : null;
  const out: CsvCell[][] = [
    [
      'id',
      'sku',
      'name',
      'cost',
      'cost_keys',
      'cost_metal_ref',
      'cost_ref',
      'key_price_ref',
      'source',
      'observed_at',
      'note',
      'stock',
      'asset_id',
      'paint',
      'spells',
      'parts',
    ],
  ];
  const sorted = [...prices].sort((a, b) => a.name.localeCompare(b.name) || a.sku.localeCompare(b.sku) || a.id - b.id);
  for (const p of sorted) {
    const keys = Number.isFinite(p.costKeys) ? p.costKeys : 0;
    const total = keys === 0 ? p.costScrap : key === null ? null : valueScrap(keys, p.costScrap, key);
    out.push([
      p.id,
      pricedSku(p),
      p.name,
      formatKeysMetal(keys, p.costScrap),
      keys,
      scrapToRef(p.costScrap),
      total === null ? null : scrapToRef(total),
      key === null ? null : scrapToRef(key),
      p.source,
      iso(p.observedAt),
      p.note,
      p.stock,
      p.assetId,
      p.special?.paint ?? null,
      p.special?.spells.join(' | ') ?? null,
      p.special?.parts.join(' | ') ?? null,
    ]);
  }
  return toCsv(out);
}

// ---------------------------------------------------------------------------
// Rules backup
// ---------------------------------------------------------------------------

/** Rules as a versioned JSON backup that rulesFromJson reads back. Ids are left out: an import always adds. */
export function rulesToJson(rules: readonly PriceRule[], exportedAt: UnixMs = Date.now()): string {
  const list = [...rules]
    .sort((a, b) => a.id - b.id)
    .map(({ name, filter, costKeys, costScrap, observedAt, enabled }) => ({ name, filter, costKeys, costScrap, observedAt, enabled }));
  return JSON.stringify({ format: RULES_BACKUP_FORMAT, version: RULES_BACKUP_VERSION, exportedAt, rules: list }, null, 2);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function ruleLabel(raw: unknown, i: number): string {
  const name = isRecord(raw) && typeof raw['name'] === 'string' ? raw['name'].replace(/\s+/g, ' ').trim() : '';
  return name ? `"${name.slice(0, 60)}"` : `Rule ${i + 1}`;
}

/**
 * Rules from a backup, each validated with the rule zod schema used by
 * 'rules.upsert'; invalid ones are left out with a reason in `skipped`.
 * Ids are dropped so imports always add. A bare array of rules is read too.
 * Throws (with a message for the user) when the text is not a rules backup at all.
 */
export function rulesFromJson(json: string): { rules: PriceRuleInput[]; skipped: string[] } {
  let data: unknown;
  try {
    data = JSON.parse(stripBom(String(json ?? '')));
  } catch {
    throw new Error('Not a rules backup: the file is not valid JSON.');
  }
  let list: unknown;
  if (Array.isArray(data)) {
    list = data;
  } else if (isRecord(data)) {
    if (data['format'] !== undefined && data['format'] !== RULES_BACKUP_FORMAT) throw new Error('Not a TF2 Flip Desk rules backup.');
    const version = data['version'];
    if (typeof version === 'number' && version > RULES_BACKUP_VERSION) {
      throw new Error('This rules backup was made by a newer version of TF2 Flip Desk. Update the app to import it.');
    }
    list = data['rules'];
  }
  if (!Array.isArray(list)) throw new Error('Not a rules backup: no "rules" list found.');

  const rules: PriceRuleInput[] = [];
  const skipped: string[] = [];
  let unlisted = 0;
  let leftOut = 0;
  list.forEach((raw, i) => {
    if (rules.length >= MAX_IMPORT_RULES) {
      leftOut++;
      return;
    }
    // Ids are dropped before validation: an id from another machine means nothing here.
    const r = ruleInputSchema.safeParse(isRecord(raw) ? { ...raw, id: undefined } : raw);
    if (!r.success) {
      if (skipped.length >= MAX_SKIP_REASONS) {
        unlisted++;
        return;
      }
      const issue = r.error.issues[0];
      const where = issue && issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : '';
      skipped.push(`${ruleLabel(raw, i)}: ${where}${issue?.message ?? 'invalid rule'}`);
      return;
    }
    const { id: _id, ...rule } = r.data;
    // Money is integer scrap everywhere else; a hand-edited backup may not be.
    rules.push({ ...rule, costScrap: Math.round(rule.costScrap) });
  });
  const plural = (n: number) => `${n} more rule${n === 1 ? '' : 's'}`;
  if (unlisted > 0) skipped.push(`${plural(unlisted)} skipped as invalid`);
  if (leftOut > 0) skipped.push(`${plural(leftOut)} left out: at most ${MAX_IMPORT_RULES} per import`);
  return { rules, skipped };
}
