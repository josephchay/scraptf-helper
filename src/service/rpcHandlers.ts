// Every SERVICE_METHODS entry from src/shared/rpc.ts, with zod-validated
// params. Errors are plain messages: no stacks and no file paths reach the
// dashboard (entry.ts scrubs them once more).

import { z } from 'zod';
import { buildLinks } from '../shared/links';
import type { PushContract, PushEvent } from '../shared/rpc';
import { SERVICE_METHODS } from '../shared/rpc';
import { MARKET_MAX_LIMIT, MARKET_MAX_SEARCH_CHARS, MARKET_SORTS, countCategories } from '../shared/market';
import { baseSku as toBaseSku, canonical, fromObject, fromString, isValidSku, looksLikeSku } from '../shared/sku';
import {
  EMPTY_SPECIAL,
  MARKET_SOURCES,
  MARKET_VERDICTS,
  SECRET_NAMES,
  type AppStatus,
  type Category,
  type CategoryCounts,
  type HealthReport,
  type HistoryPoint,
  type ImportResult,
  type MarketSort,
  type MarketSource,
  type MarketVerdict,
  type ScrapPrice,
  type ScrapPriceInput,
  type SecretName,
  type Settings,
  type SpecialAttrs,
  type UnixMs,
} from '../shared/types';
import type { BptfApi, Clock, Engine, HttpClient, Logger, PriceDb, Repo, SchemaService, SteamMarket } from './contracts';
import {
  buildItemDetail,
  eventsCsv,
  journalCsv,
  journalSummary,
  listOpportunities,
  opportunitiesCsv,
  previewRule,
} from './domain';
import { holdingsCsv, type Holdings } from './domain/holdings';
import { marketCategoryOf, marketCsv, type MarketIndex } from './domain/market';
import { buildShoppingList, shoppingCsv } from './domain/shopping';
import { createBuyerChecker } from './buyerCheck';
import { isImportableItem, MAX_IMPORT_BYTES, parseScrapTfHtml } from './import';
import { allowedHosts, normalizeHost } from './net';
import { MAX_BULK_LINES, parseBulkPrices, pricesCsv, rulesFromJson, rulesToJson } from './priceSheetIo';
import { categoryEnum, finite, id, nonNeg, ruleInputSchema } from './rpcSchemas';

export interface HandlerContext {
  clock: Clock;
  log: Logger;
  repo: Repo;
  http: HttpClient;
  schema: SchemaService;
  pricedb: PriceDb;
  bptfApi: BptfApi;
  scm: SteamMarket;
  engine: Engine;
  /** Live market index (F10): in memory, fed by the same local book as the engine; no network. */
  market: MarketIndex;
  /** Holdings (F11): open journal lots priced from the same local book; no network. */
  holdings: Holdings;
  settings(): Settings;
  secret(name: SecretName): string | null;
  push<E extends PushEvent>(event: E, payload: PushContract[E]): void;
  status(): AppStatus;
  health(): HealthReport;
  /** The scrap.tf price list changed (watchlist cache, setup checklist). */
  pricesChanged(): void;
  /** A journal row was added or deleted: held SKUs (watch list), holdings, and the 'journal.changed' push. */
  journalChanged(): void;
  /** Queue a background snapshot for a base SKU (served by the scheduler within the budget). */
  queueSnapshot(baseSku: string): void;
  snapshot(baseSku: string, priority: 'user' | 'background'): Promise<void>;
  snapshotStale(baseSku: string): boolean;
  /** The user re-enabled a host disabled after a challenge page (re-run its jobs, refresh the status). */
  hostUnblocked(host: string): void;
}

export const HISTORY_CACHE_MS = 10 * 60_000;
/** item.detail waits at most this long for PriceDB history; a slower answer fills the cache for next time. */
export const HISTORY_WAIT_MS = 4_000;
const PRICEDB_FRESH_MS = 30 * 60_000;
const USER_SNAPSHOT_MAX_WAIT_MS = 60_000;

// ---------------------------------------------------------------------------
// Param schemas
// ---------------------------------------------------------------------------

const skuText = z
  .string()
  .trim()
  .min(1, 'an item is required')
  .max(300)
  // SKUs are lower case; isValidSku rejects tokens fromString would silently drop
  // ("uncratable"), which would otherwise save the price under another item.
  .toLowerCase()
  .refine(isValidSku, 'not a SKU (pick an item first)');
const limit = (max: number) => z.number().int().min(1).max(max).optional();

const statusEnum = z.enum(['profitable', 'below-threshold', 'unprofitable', 'no-buyers']);
const tierEnum = z.enum(['key', 'ref10', 'ref2', 'small', 'loss', 'none']);
const inputKindEnum = z.enum(['user', 'import', 'rule']);

