// In-memory stand-in for window.flipdesk so the dashboard runs in a plain
// browser (npm run dev:renderer). Development only: all data is fake, nothing
// is persisted and nothing leaves the page.

import type { AppInfo, FlipdeskBridge, PushContract, PushEvent, RpcMethod, RpcParams, RpcResult } from '../shared/rpc';
import { sameAccelerator } from '../shared/accelerator';
import { blankCheckResult, CHECK_ARM_MS, CHECK_ARM_NAME_MAX, CHECK_HOTKEY_CONFLICT, CHECK_MAX_CHARS, CHECK_PRICE_TEXT_MAX, CHECK_RECENT_MAX } from '../shared/check';
import { formatScrap } from '../shared/currency';
import { DEFAULT_SETTINGS, mergeSettings } from '../shared/defaults';
import { HOLDINGS_CSV_COLUMNS, holdingRow, holdingsCsvCells, holdingsMatching, holdingsResult } from '../shared/holdings';
import { NO_BANK_FLIPS, bankFlips, bankLookFor, bankStockFlips } from '../shared/banks';
import {
  BANK_STOCK_CSV_COLUMNS,
  BANK_STOCK_MAX_LIMIT,
  BANK_STOCK_MAX_SEARCH_CHARS,
  bankStockCounts,
  bankStockCsvCells,
  bankStockDroppedIntoFlip,
  bankStockItemOf,
  bankStockKey,
  bankStockMatching,
  bankStockPricesOf,
  bankStockNewAt,
  bankStockPagePairs,
  bankStockResult,
  bankStockRows,
  bankStockTargetOf,
  bankStockThinning,
  bankStockWhatsNew,
  diffBankStock,
  type BankStockBankDiff,
} from '../shared/bankStock';
import { SCRAPTF_BANKS, bankForCategory, preferScraptfSeen, scraptfLinkFor, scraptfSeenOn, type ScraptfSeen } from '../shared/links';
import {
  MARKET_CSV_COLUMNS,
  MARKET_MAX_LIMIT,
  MARKET_MAX_SEARCH_CHARS,
  batchItemCounts,
  batchSavedAt,
  countCategories,
  isEmptyBankSave,
  marketCsvCells,
  marketSearchTokens,
  scraptfCoverage,
  wholeLookNewestSaves,
  type BankSave,
  type WholeLookSave,
} from '../shared/market';
import {
  SCRAPTF_CHANGES_CSV_COLUMNS,
  SCRAPTF_CHANGES_EXPORT_MAX,
  SCRAPTF_CHANGES_MAX_LIMIT,
  scraptfChangeCsvCells,
  scraptfChangeEvent,
  scraptfChangesLimit,
  scraptfCopyBankOf,
  scraptfEventListFamily,
  scraptfEventMatches,
  scraptfEventsOf,
  scraptfItemHistoryOf,
  scraptfKeyStatesOf,
  scraptfListedOf,
  scraptfMarkSuperseded,
  scraptfRunsOf,
  scraptfAssetStabilityOf,
  type ScraptfEventBuySide,
  type ScraptfKeyState,
  type ScraptfListed,
  type ScraptfSaveRows,
} from '../shared/scraptfHistory';
import { scraptfListCoverage, scraptfListKeyOf, scraptfListLookup, scraptfListPriceSaved, valueScraptfListRow } from '../shared/scraptfList';
import { baseSku, canonical, fromString, isValidSku, looksLikeSku } from '../shared/sku';
import type {
  AppStatus,
  Category,
  BankStockQuery,
  BankStockResult,
  BankStockRow,
  CheckResult,
  CheckSource,
  HoldingDetail,
  HoldingMark,
  HoldingRow,
  HoldingsQuery,
  BuyerCheck,
  ConnectorHealth,
  EventsExportQuery,
  HealthReport,
  ImportBatch,
  ImportResult,
  ItemDetail,
  ItemSuggestion,
  JournalEntry,
  KeyPriceQuote,
  KeyPriceState,
  MarketListResult,
  MarketQuery,
  MarketRow,
  MarketStats,
  Opportunity,
  OpportunityEvent,
  OpportunityEventKind,
  PriceRule,
  RequestLogRow,
  ResolvedItem,
  Scrap,
  ScrapPrice,
  ScraptfBank,
  ScraptfBankSummary,
  ScraptfBanksResult,
  ScraptfBuyTiming,
  ScraptfChangeEvent,
  ScraptfChangeKind,
  ScraptfChangesQuery,
  ScraptfEventStored,
  ScraptfItemHistory,
  ScraptfKeyRun,
  ScraptfListKey,
  ScraptfListRow,
  ScraptfListStatus,
  ScraptfListStored,
  ScraptfWatch,
  ScraptfWatchInput,
  SecretsStatus,
  Settings,
  SetupCode,
  ShoppingListResult,
  ShoppingQuery,
  UnixMs,
} from '../shared/types';
import { BANK_STOCK_FILTERS, BANK_STOCK_OPEN_FILTERS, BANK_STOCK_SORTS, CATEGORIES, CURRENCY_SKUS, JOURNAL_SIDES, KEY_SKU, SCRAPTF_BANK_IDS, SCRAPTF_CHANGE_KINDS, SECRET_NAMES } from '../shared/types';
import {
  JOURNAL_CSV_COLUMNS,
  JOURNAL_ENTRY_GONE,
  JOURNAL_MAX_FEE_KEYS,
  JOURNAL_MAX_FEE_SCRAP,
  JOURNAL_WRITE_OFF_NOTHING,
  applyJournalPatch,
  closedTradesOf,
  feeOf,
  feePatchOf,
  journalCsvCells,
  journalLedger,
  typicalHold,
  typicalHoldOf,
  withTypicalHold,
} from '../shared/journal';
import {
  HOLDING_DETAIL_LEAD_MS,
  HOLDING_DETAIL_MAX_CLOSED,
  HOLDING_DETAIL_MAX_MARKS,
  HOLDING_DETAIL_UNHELD_MS,
  HOLDING_HISTORY_MAX_RUNS,
  attachHoldingAdvice,
  holdingExitHistory,
  holdingMarkSettingsKey,
} from '../shared/holdingAdvice';
import {
  WATCHES_FULL,
  WATCHES_MAX,
  WATCH_ANY_COPY_SENTINEL,
  WATCH_COPY_TAKEN,
  WATCH_GONE,
  WATCH_MAX_KEYS,
  WATCH_MAX_SCRAP,
  WATCH_NAME_MAX,
  WATCH_NOT_A_COPY,
  WATCH_SPECIAL_MAX,
  watchIndexOf,
  watchJoinOf,
  watchRestoreOf,
  watchViewsOf,
  watchWriteOf,
  type WatchPageRows,
} from '../shared/watches';
import { EVENTS_EXPORT_MAX, OPPORTUNITY_EVENT_KINDS, eventMatches } from '../shared/opportunityEvents';
import { newestTypedPriceFor } from '../shared/priceCopy';
import { markSharedBuyers } from '../shared/copyExtras';
import { boundRuleCost, ruleUnderScraptfReason, scraptfSeenPriceOf, type ScraptfSeenPrice } from '../shared/ruleEvidence';
import {
  CATALOG,
  MARKET_ONLY,
  MOCK_KEY_SCRAP,
  MOCK_LIST_PAGES,
  SEED_KIT,
  SEED_RULES,
  allSearchable,
  createRng,
  evaluateOpportunity,
  findCatalogItem,
  makeBook,
  marketSignature,
  mockJournalSummary,
  mockKnownPrices,
  mockLinks,
  mockHoldingAsk,
  mockHoldingBuySide,
  mockHoldingRefs,
  mockMarketQuery,
  mockImportReport,
  mockBankOf,
  mockMarketRow,
  mockOrderFlags,
  mockParseBulk,
  mockPrices,
  mockRevenue,
  mockRulesFromJson,
  mockRulesToJson,
  mockSeedWatches,
  mockShoppingList,
  mockSkipTotals,
  ruleMatches,
  seedJournal,
  seedBankStock,
  seedBankStockHistory,
  seedHoldingMarks,
  seedPrices,
  seedScraptfList,
  type CatalogItem,
  type MockBook,
  type MockInput,
  type MockStockSave,
} from './mockData';
import { NO_CARDS_SAVED, NO_CARDS_SAVED_REASON } from './importModel';
import { checkDemoFromHash, mockCheckDemo, mockCheckResult, mockHintedParse, mockJudgeCheck, mockParseCheck, type MockParsedCheck } from './mockCheck';
import { gateScraptfWindow, IMPORT_HTML_ORIGIN_REFUSAL, SCRAPTF_BAR_HASH } from '../shared/scraptfWindowPolicy';
import { IMPORT_REPORT_RING, SKIP_CRAFT_UNPROVEN, SKIP_OUT_OF_STOCK } from '../shared/importCodes';
import { createMockScraptfWindow } from './mockScraptfWindow';
import { filterOpportunities, orderByGroup, revenueOrderOf, sortOpportunities, summarizeGroups } from './oppModel';
import { craftabilityTwin } from '../shared/ceiling';
import {
  scraptfBankCyclesOf,
  scraptfBankTurnover,
  scraptfItemTimingOf,
  scraptfOpportunityTiming,
  scraptfTimingBrief,
  scraptfTimingForKey,
  type ScraptfBankCycles,
} from '../shared/scraptfTiming';
import pkg from '../../package.json';

