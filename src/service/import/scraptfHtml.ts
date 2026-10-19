// Parser for scrap.tf pages that the user saved themselves (Ctrl+S). The file is
// untrusted: it is parsed with parse5 only (no script execution) and no URL found
// in it is ever resolved or fetched. Markup reference: DESIGN_BRIEF §3.3, checked
// against web.archive.org copies of scrap.tf pages.

import { parse, parseFragment } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { z } from 'zod';
import { parsePrice } from '../../shared/currency';
import { IMPORT_REFUSAL_CODES, IMPORT_REPORT_MAX_ITEMS, LAYOUT_CHANGED, NO_PRICE_COLUMN, NO_STOCK_LIMIT, importWarningCode } from '../../shared/importCodes';
import { fromObject, normalizeSkuObject } from '../../shared/sku';
import { SCRAPTF_BANK_IDS } from '../../shared/types';
import type { ImportPageKind, ImportReport, ImportReportItem, ParsedScrapItem, ScraptfBank, SkuObject, SpecialAttrs } from '../../shared/types';
import { SERIESLESS_CRATES } from '../connectors/schemaNames';
import type { PaintkitRow, SchemaItemRow, SchemaService } from '../contracts';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type TextNode = DefaultTreeAdapterTypes.TextNode;

/** Largest saved page accepted (bytes of UTF-8). */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
/** data-title / data-content longer than this are truncated before fragment parsing. */
const MAX_ATTR_HTML = 64 * 1024;
/**
 * Untrusted text is clipped to these lengths before any regex runs over it, so
 * a crafted page cannot make matching slow (real values are far shorter).
 */
const MAX_TITLE_CHARS = 512;
const MAX_STYLE_CHARS = 2048;
/** Item names, including a quoted custom name (at most 40 characters on Steam). */
const MAX_NAME_CHARS = 256;
/** Page-address hints (canonical, og:url, saved-from) longer than this, or nested deeper in archive links, are ignored. */
const MAX_URL_CHARS = 4096;
const MAX_ARCHIVE_DEPTH = 3;

export class ImportTooLargeError extends Error {
  override readonly name = 'ImportTooLargeError';
  constructor(readonly bytes: number, readonly limit: number = MAX_IMPORT_BYTES) {
    super(`Saved page is too large (${Math.ceil(bytes / 1024 / 1024)} MB; limit ${Math.round(limit / 1024 / 1024)} MB)`);
  }
}

export interface ScrapTfParseResult {
  pageKind: ImportPageKind;
  /**
   * F15: the scrap.tf page the file was saved from (/buy/<slug>, /unusuals, /items[/n] -> 'list'), or
   * null when it cannot be told. importSavedPage stores it as ImportBatch.bank.
   */
  bank: ScraptfBank | null;
  /**
   * F17: which page of its bank the file is (scraptfPageKey: '/buy/hats', '/items/2', '/unusuals/378',
   * or the body id of a file with no address), so bank stock compares two saves of the same page only.
   */
  page: string;
  items: ParsedScrapItem[];
  warnings: string[];
  /**
   * 0.7.1 (P4): what the parser saw, for the sanitized parser report ('import.report'); only with
   * ParseOptions.diagnostics. Whitelisted card and row fields only, never the nav, scripts or avatar.
   */
  diagnostics?: ParseDiagnostics;
}

/** 0.7.1 (P4) ScrapTfParseResult.diagnostics: the report's counts, header and item records (reports.ts sanitizes the text). */
export interface ParseDiagnostics {
  counts: ImportReport['counts'];
  headerColumns: string[];
  /** At most IMPORT_REPORT_MAX_ITEMS: refused items and items with a guess or mismatch code. */
  items: ImportReportItem[];
}

/**
 * Warnings are "code: detail" strings. Item codes: invalid-attribute, no-defindex,
 * unknown-item, name-unmatched, unparsed-name, unknown-quality, quality-mismatch,
 * unknown-effect, effect-mismatch, unusual-without-effect, ambiguous-paint,
 * unknown-paint, paint-mismatch, paintkit-unresolved, paintkit-mismatch,
 * paintkit-inferred, wear-unresolved, wear-mismatch, killstreak-mismatch,
 * sheen-mismatch, needs-target, unparsed-modifier, reserved, not-tradable,
 * series-mismatch, series-unresolved, series-inferred, price-mismatch, unparsed-price, no-price,
 * no-pays-price, unparsed-pays-price, no-stock-limit (0.7.1: an /items row whose "Item Limits"
 * could not be read), parse-error.
 * Page codes: not-scraptf, page-not-importable, page-kind-guessed,
 * page-kind-unknown, unknown-bank, schema-not-loaded, duplicate-cards, no-items,
 * no-cards-saved (F18: a bank page saved without its cards), no-sku, no-pays-column,
 * layout-changed (0.7.1: item-like elements in no shape the parser knows), no-price-column (0.7.1:
 * an /items table with headers but no "Price to buy"),
 * and from an .mhtml file (savedPage.ts): mhtml-invalid, mhtml-too-many-parts,
 * mhtml-no-html, mhtml-truncated (the file ends inside its page: nothing imported),
 * mhtml-charset; and too-large for a file the folder watch would not read
 * (recordSkippedImport in rpcHandlers.ts).
 * The pays codes only concern the /items "Price we pay" column (F14); they never
 * make an item unimportable (isImportableItem reads the price to buy).
 */
export function warningCode(warning: string): string {
  const i = warning.indexOf(':');
  return i < 0 ? warning : warning.slice(0, i);
}

/**
 * True when the item has a SKU and a usable price (the importer stores only these). 0.7.1 (P1): an /items
 * row whose stock could not be read is not one either: a sold-out row would otherwise read as buyable.
 */
export function isImportableItem(item: ParsedScrapItem): boolean {
  if (item.sku === null) return false;
  if (item.warnings.some((w) => warningCode(w) === NO_STOCK_LIMIT)) return false;
  return sellsPriceOf(item) !== null;
}

/**
 * The price to buy an item at (what scrap.tf charges), or null when the page shows none: no cell,
 * text that is not a price ("Sold out" on the /items list), or zero. A "Sold out" row keeps
 * costScrap 0 plus a warning for the price path; the saved list stores it with no price to buy.
 */
export function sellsPriceOf(item: ParsedScrapItem): { keys: number; scrap: number } | null {
  if (item.costKeys <= 0 && item.costScrap <= 0) return null;
  const unpriced = item.warnings.some((w) => {
    const c = warningCode(w);
    return c === 'no-price' || c === 'unparsed-price';
  });
  return unpriced ? null : { keys: item.costKeys, scrap: item.costScrap };
}

// ---------------------------------------------------------------------------
// Game constants (stable game data; DESIGN_BRIEF §4.3)
// ---------------------------------------------------------------------------

const WEAR_BY_NAME: Record<string, number> = {
  'factory new': 1,
  'minimal wear': 2,
  'field-tested': 3,
  'well-worn': 4,
  'battle scarred': 5,
};
const WEAR_SUFFIX_RE = /\s*\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle Scarred)\)\s*$/i;

const SHEENS: Record<number, string> = {
  1: 'Team Shine',
  2: 'Deadly Daffodil',
  3: 'Manndarin',
  4: 'Mean Green',
  5: 'Agonizing Emerald',
  6: 'Villainous Violet',
  7: 'Hot Rod',
};
const KILLSTREAKERS: Record<number, string> = {
  2002: 'Fire Horns',
  2003: 'Cerebral Discharge',
  2004: 'Tornado',
  2005: 'Flames',
  2006: 'Singularity',
  2007: 'Incinerator',
  2008: 'Hypno-Beam',
};

/** Hex shared by Legacy Paint (RED) and Team Spirit (BLU); only the tooltip can tell them apart. */
const AMBIGUOUS_PAINT_HEX = '#5885a2';

/**
 * Paint name -> RED decimal (sku.pricedb.io /api/paint/list, DESIGN_BRIEF §4.5).
 * Only used when the tooltip names a paint and the hex is missing or ambiguous,
 * because SchemaService has no lookup by paint name.
 */
const PAINT_DECIMAL_BY_NAME: Record<string, number> = {
  'a color similar to slate': 3100495,
  'a deep commitment to purple': 8208497,
  'a distinctive lack of hue': 1315860,
  "a mann's mint": 12377523,
  'after eight': 2960676,
  'aged moustache grey': 8289918,
  'an air of debonair': 6637376,
  'an extraordinary abundance of tinge': 15132390,
  'australium gold': 15185211,
  'balaclavas are forever': 3874595,
  'color no. 216-190-216': 14204632,
  'cream spirit': 12807213,
  'dark salmon injustice': 15308410,
  'drably olive': 8421376,
  'indubitably green': 7511618,
  'legacy paint': 5801378,
  'mann co. orange': 13595446,
  'muskelmannbraun': 10843461,
  "noble hatter's violet": 5322826,
  "operator's overalls": 4732984,
  'peculiarly drab tincture': 12955537,
  'pink as hell': 16738740,
  'radigan conagher brown': 6901050,
  'team spirit': 12073019,
  'the bitter taste of defeat and lime': 3329330,
  "the color of a gentlemann's business pants": 15787660,
  'the value of teamwork': 8400928,
  'waterlogged lab coat': 11049612,
  'ye olde rustic colour': 8154199,
  "zepheniah's greed": 4345659,
};

// Strange counters shown on every strange item; anything else in "(Name: N)" form is a part.
const BASE_STRANGE_COUNTERS = new Set(['kills', 'kill assists', 'ubers', 'sentry kills', 'points scored']);

// Items whose SKU needs a target / output (td-, od-, oq-) that the card does not carry.
const NEEDS_TARGET_RE = /(?:Kit Fabricator|Strangifier|Unusualifier|Chemistry Set)$|\bKillstreak\b.*\bKit$/;

// "Strange Part: X" and similar tools are items, not elevated-strange versions of something.
const STRANGE_TOOL_RE = /^Strange (?:Part:|Cosmetic Part:|Filter:|Count Transfer Tool\b|Bacon Grease\b)/;

// ---------------------------------------------------------------------------
// Attribute validation (zod)
// ---------------------------------------------------------------------------

const intString = (max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,15}$/)
    .transform(Number)
    .pipe(z.number().int().min(0).max(max));

const CardAttrsSchema = z.looseObject({
  'data-defindex': intString(10_000_000).optional(),
  'data-id': z.string().trim().regex(/^\d{1,20}$/).optional(),
  'data-item-value': intString(1_000_000_000).optional(),
  'data-num-available': intString(1_000_000).optional(),
  'data-title': z.string().optional(),
  'data-content': z.string().optional(),
  'data-content2': z.string().optional(),
  'data-custom-content': z.string().optional(),
  class: z.string().optional(),
  style: z.string().optional(),
});

const RowAttrsSchema = z.looseObject({
  'data-quality': intString(255).optional(),
  'data-defindex': intString(10_000_000).optional(),
  'data-type': z.string().optional(),
  'data-slot': z.string().optional(),
});

function clip(s: string, n = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Validates attributes; invalid ones are dropped with a warning instead of failing the card. */
function validateAttrs<T>(schema: z.ZodType<T>, attrs: Record<string, string>, warnings: string[]): T {
  const input: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) if (v.trim() !== '') input[k] = v;
  for (let attempt = 0; attempt < 10; attempt++) {
    const r = schema.safeParse(input);
    if (r.success) return r.data;
    let removed = false;
    for (const issue of r.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && key in input) {
        warnings.push(`invalid-attribute: ${key}="${clip(input[key] ?? '', 40)}"`);
        delete input[key];
        removed = true;
      }
    }
    if (!removed) break;
  }
  return schema.parse({});
}

// ---------------------------------------------------------------------------
// parse5 helpers (iterative; saved pages can be deep)
// ---------------------------------------------------------------------------

function isElement(n: Node): n is Element {
  return 'tagName' in n;
}

