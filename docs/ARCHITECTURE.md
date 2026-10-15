# TF2 Flip Desk: architecture

`docs/DESIGN_BRIEF.md` is the verified research and design brief. This file covers how the code is organised and the conventions every module follows. Where they disagree, this file wins; the deviations are listed at the end.

## Non-negotiable rules

| Rule | What it means |
|---|---|
| R1 | Nothing in this app sends a request to `scrap.tf` or any subdomain. That includes tests, fixtures and tooling. |
| R2 | No HTML fetching from backpack.tf, marketplace.tf, stntrading.eu, mannco.store or steamcommunity.com. Only documented JSON APIs and websockets, reached through `src/service/net`. |
| R3 | No userscripts, extensions or page injection. There is no embedded scrap.tf browser. |
| R4 | No automated buying, selling, trading, listing, bumping or accepting. The app is read-only toward every platform. |
| R5 | No proxy support and no multi-account features. |
| R6 | Honest User-Agent: `TF2FlipDesk/<version> (+<contact>)`. Never a browser UA. |
| R7 | Budgets below published limits. Honour 429 and `Retry-After`. Stop on challenge pages. |
| R8 | Secrets are encrypted at rest (main process, `safeStorage`), redacted from every log, and sent only to the host that issued them. |
| R9 | No Steam passwords, cookies, `shared_secret` or `identity_secret` handling. |
| R10 | scrap.tf data comes only from the user: typed entries, price-sheet rules, or pages the user saved themselves. Import is opt-in after an explicit acknowledgement. |

## Processes

```
Electron main (src/main)          windows, tray, notifications, global hotkey, app:// protocol,
  │                               settings.json (validated), secrets (safeStorage), links.open allowlist,
  │                               file dialogs; forwards RPC to the service
  ├── renderer (src/renderer)     React dashboard + quick-entry window. No network. Talks only via
  │                               window.flipdesk (preload, contextBridge)
  └── utilityProcess (src/service) all connectors, rate limits, SQLite (node:sqlite), opportunity engine,
                                   saved-page import + folder watch
```

Wire protocol and the RPC method list: `src/shared/rpc.ts`. Domain types: `src/shared/types.ts`. Service-internal interfaces: `src/service/contracts.ts`.

## Source layout and ownership

| Path | Owner / contents |
|---|---|
| `src/shared/types.ts`, `rpc.ts`, `sku.ts`, `currency.ts`, `defaults.ts` | foundation; change only through integration |
| `src/shared/links.ts`, `categories.ts` | link generator (rebuild of scrap.tf-item-information), category classifier |
| `src/shared/ceiling.ts` | profit status and the "pay up to" ceiling, shared by the engine, the dashboard and the mock so all three classify alike |
| `src/shared/referenceAge.ts` | the reference age gate's community floor (`communityMaxAgeMs`), shared the same way so the drawer marks a reference "ignored" exactly when the engine drops it |
| `src/shared/market.ts` | Live market rules (verdict, profit, filters, search words, comparator, paging, CSV cells), shared by the market index, the dashboard and the mock so counts, order and pages match |
| `src/shared/holdings.ts` | Holdings rules (status, profit figures, row, comparator, search, totals, CSV cells), shared by the holdings service, the dashboard and the mock the same way |
| `src/shared/settingsSchema.ts` | zod schema for `Settings` (owned by main) |
| `src/service/net/*` | `policy.ts`, `budgets.ts`, `http.ts`, `redact.ts`, `ratelimit.ts`, `errors.ts` |
| `src/service/db/*` | `openRepo(path)` implementing `Repo` with `node:sqlite` |
| `src/service/connectors/schema.ts`, `schemaNames.ts` | `createSchemaService` (sku.pricedb.io), names and resolver |
| `src/service/connectors/pricedb.ts`, `steamMarket.ts` | PriceDB REST and socket; optional SCM priceoverview |
| `src/service/connectors/bptfSocket.ts`, `bptfApi.ts`, `bptfItem.ts` | backpack.tf websocket, snapshot/IGetPrices/IGetCurrencies, item → SKU mapping |
| `src/service/domain/*` | matcher, pricing, confidence, key price, engine, views (list/group/detail), shopping list, Live market index (`market.ts`), journal, holdings (`holdings.ts`), CSV |
| `src/service/priceSheetIo.ts`, `buyerCheck.ts`, `rpcSchemas.ts` | bulk paste and backups (pure); `buyer.check` lookups; zod schemas shared by more than one handler |
| `src/service/import/*` | saved scrap.tf page parser (parse5, no script execution), folder watcher |
| `src/service/core.ts`, `scheduler.ts`, `rpcHandlers.ts`, `entry.ts`, `logger.ts` | wiring and periodic jobs (integration) |
| `src/main/*` | Electron main, preload, windows, tray, settings store, secrets, service host |
| `src/renderer/*` | dashboard UI; `api.ts` uses `window.flipdesk` or, in a plain browser, `mock.ts`. Page logic lives in pure, unit-tested `*Model.ts` files |
| `test/<area>/*.test.ts`, `test/fixtures/<area>/*` | vitest tests and fixtures per area |

## Agreed module entry points

These are the names that `src/service/core.ts` imports. Keep the exact names.

