// RPC contract between the dashboard (renderer), the Electron main process and
// the background service (utilityProcess).
//
//   renderer --window.flipdesk.rpc(method, params)--> main
//   main handles MAIN_METHODS itself and forwards everything else to the service
//   service --push(event, payload)--> main --> renderer (and tray/notifications)

import type {
  AppStatus,
  BankStockQuery,
  BankStockResult,
  BulkPriceRow,
  BuyerCheck,
  CheckArm,
  CheckHint,
  CheckResult,
  CheckSource,
  DeepPartial,
  EventQuery,
  HealthReport,
  HoldingsQuery,
  HoldingsResult,
  ImportBatch,
  ImportResult,
  ItemDetail,
  ItemSuggestion,
  JournalEntry,
  JournalInput,
  JournalSummary,
  LinkSpec,
  MarketListResult,
  MarketQuery,
  OppListResult,
  OppQuery,
  OpportunityEvent,
  PriceRule,
  PriceRuleInput,
  ResolvedItem,
  ScrapPrice,
  ScrapPriceInput,
  ScraptfBanksResult,
  ScraptfChangeEvent,
  ScraptfChangesQuery,
  ScraptfItemHistory,
  ScraptfListStatus,
  SecretName,
  SecretsStatus,
  Settings,
  ShoppingListResult,
  ShoppingQuery,
  UnixMs,
} from './types';

export interface AppInfo {
  version: string;
  dataDir: string;
  logDir: string;
  platform: string;
  electron: string;
  node: string;
}

/** One global hotkey as main holds it: the stored chord, whether Windows gave it to us, and why not. */
export interface HotkeyState {
  /** The stored accelerator ('' = off). */
  accelerator: string;
  registered: boolean;
  /** Why it could not be registered (another app holds it, or it is not a valid shortcut); null otherwise. */
  error: string | null;
}

/** 'app.hotkeys': both global hotkeys, so Settings can say when one is taken (at start-up too). */
export interface HotkeysStatus {
  quickEntry: HotkeyState;
  /** F16: the live check hotkey (settings.check.hotkey). */
  check: HotkeyState;
}

