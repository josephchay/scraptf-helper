// RPC contract between the dashboard (renderer), the Electron main process and
// the background service (utilityProcess).
//
//   renderer --window.flipdesk.rpc(method, params)--> main
//   main handles MAIN_METHODS itself and forwards everything else to the service
//   service --push(event, payload)--> main --> renderer (and tray/notifications)

import type {
  AppStatus,
  BulkPriceRow,
  BuyerCheck,
  DeepPartial,
  EventQuery,
  HealthReport,
  ImportBatch,
  ImportResult,
  ItemDetail,
  ItemSuggestion,
  JournalEntry,
  JournalInput,
  JournalSummary,
  LinkSpec,
  OppListResult,
  OppQuery,
  OpportunityEvent,
  PriceRule,
  PriceRuleInput,
  ResolvedItem,
  ScrapPrice,
  ScrapPriceInput,
  SecretName,
  SecretsStatus,
  Settings,
  ShoppingListResult,
  ShoppingQuery,
} from './types';

export interface AppInfo {
  version: string;
  dataDir: string;
  logDir: string;
  platform: string;
  electron: string;
  node: string;
}

export interface RpcContract {
  // ----- service -----
  'status.get': { params: void; result: AppStatus };
  'opps.list': { params: OppQuery; result: OppListResult };
  'opps.events': { params: EventQuery; result: OpportunityEvent[] };
  /**
   * `query` filters and sorts the opportunities export like 'opps.list' (paging ignored); omitted, every row.
   * kind 'shopping' exports the shopping list filtered by `shopping` (paging ignored).
   */
  'opps.exportCsv': {
    params: { kind: 'opportunities' | 'events' | 'shopping'; query?: OppQuery; shopping?: ShoppingQuery };
    result: { csv: string; suggestedName: string };
  };
  /** One row per SKU with a "pay up to" ceiling, to browse scrap.tf against by hand. */
  'shopping.list': { params: ShoppingQuery; result: ShoppingListResult };
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
  /** With a SKU, main pushes 'ui.quickPrefill' to the quick-entry window once it has loaded. */
  'app.showQuickEntry': { params: { sku?: string } | void; result: { ok: true } };
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
  'health.get',
  'net.unblock',
  'secrets.test',
  'engine.runNow',
];

/** Events pushed from the service (through main) to the dashboard. */
export interface PushContract {
  'opps.changed': { appeared: number; changed: number; gone: number; at: number };
  'status.changed': AppStatus;
  'import.done': ImportResult;
  /** The price sheet (scrap.tf prices or rules) changed, from any window or an import. */
  'prices.changed': { at: number };
  /** Service asks main to show a desktop notification. */
  'notify': { title: string; body: string; sku: string | null };
  'settings.changed': Settings;
  /** Main asks the dashboard to open an item (notification click, quick entry). */
  'ui.openItem': { sku: string };
  /** Main asks the quick-entry window to pick this item and focus the price ('app.showQuickEntry' with a SKU). */
  'ui.quickPrefill': { sku: string };
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
  'status.changed',
  'import.done',
  'prices.changed',
  'notify',
  'settings.changed',
  'ui.openItem',
  'ui.quickPrefill',
  'service.state',
];

/** API exposed on window.flipdesk by the preload script. */
export interface FlipdeskBridge {
  rpc<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>;
  /** Returns an unsubscribe function. */
  on<E extends PushEvent>(event: E, listener: (payload: PushContract[E]) => void): () => void;
  /** 'dashboard' or 'quick-entry' */
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
