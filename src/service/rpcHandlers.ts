// Every SERVICE_METHODS entry from src/shared/rpc.ts, with zod-validated
// params. Errors are plain messages: no stacks and no file paths reach the
// dashboard (entry.ts scrubs them once more).

import { z } from 'zod';
import { buildLinks } from '../shared/links';
import type { PushContract, PushEvent } from '../shared/rpc';
import { SERVICE_METHODS } from '../shared/rpc';
import { baseSku as toBaseSku, canonical, fromObject, fromString, looksLikeSku } from '../shared/sku';
import {
  CATEGORIES,
  EMPTY_SPECIAL,
  type Category,
  SECRET_NAMES,
  type AppStatus,
  type HealthReport,
  type HistoryPoint,
  type ImportResult,
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
import { isImportableItem, MAX_IMPORT_BYTES, parseScrapTfHtml } from './import';
import { allowedHosts, normalizeHost } from './net';

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
  settings(): Settings;
  secret(name: SecretName): string | null;
  push<E extends PushEvent>(event: E, payload: PushContract[E]): void;
  status(): AppStatus;
  health(): HealthReport;
  /** The scrap.tf price list changed (watchlist cache, setup checklist). */
  pricesChanged(): void;
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

const finite = z.number().refine(Number.isFinite, 'must be a finite number');
const nonNeg = finite.refine((n) => n >= 0, 'must be zero or more');
const id = z.number().int().positive();
const skuText = z
  .string()
  .trim()
  .min(1, 'an item is required')
  .max(300)
  .refine(looksLikeSku, 'not a SKU (pick an item first)');
const limit = (max: number) => z.number().int().min(1).max(max).optional();

const statusEnum = z.enum(['profitable', 'below-threshold', 'unprofitable', 'no-buyers']);
const tierEnum = z.enum(['key', 'ref10', 'ref2', 'small', 'loss', 'none']);
const inputKindEnum = z.enum(['user', 'import', 'rule']);
const categoryEnum = z.enum(CATEGORIES as unknown as [Category, ...Category[]]);

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

const ruleFilter = z.object({
  categories: z.array(categoryEnum).max(20).optional(),
  qualities: z.array(z.number().int()).max(30).optional(),
  craftable: z.boolean().nullable().optional(),
  australium: z.boolean().nullable().optional(),
  killstreak: z.array(z.number().int().min(0).max(3)).max(4).optional(),
  hasEffect: z.boolean().nullable().optional(),
  defindexes: z.array(z.number().int().min(0)).max(500).optional(),
  nameContains: z.string().max(200).nullable().optional(),
});

const ruleInput = z.object({
  id: id.optional(),
  name: z.string().trim().min(1, 'a rule needs a name').max(120),
  filter: ruleFilter,
  costKeys: nonNeg.optional(),
  costScrap: nonNeg,
  observedAt: finite.optional(),
  enabled: z.boolean().optional(),
});

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

function specialKey(s: SpecialAttrs): string {
  return JSON.stringify([s.paint, [...s.spells].sort(), [...s.parts].sort(), s.sheen, s.killstreaker, s.customName, s.customDesc]);
}

/**
 * Parses a page the user saved from scrap.tf and stores its prices as source
 * 'import'. Per SKU and set of extras the cheapest card wins, and it replaces
 * the earlier imported price for that SKU instead of adding duplicates.
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

  // Cheapest card per (base SKU, extras).
  const best = new Map<string, { sku: string; item: (typeof parsed.items)[number]; costScrap: number }>();
  const keyScrap = ctx.engine.keyPrice().valueScrap;
  for (const item of parsed.items) {
    if (!isImportableItem(item) || !item.sku || !looksLikeSku(item.sku)) {
      skipped.push({ reason: item.warnings[0] ?? (item.sku ? 'no price' : 'item not recognised'), title: item.title || item.name });
      continue;
    }
    const { base, paint } = splitSku(item.sku);
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

  const affected = new Set<string>();
  let batchId = 0;
  ctx.repo.transaction(() => {
    batchId = ctx.repo.createImportBatch({ fileName, pageKind: parsed.pageKind, fileMtime: mtime, importedAt: now, itemCount: best.size });
    const previous = new Map<string, ScrapPrice[]>();
    for (const { sku } of best.values()) {
      if (!previous.has(sku)) previous.set(sku, ctx.repo.scrapPricesForSku(sku).filter((sp) => sp.source === 'import'));
    }
    const kept = new Set<number>();
    for (const { sku, item } of best.values()) {
      const olds = previous.get(sku) ?? [];
      const sameExtras = olds.find((o) => !kept.has(o.id) && o.special !== null && specialKey(o.special) === specialKey(item.special));
      const saved = ctx.repo.upsertScrapPrice({
        ...(sameExtras ? { id: sameExtras.id } : {}),
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
      kept.add(saved.id);
      affected.add(sku);
    }
    // Earlier imported prices for these SKUs that this page no longer lists are replaced.
    for (const olds of previous.values()) for (const o of olds) if (!kept.has(o.id)) ctx.repo.deleteScrapPrice(o.id);
  });

  const result: ImportResult = {
    batchId,
    fileName,
    pageKind: parsed.pageKind,
    parsed: parsed.items.length,
    stored: best.size,
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
        if (r) engine.markDirty([base]);
      })
      .catch(() => undefined);
  };

  const handlers: Record<string, (params: unknown, method: string) => unknown> = {
    'status.get': () => ctx.status(),

    'opps.list': (params, m) => listOpportunities(repo, parse(oppQuery, params, m) ?? {}, engine.keyPrice(), clock.now()),

    'opps.events': (params, m) => repo.listEvents(withoutUndefined(parse(eventQuery, params, m) ?? {})),

    'opps.exportCsv': (params, m) => {
      const { kind, query } = parse(z.object({ kind: z.enum(['opportunities', 'events']), query: oppQuery }), params, m);
      const stamp = dateStamp(clock.now());
      if (kind === 'events') {
        return { csv: eventsCsv(repo.listEvents({ limit: 5000 })), suggestedName: `flipdesk-events-${stamp}.csv` };
      }
      // The dashboard's filters and sort, so the file matches the list; paging and grouping do not apply.
      const rows = repo.queryOpportunities(withoutUndefined(query ?? {}));
      return { csv: opportunitiesCsv(rows, engine.keyPrice().valueScrap), suggestedName: `flipdesk-opportunities-${stamp}.csv` };
    },

    'item.detail': async (params, m) => {
      const { sku } = parse(skuOnly, params, m);
      const { full, base } = splitSku(sku);
      const history = await historyFor(base);
      return buildItemDetail({
        repo,
        schema,
        sku: full,
        keyPrice: engine.keyPrice(),
        settings: ctx.settings(),
        now: clock.now(),
        snapshot: snapshotInfo(base),
        history,
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
      const p = parse(priceInput, params, m);
      const now = clock.now();
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
      const saved = repo.upsertScrapPrice(input);
      ctx.pricesChanged();
      engine.markDirty([base]);
      if (ctx.secret('bptfAccessToken') && ctx.settings().connectors.bptfApi && ctx.snapshotStale(base)) ctx.queueSnapshot(base);
      refreshPricedb(base);
      return saved;
    },

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
      const rule = repo.upsertRule(withoutUndefined({ ...p, filter: withoutUndefined(p.filter), observedAt: p.observedAt ?? clock.now() }));
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

    'journal.list': (params, m) => {
      const p = parse(z.object({ limit: limit(10_000) }).optional(), params, m);
      return repo.listJournal(p?.limit ?? 500);
    },

    'journal.add': (params, m) => {
      const p = parse(journalInput, params, m);
      const { full } = splitSku(p.sku);
      return repo.addJournal({
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
    },

    'journal.delete': (params, m) => {
      const { id: entryId } = parse(idOnly, params, m);
      repo.deleteJournal(entryId);
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