export interface RpcContract {
  // ----- service -----
  'status.get': { params: void; result: AppStatus };
  'opps.list': { params: OppQuery; result: OppListResult };
  'opps.events': { params: EventQuery; result: OpportunityEvent[] };
  /**
   * `query` filters and sorts the opportunities export like 'opps.list' (paging ignored); omitted, every row.
   * kind 'shopping' exports the shopping list filtered by `shopping` (paging ignored).
   * kind 'market' exports the live market filtered and sorted by `market` (paging ignored).
   * kind 'holdings' exports the holdings matching `holdings`, in the page's order.
   * kind 'bankStock' (F17) exports one bank's rows matching `bankStock` (required for it), in its order (paging ignored).
   * kind 'scraptfChanges' (F20) exports the scrap.tf change feed matching `scraptfChanges` (bank, kinds, sku;
   * newest first, at most SCRAPTF_CHANGES_EXPORT_MAX rows, `beforeId` and `limit` ignored).
   */
  'opps.exportCsv': {
    params: {
      kind: 'opportunities' | 'events' | 'shopping' | 'market' | 'holdings' | 'bankStock' | 'scraptfChanges';
      query?: OppQuery;
      shopping?: ShoppingQuery;
      market?: MarketQuery;
      holdings?: HoldingsQuery;
      bankStock?: BankStockQuery;
      scraptfChanges?: ScraptfChangesQuery;
    };
    result: { csv: string; suggestedName: string };
  };
  /** One row per SKU with a "pay up to" ceiling, to browse scrap.tf against by hand. */
  'shopping.list': { params: ShoppingQuery; result: ShoppingListResult };
  /**
   * Live market (F10): every base SKU with eligible backpack.tf buyers in the local book, plus every
   * SKU the user has a scrap.tf price for. Read from the service's in-memory index; no network.
   */
  'market.list': { params: MarketQuery; result: MarketListResult };
  /**
   * Holdings (F11): the journal's open FIFO lots, priced against the same local book as the Live
   * market. No request of its own; held SKUs only join the budgeted snapshot watch list.
   */
  'holdings.list': { params: HoldingsQuery; result: HoldingsResult };
  /**
   * `history: false` skips the PriceDB history fetch (local only, fast); default true.
   * `target: 'plain'` classifies the book against a clean copy of `sku` (the row quick
   * entry saves) instead of the newest stored copy's extras (the drawer, default).
   */
  'item.detail': { params: { sku: string; history?: boolean; target?: 'newest' | 'plain' }; result: ItemDetail | null };
  /** backpack.tf ban lookup for one buyer; on click only, cached 1 h, needs the access token. */
  'buyer.check': { params: { steamid: string }; result: BuyerCheck };
  /** Queue a backpack.tf snapshot refresh for one item (rate limited, user initiated). */
  'item.refresh': { params: { sku: string }; result: { queued: boolean; reason: string | null; etaMs: number | null } };
  'item.search': { params: { q: string; limit?: number }; result: ItemSuggestion[] };
  'item.resolve': { params: { text: string }; result: ResolvedItem | null };
  'links.forSku': { params: { sku: string; assetId?: string | null }; result: LinkSpec[] };
  /** Steam Community Market price overview (off unless enabled in settings; on click only). */
  'item.scm': { params: { sku: string }; result: { lowest: string | null; median: string | null; volume: string | null; marketHashName: string | null } | null };
  'prices.list': { params: { q?: string }; result: ScrapPrice[] };
  'prices.upsert': { params: ScrapPriceInput; result: ScrapPrice };
  'prices.delete': { params: { id: number }; result: { ok: true } };
  /** Preview of a bulk paste; writes nothing. Pasted page content is refused as a whole (R10). */
  'prices.parseBulk': { params: { text: string; bareUnit?: 'ref' | 'scrap' | 'keys' }; result: { rows: BulkPriceRow[]; rejected: number } };
  /** At most 500 rows, written as source 'user' in one transaction with one 'prices.changed' push. A row with `id` updates that price. */
  'prices.bulkUpsert': { params: { rows: ScrapPriceInput[] }; result: { added: number; updated: number } };
  'prices.exportCsv': { params: void; result: { csv: string; suggestedName: string } };
  'rules.list': { params: void; result: PriceRule[] };
  'rules.upsert': { params: PriceRuleInput; result: PriceRule };
  'rules.delete': { params: { id: number }; result: { ok: true } };
  'rules.preview': { params: PriceRuleInput; result: { matchingSkus: number; sample: { sku: string; name: string }[] } };
  'rules.exportJson': { params: void; result: { json: string; suggestedName: string } };
  /** Adds every valid rule (existing rules are kept); invalid ones are skipped with a reason each. */
  'rules.importJson': { params: { json: string }; result: { added: number; skipped: string[] } };
  'journal.list': { params: { limit?: number }; result: JournalEntry[] };
  'journal.add': { params: JournalInput; result: JournalEntry };
  'journal.delete': { params: { id: number }; result: { ok: true } };
  'journal.summary': { params: void; result: JournalSummary };
  'journal.exportCsv': { params: void; result: { csv: string; suggestedName: string } };
  /** Parse a saved scrap.tf page. Refused unless Settings.import.enabled. */
  'import.html': { params: { html: string; fileName: string; mtimeMs: number }; result: ImportResult };
  'import.batches': { params: { limit?: number }; result: ImportBatch[] };
  /**
   * F14: the user's saved scrap.tf/items price list (rows, age, pages) plus the import switches and the
   * folder watch as it runs, for the "scrap.tf price list" card. Local only; nothing contacts scrap.tf (R1).
   */
  'scraptf.listStatus': { params: void; result: ScraptfListStatus };
  /**
   * F15: one summary per scrap.tf page the user saves (SCRAPTF_BANKS order): when it was last saved, its
   * items, the flips its imported prices make and what to look for there. Built in memory from the
   * import batches, the opportunities and the Live market index; local only, nothing contacts scrap.tf (R1).
   */
  'scraptf.banks': { params: void; result: ScraptfBanksResult };
  /**
   * F17: every item on one scrap.tf bank page as the user's newest save of it shows it, what changed since
   * their previous save (new, gone, cheaper, pricier), each joined to the Live market's backpack.tf side
   * (Sells for, Pay up to, verdict, confidence). Gone rows come back only with filter 'gone'. Built in
   * memory from saved pages (R10) and the local book; local only, nothing contacts scrap.tf (R1).
   */
  'scraptf.bankStock': { params: BankStockQuery; result: BankStockResult };
  /**
   * F20: one copy of an item across the user's retained saves of its bank: a price per save (gaps where
   * it was not listed), time listed, the 1 h / 24 h / 7 d / since-listed changes, stock now and its last
   * change events. `special` is the bank_stock special key of the copy (BankStockRow.key's second part);
   * omitted or null, the SKU's own (its paint, else a clean copy). Built in memory from saved pages (R10);
   * local only, nothing contacts scrap.tf (R1).
   */
  'scraptf.itemHistory': { params: { sku: string; special?: string | null }; result: ScraptfItemHistory };
  /**
   * F20: the change feed (new, gone, cheaper, pricier, restocked, stock) of the user's saves, newest first,
   * each valued at the current key price with the live Sells for and Pay up to of its base SKU. Paged by
   * `beforeId`; `limit` 1..500 (default 100). Local only (R1).
   */
  'scraptf.changes': { params: ScraptfChangesQuery; result: ScraptfChangeEvent[] };
  /**
   * Live check (F16): one piece of text the user copied or typed (at most CHECK_MAX_CHARS, zod), checked
   * as a TF2 item against the local order book (item.detail {history:false} semantics) and the saved
   * scrap.tf list. Local only: no request of any kind, nothing contacts scrap.tf (R1). The text is never
   * logged, stored or quoted in an error; only the result is kept (the 'check.recent' ring), and an item
   * result is pushed as 'check.done'. Main calls it for the hotkey and the watcher after its privacy filter.
   * F19: `hint` (main only, while a 'check.arm' is unexpired; a page's check.text may not carry one) names
   * the item the user opened on scrap.tf. Text with a price but no item is checked as that SKU; text that
   * names an item ignores it.
   */
  'check.text': { params: { text: string; source: CheckSource; hint?: CheckHint }; result: CheckResult };
  /** The last CHECK_RECENT_MAX item results, newest first; in memory, results only (never text). */
  'check.recent': { params: void; result: CheckResult[] };
  'health.get': { params: void; result: HealthReport };
  /** Re-enables a host disabled after a challenge page. Only the user does this, from the Data health page (R7). */
  'net.unblock': { params: { host: string }; result: { ok: true } };
  'secrets.test': { params: { name: SecretName }; result: { ok: boolean; message: string } };
  'engine.runNow': { params: void; result: { evaluated: number; ms: number } };