function childNodesOf(n: Node): Node[] {
  return 'childNodes' in n ? (n.childNodes as Node[]) : [];
}

function attrsOf(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of el.attrs) if (!(a.name in out)) out[a.name] = a.value;
  return out;
}

function getAttr(el: Element, name: string): string | null {
  for (const a of el.attrs) if (a.name === name) return a.value;
  return null;
}

function classesOf(el: Element): string[] {
  const c = getAttr(el, 'class');
  return c ? c.split(/\s+/).filter(Boolean) : [];
}

const SKIP_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template']);

function textContent(root: Node): string {
  let out = '';
  const stack: Node[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.nodeName === '#text') {
      out += (n as TextNode).value;
      continue;
    }
    if (isElement(n) && n !== root && SKIP_TEXT_TAGS.has(n.tagName)) continue;
    const kids = childNodesOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return out.replace(/\s+/g, ' ').trim();
}

function descendants(root: Element): Element[] {
  const out: Element[] = [];
  const stack: Node[] = [...childNodesOf(root)].reverse();
  while (stack.length) {
    const n = stack.pop()!;
    if (!isElement(n)) continue;
    out.push(n);
    const kids = childNodesOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return out;
}

const BLOCK_TAGS = new Set(['div', 'p', 'li', 'ul', 'ol', 'tr', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr']);
const LINE_BREAK = Symbol('br');

/** Text lines of an HTML snippet stored in an attribute (data-title / data-content). */
export function htmlAttrLines(src: string): string[] {
  if (!src || !src.trim()) return [];
  const frag = parseFragment(src.length > MAX_ATTR_HTML ? src.slice(0, MAX_ATTR_HTML) : src);
  let buf = '';
  const stack: (Node | typeof LINE_BREAK)[] = [...childNodesOf(frag)].reverse();
  while (stack.length) {
    const n = stack.pop()!;
    if (n === LINE_BREAK) {
      buf += '\n';
      continue;
    }
    if (n.nodeName === '#text') {
      buf += (n as TextNode).value;
      continue;
    }
    if (!isElement(n)) continue;
    if (n.tagName === 'br') {
      buf += '\n';
      continue;
    }
    if (SKIP_TEXT_TAGS.has(n.tagName) || n.tagName === 'img') continue;
    if (BLOCK_TAGS.has(n.tagName)) {
      buf += '\n';
      stack.push(LINE_BREAK);
    }
    const kids = childNodesOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return buf
    .split('\n')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

function component(num: string, percent: string | undefined): number {
  const n = Math.max(0, Number.parseFloat(num));
  if (!Number.isFinite(n)) return 0;
  return percent ? Math.floor((255 * Math.min(100, n)) / 100) : Math.min(255, Math.round(n));
}

/** "#7d4071", "#abc", "rgb(125, 64, 113)", "rgba(…)" or a CSS declaration containing one -> "#rrggbb". */
export function cssColorToHex(value: string): string | null {
  const v = value.trim().toLowerCase();
  const hex = /#([0-9a-f]{6}|[0-9a-f]{3})\b/.exec(v);
  if (hex) {
    const h = hex[1]!;
    return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`;
  }
  // Separators are "," with optional spaces, or spaces alone: one way to match a run of spaces, so linear time.
  const rgb = /rgba?\(\s*(-?[\d.]+)(%?)(?:\s*,\s*|\s+)(-?[\d.]+)(%?)(?:\s*,\s*|\s+)(-?[\d.]+)(%?)/.exec(v);
  if (rgb) {
    const n = (component(rgb[1]!, rgb[2]) << 16) + (component(rgb[3]!, rgb[4]) << 8) + component(rgb[5]!, rgb[6]);
    return `#${(0x1000000 + n).toString(16).slice(1)}`;
  }
  return null;
}

/** background / background-color value from an inline style. */
function backgroundColorOf(style: string): string | null {
  const decls = style.slice(0, MAX_STYLE_CHARS).split(';');
  for (const d of decls) {
    const m = /^\s*background(?:-color)?\s*:\s*(.+)$/i.exec(d);
    if (!m) continue;
    // An unclosed url( runs to the end of the declaration (removed in one match, not rescanned per "url(").
    const hex = cssColorToHex(m[1]!.replace(/url\([^)]*(?:\)|$)/gi, ''));
    if (hex) return hex;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Page kind
// ---------------------------------------------------------------------------

export interface PageHint {
  kind: ImportPageKind;
  /**
   * F15: the scrap.tf page it names (/buy/<slug> by slug, /unusuals and /buy/unusuals, /items[/n] ->
   * 'list'); null off scrap.tf, on other paths, and for a /buy/<slug> this app does not know.
   */
  bank: ScraptfBank | null;
  host: string;
  path: string;
  scrapTf: boolean;
}

/** The /buy/<slug> banks: every bank but the list, by its own id (unusuals also answers at /unusuals). */
const BUY_SLUG_BANKS: ReadonlyMap<string, ScraptfBank> = new Map(
  SCRAPTF_BANK_IDS.filter((b) => b !== 'list').map((b) => [b, b] as const),
);

/** Lower-cased first segment after /buy/ (the bank slug), or null. */
function buySlugOf(path: string): string | null {
  const m = /^\/buy\/([^/]{1,200})/i.exec(path);
  return m ? m[1]!.toLowerCase() : null;
}

function isScrapTfHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'scrap.tf' || h.endsWith('.scrap.tf');
}

/** Maps a page URL (never fetched) to the import page kind and the scrap.tf bank it names. */
export function pageKindFromUrl(raw: string, depth = 0): PageHint | null {
  // Real page addresses are short and archive links nest once; a crafted page could nest thousands.
  if (raw.length > MAX_URL_CHARS || depth > MAX_ARCHIVE_DEPTH) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (host === 'web.archive.org') {
    const m = /^\/web\/[^/]+\/(.+)$/.exec(url.pathname + url.search);
    if (m) {
      const inner = m[1]!;
      const hint = pageKindFromUrl(/^https?:\/\//i.test(inner) ? inner : `https://${inner}`, depth + 1);
      if (hint) return hint;
    }
  }
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (!isScrapTfHostname(host)) return { kind: 'unknown', bank: null, host, path, scrapTf: false };
  const p = path.toLowerCase();
  let kind: ImportPageKind = 'unknown';
  let bank: ScraptfBank | null = null;
  if (/^\/buy\/unusuals?(\/|$)/.test(p) || /^\/unusuals?(\/|$)/.test(p)) {
    kind = 'unusuals';
    bank = 'unusuals';
  } else if (/^\/buy\/[^/]+/.test(p)) {
    kind = 'buy';
    // An unknown slug stays null (the caller warns): its items still import, coverage falls back to categories.
    bank = BUY_SLUG_BANKS.get(buySlugOf(p) ?? '') ?? null;
  } else if (/^\/items(\/\d+)?$/.test(p)) {
    kind = 'items-list';
    bank = 'list';
  }
  return { kind, bank, host, path, scrapTf: true };
}

/** A page key longer than this is clipped: real scrap.tf paths are far shorter, and the file is untrusted. */
const MAX_PAGE_KEY_CHARS = 200;

/**
 * F17: which page of its bank a saved file is. Several pages give one bank (/items and /items/2 the
 * list, /unusuals and /unusuals/378 the unusuals), and bank stock must compare a save only with an
 * earlier save of the same page: page 2 against page 1 would read as everything new and gone. The
 * scrap.tf path lower-cased (no trailing slash, query or hash), with /buy/unusuals and /unusual as
 * /unusuals; a file with no scrap.tf address gets its body id ('pid-buy-hats'), which never equals a
 * path, so it is never compared with an addressed save it cannot be told apart from; else ''.
 */
export function scraptfPageKey(hint: Pick<PageHint, 'path' | 'scrapTf'> | null, bodyId: string | null): string {
  if (hint && hint.scrapTf) {
    const p = hint.path.toLowerCase().replace(/\/+$/, '') || '/';
    return p.replace(/^\/(?:buy\/)?unusuals?(?=\/|$)/, '/unusuals').slice(0, MAX_PAGE_KEY_CHARS);
  }
  return (bodyId ?? '').trim().toLowerCase().slice(0, MAX_PAGE_KEY_CHARS);
}

const SAVED_FROM_RE = /<!--\s*saved from url=\(\s*\d+\s*\)\s*(\S+?)\s*-->/i;

// ---------------------------------------------------------------------------
// Document scan
// ---------------------------------------------------------------------------

interface DocScan {
  title: string | null;
  canonical: string | null;
  ogUrl: string | null;
  bodyId: string | null;
  cards: Element[];
  skippedCards: number;
  rows: Element[];
  priceColumn: number | null;
  nameColumn: number | null;
  /** The /items "Price we pay" column (F14), found in the same header row as the price column. */
  paysColumn: number | null;
  /** The /items "Item Limits" column (stock n of limit), found the same way. */
  limitsColumn: number | null;
  /**
   * 0.7.1 (P7): the header cells (th rows) of the table the price rows are in, or the row the price
   * column was found in; null without one (a headerless table keeps the usual layout).
   */
  headerCells: Element[] | null;
  /** 0.7.1 (P4): elements that carry a data-defindex (cards, rows and anything else). */
  dataDefindex: number;
  /**
   * 0.7.1 (P7): item-like elements in no shape the parser knows (data-defindex and data-title but not an
   * item app440 card; a tr with data-defindex but no data-quality), and the first few of them.
   */
  lookalikes: number;
  lookalikeEls: Element[];
}

function isCard(classes: string[]): boolean {
  return classes.includes('item') && classes.includes('app440');
}

function cellsOf(row: Element): Element[] {
  return row.childNodes.filter((c): c is Element => isElement(c) && (c.tagName === 'th' || c.tagName === 'td'));
}

function scanDocument(root: Node): DocScan {
  const scan: DocScan = {
    title: null,
    canonical: null,
    ogUrl: null,
    bodyId: null,
    cards: [],
    skippedCards: 0,
    rows: [],
    priceColumn: null,
    nameColumn: null,
    paysColumn: null,
    limitsColumn: null,
    headerCells: null,
    dataDefindex: 0,
    lookalikes: 0,
    lookalikeEls: [],
  };
  // Each table's first header row, and the table the first price row is in (P7: a header there that
  // lacks "Price to buy" means scrap.tf renamed or moved it, so no price is guessed by position).
  const headerOf = new Map<Element | null, Element[]>();
  let rowsTable: Element | null | undefined;
  let priceHeader: Element[] | null = null;
  const lookalike = (n: Element) => {
    scan.lookalikes++;
    if (scan.lookalikeEls.length < IMPORT_REPORT_MAX_ITEMS) scan.lookalikeEls.push(n);
  };
  const stack: { n: Node; selected: boolean; table: Element | null }[] = [{ n: root, selected: false, table: null }];
  while (stack.length) {
    const { n, selected, table } = stack.pop()!;
    if (!isElement(n)) {
      const kids = childNodesOf(n);
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ n: kids[i]!, selected, table });
      continue;
    }
    const tag = n.tagName;
    if (tag === 'script' || tag === 'style' || tag === 'template') continue;
    if (tag === 'title' && scan.title === null) {
      scan.title = textContent(n).slice(0, MAX_TITLE_CHARS);
      continue;
    }
    if (tag === 'link' && scan.canonical === null) {
      const rel = (getAttr(n, 'rel') ?? '').toLowerCase().split(/\s+/);
      if (rel.includes('canonical')) scan.canonical = getAttr(n, 'href');
      continue;
    }
    if (tag === 'meta' && scan.ogUrl === null) {
      if ((getAttr(n, 'property') ?? getAttr(n, 'name') ?? '').toLowerCase() === 'og:url') scan.ogUrl = getAttr(n, 'content');
      continue;
    }
    if (tag === 'body' && scan.bodyId === null) scan.bodyId = getAttr(n, 'id');

    const hasDefindex = getAttr(n, 'data-defindex') !== null;
    if (hasDefindex) scan.dataDefindex++;
    const classes = classesOf(n);
    if (isCard(classes)) {
      if (selected) scan.skippedCards++;
      else scan.cards.push(n);
      continue;
    }
    if (hasDefindex && tag !== 'tr' && getAttr(n, 'data-title') !== null) lookalike(n);
    if (tag === 'tr') {
      if (getAttr(n, 'data-quality') !== null && hasDefindex) {
        scan.rows.push(n);
        if (rowsTable === undefined) rowsTable = table;
        continue;
      }
      if (hasDefindex) lookalike(n);
      const cells = cellsOf(n);
      if (!headerOf.has(table) && cells.some((c) => c.tagName === 'th')) headerOf.set(table, cells);
      if (scan.priceColumn === null) {
        const idx = cells.findIndex((c) => c.tagName === 'th' && /price to buy/i.test(textContent(c)));
        if (idx >= 0) {
          scan.priceColumn = idx;
          priceHeader = cells;
          const cols = headerColumnsOf(cells);
          scan.nameColumn = cols.name;
          scan.paysColumn = cols.pays;
          scan.limitsColumn = cols.limits;
        }
      }
    }
    // Selected copies of bank items duplicate the cards in #buy-container.
    const sel = selected || getAttr(n, 'id') === 'buy-selected-container' || classes.includes('buy-selected-items');
    const inTable = tag === 'table' ? n : table;
    const kids = n.childNodes;
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ n: kids[i]!, selected: sel, table: inTable });
  }
  scan.headerCells = priceHeader ?? (rowsTable !== undefined ? (headerOf.get(rowsTable) ?? null) : null);
  return scan;
}

/**
 * The /items columns a header row names, by header text, never by position: a layout change must not
 * read stock or the price to buy as another column. Stock and limit decide "full" (then scrap.tf is no
 * exit), so a moved "Item Limits" column must still be read.
 */
function headerColumnsOf(cells: readonly Element[]): { name: number | null; pays: number | null; limits: number | null } {
  const find = (re: RegExp): number | null => {
    const i = cells.findIndex((c) => c.tagName === 'th' && re.test(textContent(c)));
    return i >= 0 ? i : null;
  };
  return { name: find(/^items?$/i), pays: find(/price we pay/i), limits: find(/item limits?/i) };
}

// ---------------------------------------------------------------------------
// Parse context
// ---------------------------------------------------------------------------

interface PreparedPaintkit {
  row: PaintkitRow;
  norm: string;
}

interface Ctx {
  schema: SchemaService;
  paintkits(): PreparedPaintkit[];
  /** 0.7.1 (P4): build the parser report's item records (ParseOptions.diagnostics). */
  diagnostics: boolean;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function makeCtx(schema: SchemaService, diagnostics = false): Ctx {
  let pks: PreparedPaintkit[] | null = null;
  return {
    schema,
    diagnostics,
    paintkits() {
      if (pks === null) {
        const rows = safe(() => schema.paintkits(), [] as PaintkitRow[]);
        pks = (Array.isArray(rows) ? rows : [])
          .filter((r) => r && typeof r.name === 'string' && r.name.trim() && Number.isInteger(r.id))
          .map((row) => ({ row, norm: lowerKeepLength(collapse(row.name)) }))
          .sort((a, b) => b.norm.length - a.norm.length || a.row.id - b.row.id);
      }
      return pks;
    },
  };
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Lowercase and unify apostrophes without changing string length (indices stay aligned). */
function lowerKeepLength(s: string): string {
  return s.toLowerCase().replace(/[’‘`´]/g, "'");
}

/** Normalised text for name matching (no apostrophes) plus a map back to original indices. */
function normWithMap(s: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  let prevSpace = true;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (/['’‘`´]/.test(ch)) continue;
    if (/\s/.test(ch)) {
      if (!prevSpace) {
        text += ' ';
        map.push(i);
        prevSpace = true;
      }
      continue;
    }
    text += ch.toLowerCase();
    map.push(i);
    prevSpace = false;
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    map.pop();
  }
  return { text, map };
}

/** Finds the schema item name inside a title; the last occurrence wins since modifiers are prefixes. */
function locateBaseName(title: string, item: SchemaItemRow | null): { start: number; end: number } | null {
  if (!item) return null;
  const names = new Set<string>();
  for (const n of [item.itemName, item.name]) {
    if (typeof n !== 'string' || !n.trim() || n.includes('_')) continue;
    names.add(collapse(n));
    names.add(collapse(n.replace(/^The\s+/i, '')));
  }
  const { text, map } = normWithMap(title);
  const cands = [...names].map((n) => normWithMap(n).text).filter(Boolean);
  cands.sort((a, b) => b.length - a.length);
  for (const c of cands) {
    let from = text.length;
    while (from >= 0) {
      const idx = text.lastIndexOf(c, from);
      if (idx < 0) break;
      const before = idx === 0 || text[idx - 1] === ' ';
      const afterIdx = idx + c.length;
      const after = afterIdx === text.length || text[afterIdx] === ' ';
      if (before && after) return { start: map[idx]!, end: map[afterIdx - 1]! + 1 };
      from = idx - 1;
    }
  }
  return null;
}

function longestPaintkitPrefix(text: string, ctx: Ctx): { pk: PaintkitRow; rest: string } | null {
  const t = collapse(text);
  const lower = lowerKeepLength(t);
  for (const pk of ctx.paintkits()) {
    if (lower.startsWith(pk.norm) && (lower.length === pk.norm.length || lower[pk.norm.length] === ' ')) {
      return { pk: pk.row, rest: t.slice(pk.norm.length).trim() };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Title / name parsing
// ---------------------------------------------------------------------------

interface NameCtx {
  item: SchemaItemRow | null;
  quality: number | null;
  isCrate: boolean;
  /** Effect already known from the card image; its name may also appear in the title. */
  effectHint: number | null;
}

interface NameParse {
  /** Title without the custom name. */
  plain: string;
  customName: string | null;
  wear: number | null;
  crateSeries: number | null;
  /** A bare "#N" ending the title of an item the schema does not know: a crate series or a craft number. */
  unresolvedSeries: string | null;
  located: boolean;
  baseText: string;
  uncraftable: boolean;
  killstreak: number;
  festive: boolean;
  strange: boolean;
  australium: boolean;
  qualities: number[];
  paintkit: PaintkitRow | null;
  effect: number | null;
  leftover: string[];
}

// Each token must be followed by a space or end the (trimmed) prefix.
const KILLSTREAK_TOKENS: [RegExp, number][] = [
  [/^Professional Killstreak(?:\s+|$)/, 3],
  [/^Specialized Killstreak(?:\s+|$)/, 2],
  [/^Killstreak(?:\s+|$)/, 1],
];

const QUALITY_TOKENS: [RegExp, number][] = [
  [/^Decorated Weapon(?:\s+|$)/, 15],
  [/^Decorated(?:\s+|$)/, 15],
  [/^Collector's(?:\s+|$)/, 14],
  [/^Self-Made(?:\s+|$)/, 9],
  [/^Genuine(?:\s+|$)/, 1],
  [/^Vintage(?:\s+|$)/, 3],
  // NetroScript strips both "Unusual " and "★Unusual " from skin names.
  [/^★\s*Unusual(?:\s+|$)/, 5],
  [/^Unusual(?:\s+|$)/, 5],
  [/^Unique(?:\s+|$)/, 6],
  // NetroScript: "Haunted Ghosts" is a war paint, not the Haunted quality.
  [/^Haunted(?:\s+(?!Ghosts\b)|$)/, 13],
  [/^Community(?:\s+|$)/, 7],
  [/^Valve(?:\s+|$)/, 8],
  [/^Normal(?:\s+|$)/, 0],
  [/^Completed(?:\s+|$)/, 12],
  [/^Customized(?:\s+|$)/, 10],
];

function parseName(title: string, nctx: NameCtx, ctx: Ctx): NameParse {
  const res: NameParse = {
    plain: '',
    customName: null,
    wear: null,
    crateSeries: null,
    unresolvedSeries: null,
    located: false,
    baseText: '',
    uncraftable: false,
    killstreak: 0,
    festive: false,
    strange: false,
    australium: false,
    qualities: [],
    paintkit: null,
    effect: null,
    leftover: [],
  };
  // Clipped first: every pass below (custom name, wear, base name) then runs on a short string.
  let t = collapse((title.length > MAX_NAME_CHARS ? title.slice(0, MAX_NAME_CHARS) : title).replace(/[’‘]/g, "'"));
  // Bounded custom name: an unclosed quote must not scan to the end from every quote.
  const custom = /(''|"|“)(.{1,64}?)(''|"|”)/.exec(t);
  if (custom) {
    res.customName = custom[2]!.trim();
    t = collapse(t.slice(0, custom.index) + ' ' + t.slice(custom.index + custom[0].length));
  }
  res.plain = t;

  const wear = WEAR_SUFFIX_RE.exec(t);
  if (wear) {
    res.wear = WEAR_BY_NAME[wear[1]!.toLowerCase()] ?? null;
    t = t.slice(0, wear.index).trim();
  }
  const series = /\s*(Series\s*)?#(\d{1,6})$/i.exec(t);
  // The series is part of a crate's SKU. Without a schema row, "Series #N" still names a crate, but a
  // bare "#N" could be a craft number: that one is left for buildSku to refuse instead of dropping it.
  if (series && (nctx.isCrate || (nctx.item === null && series[1] !== undefined))) {
    res.crateSeries = Number(series[2]);
    t = t.slice(0, series.index).trim();
  } else if (series && nctx.item === null) {
    res.unresolvedSeries = `#${series[2]}`;
  }
  // "War Paint: Masked Mender (Field-Tested)" puts the paintkit after the item; read it as
  // "Masked Mender War Paint" so the schema name and the paintkit are both found.
  const warPaint = /^(.*?)\bWar Paint:\s*(\S.*)$/i.exec(t);
  if (warPaint) t = collapse(`${warPaint[1]} ${warPaint[2]} War Paint`);

  const allowPaintkit = res.wear !== null || nctx.quality === 15 || /\bWar Paint\b/i.test(t);
  const loc = locateBaseName(t, nctx.item);
  let rest: string;
  if (loc) {
    res.located = true;
    res.baseText = t.slice(loc.start, loc.end);
    rest = t.slice(0, loc.start).trim();
    const suffix = t.slice(loc.end).trim();
    if (suffix) res.leftover.push(suffix);
  } else {
    rest = t;
  }

  const effectName = nctx.effectHint !== null ? safe(() => ctx.schema.effectName(nctx.effectHint!), null) : null;
  const take = (re: RegExp): boolean => {
    const m = re.exec(rest);
    if (!m) return false;
    rest = rest.slice(m[0].length).trim();
    return true;
  };

  let progress = true;
  while (rest && progress) {
    progress = false;
    if (take(/^Non-Craftable(?:\s+|$)/)) {
      res.uncraftable = true;
      progress = true;
      continue;
    }
    let ks = false;
    for (const [re, tier] of KILLSTREAK_TOKENS) {
      if (take(re)) {
        res.killstreak = tier;
        ks = true;
        break;
      }
    }
    if (ks) {
      progress = true;
      continue;
    }
    if (take(/^Festivized(?:\s+|$)/)) {
      res.festive = true;
      progress = true;
      continue;
    }
    if (!(!res.located && STRANGE_TOOL_RE.test(rest)) && take(/^Strange(?:\s+|$)/)) {
      res.strange = true;
      progress = true;
      continue;
    }
    let q = false;
    for (const [re, id] of QUALITY_TOKENS) {
      if (take(re)) {
        res.qualities.push(id);
        q = true;
        break;
      }
    }
    if (q) {
      progress = true;
      continue;
    }
    if (take(/^The(?:\s+|$)/)) {
      progress = true;
      continue;
    }
    // "Australium" counts only immediately before the weapon name (not the "Australium Gold" paint).
    if (/^Australium(?:\s+|$)/.test(rest)) {
      const after = rest.replace(/^Australium\s*/, '');
      if ((res.located && after === '') || (!res.located && after !== '' && !/^Gold\b/.test(after))) {
        rest = after;
        res.australium = true;
        progress = true;
        continue;
      }
    }
    if (effectName) {
      const en = lowerKeepLength(collapse(effectName));
      const lr = lowerKeepLength(rest);
      if (lr.startsWith(en) && (lr.length === en.length || lr[en.length] === ' ')) {
        rest = rest.slice(en.length).trim();
        res.effect = nctx.effectHint;
        progress = true;
        continue;
      }
    }
    if (allowPaintkit && res.paintkit === null) {
      const pk = longestPaintkitPrefix(rest, ctx);
      // Unlocated names need something after the paintkit (the weapon or "War Paint").
      if (pk && (res.located || pk.rest !== '')) {
        res.paintkit = pk.pk;
        rest = pk.rest;
        progress = true;
        continue;
      }
    }
  }

  if (res.located) {
    if (rest) {
      const eff = safe(() => ctx.schema.effectIdByName(rest), null);
      if (eff !== null && res.effect === null && !allowPaintkit) res.effect = eff;
      else res.leftover.unshift(rest);
    }
  } else {
    res.baseText = rest;
  }

  // The schema name of a war paint or skin may itself contain the paintkit name.
  if (allowPaintkit && res.paintkit === null && res.baseText) {
    const pk = longestPaintkitPrefix(res.baseText, ctx);
    if (pk && pk.rest !== '') res.paintkit = pk.pk;
  }
  return res;
}

// ---------------------------------------------------------------------------
// Tooltip (data-content) lines
// ---------------------------------------------------------------------------

interface ContentInfo {
  effectName: string | null;
  paintName: string | null;
  sheenName: string | null;
  killstreakerName: string | null;
  killstreak: number | null;
  festive: boolean;
  uncraftable: boolean;
  notTradable: boolean;
  strangeStatClock: boolean;
  reserved: boolean;
  wear: number | null;
  /** Steam's "Crate Series #N" description line (part of a crate's SKU). */
  crateSeries: number | null;
  spells: string[];
  parts: string[];
  customDesc: boolean;
  unparsed: string[];
}

/** A custom description line (the owner's own words): never reported. */
const CUSTOM_DESC_RE = /^(?:''|"|“).*(?:''|"|”)$/;
/** Lines parseContent passes over: who crafted or gifted it, when it was received, craft numbers, tool inputs. */
const PASSED_OVER_RE = [/^(?:Crafted|Gifted) by:/i, /^Date Received:/i, /^(?:Outputs?|Inputs?|Target):/i, /\bx\s*\d+$/, /^Holiday Restriction:/i, /^Craft #?\d+/i];

/**
 * P4: a line that names a person in any wording Steam or scrap.tf may use ("Gift from: …", "Crafted by …"
 * without the colon parseContent expects). Never in a report, as a tooltip line or inside a warning that
 * quotes one (unparsed-modifier).
 */
const PERSON_LINE_RE = /\b(?:(?:Crafted|Gifted|Created|Signed|Made|Owned)\s+by|Gift\s+from)\b/i;

/** P4: an item's warnings as a report may hold them: none that quotes a line naming a person. */
function reportWarnings(warnings: readonly string[]): string[] {
  return warnings.filter((w) => !PERSON_LINE_RE.test(w));
}

/**
 * 0.7.1 (P4): the tooltip lines the parser report may hold, as parseContent kept them: the gift, receipt,
 * craft and tool lines and any custom description are dropped (a person's name or words), at most 20.
 */
function reportContentLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of new Set(lines)) {
    const line = raw.replace(/[’‘]/g, "'").trim();
    if (!line || (CUSTOM_DESC_RE.test(line) && line.length > 2) || PERSON_LINE_RE.test(line) || PASSED_OVER_RE.some((re) => re.test(line))) continue;
    out.push(line);
    if (out.length >= 20) break;
  }
  return out;
}

function parseContent(lines: string[]): ContentInfo {
  const info: ContentInfo = {
    effectName: null,
    paintName: null,
    sheenName: null,
    killstreakerName: null,
    killstreak: null,
    festive: false,
    uncraftable: false,
    notTradable: false,
    strangeStatClock: false,
    reserved: false,
    wear: null,
    crateSeries: null,
    spells: [],
    parts: [],
    customDesc: false,
    unparsed: [],
  };
  // data-content2 often repeats data-content.
  for (const raw of new Set(lines)) {
    const line = raw.replace(/[’‘]/g, "'").trim();
    let m: RegExpExecArray | null;
    if (/^(?:Item )?Level\s+\d+/i.test(line)) continue;
    if ((m = /^(?:★\s*)?(?:Unusual )?Effect:\s*(.+)$/i.exec(line))) {
      info.effectName = m[1]!.trim();
      continue;
    }
    if ((m = /^Painted\s+(.+)$/i.exec(line))) {
      info.paintName = m[1]!.trim();
      continue;
    }
    if ((m = /^Sheen:\s*(.+)$/i.exec(line))) {
      info.sheenName = m[1]!.trim();
      continue;
    }
    if ((m = /^Killstreaker:\s*(.+)$/i.exec(line))) {
      info.killstreakerName = m[1]!.trim();
      continue;
    }
    if ((m = /^(Professional |Specialized )?Killstreaks? Active$/i.exec(line))) {
      const tier = (m[1] ?? '').trim().toLowerCase();
      info.killstreak = tier === 'professional' ? 3 : tier === 'specialized' ? 2 : 1;
      continue;
    }
    if (/^Festivized$/i.test(line)) {
      info.festive = true;
      continue;
    }
    if (/^\(?\s*(?:Uncraftable|Non-Craftable|Not Usable in Crafting)\s*\)?$/i.test(line)) {
      info.uncraftable = true;
      continue;
    }
    if (/^\(?\s*(?:Not Tradable|Untradable|Not Tradeable)/i.test(line)) {
      info.notTradable = true;
      continue;
    }
    if (/Strange Stat Clock/i.test(line)) {
      info.strangeStatClock = true;
      continue;
    }
    if (/has been reserved/i.test(line)) {
      info.reserved = true;
      continue;
    }
    if ((m = /^(?:Crate )?Series\s*#(\d{1,6})$/i.exec(line))) {
      info.crateSeries = Number(m[1]);
      continue;
    }
    if ((m = /^Halloween:\s*(.+?)(?:\s*\(spell only active during event\))?$/i.exec(line))) {
      info.spells.push(m[1]!.trim());
      continue;
    }
    if ((m = /^Strange (?:Cosmetic )?Part:\s*(.+)$/i.exec(line))) {
      info.parts.push(m[1]!.trim());
      continue;
    }
    if ((m = /^\(\s*([A-Za-z][A-Za-z .'\-]*?)\s*:\s*[\d,]+\s*\)$/.exec(line))) {
      const name = m[1]!.trim();
      if (!BASE_STRANGE_COUNTERS.has(name.toLowerCase())) info.parts.push(name);
      continue;
    }
    if ((m = /^([A-Za-z][A-Za-z .'\-]*?)\s*:\s*[\d,]+$/.exec(line)) && BASE_STRANGE_COUNTERS.has(m[1]!.trim().toLowerCase())) {
      continue;
    }
    if (CUSTOM_DESC_RE.test(line) && line.length > 2) {
      info.customDesc = true;
      continue;
    }
    if (/\bGrade\b/.test(line)) {
      // Rarity line, e.g. "Commando Grade Flame Thrower (Field-Tested)".
      const w = WEAR_SUFFIX_RE.exec(line);
      if (w) info.wear = WEAR_BY_NAME[w[1]!.toLowerCase()] ?? null;
      continue;
    }
    if (PASSED_OVER_RE.some((re) => re.test(line))) continue;
    info.unparsed.push(line);
  }
  return info;
}

function idByName(table: Record<number, string>, name: string | null): number | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  for (const [id, label] of Object.entries(table)) if (label.toLowerCase() === n) return Number(id);
  return null;
}

// ---------------------------------------------------------------------------
// Shared item assembly
// ---------------------------------------------------------------------------

function emptySpecial(): SpecialAttrs {
  return { paint: null, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false };
}

function displayName(ctx: Ctx, sku: string | null, fallback: string): string {
  if (sku) {
    const n = safe(() => ctx.schema.nameForSku(sku), '');
    if (typeof n === 'string' && n.trim() && n.trim() !== sku && !/^\d+;\d+/.test(n.trim())) return n.trim();
  }
  return fallback;
}

/** Kits, fabricators and strangifiers carry target/output tokens the card does not show. */
function resolveNeedsTarget(ctx: Ctx, name: string, defindex: number | null): SkuObject | null {
  const r = safe(() => ctx.schema.resolve(name), null);
  if (!r || r.match === 'fuzzy' || !r.skuObject) return null;
  if (defindex !== null && r.skuObject.defindex !== defindex) return null;
  return normalizeSkuObject({ ...r.skuObject, paint: null });
}

function paintDecimalByName(ctx: Ctx, name: string): number | null {
  const dec = PAINT_DECIMAL_BY_NAME[name.trim().toLowerCase()];
  if (dec === undefined) return null;
  const row = safe(() => ctx.schema.paintByDecimal(dec), null);
  // Trust the table when the schema has not loaded paints; otherwise insist on agreement.
  if (row && row.name.trim().toLowerCase() !== name.trim().toLowerCase()) return null;
  return dec;
}

function samePaintName(ctx: Ctx, decimal: number, name: string): boolean {
  const row = safe(() => ctx.schema.paintByDecimal(decimal), null);
  if (row) return row.name.trim().toLowerCase() === name.trim().toLowerCase();
  return PAINT_DECIMAL_BY_NAME[name.trim().toLowerCase()] === decimal;
}

// ---------------------------------------------------------------------------
// Item cards
// ---------------------------------------------------------------------------

interface CardParts {
  attrs: z.infer<typeof CardAttrsSchema>;
  classes: string[];
  styles: string[];
  imgSrcs: string[];
  paintStyle: string | null;
  indicator: string | null;
  groupText: string | null;
}

function collectCard(el: Element, warnings: string[]): CardParts {
  const attrs = validateAttrs(CardAttrsSchema, attrsOf(el), warnings);
  const parts: CardParts = {
    attrs,
    classes: classesOf(el),
    styles: attrs.style ? [attrs.style] : [],
    imgSrcs: [],
    paintStyle: null,
    indicator: null,
    groupText: null,
  };
  for (const d of descendants(el)) {
    const style = getAttr(d, 'style');
    if (style) parts.styles.push(style);
    if (d.tagName === 'img') {
      const src = getAttr(d, 'src');
      if (src) parts.imgSrcs.push(src);
    }
    const cls = classesOf(d);
    if (cls.includes('paintcolor') && parts.paintStyle === null) parts.paintStyle = style ?? '';
    if (cls.includes('item-value-indicator') && parts.indicator === null) parts.indicator = textContent(d);
    if ((cls.includes('item-group-num-text') || getAttr(d, 'id') === 'group-num-available') && parts.groupText === null) {
      parts.groupText = textContent(d);
    }
  }
  return parts;
}

function cardPrice(rawValue: number | null, indicator: string | null, warnings: string[]): { keys: number; scrap: number } {
  // A data-item-value of 0 is no price (as the reference helper reads it): the indicator text decides.
  const itemValue = rawValue !== null && rawValue > 0 ? rawValue : null;
  const ind = indicator ? collapse(indicator) : '';
  const parsed = ind ? parsePrice(ind, 'ref') : null;
  if (ind && !parsed) warnings.push(`unparsed-price: "${clip(ind, 40)}"`);
  const mentionsKeys = ind !== '' && /\bkeys?\b|\d\s*k\b/i.test(ind);
  if (parsed && mentionsKeys) {
    if (itemValue !== null && itemValue < parsed.scrap) {
      warnings.push(`price-mismatch: "${clip(ind, 40)}" but data-item-value is ${itemValue} scrap`);
    }
    return { keys: parsed.keys, scrap: parsed.scrap };
  }
  if (itemValue !== null) {
    if (parsed && parsed.keys === 0 && parsed.scrap !== itemValue) {
      warnings.push(`price-mismatch: "${clip(ind, 40)}" is ${parsed.scrap} scrap but data-item-value is ${itemValue} scrap (using data-item-value)`);
    }
    return { keys: 0, scrap: itemValue };
  }
  if (parsed) return { keys: parsed.keys, scrap: parsed.scrap };
  warnings.push('no-price: card has no data-item-value or price text');
  return { keys: 0, scrap: 0 };
}

function cardEffectId(parts: CardParts, warnings: string[]): number | null {
  const ids = new Set<number>();
  for (const s of [...parts.styles, ...parts.imgSrcs]) {
    for (const m of s.matchAll(/particles_440\/(\d{1,6})_380/gi)) ids.add(Number(m[1]));
  }
  if (ids.size === 0) {
    // "Webpage, Complete" saves can rewrite images to "<page>_files/{id}_380x380.png".
    for (const s of [...parts.styles, ...parts.imgSrcs]) {
      for (const m of s.matchAll(/_files\/(\d{1,6})_380x380\.(?:png|webp|gif)/gi)) ids.add(Number(m[1]));
    }
  }
  if (ids.size === 0) return null;
  const list = [...ids];
  if (list.length > 1) warnings.push(`effect-mismatch: card shows several effect images (${list.join(', ')}); using ${list[0]}`);
  return list[0]!;
}

function cardWarpaint(parts: CardParts): { paintkit: number; wear: number } | null {
  for (const s of [...parts.styles, ...parts.imgSrcs]) {
    // NetroScript's layout: warpaint/{a}_{paintkit}_{wear}_{b}.png
    const m = /warpaint\/(\d+)_(\d+)_(\d+)_(\d+)\.png/i.exec(s);
    if (m) return { paintkit: Number(m[2]), wear: Number(m[3]) };
  }
  return null;
}

function cardPaint(
  ctx: Ctx,
  parts: CardParts,
  content: ContentInfo,
  item: SchemaItemRow | null,
  title: string,
  warnings: string[],
): number | null {
  const hex = parts.paintStyle !== null ? backgroundColorOf(parts.paintStyle) : null;
  const name = content.paintName;
  if (hex === null && name === null) return null;
  // Paint cans show their own colour; they are not painted items.
  if (item?.itemClass === 'tool' || (name !== null && collapse(title).toLowerCase() === name.toLowerCase())) return null;

  if (hex === null) {
    const dec = paintDecimalByName(ctx, name!);
    if (dec === null) warnings.push(`unknown-paint: "${clip(name!, 50)}"`);
    return dec;
  }
  if (hex === AMBIGUOUS_PAINT_HEX) {
    const byName = name ? paintDecimalByName(ctx, name) : null;
    if (byName !== null) {
      warnings.push(`ambiguous-paint: ${hex.toUpperCase()} resolved as ${name} from the tooltip`);
      return byName;
    }
    const dec = safe(() => ctx.schema.paintDecimalByHex(hex), null);
    warnings.push(`ambiguous-paint: ${hex.toUpperCase()} is Team Spirit (BLU) or Legacy Paint; tooltip does not say which`);
    return dec;
  }
  const dec = safe(() => ctx.schema.paintDecimalByHex(hex), null);
  if (dec === null) {
    const byName = name ? paintDecimalByName(ctx, name) : null;
    warnings.push(`unknown-paint: ${hex.toUpperCase()}${name ? ` ("${clip(name, 40)}")` : ''}`);
    return byName;
  }
  if (name && !samePaintName(ctx, dec, name)) {
    const byName = paintDecimalByName(ctx, name);
    warnings.push(`paint-mismatch: colour ${hex.toUpperCase()} but tooltip says "${clip(name, 40)}"`);
    return byName ?? dec;
  }
  return dec;
}

function qualityFromClasses(classes: string[]): { primary: number | null; all: number[] } {
  const all: number[] = [];
  for (const c of classes) {
    const m = /^quality(\d{1,3})$/.exec(c);
    if (m) all.push(Number(m[1]));
  }
  if (all.length === 0) return { primary: null, all };
  const nonStrange = all.find((q) => q !== 11);
  return { primary: nonStrange ?? 11, all };
}

/** A parsed card or row, and (ParseOptions.diagnostics) how to build its parser report record. */
interface ParsedEntry {
  item: ParsedScrapItem;
  report: (() => ImportReportItem) | null;
}

function parseCard(el: Element, ctx: Ctx): ParsedEntry & { assetId: string | null } {
  const warnings: string[] = [];
  const parts = collectCard(el, warnings);
  const a = parts.attrs;
  const titleText = htmlAttrLines(a['data-title'] ?? '').join(' ');
  const contentLines = [...htmlAttrLines(a['data-content'] ?? ''), ...htmlAttrLines(a['data-content2'] ?? '')];
  const content = parseContent(contentLines);
  const defindex = a['data-defindex'] ?? null;
  const item = defindex !== null ? safe(() => ctx.schema.itemByDefindex(defindex), null) : null;

  const q = qualityFromClasses(parts.classes);
  const effectImg = cardEffectId(parts, warnings);
  const nameEffect = content.effectName ? safe(() => ctx.schema.effectIdByName(content.effectName!), null) : null;
  // A crate the schema does not know still shows its series in the tooltip ("Crate Series #N").
  const isCrate = item?.itemClass === 'supply_crate' || (item === null && content.crateSeries !== null);
  // The tooltip's effect also names it in a title such as "Isotope Frozen Aurora Flame Thrower" when no image does.
  const name = parseName(titleText, { item, quality: q.primary, isCrate, effectHint: effectImg ?? nameEffect }, ctx);
  const warpaint = cardWarpaint(parts);

  let quality = q.primary;
  // Unusual skins are Decorated (15) plus an effect, so "Unusual" in a skin's title agrees with a quality15 class.
  const skinLike = name.wear !== null || content.wear !== null || name.paintkit !== null || warpaint !== null;
  const sameQuality = (x: number, y: number): boolean => x === y || (skinLike && ((x === 5 && y === 15) || (x === 15 && y === 5)));
  if (quality === null) {
    quality = name.qualities.find((x) => x !== 11) ?? (name.strange ? 11 : null);
    if (quality === null) {
      quality = 6;
      warnings.push('unknown-quality: no qualityN class; assuming Unique');
    }
  } else if (name.qualities.length > 0 && !q.all.some((x) => name.qualities.some((y) => sameQuality(x, y)))) {
    warnings.push(`quality-mismatch: card class says ${quality} but title says ${name.qualities.join('/')}`);
  }

  let elevated =
    quality !== 11 && (q.all.includes(11) || name.strange || content.strangeStatClock);

  // Effect
  let effect: number | null = null;
  if (effectImg !== null) {
    effect = safe(() => ctx.schema.canonicalEffectId(effectImg), effectImg);
    if (safe(() => ctx.schema.effectName(effectImg), null) === null) {
      warnings.push(`unknown-effect: particle id ${effectImg}${content.effectName ? ` ("${clip(content.effectName, 40)}")` : ''}`);
    } else if (nameEffect !== null && safe(() => ctx.schema.canonicalEffectId(nameEffect), nameEffect) !== effect) {
      warnings.push(`effect-mismatch: image is effect ${effectImg} but tooltip says "${clip(content.effectName!, 40)}"`);
    }
  } else if (nameEffect !== null) {
    effect = safe(() => ctx.schema.canonicalEffectId(nameEffect), nameEffect);
  } else if (content.effectName) {
    warnings.push(`unknown-effect: "${clip(content.effectName, 50)}"`);
  } else if (name.effect !== null) {
    effect = safe(() => ctx.schema.canonicalEffectId(name.effect!), name.effect);
  }

  // Killstreak: class first, then title, then tooltip.
  let killstreak = 0;
  for (const c of parts.classes) {
    const m = /^killstreak([123])$/.exec(c);
    if (m) killstreak = Number(m[1]);
  }
  const otherKs = name.killstreak || content.killstreak || 0;
  if (killstreak === 0) killstreak = otherKs;
  else if (otherKs && otherKs !== killstreak) warnings.push(`killstreak-mismatch: class says tier ${killstreak}, text says tier ${otherKs}`);

  // Wear and paintkit
  let wear = name.wear ?? content.wear;
  if (name.wear !== null && content.wear !== null && name.wear !== content.wear) {
    warnings.push(`wear-mismatch: title says w${name.wear}, tooltip says w${content.wear}`);
  }
  let paintkit = name.paintkit?.id ?? null;
  if (warpaint) {
    if (paintkit !== null && warpaint.paintkit !== paintkit) {
      warnings.push(`paintkit-mismatch: name gives pk${paintkit}, image gives pk${warpaint.paintkit}`);
    }
    if (wear !== null && warpaint.wear >= 1 && warpaint.wear <= 5 && warpaint.wear !== wear) {
      warnings.push(`wear-mismatch: name gives w${wear}, image gives w${warpaint.wear}`);
    }
    if (paintkit === null) paintkit = warpaint.paintkit;
    if (wear === null && warpaint.wear >= 1 && warpaint.wear <= 5) wear = warpaint.wear;
  }
  const warPaint = warPaintCheck(defindex, paintkit, name, warnings);
  paintkit = warPaint.paintkit;
  // Unusual skins are keyed as Decorated (15) plus the effect (DESIGN_BRIEF §4.3); NetroScript drops the
  // Unusual quality scrap.tf puts on skins. Without an effect the card stays 5 and is refused.
  if (quality === 5 && effect !== null && paintkit !== null && wear !== null) quality = 15;
  // A Decorated card the title, class or tooltip calls Unusual has an effect this card does not show:
  // the plain skin's SKU would be a guess, so it stays Unusual and buildSku refuses it.
  else if (quality === 15 && effect === null && (name.qualities.includes(5) || q.all.includes(5) || content.effectName !== null)) quality = 5;
  // P2: every skin keyed the way backpack.tf buyers key it, whichever quality class the card carries.
  if (paintkit !== null && wear !== null) {
    const skin = skinQuality(quality, effect, elevated || quality === 11 || q.all.includes(11) || name.strange);
    if (skin) ({ quality, elevated } = skin);
  }

  // Crate series: the title's, else the tooltip's.
  let crateSeries = name.crateSeries;
  if (content.crateSeries !== null) {
    if (!isCrate) warnings.push(`unparsed-modifier: "Crate Series #${content.crateSeries}"`);
    else if (crateSeries === null) crateSeries = content.crateSeries;
    else if (crateSeries !== content.crateSeries) {
      warnings.push(`series-mismatch: title says #${crateSeries}, tooltip says #${content.crateSeries} (using the title)`);
    }
  }

  // Special attributes
  const special = emptySpecial();
  special.paint = cardPaint(ctx, parts, content, item, name.plain, warnings);
  special.spells = content.spells;
  special.parts = content.parts;
  special.customName = name.customName !== null;
  special.customDesc = content.customDesc;
  for (const c of parts.classes) {
    const m = /^fx(\d{1,5})$/.exec(c);
    if (!m) continue;
    const n = Number(m[1]);
    if (SHEENS[n] !== undefined) special.sheen = n;
    else if (KILLSTREAKERS[n] !== undefined) special.killstreaker = n;
  }
  const sheenByName = idByName(SHEENS, content.sheenName);
  if (sheenByName !== null) {
    if (special.sheen !== null && special.sheen !== sheenByName) warnings.push(`sheen-mismatch: class fx${special.sheen}, tooltip "${content.sheenName}"`);
    special.sheen ??= sheenByName;
  } else if (content.sheenName) warnings.push(`unparsed-modifier: "Sheen: ${clip(content.sheenName, 40)}"`);
  const ksrByName = idByName(KILLSTREAKERS, content.killstreakerName);
  if (ksrByName !== null) special.killstreaker ??= ksrByName;
  else if (content.killstreakerName) warnings.push(`unparsed-modifier: "Killstreaker: ${clip(content.killstreakerName, 40)}"`);

  if (content.reserved) warnings.push('reserved: scrap.tf marked this item as reserved by another user');
  if (content.notTradable) warnings.push('not-tradable: tooltip says the item is not tradable');
  for (const u of content.unparsed.slice(0, 8)) warnings.push(`unparsed-modifier: "${clip(u, 100)}"`);
  if (content.unparsed.length > 8) warnings.push(`unparsed-modifier: ${content.unparsed.length - 8} more lines`);
  for (const l of name.leftover) warnings.push(`unparsed-name: "${clip(l, 60)}" in "${clip(name.plain, 60)}"`);

  const uncraftable =
    parts.classes.includes('uncraft') || parts.classes.includes('uncraftable') || content.uncraftable || name.uncraftable;
  const festive = name.festive || content.festive;

  const assetId = a['data-id'] ?? null;
  const price = cardPrice(a['data-item-value'] ?? null, parts.indicator, warnings);
  let stock: number | null = a['data-num-available'] ?? null;
  if (stock === null && parts.groupText) {
    const m = /(\d{1,6})\s*x?/i.exec(parts.groupText);
    if (m) stock = Number(m[1]);
  }
  if (stock === null && assetId !== null) stock = 1;

  const built = buildSku(ctx, {
    defindex,
    quality,
    elevated,
    effect,
    killstreak,
    australium: name.australium,
    festive,
    uncraftable,
    tradable: !content.notTradable,
    wear,
    paintkit,
    paintkitConflict: warPaint.conflict,
    isCrate,
    crateSeries,
    item,
    name,
    fallbackTitle: titleText,
    warnings,
  });

  const fallbackName = name.customName !== null ? (item?.itemName ?? name.plain) : name.plain || titleText;
  return {
    assetId,
    item: {
      title: titleText,
      sku: built.sku,
      skuObject: built.obj,
      name: displayName(ctx, built.sku, fallbackName || titleText),
      costKeys: price.keys,
      costScrap: price.scrap,
      special,
      assetId,
      stock,
      warnings,
    },
    // P4: the card's own fields as read; the title only when it holds no custom name.
    report: ctx.diagnostics
      ? () => ({
          ...cardReportBase(el, parts.classes),
          title: name.customName === null ? titleText : null,
          contentLines: reportContentLines(contentLines),
          indicator: parts.indicator,
          particleId: effectImg,
          warpaintId: warpaint?.paintkit ?? null,
          sku: built.sku,
          warnings: reportWarnings(warnings),
        })
      : null,
  };
}

/** P4: classes a report keeps (quality, killstreak tier, sheen/killstreaker, uncraftable) and the card's own flags. */
const REPORT_CLASS_RE = /^(?:quality\d{1,3}|killstreak\d|fx\d{1,5}|uncraft[a-z]*|item|app440|hoverable)$/;

/** P4: an element's report fields from its attributes, as text (raw, clipped later by reports.ts); never its asset id. */
function cardReportBase(el: Element, classes: readonly string[]): ImportReportItem {
  const raw = (name: string): string | null => getAttr(el, name);
  const defindex = Number(raw('data-defindex') ?? '');
  return {
    defindex: Number.isSafeInteger(defindex) && defindex >= 0 && (raw('data-defindex') ?? '').trim() !== '' ? defindex : null,
    classTokens: classes.filter((c) => REPORT_CLASS_RE.test(c)).slice(0, 20),
    title: null,
    contentLines: [],
    indicator: null,
    itemValue: raw('data-item-value'),
    numAvailable: raw('data-num-available'),
    numSelected: raw('data-num-selected'),
    particleId: null,
    warpaintId: null,
    sku: null,
    warnings: [],
  };
}

/**
 * 0.7.1 (P2): a skin's quality as backpack.tf keys it, whatever quality class scrap.tf gives the card. An
 * unusual skin is Decorated (15) plus its effect, plus strange (quality2 11) when strange; a strange skin
 * without an effect is Strange (11) with no second quality ("11;…;w2;pk14"); any other skin is Decorated.
 * Killstreak and festive are separate SKU parts and stay. null (unchanged): an Unusual card that shows no
 * effect stays 5, so buildSku refuses it rather than guess the plain skin.
 */
function skinQuality(quality: number, effect: number | null, strange: boolean): { quality: number; elevated: boolean } | null {
  if (effect !== null) return { quality: 15, elevated: strange };
  if (quality === 5) return null;
  return strange ? { quality: 11, elevated: false } : { quality: 15, elevated: false };
}

function warPaintCheck(
  defindex: number | null,
  paintkit: number | null,
  name: NameParse,
  warnings: string[],
): { paintkit: number | null; conflict: boolean } {
  // War Paint items are defindex 16000 + paintkit (DESIGN_BRIEF §4.3).
  if (defindex === null || defindex < 16000 || defindex > 16999) return { paintkit, conflict: false };
  if (!/\bWar Paint\b/i.test(name.plain) && name.wear === null) return { paintkit, conflict: false };
  const implied = defindex - 16000;
  if (paintkit === null) {
    warnings.push(`paintkit-inferred: war paint pk${implied} taken from defindex ${defindex}`);
    return { paintkit: implied, conflict: false };
  }
  if (paintkit !== implied) {
    // The defindex or the name is wrong, so either paintkit is a guess (and the name's makes a SKU that
    // cannot exist): buildSku refuses the card.
    warnings.push(`paintkit-mismatch: name gives pk${paintkit}, defindex ${defindex} implies pk${implied}`);
    return { paintkit, conflict: true };
  }
  return { paintkit, conflict: false };
}

interface SkuInput {
  defindex: number | null;
  quality: number;
  elevated: boolean;
  effect: number | null;
  killstreak: number;
  australium: boolean;
  festive: boolean;
  uncraftable: boolean;
  tradable: boolean;
  wear: number | null;
  paintkit: number | null;
  /** A War Paint whose name and defindex name different paintkits (warPaintCheck warned). */
  paintkitConflict: boolean;
  /** A supply crate (schema item class, or the page's own sign): priced per series. */
  isCrate: boolean;
  crateSeries: number | null;
  item: SchemaItemRow | null;
  name: NameParse;
  fallbackTitle: string;
  warnings: string[];
}

/**
 * The series of a crate whose page shows none, from the item schema: only an exact name match on the
 * same defindex that carries one (a single-series case). A multi-series crate resolves without one.
 */
function schemaCrateSeries(ctx: Ctx, defindex: number, plain: string): number | null {
  if (!plain) return null;
  const r = safe(() => ctx.schema.resolve(plain), null);
  if (!r || r.match !== 'exact' || r.skuObject?.defindex !== defindex) return null;
  const series = r.skuObject.crateseries;
  return typeof series === 'number' && Number.isInteger(series) && series > 0 ? series : null;
}

function buildSku(ctx: Ctx, s: SkuInput): { sku: string | null; obj: SkuObject | null } {
  const w = s.warnings;
  const schemaLoaded = safe(() => ctx.schema.isLoaded(), false);

  if (NEEDS_TARGET_RE.test(s.name.plain.replace(WEAR_SUFFIX_RE, '').trim())) {
    const resolved = resolveNeedsTarget(ctx, s.name.plain || s.fallbackTitle, s.defindex);
    if (resolved) {
      if (s.uncraftable) resolved.craftable = false;
      return { sku: fromObject(resolved), obj: resolved };
    }
    w.push(`needs-target: "${clip(s.name.plain, 60)}" needs a target item that the page does not show`);
    return { sku: null, obj: null };
  }
  if (s.defindex === null) {
    const resolved = s.name.plain ? safe(() => ctx.schema.resolve(s.name.plain), null) : null;
    if (resolved && resolved.match !== 'fuzzy' && resolved.skuObject) {
      const obj = normalizeSkuObject({ ...resolved.skuObject, paint: null });
      w.push(`no-defindex: identified by name as ${fromObject(obj)}`);
      return { sku: fromObject(obj), obj };
    }
    w.push('no-defindex: card has no usable data-defindex');
    return { sku: null, obj: null };
  }
  const defindex = s.defindex;
  if (!s.item && schemaLoaded) w.push(`unknown-item: defindex ${defindex} is not in the item schema`);
  else if (s.item && !s.name.located && s.name.plain && s.name.customName === null) {
    w.push(`name-unmatched: "${clip(s.name.plain, 60)}" does not contain the schema name "${clip(s.item.itemName, 40)}"`);
  }
  if (s.name.unresolvedSeries !== null && s.crateSeries === null) {
    // Dropping it would price a crate series (or a low craft number) as the plain item.
    w.push(`series-unresolved: "${s.name.unresolvedSeries}" in "${clip(s.name.plain, 60)}" is a crate series or a craft number; the item schema does not say which`);
    return { sku: null, obj: null };
  }
  let crateSeries = s.crateSeries;
  if (s.isCrate && crateSeries === null && !SERIESLESS_CRATES.has(defindex)) {
    // Crates are priced per series (backpack.tf orders, PriceDB, the schema's resolver): a bare SKU is
    // one no order or price uses. A case with one series takes it from the schema; anything else is refused.
    crateSeries = schemaCrateSeries(ctx, defindex, s.name.plain);
    if (crateSeries === null) {
      w.push(`series-unresolved: "${clip(s.name.plain, 60)}" shows no crate series`);
      return { sku: null, obj: null };
    }
    w.push(`series-inferred: crate series #${crateSeries} taken from the item schema`);
  }
  if (s.paintkitConflict) return { sku: null, obj: null };

  // Items that exist only as Unusual have no effect (schema item_quality 5): their SKU is complete without one.
  if (s.quality === 5 && s.effect === null && safe(() => ctx.schema.itemQuality(defindex), null) !== 5) {
    w.push('unusual-without-effect: unusual quality but no effect found');
    return { sku: null, obj: null };
  }
  if (s.wear !== null && s.paintkit === null) {
    w.push(`paintkit-unresolved: "${clip(s.name.plain, 60)}" has a wear but no known paintkit`);
    return { sku: null, obj: null };
  }
  if (s.paintkit !== null && s.wear === null) {
    w.push(`wear-unresolved: paintkit ${s.paintkit} without a wear`);
    return { sku: null, obj: null };
  }

  const obj = normalizeSkuObject({
    defindex,
    quality: s.quality,
    craftable: !s.uncraftable,
    tradable: s.tradable,
    killstreak: s.killstreak,
    australium: s.australium,
    effect: s.effect,
    festive: s.festive,
    paintkit: s.paintkit,
    wear: s.wear,
    quality2: s.elevated ? 11 : null,
    crateseries: crateSeries,
    paint: null,
  });
  return { sku: fromObject(obj), obj };
}

// ---------------------------------------------------------------------------
// /items price list rows
// ---------------------------------------------------------------------------

/** A "Price we pay" cell longer than this is not a price (real ones read "3 keys, 42 refined"). */
const MAX_PAYS_CHARS = 200;
/** Empty, or only dashes ("—"): scrap.tf shows no buy price for the item. */
const NO_PAYS_RE = /^[\s\-\u2010-\u2015\u2212]*$/;

/**
 * What scrap.tf pays for a list row (F14), from the header-detected "Price we pay" column. Null with
 * an item warning when the cell is missing, empty, a dash, zero or not a price. Without the column
 * (`paysColumn` null) every row is null and the page warns once instead.
 */
function rowPays(cells: Element[], paysColumn: number | null, warnings: string[]): { keys: number; scrap: number } | null {
  if (paysColumn === null) return null;
  const cell = cells[paysColumn];
  if (!cell) {
    warnings.push('no-pays-price: row has no "Price we pay" cell');
    return null;
  }
  const text = textContent(cell);
  if (NO_PAYS_RE.test(text)) {
    warnings.push(`no-pays-price: "Price we pay" is ${text ? `"${clip(text, 10)}"` : 'empty'}`);
    return null;
  }
  const p = text.length <= MAX_PAYS_CHARS ? parsePrice(text, 'ref') : null;
  if (!p) {
    warnings.push(`unparsed-pays-price: "${clip(text, 40)}"`);
    return null;
  }
  if (p.keys <= 0 && p.scrap <= 0) {
    warnings.push(`no-pays-price: scrap.tf pays nothing ("${clip(text, 40)}")`);
    return null;
  }
  return { keys: p.keys, scrap: p.scrap };
}

/**
 * Where the "Item Limits" bar keeps "n/limit". scrap.tf renders it in `title`; once its tooltip script
 * has run on the live page (the scrap.tf window reads that DOM), Bootstrap 3 moves it to
 * data-original-title (title left ""), Bootstrap 5 to data-bs-original-title (title removed), and a
 * bar with no text may carry it as aria-label. Read in this order (P1).
 */
const LIMIT_ATTRS = ['title', 'data-original-title', 'data-bs-original-title', 'aria-label'] as const;
const LIMIT_RE = /^\s*(\d{1,7})\s*\/\s*(\d{1,7})\s*$/;

interface Limits {
  stock: number;
  limit: number;
}

/** "n/limit" from the bar's attributes on the cell or inside it (LIMIT_ATTRS order), else null. */
function limitsByAttr(cell: Element): Limits | null {
  const els = [cell, ...descendants(cell)];
  for (const name of LIMIT_ATTRS) {
    for (const h of els) {
      const m = LIMIT_RE.exec(getAttr(h, name) ?? '');
      if (m) return { stock: Number(m[1]), limit: Number(m[2]) };
    }
  }
  return null;
}

/**
 * The bar's own numbers when no attribute carries them: the first two leaf elements (no element
 * children) whose text is a whole number, or one reading "n/limit". Never the whole cell's text, which
 * runs the two together ("49" and "50" read "4950").
 */
function limitsByLeaves(cell: Element): Limits | null {
  const nums: number[] = [];
  for (const d of descendants(cell)) {
    if (SKIP_TEXT_TAGS.has(d.tagName) || d.childNodes.some(isElement)) continue;
    const t = textContent(d);
    const pair = nums.length === 0 ? LIMIT_RE.exec(t) : null;
    if (pair) return { stock: Number(pair[1]), limit: Number(pair[2]) };
    if (/^\d{1,7}$/.test(t)) nums.push(Number(t));
    if (nums.length === 2) return { stock: nums[0]!, limit: nums[1]! };
  }
  return null;
}

/** "Item Limits": stock n of at most `limit` (n >= limit: scrap.tf buys no more), from the attributes, else the bar's numbers. */
function limitsIn(cell: Element): Limits | null {
  return limitsByAttr(cell) ?? limitsByLeaves(cell);
}

/** Column indexes of a /items row, from the table header (price and name fall back to the usual layout). */
interface RowColumns {
  /** null (P7): the table has headers but none says "Price to buy", so no price is read at all. */
  price: number | null;
  name: number;
  pays: number | null;
  limits: number | null;
}

/** P4: a report may hold this many of a row's cell texts. */
const REPORT_MAX_CELLS = 12;

function parseRow(row: Element, cols: RowColumns, ctx: Ctx): ParsedEntry {
  const { price: priceColumn, name: nameColumn, pays: paysColumn } = cols;
  const warnings: string[] = [];
  const a = validateAttrs(RowAttrsSchema, attrsOf(row), warnings);
  const cells = cellsOf(row);
  const title = cells[nameColumn] ? textContent(cells[nameColumn]) : '';
  const defindex = a['data-defindex'] ?? null;
  const item = defindex !== null ? safe(() => ctx.schema.itemByDefindex(defindex), null) : null;
  let quality = a['data-quality'] ?? null;
  const isCrate = a['data-type'] === 'supply_crate' || item?.itemClass === 'supply_crate';
  const name = parseName(title, { item, quality, isCrate, effectHint: null }, ctx);
  if (quality === null) {
    quality = name.qualities[0] ?? (name.strange ? 11 : 6);
    warnings.push(`unknown-quality: row has no data-quality; using ${quality}`);
  }
  for (const l of name.leftover) warnings.push(`unparsed-name: "${clip(l, 60)}" in "${clip(name.plain, 60)}"`);

  const priceCell = priceColumn !== null ? cells[priceColumn] : undefined;
  const priceText = priceCell ? textContent(priceCell) : '';
  const parsed = priceText ? parsePrice(priceText, 'ref') : null;
  if (priceColumn === null) warnings.push('no-price: the list shows no "Price to buy" column');
  else if (!priceText) warnings.push('no-price: row has no "Price to buy" cell');
  else if (!parsed) warnings.push(`unparsed-price: "${clip(priceText, 40)}"`);
  const pays = rowPays(cells, paysColumn, warnings);

  // By its header when the page has one, else the first cell after the price that carries it (as before):
  // the attributes of every such cell first, then their bars' numbers.
  const limitsCell = cols.limits !== null ? cells[cols.limits] : undefined;
  let limits = limitsCell ? limitsIn(limitsCell) : null;
  if (!limits) {
    const rest = cells.slice(priceColumn !== null ? priceColumn + 1 : 0);
    for (const read of [limitsByAttr, limitsByLeaves]) {
      for (const c of rest) {
        limits = read(c);
        if (limits) break;
      }
      if (limits) break;
    }
  }
  // P1: the list has a limits column but this row's stock cannot be read: a sold-out row would read as
  // buyable, so the row is no price (the saved list keeps it, its stock unknown).
  if (!limits && cols.limits !== null) warnings.push(`${NO_STOCK_LIMIT}: the "Item Limits" cell shows no stock that can be read`);
  const stock = limits?.stock ?? null;
  const stockLimit = limits?.limit ?? null;

  // P2: a skin keyed as backpack.tf keys it (skinQuality), as on a card.
  const paintkit = name.paintkit?.id ?? null;
  let elevated = quality !== 11 && name.strange;
  let skuQuality = quality;
  if (paintkit !== null && name.wear !== null) {
    const skin = skinQuality(quality, name.effect, elevated || quality === 11);
    if (skin) ({ quality: skuQuality, elevated } = skin);
  }

  const built = buildSku(ctx, {
    defindex,
    quality: skuQuality,
    elevated,
    effect: name.effect,
    killstreak: name.killstreak,
    australium: name.australium,
    festive: name.festive,
    uncraftable: name.uncraftable,
    tradable: true,
    wear: name.wear,
    paintkit,
    paintkitConflict: false,
    isCrate,
    crateSeries: name.crateSeries,
    item,
    name,
    fallbackTitle: title,
    warnings,
  });
  return {
    item: {
      title,
      sku: built.sku,
      skuObject: built.obj,
      name: displayName(ctx, built.sku, name.plain || title),
      costKeys: parsed?.keys ?? 0,
      costScrap: parsed?.scrap ?? 0,
      special: emptySpecial(),
      assetId: null,
      stock,
      warnings,
      pays,
      stockLimit,
    },
    // P4: the row's cells as text, and the attributes its stock was (or was not) read from.
    report: ctx.diagnostics
      ? () => {
          const holder = limitsCell ?? cells.slice(priceColumn !== null ? priceColumn + 1 : 0).find((c) => limitsByAttr(c) !== null) ?? null;
          const attrEl = holder ? ([holder, ...descendants(holder)].find((h) => LIMIT_ATTRS.some((n) => getAttr(h, n) !== null)) ?? holder) : null;
          const classes = [...classesOf(row), ...descendants(row).filter((d) => classesOf(d).includes('item')).flatMap(classesOf)];
          return {
            ...cardReportBase(row, [...new Set(classes)]),
            title: name.customName === null ? title : null,
            cells: cells.slice(0, REPORT_MAX_CELLS).map((c, i) => (i === nameColumn && name.customName !== null ? '' : textContent(c))),
            limitAttrs: attrEl
              ? {
                  title: getAttr(attrEl, 'title'),
                  dataOriginalTitle: getAttr(attrEl, 'data-original-title'),
                  dataBsOriginalTitle: getAttr(attrEl, 'data-bs-original-title'),
                  ariaLabel: getAttr(attrEl, 'aria-label'),
                }
              : { title: null, dataOriginalTitle: null, dataBsOriginalTitle: null, ariaLabel: null },
            sku: built.sku,
            warnings: reportWarnings(warnings),
          };
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function utf8Length(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** The slug comes from the untrusted page, so it is clipped; the items still import. */
function unknownBankWarning(slug: string): string {
  return `unknown-bank: ${clip(slug, 40) || '(empty)'} is not a scrap.tf bank page this app knows; coverage uses the item categories`;
}

interface PageGuess {
  kind: ImportPageKind;
  bank: ScraptfBank | null;
  /** A pid-buy-<slug> body id this app does not know (warned as unknown-bank). */
  unknownSlug: string | null;
}

/**
 * Page kind and bank of a page saved without a scrap.tf address. The body id is the strongest sign
 * (saved pages carry pid-items, pid-unusuals and pid-buy-<slug>, see the fixtures); the title only
 * tells the kind, never which bank: the /items list is titled "Item Trading" too.
 */
function guessPage(title: string | null, scan: DocScan): PageGuess {
  const none = { bank: null, unknownSlug: null };
  const body = (scan.bodyId ?? '').trim();
  if (/^pid-items$/i.test(body) && scan.rows.length > 0) return { kind: 'items-list', bank: 'list', unknownSlug: null };
  if (scan.rows.length > 0 && scan.cards.length === 0) return { kind: 'items-list', bank: 'list', unknownSlug: null };
  if (scan.cards.length > 0) {
    if (/^pid-unusuals?$/i.test(body)) return { kind: 'unusuals', bank: 'unusuals', unknownSlug: null };
    const slug = /^pid-buy-([a-z0-9_-]{1,40})$/i.exec(body)?.[1]?.toLowerCase() ?? null;
    if (slug !== null) {
      const bank = BUY_SLUG_BANKS.get(slug) ?? null;
      if (bank === 'unusuals') return { kind: 'unusuals', bank, unknownSlug: null };
      return { kind: 'buy', bank, unknownSlug: bank === null ? slug : null };
    }
  }
  const t = (title ?? '').slice(0, MAX_TITLE_CHARS);
  if (!/scrap\.?tf/i.test(t)) return { kind: 'unknown', ...none };
  if (/unusual/i.test(t)) return { kind: 'unusuals', bank: 'unusuals', unknownSlug: null };
  if (scan.cards.length > 0) {
    // "<kind> ... trading|bank" in two linear steps: an unanchored /kind.*trading/ rescans
    // to the end from every keyword. The first keyword leaves the longest remainder.
    const kind = /(hat|weapon|strange|killstreak|skin|item)s?\b/i.exec(t);
    if (kind && /\b(trading|bank)/i.test(t.slice(kind.index + kind[0].length))) return { kind: 'buy', ...none };
  }
  return { kind: 'unknown', ...none };
}

export interface ParseOptions {
  /**
   * F18: the address the file itself names outside the HTML (an .mhtml part's Content-Location),
   * read first, as the saved-from comment is. Only parsed as text by pageKindFromUrl, never fetched.
   */
  address?: string | null;
  /**
   * 0.7.1 (P4): also return ScrapTfParseResult.diagnostics for the parser report (importSavedPage asks).
   * Off by default, so other callers parse exactly as before.
   */
  diagnostics?: boolean;
}

/** F18 S3: a recognised bank page (any /buy bank or unusuals) whose save holds no card. */
export const NO_CARDS_SAVED_WARNING =
  "no-cards-saved: This page was saved without its items. 'HTML only' keeps the page as it first loaded, before scrap.tf added the cards. Save it again as 'Webpage, Complete'.";

/** The bank pages S3 warns about: every recognised bank but the /items list (a sold-out list still lists its rows). */
function isCardBank(bank: ScraptfBank | null): boolean {
  return bank !== null && bank !== 'list';
}

/**
 * A body id that names a bank page (pid-buy-<known slug>, pid-unusuals). guessPage needs cards before it
 * trusts one (F15), but a page that says it is a bank and shows no card was saved without its items.
 */
function bodyIdNamesCardBank(bodyId: string | null): boolean {
  const body = (bodyId ?? '').trim();
  if (/^pid-unusuals?$/i.test(body)) return true;
  const slug = /^pid-buy-([a-z0-9_-]{1,40})$/i.exec(body)?.[1]?.toLowerCase() ?? null;
  return slug !== null && isCardBank(BUY_SLUG_BANKS.get(slug) ?? null);
}

/**
 * P4: item codes that mark a stored item as read by a guess or with a disagreement, so the report
 * keeps it beside the refused ones.
 */
const REPORT_GUESS_CODES: ReadonlySet<string> = new Set([
  'unknown-quality',
  'paintkit-inferred',
  'series-inferred',
  'ambiguous-paint',
  'effect-mismatch',
  'price-mismatch',
  'unparsed-modifier',
  'unparsed-name',
  NO_STOCK_LIMIT,
  LAYOUT_CHANGED,
]);
const REFUSAL_CODES: ReadonlySet<string> = new Set(IMPORT_REFUSAL_CODES);

/** P4: an item the report keeps: refused (no SKU, no usable price, a refusal code) or read with a guess. */
function reportWorthy(item: ParsedScrapItem): boolean {
  if (!isImportableItem(item)) return true;
  return item.warnings.some((w) => {
    const c = importWarningCode(w);
    return REPORT_GUESS_CODES.has(c) || (REFUSAL_CODES.has(c) && c !== 'no-defindex');
  });
}

/** P4: the report's header texts (the price list's header row), at most 20, each short. */
function headerTexts(cells: readonly Element[] | null): string[] {
  return (cells ?? []).slice(0, 20).map((c) => clip(textContent(c), 40));
}

/**
 * Parses a saved scrap.tf page into items with SKUs and prices. Throws
 * ImportTooLargeError above MAX_IMPORT_BYTES; everything else is reported as
 * warnings. Nothing in the page is executed or fetched.
 */
export function parseScrapTfHtml(html: string, schema: SchemaService, opts: ParseOptions = {}): ScrapTfParseResult {
  if (typeof html !== 'string') throw new TypeError('parseScrapTfHtml expects the page as a string');
  if (html.length > MAX_IMPORT_BYTES || (html.length * 3 > MAX_IMPORT_BYTES && utf8Length(html) > MAX_IMPORT_BYTES)) {
    throw new ImportTooLargeError(utf8Length(html));
  }
  const text = html.charCodeAt(0) === 0xfeff ? html.slice(1) : html;
  const ctx = makeCtx(schema, opts.diagnostics === true);
  const warnings: string[] = [];

  const doc = parse(text);
  const scan = scanDocument(doc);
  // P4: what the parser saw, filled in below; only returned when asked for.
  const counts: ImportReport['counts'] = {
    dataDefindex: scan.dataDefindex,
    cards: scan.cards.length,
    rows: scan.rows.length,
    selectedSkipped: scan.skippedCards,
    duplicates: 0,
    lookalikes: scan.lookalikes,
  };
  const reports: ImportReportItem[] = [];
  const withDiagnostics = (r: ScrapTfParseResult): ScrapTfParseResult =>
    ctx.diagnostics ? { ...r, diagnostics: { counts, headerColumns: headerTexts(scan.headerCells), items: reports } } : r;

  // Page kind: the file's own address (an .mhtml part's Content-Location), saved-from comment,
  // canonical link, og:url, then title/structure.
  const savedFrom = SAVED_FROM_RE.exec(text.slice(0, 64 * 1024))?.[1] ?? null;
  const address = typeof opts.address === 'string' ? opts.address : null;
  const hints = [address, savedFrom, scan.canonical, scan.ogUrl]
    .filter((u): u is string => typeof u === 'string' && u.trim() !== '')
    .map((u) => pageKindFromUrl(u))
    .filter((h): h is PageHint => h !== null);
  const hint = hints.find((h) => h.scrapTf) ?? hints[0] ?? null;

  let pageKind: ImportPageKind;
  // F15: the scrap.tf page the file was saved from (ImportBatch.bank). Null when it cannot be told,
  // and for pages saved from another site; coverage then falls back to the majority category.
  let bank: ScraptfBank | null = null;
  const page = scraptfPageKey(hint, scan.bodyId);
  if (hint && hint.scrapTf) {
    pageKind = hint.kind;
    bank = hint.bank;
    if (pageKind === 'unknown') {
      warnings.push(`page-not-importable: scrap.tf${hint.path} does not list prices you can buy at; nothing imported`);
      return withDiagnostics({ pageKind, bank, page, items: [], warnings });
    }
    if (pageKind === 'buy' && bank === null) warnings.push(unknownBankWarning(buySlugOf(hint.path) ?? ''));
  } else if (hint) {
    pageKind = 'unknown';
    warnings.push(`not-scraptf: the page was saved from ${hint.host}, not scrap.tf`);
  } else {
    const guess = guessPage(scan.title, scan);
    pageKind = guess.kind;
    bank = guess.bank;
    if (pageKind === 'unknown') warnings.push('page-kind-unknown: no scrap.tf address found in the saved page; check the prices before using them');
    else warnings.push(`page-kind-guessed: treated as ${pageKind} from the page title/layout`);
    if (guess.unknownSlug !== null) warnings.push(unknownBankWarning(guess.unknownSlug));
  }

  if (!safe(() => schema.isLoaded(), false)) {
    warnings.push('schema-not-loaded: item schema is not loaded; names and skins may not be recognised');
  }
  if (scan.skippedCards > 0) warnings.push(`duplicate-cards: ignored ${scan.skippedCards} selected-item copies`);

  const items: ParsedScrapItem[] = [];
  const keep = (entry: ParsedEntry) => {
    items.push(entry.item);
    if (entry.report !== null && reports.length < IMPORT_REPORT_MAX_ITEMS && reportWorthy(entry.item)) reports.push(entry.report());
  };
  /** P4: a card or row that threw: its attributes only (its title could hold a custom name). */
  const failedReport = (el: Element, item: ParsedScrapItem): ParsedEntry['report'] =>
    ctx.diagnostics ? () => ({ ...cardReportBase(el, classesOf(el)), warnings: reportWarnings(item.warnings) }) : null;
  // F18 S4: one card can show in two containers (a "new items" strip and the main grid). By asset id;
  // a card without one by everything it parsed to: scrap.tf stacks identical copies on one card, so an
  // identical second card is the same card shown again (a reserved copy differs by its warning).
  const seenAssets = new Set<string>();
  const seenUnidentified = new Set<string>();
  let dupes = 0;
  let unidentifiedDupes = 0;
  for (const el of scan.cards) {
    let parsed: ParsedEntry & { assetId: string | null };
    try {
      parsed = parseCard(el, ctx);
    } catch (err) {
      const title = getAttr(el, 'data-title') ?? '';
      const item = failedItem(title, `card could not be parsed (${err instanceof Error ? err.message : String(err)})`);
      keep({ item, report: failedReport(el, item) });
      continue;
    }
    if (parsed.assetId !== null) {
      if (seenAssets.has(parsed.assetId)) {
        dupes++;
        continue;
      }
      seenAssets.add(parsed.assetId);
    } else {
      const it = parsed.item;
      const key = JSON.stringify([it.title, it.sku, it.costKeys, it.costScrap, it.stock, it.special, it.warnings]);
      if (seenUnidentified.has(key)) {
        unidentifiedDupes++;
        continue;
      }
      seenUnidentified.add(key);
    }
    keep(parsed);
  }
  counts.duplicates = dupes + unidentifiedDupes;
  if (dupes > 0) warnings.push(`duplicate-cards: ignored ${dupes} cards with an asset id already seen`);
  if (unidentifiedDupes > 0) warnings.push(`duplicate-cards: ignored ${unidentifiedDupes} cards without an asset id shown twice`);

  let cols: RowColumns;
  if (scan.priceColumn !== null) {
    cols = { price: scan.priceColumn, name: scan.nameColumn ?? 1, pays: scan.paysColumn, limits: scan.limitsColumn };
  } else if (scan.rows.length > 0 && scan.headerCells !== null) {
    // P7: the price list has headers, none of them "Price to buy" (renamed or moved): no column is
    // guessed by position, so every row is no price. The other columns are still read by their headers,
    // so the saved list keeps each row's stock and what scrap.tf pays, with no price to buy.
    const named = headerColumnsOf(scan.headerCells);
    cols = { price: null, name: named.name ?? 1, pays: named.pays, limits: named.limits };
    warnings.push(`${NO_PRICE_COLUMN}: the price list has no "Price to buy" column; no price to buy was read`);
  } else {
    // A table with no header row at all: the usual layout, as before.
    cols = { price: 2, name: 1, pays: null, limits: null };
  }
  if (scan.rows.length > 0 && cols.pays === null) {
    // Never guessed by position: a wrong column would read as what scrap.tf pays (Holdings' exit).
    warnings.push('no-pays-column: no "Price we pay" column found; what scrap.tf pays was not read');
  }
  for (const row of scan.rows) {
    try {
      keep(parseRow(row, cols, ctx));
    } catch (err) {
      const item = failedItem(textContent(row).slice(0, 80), `row could not be parsed (${err instanceof Error ? err.message : String(err)})`);
      keep({ item, report: failedReport(row, item) });
    }
  }

  if (items.length === 0 && scan.lookalikes > 0) {
    // P7: item-like elements, none of them in a shape the parser knows: scrap.tf changed its page, so
    // neither "saved without its items" nor "no items" is true. Digits only: no page text.
    warnings.push(`${LAYOUT_CHANGED}: ${scan.lookalikes} item elements not recognised`);
    if (ctx.diagnostics) {
      for (const el of scan.lookalikeEls.slice(0, IMPORT_REPORT_MAX_ITEMS)) {
        reports.push({ ...cardReportBase(el, classesOf(el)), warnings: [`${LAYOUT_CHANGED}: not an item card or price row`] });
      }
    }
  } else if (items.length === 0) {
    // F18 S3: a bank page (/buy/<slug>, /unusuals) with no card. scrap.tf adds its cards after the page
    // has loaded, and "HTML only" writes the page as it first loaded. Coverage, the banks cards and bank
    // stock ignore such a save of a bank page (it stores nothing); a list page keeps 'no-items'.
    const bankPage = hint !== null ? hint.scrapTf && (pageKind === 'buy' || pageKind === 'unusuals') : isCardBank(bank) || bodyIdNamesCardBank(scan.bodyId);
    warnings.push(bankPage ? NO_CARDS_SAVED_WARNING : 'no-items: no item cards or price rows found (save the page after the items have loaded)');
  } else {
    const noSku = items.filter((i) => i.sku === null).length;
    if (noSku > 0) warnings.push(`no-sku: ${noSku} of ${items.length} items could not be identified`);
  }
  return withDiagnostics({ pageKind, bank, page, items, warnings });
}

function failedItem(titleHtml: string, reason: string): ParsedScrapItem {
  const title = safe(() => htmlAttrLines(titleHtml).join(' '), titleHtml) || titleHtml;
  return {
    title,
    sku: null,
    skuObject: null,
    name: title,
    costKeys: 0,
    costScrap: 0,
    special: emptySpecial(),
    assetId: null,
    stock: null,
    warnings: [`parse-error: ${reason}`],
  };
}