```ts
// net
createHttpClient(opts: { clock: Clock; log: Logger; sink: RequestLogSink; userAgent: () => string;
                         budgets?: BudgetSpec[]; fetchImpl?: typeof fetch }): HttpClient
checkUrl(url: string, kind?: 'http' | 'ws'): { allowed: boolean; reason: string }
assertAllowed(url: string, kind?: 'http' | 'ws'): void            // throws ForbiddenHostError
redactUrl(url: string, secretKeys?: string[]): string
buildUserAgent(version: string, contactUrl: string): string
BUDGETS: BudgetSpec[]
// db
openRepo(path: string): Repo                                         // ':memory:' supported
// schema / prices
createSchemaService(deps: ServiceDeps): SchemaService
createPriceDb(deps: ServiceDeps): PriceDb
createSteamMarket(deps: ServiceDeps): SteamMarket
// backpack.tf
createBptfSocket(deps: ServiceDeps & { schema: SchemaService; onBatch(b: FeedBatch): void;
                 wsFactory?: (url: string, headers: Record<string, string>) => WebSocketLike }): BptfSocket
createBptfApi(deps: ServiceDeps & { schema: SchemaService }): BptfApi
// domain
createEngine(deps: ServiceDeps & { schema: SchemaService; events: EngineEvents }): Engine
selectKeyPrice(quotes: KeyPriceQuote[], settings: Settings, now: UnixMs): KeyPriceState
listOpportunities(repo: Repo, q: OppQuery, keyPrice: KeyPriceState, now: UnixMs): OppListResult
buildItemDetail(args: { repo; schema; sku; keyPrice; settings; now; snapshot: {...} }): ItemDetail | null
journalSummary(entries: JournalEntry[]): JournalSummary
opportunitiesCsv(rows, keyScrap), eventsCsv(events), journalCsv(entries)
// import
parseScrapTfHtml(html: string, schema: SchemaService): { pageKind: ImportPageKind; items: ParsedScrapItem[]; warnings: string[] }
createFolderWatcher(opts: { folder: string; log: Logger; onFile(path: string, html: string, mtimeMs: number): void }): { stop(): void; alive(): boolean; lastError(): string | null }
// shared
buildLinks(ctx: LinkContext): LinkSpec[]
isAllowedExternalUrl(url: string): boolean
categorize(obj: SkuObject, item: { itemClass: string; slot: string | null; craftClass: string | null; itemName?: string } | null): Category
```

v0.2 additions (imported by `rpcHandlers.ts`, the engine and the dashboard):

```ts
// shared/ceiling.ts
maxCostFor(revenueScrap: Scrap | null, p: Pick<ProfitSettings, 'minProfitScrap' | 'minProfitPctOfCost' | 'minMargin' | 'frictionScrap'>): Scrap | null
profitStatus(profitScrap, costScrap, p): OpportunityStatus;  minProfitFor(costScrap, p): Scrap
// service/domain
buildShoppingList(rows: readonly Opportunity[], q: ShoppingQuery, keyPrice, now): ShoppingListResult
shoppingCsv(rows: readonly ShoppingRow[], keyScrap): string
itemRevenue(prices, eligibleCount, settings): ItemRevenue        // views.ts, same pick as the engine
usableReferences(refs, maxAgeMs, now): { references; stale }      // pricing.ts, the F4 age gate
// service
parseBulkPrices(text, bareUnit, resolve): { rows; rejected; refusal }   // priceSheetIo.ts
pricesCsv(prices, keyScrap), rulesToJson(rules), rulesFromJson(json): { rules; skipped }
createBuyerChecker(deps): { check(steamid): Promise<BuyerCheck> }       // never rejects; errors go in `error`
// renderer
useItemMenu(): { open(target: ItemMenuTarget, at: { x: number; y: number }): void; element: ReactNode }
```

v0.2 Live market (F10) additions:

```ts
// service/domain/market.ts
createMarketIndex(deps: ServiceDeps & { schema; keyPrice(): KeyPriceState; onChanged(p: { changed; total; at }): void; folderWatchActive(): boolean; timers?: TimerApi }): MarketIndex
  // MarketIndex: start(); stop(); markDirty(bases); markAllDirty(); pricesChanged(); list(q, now); all(q, now); stats()
evaluateMarketBase(a: { base; listings; references; isUnusual; settings; keyScrap; now; match }): MarketEval | null  // null = no eligible order
marketCsv(rows: readonly MarketRow[], keyScrap: Scrap | null): string
// service/domain/engine.ts, exported so the index reads a book exactly as an opportunity row does
priceBook(listings, target, references, p, keyScrap, now, match): { eligible; prices }
bookFlags(book, confFlags, revenueScrap, keyScrap); buyerCountOf(eligible); cleanTarget(base); validRule(rule)
// shared/market.ts
marketVerdict, marketProfit, marketUpdatedAt, marketPage, marketSearchTokens, marketRowMatches, marketComparator, marketCsvCells
```

v0.3 Holdings (F11), Record trade (F12), hardening (H1-H4) and the saved-page strip (F13):