const oppQuery = z
  .object({
    status: z.array(statusEnum).max(10).optional(),
    categories: z.array(categoryEnum).max(20).optional(),
    tiers: z.array(tierEnum).max(10).optional(),
    minConfidence: finite.optional(),
    inputKinds: z.array(inputKindEnum).max(5).optional(),
    search: z.string().max(200).optional(),
    sort: z.enum(['profit', 'margin', 'confidence', 'updated', 'name']).optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
    offset: z.number().int().min(0).optional(),
    groupBy: z.enum(['category', 'tier', 'confidence', 'input']).optional(),
  })
  .optional();

const eventQuery = z
  .object({
    limit: limit(5000),
    beforeId: z.number().int().optional(),
    sku: z.string().max(300).optional(),
    kinds: z.array(z.enum(['appeared', 'changed', 'gone', 'notified'])).max(4).optional(),
    sinceTs: finite.optional(),
  })
  .optional();

const specialSchema = z.object({
  paint: z.number().int().nullable(),
  spells: z.array(z.string().max(100)).max(20),
  parts: z.array(z.string().max(100)).max(20),
  sheen: z.number().int().nullable(),
  killstreaker: z.number().int().nullable(),
  customName: z.boolean(),
  customDesc: z.boolean(),
});

const priceInput = z.object({
  id: id.optional(),
  sku: skuText,
  name: z.string().max(300).optional(),
  costKeys: nonNeg.optional(),
  costScrap: nonNeg,
  source: z.enum(['user', 'import']).optional(),
  observedAt: finite.optional(),
  note: z.string().max(500).nullable().optional(),
  importBatch: id.nullable().optional(),
  special: specialSchema.nullable().optional(),
  assetId: z.string().max(40).nullable().optional(),
  stock: z.number().int().min(0).nullable().optional(),
});

const ruleInput = ruleInputSchema;