export interface MockOptions {
  seed?: number;
  now?: () => UnixMs;
  /** Simulated live-feed interval; 0 disables the timer (tests call tick()). */
  tickMs?: number;
  /** Simulated IPC latency upper bound in ms. */
  latencyMs?: number;
  /** Extra synthetic price inputs (defaults to the ?stress= URL parameter). */
  stressRows?: number;
  /**
   * How long the Live market's first index build appears to take (stats.building, rows filling in).
   * Defaults to 6 s while the feed timer runs and 0 when it does not (tests).
   */
  marketBuildMs?: number;
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

/** The package's version, so the preview's Settings and User-Agent cannot drift from a release bump. */
const MOCK_APP_VERSION: string = pkg.version;

const MIN = 60_000;
const HOUR = 3_600_000;

function csvCell(v: unknown): string {
  // 0.8 (J5): as the service's csvCell, a number is never formula-guarded (a negative profit stays a number).
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
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

/**
 * 0.7.3: the service's priceRow rule (rpcHandlers.ts) for a price row edited to `sku`: a row moved to
 * another item (another base SKU) keeps its id, but the old copy's extras, asset id, stock and batch
 * described the old item, so an omitted one reads null as on a new price. Otherwise it keeps the stored one.
 */
function keepUnlessMoved(existing: ScrapPrice | undefined, sku: string): <T>(value: T | null | undefined, stored: T | null | undefined) => T | null {
  const moved = !!existing && looksLikeSku(existing.sku) && baseSku(existing.sku) !== baseSku(sku);
  return (value, stored) => (value !== undefined ? value : moved ? null : (stored ?? null));
}

export function createMockBridge(opts: MockOptions = {}): MockBridge {
  const now = opts.now ?? (() => Date.now());
  const rng = createRng(opts.seed ?? 20261014);
  const latency = opts.latencyMs ?? 60;
  const tickMs = opts.tickMs ?? 4000;
  const t0 = now();

  // F21: the toolbar demo ('#/scraptf-bar') starts with the window on, so its controls answer.
  const barDemo = typeof location !== 'undefined' && location.hash.startsWith(SCRAPTF_BAR_HASH);
  let settings: Settings = mergeSettings(
    DEFAULT_SETTINGS,
    barDemo ? { import: { enabled: true, acknowledgedAt: t0 }, scraptfWindow: { enabled: true, acknowledgedAt: t0 } } : {},
  );
  // 0.8 (H6), as the service's markSettingsAt: when the buyer settings last changed (null: not since the mock began);
  // the holdings advice compares only the runs recorded since then.
  let markSettings: { key: string; at: UnixMs | null } = { key: holdingMarkSettingsKey(settings), at: null };
  const secrets: SecretsStatus = { bptfApiKey: false, bptfAccessToken: false, steamApiKey: false };

  const books = new Map<string, MockBook>();
  CATALOG.forEach((item, i) => books.set(item.sku, makeBook(rng, item, t0, i % 17 === 9)));
  // Live market only: items with buyers and no price of yours. Their own RNG keeps the seeded mock unchanged.
  const marketRng = createRng(((opts.seed ?? 20261014) ^ 0x5eed) >>> 0);
  const marketBuildMs = Math.max(0, opts.marketBuildMs ?? (tickMs > 0 ? 6000 : 0));
  const extraBooks = new Map<string, MockBook>();
  for (const item of MARKET_ONLY) extraBooks.set(item.sku, makeBook(marketRng, item, t0));
  // 0.7.2: the seeded kit has no catalog book. Built here on its own RNG, so bookFor never draws from the main one
  // and every other seeded event and opportunity time stays as it was.
  books.set(SEED_KIT.sku, makeBook(createRng(0x6b17), { sku: SEED_KIT.sku, name: SEED_KIT.name, category: guessCategory(SEED_KIT.sku), value: 0 }, t0, true));

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
  // 0.8 (H1): recorded exit runs of the seeded journal's held bases, served per base as repo.holdingMarks reads them.
  // Seeded once from the books at t0 and the default key price, drawn from no RNG, so every other seed is unchanged.
  const holdingMarks: readonly HoldingMark[] = seedHoldingMarks(
    mockJournalSummary(journal).open,
    (base) => {
      const book = books.get(base) ?? extraBooks.get(base);
      return book ? mockHoldingBuySide(book, settings, MOCK_KEY_SCRAP, t0) : null;
    },
    MOCK_KEY_SCRAP,
    t0,
  );
  // 0.8 (G1): the user's scrap.tf watches, seeded from the hats page's rows on the first read (watchList); no RNG.
  let watches: ScraptfWatch[] | null = null;
  let watchSeq = 3;
  // Saved pages for the Live market's coverage strip (F13): some minutes old, some hours, skins and items never.
  // Each carries the categories it stored, as the service records them at import time (the seeded
  // prices' batch ids are random, so the rows could not say).
  const batches: ImportBatch[] = [
    { id: 6, fileName: 'scrap.tf - Buy Hats.html', pageKind: 'buy', fileMtime: t0 - 4 * MIN, importedAt: t0 - 4 * MIN + 2_000, itemCount: 48, categories: { hats: 48 }, bank: 'hats' },
    { id: 5, fileName: 'scrap.tf - Unusuals.html', pageKind: 'unusuals', fileMtime: t0 - 12 * MIN, importedAt: t0 - 12 * MIN + 2_000, itemCount: 31, categories: { unusuals: 31 }, bank: 'unusuals' },
    { id: 4, fileName: 'scrap.tf - Buy Stranges.html', pageKind: 'buy', fileMtime: t0 - 70 * MIN, importedAt: t0 - 69 * MIN, itemCount: 22, categories: { stranges: 22 }, bank: 'stranges' },
    { id: 3, fileName: 'scrap.tf - Items.html', pageKind: 'items-list', fileMtime: t0 - 2 * HOUR, importedAt: t0 - 2 * HOUR + MIN, itemCount: 140, categories: { other: 140 }, bank: 'list' },
    { id: 2, fileName: 'scrap.tf - Buy Weapons.html', pageKind: 'buy', fileMtime: t0 - 5 * HOUR, importedAt: t0 - 5 * HOUR + MIN, itemCount: 64, categories: { weapons: 64 }, bank: 'weapons' },
    { id: 1, fileName: 'scrap.tf - Buy Killstreaks.html', pageKind: 'buy', fileMtime: t0 - 26 * HOUR, importedAt: t0 - 26 * HOUR + MIN, itemCount: 17, categories: { killstreaks: 17 }, bank: 'killstreaks' },
  ];
  let batchSeq = 7;
  // F15: a seeded imported price comes from the saved page that sells it (its bank's batch, else the
  // /items list), dated at that page's save as the import dates it, so its ScrapPrice.bank, the
  // drawer's "Seen on" and the bank card's "saved … ago" agree. No RNG: seeds unchanged.
  {
    const batchOfBank = new Map<ScraptfBank, ImportBatch>();
    for (const b of batches) if (b.bank && !batchOfBank.has(b.bank)) batchOfBank.set(b.bank, b);
    prices = prices.map((p) => {
      if (p.source !== 'import') return p;
      const category = findCatalogItem(p.sku)?.category ?? guessCategory(p.sku);
      const page = batchOfBank.get(bankForCategory(category)) ?? batchOfBank.get('list');
      return page ? { ...p, importBatch: page.id, observedAt: batchSavedAt(page) } : p;
    });
  }
  // F14: the saved scrap.tf/items list (three pages of mixed ages, the key row included).
  let listRows: ScraptfListStored[] = seedScraptfList(t0);
  // F17: bank-stock saves. Two of hats, unusuals, stranges, weapons and the /items list (their newest is
  // the bank's batch above, the list's its newest page), with new, gone, cheaper and pricier rows between
  // them; one of killstreaks (a first save); none of skins and items (never saved, as on the strip). The
  // previous saves are not in `batches` (the coverage strip and the banks cards date banks by their newest).
  let stockSaves: MockStockSave[] = (() => {
    const at = (bank: ScraptfBank) => batches.find((b) => b.bank === bank)!;
    const save = (bank: ScraptfBank, previousAgo: number | null, previousId: number) => {
      const b = at(bank);
      return { bank, batchId: b.id, savedAt: batchSavedAt(b), previous: previousAgo === null ? null : { batchId: previousId, savedAt: batchSavedAt(b) - previousAgo } };
    };
    return seedBankStock({
      saves: [
        save('hats', 3 * HOUR, 191),
        save('unusuals', 20 * HOUR, 192),
        save('stranges', 5 * HOUR, 193),
        save('weapons', 48 * HOUR, 194),
        save('killstreaks', null, 0),
        { bank: 'list', batchId: MOCK_LIST_PAGES[0]!.batchId, savedAt: t0 - MOCK_LIST_PAGES[0]!.ageMs, previous: { batchId: 195, savedAt: t0 - MOCK_LIST_PAGES[0]!.ageMs - 24 * HOUR } },
      ],
      prices,
      listRows,
    });
  })();
  // F20: about 20 saves per bank over 10 days, older than the two above (killstreaks keeps its first save).
  stockSaves = [...stockSaves, ...seedBankStockHistory(stockSaves)];
  // F20 S2: the change feed, written save by save as the service writes it at import (oldest first),
  // then the S1 thinning, as maintenance would leave it.
  const stockEvents: ScraptfEventStored[] = [];
  let stockEventSeq = 1;
  {
    const done: MockStockSave[] = [];
    for (const save of [...stockSaves].sort((a, b) => a.savedAt - b.savedAt || a.batchId - b.batchId)) {
      recordStockEvents(save, done, MOCK_KEY_SCRAP);
      done.push(save);
    }
    stockSaves = thinnedStockSaves(stockSaves, t0);
  }

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

  /** The saved list's key row (F14), read raw like the service's scraptfList.keyRow(). */
  function listKey(): ScraptfListKey | null {
    return scraptfListKeyOf(listRows.find((r) => r.sku === KEY_SKU));
  }

  /**
   * What scrap.tf pays for a key, as the service's effectiveScraptfKey picks it: the newer of the typed
   * value (dated scraptfObservedAt; undated counts as older) and the saved list's key row.
   */
  function scraptfKeyCap(): Scrap | null {
    const k = settings.keyPrice;
    const typed = k.scraptfSellScrap || null;
    const lk = listKey();
    const listNewer = lk !== null && (!(k.scraptfSellScrap || k.scraptfBuyScrap) || k.scraptfObservedAt === null || lk.observedAt > k.scraptfObservedAt);
    return listNewer ? (lk.paysScrap ?? typed) : (typed ?? lk?.paysScrap ?? null);
  }

  function keyPrice(): KeyPriceState {
    const t = now();
    const scraptfFromList = listKey();
    const quotes: KeyPriceQuote[] = [
      { source: 'pricedb', buyScrap: MOCK_KEY_SCRAP + keyDrift, sellScrap: MOCK_KEY_SCRAP + 12 + keyDrift, observedAt: t0 - 22 * MIN, priceAt: t0 - 22 * MIN },
    ];
    if (secrets.bptfApiKey && settings.connectors.bptfApi) {
      // 0.7.4 (F71): backpack.tf's community key price is fetched hourly but last changed days ago.
      quotes.unshift({ source: 'bptf', buyScrap: MOCK_KEY_SCRAP + 2 + keyDrift, sellScrap: MOCK_KEY_SCRAP + 9 + keyDrift, observedAt: t0 - 41 * MIN, priceAt: t0 - 9 * 24 * 60 * MIN });
    }
    if (settings.keyPrice.mode === 'manual' && settings.keyPrice.manualScrap) {
      quotes.push({ source: 'manual', buyScrap: settings.keyPrice.manualScrap, sellScrap: null, observedAt: t0 });
      return { valueScrap: settings.keyPrice.manualScrap, source: 'manual', observedAt: t0, stale: false, quotes, scraptfFromList };
    }
    const q = quotes[0]!;
    let value = q.buyScrap ?? MOCK_KEY_SCRAP;
    const cap = scraptfKeyCap();
    if (cap) value = Math.min(value, cap);
    return { valueScrap: value, source: q.source, observedAt: q.observedAt, stale: t - q.observedAt > 6 * HOUR, quotes, priceAt: q.priceAt ?? null, divergence: null, scraptfFromList };
  }

  /**
   * The saved list row of a SKU's base (paint dropped), else 0.7.4 its family row (scraptfListLookup, as
   * the service's rowFor: match 'family'), valued at `keyScrap`.
   */
  function listRowFor(sku: string, keyScrap: Scrap = keyPrice().valueScrap): ScraptfListRow | null {
    const hit = scraptfListLookup((s) => listRows.find((x) => x.sku === s), sku);
    if (!hit) return null;
    const row = valueScraptfListRow(hit.stored, keyScrap);
    return hit.match === 'family' ? { ...row, match: 'family' } : row;
  }

  /** Row count, newest and oldest row and the saved pages behind them (the service's scraptfListSummary). */
  function listSummary(): { items: number; newestAt: UnixMs | null; oldestAt: UnixMs | null; batches: number } {
    let newestAt: UnixMs | null = null;
    let oldestAt: UnixMs | null = null;
    for (const r of listRows) {
      if (newestAt === null || r.observedAt > newestAt) newestAt = r.observedAt;
      if (oldestAt === null || r.observedAt < oldestAt) oldestAt = r.observedAt;
    }
    return { items: listRows.length, newestAt, oldestAt, batches: new Set(listRows.map((r) => r.batchId)).size };
  }

  function listStatus(): ScraptfListStatus {
    const s = listSummary();
    const importEnabled = settings.import.enabled && settings.import.acknowledgedAt !== null;
    const watchActive = importEnabled && !!settings.import.watchFolder;
    // The mock has no file system: a chosen folder counts as watched, and never fails.
    return { items: s.items, newestAt: s.newestAt, oldestAt: s.oldestAt, pages: s.batches, importEnabled, watchFolder: settings.import.watchFolder, watchActive, watchError: null };
  }

  // ---------------------------------------------------------------------------
  // scrap.tf banks (F15)
  // ---------------------------------------------------------------------------

  /**
   * A price as the repo reads it: with its import batch's bank joined in. Imported rows only, as the
   * repo joins: an imported price edited by hand turns 'user' but keeps its batch, and is no page's.
   */
  function withBank(p: ScrapPrice): ScrapPrice {
    const bank = p.source !== 'import' || p.importBatch === null ? null : (batches.find((b) => b.id === p.importBatch)?.bank ?? null);
    return { ...p, bank };
  }

  /** The bank of the imported price behind an opportunity ('price:<id>'), as the service reads it. */
  function opportunityBanks(): (o: Opportunity) => ScraptfBank | null {
    const byId = new Map(prices.map((p) => [p.id, p]));
    return (o) => {
      if (o.inputKind !== 'import' || !o.inputRef.startsWith('price:')) return null;
      const p = byId.get(Number(o.inputRef.slice('price:'.length)));
      return p ? withBank(p).bank ?? null : null;
    };
  }

  /**
   * 'scraptf.banks' with the shared rules (bankFlips, bankLookFor): bank pages from the newest batch of
   * each bank, the 'list' card from the saved list (F14 status), or from its batches while it holds no
   * rows. In-stock counts on bank pages are made up: the mock keeps no per-page stock.
   */
  function banksResult(): ScraptfBanksResult {
    const t = now();
    const flips = bankFlips([...opps.values()], opportunityBanks());
    const rows = marketRows();
    const market = new Map(rows.map((r) => [r.sku, r]));
    const list = listSummary();
    // As the service counts a bank's pages: the saves behind its prices today, plus its newest save.
    const behind = new Map<ScraptfBank, Set<number>>();
    for (const p of prices) {
      const bank = withBank(p).bank;
      if (!bank || p.importBatch === null) continue;
      const ids = behind.get(bank) ?? new Set<number>();
      ids.add(p.importBatch);
      behind.set(bank, ids);
    }
    const byBatch = new Map<ScraptfBank, BankSave>();
    for (const info of SCRAPTF_BANKS) {
      // F18 S3, as scraptfBankSaves: a bank page saved without its cards dates nothing.
      const saves = batches.filter((b) => b.bank === info.bank && !isEmptyBankSave(b, info.bank));
      const n = saves.reduce<ImportBatch | null>((m, b) => (m === null || batchSavedAt(b) > batchSavedAt(m) ? b : m), null);
      if (n) byBatch.set(info.bank, { at: batchSavedAt(n), id: n.id, items: n.itemCount });
    }
    // DC-2, as the service: a bank page by its newest whole look (its newest stock save).
    const dated = wholeLookNewestSaves(byBatch, wholeLookOf, batchItemCounts(batches));
    const banks = SCRAPTF_BANKS.map((info): ScraptfBankSummary => {
      const newest = dated.get(info.bank) ?? null;
      const isList = info.bank === 'list';
      // As the service: the saved list, else (no rows: purged, or a 0.3 import) the list's own batches.
      const fromList = isList && list.items > 0;
      const items = fromList ? list.items : (newest?.items ?? 0);
      const pages = new Set(behind.get(info.bank));
      if (newest) pages.add(newest.id);
      return {
        bank: info.bank,
        label: info.label,
        url: info.url,
        lastSavedAt: fromList ? list.newestAt : (newest?.at ?? null),
        pages: fromList ? list.batches : pages.size,
        items,
        // A list batch stores in-stock rows only.
        inStock: fromList ? listRows.filter((r) => (r.stock ?? 0) > 0).length : isList ? items : Math.round(items * 0.65),
        // UX-2b, as the service: a bank page counts its stock page's flips; the list keeps the price rule.
        ...(stockFlipsOf(info.bank, market) ?? flips.get(info.bank) ?? NO_BANK_FLIPS),
        // 0.7.4 (F36): as the service, a row is the bank's when its scrap.tf button opens that page.
        ...bankLookFor(rows, info.categories, info.bank),
        // F17: as the service, the change counts between the bank's two newest stock saves.
        whatsNew: whatsNewOf(info.bank, market),
      };
    });
    const status = listStatus();
    return { banks: structuredClone(banks), importEnabled: status.importEnabled, watchActive: status.watchActive, generatedAt: t };
  }

  /** Like the service's throttled push; the mock tells every change at once (the page throttles its refetch). */
  function banksChanged(): void {
    emit('scraptf.banksChanged', { at: now() });
  }

  // ---------------------------------------------------------------------------
  // scrap.tf bank stock (F17): the service's rules, from src/shared/bankStock.ts
  // ---------------------------------------------------------------------------

  /** A bank's kept saves, newest first (save time, then batch id), as repo.bankStockSaves orders them. */
  function stockSavesOf(bank: ScraptfBank): MockStockSave[] {
    return stockSaves.filter((s) => s.bank === bank).sort((a, b) => b.savedAt - a.savedAt || b.batchId - a.batchId);
  }

  /** DC-2: a bank's newest whole look, as the service reads repo.bankStockSaves(bank, 1)[0]. */
  function wholeLookOf(bank: ScraptfBank): WholeLookSave | null {
    const s = stockSavesOf(bank)[0];
    return s ? { batchId: s.batchId, savedAt: s.savedAt, items: s.rows.length } : null;
  }

  /**
   * A bank's newest save and the saves it is compared with, as the service pairs them (bankStockPagePairs;
   * the mock's banks have one page each): 0.7.1 (CQ-2) the session baseline for what the page shows, the
   * save just before for one read at a time.
   */
  function stockPairOf(bank: ScraptfBank): { newest: MockStockSave; previous: MockStockSave | null; baseline: MockStockSave | null; saves: number } | null {
    const saves = stockSavesOf(bank);
    const pair = bankStockPagePairs(saves.map((s) => ({ batchId: s.batchId, savedAt: s.savedAt, page: '', items: s.rows.length, save: s })))[0];
    if (!pair) return null;
    return { newest: pair.newest.save, previous: pair.previous?.save ?? null, baseline: pair.baseline?.save ?? null, saves: pair.saves };
  }

  /** Each saved bank's newest save diffed against its session baseline at the key price (what the service caches). */
  function stockDiffs(keyScrap: Scrap): BankStockBankDiff[] {
    const out: BankStockBankDiff[] = [];
    for (const info of SCRAPTF_BANKS) {
      const p = stockPairOf(info.bank);
      if (!p) continue;
      out.push({ bank: info.bank, savedAt: p.newest.savedAt, previousSavedAt: p.baseline?.savedAt ?? null, diff: diffBankStock(p.newest.rows, p.baseline?.rows ?? null, keyScrap) });
    }
    return out;
  }

  /** Every row a bank's page shows, joined to the Live market rows (`market`: by base SKU, read once per call). */
  function bankStockAll(
    bank: ScraptfBank,
    market?: ReadonlyMap<string, MarketRow>,
  ): { rows: BankStockRow[]; items: number; savedAt: UnixMs | null; previousSavedAt: UnixMs | null; saves: number } {
    const p = stockPairOf(bank);
    if (!p) return { rows: [], items: 0, savedAt: null, previousSavedAt: null, saves: 0 };
    const { newest, baseline } = p;
    const byBase = market ?? new Map(marketRows().map((r) => [r.sku, r]));
    const rows = bankStockRows({
      newest: newest.rows,
      // CQ-2: since the save before the newest one's session, as the service.
      previous: baseline?.rows ?? null,
      keyScrap: keyPrice().valueScrap,
      profit: settings.profit,
      categoryOf: (sku) => findCatalogItem(sku)?.category ?? guessCategory(sku),
      // As the service's market.entryFor: an entry only while the item has eligible buyers.
      buySideOf: (sku) => {
        const r = byBase.get(sku);
        return r && r.buyerCount > 0 ? r : null;
      },
      // F20: listed since, first seen and the change since listed, from the bank's runs.
      runOf: (key) => runsFor(bank).get(key) ?? null,
      // 0.7.4, as the service: the list's unproven rows (craft 'any') meet no buyer.
      bank,
      // 0.8 (T4): each on-sale row's buy timing, by the shared rule over the bank's saves (the service's timingFor).
      timingOf: (key, buy) => {
        const t = mockTimingOf(bank, key, buy);
        return t ? scraptfTimingBrief(t) : null;
      },
    });
    // 0.8 (G1): each row's watch by the shared join, as the service's joinRow (the Watched chip and the row tag).
    const index = watchIndexOf(watchList());
    const kp = keyPrice().valueScrap;
    const minConfidence = settings.notifications.minConfidence;
    const joined =
      index.size === 0
        ? rows
        : rows.map((r) => {
            const w = watchJoinOf(index, r, kp, Number.isFinite(minConfidence) ? minConfidence : 0);
            return w ? { ...r, watch: w } : r;
          });
    return { rows: joined, items: newest.rows.length, savedAt: newest.savedAt, previousSavedAt: baseline?.savedAt ?? null, saves: p.saves };
  }

  /**
   * 0.8 (G1): the watch list, seeded on the first read from the hats page's rows (mockSeedWatches). The list is set
   * empty before the seed reads those rows, so their join finds no watch yet instead of seeding again.
   */
  function watchList(): ScraptfWatch[] {
    if (watches === null) {
      watches = [];
      watches = mockSeedWatches(bankStockAll('hats').rows, now());
    }
    return watches;
  }

  /** 0.8 ('watches.list'): per saved bank page, its newest save's on-sale rows of the given bases (the service's watchRows). */
  function watchPages(bases: ReadonlySet<string>): WatchPageRows[] {
    const out: WatchPageRows[] = [];
    for (const info of SCRAPTF_BANKS) {
      const s = bankStockAll(info.bank);
      if (s.savedAt === null) continue;
      const rows = s.rows.filter((r) => r.change !== 'gone' && bases.has(r.sku));
      if (rows.length) out.push({ bank: info.bank, savedAt: s.savedAt, rows });
    }
    return out;
  }

  /** The service's zod for 'watches.*' (watchInput, watchesListParams, idOnly), with its messages' shape. */
  function watchParams(method: string) {
    const bad = (why: string): never => {
      throw new Error(`Invalid parameters for ${method}: ${why}`);
    };
    const sku = (v: unknown): string => {
      if (typeof v !== 'string') return bad('sku: expected a string');
      const t = v.trim();
      if (t.length < 1) return bad('sku: an item is required');
      if (t.length > 300) return bad('sku: at most 300 characters');
      const lower = t.toLowerCase();
      if (!isValidSku(lower)) return bad('sku: not a SKU (pick an item first)');
      return lower;
    };
    const watchId = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : bad('id: must be a positive whole number'));
    // 'watches.restore': a removed watch's created and updated times, as the zod (whole ms, at least 0).
    const time = (key: string, v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : bad(`${key}: a time in ms, at least 0`));
    const scrapOrNull = (key: string, v: unknown): Scrap | null | undefined => {
      if (v === undefined || v === null) return v;
      return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= WATCH_MAX_SCRAP ? v : bad(`${key}: whole scrap, 0 to ${WATCH_MAX_SCRAP}`);
    };
    const flag = (key: string, v: unknown): boolean | undefined => (v === undefined || typeof v === 'boolean' ? v : bad(`${key}: expected a boolean`));
    return {
      sku,
      watchId,
      time,
      input(p: unknown): ScraptfWatchInput {
        if (!p || typeof p !== 'object') return bad('sku: required');
        const q = p as Partial<Record<keyof ScraptfWatchInput, unknown>>;
        const out: ScraptfWatchInput = { sku: '' };
        if (q.id !== undefined) out.id = watchId(q.id);
        out.sku = sku(q.sku);
        if (q.copies !== undefined) out.copies = q.copies === 'one' || q.copies === 'any' ? q.copies : bad("copies: 'one' or 'any'");
        if (q.special !== undefined) {
          out.special = q.special === null || (typeof q.special === 'string' && q.special.length <= WATCH_SPECIAL_MAX) ? q.special : bad(`special: at most ${WATCH_SPECIAL_MAX} characters`);
          // As the zod's refine: the copy index's every-copy stand-in is no copy key.
          if (out.special === WATCH_ANY_COPY_SENTINEL) bad(`special: ${WATCH_NOT_A_COPY}`);
        }
        if (q.name !== undefined) out.name = typeof q.name === 'string' && q.name.length <= WATCH_NAME_MAX ? q.name : bad(`name: at most ${WATCH_NAME_MAX} characters`);
        if (q.maxCostKeys !== undefined) {
          const k = q.maxCostKeys;
          out.maxCostKeys = typeof k === 'number' && Number.isFinite(k) && k >= 0 && k <= WATCH_MAX_KEYS ? k : bad(`maxCostKeys: 0 to ${WATCH_MAX_KEYS}`);
        }
        const maxCostScrap = scrapOrNull('maxCostScrap', q.maxCostScrap);
        if (maxCostScrap !== undefined) out.maxCostScrap = maxCostScrap;
        const minProfitScrap = scrapOrNull('minProfitScrap', q.minProfitScrap);
        if (minProfitScrap !== undefined) out.minProfitScrap = minProfitScrap;
        const onRestock = flag('onRestock', q.onRestock);
        if (onRestock !== undefined) out.onRestock = onRestock;
        const enabled = flag('enabled', q.enabled);
        if (enabled !== undefined) out.enabled = enabled;
        return out;
      },
    };
  }

  /**
   * UX-2b: a bank page's card flips as its stock page counts them (the Flips chip, most profit first), as
   * the service; null for the list and a bank with no stock save (the opportunity count stands then).
   */
  function stockFlipsOf(bank: ScraptfBank, market: ReadonlyMap<string, MarketRow>): ReturnType<typeof bankStockFlips> | null {
    if (bank === 'list') return null;
    const s = bankStockAll(bank, market);
    if (s.savedAt === null) return null;
    const flips = bankStockMatching(s.rows, { filter: 'flips', sort: 'profit', dir: 'desc' }, now());
    return bankStockFlips(flips, bankStockCounts(s.rows, s.items).flips);
  }

  function whatsNewOf(bank: ScraptfBank, market: ReadonlyMap<string, MarketRow>): ScraptfBankSummary['whatsNew'] {
    const s = bankStockAll(bank, market);
    return bankStockWhatsNew(bankStockCounts(s.rows, s.items), s.previousSavedAt);
  }

  /** The service's zod for BankStockQuery, with its messages' shape. */
  function bankStockQuery(q: unknown, method: string): BankStockQuery {
    const bad = (why: string): never => {
      throw new Error(`Invalid parameters for ${method}: ${why}`);
    };
    if (!q || typeof q !== 'object') return bad('bank: required');
    const p = q as Partial<Record<keyof BankStockQuery, unknown>>;
    if (typeof p.bank !== 'string' || !(SCRAPTF_BANK_IDS as readonly string[]).includes(p.bank)) bad('bank: not a scrap.tf bank');
    if (p.filter !== undefined && !(BANK_STOCK_FILTERS as readonly unknown[]).includes(p.filter)) bad('filter: not a filter');
    if (p.sort !== undefined && !(BANK_STOCK_SORTS as readonly unknown[]).includes(p.sort)) bad('sort: not a sort');
    if (p.dir !== undefined && p.dir !== 'asc' && p.dir !== 'desc') bad('dir: asc or desc');
    if (p.search !== undefined && (typeof p.search !== 'string' || p.search.length > BANK_STOCK_MAX_SEARCH_CHARS)) bad(`search: at most ${BANK_STOCK_MAX_SEARCH_CHARS} characters`);
    if (p.limit !== undefined && (typeof p.limit !== 'number' || !Number.isInteger(p.limit) || p.limit < 1 || p.limit > BANK_STOCK_MAX_LIMIT)) bad(`limit: must be 1 to ${BANK_STOCK_MAX_LIMIT}`);
    if (p.offset !== undefined && (typeof p.offset !== 'number' || !Number.isInteger(p.offset) || p.offset < 0)) bad('offset: must be zero or more');
    const out: Record<string, unknown> = { bank: p.bank };
    for (const k of ['filter', 'search', 'sort', 'dir', 'limit', 'offset'] as const) if (p[k] !== undefined) out[k] = p[k];
    return out as unknown as BankStockQuery;
  }

  function bankStockList(q: BankStockQuery): BankStockResult {
    const s = bankStockAll(q.bank);
    // 0.8 (LC-4): how long items stayed listed in the bank, as the service's turnoverFor.
    const cycles = cyclesOf(q.bank);
    const turnover = cycles ? scraptfBankTurnover(cycles) : null;
    return bankStockResult({ q, rows: s.rows, items: s.items, savedAt: s.savedAt, previousSavedAt: s.previousSavedAt, saves: s.saves, turnover, keyPrice: keyPrice(), now: now() });
  }

  /**
   * A new save of a bank (an import): its change events first (F20 S2, against the saves before it), then
   * kept with the others and thinned (S1). Returns the events written ('scraptf.changed' when any).
   */
  function addStockSave(save: MockStockSave): number {
    const written = recordStockEvents(save, stockSaves, keyPrice().valueScrap);
    stockSaves = thinnedStockSaves([...stockSaves, save], now());
    return written;
  }

  // ---------------------------------------------------------------------------
  // scrap.tf history (F20): the service's rules, from src/shared/scraptfHistory.ts
  // ---------------------------------------------------------------------------

  /** A mock save as the history rules read it (the mock's banks have one page each). */
  function saveRows(s: MockStockSave): ScraptfSaveRows {
    return { batchId: s.batchId, savedAt: s.savedAt, page: '', rows: s.rows };
  }

  /** S1: what Repo.pruneBankStock keeps (bankStockThinning), every bank at once. */
  function thinnedStockSaves(saves: MockStockSave[], at: UnixMs): MockStockSave[] {
    const drop = bankStockThinning(saves.map((s) => ({ batchId: s.batchId, savedAt: s.savedAt, bank: s.bank, page: '' })), at);
    return drop.size === 0 ? saves : saves.filter((s) => !drop.has(s.batchId));
  }

  /**
   * S2 as importSavedPage runs it: the save's changes against the newest earlier save of its bank (none for
   * a first save, or one not newer than every save already kept), 'restocked' when an earlier save listed it.
   */
  function recordStockEvents(save: MockStockSave, before: readonly MockStockSave[], keyScrap: Scrap): number {
    const mine = before.filter((s) => s.bank === save.bank);
    if (mine.some((s) => s.savedAt >= save.savedAt)) return 0;
    const previous = [...mine].sort((a, b) => b.savedAt - a.savedAt || b.batchId - a.batchId)[0];
    if (!previous) return 0;
    const runs = scraptfRunsOf(mine.map(saveRows));
    const events = scraptfEventsOf({ bank: save.bank, page: '', at: save.savedAt, batchId: save.batchId, newest: save.rows, previous: previous.rows, keyScrap, seenBefore: (key) => runs.has(key) });
    for (const e of events) stockEvents.push({ ...e, id: stockEventSeq++ });
    return events.length;
  }

  let runsMemo: { saves: MockStockSave[]; byBank: Map<ScraptfBank, Map<string, ScraptfKeyRun>> } | null = null;
  /** The runs index of a bank (ScraptfHistory.runsFor), memoised until the saves change. */
  function runsFor(bank: ScraptfBank): ReadonlyMap<string, ScraptfKeyRun> {
    if (runsMemo === null || runsMemo.saves !== stockSaves) runsMemo = { saves: stockSaves, byBank: new Map() };
    let runs = runsMemo.byBank.get(bank);
    if (!runs) runsMemo.byBank.set(bank, (runs = scraptfRunsOf(stockSavesOf(bank).map(saveRows))));
    return runs;
  }

  let cyclesMemo: { saves: MockStockSave[]; byBank: Map<ScraptfBank, ScraptfBankCycles> } | null = null;
  /**
   * 0.8: a bank's cycles (scraptfBankCyclesOf over its kept saves, at the key price when built), memoised until the
   * saves change, as the service's history index builds them once per runs rebuild; null for a bank with no save.
   */
  function cyclesOf(bank: ScraptfBank): ScraptfBankCycles | null {
    if (cyclesMemo === null || cyclesMemo.saves !== stockSaves) cyclesMemo = { saves: stockSaves, byBank: new Map() };
    const hit = cyclesMemo.byBank.get(bank);
    if (hit) return hit;
    const saves = stockSavesOf(bank);
    if (saves.length === 0) return null;
    const c = scraptfBankCyclesOf(bank, saves.map(saveRows), keyPrice().valueScrap);
    cyclesMemo.byBank.set(bank, c);
    return c;
  }

  /** 0.8 (T3/T4): one copy's verdict, as the service's ScraptfHistory.timingFor (the shared scraptfTimingForKey). */
  function mockTimingOf(bank: ScraptfBank, key: string, buy: ScraptfEventBuySide | null): ScraptfBuyTiming | null {
    const cycles = cyclesOf(bank);
    return cycles ? scraptfTimingForKey({ cycles, key, buy, profit: settings.profit, keyScrap: keyPrice().valueScrap, now: now() }) : null;
  }

  /** 0.8 (T4): the copy's verdict in the bank its item history reads (scraptfCopyBankOf), as the service's timingForCopy. */
  function mockTimingForCopy(base: string, special: string, buy: ScraptfEventBuySide | null): ScraptfBuyTiming | null {
    const key = bankStockKey(base, special);
    const list: { bank: ScraptfBank; life: ScraptfBankCycles['life'] }[] = [];
    for (const info of SCRAPTF_BANKS) {
      const c = cyclesOf(info.bank);
      if (c) list.push({ bank: info.bank, life: c.life });
    }
    const bank = scraptfCopyBankOf(list, key);
    return bank ? mockTimingOf(bank, key, buy) : null;
  }

  /** 0.8 (T7): MarketRow.scraptfTiming as market.list joins it: the copy scraptfListedOf picks on the row's 'seen' bank. */
  function withMarketTiming(r: MarketRow): MarketRow {
    if (r.scraptfLink.source !== 'seen') return r;
    const bank = r.scraptfLink.bank;
    const key = scraptfListedOf(runsFor(bank), r.sku)?.key;
    // As the service's market.entryFor: an entry only while the item has eligible buyers.
    const t = key !== undefined ? mockTimingOf(bank, key, r.buyerCount > 0 ? r : null) : null;
    return t ? { ...r, scraptfTiming: scraptfTimingBrief(t) } : r;
  }

  /** The service's zod for 'scraptf.changes' (every key optional), with its messages' shape. */
  function changesQuery(q: unknown, method: string): ScraptfChangesQuery {
    const bad = (why: string): never => {
      throw new Error(`Invalid parameters for ${method}: ${why}`);
    };
    if (q === undefined || q === null) return {};
    if (typeof q !== 'object') return bad('expected an object');
    const p = q as Partial<Record<keyof ScraptfChangesQuery, unknown>>;
    const out: ScraptfChangesQuery = {};
    if (p.bank !== undefined) {
      if (typeof p.bank !== 'string' || !(SCRAPTF_BANK_IDS as readonly string[]).includes(p.bank)) bad('bank: not a scrap.tf bank');
      out.bank = p.bank as ScraptfBank;
    }
    if (p.kinds !== undefined) {
      if (!Array.isArray(p.kinds) || p.kinds.length > SCRAPTF_CHANGE_KINDS.length || !p.kinds.every((k) => (SCRAPTF_CHANGE_KINDS as readonly unknown[]).includes(k))) bad('kinds: not a change kind');
      out.kinds = [...(p.kinds as ScraptfChangeKind[])];
    }
    if (p.sku !== undefined) {
      if (typeof p.sku !== 'string' || !isValidSku(p.sku.trim().toLowerCase())) bad('sku: not a SKU (pick an item first)');
      out.sku = (p.sku as string).trim().toLowerCase();
    }
    if (p.beforeId !== undefined) {
      if (typeof p.beforeId !== 'number' || !Number.isInteger(p.beforeId) || p.beforeId < 1) bad('beforeId: must be 1 or more');
      out.beforeId = p.beforeId as number;
    }
    if (p.limit !== undefined) {
      if (typeof p.limit !== 'number' || !Number.isInteger(p.limit) || p.limit < 1 || p.limit > SCRAPTF_CHANGES_MAX_LIMIT) bad(`limit: must be 1 to ${SCRAPTF_CHANGES_MAX_LIMIT}`);
      out.limit = p.limit as number;
    }
    return out;
  }

  /**
   * Stored events valued now and joined to the Live market rows of their base SKUs (market.entryFor);
   * 0.7.1 (ACT-10) a superseded flip gets wasFlip, by the service's rule over the kept saves.
   */
  function valuedEvents(list: readonly ScraptfEventStored[]): ScraptfChangeEvent[] {
    const kp = keyPrice().valueScrap;
    const byBase = new Map(marketRows().map((r) => [r.sku, r]));
    // 0.7.4, as the service: an /items list event's row in its own save decides whether it meets a buyer.
    const rowOf = (e: Pick<ScraptfEventStored, 'batchId' | 'sku' | 'specialKey'>) =>
      stockSaves.find((s) => s.batchId === e.batchId)?.rows.find((r) => r.sku === e.sku && r.specialKey === e.specialKey) ?? null;
    const valued = list.map((e) => {
      const r = byBase.get(e.sku);
      return scraptfChangeEvent(e, kp, r && r.buyerCount > 0 ? r : null, { family: scraptfEventListFamily(e, rowOf) });
    });
    const states = new Map<ScraptfBank, ReadonlyMap<string, ScraptfKeyState>>();
    return scraptfMarkSuperseded(valued, (bank) => {
      let s = states.get(bank);
      if (!s) states.set(bank, (s = scraptfKeyStatesOf(stockSavesOf(bank).map(saveRows))));
      return s;
    });
  }

  /** 'scraptf.changes': newest first, filtered and paged like the service. */
  function changesList(q: ScraptfChangesQuery, limit: number = scraptfChangesLimit(q.limit)): ScraptfChangeEvent[] {
    let base: string | undefined;
    if (q.sku !== undefined) {
      try {
        base = baseSku(q.sku);
      } catch {
        base = q.sku;
      }
    }
    const list = stockEvents
      .filter((e) => scraptfEventMatches(e, { bank: q.bank, kinds: q.kinds, baseSku: base }) && (q.beforeId === undefined || e.id < q.beforeId))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
    return valuedEvents(list);
  }

  /** 'scraptf.itemHistory': the shared rules over every bank's kept saves and this base SKU's events. */
  function itemHistory(p: { sku: string; special?: string | null }): ScraptfItemHistory {
    const bad = (why: string): never => {
      throw new Error(`Invalid parameters for scraptf.itemHistory: ${why}`);
    };
    if (!p || typeof p.sku !== 'string' || !isValidSku(p.sku.trim().toLowerCase())) bad('sku: not a SKU (pick an item first)');
    if (p.special !== undefined && p.special !== null && (typeof p.special !== 'string' || p.special.length > 2000)) bad('special: at most 2000 characters');
    const sku = p.sku.trim().toLowerCase();
    let base = sku;
    try {
      base = baseSku(sku);
    } catch {
      // an unparseable SKU is its own base
    }
    const banks = SCRAPTF_BANKS.map((info) => ({ bank: info.bank, saves: stockSavesOf(info.bank).map(saveRows) })).filter((b) => b.saves.length > 0);
    const events = valuedEvents(stockEvents.filter((e) => e.sku === base));
    const h = scraptfItemHistoryOf({ sku, specialKey: p.special ?? null, name: findCatalogItem(sku)?.name, banks, events, keyPrice: keyPrice(), now: now() });
    // 0.8 (T3-T5): its runs and verdict in its bank, as the service; the buy side is the base's market row with buyers.
    const row = marketRows().find((r) => r.sku === h.sku);
    return { ...h, ...scraptfItemTimingOf(h, { cyclesOf, buy: row && row.buyerCount > 0 ? row : null, profit: settings.profit, keyScrap: keyPrice().valueScrap, now: now() }) };
  }

  function bookFor(sku: string, name?: string): MockBook {
    const existing = books.get(sku) ?? extraBooks.get(sku);
    if (existing) return existing;
    const item: CatalogItem = findCatalogItem(sku) ?? { sku, name: name ?? sku, category: guessCategory(sku), value: 0 };
    const book = makeBook(rng, { ...item, value: 0 }, now(), true);
    books.set(sku, book);
    return book;
  }

  /** 0.7.4 (F78): as core's scraptfSeenPriceOf, over the mock's saved list and its bank saves' runs. */
  function seenPriceOf(sku: string, kp: Scrap): ScraptfSeenPrice | null {
    return scraptfSeenPriceOf(sku, { listRow: (b) => listRowFor(b, kp), runsFor }, kp);
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
        // 0.7.4 (F78): as the engine, never under a price the saved list or a bank save showed the plain copy at.
        const kp = keyPrice().valueScrap;
        const seen = seenPriceOf(item.sku, kp);
        const bound = boundRuleCost(rule, seen, kp);
        out.push({
          book,
          input: {
            kind: 'rule',
            ref: `rule:${rule.id}`,
            costKeys: bound.costKeys,
            costScrapRaw: bound.costScrapRaw,
            observedAt: rule.observedAt,
            special: null,
            ...(bound.underScraptf && seen ? { ruleUnderScraptf: ruleUnderScraptfReason(seen, Math.round(rule.costKeys * kp) + rule.costScrap, kp) } : {}),
          },
        });
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
    const evaluatedRows = [...inputs()].map(({ book, input }) => {
      const key = `${book.item.sku}|${input.ref}`;
      const prev = opps.get(key) ?? null;
      // 0.7.4 (F70): the craftability twin's book, for the cost check (as the engine's twin references).
      const twinSku = input.kind === 'rule' ? null : craftabilityTwin(baseSku(book.item.sku));
      const twin = twinSku ? (books.get(twinSku) ?? extraBooks.get(twinSku) ?? null) : null;
      return { key, prev, o: evaluateOpportunity(book, input, settings, kp, t, prev, twin) };
    });
    // 0.7.4 (F27, F33): as the engine, copies of one item sharing a revenue order are flagged before the comparison.
    const copiesByBase = new Map<string, Opportunity[]>();
    for (const { o } of evaluatedRows) {
      if (o.inputKind === 'rule') continue;
      const b = baseSku(o.sku);
      copiesByBase.set(b, [...(copiesByBase.get(b) ?? []), o]);
    }
    for (const copies of copiesByBase.values()) if (copies.length > 1) markSharedBuyers(copies, (x) => revenueOrderOf(x, settings.profit.useOrder));
    for (const { key, prev, o } of evaluatedRows) {
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
    // 0.7.4, as the engine: no toast on a cost far under market, nor (not recorded) on an unverified revenue order.
    if (o.flags.includes('variant-suspect') || o.flags.includes('cost-below-market')) return;
    if (revenueOrderOf(o, settings.profit.useOrder)?.flags.includes('unverified')) return;
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
    // As the service's computeStatus: a disabled rule prices nothing.
    if (prices.length === 0 && !rules.some((r) => r.enabled)) out.push('first-price');
    return out;
  }

  function status(): AppStatus {
    const all = [...opps.values()];
    const profitable = all.filter((o) => o.status === 'profitable');
    return {
      version: MOCK_APP_VERSION,
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
      // 0.8 (LC-5): each saved bank's asset-id stability, as the service's history index measures it: the pre-pass
      // alone (no lifecycle is built for Health's poll).
      scraptfAssetIds: SCRAPTF_BANKS.flatMap((info) => {
        const saves = stockSavesOf(info.bank);
        return saves.length > 0 ? [{ bank: info.bank, ...scraptfAssetStabilityOf(saves.map(saveRows)) }] : [];
      }),
    };
  }

  function seedRequestLog(): RequestLogRow[] {
    const rows: RequestLogRow[] = [];
    const tpl: Omit<RequestLogRow, 'ts' | 'ms' | 'bytes'>[] = [
      { host: 'pricedb.io', path: '/api/items-bulk', method: 'POST', status: 200, note: '87 SKUs' },
      { host: 'pricedb.io', path: '/api/item/30357;5;u702', method: 'GET', status: 200, note: null },
      { host: 'pricedb.io', path: '/api/item/15141;5;u701;w1;pk300;strange', method: 'GET', status: 404, note: 'not covered by PriceDB' },
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
    // 0.7.2: the seeded kit's opportunities draw from their own RNG, so every other seeded event keeps its values.
    const kitRng = createRng(0x6b18);
    for (const o of list) {
      const r = o.sku === SEED_KIT.sku ? kitRng : rng;
      const first = t0 - r.int(10, 9 * 60) * MIN;
      o.firstSeenAt = first;
      o.updatedAt = first;
      ev(o, 'appeared', o.profitScrap === null ? 'no buy orders yet' : `profit ${money(o.profitScrap)} at cost ${money(o.costScrap)}`, first);
      if (o.profitScrap !== null && r.chance(0.5)) {
        const ts = first + r.int(1, Math.max(2, Math.floor((t0 - first) / MIN) - 1)) * MIN;
        const before = o.profitScrap - r.int(-6, 12);
        ev(o, 'changed', `profit ${money(before)} -> ${money(o.profitScrap)}`, ts);
        o.updatedAt = ts;
      }
      if (o.status === 'profitable' && o.confidenceLevel === 'high' && r.chance(0.7)) {
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
    // F15: imports and price writes move each bank's flips and lookFor.
    banksChanged();
  }

  // ---------------------------------------------------------------------------
  // Live market (F10): every item with buyers or a price of yours
  // ---------------------------------------------------------------------------

  let marketSigs = new Map<string, string>();
  let marketChangeAt: UnixMs | null = null;

  /** 0..1 through the simulated first index build. */
  function marketProgress(): number {
    return marketBuildMs <= 0 ? 1 : Math.max(0, Math.min(1, (now() - t0) / marketBuildMs));
  }

  /**
   * Every row the index would hold. One row per base SKU: painted copies are the same item (their
   * prices join the base row, flagged has-extras). While the first build runs, books it has not
   * reached yet are left out, as in the service.
   */
  function marketRows(known = mockKnownPrices(prices)): MarketRow[] {
    const t = now();
    const kp = keyPrice().valueScrap;
    // F17: "New on scrap.tf", joined per read like the service's bankStock.newAtFor (0.7.1: a bank saved
    // over a day ago marks nothing new).
    const diffs = stockDiffs(kp);
    const newAt = bankStockNewAt(diffs, t);
    // F19: where each row's scrap.tf button points, joined per read like the service's.
    const sightings = scraptfSeenByBase(diffs);
    const all = [...books.values(), ...extraBooks.values()].filter((b) => !/;p\d/.test(b.item.sku));
    const progress = marketProgress();
    const reached = progress >= 1 ? all.length : Math.floor(all.length * progress);
    const out: MarketRow[] = [];
    const seen = new Set<string>();
    all.forEach((book, i) => {
      const sku = book.item.sku;
      seen.add(sku);
      if (i >= reached) return;
      const seenAt = sightings.get(sku) ?? null;
      const listed = listedOf(sku, seenAt);
      const row = mockMarketRow({ item: book.item, book, known: known.get(sku), rules, settings, keyScrap: kp, now: t, list: listRowFor(sku, kp), newAt: newAt.get(sku) ?? null, seen: seenAt, listedSince: listed?.since ?? null, lastSeenAt: listed?.lastSeenAt ?? null, seenPriceOf: () => seenPriceOf(sku, kp) });
      if (row) out.push(row);
    });
    // Prices for items the mock has no book for: shown with no buyers.
    for (const [sku, k] of known) {
      if (seen.has(sku)) continue;
      const item = findCatalogItem(sku) ?? { sku, name: k.typed?.name ?? k.page?.name ?? sku, category: guessCategory(sku) };
      const seenAt = sightings.get(sku) ?? null;
      const listed = listedOf(sku, seenAt);
      const row = mockMarketRow({ item, book: null, known: k, rules, settings, keyScrap: kp, now: t, list: listRowFor(sku, kp), newAt: newAt.get(sku) ?? null, seen: seenAt, listedSince: listed?.since ?? null, lastSeenAt: listed?.lastSeenAt ?? null, seenPriceOf: () => seenPriceOf(sku, kp) });
      if (row) out.push(row);
    }
    return out;
  }

  /**
   * F20, MarketRow.scraptfListedSince: the runs of the bank the row was seen on (ScraptfHistory.listedFor);
   * 0.7.1 (DM-5) with that run's newest sighting (scraptfLastSeenAt).
   */
  function listedOf(sku: string, seen: ScraptfSeen | null): ScraptfListed | null {
    return seen ? scraptfListedOf(runsFor(seen.bank), sku) : null;
  }

  /**
   * F19, MarketRow.scraptfLink as the service joins it: per base SKU, the saved page that last listed it,
   * a bank's newest stock save that still shows it or the bank of an imported price (preferScraptfSeen:
   * bank pages before the list). Absent: the row falls back to its category's bank.
   */
  function scraptfSeenByBase(diffs: readonly BankStockBankDiff[]): Map<string, ScraptfSeen> {
    const out = new Map<string, ScraptfSeen>();
    const add = (sku: string, s: ScraptfSeen): void => {
      const best = preferScraptfSeen(out.get(sku), s);
      if (best) out.set(sku, best);
    };
    for (const b of diffs) for (const d of b.diff) if (d.current !== null) add(d.sku, { bank: b.bank, at: b.savedAt });
    for (const p of prices) {
      const bank = withBank(p).bank;
      if (!bank) continue;
      let base = p.sku;
      try {
        base = baseSku(p.sku);
      } catch {
        // an unparseable SKU is its own base
      }
      add(base, { bank, at: p.observedAt });
    }
    return out;
  }

  function marketStats(entries: number): MarketStats {
    const progress = marketProgress();
    return {
      entries,
      building: progress < 1,
      progress,
      lastFullAt: progress < 1 ? null : t0 + marketBuildMs,
      lastChangeAt: marketChangeAt,
      pendingDirty: 0,
      // The mock's book never fails to read (H1 is exercised by the service tests).
      lastError: null,
      retryAt: null,
    };
  }

  function scraptfSide(known: ReturnType<typeof mockKnownPrices>): MarketListResult['scraptf'] {
    let typed = 0;
    let pages = 0;
    let newestPageAt: UnixMs | null = null;
    for (const k of known.values()) {
      if (k.typed) typed++;
      if (k.page) {
        pages++;
        if (newestPageAt === null || k.page.observedAt > newestPageAt) newestPageAt = k.page.observedAt;
      }
    }
    const importEnabled = settings.import.enabled && settings.import.acknowledgedAt !== null;
    // The service reports the watch as it runs; the mock has no file system, so a chosen folder counts as watched.
    return {
      typed,
      pages,
      newestPageAt,
      importEnabled,
      watchFolder: importEnabled && !!settings.import.watchFolder,
      coverage: coverage(),
      allItems: scraptfListCoverage(listSummary()),
    };
  }

  /** The same rule as the service (scraptfCoverage): a page counts for the bank page most of its items belong to. */
  function coverage(): ReturnType<typeof scraptfCoverage> {
    return scraptfCoverage(
      batches,
      (id) => prices.filter((p) => p.source === 'import' && p.importBatch === id).map((p) => findCatalogItem(p.sku)?.category ?? guessCategory(p.sku)),
      null,
      wholeLookOf,
    );
  }

  // ---------------------------------------------------------------------------
  // Holdings (F11): open journal lots against the mock books
  // ---------------------------------------------------------------------------

  /** Every held SKU, priced against its base SKU's book like the service reads the market entry. */
  function holdingRows(): HoldingRow[] {
    const t = now();
    const kp = keyPrice().valueScrap;
    // 0.8 (H5): as the service, each row carries the user's typical hold over every open position.
    const s = mockJournalSummary(journal);
    const hold = typicalHoldOf(s.closed, s.open);
    return s.open.map((pos) => {
      let base = pos.sku;
      try {
        base = baseSku(pos.sku);
      } catch {
        // an unparseable SKU is its own base
      }
      // A currency has no book, list row, ask, references or runs, as the service's rowsOf (its base is null there).
      const runsBase = holdingBaseOf(pos.sku);
      const book = runsBase === null ? null : (books.get(base) ?? extraBooks.get(base) ?? null);
      const category = (findCatalogItem(pos.sku) ?? findCatalogItem(base))?.category ?? guessCategory(base);
      // 0.8 (H3, H4, H6): as the service's rowsOf, the copy's ask, the age-gated references and the last snapshot.
      const extras = { ask: mockHoldingAsk(book, pos.sku, settings, kp, t), refs: mockHoldingRefs(book, settings, t), snapshotAt: book?.snapshotAt ?? null };
      // F14: the saved list row is the held item's scrap.tf exit (bestExitOf).
      const list = runsBase === null ? null : listRowFor(base, kp);
      const row = withTypicalHold(holdingRow(pos, category, book ? mockHoldingBuySide(book, settings, kp, t) : null, settings.profit, kp, { list, now: t }, extras), hold);
      // 0.8 (H6): the advice over the base's recorded runs, read as the service's historyFor reads them, since the buyer
      // settings last changed; a currency has no book to refresh and no runs.
      if (runsBase === null) return attachHoldingAdvice(row, null, settings.profit, kp, t, { book: false });
      const history = holdingExitHistory(marksOf(runsBase, row.heldSince, HOLDING_HISTORY_MAX_RUNS), row.heldSince, kp, t, markSettings.at);
      return attachHoldingAdvice(row, history, settings.profit, kp, t);
    });
  }

  /** 0.8 (H1): the base SKU a holding's runs are recorded under (paint dropped); null for a currency, as the service's. */
  function holdingBaseOf(sku: string): string | null {
    let base = sku;
    try {
      base = baseSku(sku);
    } catch {
      // an unparseable SKU is its own base
    }
    return CURRENCY_SKUS.includes(base) ? null : base;
  }

  /** 0.8 (H1): a base's seeded runs as repo.holdingMarks reads them: toAt >= since, the newest `limit`, oldest first. */
  function marksOf(base: string | null, since: UnixMs, limit: number): HoldingMark[] {
    if (base === null) return [];
    const hits = holdingMarks.filter((m) => m.baseSku === base && m.toAt >= since).sort((a, b) => a.fromAt - b.fromAt || a.id - b.id);
    return hits.slice(Math.max(0, hits.length - limit));
  }

  /**
   * 0.8 (H7) 'holdings.detail' over mock data, by the service's rules (Holdings.detail): the held row (advice
   * included), its lots oldest first, the SKU's closed trades newest first, the base's runs in the same window with
   * `truncated`, the history and the typical hold. `sku` is canonical.
   */
  function holdingDetail(sku: string): HoldingDetail {
    const t = now();
    const kp = keyPrice().valueScrap;
    const s = mockJournalSummary(journal);
    const pos = s.open.find((p) => p.sku === sku) ?? null;
    const row = pos ? (holdingRows().find((r) => r.sku === sku) ?? null) : null;
    const base = holdingBaseOf(sku);
    const since = row ? row.heldSince - HOLDING_DETAIL_LEAD_MS : t - HOLDING_DETAIL_UNHELD_MS;
    const read = marksOf(base, since, HOLDING_DETAIL_MAX_MARKS + 1);
    const truncated = read.length > HOLDING_DETAIL_MAX_MARKS;
    const marks = truncated ? read.slice(read.length - HOLDING_DETAIL_MAX_MARKS) : read;
    return {
      sku,
      baseSku: base,
      row,
      lots: pos ? [...pos.lots].sort((a, b) => a.ts - b.ts || a.id - b.id) : [],
      closed: closedTradesOf(s.closed, sku).slice(0, HOLDING_DETAIL_MAX_CLOSED),
      typicalHold: typicalHold(s.closed, s.open, sku),
      marks,
      truncated,
      history: row ? holdingExitHistory(marks, row.heldSince, kp, t, markSettings.at) : null,
      keyScrap: kp,
      generatedAt: t,
    };
  }

  /** 0.7.3, as the service's eventsExportQuery: the Live log's kinds, category and search. */
  function eventsExportFilter(q: EventsExportQuery | undefined, method: string): EventsExportQuery {
    const bad = (why: string): never => {
      throw new Error(`Invalid parameters for ${method}: ${why}`);
    };
    if (q === undefined || q === null) return {};
    if (typeof q !== 'object') return bad('events: expected an object');
    const out: EventsExportQuery = {};
    if (q.kinds !== undefined) {
      if (!Array.isArray(q.kinds) || q.kinds.length > OPPORTUNITY_EVENT_KINDS.length || !q.kinds.every((k) => OPPORTUNITY_EVENT_KINDS.includes(k))) bad('events.kinds: not an event kind');
      out.kinds = [...q.kinds];
    }
    if (q.category !== undefined) {
      if (!(CATEGORIES as readonly unknown[]).includes(q.category)) bad('events.category: not a category');
      out.category = q.category;
    }
    if (q.search !== undefined) {
      if (typeof q.search !== 'string' || q.search.length > MARKET_MAX_SEARCH_CHARS) bad(`events.search: at most ${MARKET_MAX_SEARCH_CHARS} characters`);
      out.search = q.search;
    }
    return out;
  }

  function holdingsQuery(q: HoldingsQuery | undefined, method: string): HoldingsQuery {
    if (q?.search !== undefined && (typeof q.search !== 'string' || q.search.length > MARKET_MAX_SEARCH_CHARS)) {
      throw new Error(`Invalid parameters for ${method}: search: at most ${MARKET_MAX_SEARCH_CHARS} characters`);
    }
    return q?.search !== undefined ? { search: q.search } : {};
  }

  /** Like the service's ctx.journalChanged: the Journal and Holdings pages refresh. */
  function journalChanged(): void {
    emit('journal.changed', { at: now() });
  }

  /** 0.8 (J2): the service's fee zod for one part: absent (or null in a patch), else finite, at least 0 and within `max`. */
  function checkJournalFee(v: unknown, max: number, nullable: boolean): void {
    if (v === undefined || (nullable && v === null)) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error('Fees must be zero or more.');
    if (v > max) throw new Error('That fee is too high.');
  }

  function marketList(q: MarketQuery): MarketListResult {
    const bad = (why: string): never => {
      throw new Error(`Invalid parameters for market.list: ${why}`);
    };
    if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > MARKET_MAX_LIMIT)) bad(`limit: must be 1 to ${MARKET_MAX_LIMIT}`);
    if (q.offset !== undefined && (!Number.isInteger(q.offset) || q.offset < 0)) bad('offset: must be zero or more');
    if (q.search !== undefined && q.search.length > MARKET_MAX_SEARCH_CHARS) bad(`search: at most ${MARKET_MAX_SEARCH_CHARS} characters`);
    const known = mockKnownPrices(prices);
    const all = marketRows(known);
    const res = mockMarketQuery(all, q, now());
    return {
      // 0.8 (T7): the page's rows only, as the service's list() (not the CSV, not the banks cards).
      rows: res.rows.map(withMarketTiming),
      total: res.total,
      counts: res.counts,
      scraptf: scraptfSide(known),
      stats: marketStats(all.filter((r) => r.buyerCount > 0).length),
      keyPrice: keyPrice(),
      generatedAt: now(),
    };
  }

  /** Like the service's onChanged: entries (rows with buyers) added, removed, or moved in revenue, ceiling, buyers or revenue order. */
  function emitMarketChanges(): void {
    const next = new Map<string, string>();
    for (const r of marketRows()) if (r.buyerCount > 0) next.set(r.sku, marketSignature(r));
    let changed = 0;
    for (const [sku, sig] of next) if (marketSigs.get(sku) !== sig) changed++;
    for (const sku of marketSigs.keys()) if (!next.has(sku)) changed++;
    marketSigs = next;
    if (changed === 0) return;
    marketChangeAt = now();
    emit('market.changed', { changed, total: next.size, at: marketChangeAt });
    // F15: market rows feed each bank's lookFor.
    banksChanged();
  }

  /** A buyer re-prices the order a market row sells to, so the Live market visibly moves every few seconds. */
  function repriceMarketOrder(t: UnixMs): void {
    const candidates = [...extraBooks.values(), ...books.values()].filter((b) => !/;p\d/.test(b.item.sku) && b.buy.some((o) => o.eligible));
    if (candidates.length === 0) return;
    const book = marketRng.pick(candidates);
    const target = mockPrices(book, settings, keyPrice().valueScrap, t).cons;
    const order = target ? book.buy.find((o) => o.listingId === target.listingId) : undefined;
    if (!order) return;
    const step = Math.max(1, Math.round(order.valueScrap * (0.005 + marketRng.next() * 0.025)));
    const v = Math.max(1, order.valueScrap + (marketRng.chance(0.5) ? step : -step));
    order.keys = v >= MOCK_KEY_SCRAP ? Math.floor(v / MOCK_KEY_SCRAP) : 0;
    order.metalScrap = v - order.keys * MOCK_KEY_SCRAP;
    order.valueScrap = v;
    order.lastEventAt = t;
    book.buy.sort((a, b) => b.valueScrap - a.valueScrap);
  }

  function changedAndEmit(): void {
    const diff = recompute();
    if (diff.appeared + diff.changed + diff.gone > 0) emit('opps.changed', diff);
    emitMarketChanges();
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
    if (marketRng.chance(0.85)) repriceMarketOrder(t);
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
    emitMarketChanges();
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
      .map(({ item }) => ({ sku: item.sku, name: item.name, category: item.category, source: books.has(item.sku) || extraBooks.has(item.sku) ? 'bptf' : 'schema' }));
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
    const known = books.get(sku) ?? extraBooks.get(sku) ?? (findCatalogItem(sku) || prices.some((p) => p.sku === sku) ? bookFor(sku) : null);
    if (!known) return null;
    const t = now();
    const scrapPrices = prices
      .filter((p) => p.sku === sku)
      .sort((a, b) => b.observedAt - a.observedAt)
      .map(withBank);
    const list = listRowFor(sku);
    const assetId = scrapPrices.find((p) => p.assetId)?.assetId ?? null;
    const blocked = new Set(settings.blocklist);
    const kp = keyPrice().valueScrap;
    // 0.7.4 (R31): 'unverified' from the order's age now, as the service flags it (mockOrderFlags).
    // 0.8 (PC-2): as buildItemDetail, every order valued at today's key price and the pricing's outliers flagged
    // 'outlier' (mockPrices' outlierIds), so the drawer's Next buyer and the Live check read the book revenue came from.
    const { outlierIds } = mockPrices(known, settings, kp, t);
    const buyOrders = known.buy
      .map((o) => ({ ...o, valueScrap: Math.round(o.keys * kp) + o.metalScrap, flags: mockOrderFlags(o, t) }))
      .map((o) => (blocked.has(o.steamid) && o.eligible ? { ...o, eligible: false, flags: [...o.flags, 'blocklisted'] } : o))
      .map((o) => (o.eligible && outlierIds.has(o.listingId) && !o.flags.includes('outlier') ? { ...o, flags: [...o.flags, 'outlier'] } : o))
      .sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.valueScrap - a.valueScrap);
    return {
      sku,
      name: known.item.name,
      bptfName: known.item.name,
      category: known.item.category,
      skuObject: fromString(sku),
      revenue: mockRevenue(known, settings, kp, t),
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
      scraptfList: list,
      // As the service: the plain copy's saved list price, which a painted SKU's own prices leave out.
      scraptfListSaved: list !== null && scraptfListPriceSaved(list, prices.filter((p) => p.sku === list.sku)),
      // F15: as the service, the bank of the newest imported price shown.
      seenOn: scraptfSeenOn(scrapPrices),
      // 0.7.4 (R32): as the service's kindBank, the bank its kind is sold on (mockBankOf: no schema entry).
      kindBank: mockBankOf(sku, known.item.category),
      // F17: as the service, this copy in the newest bank-stock save that lists it.
      bankStock: bankStockItemOf(stockDiffs(keyPrice().valueScrap), sku, keyPrice().valueScrap),
      // 0.8 (H3): as buildItemDetail, what other sellers ask for this copy (askSideOf over the book's sells).
      ask: mockHoldingAsk(known, sku, settings, keyPrice().valueScrap, t),
    };
  }

  function shoppingList(q: ShoppingQuery): ShoppingListResult {
    // ACT-9, as the service: the known price's age and stock, stale past profit.inputStaleMs.
    const byId = new Map(prices.map((p) => [p.id, p]));
    const stockOf = (o: Opportunity): number | null => {
      if (!o.inputRef.startsWith('price:')) return null;
      const stock = byId.get(Number(o.inputRef.slice('price:'.length)))?.stock;
      return typeof stock === 'number' && Number.isFinite(stock) ? stock : null;
    };
    // 0.7.4 (F36): as the service's MarketIndex.bankFor, the bank page a save listed the item on, else its kind's.
    const sightings = scraptfSeenByBase(stockDiffs(keyPrice().valueScrap));
    const bankOf = (sku: string, category: Category): ScraptfBank => {
      let base = sku;
      try {
        base = baseSku(sku);
      } catch {
        // as given
      }
      const link = scraptfLinkFor(category, sightings.get(base) ?? null, mockBankOf(base, category));
      return link.bank === 'list' ? mockBankOf(base, category) : link.bank;
    };
    return mockShoppingList([...opps.values()], q, settings.profit.useOrder, keyPrice(), now(), { staleMs: settings.profit.inputStaleMs, stockOf, bankOf });
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

  /**
   * A saved scrap.tf/items page, as the service imports one (F14): every list row is re-dated to the
   * file (no newer row is replaced), then 'import.done', 'scraptf.listChanged' and 'prices.changed'.
   * Prices, stock and limits stay as seeded: the mock parses nothing.
   */
  function importList(fileName: string, mtimeMs: number): ImportResult {
    const t = now();
    const at = Number.isFinite(mtimeMs) && mtimeMs > 0 ? Math.min(Math.round(mtimeMs), t) : t;
    const batchId = batchSeq++;
    let stored = 0;
    listRows = listRows.map((r) => {
      if (r.observedAt > at) return r;
      stored++;
      return { ...r, batchId, observedAt: at };
    });
    const outOfStock = listRows.filter((r) => r.batchId === batchId && r.stock === 0);
    // 0.7.4, as the service: a family row (craft 'any') is a list row only, never a price.
    const unproven = listRows.filter((r) => r.batchId === batchId && r.stock !== 0 && r.craft !== 'craftable' && r.craft !== 'uncraftable');
    const allSkipped = [...outOfStock.map((r) => ({ reason: SKIP_OUT_OF_STOCK, title: r.name })), ...unproven.map((r) => ({ reason: SKIP_CRAFT_UNPROVEN, title: r.name }))];
    const result: ImportResult = {
      batchId,
      fileName,
      pageKind: 'items-list',
      parsed: listRows.length,
      stored: stored - outOfStock.length - unproven.length,
      skipped: allSkipped.slice(0, 500),
      // P5, as the service: the true total and the count per reason, before the list is cut.
      ...mockSkipTotals(allSkipped),
      warnings: ['Mock mode: the saved list is not parsed in the browser preview; the seeded list was re-dated.'],
      listRows: stored,
      bank: 'list',
    };
    batches.unshift({ id: batchId, fileName, pageKind: 'items-list', fileMtime: at, importedAt: t, itemCount: result.stored, categories: null, bank: 'list' });
    pricesChanged();
    // As the service: an older copy that changed no row announces nothing.
    if (stored > 0) emit('scraptf.listChanged', { at: t, items: listRows.length });
    changedAndEmit();
    emit('import.done', result);
    return result;
  }

  /**
   * F18 S3, as the service: a recognised bank page with no card warns 'no-cards-saved', stores nothing
   * and removes nothing. Its batch keeps the bank and time with 0 items, so the shared rules
   * (isEmptyBankSave) keep the strip and the banks card on the save before; no bank stock save is made.
   */
  function importWithoutCards(fileName: string, mtimeMs: number): ImportResult {
    const t = now();
    const at = Number.isFinite(mtimeMs) && mtimeMs > 0 ? Math.min(Math.round(mtimeMs), t) : t;
    const batchId = batchSeq++;
    const result: ImportResult = { batchId, fileName, pageKind: 'buy', bank: 'hats', parsed: 0, stored: 0, skipped: [], ...mockSkipTotals([]), warnings: [`${NO_CARDS_SAVED}: ${NO_CARDS_SAVED_REASON}`] };
    batches.unshift({ id: batchId, fileName, pageKind: 'buy', fileMtime: at, importedAt: t, itemCount: 0, categories: {}, bank: 'hats' });
    pricesChanged();
    emit('import.done', result);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Live check (F16): as the service, results only (never text), newest first
  // ---------------------------------------------------------------------------

  let checkSeq = 0;
  /** F19: main's 'check.arm', in memory (the SKU only: the mock has no watcher to compare the name with). */
  let checkArmed: { sku: string; until: UnixMs } | null = null;

  /** main's checkArmParams: a SKU and a name (1 to CHECK_ARM_NAME_MAX characters, one line), or null. Fixed messages. */
  function armCheck(p: unknown): { armedUntil: UnixMs | null } {
    if (p === null) {
      checkArmed = null;
      return { armedUntil: null };
    }
    if (typeof p !== 'object') throw new Error('Invalid parameters for check.arm: expected { sku, name } or null');
    const { sku: rawSku, name: rawName } = p as { sku?: unknown; name?: unknown };
    const sku = typeof rawSku === 'string' ? rawSku.trim().toLowerCase() : '';
    if (!sku || sku.length > 300 || !isValidSku(sku)) throw new Error('Invalid parameters for check.arm: sku: not a SKU');
    if (typeof rawName !== 'string') throw new Error('Invalid parameters for check.arm: name: must be a string');
    const name = rawName.trim();
    if (!name) throw new Error('Invalid parameters for check.arm: name: an item name is required');
    if (name.length > CHECK_ARM_NAME_MAX) throw new Error(`Invalid parameters for check.arm: name: at most ${CHECK_ARM_NAME_MAX} characters`);
    if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('Invalid parameters for check.arm: name: not an item name');
    checkArmed = { sku, until: now() + CHECK_ARM_MS };
    return { armedUntil: checkArmed.until };
  }

  /** What main adds to a hotkey or watcher check while armed (never to a manual one). */
  function armedHint(source: unknown): { sku: string } | null {
    if (source === 'manual' || checkArmed === null) return null;
    if (now() >= checkArmed.until) {
      checkArmed = null;
      return null;
    }
    return { sku: checkArmed.sku };
  }
  let recentChecks: CheckResult[] = [];

  /** The service's zod for 'check.text' hint: an object whose SKU passes the SKU rule (fixed messages). */
  function checkHintOf(hint: unknown): { sku: string } | null {
    if (hint === undefined) return null;
    if (!hint || typeof hint !== 'object') throw new Error('Invalid parameters for check.text: hint: expected { sku }');
    const raw = (hint as { sku?: unknown }).sku;
    const sku = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!sku || sku.length > 300 || !isValidSku(sku)) throw new Error('Invalid parameters for check.text: hint.sku: not a SKU (pick an item first)');
    return { sku };
  }

  function liveCheck(text: unknown, source: unknown, rawHint?: unknown): CheckResult {
    // As the service's zod: fixed messages, never the text.
    if (typeof text !== 'string') throw new Error('Invalid parameters for check.text: text: must be a string');
    if (text.length > CHECK_MAX_CHARS) throw new Error(`Invalid parameters for check.text: text: at most ${CHECK_MAX_CHARS} characters`);
    if (source !== 'hotkey' && source !== 'watch' && source !== 'manual') throw new Error('Invalid parameters for check.text: source: must be hotkey, watch or manual');
    // The mock plays main too: a hotkey or watcher check while armed carries the arm's hint.
    const hint = checkHintOf(rawHint) ?? armedHint(source);
    const t = now();
    const id = ++checkSeq;
    const kp = keyPrice().valueScrap;
    const read = mockParseCheck(text, resolve);
    let parsed: MockParsedCheck;
    // F19: only a bare price takes the hinted item; text that names an item wins.
    let hinted = false;
    if (read.ok) parsed = read.parsed;
    else {
      const hintItem = read.status === 'not-item' && hint ? resolve(hint.sku) : null;
      const fromHint = hintItem ? mockHintedParse(text, hintItem, source as CheckSource) : null;
      if (!fromHint) return blankCheckResult(read.status, read.reason, source as CheckSource, t, id, kp);
      parsed = fromHint;
      hinted = true;
    }
    /** One copy checked (the name in the hinted note is the resolved item's, never the text). */
    const evaluate = (p: MockParsedCheck, craftNote: string | null): CheckResult => {
      const sku = p.item.sku;
      let base = sku;
      try {
        base = baseSku(sku);
      } catch {
        // an unparseable SKU is its own base
      }
      // Buyer confidence as the Live market row's (the service reads the market entry).
      const book = books.get(base) ?? extraBooks.get(base) ?? null;
      const row = book ? mockMarketRow({ item: book.item, book, known: undefined, rules: [], settings, keyScrap: kp, now: t }) : null;
      return mockCheckResult({
        id,
        source: source as CheckSource,
        now: t,
        parsed: p,
        detail: detail(sku),
        keyScrap: kp,
        settings,
        confidence: row && row.buyerCount > 0 ? { value: row.confidence, level: row.confidenceLevel } : null,
        hinted,
        // 0.7.4: as the service, the hinted note names the item the user opened, also when its twin answers.
        hintedName: hinted && sku !== parsed.item.sku ? (detail(parsed.item.sku)?.name ?? parsed.item.name) : null,
        craftNote,
        // 0.7.4 (R14): the craftability twin's references for the cost check, as the engine's twin references.
        twinReferences: () => {
          const twinSku = craftabilityTwin(base);
          return (twinSku ? (books.get(twinSku) ?? extraBooks.get(twinSku) ?? null) : null)?.references ?? null;
        },
      });
    };
    // 0.7.4 (F41, F44): judged as the service judges it: the watcher drops a number without a unit, and a plain
    // name's copy is the one the saved list rows and bank saves match.
    const result = mockJudgeCheck({
      parsed,
      source: source as CheckSource,
      listRowFor: (s) => listRowFor(s, kp),
      bankPricesFor: (s) => bankStockPricesOf(stockDiffs(kp), s),
      evaluate,
    });
    recentChecks = [result, ...recentChecks].slice(0, CHECK_RECENT_MAX);
    emit('check.done', result);
    return result;
  }

  // F21: main's scrap.tf window methods over a fake history; nothing is loaded or read in a browser.
  const scraptfWindow = createMockScraptfWindow({
    now,
    settings: () => settings,
    emit,
    itemsOn: (url) => {
      const bank = SCRAPTF_BANKS.find((b) => b.url === url)?.bank;
      return bank ? (stockSavesOf(bank)[0]?.rows.length ?? 0) : 0;
    },
    // 0.7.1 (UX-3): the toolbar's best flip is the bank stock page's top Flips row, as the service's topFlips[0].
    bestFlipOn: (url) => {
      const bank = SCRAPTF_BANKS.find((b) => b.url === url)?.bank;
      const top = bank ? bankStockList({ bank, filter: 'flips', sort: 'profit', limit: 1 }).rows[0] : undefined;
      return top && top.profitScrap !== null ? { sku: top.sku, name: top.name, profitScrap: top.profitScrap } : null;
    },
    // 0.7.4 (G1 follow-up to R01/R06): the page's flip counts from the same shared rules as its Flips chip, so
    // an /items row for every copy (bankStockListFamily) counts as no flip, as in the service's pageFlips.
    flipsOn: (url) => {
      const bank = SCRAPTF_BANKS.find((b) => b.url === url)?.bank;
      if (!bank) return null;
      const c = bankStockList({ bank, limit: 1 }).counts;
      // 0.8 (G2): the flips this read dropped under Pay up to, by the shared rule (ImportResult.droppedFlips).
      return { pageFlips: c.flips, newFlips: c.newFlips, droppedFlips: bankStockAll(bank).rows.filter(bankStockDroppedIntoFlip).length };
    },
  });

  const handlers: Handlers = {
    'status.get': () => status(),
    'opps.list': (q) => {
      const sorted = sortOpportunities(filterOpportunities([...opps.values()], q ?? {}), q?.sort ?? 'profit', q?.dir ?? 'desc');
      // Like the service: a grouped list is paged in group order, the sort applying inside each group.
      const rows = q?.groupBy ? orderByGroup(sorted, q.groupBy) : sorted;
      const offset = Math.max(0, q?.offset ?? 0);
      const limit = Math.max(1, Math.min(5000, q?.limit ?? 500));
      // 0.8 (T4/T7): each 'import' row's buy timing on the page, as the service's listOpportunities joins it.
      const t = now();
      const page = rows.slice(offset, offset + limit).map((o) => {
        const timing = scraptfOpportunityTiming(o, (b, s, buy) => mockTimingForCopy(b, s, buy), t);
        return timing ? { ...o, timing } : o;
      });
      return { rows: page, total: rows.length, groups: summarizeGroups(rows, q?.groupBy ?? 'category', settings.profit.useOrder), keyPrice: keyPrice(), generatedAt: t };
    },
    'opps.events': (q) => {
      let list = events;
      if (q?.kinds?.length) list = list.filter((e) => q.kinds!.includes(e.kind));
      if (q?.sku) list = list.filter((e) => e.sku === q.sku);
      if (q?.sinceTs !== undefined) list = list.filter((e) => e.ts > q.sinceTs!);
      if (q?.beforeId !== undefined) list = list.filter((e) => e.id < q.beforeId!);
      return [...list].sort((a, b) => b.id - a.id).slice(0, Math.max(1, Math.min(2000, q?.limit ?? 200)));
    },
    'opps.exportCsv': ({ kind, query, events: eventsFilter, shopping, market, holdings, bankStock, scraptfChanges }) => {
      const t = now();
      const kp = keyPrice().valueScrap;
      if (kind === 'scraptfChanges') {
        // F20, as the service: the feed's filters, newest first; paging does not apply to the file.
        const { beforeId: _beforeId, limit: _limit, ...filters } = changesQuery(scraptfChanges, 'opps.exportCsv');
        const rows: unknown[][] = [[...SCRAPTF_CHANGES_CSV_COLUMNS]];
        for (const e of changesList(filters, SCRAPTF_CHANGES_EXPORT_MAX)) rows.push(scraptfChangeCsvCells(e, kp));
        return { csv: csv(rows), suggestedName: `flipdesk-scraptf-changes-${stamp(t)}.csv` };
      }
      if (kind === 'bankStock') {
        // As the service: the bank is required; the page's filter, search and sort, paging ignored.
        if (!bankStock) throw new Error('Invalid parameters for opps.exportCsv: bankStock: required for kind bankStock');
        const { limit: _limit, offset: _offset, ...filters } = bankStockQuery(bankStock, 'opps.exportCsv');
        const rows: unknown[][] = [[...BANK_STOCK_CSV_COLUMNS]];
        for (const r of bankStockMatching(bankStockAll(filters.bank).rows, filters, t)) rows.push(bankStockCsvCells(r, kp));
        return { csv: csv(rows), suggestedName: `flipdesk-bank-stock-${filters.bank}-${stamp(t)}.csv` };
      }
      if (kind === 'holdings') {
        const rows: unknown[][] = [[...HOLDINGS_CSV_COLUMNS]];
        for (const r of holdingsMatching(holdingRows(), holdingsQuery(holdings, 'opps.exportCsv'))) rows.push(holdingsCsvCells(r, kp));
        return { csv: csv(rows), suggestedName: `flipdesk-holdings-${stamp(t)}.csv` };
      }
      if (kind === 'market') {
        // The page's filters and sort; paging does not apply to the file.
        const { limit: _limit, offset: _offset, ...filters } = market ?? {};
        const rows: unknown[][] = [[...MARKET_CSV_COLUMNS]];
        for (const r of mockMarketQuery(marketRows(), filters, t).matched) rows.push(marketCsvCells(r, kp));
        return { csv: csv(rows), suggestedName: `flipdesk-market-${stamp(t)}.csv` };
      }
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
        // 0.7.3, as the service: the newest EVENTS_EXPORT_MAX of the Live log's kinds, then its category and search.
        const { kinds, category, search } = eventsExportFilter(eventsFilter, 'opps.exportCsv');
        const tokens = marketSearchTokens(search);
        const list = events
          .filter((e) => !kinds?.length || kinds.includes(e.kind))
          .sort((a, b) => b.id - a.id)
          .slice(0, EVENTS_EXPORT_MAX)
          .filter((e) => eventMatches(e, category, tokens));
        const rows: unknown[][] = [['id', 'time', 'kind', 'sku', 'name', 'category', 'profit_ref', 'confidence', 'summary']];
        for (const e of list) rows.push([e.id, new Date(e.ts).toISOString(), e.kind, e.sku, e.name, e.category, e.profitScrap === null ? '' : (e.profitScrap / 9).toFixed(2), e.confidence, e.summary]);
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
    'market.list': (q) => marketList(q ?? {}),
    'holdings.list': (q) => holdingsResult(holdingRows(), holdingsQuery(q, 'holdings.list'), keyPrice(), now()),
    // 0.8 (H7): the drawer's "Your holding & trades", from the mock's holdings, as the service's Holdings.detail.
    'holdings.detail': (p) => {
      if (typeof p?.sku !== 'string' || !isValidSku(p.sku.trim().toLowerCase())) throw new Error('Invalid parameters for holdings.detail: sku: not a SKU (pick an item first)');
      // Local only, as the service: the journal, the recorded exit runs and the same book (H7).
      return holdingDetail(canonical(p.sku.trim().toLowerCase()));
    },
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
        // The drawer counts etaMs down itself, as with the service's refusal.
        return { queued: false, reason: 'Snapshot budget is 1 request per 10 s.', etaMs: wait };
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
        .sort((a, b) => b.observedAt - a.observedAt)
        .map(withBank);
    },
    'prices.upsert': (input) => {
      if (!input || typeof input.sku !== 'string' || !input.sku.trim()) throw new Error('An item is required.');
      if (!Number.isFinite(input.costScrap) || input.costScrap < 0) throw new Error('Price must be zero or more.');
      if (input.costKeys !== undefined && (!Number.isFinite(input.costKeys) || input.costKeys < 0)) throw new Error('Keys must be zero or more.');
      const typedSku = canonical(input.sku.trim());
      // 0.7.4 (F80): as the service, replaceTyped (no id) updates the newest typed price of this copy, its
      // stored SKU and extras kept; none adds a row.
      const typed =
        input.id === undefined && input.replaceTyped === true && (input.source ?? 'user') === 'user'
          ? newestTypedPriceFor(prices.filter((p) => looksLikeSku(p.sku) && baseSku(p.sku) === baseSku(typedSku)), typedSku)
          : null;
      const sku = typed?.sku ?? typedSku;
      const existing = typed ?? (input.id !== undefined ? prices.find((p) => p.id === input.id) : undefined);
      if (input.id !== undefined && !existing) throw new Error(`Price #${input.id} does not exist.`);
      const keep = keepUnlessMoved(existing, sku);
      const row: ScrapPrice = {
        id: existing?.id ?? priceSeq++,
        sku,
        name: input.name?.trim() || itemName(sku),
        costKeys: input.costKeys ?? 0,
        costScrap: Math.round(input.costScrap),
        source: input.source ?? existing?.source ?? 'user',
        observedAt: input.observedAt ?? now(),
        note: input.note === undefined ? (existing?.note ?? null) : input.note,
        importBatch: keep(input.importBatch, existing?.importBatch),
        special: keep(input.special, existing?.special),
        assetId: keep(input.assetId, existing?.assetId),
        stock: keep(input.stock, existing?.stock),
      };
      prices = existing ? prices.map((p) => (p.id === row.id ? row : p)) : [...prices, row];
      pricesChanged();
      changedAndEmit();
      return withBank(row);
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
        const keep = keepUnlessMoved(existing, sku);
        const row: ScrapPrice = {
          id: existing?.id ?? priceSeq++,
          sku,
          name: r.name?.trim() || itemName(sku),
          costKeys: r.costKeys ?? 0,
          costScrap: Math.round(r.costScrap),
          source: 'user',
          observedAt: r.observedAt ?? t,
          note: r.note === undefined ? (existing?.note ?? null) : r.note,
          importBatch: keep(undefined, existing?.importBatch),
          special: keep(r.special, existing?.special),
          assetId: keep(undefined, existing?.assetId),
          stock: keep(undefined, existing?.stock),
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
      if (!JOURNAL_SIDES.includes(input?.side)) throw new Error('Side must be buy, sell or writeoff.');
      if (!input.venue?.trim()) throw new Error('A venue is required.');
      if (!input.sku?.trim()) throw new Error('An item is required.');
      if (!Number.isFinite(input.scrap) || input.scrap < 0) throw new Error('Price must be zero or more.');
      // 0.7.4 (F39): as the service's journalInput, a backfill's key price then is whole scrap, 9 to 100,000.
      const k = input.keyPriceScrap;
      if (k !== undefined && (!Number.isInteger(k) || k < 9 || k > 100_000)) throw new Error('Key price must be at least 1 ref.');
      // 0.8 (J2): as the service's zod, each fee part given is checked; a write-off receives nothing (its refine).
      checkJournalFee(input.feeKeys, JOURNAL_MAX_FEE_KEYS, false);
      checkJournalFee(input.feeScrap, JOURNAL_MAX_FEE_SCRAP, false);
      if (input.side === 'writeoff' && ((input.keys ?? 0) !== 0 || input.scrap !== 0 || input.feeKeys !== undefined || input.feeScrap !== undefined)) {
        throw new Error(JOURNAL_WRITE_OFF_NOTHING);
      }
      const fee = feeOf(input);
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
        keyPriceScrap: k ?? keyPrice().valueScrap,
        note: input.note ?? null,
        ...(fee ? { feeKeys: fee.keys, feeScrap: Math.round(fee.scrap) } : {}),
      };
      journal = [...journal, row];
      journalChanged();
      return row;
    },
    'journal.delete': ({ id }) => {
      journal = journal.filter((j) => j.id !== id);
      journalChanged();
      return { ok: true };
    },
    // 0.8 (J6): as the service, venue, note and fee only (params checked first, then the row); a write-off takes no fee.
    'journal.update': (p) => {
      const bad = (why: string): never => {
        throw new Error(`Invalid parameters for journal.update: ${why}`);
      };
      const entryId = p?.id;
      if (typeof entryId !== 'number' || !Number.isInteger(entryId) || entryId <= 0) bad('id');
      const venue = p.venue === undefined ? undefined : typeof p.venue === 'string' ? p.venue.trim() : null;
      if (venue !== undefined && (venue === null || venue.length < 1 || venue.length > 100)) bad('venue');
      if (p.note !== undefined && p.note !== null && (typeof p.note !== 'string' || p.note.length > 500)) bad('note');
      checkJournalFee(p.feeKeys, JOURNAL_MAX_FEE_KEYS, true);
      checkJournalFee(p.feeScrap, JOURNAL_MAX_FEE_SCRAP, true);
      const before = journal.find((j) => j.id === entryId);
      if (!before) throw new Error(JOURNAL_ENTRY_GONE);
      if (before.side === 'writeoff' && feePatchOf(p)) throw new Error(JOURNAL_WRITE_OFF_NOTHING);
      const row = applyJournalPatch(before, {
        venue: venue ?? undefined,
        note: p.note === undefined ? undefined : p.note?.trim() || null,
        feeKeys: p.feeKeys,
        feeScrap: p.feeScrap,
      });
      journal = journal.map((j) => (j.id === entryId ? row : j));
      journalChanged();
      return row;
    },
    'journal.summary': () => mockJournalSummary(journal),
    // 0.8 (J5): the service's ledger cells in FIFO order (the value_ref column included).
    'journal.exportCsv': () => {
      const rows: unknown[][] = [[...JOURNAL_CSV_COLUMNS], ...journalLedger(journal).map(journalCsvCells)];
      return { csv: csv(rows), suggestedName: `flipdesk-journal-${stamp(now())}.csv` };
    },
    'import.html': (p) => {
      // F21: as main's router, a page may not mark its import as a scrap.tf window read.
      if (p.address !== undefined || p.origin !== undefined) throw new Error(IMPORT_HTML_ORIGIN_REFUSAL);
      const { fileName, mtimeMs } = p;
      requireImportEnabled();
      // A saved scrap.tf/items page ("Items.html", "items_2.html"): the whole list counts as re-saved (F14).
      if (/items/i.test(fileName)) return importList(fileName, mtimeMs);
      // F18 S3 in the preview: a hats page "saved without its cards" (a name with "empty" or "no cards").
      if (/\b(empty|no[ -]?cards)\b/i.test(fileName)) return importWithoutCards(fileName, mtimeMs);
      const result: ImportResult = { batchId: batchSeq++, fileName, pageKind: 'unknown', bank: null, parsed: 0, stored: 0, skipped: [], ...mockSkipTotals([]), warnings: ['Mock mode: saved pages are not parsed in the browser preview.'] };
      batches.unshift({ id: result.batchId, fileName, pageKind: 'unknown', fileMtime: mtimeMs, importedAt: now(), itemCount: 0, bank: null });
      return result;
    },
    'import.batches': (p) => batches.slice(0, Math.max(1, p?.limit ?? 20)),
    // 0.7.1 (P4): the preview parses nothing, so it answers one fixed, whitelisted sample report.
    'import.report': (p) => {
      const n = p?.limit;
      if (n !== undefined && (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > IMPORT_REPORT_RING)) {
        throw new Error(`Invalid parameters for import.report: limit: must be 1 to ${IMPORT_REPORT_RING}`);
      }
      return [mockImportReport(t0)].slice(0, n ?? IMPORT_REPORT_RING);
    },
    'scraptf.listStatus': () => listStatus(),
    'scraptf.banks': () => banksResult(),
    'scraptf.bankStock': (q) => bankStockList(bankStockQuery(q, 'scraptf.bankStock')),
    'scraptf.itemHistory': (p) => itemHistory(p),
    'scraptf.changes': (q) => changesList(changesQuery(q, 'scraptf.changes')),
    // 0.8 (G1): as the service, from memory (the watch list and the kept saves) by the shared rules; nothing is fetched.
    'watches.list': (p) => {
      const q = p as { sku?: unknown } | null | undefined;
      const sku = q?.sku !== undefined ? watchParams('watches.list').sku(q.sku) : null;
      // Any SKU of the item lists its base's watches.
      const base = sku !== null ? (bankStockTargetOf(sku)?.base ?? sku) : null;
      const list = watchList().filter((w) => base === null || w.sku === base);
      const pages = list.length > 0 ? watchPages(new Set(list.map((w) => w.sku))) : [];
      const minConfidence = settings.notifications.minConfidence;
      return watchViewsOf(list, pages, keyPrice().valueScrap, Number.isFinite(minConfidence) ? minConfidence : 0);
    },
    'watches.upsert': (p) => {
      const input = watchParams('watches.upsert').input(p);
      const all = watchList();
      const existing = input.id !== undefined ? (all.find((w) => w.id === input.id) ?? null) : null;
      if (input.id !== undefined && existing === null) throw new Error(WATCH_GONE);
      const write = watchWriteOf(input, existing, (b) => findCatalogItem(b)?.name ?? null);
      // As the repo: one watch per copy; an add of a watched copy updates it, an update may not take another's copy.
      const same = all.find((w) => w.sku === write.sku && w.specialKey === write.specialKey) ?? null;
      if (existing === null && same === null && all.length >= WATCHES_MAX) throw new Error(WATCHES_FULL);
      if (existing !== null && same !== null && same.id !== existing.id) throw new Error(WATCH_COPY_TAKEN);
      const target = existing ?? same;
      const t = now();
      const saved: ScraptfWatch = {
        id: target ? target.id : watchSeq++,
        sku: write.sku,
        specialKey: write.specialKey,
        name: write.name,
        maxCostKeys: write.maxCostKeys,
        maxCostScrap: write.maxCostScrap,
        minProfitScrap: write.minProfitScrap,
        onRestock: write.onRestock,
        enabled: write.enabled,
        createdAt: target ? target.createdAt : t,
        updatedAt: t,
      };
      watches = target ? all.map((w) => (w.id === target.id ? saved : w)) : [...all, saved];
      emit('watches.changed', { at: now() });
      return saved;
    },
    'watches.delete': (p) => {
      const watchId = watchParams('watches.delete').watchId((p as { id?: unknown } | null | undefined)?.id);
      watches = watchList().filter((w) => w.id !== watchId);
      emit('watches.changed', { at: now() });
      return { ok: true };
    },
    // As the service: Undo of a removal puts the same watch back (its id and times, watchRestoreOf).
    'watches.restore': (p) => {
      const v = watchParams('watches.restore');
      const q = (p ?? {}) as { id?: unknown; createdAt?: unknown; updatedAt?: unknown };
      const id = v.watchId(q.id);
      const input = { ...v.input(p), id, createdAt: v.time('createdAt', q.createdAt), updatedAt: v.time('updatedAt', q.updatedAt) };
      const all = watchList();
      const back = all.find((w) => w.id === id);
      if (back) return back;
      const r = watchRestoreOf(input, (b) => findCatalogItem(b)?.name ?? null, now());
      if (all.some((w) => w.sku === r.write.sku && w.specialKey === r.write.specialKey)) throw new Error(WATCH_COPY_TAKEN);
      if (all.length >= WATCHES_MAX) throw new Error(WATCHES_FULL);
      const saved: ScraptfWatch = {
        id,
        sku: r.write.sku,
        specialKey: r.write.specialKey,
        name: r.write.name,
        maxCostKeys: r.write.maxCostKeys,
        maxCostScrap: r.write.maxCostScrap,
        minProfitScrap: r.write.minProfitScrap,
        onRestock: r.write.onRestock,
        enabled: r.write.enabled,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
      watches = [...all, saved].sort((a, b) => a.id - b.id);
      emit('watches.changed', { at: now() });
      return saved;
    },
    'check.text': (p) => liveCheck(p?.text, p?.source, p?.hint),
    'check.recent': () => recentChecks,
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
      version: MOCK_APP_VERSION,
      appDir: 'C:\\Users\\you\\AppData\\Local\\Programs\\TF2 Flip Desk',
      dataDir: 'C:\\Users\\you\\AppData\\Roaming\\TF2 Flip Desk',
      logDir: 'C:\\Users\\you\\AppData\\Roaming\\TF2 Flip Desk\\logs',
      platform: 'browser (mock)',
      electron: 'n/a',
      node: 'n/a',
    }),
    // The mock has no separate service process to restart.
    'app.serviceState': () => ({ state: 'ready', detail: null, nextAttemptAt: null }),
    // A browser registers no global hotkey: every stored chord counts as held, '' as off.
    'app.hotkeys': () => ({
      quickEntry: { accelerator: settings.app.quickEntryHotkey, registered: settings.app.quickEntryHotkey !== '', error: null },
      check: { accelerator: settings.check.hotkey, registered: settings.check.hotkey !== '', error: null },
    }),
    'check.arm': (p) => armCheck(p),
    'app.showQuickEntry': (p) => {
      if (typeof location !== 'undefined') location.hash = '#/quick';
      // Like main: the quick-entry page gets the SKU once it listens.
      // Lower-cased first, as main's ipc.ts does, so 'U17'-style effect letters keep the effect.
      const sku = p && typeof p === 'object' && typeof p.sku === 'string' ? p.sku.trim().toLowerCase() : '';
      // F16: price text rides along with a SKU only, under main's limits.
      const price = p && typeof p === 'object' && typeof p.price === 'string' ? p.price.trim() : '';
      if (price.length > CHECK_PRICE_TEXT_MAX || /[\u0000-\u001f\u007f<>]/.test(price)) throw new Error('Invalid parameters for app.showQuickEntry: price: not a price');
      if (sku) {
        if (!looksLikeSku(sku)) throw new Error('Invalid parameters for app.showQuickEntry: sku: not a SKU');
        emitHeld('ui.quickPrefill', price ? { sku: canonical(sku), price } : { sku: canonical(sku) });
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
    // 0.7.1: as main, a known bank and chip only; held until the dashboard subscribes, as the preload holds it.
    'app.showBankStock': (p) => {
      if (!SCRAPTF_BANK_IDS.includes(p?.bank)) throw new Error('Invalid parameters for app.showBankStock: bank: not a scrap.tf bank');
      if (!BANK_STOCK_OPEN_FILTERS.includes(p.filter)) throw new Error('Invalid parameters for app.showBankStock: filter: must be flips, new or watched');
      emitHeld('ui.openBankStock', { bank: p.bank, filter: p.filter });
      return { ok: true };
    },
    'settings.get': () => settings,
    'settings.set': (patch) => {
      const importBefore = JSON.stringify(settings.import);
      const merged = mergeSettings(settings, patch);
      // As main's schema (crossFieldProblem): one chord cannot be both global hotkeys.
      if (sameAccelerator(merged.check.hotkey, merged.app.quickEntryHotkey)) throw new Error(`Invalid settings: ${CHECK_HOTKEY_CONFLICT}`);
      // F21, as main's schema: the window turns on only with its three gates, and off when one goes.
      const gate = gateScraptfWindow(merged, patch?.scraptfWindow?.enabled === true);
      if (!gate.ok) throw new Error(`Invalid settings: ${gate.message}`);
      const next = gate.settings;
      settings = next;
      // 0.8 (H6), as Holdings.settingsChanged: a change to which buyers count is dated now.
      const markKey = holdingMarkSettingsKey(settings);
      if (markKey !== markSettings.key) markSettings = { key: markKey, at: now() };
      emit('settings.changed', settings);
      changedAndEmit();
      // F15: importEnabled and watchActive are part of the banks summary.
      if (JSON.stringify(settings.import) !== importBefore) banksChanged();
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
    'links.open': ({ url, allowWindow }) => {
      // F21: like main, the user's choice sends static scrap.tf pages to the (fake) scrap.tf window, and only
      // from an open worded for it (allowWindow).
      if (allowWindow === true && scraptfWindow.openFromLink(url)) return { opened: true, reason: null, openedIn: 'window' };
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
        bank: 'hats',
        parsed: picks.length + 2,
        stored: picks.length,
        skipped: [
          { reason: 'Item name not in the schema', title: 'Unknown Festive Thing' },
          { reason: 'No price found on the card', title: 'Brigade Helm' },
        ],
        ...mockSkipTotals([
          { reason: 'Item name not in the schema', title: 'Unknown Festive Thing' },
          { reason: 'No price found on the card', title: 'Brigade Helm' },
        ]),
        warnings: ['2 cards had unparsed attributes; they were skipped rather than guessed.'],
      };
      batches.unshift({ id: batchId, fileName: result.fileName, pageKind: 'buy', fileMtime: t - 30_000, importedAt: t, itemCount: picks.length, categories: countCategories(picks.map((c) => c.category)), bank: 'hats' });
      // F17: the page is the hats bank's newest save: the previous newest minus its first row on sale
      // (gone), with the picked cards at their new prices (new, or cheaper/pricier).
      const before = stockSavesOf('hats')[0]?.rows ?? [];
      const picked = new Map(picks.map((item) => [baseSku(item.sku), { sku: baseSku(item.sku), specialKey: '', name: item.name, costKeys: 0, costScrap: Math.max(1, item.value - 4), stock: 1, assetId: null }]));
      const dropped = before.find((r) => r.costScrap !== null && r.stock !== 0 && !picked.has(r.sku));
      const kept = before.filter((r) => r !== dropped && !(r.specialKey === '' && picked.has(r.sku)));
      const written = addStockSave({ bank: 'hats', batchId, savedAt: t - 30_000, rows: [...kept, ...picked.values()] });
      // F20: as the service, after the bank stock and before the prices.
      if (written > 0) emit('scraptf.changed', { at: t - 30_000, count: written });
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
    'scraptfWindow.open': (p) => scraptfWindow.open(p),
    'scraptfWindow.back': () => scraptfWindow.back(),
    'scraptfWindow.forward': () => scraptfWindow.forward(),
    'scraptfWindow.reload': () => scraptfWindow.reload(),
    'scraptfWindow.home': () => scraptfWindow.home(),
    'scraptfWindow.go': (p) => scraptfWindow.go(p),
    'scraptfWindow.read': () => scraptfWindow.read(),
    'scraptfWindow.clear': () => scraptfWindow.clear(),
    'scraptfWindow.state': () => scraptfWindow.state(),
  };

  seedEvents();
  // The starting index is not a change; only later feed moves are pushed as 'market.changed'.
  for (const r of marketRows()) if (r.buyerCount > 0) marketSigs.set(r.sku, marketSignature(r));

  // F16: '#/check?demo=flip|over|no-price|not-item' shows a fixed result in the popup page, as main's
  // 'ui.checkShow' would (held until the page subscribes); changing the hash shows another.
  const showCheckDemo = (): void => {
    const demo = typeof location !== 'undefined' ? checkDemoFromHash(location.hash) : null;
    if (demo) emitHeld('ui.checkShow', mockCheckDemo(demo, now(), keyPrice().valueScrap, settings));
  };
  showCheckDemo();
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('hashchange', showCheckDemo);

  const delay = () => new Promise<void>((res) => setTimeout(res, latency > 0 ? 15 + Math.random() * latency : 0));

  const hash = typeof location !== 'undefined' ? location.hash : '';
  return {
    windowKind: hash.startsWith('#/quick') ? 'quick-entry' : hash.startsWith('#/check') ? 'check' : hash.startsWith(SCRAPTF_BAR_HASH) ? 'scraptf' : 'dashboard',
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
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('hashchange', showCheckDemo);
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