```ts
// service/domain/holdings.ts
createHoldings(deps: ServiceDeps & { schema; market: MarketIndex; keyPrice(): KeyPriceState; notify(n: PushContract['notify']): void; timers?: TimerApi }): Holdings
  // Holdings: list(q, now); all(q, now); onBasesChanged(bases); journalChanged(); settingsChanged(); heldBases(); start(); stop()
holdingsCsv(rows: readonly HoldingRow[], keyScrap: Scrap | null): string; holdingNotification(row, keyScrap): PushContract['notify']
// service/domain/market.ts
MarketIndex.entryFor(base): Readonly<MarketEval> | null          // paint dropped; MarketEval gains bestOrder
MarketIndexDeps.onBasesChanged?(bases: ReadonlySet<string>)      // the bases behind one market.changed
MARKET_RETRY_MIN_MS = 30_000, MARKET_RETRY_MAX_MS = 600_000      // H1 backoff
// service/domain/journal.ts
JournalPosition.lots: { id; ts; costScrap; keys; scrap; keyPriceScrap }[]   // open FIFO lots, oldest first; id = the buy row
// shared/holdings.ts
holdingStatusOf, holdingFigures, holdingRow(pos, category, buy, p, keyScrap?), lotCostAt, holdingComparator, holdingsMatching, holdingsTotals, holdingsResult, holdingsCsvCells, HOLDINGS_CSV_COLUMNS
// shared/market.ts
MARKET_MAX_LIMIT = 2000; scraptfCoverage(batches, categoriesOf), batchSavedAt, bankPageIndexOf, cleanCategoryCounts, countCategories
ImportBatch.categories?: CategoryCounts | null                  // items per category, fixed at import time (schema V3)
// renderer
useRecordTrade(): { open(init: RecordTradeInit): void; element: ReactNode }
toast(text, tone?, opts?: { action?: { label: string; onClick(): void }; timeoutMs?: number }): number   // useApp(); also dismissToast(id), holdToast(id, why, on)
```

## Integration (src/service/core.ts and friends)

```ts
createLogger({ dataDir, post? }): ServiceLogger          // <dataDir>/../logs/service.log, 5 MB x 2, every line redacted
createServiceCore({ dataDir, version, settings, secrets, log, fetchImpl?, wsFactory?, socketFactory?, clock?, timers? })
  -> { start(); stop(); handle(method, params); updateSettings(s); updateSecrets(s); onPush(cb) }
createScheduler({ clock, timers, log, isPaused }) + buildJobs(ctx)   // fixed cadences, no overlap, skipped while paused/blocked
createRpcHandlers(ctx)                                    // every SERVICE_METHODS entry, zod-validated params
importSavedPage(ctx, { html, fileName, mtimeMs })         // shared by 'import.html' and the folder watcher
```

- The database is `<dataDir>/flipdesk.sqlite`. A database from a newer app version (SchemaVersionError) leaves the
  service running in a failed state where every RPC answers with that message, instead of crash-looping.
- Feed batches: names, deletes and listings in one transaction; sell listings are kept only for watched base SKUs
  (SKUs with a scrap.tf price or an open journal lot, see Holdings) unless `liveFeed.keepSellListings` is 'all';
  affected base SKUs are marked dirty.
- Opportunity events are appended to `<dataDir>/../logs/opportunities-YYYY-MM-DD.jsonl` (local date) after each
  engine change, oldest first from repo meta `oppLog.lastEventId` (the position across restarts). Files older than
  the 90-day event retention, and the oldest ones while all of them exceed 512 MB, are removed once a day.
- Snapshots: user refreshes run at once (user priority); the background job takes at most one watched SKU per
  minute, and only when the snapshot budget has a free slot; a SKU whose snapshot fails waits 30 min, doubling up
  to a day. A fresh snapshot reconciles the stored order book; listings the feed updated or deleted after the
  snapshot was taken keep the feed's version. A snapshot served from the 10-min cache changes nothing.
- The folder watch is reported as an error when fs.watch fails and is retried about once a minute. A file the
  service died importing (repo meta `import.watchImporting`) is skipped once at the next start.
- Generic "any effect" unusual buy orders (`<defindex>;5` without `u`) are eligible exits for every effect of
  that item, flagged `any-effect`.
