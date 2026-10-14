// In-memory stand-in for window.flipdesk so the dashboard runs in a plain
// browser (npm run dev:renderer). Development only: all data is fake, nothing
// is persisted and nothing leaves the page.

import type { AppInfo, FlipdeskBridge, PushContract, PushEvent, RpcMethod, RpcParams, RpcResult } from '../shared/rpc';
import { formatScrap } from '../shared/currency';
import { DEFAULT_SETTINGS, mergeSettings } from '../shared/defaults';
import { canonical, fromString, looksLikeSku } from '../shared/sku';
import type {
  AppStatus,
  BuyerCheck,
  ConnectorHealth,
  HealthReport,
  ImportBatch,
  ImportResult,
  ItemDetail,
  ItemSuggestion,
  JournalEntry,
  KeyPriceQuote,
  KeyPriceState,
  Opportunity,
  OpportunityEvent,
  OpportunityEventKind,
  PriceRule,
  RequestLogRow,
  ResolvedItem,
  ScrapPrice,
  SecretsStatus,
  Settings,
  SetupCode,
  ShoppingListResult,
  ShoppingQuery,
  UnixMs,
} from '../shared/types';
import { SECRET_NAMES } from '../shared/types';
import {
  CATALOG,
  MOCK_KEY_SCRAP,
  SEED_RULES,
  allSearchable,
  createRng,
  evaluateOpportunity,
  findCatalogItem,
  makeBook,
  mockJournalSummary,
  mockLinks,
  mockParseBulk,
  mockRevenue,
  mockRulesFromJson,
  mockRulesToJson,
  mockShoppingList,
  ruleMatches,
  seedJournal,
  seedPrices,
  type CatalogItem,
  type MockBook,
  type MockInput,
} from './mockData';
import { filterOpportunities, orderByGroup, sortOpportunities, summarizeGroups } from './oppModel';

export interface MockOptions {
  seed?: number;
  now?: () => UnixMs;
  /** Simulated live-feed interval; 0 disables the timer (tests call tick()). */
  tickMs?: number;
  /** Simulated IPC latency upper bound in ms. */
  latencyMs?: number;
  /** Extra synthetic price inputs (defaults to the ?stress= URL parameter). */
  stressRows?: number;
}

function readStressParam(): number {
  if (typeof location === 'undefined') return 0;
  const n = Number(new URLSearchParams(location.search).get('stress'));
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

export interface MockBridge extends FlipdeskBridge {
  /** Advances the simulated live feed once. */
  tick(): void;
  dispose(): void;
}

type Handler<M extends RpcMethod> = (params: RpcParams<M>) => RpcResult<M> | Promise<RpcResult<M>>;
type Handlers = { [M in RpcMethod]: Handler<M> };

const MIN = 60_000;
const HOUR = 3_600_000;

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function stamp(now: UnixMs): string {
  return new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, '-');
}

/** Sorted-key JSON, so the same filter in another key order compares equal (as in rpcHandlers.ts). */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** The service's rules-import identity: name, filter and price, not the date or the on/off switch. */
function mockRuleKey(r: { name: string; filter: object; costKeys?: number; costScrap: number }): string {
  return stableJson([r.name.trim(), r.filter, r.costKeys ?? 0, Math.round(r.costScrap)]);
}

