// Parser for scrap.tf pages that the user saved themselves (Ctrl+S). The file is
// untrusted: it is parsed with parse5 only (no script execution) and no URL found
// in it is ever resolved or fetched. Markup reference: DESIGN_BRIEF §3.3, checked
// against web.archive.org copies of scrap.tf pages.

import { parse, parseFragment } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { z } from 'zod';
import { parsePrice } from '../../shared/currency';
import { fromObject, normalizeSkuObject } from '../../shared/sku';
import type { ImportPageKind, ParsedScrapItem, SkuObject, SpecialAttrs } from '../../shared/types';
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
  items: ParsedScrapItem[];
  warnings: string[];
}

/**
 * Warnings are "code: detail" strings. Item codes: invalid-attribute, no-defindex,
 * unknown-item, name-unmatched, unparsed-name, unknown-quality, quality-mismatch,
 * unknown-effect, effect-mismatch, unusual-without-effect, ambiguous-paint,
 * unknown-paint, paint-mismatch, paintkit-unresolved, paintkit-mismatch,
 * paintkit-inferred, wear-unresolved, wear-mismatch, killstreak-mismatch,
 * sheen-mismatch, needs-target, unparsed-modifier, reserved, not-tradable,
 * price-mismatch, unparsed-price, no-price, parse-error.
 * Page codes: not-scraptf, page-not-importable, page-kind-guessed,
 * page-kind-unknown, schema-not-loaded, duplicate-cards, no-items, no-sku.
 */
export function warningCode(warning: string): string {
  const i = warning.indexOf(':');
  return i < 0 ? warning : warning.slice(0, i);
}

/** True when the item has a SKU and a usable price (the importer stores only these). */
export function isImportableItem(item: ParsedScrapItem): boolean {
  if (item.sku === null) return false;
  if (item.costKeys <= 0 && item.costScrap <= 0) return false;
  return !item.warnings.some((w) => {
    const c = warningCode(w);
    return c === 'no-price' || c === 'unparsed-price';
  });
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
  host: string;
  path: string;
  scrapTf: boolean;
}

function isScrapTfHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'scrap.tf' || h.endsWith('.scrap.tf');
}

/** Maps a page URL (never fetched) to the import page kind. */
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
  if (!isScrapTfHostname(host)) return { kind: 'unknown', host, path, scrapTf: false };
  const p = path.toLowerCase();
  let kind: ImportPageKind = 'unknown';
  if (/^\/buy\/unusuals?(\/|$)/.test(p) || /^\/unusuals?(\/|$)/.test(p)) kind = 'unusuals';
  else if (/^\/buy\/[^/]+/.test(p)) kind = 'buy';
  else if (/^\/items(\/\d+)?$/.test(p)) kind = 'items-list';
  return { kind, host, path, scrapTf: true };
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
}