  // ----- main process -----
  'app.info': { params: void; result: AppInfo };
  /**
   * The current 'service.state' (null while idle or stopping). A page that loads after the
   * push was sent (a reload after a renderer crash, a first open from the tray) asks for it.
   */
  'app.serviceState': { params: void; result: PushContract['service.state'] | null };
  /**
   * F16: whether each global hotkey is registered right now (main registers a changed one before it
   * saves it, and the stored ones at start-up). Settings shows it beside the hotkey fields.
   */
  'app.hotkeys': { params: void; result: HotkeysStatus };
  /**
   * F19: the item the user just opened on scrap.tf (the Live market's scrap.tf button, the drawer, the item
   * menu), so the next check hotkey or watcher copy of a bare price is checked as it (`check.text` hint).
   * Main keeps it in memory for CHECK_ARM_MS and replaces any earlier one; null disarms. `armedUntil` is
   * when it lapses (null: disarmed). Never logged or stored; nothing is fetched.
   */
  'check.arm': { params: CheckArm | null; result: { armedUntil: UnixMs | null } };
  /**
   * With a SKU, main pushes 'ui.quickPrefill' to the quick-entry window once it has loaded. `price`
   * (F16, the check popup's Quick entry…) is text for its price field, at most CHECK_PRICE_TEXT_MAX
   * characters, and is passed on only with a SKU.
   */
  'app.showQuickEntry': { params: { sku?: string; price?: string } | void; result: { ok: true } };
  'app.hideWindow': { params: void; result: { ok: true } };
  /** Shows the dashboard and asks it to open an item (push 'ui.openItem'); used by the quick-entry window. */
  'app.openItem': { params: { sku: string }; result: { ok: true } };
  'settings.get': { params: void; result: Settings };
  'settings.set': { params: DeepPartial<Settings>; result: Settings };
  'secrets.status': { params: void; result: SecretsStatus };
  /** value null deletes the secret. */
  'secrets.set': { params: { name: SecretName; value: string | null }; result: SecretsStatus };
  /** Opens an https URL in the default browser after checking the host allowlist. */
  'links.open': { params: { url: string }; result: { opened: boolean; reason: string | null } };
  /** Shows an open-file dialog, reads the chosen saved page and forwards it to 'import.html'. */
  'import.pickFile': { params: void; result: ImportResult | null };
  'import.pickWatchFolder': { params: void; result: { folder: string | null } };
  /** Shows a save dialog and writes text: CSV export, or JSON when suggestedName ends in .json. */
  'file.saveText': { params: { suggestedName: string; text: string }; result: { saved: boolean; path: string | null } };
}