export function createMockBridge(opts: MockOptions = {}): MockBridge {
  const now = opts.now ?? (() => Date.now());
  const rng = createRng(opts.seed ?? 20261014);
  const latency = opts.latencyMs ?? 60;
  const tickMs = opts.tickMs ?? 4000;
  const t0 = now();

  let settings: Settings = mergeSettings(DEFAULT_SETTINGS, {});
  const secrets: SecretsStatus = { bptfApiKey: false, bptfAccessToken: false, steamApiKey: false };

  const books = new Map<string, MockBook>();
  CATALOG.forEach((item, i) => books.set(item.sku, makeBook(rng, item, t0, i % 17 === 9)));

  let prices: ScrapPrice[] = seedPrices(rng, t0);
  let priceSeq = prices.reduce((m, p) => Math.max(m, p.id), 0) + 1;

  // "?stress=5000" adds synthetic inputs to exercise the virtualised table.
  const stress = Math.max(0, Math.min(10_000, opts.stressRows ?? readStressParam()));
  for (let i = 0; i < stress; i++) {
    const item = CATALOG[i % CATALOG.length]!;
    const cost = Math.max(1, Math.round(item.value * (0.8 + rng.next() * 0.35)));
    const keys = cost >= MOCK_KEY_SCRAP ? Math.floor(cost / MOCK_KEY_SCRAP) : 0;
    prices.push({
      id: priceSeq++,
      sku: item.sku,
      name: item.name,
      costKeys: keys,
      costScrap: cost - keys * MOCK_KEY_SCRAP,
      source: 'user',
      observedAt: t0 - rng.int(1, 300) * MIN,
      note: `stress ${i}`,
      importBatch: null,
      special: null,
      assetId: null,
      stock: null,
    });
  }
  let rules: PriceRule[] = SEED_RULES.map((r) => ({ ...r, filter: structuredClone(r.filter), observedAt: t0 - 3 * HOUR }));
  let ruleSeq = rules.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  let journal: JournalEntry[] = seedJournal(t0);
  let journalSeq = journal.length + 1;
  const batches: ImportBatch[] = [
    { id: 3, fileName: 'scrap.tf - Unusuals.html', pageKind: 'unusuals', fileMtime: t0 - 70 * MIN, importedAt: t0 - 69 * MIN, itemCount: 6 },
    { id: 2, fileName: 'scrap.tf - Buy Hats.html', pageKind: 'buy', fileMtime: t0 - 3 * HOUR, importedAt: t0 - 3 * HOUR + MIN, itemCount: 9 },
    { id: 1, fileName: 'scrap.tf - Buy Stranges.html', pageKind: 'buy', fileMtime: t0 - 26 * HOUR, importedAt: t0 - 26 * HOUR + MIN, itemCount: 4 },
  ];
  let batchSeq = 4;

  let opps = new Map<string, Opportunity>();
  let events: OpportunityEvent[] = [];
  let eventSeq = 1;
  const notifiedAt = new Map<string, UnixMs>();
  const buyerChecks = new Map<string, BuyerCheck>();
  const stashed = new Map<string, MockBook['buy']>();
  let lastEngineRunAt: UnixMs | null = null;
  let lastEngineMs: number | null = null;
  let lastRefreshAt = 0;
  let keyDrift = 0;
  let tickCount = 0;

  const feed = { eventsToday: 412_337, bytesToday: 3_180_000_000, lastFrameAt: t0 - 2_000, parseFailures: 3 };
  const requestLog: RequestLogRow[] = seedRequestLog();
  const listeners = new Map<PushEvent, Set<(p: unknown) => void>>();
  let timer: ReturnType<typeof setInterval> | null = null;

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  function keyPrice(): KeyPriceState {
    const t = now();
    const quotes: KeyPriceQuote[] = [
      { source: 'pricedb', buyScrap: MOCK_KEY_SCRAP + keyDrift, sellScrap: MOCK_KEY_SCRAP + 12 + keyDrift, observedAt: t0 - 22 * MIN },
    ];
    if (secrets.bptfApiKey && settings.connectors.bptfApi) {
      quotes.unshift({ source: 'bptf', buyScrap: MOCK_KEY_SCRAP + 2 + keyDrift, sellScrap: MOCK_KEY_SCRAP + 9 + keyDrift, observedAt: t0 - 41 * MIN });
    }
    if (settings.keyPrice.mode === 'manual' && settings.keyPrice.manualScrap) {
      quotes.push({ source: 'manual', buyScrap: settings.keyPrice.manualScrap, sellScrap: null, observedAt: t0 });
      return { valueScrap: settings.keyPrice.manualScrap, source: 'manual', observedAt: t0, stale: false, quotes };
    }
    const q = quotes[0]!;
    let value = q.buyScrap ?? MOCK_KEY_SCRAP;
    if (settings.keyPrice.scraptfSellScrap) value = Math.min(value, settings.keyPrice.scraptfSellScrap);
    return { valueScrap: value, source: q.source, observedAt: q.observedAt, stale: t - q.observedAt > 6 * HOUR, quotes };
  }

  function bookFor(sku: string, name?: string): MockBook {
    const existing = books.get(sku);
    if (existing) return existing;
    const item: CatalogItem = findCatalogItem(sku) ?? { sku, name: name ?? sku, category: guessCategory(sku), value: 0 };
    const book = makeBook(rng, { ...item, value: 0 }, now(), true);
    books.set(sku, book);
    return book;
  }

  function inputs(): { book: MockBook; input: MockInput }[] {
    const out: { book: MockBook; input: MockInput }[] = [];
    for (const p of prices) {
      out.push({
        book: bookFor(p.sku, p.name),
        input: { kind: p.source === 'import' ? 'import' : 'user', ref: `price:${p.id}`, costKeys: p.costKeys, costScrapRaw: p.costScrap, observedAt: p.observedAt, special: p.special },
      });
    }
    for (const rule of rules) {
      if (!rule.enabled) continue;
      for (const item of CATALOG) {
        const book = books.get(item.sku);
        if (!book || !book.buy.some((o) => o.eligible) || !ruleMatches(rule.filter, item)) continue;
        // Only plausible candidates: a flat rule price says nothing about rare or expensive copies.
        const ruleCost = rule.costKeys * MOCK_KEY_SCRAP + rule.costScrap;
        if (item.value > ruleCost * 3 + 18) continue;
        out.push({ book, input: { kind: 'rule', ref: `rule:${rule.id}`, costKeys: rule.costKeys, costScrapRaw: rule.costScrap, observedAt: rule.observedAt, special: null } });
      }
    }
    return out;
  }

  function same(a: Opportunity, b: Opportunity): boolean {
    return (
      a.profitScrap === b.profitScrap &&
      a.revenueScrap === b.revenueScrap &&
      a.costScrap === b.costScrap &&
      a.confidence === b.confidence &&
      a.status === b.status &&
      a.buyerCount === b.buyerCount &&
      // Settings-only changes (thresholds, reference age) move these without touching the rest.
      a.maxCostScrap === b.maxCostScrap &&
      a.flags.join(' ') === b.flags.join(' ')
    );
  }

  function pushEvent(o: Opportunity, kind: OpportunityEventKind, summary: string, ts: UnixMs): void {
    events.push({
      id: eventSeq++,
      key: o.key,
      sku: o.sku,
      name: o.name,
      category: o.category,
      kind,
      profitScrap: o.profitScrap,
      costScrap: o.costScrap,
      revenueScrap: o.revenueScrap,
      confidence: o.confidence,
      summary,
      ts,
    });
    if (events.length > 5000) events = events.slice(-4000);
  }

  function money(v: number | null): string {
    return formatScrap(v, keyPrice().valueScrap);
  }

  /** Re-evaluates every input and records appeared/changed/gone/notified events. */
  function recompute(): { appeared: number; changed: number; gone: number; at: UnixMs } {
    const started = performance.now();
    const t = now();
    const kp = keyPrice().valueScrap;
    const next = new Map<string, Opportunity>();
    let appeared = 0;
    let changed = 0;
    let gone = 0;
    for (const { book, input } of inputs()) {
      const key = `${book.item.sku}|${input.ref}`;
      const prev = opps.get(key) ?? null;
      const o = evaluateOpportunity(book, input, settings, kp, t, prev);
      if (prev && same(prev, o)) {
        next.set(key, prev);
        continue;
      }
      next.set(key, o);
      if (!prev) {
        appeared++;
        pushEvent(o, 'appeared', o.profitScrap === null ? 'no buy orders yet' : `profit ${money(o.profitScrap)} at cost ${money(o.costScrap)}`, t);
      } else {
        changed++;
        const summary =
          prev.profitScrap !== o.profitScrap
            ? `profit ${money(prev.profitScrap)} -> ${money(o.profitScrap)}`
            : prev.confidence !== o.confidence
              ? `confidence ${prev.confidence} -> ${o.confidence}`
              : `status ${prev.status} -> ${o.status}`;
        pushEvent(o, 'changed', summary, t);
      }
      maybeNotify(o, t);
    }
    for (const [key, o] of opps) {
      if (!next.has(key)) {
        gone++;
        pushEvent(o, 'gone', 'input removed or no longer matched', t);
      }
    }
    opps = next;
    lastEngineRunAt = t;
    lastEngineMs = Math.max(1, Math.round(performance.now() - started));
    return { appeared, changed, gone, at: t };
  }

  function maybeNotify(o: Opportunity, t: UnixMs): void {
    const n = settings.notifications;
    if (!n.enabled || o.status !== 'profitable' || o.confidence < n.minConfidence || (o.profitScrap ?? 0) < n.minProfitScrap) return;
    // F5/F6: suspect margins and input kinds the user muted never notify.
    if (o.flags.includes('suspect-margin') || !n.inputKinds.includes(o.inputKind)) return;
    const last = notifiedAt.get(o.key);
    if (last !== undefined && t - last < n.dedupMs) return;
    notifiedAt.set(o.key, t);
    pushEvent(o, 'notified', `desktop notification: +${money(o.profitScrap)}`, t);
  }

  function feedState(): AppStatus['feed'] {
    if (settings.networkPaused) return 'paused';
    if (!settings.liveFeed.enabled) return 'off';
    if (feed.bytesToday >= settings.liveFeed.dailyCapBytes) return 'paused';
    return 'live';
  }

  function setupNeeded(): SetupCode[] {
    const out: SetupCode[] = [];
    if (!secrets.bptfAccessToken) out.push('bptf-token');
    if (!secrets.bptfApiKey) out.push('bptf-key');
    if (!settings.contactUrl.trim()) out.push('contact-url');
    if (prices.length === 0 && rules.length === 0) out.push('first-price');
    return out;
  }

  function status(): AppStatus {
    const all = [...opps.values()];
    const profitable = all.filter((o) => o.status === 'profitable');
    return {
      version: '0.2.0',
      networkPaused: settings.networkPaused,
      feed: feedState(),
      keyPrice: keyPrice(),
      counts: {
        opportunities: all.length,
        profitable: profitable.length,
        highConfidence: profitable.filter((o) => o.confidenceLevel === 'high').length,
      },
      lastEngineRunAt,
      setupNeeded: setupNeeded(),
    };
  }

  function health(): HealthReport {
    const t = now();
    const paused = settings.networkPaused;
    const c = settings.connectors;
    const conn = (h: Partial<ConnectorHealth> & Pick<ConnectorHealth, 'id' | 'label' | 'state'>): ConnectorHealth => ({
      detail: '',
      lastOkAt: null,
      lastErrorAt: null,
      lastError: null,
      disabledReason: null,
      ...h,
      state: paused && h.state !== 'off' ? 'paused' : h.state,
    });
    const counts = { total: 0, buy: 0, sell: 0 };
    for (const b of books.values()) {
      counts.buy += b.buy.length;
      counts.sell += b.sell.length;
    }
    counts.buy *= 1900; // the real book holds every TF2 buy listing
    counts.sell *= 40;
    counts.total = counts.buy + counts.sell;
    return {
      connectors: [
        conn({ id: 'bptf-ws', label: 'backpack.tf live feed', state: feedState(), detail: settings.liveFeed.enabled ? '~55 events/s, buy listings for all items' : 'Turned off in Settings', lastOkAt: feed.lastFrameAt }),
        conn({
          id: 'bptf-snapshot',
          label: 'backpack.tf snapshots',
          state: secrets.bptfAccessToken ? 'idle' : 'off',
          detail: secrets.bptfAccessToken ? 'On demand only, 1 per 10 s' : 'Needs an access token',
          lastOkAt: secrets.bptfAccessToken ? t - 9 * MIN : null,
        }),
        conn({
          id: 'bptf-prices',
          label: 'backpack.tf community prices',
          state: secrets.bptfApiKey && c.bptfApi ? 'idle' : 'off',
          detail: secrets.bptfApiKey ? 'Delta every 2 h' : 'Needs an API key',
          lastOkAt: secrets.bptfApiKey ? t - 47 * MIN : null,
        }),
        conn({
          id: 'bptf-currencies',
          label: 'backpack.tf key price',
          state: secrets.bptfApiKey && c.bptfApi ? 'idle' : 'off',
          detail: secrets.bptfApiKey ? 'Every 60 min' : 'Needs an API key; using PriceDB',
          lastOkAt: secrets.bptfApiKey ? t - 41 * MIN : null,
        }),
        conn({ id: 'pricedb', label: 'PriceDB REST', state: c.pricedb ? 'idle' : 'off', detail: 'Bulk refresh for watched items every 10 min', lastOkAt: t - 3 * MIN }),
        conn({
          id: 'pricedb-socket',
          label: 'PriceDB socket',
          state: c.pricedbSocket ? 'backoff' : 'off',
          detail: c.pricedbSocket ? 'Reconnecting in 16 s (attempt 4 of 5)' : 'Off',
          lastOkAt: t - 38 * MIN,
          lastErrorAt: t - 50_000,
          lastError: c.pricedbSocket ? 'websocket error: connection timed out' : null,
        }),
        conn({ id: 'schema', label: 'Item schema (sku.pricedb.io)', state: 'idle', detail: 'Cached, next check in 19 h', lastOkAt: t0 - 5 * HOUR }),
        conn({ id: 'scm', label: 'Steam Community Market', state: c.scm ? 'idle' : 'off', detail: c.scm ? 'On click only, 1 per 5 s' : 'Off (recommended)' }),
      ],
      budgets: [
        { host: 'api.backpack.tf', policy: 'Snapshots 1 per 10 s, 300 per hour; IGetPrices every 2 h', usedLastHour: 14 + (tickCount % 5), pausedUntil: null, consecutive429: 0 },
        { host: 'pricedb.io', policy: '60 per minute', usedLastHour: 37 + (tickCount % 9), pausedUntil: null, consecutive429: 0 },
        { host: 'sku.pricedb.io', policy: '30 per minute; schema once per 24 h', usedLastHour: 2, pausedUntil: null, consecutive429: 0 },
        { host: 'steamcommunity.com', policy: 'priceoverview on click only, 1 per 5 s', usedLastHour: c.scm ? 3 : 0, pausedUntil: c.scm ? t0 + 4 * HOUR : null, consecutive429: c.scm ? 1 : 0 },
      ],
      feed: {
        enabled: settings.liveFeed.enabled,
        state: feedState(),
        eventsToday: feed.eventsToday,
        bytesToday: feed.bytesToday,
        capBytes: settings.liveFeed.dailyCapBytes,
        lastFrameAt: feed.lastFrameAt,
        listingsTotal: counts.total,
        buyListings: counts.buy,
        sellListings: counts.sell,
        parseFailures: feed.parseFailures,
      },
      schema: { loadedAt: t0 - 5 * HOUR, items: 11_606, effects: 590, paintkits: 250 },
      keyPrice: keyPrice(),
      recentRequests: [...requestLog].sort((a, b) => b.ts - a.ts).slice(0, 60),
      db: { path: 'C:\\Users\\you\\AppData\\Roaming\\TF2 Flip Desk\\flipdesk.db', sizeBytes: 61_440_000 + tickCount * 4096 },
      engine: { lastRunAt: lastEngineRunAt, lastRunMs: lastEngineMs, evaluated: opps.size },
    };
  }

  function seedRequestLog(): RequestLogRow[] {
    const rows: RequestLogRow[] = [];
    const tpl: Omit<RequestLogRow, 'ts' | 'ms' | 'bytes'>[] = [
      { host: 'pricedb.io', path: '/api/items-bulk', method: 'POST', status: 200, note: '87 SKUs' },
      { host: 'pricedb.io', path: '/api/item/30357;5;u702', method: 'GET', status: 200, note: null },
      { host: 'pricedb.io', path: '/api/item/15141;15;u701;w1;pk300;strange', method: 'GET', status: 404, note: 'not covered by PriceDB' },
      { host: 'sku.pricedb.io', path: '/api/schema', method: 'GET', status: 304, note: 'ETag match' },
      { host: 'api.backpack.tf', path: '/api/classifieds/listings/snapshot?sku=Team%20Captain&appid=440&token=[redacted]', method: 'GET', status: 200, note: null },
      { host: 'api.backpack.tf', path: '/api/IGetCurrencies/v1?key=[redacted]&raw=1', method: 'GET', status: 200, note: null },
      { host: 'api.backpack.tf', path: '/api/IGetPrices/v4?key=[redacted]&raw=1&since=1791950000', method: 'GET', status: 200, note: 'delta: 412 items' },
      { host: 'api.backpack.tf', path: '/api/classifieds/listings/snapshot?sku=Strange%20Knife&appid=440&token=[redacted]', method: 'GET', status: 429, note: 'Retry-After 30 s' },
    ];
    for (let i = 0; i < 36; i++) {
      const base = tpl[i % tpl.length]!;
      rows.push({ ...base, ts: t0 - i * 97_000 - rng.int(0, 40_000), ms: rng.int(60, 900), bytes: base.status === 304 ? 0 : rng.int(400, 240_000) });
    }
    return rows;
  }

  // Seed the event log with a plausible history before the first evaluation.
  function seedEvents(): void {
    recompute();
    events = [];
    eventSeq = 1;
    const list = [...opps.values()];
    const seeded: OpportunityEvent[] = [];
    const ev = (o: Opportunity, kind: OpportunityEventKind, summary: string, ts: UnixMs) =>
      seeded.push({ id: 0, key: o.key, sku: o.sku, name: o.name, category: o.category, kind, profitScrap: o.profitScrap, costScrap: o.costScrap, revenueScrap: o.revenueScrap, confidence: o.confidence, summary, ts });
    for (const o of list) {
      const first = t0 - rng.int(10, 9 * 60) * MIN;
      o.firstSeenAt = first;
      o.updatedAt = first;
      ev(o, 'appeared', o.profitScrap === null ? 'no buy orders yet' : `profit ${money(o.profitScrap)} at cost ${money(o.costScrap)}`, first);
      if (o.profitScrap !== null && rng.chance(0.5)) {
        const ts = first + rng.int(1, Math.max(2, Math.floor((t0 - first) / MIN) - 1)) * MIN;
        const before = o.profitScrap - rng.int(-6, 12);
        ev(o, 'changed', `profit ${money(before)} -> ${money(o.profitScrap)}`, ts);
        o.updatedAt = ts;
      }
      if (o.status === 'profitable' && o.confidenceLevel === 'high' && rng.chance(0.7)) {
        ev(o, 'notified', `desktop notification: +${money(o.profitScrap)}`, o.updatedAt + 1000);
        notifiedAt.set(o.key, o.updatedAt + 1000);
      }
    }
    for (const item of CATALOG.slice(0, 40)) {
      if (rng.chance(0.15)) {
        const fake = { key: `${item.sku}|price:999`, sku: item.sku, name: item.name, category: item.category, profitScrap: null, costScrap: null, revenueScrap: null, confidence: 0 } as unknown as Opportunity;
        ev(fake, 'gone', 'last eligible buy order was removed', t0 - rng.int(5, 400) * MIN);
      }
    }
    seeded.sort((a, b) => a.ts - b.ts);
    for (const e of seeded) events.push({ ...e, id: eventSeq++ });
  }

  // ---------------------------------------------------------------------------
  // Push events and the simulated feed
  // ---------------------------------------------------------------------------

  function emit<E extends PushEvent>(event: E, payload: PushContract[E]): void {
    for (const fn of listeners.get(event) ?? []) {
      try {
        fn(structuredClone(payload));
      } catch (e) {
        console.error('[mock] listener failed', e);
      }
    }
  }

  // One-shot UI requests wait for a subscriber, as the preload holds them for a window still loading.
  const held = new Map<PushEvent, unknown>();
  function emitHeld<E extends PushEvent>(event: E, payload: PushContract[E]): void {
    if ((listeners.get(event)?.size ?? 0) > 0) emit(event, payload);
    else held.set(event, payload);
  }

  /** Like the service: every price or rule write tells all windows. */
  function pricesChanged(): void {
    emit('prices.changed', { at: now() });
  }

  function changedAndEmit(): void {
    const diff = recompute();
    if (diff.appeared + diff.changed + diff.gone > 0) emit('opps.changed', diff);
    emit('status.changed', status());
  }

  function tick(): void {
    tickCount++;
    if (settings.networkPaused || !settings.liveFeed.enabled) {
      if (tickCount % 3 === 0) emit('status.changed', status());
      return;
    }
    const t = now();
    const withOrders = [...books.values()].filter((b) => b.buy.some((o) => o.eligible));
    const n = rng.int(1, 3);
    for (let i = 0; i < n && withOrders.length; i++) {
      const book = rng.pick(withOrders);
      const eligible = book.buy.filter((o) => o.eligible);
      const order = rng.pick(eligible);
      const factor = 1 + (rng.next() - 0.47) * 0.08;
      const kp = MOCK_KEY_SCRAP;
      const v = Math.max(1, Math.round(order.valueScrap * factor));
      order.keys = v >= kp ? Math.floor(v / kp) : 0;
      order.metalScrap = v - order.keys * kp;
      order.valueScrap = v;
      order.lastEventAt = t;
      book.buy.sort((a, b) => b.valueScrap - a.valueScrap);
    }
    // Occasionally a whole book disappears and comes back later.
    if (rng.chance(0.06) && withOrders.length > 10) {
      const book = rng.pick(withOrders);
      stashed.set(book.item.sku, book.buy);
      book.buy = [];
    } else if (stashed.size && rng.chance(0.3)) {
      const [sku, buy] = stashed.entries().next().value as [string, MockBook['buy']];
      stashed.delete(sku);
      const book = books.get(sku);
      if (book) book.buy = buy.map((o) => ({ ...o, lastEventAt: t }));
    }
    if (rng.chance(0.05)) keyDrift = Math.max(-4, Math.min(4, keyDrift + (rng.chance(0.5) ? 1 : -1)));
    const frames = rng.int(150, 260);
    feed.eventsToday += frames;
    feed.bytesToday += frames * rng.int(1800, 2600);
    feed.lastFrameAt = t;
    if (rng.chance(0.02)) feed.parseFailures++;
    if (rng.chance(0.35)) {
      const item = rng.pick(CATALOG);
      requestLog.push({ ts: t, host: 'pricedb.io', path: `/api/item/${item.sku}`, method: 'GET', status: rng.chance(0.9) ? 200 : 404, ms: rng.int(70, 400), bytes: rng.int(300, 900), note: null });
      if (requestLog.length > 300) requestLog.splice(0, requestLog.length - 300);
    }
    const diff = recompute();
    if (diff.appeared + diff.changed + diff.gone > 0) emit('opps.changed', diff);
    if (tickCount % 3 === 0) emit('status.changed', status());
  }

  function ensureTimer(): void {
    if (timer || tickMs <= 0) return;
    timer = setInterval(tick, tickMs);
  }

  // ---------------------------------------------------------------------------
  // RPC handlers
  // ---------------------------------------------------------------------------

  function itemName(sku: string): string {
    return findCatalogItem(sku)?.name ?? prices.find((p) => p.sku === sku)?.name ?? books.get(sku)?.item.name ?? sku;
  }

  function search(q: string, limit: number): ItemSuggestion[] {
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    const scored: { s: number; item: CatalogItem }[] = [];
    for (const item of allSearchable()) {
      const name = item.name.toLowerCase();
      if (!tokens.every((t) => name.includes(t) || item.sku.startsWith(t))) continue;
      const s = (name.startsWith(tokens[0]!) ? 0 : 1) + name.length / 1000;
      scored.push({ s, item });
    }
    return scored
      .sort((a, b) => a.s - b.s)
      .slice(0, limit)
      .map(({ item }) => ({ sku: item.sku, name: item.name, category: item.category, source: books.has(item.sku) ? 'bptf' : 'schema' }));
  }

  function resolve(text: string): ResolvedItem | null {
    const t = text.trim();
    if (!t) return null;
    const mk = (item: CatalogItem, match: ResolvedItem['match'], warnings: string[] = []): ResolvedItem => ({
      sku: item.sku,
      name: item.name,
      skuObject: fromString(item.sku),
      category: item.category,
      match,
      warnings,
    });
    if (looksLikeSku(t)) {
      const sku = canonical(t);
      const item = findCatalogItem(sku);
      return mk(item ?? { sku, name: sku, category: guessCategory(sku), value: 0 }, 'sku', item ? [] : ['Unknown to the mock schema; name not resolved']);
    }
    const exact = allSearchable().find((c) => c.name.toLowerCase() === t.toLowerCase());
    if (exact) return mk(exact, 'exact');
    const fuzzy = search(t, 1)[0];
    if (fuzzy) {
      const item = findCatalogItem(fuzzy.sku);
      if (item) return mk(item, 'fuzzy', [`Closest match for "${t}". Check quality and effect.`]);
    }
    return null;
  }

  function detail(sku: string): ItemDetail | null {
    const known = books.get(sku) ?? (findCatalogItem(sku) || prices.some((p) => p.sku === sku) ? bookFor(sku) : null);
    if (!known) return null;
    const t = now();
    const scrapPrices = prices.filter((p) => p.sku === sku).sort((a, b) => b.observedAt - a.observedAt);
    const assetId = scrapPrices.find((p) => p.assetId)?.assetId ?? null;
    const blocked = new Set(settings.blocklist);
    const buyOrders = known.buy
      .map((o) => (blocked.has(o.steamid) && o.eligible ? { ...o, eligible: false, flags: [...o.flags, 'blocklisted'] } : o))
      .sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.valueScrap - a.valueScrap);
    return {
      sku,
      name: known.item.name,
      bptfName: known.item.name,
      category: known.item.category,
      skuObject: fromString(sku),
      revenue: mockRevenue(known, settings, keyPrice().valueScrap, t),
      buyOrders,
      sellListings: known.sell,
      references: known.references,
      scrapPrices,
      opportunities: [...opps.values()].filter((o) => o.sku === sku),
      history: known.history,
      links: mockLinks(sku, known.item.name, assetId),
      snapshot: {
        lastAt: known.snapshotAt,
        available: true,
        nextAllowedAt: lastRefreshAt && t - lastRefreshAt < 10_000 ? lastRefreshAt + 10_000 : null,
      },
      keyPrice: keyPrice(),
    };
  }

  function shoppingList(q: ShoppingQuery): ShoppingListResult {
    return mockShoppingList([...opps.values()], q, settings.profit.useOrder, keyPrice(), now());
  }

  /** Fake but deterministic ban lookup; needs the token and the network like the service, cached 1 h. */
  function checkBuyer(steamid: string): BuyerCheck {
    const t = now();
    const id = typeof steamid === 'string' ? steamid.trim() : '';
    if (!/^\d{17}$/.test(id)) throw new Error('Invalid parameters for buyer.check: steamid: expected a 17-digit SteamID64');
    const fail = (error: string): BuyerCheck => ({ steamid: id, name: null, bptfBanned: null, banDetails: [], checkedAt: t, cached: false, error });
    // As in the service: a cached answer costs no request, so it is served even while paused.
    const hit = buyerChecks.get(id);
    if (hit && t - hit.checkedAt < HOUR && t >= hit.checkedAt) return { ...hit, cached: true };
    if (!secrets.bptfAccessToken) return fail('Add a backpack.tf access token in Settings');
    if (!settings.connectors.bptfApi) return fail('The backpack.tf API is turned off in Settings.');
    if (settings.networkPaused) return fail('The network is paused. Resume it from the top bar first.');
    let order: MockBook['buy'][number] | undefined;
    for (const b of books.values()) {
      order = b.buy.find((o) => o.steamid === id) ?? b.sell.find((o) => o.steamid === id);
      if (order) break;
    }
    const hash = [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    const banned = order?.flags.includes('banned') === true || hash % 13 === 0;
    const r: BuyerCheck = {
      steamid: id,
      name: order?.userName ?? null,
      bptfBanned: banned,
      banDetails: banned ? ['backpack.tf: all (mock)'] : [],
      checkedAt: t,
      cached: false,
      error: null,
    };
    buyerChecks.set(id, r);
    return r;
  }

  function requireImportEnabled(): void {
    if (!settings.import.enabled) throw new Error('Import is turned off. Enable it on the Import page first.');
  }

  const handlers: Handlers = {
    'status.get': () => status(),
    'opps.list': (q) => {
      const sorted = sortOpportunities(filterOpportunities([...opps.values()], q ?? {}), q?.sort ?? 'profit', q?.dir ?? 'desc');
      // Like the service: a grouped list is paged in group order, the sort applying inside each group.
      const rows = q?.groupBy ? orderByGroup(sorted, q.groupBy) : sorted;
      const offset = Math.max(0, q?.offset ?? 0);
      const limit = Math.max(1, Math.min(5000, q?.limit ?? 500));
      return { rows: rows.slice(offset, offset + limit), total: rows.length, groups: summarizeGroups(rows, q?.groupBy ?? 'category'), keyPrice: keyPrice(), generatedAt: now() };
    },
    'opps.events': (q) => {
      let list = events;
      if (q?.kinds?.length) list = list.filter((e) => q.kinds!.includes(e.kind));
      if (q?.sku) list = list.filter((e) => e.sku === q.sku);
      if (q?.sinceTs !== undefined) list = list.filter((e) => e.ts > q.sinceTs!);
      if (q?.beforeId !== undefined) list = list.filter((e) => e.id < q.beforeId!);
      return [...list].sort((a, b) => b.id - a.id).slice(0, Math.max(1, Math.min(2000, q?.limit ?? 200)));
    },
    'opps.exportCsv': ({ kind, query, shopping }) => {
      const t = now();
      const kp = keyPrice().valueScrap;
      if (kind === 'shopping') {
        const { limit: _limit, offset: _offset, ...filters } = shopping ?? {};
        const rows: unknown[][] = [['sku', 'name', 'category', 'pay_up_to', 'revenue', 'buyer', 'confidence', 'known_cost', 'under_ceiling', 'bank_page']];
        for (const r of shoppingList(filters).rows) {
          const buyer = r.revenueOrder ? `${r.revenueOrder.userName ?? r.revenueOrder.steamid} (${r.revenueOrder.isBot ? 'bot' : 'human'})` : '';
          rows.push([r.sku, r.name, r.category, formatScrap(r.maxCostScrap, kp), formatScrap(r.revenueScrap, kp), buyer, r.confidence, r.knownCostScrap === null ? '' : formatScrap(r.knownCostScrap, kp), r.underCeiling === null ? '' : String(r.underCeiling), r.bankPageUrl]);
        }
        return { csv: csv(rows), suggestedName: `flipdesk-shopping-${stamp(t)}.csv` };
      }
      if (kind === 'events') {
        const rows: unknown[][] = [['id', 'time', 'kind', 'sku', 'name', 'category', 'profit_ref', 'confidence', 'summary']];
        for (const e of [...events].sort((a, b) => b.id - a.id)) rows.push([e.id, new Date(e.ts).toISOString(), e.kind, e.sku, e.name, e.category, e.profitScrap === null ? '' : (e.profitScrap / 9).toFixed(2), e.confidence, e.summary]);
        return { csv: csv(rows), suggestedName: `flipdesk-events-${stamp(t)}.csv` };
      }
      const rows: unknown[][] = [['sku', 'name', 'category', 'input', 'cost', 'revenue', 'profit', 'margin', 'confidence', 'buyers', 'status']];
      const q = query ?? {};
      for (const o of sortOpportunities(filterOpportunities([...opps.values()], q), q.sort ?? 'profit', q.dir ?? 'desc')) {
        rows.push([o.sku, o.name, o.category, o.inputKind, formatScrap(o.costScrap, kp), formatScrap(o.revenueScrap, kp), formatScrap(o.profitScrap, kp), o.margin === null ? '' : o.margin.toFixed(4), o.confidence, o.buyerCount, o.status]);
      }
      return { csv: csv(rows), suggestedName: `flipdesk-opportunities-${stamp(t)}.csv` };
    },
    'shopping.list': (q) => shoppingList(q ?? {}),
    'item.detail': ({ sku, history }) => {
      const d = detail(sku);
      // history: false is quick entry's local-only preview.
      return d && history === false ? { ...d, history: [] } : d;
    },
    'buyer.check': ({ steamid }) => checkBuyer(steamid),
    'item.refresh': ({ sku }) => {
      const t = now();
      if (settings.networkPaused) return { queued: false, reason: 'Network is paused. Resume it from the top bar first.', etaMs: null };
      if (!secrets.bptfAccessToken) return { queued: false, reason: 'Snapshots need a backpack.tf access token (Settings).', etaMs: null };
      if (t - lastRefreshAt < 10_000) {
        const wait = 10_000 - (t - lastRefreshAt);
        return { queued: false, reason: `Snapshot budget is 1 request per 10 s. Next slot in ${Math.ceil(wait / 1000)} s.`, etaMs: wait };
      }
      lastRefreshAt = t;
      setTimeout(() => {
        const book = books.get(sku);
        if (!book) return;
        book.snapshotAt = now();
        for (const o of book.buy) o.lastEventAt = now();
        changedAndEmit();
      }, 2500);
      return { queued: true, reason: null, etaMs: 2500 };
    },
    'item.search': ({ q, limit }) => search(q, Math.max(1, Math.min(50, limit ?? 10))),
    'item.resolve': ({ text }) => resolve(text),
    'links.forSku': ({ sku, assetId }) => mockLinks(sku, itemName(sku), assetId ?? null),
    'item.scm': ({ sku }) => {
      if (!settings.connectors.scm) return null;
      const name = itemName(sku);
      const cents = 50 + (Math.abs([...sku].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 2000);
      const usd = (c: number) => `${(c / 100).toFixed(2)}`;
      return { lowest: usd(cents), median: usd(Math.round(cents * 1.04)), volume: String(10 + (cents % 400)), marketHashName: name };
    },
    'prices.list': (p) => {
      const tokens = (p?.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      return prices
        .filter((x) => tokens.every((t) => `${x.name} ${x.sku}`.toLowerCase().includes(t)))
        .sort((a, b) => b.observedAt - a.observedAt);
    },
    'prices.upsert': (input) => {
      if (!input || typeof input.sku !== 'string' || !input.sku.trim()) throw new Error('An item is required.');
      if (!Number.isFinite(input.costScrap) || input.costScrap < 0) throw new Error('Price must be zero or more.');
      if (input.costKeys !== undefined && (!Number.isFinite(input.costKeys) || input.costKeys < 0)) throw new Error('Keys must be zero or more.');
      const sku = canonical(input.sku.trim());
      const existing = input.id !== undefined ? prices.find((p) => p.id === input.id) : undefined;
      if (input.id !== undefined && !existing) throw new Error(`Price #${input.id} does not exist.`);
      const row: ScrapPrice = {
        id: existing?.id ?? priceSeq++,
        sku,
        name: input.name?.trim() || itemName(sku),
        costKeys: input.costKeys ?? 0,
        costScrap: Math.round(input.costScrap),
        source: input.source ?? existing?.source ?? 'user',
        observedAt: input.observedAt ?? now(),
        note: input.note === undefined ? (existing?.note ?? null) : input.note,
        importBatch: input.importBatch === undefined ? (existing?.importBatch ?? null) : input.importBatch,
        special: input.special === undefined ? (existing?.special ?? null) : input.special,
        assetId: input.assetId === undefined ? (existing?.assetId ?? null) : input.assetId,
        stock: input.stock === undefined ? (existing?.stock ?? null) : input.stock,
      };
      prices = existing ? prices.map((p) => (p.id === row.id ? row : p)) : [...prices, row];
      pricesChanged();
      changedAndEmit();
      return row;
    },
    'prices.delete': ({ id }) => {
      prices = prices.filter((p) => p.id !== id);
      pricesChanged();
      changedAndEmit();
      return { ok: true };
    },
    'prices.parseBulk': ({ text, bareUnit }) => {
      if (typeof text !== 'string') throw new Error('Invalid parameters for prices.parseBulk: text: expected a string');
      return mockParseBulk(text, bareUnit ?? 'ref', resolve);
    },
    'prices.bulkUpsert': ({ rows }) => {
      if (!Array.isArray(rows)) throw new Error('Invalid parameters for prices.bulkUpsert: rows: expected an array');
      if (rows.length > 500) throw new Error('Invalid parameters for prices.bulkUpsert: rows: at most 500 rows');
      // Validate everything first: one bad row writes nothing, like the service's transaction.
      rows.forEach((r, i) => {
        if (!r || typeof r.sku !== 'string' || !looksLikeSku(r.sku.trim())) throw new Error(`Row ${i + 1}: not a SKU (pick an item first)`);
        if (!Number.isFinite(r.costScrap) || r.costScrap < 0) throw new Error(`Row ${i + 1}: price must be zero or more`);
        if (r.costKeys !== undefined && (!Number.isFinite(r.costKeys) || r.costKeys < 0)) throw new Error(`Row ${i + 1}: keys must be zero or more`);
        if (r.id !== undefined && !prices.some((p) => p.id === r.id)) throw new Error(`Row ${i + 1}: price #${r.id} does not exist`);
      });
      let added = 0;
      let updated = 0;
      const t = now();
      for (const r of rows) {
        const sku = canonical(r.sku.trim());
        const existing = r.id !== undefined ? prices.find((p) => p.id === r.id) : undefined;
        const row: ScrapPrice = {
          id: existing?.id ?? priceSeq++,
          sku,
          name: r.name?.trim() || itemName(sku),
          costKeys: r.costKeys ?? 0,
          costScrap: Math.round(r.costScrap),
          source: 'user',
          observedAt: r.observedAt ?? t,
          note: r.note === undefined ? (existing?.note ?? null) : r.note,
          importBatch: existing?.importBatch ?? null,
          special: r.special === undefined ? (existing?.special ?? null) : r.special,
          assetId: existing?.assetId ?? null,
          stock: existing?.stock ?? null,
        };
        if (existing) {
          prices = prices.map((p) => (p.id === row.id ? row : p));
          updated++;
        } else {
          prices = [...prices, row];
          added++;
        }
      }
      if (rows.length > 0) {
        pricesChanged();
        changedAndEmit();
      }
      return { added, updated };
    },
    'prices.exportCsv': () => {
      const kp = keyPrice().valueScrap;
      const rows: unknown[][] = [['id', 'sku', 'name', 'cost_keys', 'cost_metal', 'cost', 'source', 'observed_at', 'note']];
      for (const p of [...prices].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)) {
        rows.push([p.id, p.sku, p.name, p.costKeys, formatScrap(p.costScrap), formatScrap(Math.round(p.costKeys * kp) + p.costScrap, kp), p.source, new Date(p.observedAt).toISOString(), p.note ?? '']);
      }
      return { csv: csv(rows), suggestedName: `flipdesk-prices-${stamp(now())}.csv` };
    },
    'rules.list': () => [...rules].sort((a, b) => a.id - b.id),
    'rules.upsert': (input) => {
      if (!input?.name?.trim()) throw new Error('A rule needs a name.');
      if (!Number.isFinite(input.costScrap) || input.costScrap < 0) throw new Error('Price must be zero or more.');
      const existing = input.id !== undefined ? rules.find((r) => r.id === input.id) : undefined;
      const row: PriceRule = {
        id: existing?.id ?? ruleSeq++,
        name: input.name.trim(),
        filter: structuredClone(input.filter ?? {}),
        costKeys: input.costKeys ?? 0,
        costScrap: Math.round(input.costScrap),
        observedAt: input.observedAt ?? now(),
        enabled: input.enabled ?? existing?.enabled ?? true,
      };
      rules = existing ? rules.map((r) => (r.id === row.id ? row : r)) : [...rules, row];
      pricesChanged();
      changedAndEmit();
      return row;
    },
    'rules.delete': ({ id }) => {
      rules = rules.filter((r) => r.id !== id);
      pricesChanged();
      changedAndEmit();
      return { ok: true };
    },
    'rules.preview': (input) => {
      const matching = allSearchable().filter((item) => ruleMatches(input.filter ?? {}, item));
      return { matchingSkus: matching.length * 37, sample: matching.slice(0, 8).map((m) => ({ sku: m.sku, name: m.name })) };
    },
    'rules.exportJson': () => ({ json: mockRulesToJson([...rules].sort((a, b) => a.id - b.id), now()), suggestedName: `flipdesk-rules-${stamp(now())}.json` }),
    'rules.importJson': ({ json }) => {
      if (typeof json !== 'string') throw new Error('Invalid parameters for rules.importJson: json: expected a string');
      const parsed = mockRulesFromJson(json);
      const t = now();
      const skipped = [...parsed.skipped];
      // Adds only; existing rules are kept. Like the service, restoring a backup twice adds nothing.
      const existing = new Set(rules.map(mockRuleKey));
      const seen = new Set<string>();
      let added = 0;
      for (const r of parsed.rules) {
        const key = mockRuleKey(r);
        if (existing.has(key) || seen.has(key)) {
          if (skipped.length < 400) skipped.push(`"${r.name.slice(0, 60)}": ${existing.has(key) ? 'already in your rules' : 'repeated in this backup'}`);
          continue;
        }
        seen.add(key);
        rules = [...rules, { id: ruleSeq++, name: r.name, filter: r.filter, costKeys: r.costKeys ?? 0, costScrap: r.costScrap, observedAt: Math.min(r.observedAt ?? t, t), enabled: r.enabled ?? true }];
        added++;
      }
      if (added > 0) {
        pricesChanged();
        changedAndEmit();
      }
      return { added, skipped };
    },
    'journal.list': (p) => [...journal].sort((a, b) => b.ts - a.ts || b.id - a.id).slice(0, Math.max(1, p?.limit ?? 500)),
    'journal.add': (input) => {
      if (input?.side !== 'buy' && input?.side !== 'sell') throw new Error('Side must be buy or sell.');
      if (!input.venue?.trim()) throw new Error('A venue is required.');
      if (!input.sku?.trim()) throw new Error('An item is required.');
      if (!Number.isFinite(input.scrap) || input.scrap < 0) throw new Error('Price must be zero or more.');
      const sku = canonical(input.sku.trim());
      const row: JournalEntry = {
        id: journalSeq++,
        ts: input.ts ?? now(),
        side: input.side,
        venue: input.venue.trim(),
        sku,
        name: input.name?.trim() || itemName(sku),
        keys: input.keys ?? 0,
        scrap: Math.round(input.scrap),
        keyPriceScrap: keyPrice().valueScrap,
        note: input.note ?? null,
      };
      journal = [...journal, row];
      return row;
    },
    'journal.delete': ({ id }) => {
      journal = journal.filter((j) => j.id !== id);
      return { ok: true };
    },
    'journal.summary': () => mockJournalSummary(journal),
    'journal.exportCsv': () => {
      const rows: unknown[][] = [['id', 'time', 'side', 'venue', 'sku', 'name', 'keys', 'metal_ref', 'key_price_ref', 'note']];
      for (const j of [...journal].sort((a, b) => a.ts - b.ts)) rows.push([j.id, new Date(j.ts).toISOString(), j.side, j.venue, j.sku, j.name, j.keys, (j.scrap / 9).toFixed(2), (j.keyPriceScrap / 9).toFixed(2), j.note ?? '']);
      return { csv: csv(rows), suggestedName: `flipdesk-journal-${stamp(now())}.csv` };
    },
    'import.html': ({ fileName, mtimeMs }) => {
      requireImportEnabled();
      const result: ImportResult = { batchId: batchSeq++, fileName, pageKind: 'unknown', parsed: 0, stored: 0, skipped: [], warnings: ['Mock mode: saved pages are not parsed in the browser preview.'] };
      batches.unshift({ id: result.batchId, fileName, pageKind: 'unknown', fileMtime: mtimeMs, importedAt: now(), itemCount: 0 });
      return result;
    },
    'import.batches': (p) => batches.slice(0, Math.max(1, p?.limit ?? 20)),
    'health.get': () => health(),
    // The mock never disables a host, so there is nothing to re-enable.
    'net.unblock': () => ({ ok: true }),
    'secrets.test': ({ name }) =>
      secrets[name]
        ? { ok: true, message: name === 'steamApiKey' ? 'Steam accepted the key (mock).' : 'backpack.tf accepted it (mock).' }
        : { ok: false, message: 'Nothing is stored for this secret yet.' },
    'engine.runNow': () => {
      changedAndEmit();
      return { evaluated: opps.size, ms: lastEngineMs ?? 1 };
    },
    'app.info': (): AppInfo => ({
      version: '0.2.0',
      dataDir: 'C:\\Users\\you\\AppData\\Roaming\\TF2 Flip Desk',
      logDir: 'C:\\Users\\you\\AppData\\Roaming\\TF2 Flip Desk\\logs',
      platform: 'browser (mock)',
      electron: 'n/a',
      node: 'n/a',
    }),
    // The mock has no separate service process to restart.
    'app.serviceState': () => ({ state: 'ready', detail: null, nextAttemptAt: null }),
    'app.showQuickEntry': (p) => {
      if (typeof location !== 'undefined') location.hash = '#/quick';
      // Like main: the quick-entry page gets the SKU once it listens.
      // Lower-cased first, as main's ipc.ts does, so 'U17'-style effect letters keep the effect.
      const sku = p && typeof p === 'object' && typeof p.sku === 'string' ? p.sku.trim().toLowerCase() : '';
      if (sku) {
        if (!looksLikeSku(sku)) throw new Error('Invalid parameters for app.showQuickEntry: sku: not a SKU');
        emitHeld('ui.quickPrefill', { sku: canonical(sku) });
      }
      return { ok: true };
    },
    'app.hideWindow': () => {
      if (typeof location !== 'undefined' && location.hash.startsWith('#/quick')) location.hash = '#/opportunities';
      return { ok: true };
    },
    'app.openItem': ({ sku }) => {
      if (typeof location !== 'undefined' && location.hash.startsWith('#/quick')) location.hash = '#/opportunities';
      // Let the dashboard mount before it is asked to open the drawer.
      setTimeout(() => emit('ui.openItem', { sku }), 50);
      return { ok: true };
    },
    'settings.get': () => settings,
    'settings.set': (patch) => {
      settings = mergeSettings(settings, patch);
      emit('settings.changed', settings);
      changedAndEmit();
      return settings;
    },
    'secrets.status': () => ({ ...secrets }),
    'secrets.set': ({ name, value }) => {
      if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown secret ${String(name)}`);
      // Only presence is kept; the mock never stores the value itself.
      secrets[name] = typeof value === 'string' && value.trim().length > 0;
      emit('status.changed', status());
      return { ...secrets };
    },
    'links.open': ({ url }) => {
      let ok = false;
      try {
        ok = new URL(url).protocol === 'https:';
      } catch {
        ok = false;
      }
      return { opened: false, reason: ok ? 'Browser preview: links open in your default browser only in the desktop app.' : 'Only https links can be opened.' };
    },
    'import.pickFile': () => {
      requireImportEnabled();
      const t = now();
      const picks = CATALOG.filter((c) => c.category === 'hats' && !c.sku.includes(';p')).slice(0, 3);
      const batchId = batchSeq++;
      for (const item of picks) {
        prices = [
          ...prices,
          {
            id: priceSeq++,
            sku: item.sku,
            name: item.name,
            costKeys: 0,
            costScrap: Math.max(1, item.value - 4),
            source: 'import',
            observedAt: t,
            note: null,
            importBatch: batchId,
            special: { paint: null, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false },
            assetId: null,
            stock: 1,
          },
        ];
      }
      const result: ImportResult = {
        batchId,
        fileName: 'scrap.tf - Buy Hats.html',
        pageKind: 'buy',
        parsed: picks.length + 2,
        stored: picks.length,
        skipped: [
          { reason: 'Item name not in the schema', title: 'Unknown Festive Thing' },
          { reason: 'No price found on the card', title: 'Brigade Helm' },
        ],
        warnings: ['2 cards had unparsed attributes; they were skipped rather than guessed.'],
      };
      batches.unshift({ id: batchId, fileName: result.fileName, pageKind: 'buy', fileMtime: t - 30_000, importedAt: t, itemCount: picks.length });
      pricesChanged();
      changedAndEmit();
      emit('import.done', result);
      return result;
    },
    // Like main: only the folder dialog. The page saves the choice through settings.set.
    'import.pickWatchFolder': () => {
      requireImportEnabled();
      return { folder: 'C:\\Users\\you\\Documents\\scrap.tf pages' };
    },
    'file.saveText': ({ suggestedName }) => ({ saved: true, path: `C:\\Users\\you\\Downloads\\${suggestedName}` }),
  };

  seedEvents();

  const delay = () => new Promise<void>((res) => setTimeout(res, latency > 0 ? 15 + Math.random() * latency : 0));

  return {
    windowKind: typeof location !== 'undefined' && location.hash.startsWith('#/quick') ? 'quick-entry' : 'dashboard',
    async rpc<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
      await delay();
      const h = handlers[method] as Handler<M> | undefined;
      if (!h) throw new Error(`Unknown method ${method}`);
      const result = await h(params);
      return structuredClone(result);
    },
    on<E extends PushEvent>(event: E, listener: (payload: PushContract[E]) => void): () => void {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const fn = listener as (p: unknown) => void;
      set.add(fn);
      if (held.has(event)) {
        const payload = held.get(event);
        held.delete(event);
        queueMicrotask(() => fn(structuredClone(payload)));
      }
      ensureTimer();
      return () => {
        set.delete(fn);
      };
    },
    tick,
    dispose() {
      if (timer) clearInterval(timer);
      timer = null;
      listeners.clear();
    },
  };
}

function guessCategory(sku: string): CatalogItem['category'] {
  const o = fromString(sku);
  if (o.quality === 5 && o.effect) return 'unusuals';
  if (o.paintkit !== null) return 'skins';
  if (o.killstreak > 0) return 'killstreaks';
  if (o.quality === 11) return 'stranges';
  return 'other';
}