function isCard(classes: string[]): boolean {
  return classes.includes('item') && classes.includes('app440');
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
  };
  const stack: { n: Node; selected: boolean }[] = [{ n: root, selected: false }];
  while (stack.length) {
    const { n, selected } = stack.pop()!;
    if (!isElement(n)) {
      const kids = childNodesOf(n);
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ n: kids[i]!, selected });
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

    const classes = classesOf(n);
    if (isCard(classes)) {
      if (selected) scan.skippedCards++;
      else scan.cards.push(n);
      continue;
    }
    if (tag === 'tr') {
      if (getAttr(n, 'data-quality') !== null && getAttr(n, 'data-defindex') !== null) {
        scan.rows.push(n);
        continue;
      }
      if (scan.priceColumn === null) {
        const cells = n.childNodes.filter((c): c is Element => isElement(c) && (c.tagName === 'th' || c.tagName === 'td'));
        const idx = cells.findIndex((c) => c.tagName === 'th' && /price to buy/i.test(textContent(c)));
        if (idx >= 0) {
          scan.priceColumn = idx;
          const nameIdx = cells.findIndex((c) => c.tagName === 'th' && /^items?$/i.test(textContent(c)));
          if (nameIdx >= 0) scan.nameColumn = nameIdx;
        }
      }
    }
    // Selected copies of bank items duplicate the cards in #buy-container.
    const sel = selected || getAttr(n, 'id') === 'buy-selected-container' || classes.includes('buy-selected-items');
    const kids = n.childNodes;
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ n: kids[i]!, selected: sel });
  }
  return scan;
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
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function makeCtx(schema: SchemaService): Ctx {
  let pks: PreparedPaintkit[] | null = null;
  return {
    schema,
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
  if (nctx.isCrate) {
    const series = /\s*(?:Series\s*)?#(\d{1,6})$/i.exec(t);
    if (series) {
      res.crateSeries = Number(series[1]);
      t = t.slice(0, series.index).trim();
    }
  }

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
  spells: string[];
  parts: string[];
  customDesc: boolean;
  unparsed: string[];
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
    if (/^(?:''|"|“).*(?:''|"|”)$/.test(line) && line.length > 2) {
      info.customDesc = true;
      continue;
    }
    if (/\bGrade\b/.test(line)) {
      // Rarity line, e.g. "Commando Grade Flame Thrower (Field-Tested)".
      const w = WEAR_SUFFIX_RE.exec(line);
      if (w) info.wear = WEAR_BY_NAME[w[1]!.toLowerCase()] ?? null;
      continue;
    }
    if (
      /^(?:Crafted|Gifted) by:/i.test(line) ||
      /^Date Received:/i.test(line) ||
      /^(?:Outputs?|Inputs?|Target):/i.test(line) ||
      /\bx\s*\d+$/.test(line) ||
      /^Holiday Restriction:/i.test(line) ||
      /^Craft #?\d+/i.test(line)
    ) {
      continue;
    }
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

function cardPrice(itemValue: number | null, indicator: string | null, warnings: string[]): { keys: number; scrap: number } {
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

function parseCard(el: Element, ctx: Ctx): { item: ParsedScrapItem; assetId: string | null } {
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
  const name = parseName(titleText, { item, quality: q.primary, isCrate: item?.itemClass === 'supply_crate', effectHint: effectImg }, ctx);

  let quality = q.primary;
  if (quality === null) {
    quality = name.qualities.find((x) => x !== 11) ?? (name.strange ? 11 : null);
    if (quality === null) {
      quality = 6;
      warnings.push('unknown-quality: no qualityN class; assuming Unique');
    }
  } else if (name.qualities.length > 0 && !name.qualities.includes(quality) && !q.all.some((x) => name.qualities.includes(x))) {
    warnings.push(`quality-mismatch: card class says ${quality} but title says ${name.qualities.join('/')}`);
  }

  const elevated =
    quality !== 11 && (q.all.includes(11) || name.strange || content.strangeStatClock);

  // Effect
  let effect: number | null = null;
  const nameEffect = content.effectName ? safe(() => ctx.schema.effectIdByName(content.effectName!), null) : null;
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
  const warpaint = cardWarpaint(parts);
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
  ({ paintkit } = warPaintCheck(defindex, paintkit, name, warnings));

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
    crateSeries: name.crateSeries,
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
  };
}

function warPaintCheck(
  defindex: number | null,
  paintkit: number | null,
  name: NameParse,
  warnings: string[],
): { paintkit: number | null } {
  // War Paint items are defindex 16000 + paintkit (DESIGN_BRIEF §4.3).
  if (defindex === null || defindex < 16000 || defindex > 16999) return { paintkit };
  if (!/\bWar Paint\b/i.test(name.plain) && name.wear === null) return { paintkit };
  const implied = defindex - 16000;
  if (paintkit === null) {
    warnings.push(`paintkit-inferred: war paint pk${implied} taken from defindex ${defindex}`);
    return { paintkit: implied };
  }
  if (paintkit !== implied) warnings.push(`paintkit-mismatch: name gives pk${paintkit}, defindex ${defindex} implies pk${implied}`);
  return { paintkit };
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
  crateSeries: number | null;
  item: SchemaItemRow | null;
  name: NameParse;
  fallbackTitle: string;
  warnings: string[];
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
  if (!s.item && schemaLoaded) w.push(`unknown-item: defindex ${s.defindex} is not in the item schema`);
  else if (s.item && !s.name.located && s.name.plain && s.name.customName === null) {
    w.push(`name-unmatched: "${clip(s.name.plain, 60)}" does not contain the schema name "${clip(s.item.itemName, 40)}"`);
  }

  if (s.quality === 5 && s.effect === null) {
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
    defindex: s.defindex,
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
    crateseries: s.crateSeries,
    paint: null,
  });
  return { sku: fromObject(obj), obj };
}

// ---------------------------------------------------------------------------
// /items price list rows
// ---------------------------------------------------------------------------

function parseRow(row: Element, priceColumn: number, nameColumn: number, ctx: Ctx): ParsedScrapItem {
  const warnings: string[] = [];
  const a = validateAttrs(RowAttrsSchema, attrsOf(row), warnings);
  const cells = row.childNodes.filter((c): c is Element => isElement(c) && (c.tagName === 'td' || c.tagName === 'th'));
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

  const priceText = cells[priceColumn] ? textContent(cells[priceColumn]) : '';
  const parsed = priceText ? parsePrice(priceText, 'ref') : null;
  if (!priceText) warnings.push('no-price: row has no "Price to buy" cell');
  else if (!parsed) warnings.push(`unparsed-price: "${clip(priceText, 40)}"`);

  let stock: number | null = null;
  for (const c of cells.slice(priceColumn + 1)) {
    const holders = [c, ...descendants(c)];
    for (const h of holders) {
      const m = /^\s*(\d{1,7})\s*\/\s*(\d{1,7})\s*$/.exec(getAttr(h, 'title') ?? '');
      if (m) {
        stock = Number(m[1]);
        break;
      }
    }
    if (stock !== null) break;
  }

  const built = buildSku(ctx, {
    defindex,
    quality,
    elevated: quality !== 11 && name.strange,
    effect: name.effect,
    killstreak: name.killstreak,
    australium: name.australium,
    festive: name.festive,
    uncraftable: name.uncraftable,
    tradable: true,
    wear: name.wear,
    paintkit: name.paintkit?.id ?? null,
    crateSeries: name.crateSeries,
    item,
    name,
    fallbackTitle: title,
    warnings,
  });
  return {
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
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function utf8Length(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function guessKindFromTitle(title: string | null, scan: DocScan): ImportPageKind {
  if (scan.bodyId && /^pid-items$/i.test(scan.bodyId) && scan.rows.length > 0) return 'items-list';
  if (scan.rows.length > 0 && scan.cards.length === 0) return 'items-list';
  const t = (title ?? '').slice(0, MAX_TITLE_CHARS);
  if (!/scrap\.?tf/i.test(t)) return 'unknown';
  if (/unusual/i.test(t)) return 'unusuals';
  if (scan.cards.length > 0) {
    // "<kind> ... trading|bank" in two linear steps: an unanchored /kind.*trading/ rescans
    // to the end from every keyword. The first keyword leaves the longest remainder.
    const kind = /(hat|weapon|strange|killstreak|skin|item)s?\b/i.exec(t);
    if (kind && /\b(trading|bank)/i.test(t.slice(kind.index + kind[0].length))) return 'buy';
  }
  return 'unknown';
}

/**
 * Parses a saved scrap.tf page into items with SKUs and prices. Throws
 * ImportTooLargeError above MAX_IMPORT_BYTES; everything else is reported as
 * warnings. Nothing in the page is executed or fetched.
 */
export function parseScrapTfHtml(html: string, schema: SchemaService): ScrapTfParseResult {
  if (typeof html !== 'string') throw new TypeError('parseScrapTfHtml expects the page as a string');
  if (html.length > MAX_IMPORT_BYTES || (html.length * 3 > MAX_IMPORT_BYTES && utf8Length(html) > MAX_IMPORT_BYTES)) {
    throw new ImportTooLargeError(utf8Length(html));
  }
  const text = html.charCodeAt(0) === 0xfeff ? html.slice(1) : html;
  const ctx = makeCtx(schema);
  const warnings: string[] = [];

  const doc = parse(text);
  const scan = scanDocument(doc);

  // Page kind: saved-from comment, canonical link, og:url, then title/structure.
  const savedFrom = SAVED_FROM_RE.exec(text.slice(0, 64 * 1024))?.[1] ?? null;
  const hints = [savedFrom, scan.canonical, scan.ogUrl]
    .filter((u): u is string => typeof u === 'string' && u.trim() !== '')
    .map((u) => pageKindFromUrl(u))
    .filter((h): h is PageHint => h !== null);
  const hint = hints.find((h) => h.scrapTf) ?? hints[0] ?? null;

  let pageKind: ImportPageKind;
  if (hint && hint.scrapTf) {
    pageKind = hint.kind;
    if (pageKind === 'unknown') {
      warnings.push(`page-not-importable: scrap.tf${hint.path} does not list prices you can buy at; nothing imported`);
      return { pageKind, items: [], warnings };
    }
  } else if (hint) {
    pageKind = 'unknown';
    warnings.push(`not-scraptf: the page was saved from ${hint.host}, not scrap.tf`);
  } else {
    pageKind = guessKindFromTitle(scan.title, scan);
    if (pageKind === 'unknown') warnings.push('page-kind-unknown: no scrap.tf address found in the saved page; check the prices before using them');
    else warnings.push(`page-kind-guessed: treated as ${pageKind} from the page title/layout`);
  }

  if (!safe(() => schema.isLoaded(), false)) {
    warnings.push('schema-not-loaded: item schema is not loaded; names and skins may not be recognised');
  }
  if (scan.skippedCards > 0) warnings.push(`duplicate-cards: ignored ${scan.skippedCards} selected-item copies`);

  const items: ParsedScrapItem[] = [];
  const seenAssets = new Set<string>();
  let dupes = 0;
  for (const el of scan.cards) {
    let parsed: { item: ParsedScrapItem; assetId: string | null };
    try {
      parsed = parseCard(el, ctx);
    } catch (err) {
      const title = getAttr(el, 'data-title') ?? '';
      items.push(failedItem(title, `card could not be parsed (${err instanceof Error ? err.message : String(err)})`));
      continue;
    }
    if (parsed.assetId !== null) {
      if (seenAssets.has(parsed.assetId)) {
        dupes++;
        continue;
      }
      seenAssets.add(parsed.assetId);
    }
    items.push(parsed.item);
  }
  if (dupes > 0) warnings.push(`duplicate-cards: ignored ${dupes} cards with an asset id already seen`);

  const priceColumn = scan.priceColumn ?? 2;
  const nameColumn = scan.nameColumn ?? 1;
  for (const row of scan.rows) {
    try {
      items.push(parseRow(row, priceColumn, nameColumn, ctx));
    } catch (err) {
      items.push(failedItem(textContent(row).slice(0, 80), `row could not be parsed (${err instanceof Error ? err.message : String(err)})`));
    }
  }

  if (items.length === 0) {
    warnings.push('no-items: no item cards or price rows found (save the page after the items have loaded)');
  } else {
    const noSku = items.filter((i) => i.sku === null).length;
    if (noSku > 0) warnings.push(`no-sku: ${noSku} of ${items.length} items could not be identified`);
  }
  return { pageKind, items, warnings };
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