export type RpcMethod = keyof RpcContract;
export type RpcParams<M extends RpcMethod> = RpcContract[M]['params'];
export type RpcResult<M extends RpcMethod> = RpcContract[M]['result'];

/** Methods implemented by the Electron main process; all others go to the service. */
export const MAIN_METHODS: readonly RpcMethod[] = [
  'app.info',
  'app.serviceState',
  'app.hotkeys',
  'check.arm',
  'app.showQuickEntry',
  'app.hideWindow',
  'app.openItem',
  'settings.get',
  'settings.set',
  'secrets.status',
  'secrets.set',
  'links.open',
  'import.pickFile',
  'import.pickWatchFolder',
  'file.saveText',
];

export const SERVICE_METHODS: readonly RpcMethod[] = [
  'status.get',
  'opps.list',
  'opps.events',
  'opps.exportCsv',
  'shopping.list',
  'market.list',
  'holdings.list',
  'item.detail',
  'buyer.check',
  'item.refresh',
  'item.search',
  'item.resolve',
  'links.forSku',
  'item.scm',
  'prices.list',
  'prices.upsert',
  'prices.delete',
  'prices.parseBulk',
  'prices.bulkUpsert',
  'prices.exportCsv',
  'rules.list',
  'rules.upsert',
  'rules.delete',
  'rules.preview',
  'rules.exportJson',
  'rules.importJson',
  'journal.list',
  'journal.add',
  'journal.delete',
  'journal.summary',
  'journal.exportCsv',
  'import.html',
  'import.batches',
  'scraptf.listStatus',
  'scraptf.banks',
  'scraptf.bankStock',
  'scraptf.itemHistory',
  'scraptf.changes',
  'check.text',
  'check.recent',
  'health.get',
  'net.unblock',
  'secrets.test',
  'engine.runNow',
];