const shoppingQuery = z
  .object({
    categories: z.array(categoryEnum).max(20).optional(),
    search: z.string().max(200).optional(),
    minCeilingScrap: nonNeg.optional(),
    onlyBotBuyers: z.boolean().optional(),
    limit: z.number().int().min(1).max(5000).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .optional();

const marketQuery = z
  .object({
    search: z.string().max(MARKET_MAX_SEARCH_CHARS).optional(),
    categories: z.array(categoryEnum).max(20).optional(),
    verdicts: z.array(z.enum(MARKET_VERDICTS as unknown as [MarketVerdict, ...MarketVerdict[]])).max(10).optional(),
    sources: z.array(z.enum(MARKET_SOURCES as unknown as [MarketSource, ...MarketSource[]])).max(5).optional(),
    minCeilingScrap: nonNeg.optional(),
    onlyBotBuyers: z.boolean().optional(),
    minBuyers: z.number().int().min(0).max(100_000).optional(),
    sort: z.enum(MARKET_SORTS as unknown as [MarketSort, ...MarketSort[]]).optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    limit: z.number().int().min(1).max(MARKET_MAX_LIMIT).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .optional();

const holdingsQuery = z
  .object({
    search: z.string().max(MARKET_MAX_SEARCH_CHARS).optional(),
  })
  .optional();

const steamId64 = z.string().trim().regex(/^\d{17}$/, 'expected a 17-digit SteamID64');

/** Bulk paste preview: the helper enforces the 100 KB / 500-line limits with a friendly refusal; this only bounds memory. */
const MAX_BULK_TEXT_CHARS = 1_000_000;
/** Same size cap as a rules backup the dashboard would reasonably hold. */
const MAX_RULES_JSON_CHARS = 5_000_000;
/** Skip reasons returned by 'rules.importJson' (rulesFromJson already caps its own). */
const MAX_RULE_SKIP_LINES = 400;
export const SCHEMA_LOADING_MESSAGE = 'The item list is still loading, so names cannot be matched yet. Preview again in a moment.';

const journalInput = z.object({
  ts: finite.optional(),
  side: z.enum(['buy', 'sell']),
  venue: z.string().trim().min(1, 'venue is required').max(100),
  sku: skuText,
  name: z.string().max(300).optional(),
  keys: nonNeg.optional(),
  scrap: nonNeg,
  note: z.string().max(500).nullable().optional(),
});

const importParams = z.object({
  html: z.string().max(MAX_IMPORT_BYTES, 'the page is larger than 20 MB'),
  fileName: z.string().max(260),
  mtimeMs: finite,
});

const skuOnly = z.object({ sku: skuText });
const idOnly = z.object({ id });

function parse<T>(schema: z.ZodType<T>, params: unknown, method: string): T {
  const r = schema.safeParse(params);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : '';
  throw new Error(`Invalid parameters for ${method}: ${where}${issue?.message ?? 'invalid'}`);
}

function withoutUndefined<T extends object>(o: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Sorted-key JSON: the same filter written in another key order compares equal. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** What makes two rules the same for an import: name, filter and price (not the date or the on/off switch). */
function ruleKey(r: { name: string; filter: object; costKeys?: number; costScrap: number }): string {
  return stableJson([r.name.trim(), r.filter, r.costKeys ?? 0, Math.round(r.costScrap)]);
}

function dateStamp(ms: UnixMs): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Canonical SKU and its base SKU (paint removed); paint goes into the special attributes. */
function splitSku(sku: string): { full: string; base: string; paint: number | null } {
  const obj = fromString(canonical(sku.trim()));
  const paint = typeof obj.paint === 'number' && obj.paint > 0 ? obj.paint : null;
  return { full: fromObject(obj), base: fromObject({ ...obj, paint: null }), paint };
}

function emptySpecial(): SpecialAttrs {
  return { ...EMPTY_SPECIAL, spells: [], parts: [] };
}

// ---------------------------------------------------------------------------
// Saved-page import (also used by the folder watcher)
// ---------------------------------------------------------------------------

/** The stored base SKUs per category, as the Live market files them (an unreadable SKU counts for none). */
function storedCategories(schema: SchemaService, skus: readonly string[]): CategoryCounts {
  const list: Category[] = [];
  for (const sku of skus) {
    try {
      list.push(marketCategoryOf(schema, sku));
    } catch {
      // counts for no page, as in the index
    }
  }
  return countCategories(list);
}

function specialKey(s: SpecialAttrs): string {
  return JSON.stringify([s.paint, [...s.spells].sort(), [...s.parts].sort(), s.sheen, s.killstreaker, s.customName, s.customDesc]);
}

/**
 * Parses a page the user saved from scrap.tf and stores its prices as source
 * 'import'. Per SKU and set of extras the cheapest card wins, and it replaces
 * the earlier imported price for that SKU instead of adding duplicates.
 * Items with none in stock are not stored. Prices from a page saved later than
 * this one are never replaced or removed.
 * Refused unless the user enabled import and acknowledged the ToS note (R10).
 */
export function importSavedPage(ctx: HandlerContext, p: { html: string; fileName: string; mtimeMs: number }): ImportResult {
  const s = ctx.settings();
  if (!s.import.enabled || s.import.acknowledgedAt === null) {
    throw new Error('Saved-page import is turned off. Enable it (and accept the note) in Settings first.');
  }
  const now = ctx.clock.now();
  const fileName = p.fileName.replace(/^.*[\\/]/, '').slice(0, 200) || 'saved page';
  const mtime = Number.isFinite(p.mtimeMs) && p.mtimeMs > 0 ? Math.min(Math.round(p.mtimeMs), now) : now;
  const parsed = parseScrapTfHtml(p.html, ctx.schema);
  const skipped: ImportResult['skipped'] = [];
  type Item = (typeof parsed.items)[number];

  // Cheapest card per (base SKU, extras).
  const best = new Map<string, { sku: string; item: Item; costScrap: number }>();
  /** Base SKUs the page shows with none in stock: earlier imported copies of them are gone. */
  const soldOut = new Set<string>();
  const keyScrap = ctx.engine.keyPrice().valueScrap;
  for (const item of parsed.items) {
    const title = item.title || item.name;
    const sku = item.sku !== null && looksLikeSku(item.sku) ? item.sku : null;
    // "0/5" on the /items list (priced or "Sold out"): the price to buy cannot be paid right now.
    if (sku !== null && item.stock === 0) {
      skipped.push({ reason: 'out of stock on scrap.tf', title });
      soldOut.add(splitSku(sku).base);
      continue;
    }
    if (sku === null || !isImportableItem(item)) {
      skipped.push({ reason: item.warnings[0] ?? (item.sku ? 'no price' : 'item not recognised'), title });
      continue;
    }
    const { base, paint } = splitSku(sku);
    const special: SpecialAttrs = { ...item.special, paint: item.special.paint ?? paint };
    const key = `${base}|${specialKey(special)}`;
    const total = Math.round(item.costKeys * keyScrap) + item.costScrap;
    const prev = best.get(key);
    if (!prev || total < prev.costScrap) {
      if (prev) skipped.push({ reason: 'a cheaper copy is on the same page', title: prev.item.title || prev.item.name });
      best.set(key, { sku: base, item: { ...item, special }, costScrap: total });
    } else {
      skipped.push({ reason: 'a cheaper copy is on the same page', title: item.title || item.name });
    }
  }

  // The /items list shows plain copies only, so it cannot speak for painted, spelled or named
  // copies imported from bank pages. Rows whose extras were never recorded (null) count as plain.
  const plainKey = specialKey(emptySpecial());
  const extrasKey = (sp: ScrapPrice): string => (sp.special === null ? plainKey : specialKey(sp.special));
  const replaceable = (sp: ScrapPrice): boolean => sp.source === 'import' && (parsed.pageKind !== 'items-list' || extrasKey(sp) === plainKey);
  // Catch-up scans and old pages copied into the watch folder can arrive after a newer page.
  const newerThanPage = (sp: ScrapPrice): boolean => sp.observedAt > mtime;

  const affected = new Set<string>();
  let batchId = 0;
  let stored = 0;
  ctx.repo.transaction(() => {
    const previous = new Map<string, ScrapPrice[]>();
    for (const sku of [...[...best.values()].map((b) => b.sku), ...soldOut]) {
      if (!previous.has(sku)) previous.set(sku, ctx.repo.scrapPricesForSku(sku).filter(replaceable));
    }
    const kept = new Set<number>();
    const writes: { id: number | null; sku: string; item: Item }[] = [];
    for (const { sku, item } of best.values()) {
      const key = specialKey(item.special);
      // A newer row with unrecorded extras must block this write too, or the plain copy is doubled.
      const same = (previous.get(sku) ?? []).filter((o) => !kept.has(o.id) && extrasKey(o) === key);
      const newer = same.find(newerThanPage);
      if (newer) {
        kept.add(newer.id);
        skipped.push({ reason: 'a newer saved page already set this price', title: item.title || item.name });
        continue;
      }
      const target = same[0] ?? null;
      if (target) kept.add(target.id);
      writes.push({ id: target?.id ?? null, sku, item });
    }

    // Classified now, from what this page stores: a later import (an /items list) re-tags the rows it
    // shares with this one, and the coverage strip must still know which bank page this was (F13).
    const categories = storedCategories(ctx.schema, writes.map((w) => w.sku));
    batchId = ctx.repo.createImportBatch({ fileName, pageKind: parsed.pageKind, fileMtime: mtime, importedAt: now, itemCount: writes.length, categories });
    for (const { id: priceId, sku, item } of writes) {
      ctx.repo.upsertScrapPrice({
        ...(priceId !== null ? { id: priceId } : {}),
        sku,
        name: item.name || ctx.schema.nameForSku(sku),
        costKeys: item.costKeys,
        costScrap: item.costScrap,
        source: 'import',
        observedAt: mtime,
        note: null,
        importBatch: batchId,
        special: item.special,
        assetId: item.assetId,
        stock: item.stock,
      });
      affected.add(sku);
    }
    stored = writes.length;
    // Earlier imported prices for these SKUs that this page no longer lists, or shows sold out, are removed.
    for (const [sku, olds] of previous) {
      for (const o of olds) {
        if (kept.has(o.id) || newerThanPage(o)) continue;
        ctx.repo.deleteScrapPrice(o.id);
        affected.add(sku);
      }
    }
  });

  const result: ImportResult = {
    batchId,
    fileName,
    pageKind: parsed.pageKind,
    parsed: parsed.items.length,
    stored,
    skipped: skipped.slice(0, 500),
    warnings: parsed.warnings.slice(0, 100),
  };
  ctx.pricesChanged();
  if (affected.size > 0) ctx.engine.markDirty(affected);
  ctx.push('import.done', result);
  ctx.log.info(`imported ${fileName}: ${result.stored} prices from ${result.parsed} items (${parsed.pageKind})`);
  return result;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export type RpcHandler = (method: string, params: unknown) => Promise<unknown>;

export function createRpcHandlers(ctx: HandlerContext): RpcHandler {
  const { repo, schema, engine, http, log, clock } = ctx;
  const historyCache = new Map<string, { at: UnixMs; points: HistoryPoint[] }>();
  const historyInflight = new Map<string, Promise<HistoryPoint[]>>();
  const refreshing = new Set<string>();

  const historyFor = async (base: string): Promise<HistoryPoint[]> => {
    const now = clock.now();
    const hit = historyCache.get(base);
    if (hit && now - hit.at < HISTORY_CACHE_MS) return hit.points;
    const s = ctx.settings();
    if (!s.connectors.pricedb || s.networkPaused || http.isPaused()) return hit?.points ?? [];
    let p = historyInflight.get(base);
    if (!p) {
      p = ctx.pricedb
        .history(base)
        .catch(() => [] as HistoryPoint[])
        .then((points) => {
          if (historyCache.size > 200) historyCache.clear();
          historyCache.set(base, { at: clock.now(), points });
          return points;
        })
        .finally(() => historyInflight.delete(base));
      historyInflight.set(base, p);
    }
    let timer: unknown = null;
    const timeout = new Promise<HistoryPoint[]>((resolve) => {
      timer = setTimeout(() => resolve(hit?.points ?? []), HISTORY_WAIT_MS);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
    }
  };

  const snapshotInfo = (base: string) => {
    const now = clock.now();
    const next = http.nextAllowedAt('bptf-snapshot');
    return {
      lastAt: repo.getSnapshotAt(base),
      available: !!ctx.secret('bptfAccessToken') && ctx.settings().connectors.bptfApi && ctx.bptfApi.snapshotAvailable(),
      nextAllowedAt: next > now ? next : null,
    };
  };

  const refreshPricedb = (base: string): void => {
    const s = ctx.settings();
    if (!s.connectors.pricedb || s.networkPaused || http.isPaused()) return;
    const row = repo.getPricedb(base);
    if (row && clock.now() - row.fetchedAt < PRICEDB_FRESH_MS) return;
    ctx.pricedb
      .item(base)
      .then((r) => {
        if (!r) return;
        engine.markDirty([base]);
        // The new reference moves the Live market row's confidence and outlier test too.
        ctx.market.markDirty([base]);
      })
      .catch(() => undefined);
  };

  /** The repo write for a validated price ('prices.upsert', 'prices.bulkUpsert'): base SKU, paint moved into the extras. */
  const priceRow = (p: z.infer<typeof priceInput>, now: UnixMs) => {
    const { full, base, paint } = splitSku(p.sku);
    let special: SpecialAttrs | null | undefined = p.special;
    if (paint !== null) special = { ...(special ?? emptySpecial()), paint };
    const name = p.name?.trim() || schema.nameForSku(full);
    const observedAt = p.observedAt !== undefined ? Math.min(p.observedAt, now + 60_000) : now;
    const input: ScrapPriceInput & { name: string; observedAt: UnixMs; source: 'user' | 'import' } = withoutUndefined({
      id: p.id,
      sku: base,
      name,
      costKeys: p.costKeys,
      costScrap: Math.round(p.costScrap),
      source: p.source ?? 'user',
      observedAt,
      note: p.note === undefined ? undefined : p.note?.trim() || null,
      importBatch: p.importBatch,
      special,
      assetId: p.assetId,
      stock: p.stock,
    });
    return { input, base };
  };

  // In-memory 1 h cache lives inside the checker, one per service process.
  const buyers = createBuyerChecker({
    bptfApi: ctx.bptfApi,
    http,
    clock,
    log,
    settings: () => ctx.settings(),
    secret: (name) => ctx.secret(name),
  });

  const handlers: Record<string, (params: unknown, method: string) => unknown> = {
    'status.get': () => ctx.status(),

    'opps.list': (params, m) => listOpportunities(repo, parse(oppQuery, params, m) ?? {}, engine.keyPrice(), clock.now()),

    'opps.events': (params, m) => repo.listEvents(withoutUndefined(parse(eventQuery, params, m) ?? {})),

    'opps.exportCsv': (params, m) => {
      const { kind, query, shopping, market, holdings } = parse(
        z.object({
          kind: z.enum(['opportunities', 'events', 'shopping', 'market', 'holdings']),
          query: oppQuery,
          shopping: shoppingQuery,
          market: marketQuery,
          holdings: holdingsQuery,
        }),
        params,
        m,
      );
      const stamp = dateStamp(clock.now());
      if (kind === 'events') {
        return { csv: eventsCsv(repo.listEvents({ limit: 5000 })), suggestedName: `flipdesk-events-${stamp}.csv` };
      }
      if (kind === 'shopping') {
        // Every matching row: paging does not apply to the file.
        const kp = engine.keyPrice();
        const { limit: _limit, offset: _offset, ...filters } = shopping ?? {};
        const list = buildShoppingList(repo.allOpportunities(), withoutUndefined(filters), kp, clock.now());
        return { csv: shoppingCsv(list.rows, kp.valueScrap), suggestedName: `flipdesk-shopping-${stamp}.csv` };
      }
      if (kind === 'market') {
        // The page's filters and sort; paging does not apply to the file.
        const { limit: _limit, offset: _offset, ...filters } = market ?? {};
        const rows = ctx.market.all(withoutUndefined(filters), clock.now());
        return { csv: marketCsv(rows, engine.keyPrice().valueScrap), suggestedName: `flipdesk-market-${stamp}.csv` };
      }
      if (kind === 'holdings') {
        const rows = ctx.holdings.all(withoutUndefined(holdings ?? {}), clock.now());
        return { csv: holdingsCsv(rows, engine.keyPrice().valueScrap), suggestedName: `flipdesk-holdings-${stamp}.csv` };
      }
      // The dashboard's filters and sort, so the file matches the list; paging and grouping do not apply.
      const rows = repo.queryOpportunities(withoutUndefined(query ?? {}));
      return { csv: opportunitiesCsv(rows, engine.keyPrice().valueScrap), suggestedName: `flipdesk-opportunities-${stamp}.csv` };
    },

    'shopping.list': (params, m) =>
      buildShoppingList(repo.allOpportunities(), withoutUndefined(parse(shoppingQuery, params, m) ?? {}), engine.keyPrice(), clock.now()),

    // In memory only: the index reads the local book the live feed fills, with no request of its own.
    'market.list': (params, m) => ctx.market.list(withoutUndefined(parse(marketQuery, params, m) ?? {}), clock.now()),

    // Also local only: the journal's open lots against the same book the market index reads.
    'holdings.list': (params, m) => ctx.holdings.list(withoutUndefined(parse(holdingsQuery, params, m) ?? {}), clock.now()),

    'item.detail': async (params, m) => {
      const { sku, history: withHistory, target } = parse(
        z.object({ sku: skuText, history: z.boolean().optional(), target: z.enum(['newest', 'plain']).optional() }),
        params,
        m,
      );
      const { full, base } = splitSku(sku);
      // Quick entry's live preview asks without history: local only, no PriceDB request.
      const history = withHistory === false ? [] : await historyFor(base);
      return buildItemDetail({
        repo,
        schema,
        sku: full,
        keyPrice: engine.keyPrice(),
        settings: ctx.settings(),
        now: clock.now(),
        snapshot: snapshotInfo(base),
        history,
        ...(target ? { target } : {}),
      });
    },

    'item.refresh': (params, m) => {
      const { sku } = parse(skuOnly, params, m);
      const { base } = splitSku(sku);
      const s = ctx.settings();
      const no = (reason: string, etaMs: number | null = null) => ({ queued: false, reason, etaMs });
      if (!ctx.secret('bptfAccessToken')) return no('Refreshing needs your backpack.tf access token (Settings).');
      if (!s.connectors.bptfApi) return no('The backpack.tf API is turned off in Settings.');
      if (s.networkPaused || http.isPaused()) return no('The network is paused. Resume it from the top bar first.');
      const blocked = http.hostBlocked('api.backpack.tf');
      if (blocked) return no(`backpack.tf requests are disabled: ${blocked}`);
      if (!ctx.bptfApi.snapshotAvailable()) return no('The backpack.tf snapshot endpoint is unavailable right now; the live feed still updates this item.');
      const wait = Math.max(0, http.nextAllowedAt('bptf-snapshot') - clock.now());
      if (refreshing.has(base)) return { queued: true, reason: null, etaMs: wait + 2_500 };
      if (wait > USER_SNAPSHOT_MAX_WAIT_MS) {
        return no(`The snapshot rate limit is reached; try again in ${Math.ceil(wait / 1000)} s.`, wait);
      }
      refreshing.add(base);
      void ctx
        .snapshot(base, 'user')
        .then(() => ctx.push('opps.changed', { appeared: 0, changed: 0, gone: 0, at: clock.now() }))
        .catch((err: unknown) => log.info(`refresh of ${base} failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => refreshing.delete(base));
      return { queued: true, reason: null, etaMs: wait + 2_500 };
    },

    'item.search': (params, m) => {
      const { q, limit: n } = parse(z.object({ q: z.string().max(300), limit: limit(50) }), params, m);
      return q.trim() ? schema.search(q, n ?? 10) : [];
    },

    'item.resolve': (params, m) => {
      const { text } = parse(z.object({ text: z.string().max(2000) }), params, m);
      return text.trim() ? schema.resolve(text) : null;
    },

    'item.scm': async (params, m) => {
      const { sku } = parse(skuOnly, params, m);
      if (!ctx.settings().connectors.scm) return null;
      const { full } = splitSku(sku);
      const marketHashName = schema.marketHashName(full);
      if (!marketHashName) return { lowest: null, median: null, volume: null, marketHashName: null };
      const r = await ctx.scm.priceOverview(marketHashName);
      return { lowest: r?.lowest ?? null, median: r?.median ?? null, volume: r?.volume ?? null, marketHashName };
    },

    'links.forSku': (params, m) => {
      const { sku, assetId } = parse(z.object({ sku: skuText, assetId: z.string().max(40).nullable().optional() }), params, m);
      const { full } = splitSku(sku);
      const obj = fromString(full);
      return buildLinks({
        sku: full,
        skuObject: obj,
        fullName: schema.nameForSku(full),
        baseName: schema.baseNameForSku(full),
        marketHashName: schema.marketHashName(full),
        effectName: obj.effect !== null ? schema.effectName(obj.effect) : null,
        paintkitName: obj.paintkit !== null ? schema.paintkitName(obj.paintkit) : null,
        assetId: assetId ?? null,
        category: (() => {
          try {
            return schema.categoryForSku(full);
          } catch {
            return null;
          }
        })(),
      });
    },

    'prices.list': (params, m) => {
      const p = parse(z.object({ q: z.string().max(200).optional() }).optional(), params, m);
      return repo.listScrapPrices(p?.q);
    },

    'prices.upsert': (params, m) => {
      const { input, base } = priceRow(parse(priceInput, params, m), clock.now());
      const saved = repo.upsertScrapPrice(input);
      ctx.pricesChanged();
      engine.markDirty([base]);
      if (ctx.secret('bptfAccessToken') && ctx.settings().connectors.bptfApi && ctx.snapshotStale(base)) ctx.queueSnapshot(base);
      refreshPricedb(base);
      return saved;
    },

    // No per-row snapshot or PriceDB request: the scheduler's watched-SKU jobs pick new SKUs up within their budgets.
    'prices.bulkUpsert': (params, m) => {
      const { rows } = parse(z.object({ rows: z.array(priceInput).max(MAX_BULK_LINES, `at most ${MAX_BULK_LINES} rows`) }), params, m);
      const now = clock.now();
      // Each row is a whole typed price: no keys means 0 keys (an update must not keep the old keys),
      // and a typed price belongs to no import batch.
      const writes = rows.map((r) => priceRow({ ...r, costKeys: r.costKeys ?? 0, source: 'user', importBatch: null }, now));
      let added = 0;
      let updated = 0;
      repo.transaction(() => {
        for (const w of writes) {
          repo.upsertScrapPrice(w.input);
          if (w.input.id !== undefined) updated++;
          else added++;
        }
      });
      if (writes.length > 0) {
        ctx.pricesChanged();
        engine.markDirty(new Set(writes.map((w) => w.base)));
      }
      return { added, updated };
    },

    'prices.parseBulk': (params, m) => {
      const { text, bareUnit } = parse(
        z.object({ text: z.string().max(MAX_BULK_TEXT_CHARS, 'the paste is too large'), bareUnit: z.enum(['ref', 'scrap', 'keys']).optional() }),
        params,
        m,
      );
      const resolve = (t: string) => {
        try {
          return t.trim() ? schema.resolve(t) : null;
        } catch {
          return null;
        }
      };
      const r = parseBulkPrices(text, bareUnit ?? 'ref', resolve);
      if (r.refusal !== null) throw new Error(r.refusal);
      // Without the item list every name would read "Item not recognised"; say what is really wrong.
      if (!schema.isLoaded() && r.rows.length > 0) throw new Error(SCHEMA_LOADING_MESSAGE);
      return { rows: r.rows, rejected: r.rejected };
    },

    'prices.exportCsv': () => ({
      csv: pricesCsv(repo.listScrapPrices(), engine.keyPrice().valueScrap),
      suggestedName: `flipdesk-prices-${dateStamp(clock.now())}.csv`,
    }),

    'prices.delete': (params, m) => {
      const { id: priceId } = parse(idOnly, params, m);
      const sp = repo.getScrapPrice(priceId);
      if (sp) {
        repo.deleteScrapPrice(priceId);
        ctx.pricesChanged();
        if (looksLikeSku(sp.sku)) engine.markDirty([toBaseSku(sp.sku)]);
      }
      return { ok: true };
    },

    'rules.list': () => repo.listRules(),

    'rules.upsert': (params, m) => {
      const p = parse(ruleInput, params, m);
      const rule = repo.upsertRule(
        withoutUndefined({ ...p, costScrap: Math.round(p.costScrap), filter: withoutUndefined(p.filter), observedAt: p.observedAt ?? clock.now() }),
      );
      ctx.pricesChanged();
      engine.markAllDirty();
      return rule;
    },

    'rules.delete': (params, m) => {
      const { id: ruleId } = parse(idOnly, params, m);
      repo.deleteRule(ruleId);
      ctx.pricesChanged();
      engine.markAllDirty();
      return { ok: true };
    },

    'rules.preview': (params, m) => {
      const p = parse(ruleInput.extend({ name: z.string().max(120) }), params, m);
      return previewRule(repo, schema, withoutUndefined(p.filter), 20);
    },

    'rules.exportJson': () => {
      const now = clock.now();
      return { json: rulesToJson(repo.listRules(), now), suggestedName: `flipdesk-rules-${dateStamp(now)}.json` };
    },

    // Adds only; existing rules are never deleted or overwritten (rulesFromJson drops ids).
    'rules.importJson': (params, m) => {
      const { json } = parse(z.object({ json: z.string().max(MAX_RULES_JSON_CHARS, 'the backup is too large') }), params, m);
      const { rules, skipped } = rulesFromJson(json);
      const now = clock.now();
      let added = 0;
      repo.transaction(() => {
        // Restoring the same backup twice must not double every rule (and every rule candidate).
        const existing = new Set(repo.listRules().map(ruleKey));
        const seen = new Set<string>();
        for (const r of rules) {
          const { id: _id, ...rest } = r;
          const input = withoutUndefined({
            ...rest,
            filter: withoutUndefined(rest.filter),
            // A date in the future would keep the rule looking freshly observed forever.
            observedAt: Math.min(rest.observedAt ?? now, now),
          });
          const key = ruleKey(input);
          if (existing.has(key) || seen.has(key)) {
            const why = existing.has(key) ? 'already in your rules' : 'repeated in this backup';
            if (skipped.length < MAX_RULE_SKIP_LINES) skipped.push(`"${input.name.slice(0, 60)}": ${why}`);
            continue;
          }
          seen.add(key);
          repo.upsertRule(input);
          added++;
        }
      });
      if (added > 0) {
        ctx.pricesChanged();
        engine.markAllDirty();
      }
      return { added, skipped };
    },

    'buyer.check': (params, m) => buyers.check(parse(z.object({ steamid: steamId64 }), params, m).steamid),

    'journal.list': (params, m) => {
      const p = parse(z.object({ limit: limit(10_000) }).optional(), params, m);
      return repo.listJournal(p?.limit ?? 500);
    },

    'journal.add': (params, m) => {
      const p = parse(journalInput, params, m);
      const { full } = splitSku(p.sku);
      const row = repo.addJournal({
        ts: p.ts ?? clock.now(),
        side: p.side,
        venue: p.venue,
        sku: full,
        name: p.name?.trim() || schema.nameForSku(full),
        keys: p.keys ?? 0,
        scrap: Math.round(p.scrap),
        keyPriceScrap: engine.keyPrice().valueScrap,
        note: p.note?.trim() || null,
      });
      ctx.journalChanged();
      return row;
    },

    // Also the toast's Undo after a recorded trade (F12), so holdings and the journal page follow.
    'journal.delete': (params, m) => {
      const { id: entryId } = parse(idOnly, params, m);
      repo.deleteJournal(entryId);
      ctx.journalChanged();
      return { ok: true };
    },

    'journal.summary': () => journalSummary(repo.listJournal()),

    'journal.exportCsv': () => ({ csv: journalCsv(repo.listJournal()), suggestedName: `flipdesk-journal-${dateStamp(clock.now())}.csv` }),

    'import.html': (params, m) => importSavedPage(ctx, parse(importParams, params, m)),

    'import.batches': (params, m) => {
      const p = parse(z.object({ limit: limit(500) }).optional(), params, m);
      return repo.listImportBatches(p?.limit ?? 20);
    },

    'health.get': () => ctx.health(),

    // Only the user clears a challenge block (R7); the service never retries a blocked host on its own.
    'net.unblock': (params, m) => {
      const { host: raw } = parse(z.object({ host: z.string().trim().min(1, 'a host is required').max(253) }), params, m);
      const host = normalizeHost(raw);
      if (!allowedHosts().includes(host) && http.hostBlocked(host) === null) {
        throw new Error(`${host.slice(0, 64)} is not a host this app contacts.`);
      }
      http.unblockHost(host);
      ctx.hostUnblocked(host);
      return { ok: true };
    },

    'secrets.test': async (params, m) => {
      const { name } = parse(z.object({ name: z.enum(SECRET_NAMES as unknown as [SecretName, ...SecretName[]]) }), params, m);
      if (name === 'steamApiKey') {
        return ctx.secret('steamApiKey')
          ? { ok: true, message: 'Saved. The Steam Web API key is not used yet, so it was not sent anywhere.' }
          : { ok: false, message: 'No Steam Web API key is set. It is optional and not used yet.' };
      }
      return ctx.bptfApi.test(name);
    },

    'engine.runNow': () => engine.runNow(),
  };

  const known = new Set<string>(SERVICE_METHODS);
  return async (method, params) => {
    if (typeof method !== 'string' || !known.has(method) || !Object.hasOwn(handlers, method)) {
      throw new Error(`Unknown method: ${String(method).slice(0, 64)}`);
    }
    return handlers[method]!(params, method);
  };
}