- Main pushes `service.state` (starting/ready/restarting/stopped), `ui.openItem` (notification click, or the
  quick-entry window's `app.openItem`) and `ui.quickPrefill` (`app.showQuickEntry` with a SKU; held until the
  quick-entry page has loaded, and by the preload until it subscribes). The service pushes `opps.changed`, `status.changed`, `import.done`, `prices.changed` (any price or rule write, so
  every window's price sheet refreshes), `market.changed` (the Live market index, see below), `journal.changed`
  (`journal.add` and `journal.delete`, see Holdings) and `notify`.
- Only `ui.openItem` is queued across a dashboard (re)load; other pushes reach loaded pages only. `service.state` is sent
  once per change, so a page that loads later (a reload after a renderer crash, a first open from the tray during a
  restart wait) asks main for it with `app.serviceState` on mount. While the service is not ready, the dashboard shows
  the restart banner and its countdown even when `status.get` times out.
- `npx electron . --smoke-test=<report.json> [--smoke-wait=<s>]`: with a wait, the app runs live for that long and
  fails unless the feed is live with listings, the schema loaded and a key price arrived. Packaged builds ignore
  `--dev`, `--smoke-test` and `--smoke-wait` unless `FLIPDESK_DIAGNOSTICS=1` is set.
- One copy per machine: besides Electron's per-userData lock, main holds the named pipe
  `\\.\pipe\io.github.tf2flipdesk.app.instance`, so another `--user-data-dir` or Windows account cannot open a
  second backpack.tf feed from the same IP (a smoke test then fails with that reason).
- `file.saveText` writes CSV exports as .csv/.txt and a JSON backup (suggested name ending in .json, e.g. the rules
  export) as .json/.txt; no other file type, whatever the caller suggests or the user picks.
- Main drops service pushes it owns (`settings.changed`, `ui.openItem`, `ui.quickPrefill`, `service.state`) and any `status.changed`
  that fails its shape check. The service runs with main's environment minus proxy variables (R5); if Node's
  env-proxy support is on anyway, the service keeps the network paused.
- A service that exits unexpectedly 5 times within an hour is restarted at most every 15 min. Request budgets are
  restored at service start from the request log plus the saved start of the last slow-budget request
  (`net.lastSent.<budget>` meta, written before sending), so restarts never reset them. The IGetCurrencies and
  IGetPrices jobs also keep the previous process's cadence (the last backpack.tf key quote, `bptf.pricesFetchedAt`).
- Schema V2 adds `opportunities.max_cost_scrap`, the row's "pay up to" ceiling: `maxCostFor(revenueScrap, settings.profit)`,
  the highest integer cost that is still 'profitable'. Rows from 0.1 read NULL until the engine's start-up sweep
  rewrites them. The engine fingerprint covers all of `settings.profit`, so any threshold change recomputes every ceiling.
- Schema V3 adds `import_batches.categories` (JSON, items per category): `importSavedPage` counts the base SKUs it
  stores, classified as the Live market files them (`marketCategoryOf`), so the F13 strip knows which bank page a batch
  was after a later import re-tags its rows. Batches from 0.2 read null.
- `shopping.list` and `opps.exportCsv {kind:'shopping'}` are built from the stored opportunities: one row per SKU with a
  ceiling above 0 and buyers; when a SKU has several inputs, the one with the highest confidence wins. The known cost is
  that row's own when it is typed or imported, else the newest typed/imported one, and `underCeiling` compares it only
  with its own row's ceiling (`knownMaxCostScrap`): painted, spelled and plain copies share a SKU. The scrap.tf bank-page
  URLs are only passed to `links.open` (the user's browser), never fetched (R1).
- `item.detail {history:false}` skips the PriceDB history request, so quick entry's live preview is local only.
  `ItemDetail.revenue` uses the engine's pricing over the same book (including generic any-effect orders), with the same
  reference gate, so the drawer, quick entry and the opportunity row agree. The drawer classifies the book against the
  newest stored copy's extras; quick entry asks with `target:'plain'`, a clean copy of the SKU (paint from the SKU
  only), because that is the row its `prices.upsert` creates. Prices are stored under the base SKU with the paint in
  their extras, so a painted SKU's `scrapPrices` are the base SKU's rows of that paint (plus rows stored under the
  painted SKU itself); a plain SKU still lists every copy stored under it.
- Reference age (`profit.referenceMaxAgeMs`, default 30 days): a PriceDB price whose `ageMs` is older, or a community price
  whose `lastUpdate` is older than max(that, 365 days), counts as absent for the outlier rule and for confidence, and the row
  is flagged `stale-reference`. Community prices are hand-set and stay right for months, hence the one-year floor.
  Suspect margin (`profit.suspectMargin`, default 2, 0 = off): a margin above it with fewer than 3 eligible orders and no
  usable reference is flagged `suspect-margin`, capped at Low (44) and never notified.
- Notifications skip input kinds missing from `notifications.inputKinds`. Rule candidates are titled `Candidate: <name>`,
  others `Profit: <name>`, and the body adds the ceiling when there is one. Main's `notify.ts` checks and clips the payload and passes `notifications.silent`.
- `buyer.check` runs only on a click. It sends one users/info request on the `bptf-users` budget at user priority: it waits at
  most 15 s for a slot and then times out after 12 s, inside main's 30 s RPC timeout. It needs the access token and the
  backpack.tf API switch, and it refuses while the network is paused or the host is blocked. Successful answers are cached
  in memory for 1 h (at most 500), and served even while paused. Failures are not cached.
- `prices.parseBulk` writes and fetches nothing. A paste containing `<` or `scrap.tf/` is refused as a whole, so it cannot
  route around the opt-in saved-page import (R10). So is a paste over 500 lines or 100 KB, and any item line before the
  schema has loaded (the error says it is still loading). A row carries a `sku` only when it can be saved: fuzzy names, incomplete SKUs and zero prices are
  errors. A repeated item stays saveable, and the dashboard keeps the last line. `prices.bulkUpsert` writes at most 500 rows
  as whole typed prices (source 'user') in one transaction, with one `prices.changed` push.
- Backups: in `prices.exportCsv` the `sku` column includes the paint and `cost` uses the `parsePrice` format, so those two
  columns paste back. `rules.exportJson` writes `{ format: 'tf2-flip-desk-rules', version: 1, exportedAt, rules }`.
  `rules.importJson` validates each rule with `ruleInputSchema`. It skips rules that are already stored or repeated (same
  name, filter and price), each with a reason. It never deletes, and it caps a future `observedAt` at now.
- Server waits survive restarts too (R7): budget pauses and 429 streaks are repo meta `net.pauses`, and the
  websockets' waits after a refused upgrade (with their 429 streaks) are `bptf.feedRetry` and `pricedb.socketRetry`.
  socket.io hides the PriceDB upgrade's headers, so a 429/503 there backs off 60 s doubling to 15 min, and 1 h after
  three 429s in a row. A restored wait is clamped to 24 h and the
  clamped value is written back, so frequent restarts cannot stretch it. Challenge or refusal stops of the
  websockets (`ws.backpack.tf`, `ws.pricedb.io`) are host blocks in `net.blockedHosts`, cleared only by the user.

## Live market index (F10, `src/service/domain/market.ts`)

The Live market page lists every base SKU with at least one eligible backpack.tf buy order, plus every base SKU the user
has a scrap.tf price for, and compares the two sides live. It adds **no network traffic**: it reads the local book that
the backpack.tf websocket (and snapshots) already fill. The scrap.tf side is only what R10 allows: typed prices, rules and
saved pages. Nothing here fetches or polls scrap.tf (R1).

- **Entries.** One in-memory entry per base SKU with an eligible order, valued as an opportunity on a clean copy
  (`evaluateMarketBase`): `priceBook` (dedupe, classify, value, outliers), `itemRevenue`, `maxCostFor`, `bookFlags`. An
  effect-specific unusual also reads the generic `<defindex>;5` book, as the engine does. Buy-side confidence is
  `scoreConfidence` with a fresh typed input and `margin: null`, so input age and the suspect-margin guard play no part
  (a free item would otherwise read as an unbounded margin and be capped at Low). An entry is dropped when its last
  eligible order goes. An effect SKU bought only through the generic book has no buy orders of its own to enumerate, so
  it is listed only while the user has a price for it (the engine has the same limit).
- **Dirty batches.** Core calls `market.markDirty` wherever it calls `engine.markDirty` for a book or reference change
  (feed batches, the snapshot reconcile, the PriceDB socket, the `pricedb-watched` job, `refreshPricedb`). Marks are
  evaluated together at most every 2 s, read with `repo.buyListingsByBaseSkus` in chunks. A dirty generic book also
  re-evaluates every effect base that has buy orders of its own (eligible or not, so an effect only marketplace.tf
  buys appears as soon as a generic order does, as a rebuild would list it) and every effect price that reads it.
  Over 20,000 pending marks turn into a full rebuild.
- **Full rebuilds** run once the schema has loaded at start (a schema that loads later is noticed and rebuilds), on
  `markAllDirty` and every 10 min, because order age changes eligibility and flags. `markAllDirty` comes from a key price
  move of 1 scrap or more, a change to `settings.profit` (which holds `notesKeywords`) or `settings.blocklist`, and the
  `pricedb-all`, `bptf-prices`, `maintenance` and schema jobs. Several calls coalesce into one rebuild, and a call during
  a rebuild restarts it. Candidates are `repo.baseSkusWithBuyOrders()`, the known-price bases and the current entries.
  The rebuild works in chunks of 100 to 2,000 bases that adapt toward 40 ms of synchronous work, yielding to the event
  loop (`setTimeout(0)`) between chunks; the candidate scan gets a slice of its own. The chunk size is only an upper
  bound: every slice (rebuild or dirty batch) also stops once it has used 40 ms and leaves the rest to the next one, so
  a batch far costlier per base than the last (a generic book's fan-out to its effects) cannot stretch a slice. Entries already shown stay until the
  rebuild reaches them, and during the first build known-only rows appear only once the build has reached their base,
  so they never flash "no buyers". At 50k bases a build takes about 1.2 s in about 30 slices.
- **Memory.** Roughly one entry and one order summary per base, plus a cached name order and per-base rule estimates:
  about 30-50 MB at 50k bases. Nothing is persisted; a restart rebuilds from the stored book.
- **The user's side** is joined when rows are read, never stored in entries. A known-price map (base SKU to the newest
  typed and the newest saved-page price by `observedAt`, ties to the higher id; the newer of the two wins) is rebuilt on
  `pricesChanged()`, which `ctx.pricesChanged` calls on every price and rule write, import and folder-watch import.
  Price writes never mark the book dirty or fire `market.changed`; the page refetches on `prices.changed`. Stock comes
  only from saved pages, and a chosen price with paint or spells adds the `has-extras` flag (the ceiling is for a clean
  copy). The rule estimate is the cheapest enabled valid rule that matches (`ruleMatches`, `validRule`), cached per
  base. The cache is dropped only when the rule list or the key price really changed (not by `markAllDirty`); an
  estimate also remembers the name and category it matched, so a renamed or recategorised item is matched again alone.
- **Reads.** `list()` filters and sorts the in-memory entries with the shared helpers in `src/shared/market.ts`, so the
  service, the dashboard and the mock agree on verdicts, counts, order and paging. Verdict counts ignore the query's own
  verdict filter (each chip shows what it would add). Sorting uses a cached name order instead of `localeCompare` per
  comparison and gives exactly `marketComparator`'s order. About 25-40 ms for 50k entries (`test/domain/marketPerf.test.ts`);
  the first read after a build fills the caches (about 100 ms, once). The last filtered and sorted pass is kept, keyed
  by the query without paging, the key value and `settings.profit`, and dropped by anything it read changing (an entry
  written, the known prices, the rules, names, the first build's progress), so a window refresh and the Load more
  after it cost one pass. `all()` is the same without paging, for CSV.
- **RPC.** `market.list` (`MarketQuery`, zod: search up to 200 characters, limit 1-2000 (`MARKET_MAX_LIMIT`) with
  default 200, offset 0 or more) returns `MarketListResult`: rows, total, verdict counts, the scrap.tf side's counts
  (`typed`, `pages`, `newestPageAt`, `importEnabled`, `watchFolder`: the folder watch as it runs, from core's watcher,
  so a missing folder or a failed OS watch reads off, and `coverage`, below), `stats()` and the key price. `opps.exportCsv {kind:'market', market}` drops paging and writes
  `flipdesk-market-YYYY-MM-DD.csv`.
- **Push.** `market.changed {changed, total, at}` at most every 2 s, and only when an entry was added or removed or
  changed its revenue, ceiling, buyer count or revenue order id. Main forwards it like `opps.changed` (it is in
  `PUSH_EVENTS`, so the service host and the preload allow it). The page refetches its loaded window (at most 2,000
  rows) in ONE `market.list` call (H2): one read comes from one state of the index, so a row moving during a refresh
  can be neither missed nor shown twice, as it could between the 500-row chunks of 0.2. It is throttled to 2 s
  and runs only while the window is visible; Freeze counts the pushes instead and catches up when released. Freeze holds
  the window itself (`createMarketWindow().hold`), so a refresh already queued or in flight is not shown either, and
  Load more (button and infinite scroll) is off until it is released. Load more re-reads the grown window from the
  top and appends the rows not shown yet, so a row that rose across the window's edge is never skipped. A minimum
  Pay up to typed in keys stays in keys in the window's query and is converted per request, so a key price move
  refreshes the window in place instead of starting a new query.
- **Failures and pause.** Work that runs from a timer logs a failed read and skips that chunk instead of crashing the
  service. While the network is paused the feed stops by itself and the index keeps serving its last state.
- **Rebuild failure (H1).** When a rebuild's candidate scan throws (a local database read), `stats()` reports
  `building: false`, `lastError` (the message, clipped to 300 characters) and `retryAt`. The rebuild is retried after
  `MARKET_RETRY_MIN_MS` (30 s), doubling per failure up to `MARKET_RETRY_MAX_MS` (10 min); the 10-min periodic
  rebuild waits meanwhile and is re-armed by the next successful build. A successful scan clears both fields and the
  backoff; `markAllDirty` retries at once; `stop()` drops a pending retry and the next `start()` tries again. The
  page shows `Could not read the local database (<lastError>). Retrying in N s.` (not "Building 0 %"), keeps the
  last good rows, and polls the index every 5 s while a retry is pending.
- **Saved-page coverage (F13).** `MarketListResult.scraptf.coverage` has one `ScraptfCoverage` per scrap.tf bank page,
  in `SCRAPTF_BANK_PAGES` order (Hats, Weapons, Stranges, Killstreaks, Skins, Items, Unusuals; links.ts). A page's
  `lastSavedAt` is the newest import batch (of the last 500, `repo.listImportBatches`) whose stored items fall at least
  half into that page's categories, at the batch's file time when known, else its import time; `items` is that
  batch's item count. Batches of kind 'items-list' count for no page. A batch is classified from the categories it
  stored when imported (`ImportBatch.categories`), because a later import rewrites the rows it shares in place under
  its own batch id (an /items list takes over a bank page's plain rows). Only a batch from 0.2, without them, is
  classified from the rows carrying its id today (that map is collected while the known prices are rebuilt). The
  result is cached: recomputed only after `pricesChanged()` or when categories may change (a schema reload,
  `markAllDirty`), never per `list()`, and skipped when no saved-page item is stored. A failed batch read is logged
  once per failure streak and not cached: that `list()` returns the last good strip (all "never saved" before the
  first), and the next one reads again. The page's strip is a row of chips (green up to 15 min, amber up to 2 h,
  else muted), hidden while import is off; a click passes the page URL to `links.open` (the user's browser). Nothing
  fetches it (R1).
- **Hooks for Holdings.** `entryFor(base)` returns a base's entry (paint dropped) or null. `MarketEval.bestOrder` is
  the best eligible order (the same object as `revenueOrder` when they are one listing). The optional
  `onBasesChanged(bases)` dependency receives exactly the bases `put()` counted for one `market.changed` (same change
  test, same 2 s throttle), inside a try/catch; core wires it to `holdings.onBasesChanged`.

## Holdings (F11, `src/service/domain/holdings.ts`)

What the user still holds, priced live against backpack.tf buyers, plus "Sell:" notifications. It adds **no network
traffic and no request kind**: revenue comes from the local book through the Live market's own evaluation, and held
SKUs only join the existing, budgeted watch list. Nothing here sells, lists or offers anything (R4); the user records
a sale in the journal.

- **Source of truth.** The journal's open FIFO lots: `journalSummary(repo.listJournal()).open`, whose
  `JournalPosition.lots` (oldest first, id and time of the buy row, cost at its buy-time key price, and the keys,
  metal and key price as recorded) is new in 0.3 and additive. The positions are cached until `journalChanged()`; a failed journal read is logged, not cached, and lists
  nothing.
- **Pricing.** Each position is read for its base SKU (paint dropped; a painted row gets the `has-extras` flag, the
  value is for a clean copy). The buy side is `market.entryFor(base)`, else `evaluateMarketBase` on demand with one
  `repo.buyListingsByBaseSkus` read (own book plus the generic any-effect book) and the stored references, exactly as
  the index evaluates a base. Before the index's first build, or after an H1 failure, every held base without an entry
  is evaluated this way; once a build has finished, only an effect-specific unusual without an entry is (the index
  lists an effect bought only through the generic book only when the user has priced it). Currency lots (keys, metal)
  are rows with no buy side. A SKU that cannot be read prices nothing and takes no other row down.
- **Figures** (`holdingFigures` / `holdingRow` in `src/shared/holdings.ts`, shared with the mock and the dashboard):
  each lot's cost is its own keys and metal valued at today's key price (`lotCostAt`, the K the revenue is valued at;
  the buy-time cost without a key price). The journal nets a sale against its buy per currency and values the
  difference at the sale's key price, so this is exactly what it will book, and a key price move alone never reads
  as profit, a loss or a "Sell:" (the Record sale dialog compares with the same next-lot cost).
  `profitNowScrap = revenue - next lot cost - friction`, `profitAllScrap = revenue x qty - total cost - friction x qty`,
  `margin = profitNow / next lot cost`. The status is `profitStatus(profitNow, next lot cost, settings.profit)` mapped to
  `sell` (profitable), `hold` (below threshold), `loss` or `no-buyers` (no eligible order). Rows sort by status in
  that order, then profit now descending, then name. Totals cover everything held whatever the search; worth now and
  the unrealised P/L (the sum of `profitAllScrap`) count only rows with a revenue; `sellable` counts `sell` rows.
- **RPC.** `holdings.list` (`HoldingsQuery`, zod: search up to 200 characters, optional) returns `HoldingsResult`
  (`rows`, `totals`, `keyPrice`, `generatedAt`). `opps.exportCsv {kind:'holdings', holdings}` writes
  `flipdesk-holdings-YYYY-MM-DD.csv` with the columns sku, name, qty, cost, next_lot_cost, held_since, sells_for,
  buyer, profit_now, profit_all, status, confidence (money as "1 key 2.00 ref").
- **Trigger path.** The market index's `fireChanged` hands the changed bases to `holdings.onBasesChanged`, which keeps
  only held bases (and the generic book of a held effect). `ctx.journalChanged` (after `journal.add` and
  `journal.delete`) calls `journalChanged()`; `core.updateSettings` calls `settingsChanged()` when `settings.profit`,
  `blocklist` or `notifications` changed, and `keyQuotesChanged` does on a key move of 1 scrap or more. Triggers are
  coalesced into one check `HOLDINGS_CHECK_MS` (250 ms) later; the timer runs only between `start()` and `stop()`
  (core calls them after the market index's), and a failed check is logged, never thrown.
- **Notifications.** A check notifies a held SKU that entered `sell`, or whose `profitNowScrap` rose by
  `CHANGE_PROFIT_DELTA` (9 scrap) or more since its last notification while still in `sell`: title `Sell: <name>`,
  body `<buyer> pays <revenue> (<bot|human>), +<profitNow> over your cost`, `sku` set so a click opens the item. Gates:
  `notifications.enabled`, the new `notifications.holdings` (boolean, default true; Settings > Notifications has the
  switch), and `notifications.minConfidence` (an item that entered `sell` below it stays pending, so more buyers
  later still notify it once). Main applies `notifications.silent`. Dedupe is per SKU for `notifications.dedupMs`,
  saved in repo meta `holdings.lastNotified` and expired by age like the engine's `engine.lastNotified`, so a restart
  does not notify again. At most `MAX_NOTIFICATIONS_PER_RUN` (3) per check, then one summary ("N more held items to
  sell", `sku: null`). The sell state is tracked while notifications are off, so switching them on replays nothing.
- **Watched set.** `core.watchedSet()` is the base SKUs with a scrap.tf price plus `holdings.heldBases()` (open lots,
  currencies excluded; it never throws), cached and reset by `prices.changed` and `journal.changed`. Everything that
  reads the list keeps doing what it did, now also for held SKUs: the feed keeps their sell listings, the background
  snapshot job (`bptf-snapshot` budget, at most one watched SKU per minute when the budget has a free slot) keeps
  their book fresh, and the `pricedb-watched` job (bulk, 100 per request, every 30 min) includes them. Same endpoints,
  same budgets, no new request kind. If the journal cannot be read while the list is built, it is built without
  the held SKUs until the next price or journal change.
- **Push.** `journal.changed {at}` after `journal.add` and `journal.delete`. It is in `PUSH_EVENTS`, so the service host
  and the preload forward it like `prices.changed`. The Journal and Holdings pages refetch on it (300 ms throttle,
  only while visible). Holdings also refetches on `market.changed` and `prices.changed` (2 s throttle, only while
  visible) and when `settings.profit` or the blocklist changes.

## Dashboard additions in 0.3

- **Holdings page** (`pages/HoldingsPage.tsx`, pure helpers in `holdingsModel.ts`): nav entry after Shopping list.
  Header totals, search, Export CSV, a row per held SKU (Item, Qty, Your cost, Held for, Sells now for, Buyers, Profit
  now with a status pill, Confidence, Updated) and a *Record sale…* button. A click opens the drawer, right-click or
  `Shift+F10` the ItemMenu; `j`/`k` and the arrows move, `Enter` opens, `s` records a sale, `b` opens the buyer's
  backpack.tf profile through `links.open`. Rows whose profit now changed flash briefly (reduced-motion aware).
- **Record trade** (F12, `components/RecordTradeDialog.tsx`, pure helpers in `recordTradeModel.ts`). `useRecordTrade()`
  is used like `useItemMenu()`: render `element` once, call `open(init)` from any entry point. A modal dialog
  (labelled fields, focus trap, Esc, `Ctrl+Enter` saves once, focus returns to the opener; portalled into the item
  drawer when opened from it) with side, venue (suggestions), price (`PriceInput`: keys plus metal), date/time and
  note. As the user types it compares: a buy against the item's Pay up to and profit (`item.detail {history:false,
  target:'plain'}`, local only), a sale against the next FIFO lot (`holdings.list`). Save calls `journal.add`; the
  confirmation toast's Undo calls `journal.delete`. While focus is outside the dialog (a toast's Undo or Dismiss took it
  and the toast went, leaving it on `<body>`), a capture-phase document listener still gives Esc (closes the dialog,
  never the drawer behind it), `Ctrl+Enter` (saves) and Tab (back into the dialog); focus landing anywhere behind it
  but the toasts is moved back to the price. Entry points: the drawer (*Record buy*: venue scrap.tf and the newest
  scrap.tf price for that very copy, `priceIsForSku`: the SKU's paint, or no extras at all for a plain SKU, else no
  price; *Record sale*: venue backpack.tf, the revenue order's price and `Sold to <buyer>`; *Record sale to this
  buyer* on each buy order), the ItemMenu (*Record buy…*, *Record sale…*, prefilled from `item.detail
  {history:false}`), and Holdings rows. Quick entry's **Bought it** (after a successful Save) is a single click instead:
  one `journal.add` buy on scrap.tf at the saved price (paint kept), with Undo in the toast. The card re-reads the saved
  row by id on `opps.changed` and `prices.changed` (an edit in the drawer or on the Prices page keeps the id), and Bought
  it reads it once more before writing; a row deleted since keeps the last known price.
- **Toast actions** (H3, `toastModel.ts`). `toast(text, tone?, opts?)` takes an optional action and timeout and
  returns the toast id; existing calls are unchanged. An action toast stays 12 s (`TOAST_ACTION_MS`; `timeoutMs`
  overrides, capped at 120 s), pauses while hovered or focused and resumes with at least 1.5 s left; its button runs
  the action and dismisses it. At most 4 show, and a new toast evicts the oldest one without an action first. Block
  buyer's Undo and every recorded trade's Undo use it; the in-drawer undo bar is gone. The drawer's focus trap
  includes the toast buttons, so a keyboard user can Tab to an Undo while the drawer is open. A toast removed while
  it holds focus hands it to the open modal on top (`topmostModalIn`: the Record trade dialog, else the drawer).
  The Journal page refreshes only on `journal.changed`, its own writes included, so each write reads the journal once.
- **ItemMenu** (H4, `components/ItemMenu.tsx`, `itemMenuModel.ts`). It closes only on a user scroll: a wheel or
  touchmove outside it, a scroll key pressed outside it (not in a text field, not with Ctrl/Alt/Meta), or a scroll
  that moves its anchor (the row under the opening point, or the opener) by more than 4 px or removes it. A
  programmatic scroll (the market's scroll anchoring, a smooth scroll) does not close it. It opens below the pointer
  when it fits, else upward with its bottom edge at the pointer (or at the row's or button's top, `MenuPoint.upY`),
  else on the roomier side with a scrollbar, and is clamped to the viewport.

## Conventions

- TypeScript strict, ESM `import` without file extensions, named exports only.
- All money is integer scrap; keys are separate numbers (see `src/shared/currency.ts`).
- Timestamps: `UnixMs` for our own times, `UnixSec` where backpack.tf or PriceDB use seconds. The name says which.
- Every external payload is validated with zod (`.passthrough()` / loose objects) and unknown shapes are counted, not thrown.
- Tests use vitest, live in `test/<area>/`, and never hit the network. Fixtures captured from real APIs go in `test/fixtures/<area>/` with secrets and other users' trade URLs removed.
- A test file that asserts wall-clock bounds goes in `TIMED` in `vitest.config.ts`. Those files run as a second group
  (`timed`) after the rest of the suite, so a saturated CPU does not decide their results.
- Comments are short and explain why, not what.

## Deviations from the design brief

1. Saved-page import is available once the user ticks an explicit acknowledgement in Settings, which states that scrap.tf's ToS lists "external tools". Recording written permission is optional rather than required, because the import never contacts scrap.tf and the risk decision belongs to the user. It stays off by default.
2. Folder watch (auto-import of pages the user saves into one folder) is part of that same opt-in.
3. No embedded scrap.tf browser in any form (brief option D).
4. The dashboard can run in a plain browser against mock data (`npm run dev:renderer`), for UI development only.
5. The live feed's default daily data cap is 25 GB, not the brief's 12 GB (§2.1, Appendix A). The cap counts decompressed websocket payload bytes, measured at about 13 GB on a busy day (far less on the wire with permessage-deflate), so a 12 GB default would pause the feed most evenings. Users on capped or metered connections can lower it in Settings > Live feed.
6. `pauseOnMetered` (Appendix A) is not implemented in v1: the app does not detect metered Windows connections. The daily cap and the Pause-network switch are the controls.
7. Opportunity thresholds are global in v1, as in the brief's Appendix A config: one minimum profit (`profit.minProfitScrap`, `minProfitPctOfCost`), one minimum margin (`profit.minMargin`) and one set of notification thresholds (`notifications.minConfidence`, `minProfitScrap`, `dedupMs`) apply to every category. §5.6's "all configurable per category" is not implemented. Per-category overrides would be merged in `evaluateOpportunity` by the opportunity's category and included in the engine fingerprint (through `settings.profit`).