/** Events pushed from the service (through main) to the dashboard. */
export interface PushContract {
  'opps.changed': { appeared: number; changed: number; gone: number; at: number };
  /** The live market index changed (throttled to one per 2 s): `changed` rows of `total`. */
  'market.changed': { changed: number; total: number; at: number };
  'status.changed': AppStatus;
  'import.done': ImportResult;
  /** The price sheet (scrap.tf prices or rules) changed, from any window or an import. */
  'prices.changed': { at: number };
  /** The trade journal changed ('journal.add', 'journal.delete'): the Journal and Holdings pages refresh. */
  'journal.changed': { at: number };
  /** F14: rows of the saved scrap.tf/items list were written (an import) or purged; `items` is the new row count. */
  'scraptf.listChanged': { at: number; items: number };
  /**
   * F15: something 'scraptf.banks' reads changed (an import, a price or list write, the market); at most one
   * per 2 s. From F17 also after a bank import or a bank stock prune: the bank stock page refetches on it.
   */
  'scraptf.banksChanged': { at: number };
  /**
   * F20: an import wrote `count` scrap.tf change events (scraptf_events), saved at `at`. The change feed
   * and an open drawer's history refetch on it. Not sent for an import that wrote none.
   */
  'scraptf.changed': { at: UnixMs; count: number };
  /**
   * Service asks main to show a desktop notification. `sku` opens that item on a click. F20: `openUrl`
   * (re-save reminders) is a static scrap.tf bank page: main opens it in the user's browser on a click
   * only if isAllowedExternalUrl accepts it and it is one of the SCRAPTF_BANKS URLs, checked again at
   * click time; anything else is ignored (the click then just shows the dashboard).
   */
  'notify': { title: string; body: string; sku: string | null; openUrl?: string };
  'settings.changed': Settings;
  /** Main asks the dashboard to open an item (notification click, quick entry). */
  'ui.openItem': { sku: string };
  /**
   * Main asks the quick-entry window to pick this item and focus the price ('app.showQuickEntry' with a SKU).
   * `price` (F16) is text for the price field (e.g. "1 key 5.33 ref"); quick entry fills it when given.
   */
  'ui.quickPrefill': { sku: string; price?: string };
  /** F16: the service added an item result (status 'item') to the recent-checks ring. */
  'check.done': CheckResult;
  /**
   * F16, main only: show this result in the check popup (window kind 'check'). Held by the preload until
   * the popup page subscribes, like 'ui.quickPrefill'; the latest one wins.
   */
  'ui.checkShow': CheckResult;
  /**
   * State of the background service process, sent by main. `nextAttemptAt` (Unix ms) is when a
   * restarting service is tried again: an absolute time, so the banner can count down without
   * another push.
   */
  'service.state': { state: 'starting' | 'ready' | 'restarting' | 'stopped'; detail: string | null; nextAttemptAt: number | null };
}

export type PushEvent = keyof PushContract;

export const PUSH_EVENTS: readonly PushEvent[] = [
  'opps.changed',
  'market.changed',
  'status.changed',
  'import.done',
  'prices.changed',
  'journal.changed',
  'scraptf.listChanged',
  'scraptf.banksChanged',
  'scraptf.changed',
  'check.done',
  'notify',
  'settings.changed',
  'ui.openItem',
  'ui.quickPrefill',
  'ui.checkShow',
  'service.state',
];

/** API exposed on window.flipdesk by the preload script. */
export interface FlipdeskBridge {
  rpc<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>;
  /** Returns an unsubscribe function. */
  on<E extends PushEvent>(event: E, listener: (payload: PushContract[E]) => void): () => void;
  /** 'dashboard', 'quick-entry' or 'check' (the live check popup, F16). */
  windowKind: string;
}

// ----- main <-> service wire protocol (MessagePort / parentPort) -----

export type ToService =
  | { type: 'init'; dataDir: string; version: string; settings: Settings; secrets: Partial<Record<SecretName, string>> }
  | { type: 'rpc'; id: number; method: RpcMethod; params: unknown }
  | { type: 'settings'; settings: Settings }
  | { type: 'secrets'; secrets: Partial<Record<SecretName, string>> }
  | { type: 'shutdown' };

export type FromService =
  | { type: 'ready' }
  | { type: 'rpc-result'; id: number; ok: true; result: unknown }
  | { type: 'rpc-result'; id: number; ok: false; error: string }
  | { type: 'push'; event: PushEvent; payload: unknown }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string };
