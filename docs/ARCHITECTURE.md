# TF2 Flip Desk: architecture

`docs/DESIGN_BRIEF.md` is the verified research and design brief. This file covers how the code is organised and the conventions every module follows. Where they disagree, this file wins; the deviations are listed at the end.

## Non-negotiable rules

| Rule | What it means |
|---|---|
| R1 | Nothing in this app sends a request of its own to `scrap.tf` or any subdomain: no HTTP client request, fetch, `/ajax`, `ws.scrap.tf` socket or download, no polling, no auto-refresh, and no load, reload or history step from a timer, an event or a promise callback. That includes tests, fixtures and tooling, and `src/service/net/policy.ts` refuses every scrap.tf host. From 0.7 (F21) the one place scrap.tf is shown is the opt-in scrap.tf window (`src/main/scraptfWindow.ts`), which the **user** browses: Chromium loads only a static start page the user opened (`SCRAPTF_WINDOW_START_URLS`), a toolbar move the user clicked (back, forward, reload, home, a bank chip, Log out & clear), from 0.7.1 the same back, forward, reload and home from the user's own keys in the page and the mouse's back and forward buttons (`before-input-event` and `app-command`, which Chromium and Windows raise for real input only), or the user's own clicks in the page, plus what those pages load themselves. |
| R2 | No HTML fetching from backpack.tf, marketplace.tf, stntrading.eu, mannco.store or steamcommunity.com. Only documented JSON APIs and websockets, reached through `src/service/net`. |
| R3 | No userscripts, extensions or page injection: nothing of the app's runs in another site's page except F21's `READ_SCRIPT`, and the app never clicks, types, scrolls, sends input events or writes the DOM there. The one embedded browser is F21's opt-in scrap.tf window, whose view has no preload and runs exactly that one pinned, read-only script (`document.documentElement.outerHTML`) in isolated world 1001, only on `https://scrap.tf` pages the import reads (from 0.7.1 `scraptfImportablePath`: the bank pages, the unusual pages and scrap.tf/items, not the front page, raffles or settings), only on a document that has stopped loading, after each such page load or in-page navigation in the window (the user's browsing, and what the page's own scripts do, such as a reload or a `replaceState`, which the app cannot tell apart; with the 30 s per-page gap, the one settle read and the dedupe) or on the user's Read page now. A read is a local snapshot and sends nothing. Steam's sign-in and Cloudflare's challenge frame are never read; a check or error page served at a scrap.tf address (HTTP 403, 429 or 503), and Chromium's error page after a failed load, is not read when it loads, only on Read page now, and imports nothing. It never solves or skips a challenge, never calls `setUserAgent` and never touches cookies (`session.cookies`, `document.cookie`). |
| R4 | No automated buying, selling, trading, listing, bumping or accepting. The app is read-only toward every platform. |
| R5 | No proxy support and no multi-account features. |
| R6 | Honest User-Agent: `TF2FlipDesk/<version> (+<contact>)`. Never a browser UA. The F21 scrap.tf window is a browser the user drives and keeps Electron's default user agent, which names the app and Electron: nothing in `src/` calls `setUserAgent` or rewrites the window's request headers. |
| R7 | Budgets below published limits. Honour 429 and `Retry-After`. Stop on challenge pages. |
| R8 | Secrets are encrypted at rest (main process, `safeStorage`), redacted from every log, and sent only to the host that issued them. |
| R9 | No Steam passwords, cookies, `shared_secret` or `identity_secret` handling. In the F21 scrap.tf window the user signs in on Steam's own page; the session lives in Chromium's own partition (in memory unless the user chose to stay signed in), and the app never reads, exports or reuses it. |
| R10 | scrap.tf data comes only from the user: typed entries, price-sheet rules, pages the user saved themselves (scrap.tf/items included, F14; kept as snapshots so two saves of a bank can be compared, F17; as `.html` or `.mhtml`, F18: a saved file is untrusted input, and nothing inside it, a part, a URL or a Content-Location, is ever fetched, opened or followed), or text the user copied and asked to check (Live check, F16: plain clipboard text read locally by main, never stored or sent; from F19 a price copied on its own is checked as the item the user just opened on scrap.tf from the app, whose page the app only handed to the user's browser). From F21, also the DOM of a scrap.tf page the user opened in the opt-in scrap.tf window, read by `READ_SCRIPT` and fed to the same saved-page import with the page's address as a hint and `origin: 'window'` (only main sets either). Import is opt-in after an explicit acknowledgement; so is the clipboard watcher, and the scrap.tf window needs import plus its own acknowledgement. The app never reads the user's own browser (no DOM, history or windows). |

## Processes

```
Electron main (src/main)          windows, tray, notifications, global hotkeys (quick entry, live check),
  │                               the clipboard (readText only, live check), app:// protocol,
  │                               settings.json (validated), secrets (safeStorage), links.open allowlist,
  │                               file dialogs, the opt-in scrap.tf window (F21); forwards RPC to the service
  ├── renderer (src/renderer)     React dashboard, quick-entry window, live check popup and the scrap.tf
  │                               window's toolbar. No network. Talks only via window.flipdesk (preload,
  │                               contextBridge)
  ├── scrap.tf view (F21)         a WebContentsView the user browses scrap.tf in: no preload, sandboxed, its
  │                               own partition; main reads its DOM with READ_SCRIPT only
  └── utilityProcess (src/service) all connectors, rate limits, SQLite (node:sqlite), opportunity engine,
                                   saved-page import + folder watch
```

Wire protocol and the RPC method list: `src/shared/rpc.ts`. Domain types: `src/shared/types.ts`. Service-internal interfaces: `src/service/contracts.ts`.

## Source layout and ownership

| Path | Owner / contents |
|---|---|
| `src/shared/types.ts`, `rpc.ts`, `sku.ts`, `currency.ts`, `defaults.ts` | foundation; change only through integration |
| `src/shared/links.ts`, `categories.ts` | link generator (rebuild of scrap.tf-item-information), category classifier; `SCRAPTF_BANKS`, the one list of scrap.tf bank ids, labels and URLs (F15); `scraptfLinkFor`, the page a Live market row links to (F19) |
| `src/shared/ceiling.ts` | profit status and the "pay up to" ceiling, shared by the engine, the dashboard and the mock so all three classify alike |
| `src/shared/referenceAge.ts` | the reference age gate's community floor (`communityMaxAgeMs`), shared the same way so the drawer marks a reference "ignored" exactly when the engine drops it |
| `src/shared/market.ts` | Live market rules (verdict, profit, filters, search words, comparator, paging, CSV cells), shared by the market index, the dashboard and the mock so counts, order and pages match |
| `src/shared/holdings.ts` | Holdings rules (status, profit figures, row, comparator, search, totals, CSV cells), shared by the holdings service, the dashboard and the mock the same way |
| `src/shared/scraptfList.ts` | scrap.tf price list rules (F14): valuing a saved list row, full, fresh, the key row, a held item's better exit, the market and holdings list fields, shared the same way |
| `src/shared/banks.ts` | scrap.tf banks rules (F15): flips per bank and what to look for there (`bankFlips`, `bankLookFor`), shared by the banks summary, the dashboard and the mock the same way |
| `src/shared/bankStock.ts` | scrap.tf bank stock rules (F17): the extras key, on sale, the diff of two saves, rows, verdict, filters, counts, order, paging, "What's new", the market's New join, the drawer's line, the notification texts and CSV cells, shared by the bank stock cache, the dashboard and the mock the same way |
| `src/shared/scraptfHistory.ts` | scrap.tf history rules (F20): a save's change events, valuing an event now with the live buy side, the runs index ("listed since"), one item's history, the feed's limits and CSV cells, and the re-save reminder's banks, timing and texts, shared by the service, the dashboard and the mock the same way |
| `src/shared/check.ts` | Live check (F16) limits, fixed user-facing texts (refusals, reasons, item notes, the privacy sentence, `CHECK_HOTKEY_CONFLICT`), `checkTextRefusal`, `checkPriceIsOtherCopy`, `blankCheckResult` and F19's `checkHintPriceOf` (a price copied on its own); zod-free, shared by main, the service, the dashboard and the mock so all of them refuse and word things alike |
| `src/shared/itemUrl.ts` | the item links the app reads (marketplace.tf and PriceDB item pages, backpack.tf stats pages): hosts, path shapes and next.backpack.tf's query keys, shared by the schema resolver (`parseItemUrl`) and main's clipboard filter, which lets exactly these links through |
| `src/shared/settingsSchema.ts` | zod schema for `Settings` (owned by main) |
| `src/shared/importCodes.ts`, `scraptfPaths.ts`, `boundaryText.ts` | 0.7.1: the import's warning and refusal codes, fixed messages, skip reasons, partial-read thresholds and report limits (`importWarningCode`); `scraptfImportablePath`, the scrap.tf pages the import reads (parity with `pageKindFromUrl`, tested); the one boundary sentence (`SCRAPTF_BOUNDARY_SHORT`, `scraptfDataSourcesText`) every dashboard text uses |
| `src/shared/scraptfWindowPolicy.ts` | F21's rules for the opt-in scrap.tf window, pure and zod-free: which URLs it starts on, keeps, sends to the browser or blocks (top level and frames), which pages it reads, the pinned `READ_SCRIPT` and its forbidden tokens, the read timings, the fixed texts and the settings gate; shared by main, the settings schema, the service, the mock and the tests |
| `src/service/net/*` | `policy.ts`, `budgets.ts`, `http.ts`, `redact.ts`, `ratelimit.ts`, `errors.ts` |
| `src/service/db/*` | `openRepo(path)` implementing `Repo` with `node:sqlite` |
| `src/service/connectors/schema.ts`, `schemaNames.ts` | `createSchemaService` (sku.pricedb.io), names and resolver |
| `src/service/connectors/pricedb.ts`, `steamMarket.ts` | PriceDB REST and socket; optional SCM priceoverview |
| `src/service/connectors/bptfSocket.ts`, `bptfApi.ts`, `bptfItem.ts` | backpack.tf websocket, snapshot/IGetPrices/IGetCurrencies, item → SKU mapping |
| `src/service/domain/*` | matcher, pricing, confidence, key price, engine, views (list/group/detail), shopping list, Live market index (`market.ts`), journal, holdings (`holdings.ts`), the saved scrap.tf list cache (`scraptfList.ts`), the per-bank summary (`banks.ts`, F15), the live check parser and evaluation (`liveCheck.ts`), the bank stock cache and its notifications (`bankStock.ts`, F17), the scrap.tf history index and change feed (`scraptfHistory.ts`, F20) and the re-save reminders (`resaveReminders.ts`, F20), CSV |
| `src/service/priceSheetIo.ts`, `buyerCheck.ts`, `rpcSchemas.ts` | bulk paste and backups (pure); `buyer.check` lookups; zod schemas shared by more than one handler |
| `src/service/import/*` | saved scrap.tf page parser (`scraptfHtml.ts`, parse5, no script execution), the MHTML extractor (`mhtml.ts`, F18, pure), the one entry for both file types (`savedPage.ts`), folder watcher; from 0.7.1 the in-memory ring of sanitized parser reports behind `'import.report'` (`reports.ts`, P4, never persisted) |
| `src/service/core.ts`, `scheduler.ts`, `rpcHandlers.ts`, `entry.ts`, `logger.ts` | wiring and periodic jobs (integration) |
| `src/main/*` | Electron main, preload, windows, tray, settings store, secrets, service host; the live check's controller (`liveCheck.ts`, with F19's `check.arm`), clipboard filter and watcher (`clipboardWatch.ts`) and global hotkey registration (`hotkeys.ts`); the opt-in scrap.tf window (`scraptfWindow.ts`, F21), the only module that may show scrap.tf, and from 0.7.1 its remembered size and place (`windowBounds.ts`, F21-12); diagnostics only, the window's hermetic test (`smokeWindow.ts`, loaded by main's gated `--smoke-window` branch alone, and its pure local router `smokeWindowFixtures.ts`) |
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
parseScrapTfHtml(html: string, schema: SchemaService, opts?: ParseOptions): ScrapTfParseResult   // { pageKind; bank; page; items; warnings }; opts.address from 0.6 (F18)
parseSavedPage(text: string, fileName: string, schema: SchemaService): SavedPageParse          // F18: .html or .mhtml, + format
createFolderWatcher(opts: { folder: string; log: Logger; onFile(path: string, html: string, mtimeMs: number): void; onSkip?(path, reason: 'too-large', detail, mtimeMs): void }): { stop(): void; alive(): boolean; lastError(): string | null }
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

v0.4 scrap.tf price list (F14):

```ts
// shared/links.ts
SCRAPTF_ITEMS_URL = 'https://scrap.tf/items'                      // in STATIC_EXTERNAL_URLS, exact URL only; only ever passed to links.open
// shared/scraptfList.ts
SCRAPTF_LIST_FRESH_MS (24 h), SCRAPTF_LIST_LABEL ('All items'), scraptfListFull(stock, limit), valueScraptfListRow(stored, K),
scraptfListFresh(row, now), scraptfListKeyOf(stored), bestExitOf(revenue, list, now), scraptfListCoverage(summary),
marketListFields(row), holdingListFields(row), marketListSideMatches(row, q),
SCRAPTF_LIST_PRICE_NOTE, scraptfListUsePrice(row) (null: sold out or stock 0), scraptfListPriceSaved(row, prices)
// service/domain/scraptfList.ts
createScraptfListCache(deps: { repo: Pick<Repo, 'scraptfList'>; log: Logger; keyPrice(): KeyPriceState }): ScraptfListCache
  // refresh(); keyPriceChanged(); rowFor(sku, keyScrap?); has(sku); all(keyScrap?); summary(); keyRow(); version(); onChanged(cb)
// service/domain/keyprice.ts
selectKeyPrice(quotes, settings, now, listKey: ScraptfListKey | null = null): KeyPriceState   // + scraptfFromList
effectiveScraptfKey(settings, listKey?): { paysScrap; sellsScrap; source: 'settings' | 'list' | null }
EngineDeps.scraptfKey?(): ScraptfListKey | null                  // core: scraptfList.keyRow()
// service/domain/market.ts, holdings.ts
MarketIndexDeps.scraptfList?: Pick<ScraptfListCache, 'rowFor' | 'has' | 'summary' | 'version'>
HoldingsDeps.scraptfList?: Pick<ScraptfListCache, 'rowFor'>; holdingNotification(row, keyScrap, now?); listAgeText(at, now)
// shared/holdings.ts
holdingRow(pos, category, buy, p, keyScrap?, scraptf?: { list: ScraptfListRow | null; now: UnixMs } | null)
HoldingRow.scraptfPaysKeys / scraptfPaysScrapRaw                 // the pays price as listed, for Record sale
// service/domain/views.ts
ItemDetail.scraptfListSaved: boolean                             // "Use as my price" already saved (base SKU's plain rows)
// service/import
sellsPriceOf(item: ParsedScrapItem): { keys; scrap } | null       // the price to buy; null for "Sold out"
// renderer
ScraptfListCard({ placement: 'market' | 'import'; boundaryNote? }); openOnScraptf(url, name, toast)   // components/ItemMenu.tsx
useScraptfExitLapse(rows, reload)                                // pages/HoldingsPage.tsx; holdingsModel: scraptfExitLapsed, scraptfExitLapseAt
scraptfKeyHealthRows(list, typed), scraptfKeyTipText(list, typed, now)   // settingsFields.ts: Data health, the key tip
```

v0.5 scrap.tf banks (F15, below):

```ts
// shared/types.ts
ScraptfBank = 'hats' | 'weapons' | 'stranges' | 'killstreaks' | 'skins' | 'items' | 'unusuals' | 'list'; SCRAPTF_BANK_IDS
ImportBatch.bank: ScraptfBank | null; ScrapPrice.bank?: ScraptfBank | null (joined on read); ImportResult.bank?
ItemDetail.seenOn: ScraptfSeenOn | null                           // { bank, url, at }
ScraptfBankSummary, ScraptfBankFlip, ScraptfBankLookFor, ScraptfBanksResult
// shared/links.ts (the only source of bank ids, labels and URLs; the allowlist is unchanged)
SCRAPTF_BANKS: { bank; label; url; categories }[]; SCRAPTF_BANK_PAGES (derived, gains `bank`)
isScraptfBank(v); scraptfBankInfo(bank) (null for anything else, '__proto__' included); bankForCategory(c); scraptfSeenOn(prices)
// shared/banks.ts
BANK_TOP_FLIPS = 3, BANK_LOOK_FOR = 5; bankFlips(rows, bankOf); bankLookFor(rows, categories); NO_BANK_FLIPS
// shared/market.ts
batchBankOf(batch, categoriesOf); scraptfBankSaves(batches, categoriesOf): { bankOf; newest }; CoverageBatch, BankSave
// service
PageHint.bank, ScrapTfParseResult.bank                            // import/scraptfHtml.ts (pageKindFromUrl and the body-id fallback)
NewImportBatch = Omit<ImportBatch, 'id' | 'bank'> & { bank? }; Repo.createImportBatch(b: NewImportBatch)   // contracts.ts
createBanksSummary(deps: { clock; log; repo; market: Pick<MarketIndex, 'uncheckedBy'>; scraptfList; settings(); folderWatch(); categoryOf?; timers? }): BanksSummary
  // BanksSummary: summary(now); invalidate(what?: 'all' | 'flips' | 'market' | 'switches'); onChanged(cb); stop()
BANKS_PUSH_MS = 2_000; emptyBankSummary(info); opportunityBank(o, priceBank)                    // domain/banks.ts
MarketIndex.uncheckedBy(groupOf, top, now): Map<K, UncheckedGroup>; COVERAGE_BATCHES = 500      // domain/market.ts
itemSeenOn(prices, baseRows)                                      // domain/views.ts
// rpc.ts
'scraptf.banks' (service) -> ScraptfBanksResult; push 'scraptf.banksChanged' { at }
// renderer
BanksPage(), BanksView(props)                                     // pages/BanksPage.tsx
bankCards, banksHeadline, bankFreshness, bankSavedText, bankFlipsText, bankLookForText, seenOnText, importBankText,
bankGridMove, gridColumns, banksPath, banksRouteBank, createBanksLoader, BANKS_REFRESH_MS   // banksModel.ts
marketBankPath(bank), marketRouteIntent(segments), coverageBank(chip)                     // marketModel.ts
seenBankPageUrl(seenOn), bankPageUrl(seenOn, category), scraptfOpenUrl(category, links, seenOn?)   // itemMenuModel.ts
ItemMenuTarget.bank?; useScraptfListStatus(), useWatchFolderPicker(), copyFolderPath(), SetupNoteView   // ItemMenu, ScraptfListCard
```

v0.5 Live check (F16, below):

```ts
// shared/check.ts (zod-free)
CHECK_MAX_CHARS = 400, CHECK_MAX_LINES = 3, CHECK_RECENT_MAX = 30, CHECK_WATCH_INTERVAL_MS = 700, CHECK_POPUP_MIN_GAP_MS = 1_500,
CHECK_POPUP_HIDE_MS = 10_000, CHECK_NOTIFY_DEDUP_MS = 60_000, CHECK_PRICE_TEXT_MAX = 60
CHECK_PRIVACY_SENTENCE, CHECK_HINT, CHECK_SAMPLE_TEXT, CHECK_REFUSALS (incl. `link`), CHECK_NOT_ITEM_REASON, CHECK_SCRAPTF_LINK_REASON,
CHECK_SCHEMA_LOADING_REASON, CHECK_SOLD_OUT_NOTE, CHECK_FUZZY_NOTE, CHECK_INCOMPLETE_NOTE, CHECK_EXTRAS_NOTE, CHECK_HOTKEY_CONFLICT
checkLineCount(text); checkTextRefusal(text): string | null; blankCheckResult(status, reason, source, checkedAt, id = 0, keyScrap = null)
checkPriceIsOtherCopy(result): boolean                           // reason carries CHECK_EXTRAS_NOTE: no flip notification, no Bought it
// shared/itemUrl.ts
itemUrlParts(u: URL): ItemUrlParts | null; itemUrlHost(u); NEXT_STATS_PARAMS   // parseItemUrl and main's filter share these
// shared/accelerator.ts
sameAccelerator(a, b): boolean                                    // canonical chords; '' never matches
// service
parsePriceLine(line, bareUnit, resolve, spare?): PriceLine | null     // priceSheetIo.ts; parseBulkPrices uses it
parseCheckText(text, resolve, opts?: { confirmFuzzy?(itemText, item): boolean }): ParseCheckResult   // domain/liveCheck.ts, pure
createLiveCheck(deps: { repo; schema; log; settings(); keyPrice(); market: Pick<MarketIndex, 'entryFor'>; scraptfList: Pick<ScraptfListCache, 'rowFor'> }): LiveCheck
  // LiveCheck: check(text, source, now): CheckResult; recent(): CheckResult[]
chooseCheckPrice({ parsed, list, stored, keyScrap, now, plain? }); checkVerdict(profitScrap, price, settings); newestStoredPrice(prices, plain); storedPriceHasExtras(p)
copiedSoldOut(parsed); looselySameName(text, name); CHECK_MAX_RESOLVES = 8
// main
createLiveCheckMain(deps: { readText; check; serviceReady; showPopup; notify; settings; systemPaused; log; now?; timers?; watchIntervalMs? }): LiveCheckMain
  // LiveCheckMain: hotkey(); syncWatch(); watching(); stop()
isCheckResult(value); flipNotification(result); CHECK_CALL_TIMEOUT_MS, CHECK_HOTKEY_MIN_GAP_MS, CHECK_HOTKEY_FOCUS_MS     // liveCheck.ts
shouldCheckClipboardText(text, lastHash): { ok; hash; reason }; looksLikeSecret(text); clipboardTextHash(text); clipboardSkipMessage(reason)   // reason 'secret' | 'link' | …
createClipboardWatch({ readText, onText, isPaused, intervalMs?, timers?, onError? }): { start(); stop(); running(); markChecked(text) }
createSystemPause(powerMonitor): { paused(); dispose() }                                         // clipboardWatch.ts
applyGlobalHotkey(globalShortcut, next, prev, onTrigger): HotkeyResult; startupHotkeyNotice(quick, check)   // hotkeys.ts
SettingsEffects.applyCheckHotkey?(next, prev); SettingsStore.checkHotkeyStatus()                // settingsStore.ts
WindowManager.showCheck(result, { focus }); hideCheck(); checkWindow(); checkPopupPosition(area, w, h, margin = 16)   // windows.ts
CHECK_URL = 'app://app/index.html#/check'; WindowKind 'check'; HELD_EVENTS (preload) has 'ui.checkShow'
CHECK_TEXT_SOURCE_REFUSAL                                         // ipc.ts: a page's check.text must be source 'manual'
TrayState.checkWatch, checkHotkey; TrayActions.setClipboardWatch(on)
// rpc.ts
'check.text', 'check.recent' (service); 'app.hotkeys' (main) -> HotkeysStatus { quickEntry: HotkeyState; check: HotkeyState }
push 'check.done' (service, every window); push 'ui.checkShow' (main only); 'ui.quickPrefill' { sku; price? }
// renderer
CheckPopup(), CheckVerdictPill({ result })                       // pages/CheckPopup.tsx, helpers in checkModel.ts
RecentChecks()                                                    // pages/MarketPage.tsx
CheckSection({ s })                                               // pages/SettingsPage.tsx
validateCheckHotkey, validateQuickEntryHotkey, checkHotkeyStatus(hotkey, lastSave, held?), quickHotkeyProblem(hotkey, held)   // settingsFields.ts
prefillPriceText(price)                                           // quickModel.ts
mockParseCheck, mockCheckResult, mockCheckDemo, checkDemoFromHash // mockCheck.ts
```

v0.6 scrap.tf bank stock (F17, below):

```ts
// shared/types.ts
BankStockChange = 'new' | 'cheaper' | 'pricier' | 'gone' | null; BANK_STOCK_CHANGES; BankStockVerdict = 'flip' | 'over' | 'no-buyers'
BankStockFilter ('all' | 'new' | 'flips' | 'changed' | 'gone'), BANK_STOCK_FILTERS; BankStockSort ('profit' | 'margin' | 'cost' | 'name' | 'payUpTo'), BANK_STOCK_SORTS
BankStockStored, BankStockSave (+ page), BankStockRow (+ key), BankStockQuery, BankStockCounts, BankStockResult (+ pages?, oldestSavedAt?)
ItemBankStock { bank; savedAt; change; previousCostScrap; stock }; ItemDetail.bankStock: ItemBankStock | null
ScraptfBankWhatsNew { new; newFlips; gone; cheaper; pricier; since }; ScraptfBankSummary.whatsNew: ScraptfBankWhatsNew | null
MarketRow.scraptfNewAt: UnixMs | null; MarketQuery.newOnScraptf?: boolean; Settings.notifications.newOnScraptf (default true)
// shared/bankStock.ts (pure; the service, the dashboard and the mock)
BANK_STOCK_KEEP_SAVES = 10 (per page, saves the diff reads; retention is F20's thinning), BANK_STOCK_MAX_PAGES = 50, BANK_STOCK_MAX_AGE_MS = 90 d (F20), BANK_STOCK_DEFAULT_LIMIT = 200, BANK_STOCK_MAX_LIMIT = 2000, BANK_STOCK_MAX_SEARCH_CHARS = 200,
BANK_STOCK_PLAIN_KEY = '', BANK_STOCK_NOTIFY_DEDUP_MS = 30 min, BANK_STOCK_MAX_NOTIFICATIONS = 3
bankStockSpecialKey(special); bankStockKey(sku, specialKey); bankStockTargetOf(sku); bankStockOnSale(stored)
diffBankStock(newest, previous | null, keyScrap): BankStockDiffRow[]; bankStockVerdict(profit, cost, p); bankStockRow(diffRow, { category, buy, keyScrap, profit })
bankStockPagePairs(saves): { page; newest; previous; firstBatchId; saves }[]; bankStockMergePages(pages)   // F17-C1: per page
bankStockRows(...); bankStockFilterOf, bankStockFilterMatches, bankStockSearchMatches, bankStockDefaultDir, bankStockComparator, bankStockPage, bankStockMatching
emptyBankStockCounts(); bankStockCounts(rows, items); bankStockWhatsNew(counts, previousSavedAt); bankStockResult(...); emptyBankStockResult(bank, keyPrice, now)
bankStockNewAt(banks): Map<baseSku, UnixMs>; marketNewSideMatches(row, q); bankStockItemOf(banks, sku, keyScrap): ItemBankStock | null
bankStockPagePath(url); bankStockNewFlipNotice(label, row, keyScrap); bankStockMoreNotice(n, url); BANK_STOCK_CSV_COLUMNS; bankStockCsvCells(row, keyScrap)
// service
Repo.insertBankStock(batchId, bank, rows, page?); bankStockSaves(bank, limit?, { perPage? }?); bankStockRows(batchId); bankStockLatestPair(bank); pruneBankStock(now, opts?)   // V6 (perPage, V8: F20)
ScrapTfParseResult.page; scraptfPageKey(hint, bodyId)               // import/scraptfHtml.ts: which page of its bank a file is
createBankStock(deps: { clock; log; repo; market: Pick<MarketIndex, 'entryFor'>; keyPrice(); settings(); categoryOf(sku); schemaLoaded?() }): BankStock
  // BankStock: refresh(); list(q, now); all(q, now); whatsNew(bank); newAtFor(baseSku); detailFor(sku); version(); newFlips(bank, batchId)
previousOf(saves); BANK_STOCK_RETRY_MS = 10_000; BANK_STOCK_NOTIFY_META_KEY = 'bankStock.lastNotified'; bankStockCsv(rows, keyScrap)   // domain/bankStock.ts
notifyNewBankFlips(deps & { toldBefore?(base, now) }, { bank, batchId }, now): number
createNewFlipNotifier(deps & { clock; marketBuilt() }): { imported(x); flush(); held(); toldRecently(base, now); toastedElsewhere(base, at) }
MarketIndexDeps.bankStock?: Pick<BankStock, 'newAtFor' | 'version'>; BanksSummaryDeps.bankStock?: Pick<BankStock, 'whatsNew'>
MarketEval.referenced: boolean; isSuspectMargin(margin, eligibleCount, referenced, suspectMargin)   // market.ts, confidence.ts (F5's rule, shared)
EngineDeps.toldElsewhere?(opp, now): boolean                     // one toast per find (core: newFlipNotifier.toldRecently)
EngineDeps.notified?(opps, now): void                             // ...both ways (core: newFlipNotifier.toastedElsewhere)
HandlerContext.bankStock: Pick<BankStock, 'list' | 'all' | 'detailFor'>; HandlerContext.bankStockChanged(imported?); JobContext.bankStockChanged?()
// rpc.ts
'scraptf.bankStock' (service): BankStockQuery -> BankStockResult; 'opps.exportCsv' kind 'bankStock' + bankStock: BankStockQuery
// renderer
BankStockPage({ bank }), BankStockPageView(props)                // pages/BankStockPage.tsx, helpers in bankStockModel.ts
createBankStockLoader, BANK_STOCK_REFRESH_MS, DEFAULT_BANK_STOCK_VIEW, sanitizeBankStockView, bankStockPrefKey, bankStockExtras, bankStockLoadingMore   // bankStockModel.ts
bankWhatsNew, BANK_FIRST_SAVE_TEXT, BANK_STOCK_SEGMENT, bankStockPath(bank), bankStockRouteBank(segments)   // banksModel.ts
MarketFilters.newOnScraptf, marketSourceCount, scraptfNewBadge, SCRAPTF_NEW_FRESH_MS, emptyFiltersText, drawerBankStockLine, bankStockRoute   // marketModel.ts
NEW_ON_SCRAPTF_NOTIFY_LABEL, newOnScraptfNotifyHint                // settingsFields.ts
```

v0.6 save modes, MHTML and parity with the reference helper (F18, below):

```ts
// service/import/mhtml.ts (pure: no I/O, no parser)
readMhtml(input: Uint8Array | string, limits?: { maxBytes?; maxParts? }): MhtmlRead   // { ok: true; html; contentLocation; notes } | { ok: false; reason: MhtmlFailure; detail }
extractMhtmlHtml(input: Uint8Array | string): { html: string; contentLocation: string | null } | null   // the spec's signature
looksLikeMhtml(text); isMhtmlFileName(name); decodeQuotedPrintable(bytes); MHTML_MAX_PARTS = 2000
MhtmlFailure = 'too-large' | 'mhtml-invalid' | 'mhtml-too-many-parts' | 'mhtml-no-html' | 'mhtml-truncated'
// service/import/savedPage.ts
parseSavedPage(text, fileName, schema): SavedPageParse            // ScrapTfParseResult + format: 'html' | 'mhtml'; throws ImportTooLargeError
tooLargeWarning(detail): string                                    // 'too-large: 24 MB is over the 20 MB import limit; save the page again as …'
decodedTooLargeWarning(bytes, limit?): string                      // 'too-large: the page decodes to 24 MB, over the 20 MB import limit; save the page again'
// service/import/scraptfHtml.ts
ParseOptions { address?: string | null }                           // read first, before the saved-from comment
NO_CARDS_SAVED_WARNING                                             // 'no-cards-saved: This page was saved without its items. …'
// service/rpcHandlers.ts
recordSkippedImport(ctx, { fileName, mtimeMs, warning }): ImportResult   // a page the folder watch would not read: a batch + 'import.done'
// shared/market.ts
isEmptyBankSave(batch, bank): boolean                              // a bank page (not the list) whose batch stored 0 items
// shared/bankStock.ts
BankStockPageSave.items?                                           // bankStockPagePairs skips a save known to hold 0 rows
// main/ipc.ts
PICK_PAGE_REFUSAL = 'Choose a saved .html or .mhtml page.'         // import.pickFile takes .html/.htm/.mhtml/.mht
// renderer
SAVE_MODE, SAVE_MODE_ALT, SAVE_MODE_REASON, SAVE_MODE_TEXT, SAVE_MODE_HTML_ONLY_NOTE, SAVE_MODE_FILES_NOTE, SAVE_MODE_LIST_NOTE,
SAVE_MODE_LIST_ONLY, IMPORT_FILE_HINT, NO_CARDS_SAVED, NO_CARDS_SAVED_REASON, NO_CARDS_ALT_HINT, NO_CARDS_MHTML_HINT, TOO_LARGE,
TOO_LARGE_FIX, TOO_LARGE_REASON, NO_CARDS_TOAST_MS = 20_000, importWarningCode, importSavedWithoutCards, importTooLarge,
importWarningsView(r: { warnings; fileName }), noCardsToastText, importNoticeToastText   // importModel.ts
importFailedToast(message): { text; timeoutMs }                    // importModel.ts: a manual import refused for its size names the fix
SaveModeChoice({ alt?: boolean })                                  // components/ScraptfListCard.tsx; alt={false} for scrap.tf/items
LIST_SAVE_TIP                                                      // banksModel.ts: the All items card's tip, no Single File
ToastHold = 'hover' | 'focus' | 'hidden'                           // toastModel.ts: 'hidden' set by AppProvider for the import notice
ImportResultView({ r })                                            // pages/ImportPage.tsx (exported for tests)
importBankText(bank, stored?)                                      // banksModel.ts: "not counted" for a bank page that stored nothing
AppContextValue.lastImport: ImportResult | null                    // the newest 'import.done' (dashboard window); the Import page starts on it
```

v0.6 Live market ↔ scrap.tf link (F19, below):

```ts
// shared/types.ts
MarketScraptfLink { bank: ScraptfBank; url; seenAt: UnixMs | null; source: 'seen' | 'category' }; MarketRow.scraptfLink
CheckArm { sku; name }; CheckHint { sku }
// shared/links.ts
ScraptfSeen = Pick<ScraptfSeenOn, 'bank' | 'at'>; preferScraptfSeen(a, b)   // a bank page beats the list, then the newer; a tie keeps a
scraptfLinkFor(category, seen): MarketScraptfLink                   // the URL always from SCRAPTF_BANKS
// shared/check.ts
CHECK_ARM_MS = 10 min, CHECK_ARM_NAME_MAX = 200, CHECK_HINTED_NOTE_TAIL; checkHintedNote(name); checkMatchedByHint(result)
CHECK_HINT_MAX_KEYS = 5000, CHECK_HINT_MAX_REF = 50000; checkHintPriceOf(text, source): ParsedPrice | null
// rpc.ts
'check.text' params + hint?: CheckHint (main only); 'check.arm' (main): CheckArm | null -> { armedUntil: UnixMs | null }
// service
BankStock.seenFor(baseSku): ScraptfSeen | null                      // domain/bankStock.ts, memoised per version()
MarketIndexDeps.bankStock?: Pick<BankStock, 'newAtFor' | 'version'> & Partial<Pick<BankStock, 'seenFor'>>   // core: bankStock.seenFor
CheckForm 'hinted'; checkHintPrice(text, source): CheckMoney | null; hintedCheck(text, hint, source): ParsedCheck | null   // domain/liveCheck.ts, pure
LiveCheck.check(text, source, now, hint?)
// main
LiveCheckMain.arm(a: CheckArm | null): { armedUntil }; LiveCheckMainDeps.check(text, source, hint?); CHECK_OWN_COPY_MS = 5 s   // liveCheck.ts
ClipboardWatch.isLastSeen(hash); ClipboardWatchOptions.onPrimed?(hash)   // clipboardWatch.ts
MainRpcDeps.armCheck(arm); CHECK_TEXT_HINT_REFUSAL                  // ipc.ts: a page's check.text may not carry a hint
// renderer
MARKET_SCRAPTF_KEY = 'o'; marketScraptfButton(row, now); marketSingleBank(categories); marketBankLink(categories)   // marketModel.ts
MarketTableProps.onScraptf?(row)                                    // pages/MarketPage.tsx
openOnScraptf(url, name, toast, arm?: ScraptfArm)                   // components/ItemMenu.tsx; ScraptfArm { sku; settings }
CHECK_MATCHED_NOTE, checkPopupNote(r), checkArmFor(sku, name), checkReturnPath(settings, hotkey, armed), scraptfBackHint(p)   // checkModel.ts
scraptfOpenedToast(copied, opened, url, back?)                       // itemMenuModel.ts
mockHintedParse(text, item, source)                                 // mockCheck.ts
```

v0.6 scrap.tf history (F20, below):

```ts
// shared/types.ts
ScraptfChangeKind ('new' | 'gone' | 'cheaper' | 'pricier' | 'restocked' | 'stock'), SCRAPTF_CHANGE_KINDS
NewScraptfEvent, ScraptfEventStored (+ id), ScraptfChangeEvent (+ key, hasExtras, fromValueScrap, toValueScrap, deltaScrap, pct, revenueScrap, maxCostScrap, flip)
ScraptfChangesQuery { bank?; kinds?; sku?; beforeId?; limit? }; ScraptfHistoryPoint, ScraptfPriceChange, ScraptfItemHistory, ScraptfKeyRun
BankStockFilter += 'long-listed' | 'dropped'; BankStockSort += 'listed' | 'sinceListed'; BankStockQuery.minListedMs?
BankStockRow.listedSince, firstSeenAt, changeSinceListed; BankStockCounts.longListed, dropped
MarketRow.scraptfListedSince; MarketQuery.listedOnScraptf?; Settings.import.resaveReminderMin (0..1440, 0 = off), resaveBanks ([] = every saved bank)
// shared/bankStock.ts (S1 thinning, listed fields)
BANK_STOCK_KEEP_ALL_MS = 24 h, BANK_STOCK_HOURLY_MS = 7 d, BANK_STOCK_MAX_AGE_MS = 90 d, BANK_STOCK_MAX_SAVES_PER_PAGE = 300; BankStockThinSave
bankStockThinning(saves, now, opts?): Set<batchId to delete>; SCRAPTF_LONG_LISTED_MS = 24 h; scraptfPriceChange(from, to, since, keyScrap)
bankStockRow(d, { …, run? }); bankStockMinListedMs(q); bankStockLongListed(r, now, minListedMs?); bankStockDropped(r)
bankStockFilterMatches(r, filter, { now?, minListedMs? }); bankStockMatching(rows, q, now?); bankStockCounts(rows, items, { now?, minListedMs? })
// shared/scraptfHistory.ts (pure; the service, the dashboard and the mock)
SCRAPTF_EVENTS_MAX_AGE_MS = 90 d, SCRAPTF_CHANGES_DEFAULT_LIMIT = 100, SCRAPTF_CHANGES_MAX_LIMIT = 500, SCRAPTF_CHANGES_EXPORT_MAX = 5000,
SCRAPTF_ITEM_EVENTS = 50, SCRAPTF_RESAVE_MAX_MIN = 1440, SCRAPTF_RESAVE_HELP
scraptfEventsOf({ bank, page, at, batchId, newest, previous, keyScrap, seenBefore? }): NewScraptfEvent[]
scraptfChangeEvent(e, keyScrap, buy); scraptfEventMatches(e, q); scraptfChangesLimit(limit); SCRAPTF_CHANGES_CSV_COLUMNS; scraptfChangeCsvCells(e, keyScrap)
ScraptfSaveRows, ScraptfObservation; scraptfRunsOf(saves); scraptfObservationsOf(saves, key); scraptfItemHistoryOf({ sku, specialKey?, name?, banks, events, keyPrice, now })
scraptfListedSinceOf(runs, baseSku); marketListedSideMatches(r, q, now)
scraptfAgoText(ms); scraptfResaveBanksOf(chosen, saved); scraptfResaveDue({ minutes, lastSavedAt, lastRemindedAt, now }); scraptfResaveNotice(bank, lastSavedAt, now)
// shared/links.ts
isScraptfBankUrl(url): url is string                                // an exact SCRAPTF_BANKS url, nothing else
// rpc.ts
'scraptf.itemHistory' (service): { sku; special? } -> ScraptfItemHistory; 'scraptf.changes' (service): ScraptfChangesQuery -> ScraptfChangeEvent[]
'opps.exportCsv' kind 'scraptfChanges' + scraptfChanges: ScraptfChangesQuery; push 'scraptf.changed' { at; count }; PushContract['notify'].openUrl?
// service
Repo.insertScraptfEvents(events); scraptfEvents(q?: ScraptfEventQuery); scraptfEventsForSku(sku, limit?); pruneScraptfEvents(now, maxAgeMs?)   // V7
Repo.bankStockSaveIndex(): BankStockThinSave[]; bankStockRowsOf(batchIds): Map<batchId, BankStockStored[]>; pruneBankStock(now, { maxSaves?, maxAgeMs?, orphans? })
createScraptfHistory(deps: { clock; log; repo; market: Pick<MarketIndex, 'entryFor'>; keyPrice(); nameOf?(sku) }): ScraptfHistory   // domain/scraptfHistory.ts
  // ScraptfHistory: onImport(batchId); itemHistory(sku, special, now); changes(q, now); runsFor(bank); listedSinceFor(base, bank?); refresh(); csv(q, now); version()
scraptfChangesCsv(events, keyScrap); scraptfChangedPush(at, count); SCRAPTF_HISTORY_RETRY_MS = 10_000
createResaveReminders(deps: { clock; log; repo: Pick<Repo, 'bankStockSaveIndex'>; settings(); networkPaused(); notify(n); timers? }): ResaveReminders   // domain/resaveReminders.ts
  // ResaveReminders: start(); stop(); tick(now); RESAVE_TICK_MS = 60_000
BankStockDeps.history?: Pick<ScraptfHistory, 'runsFor'>; MarketIndexDeps.history?: Pick<ScraptfHistory, 'listedSinceFor' | 'version'>
HandlerContext.scraptfHistory: Pick<ScraptfHistory, 'onImport' | 'itemHistory' | 'changes' | 'csv'>; JobContext.scraptfEventsPruned?()
runMaintenance(repo, now) -> { …, bankStock, scraptfEvents }        // engine.ts: thinning with the orphan sweep, events past 90 d
// main
notificationOpenUrl(url): string | null; droppedOpenUrl(payload, data); handleNotificationClick(data, { openExternal; openItem; showDashboard; log })   // notify.ts
isHttpsUrl(url)                                                     // paths.ts (moved from ipc.ts; links.open and the click share it)
// renderer
ScraptfHistory({ sku; special?; keyScrap; now })                     // components/ScraptfHistory.tsx, helpers in historyModel.ts
StepSparkline({ geom; ariaLabel; readout; axis? })                   // components/Sparkline.tsx; stepChartGeom, historySeries, nearestStep (historyModel.ts)
historyListedLine, historyNowText, historyChips, priceChangeText, historyReadout, historyChartLabel, historyEventLines, historyNote, historyBankPath   // historyModel.ts
LogTab, LOG_TABS, logTabOf(segments), logTabPath(tab), createChangesFeed, changesQueryOf, changesExportQuery, sanitizeChangesView, CHANGES_PREF_KEY,
changeRowView, changePriceText, changeStockText, fmtSaveTime, CHANGES_PAGE, CHANGES_MAX_KEPT, CHANGES_SHOWN   // changesModel.ts; LogPage's ScraptfChangesView
bankStockListedCell(r, now), bankStockSinceListedCell(r, keyScrap), RETENTION_NOTE   // bankStockModel.ts
MarketFilters.listedOnScraptf, LISTED_ON_SCRAPTF_LABEL               // marketModel.ts
ImportSection({ s })                                                 // pages/SettingsPage.tsx; resaveMinutesOf, resaveBanksShown, resaveBanksHint, resaveReminderHint (settingsFields.ts)
seedBankStockHistory(saves)                                          // mockData.ts
```

v0.7 the scrap.tf window (F21, below):

```ts
// shared/types.ts
Settings.scraptfWindow: ScraptfWindowSettings { enabled; acknowledgedAt: UnixMs | null; keepLoggedIn; readOnLoad; openLinksInWindow }
ScraptfWindowRead { at; path; items; bank; newFlips; warning }; ScraptfWindowNav { url; canGoBack; canGoForward; loading }
ScraptfWindowState { open; url; canGoBack; canGoForward; lastRead }; ScraptfReadOutcome { read; reason }
ImportOrigin = 'file' | 'window', IMPORT_ORIGINS; ImportBatch.origin?: ImportOrigin | null (V9); ImportResult.origin?, newFlips?
// shared/links.ts
SCRAPTF_HOME_URL = 'https://scrap.tf/'                             // a window start page only; not in STATIC_EXTERNAL_URLS
// shared/scraptfWindowPolicy.ts (pure, zod-free)
isScraptfPageUrl(url); shouldReadUrl(url); SCRAPTF_WINDOW_START_URLS, scraptfWindowStartUrls(), isAllowedWindowStart(url)   // exact Set.has
topLevelNavigationDecision(url): 'allow' | 'external' | 'block'; subframeNavigationDecision(url): 'allow' | 'block'
windowDisplayUrl(url) (origin + path); scraptfPathOf(url); windowReadFileName(url) ('scrap.tf window /buy/hats')
READ_WORLD_ID = 1001, READ_SETTLE_MS = 4_000, READ_MANUAL_MIN_GAP_MS = 2_000, READ_AUTO_MIN_GAP_MS = 30_000, READ_DEDUPE_MS = 60_000,
READ_MAX_CHARS = 20 MiB (= MAX_IMPORT_BYTES), EXTERNAL_OPEN_MIN_GAP_MS = 1_000
READ_SCRIPT; READ_SCRIPT_FORBIDDEN; readScriptProblems(code); readResultHtml(v)
SCRAPTF_READ_REASONS, SCRAPTF_WINDOW_OFF, IMPORT_HTML_ORIGIN_REFUSAL, SCRAPTF_BAR_HASH = '#/scraptf-bar'
SCRAPTF_WINDOW_NEEDS_IMPORT, SCRAPTF_WINDOW_NEEDS_ACK; scraptfWindowEnableProblem(s); gateScraptfWindow(next, turnsOn)
// rpc.ts
MAIN_METHODS += 'scraptfWindow.open' { start? } | 'back' | 'forward' | 'reload' | 'home' | 'go' { url } | 'read' -> ScraptfReadOutcome | 'clear' | 'state' -> ScraptfWindowState
'import.html' params + address?, origin? (main only); 'links.open' result + openedIn?: 'window'
push 'scraptfWindow.read' (ScraptfWindowRead), 'scraptfWindow.nav' (ScraptfWindowNav): main only (MAIN_ONLY_PUSH_EVENTS), to the toolbar
// main
SCRAPTF_BAR_URL = 'app://app/index.html#/scraptf-bar'; WindowKind 'scraptf'          // paths.ts, preload.ts PRELOAD_WINDOW_KINDS
createScraptfWindowManager(deps: { settings(); log; preloadPath; iconPath; devTools; importHtml(p: WindowImportParams); openExternal(url);
                                   isQuitting(); onStateChanged?(); now?(); timers?: ScraptfWindowTimers }): ScraptfWindowManager
  // open(start?); focus(); close(); back(); forward(); reload(); home(); go(url); readNow(); clear(); state(); send(event, payload); ownsContents(c); dispose()
scraptfPartition(keepLoggedIn); scraptfViewWebPreferences(partition, devTools); SCRAPTF_MEMORY_PARTITION = 'scraptf', SCRAPTF_PERSIST_PARTITION = 'persist:scraptf'
SCRAPTF_WINDOW_TITLE, SCRAPTF_TOOLBAR_HEIGHT = 48, SCRAPTF_START_REFUSAL, SCRAPTF_NOTHING_TO_IMPORT       // scraptfWindow.ts
hardenWebContents(contents, log, opts?: { ownNavigation?(c) }); hardenScraptfSession(ses, log)              // windows.ts
MainRpcDeps.scraptfWindow?: ScraptfWindowRpc; SCRAPTF_WINDOW_UNAVAILABLE                                    // ipc.ts
TrayState.scraptfWindow; TrayActions.openScraptfWindow()                                                     // tray.ts
// service
parseSavedPage(text, fileName, schema, opts?: { address?: string | null }); SavedPageOptions             // import/savedPage.ts
importSavedPage(ctx, p: ImportSavedPageParams); WINDOW_NOTHING_TO_IMPORT                                   // rpcHandlers.ts
HandlerContext.bankStock + 'newFlips'
// renderer
ScraptfWindowBar()                                                   // pages/ScraptfWindowBar.tsx (window kind 'scraptf')
ScraptfWindowSection({ s })                                          // pages/SettingsPage.tsx
scraptfWindowOn, scraptfLinksInWindow, windowEnableView, windowRefusalText, windowAckText, barShortcut, barFocusMove, barBankChips,
activeBankOf, addressView, readButtonView, readWarningText, readStatusView, readStatusText, bankWindowView, windowOpenTitle,
windowOpenFailedText, importOriginView; SCRAPTF_WINDOW_RISK, SCRAPTF_WINDOW_DOES, SCRAPTF_WINDOW_NEVER, SCRAPTF_WINDOW_ACK_TEXT   // scraptfWindowModel.ts
scraptfOpenedToast(copied, opened: { …; openedIn? }, url, back?); SCRAPTF_NAME_COPIED_WINDOW     // itemMenuModel.ts
importBankText(bank, stored?, savedWithoutCards?, fromWindow = false)  // banksModel.ts
createMockScraptfWindow({ now; settings; emit; itemsOn? }): MockScraptfWindow; MOCK_WINDOW_READ_WARNING   // mockScraptfWindow.ts
```

v0.7.1 import truth, bank history, alerts and the window ("0.7.1 round", below):

```ts
// shared/types.ts (every new field optional)
ImportResult + skippedTotal?, skippedCounts? (benign reason text or warning code -> count), stockSave? ('written' | 'partial' | 'unsettled' | 'none'),
  pageFlips?, topFlips?: ImportTopFlip[] (<= 3; { sku; name (app data); costScrap; maxCostScrap; profitScrap })
ImportReport { id; at; origin; name; pageKind; bank; page; format; batchId; counts; headerColumns; warningCodes; items: ImportReportItem[] (<= 200) }
ScraptfWindowRead + stored?, pageFlips?, bestFlip?; ScraptfWindowNav + importable?, notice?; ScraptfWindowState + pendingPartitionChange?
MarketSort + 'seen'; MarketRow.scraptfLastSeenAt?; BankStockRow.lastSeenAt?; BankStockResult.olderPages?; ScraptfChangeEvent.wasFlip?
ShoppingRow.knownObservedAt?, knownStock?, knownStale?
// shared/rpc.ts
'import.html' params + settled?: boolean (main only; false = an unsettled window snapshot); 'import.report' (service) { limit? } -> ImportReport[]
'app.showBankStock' (main) { bank; filter: 'flips' | 'new' } -> { ok: true }; push 'ui.openBankStock' (main only, held by the preload like ui.openItem)
// shared/importCodes.ts, scraptfPaths.ts, boundaryText.ts
IMPORT_SCHEMA_LOADING_CODE, IMPORT_SCHEMA_LOADING_MESSAGE, LAYOUT_CHANGED, NO_PRICE_COLUMN, PARTIAL_READ, NO_STOCK_LIMIT, IMPORT_REFUSAL_CODES,
SKIP_OUT_OF_STOCK, SKIP_SAME_OR_CHEAPER, SKIP_NEWER_SAVE, BENIGN_SKIP_REASONS, PARTIAL_READ_MAX_AGE_MS (6 h), PARTIAL_READ_RATIO (0.5),
PARTIAL_READ_MIN_KEYS (8), IMPORT_REPORT_MAX_ITEMS, IMPORT_REPORT_RING (20), importWarningCode(w)
scraptfImportablePath(url); SCRAPTF_BOUNDARY_SHORT, scraptfDataSourcesText(windowOn)
// shared/bankStock.ts
BANK_STOCK_KEEP_ALL_MS (2 h), BANK_STOCK_RECENT_BUCKET_MS (10 min), BANK_STOCK_RECENT_TIER_MS (24 h); bankStockThinning(saves, now, opts?) (new tiers)
BANK_STOCK_SESSION_GAP_MS (30 min), BANK_STOCK_SESSION_READ (1000), bankStockBaselineOf(groupNewestFirst); BankStockPagePair.baseline
BANK_STOCK_OLDER_PAGE_MS (48 h), bankStockCurrentPages(pages); BANK_STOCK_NEW_MAX_AGE_MS (24 h), bankStockNewAt(banks, now?)
bankStockComparator(sort, dir, now?); bankStockLongListed(r, now, minListedMs?) (lastSeenAt - listedSince)
BANK_STOCK_NOTIFY_AGE_NOTE_MS (15 min), bankStockSaveAgeText(ms), bankStockOldSaveNotice(...), bankStockNewFlipNotice(label, row, key, savedAgoMs?)
// shared/banks.ts, market.ts, scraptfHistory.ts, scraptfList.ts
bankStockFlips(rows, count); mergeBankNewestSaves(newest, extra); WholeLookSave, wholeLookNewestSaves(newest, wholeLookOf, itemCountOf), batchItemCounts(batches, extra?) (DC-2)
scraptfCoverage(batches, categoriesOf, extra?, wholeLookOf?); MARKET_SORTS; marketProfitTie
SCRAPTF_ITEM_STOCK_EVENTS (10), SCRAPTF_PRICE_KINDS; ScraptfKeyState, scraptfKeyStatesOf, scraptfEventIsCurrent, scraptfMarkSuperseded (ACT-10)
ScraptfListed, scraptfListedOf, scraptfListedPick; marketListedSideMatches({ scraptfListedSince, scraptfLastSeenAt? }, q, now)
scraptfResaveNotice(bank, lastSavedAt, now, window?); SCRAPTF_RESAVE_HOW_FILE, SCRAPTF_RESAVE_HOW_WINDOW; WATCH_WAITING_FOR_SCHEMA (scraptfList.ts)
// shared/scraptfWindowPolicy.ts
SCRAPTF_READ_REASONS + schemaLoading, notImportable; SCRAPTF_NOT_READ_AGAIN; SCRAPTF_WINDOW_NOTICES, SCRAPTF_LINK_NOTICES, SCRAPTF_FAILURE_NOTICES
responseNotice(status), loadFailureNotice(errorCode); WindowKeyAction, WindowKeyInput, windowKeyAction(input), appCommandAction(command)
// service
Repo.bankNewestSaves(): { bank; batchId; savedAt; itemCount }[]   // V10 index idx_import_batches_bank_saved
parseScrapTfHtml(html, schema, opts?: { address?; diagnostics? }) -> + diagnostics?: ParseDiagnostics; parseSavedPage(..., opts.diagnostics)
recordImportReport(input), importReports(limit?), clearImportReports(), scrubReportText(s, max)   // import/reports.ts
importSavedPage(ctx, { ..., settled? }); HandlerContext.bankStock + 'pageFlips'
BankStock.pageFlips(bank, batchId): BankStockRow[]; BankStock.savedAtOf(batchId); BankStockNotifyDeps.stock: Partial<Pick<BankStock, 'savedAtOf'>>
ScraptfHistory.listedFor(base, bank?): ScraptfListed | null; MarketIndexDeps.history + Partial listedFor; BanksSummaryDeps.repo + Partial bankNewestSaves, bankStockSaves
BanksSummaryDeps.bankStock: Pick<BankStock, 'whatsNew'> & Partial<Pick<BankStock, 'list'>>
EngineDeps.toldElsewhere(opp (+ inputObservedAt, firstSeenAt), now); EngineDeps.boughtSince?(baseSku, at); EngineDeps.recentBankSaveAt?(bank)
NotifyFingerprint { obs; lid; p }, NotifyRecord { t; f }, notifyFingerprintOf, notifyWorthRepeating, parseNotifyRecords   // domain/engine.ts
buildShoppingList(rows, q, keyPrice, now, opts?: { stockOf?(inputRef) }); ShoppingListOptions   // domain/shopping.ts
USER_PRICE_TOLD_MS (5 min), newestScraptfBuys(journal), WATCH_WAITING_FOR_SCHEMA (re-export)   // core.ts
// main
MainRpcDeps.showBankStock?(bank, filter); createWindowBounds(deps), placeWindow, visibleOn, parseWindowBounds, MIN_VISIBLE (120 x 48)   // ipc.ts, windowBounds.ts
ScraptfWindowDeps.bounds?: { file; screen; readFile?; writeFile? }; WindowImportParams.settled?: false
// renderer
MARKET_FLIPS_ROUTE, MARKET_FLIPS_PATH ('#/market/flips'); banksFlipsLine; bankStockRouteFilter(segments), bankStockOpenPath(push); bankLookForTitle
listSetupState(s, windowOn?) ('window-only', 'watch-waiting'); listStepsAutoOpen(s, windowOn?); listBoundaryNote, marketBoundaryNote; FIRST_PRICE_LEAD
bankStockBuyCopy(row, bank) (ItemMenuTarget.copy, recordBuyInit(item, prices, copy?)); bankStockHeader(bank, r, now, inWindow?); SESSION_NOTE
DEFAULT_CHANGE_KINDS (all but 'stock'), CHANGES_PREF_KEY 'log.scraptfChanges.v2', changesViewFromLegacy; historyEventGroups; changeRowView.wasFlip
importSkipSummary, IMPORT_REPORT_NOTE, importOffText(windowOn); checkNotifyHint(notificationsOn, popupOn?); scraptfOpenedToast(..., readOnLoad?)
showFlipsView(read), bestFlipTitle, windowNoticeText   // scraptfWindowModel.ts
```

## Integration (src/service/core.ts and friends)

```ts
createLogger({ dataDir, post? }): ServiceLogger          // <dataDir>/../logs/service.log, 5 MB x 2, every line redacted
createServiceCore({ dataDir, version, settings, secrets, log, fetchImpl?, wsFactory?, socketFactory?, clock?, timers? })
  -> { start(); stop(); handle(method, params); updateSettings(s); updateSecrets(s); onPush(cb) }
createScheduler({ clock, timers, log, isPaused }) + buildJobs(ctx)   // fixed cadences, no overlap, skipped while paused/blocked
createRpcHandlers(ctx)                                    // every SERVICE_METHODS entry, zod-validated params
importSavedPage(ctx, { html, fileName, mtimeMs })         // shared by 'import.html' and the folder watcher; `html` is the
                                                          // file's text, .mhtml included (parseSavedPage unpacks it, F18)
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
  service died importing (repo meta `import.watchImporting`) is skipped once at the next start. From 0.7.1 (P3) it
  starts only once the item schema has loaded, and reports `WATCH_WAITING_FOR_SCHEMA` ('Waiting for item data to load')
  until then (`scraptf.listStatus`, Data health; the dashboard shows it as a muted wait, `listSetupState` 'watch-waiting');
  it starts on the next 10 s status tick after the load, and its catch-up scan imports the pages saved meanwhile: its
  start is fixed when the watch begins waiting (DC-4), so an import between the load and that tick (a window read, a
  page picked by hand) does not skip them.
- Generic "any effect" unusual buy orders (`<defindex>;5` without `u`) are eligible exits for every effect of
  that item, flagged `any-effect`.
- Main pushes `service.state` (starting/ready/restarting/stopped), `ui.openItem` (notification click, or the
  quick-entry window's or the check popup's `app.openItem`), `ui.quickPrefill` (`app.showQuickEntry` with a SKU, and
  from 0.5 an optional price text; held until the quick-entry page has loaded, and by the preload until it subscribes)
  and `ui.checkShow` (the live check popup's result, F16; held the same way, the latest wins). The service pushes `opps.changed`, `status.changed`, `import.done`, `prices.changed` (any price or rule write, so
  every window's price sheet refreshes), `market.changed` (the Live market index, see below), `journal.changed`
  (`journal.add` and `journal.delete`, see Holdings), `scraptf.listChanged` (the saved scrap.tf list, see F14),
  `scraptf.banksChanged` (the scrap.tf banks page, F15, and from 0.6 its bank stock, F17), `scraptf.changed` (an import
  that wrote scrap.tf change events, F20), `check.done` (an item result of a live check, F16) and `notify`.
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
- Main drops service pushes it owns (`settings.changed`, `ui.openItem`, `ui.quickPrefill`, `ui.checkShow`, `service.state`) and any `status.changed`
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
- Schema V4 adds `scraptf_list`, the saved scrap.tf/items price list (F14, below). Nothing else changes; a 0.3 database
  gains an empty table.
- Schema V5 adds `import_batches.bank` (TEXT, nullable): the scrap.tf page the parser recognised when the page was
  imported (F15, below). A 0.4 database gains a NULL column, so its batches fall back to the F13 majority rule. Every
  `scrap_prices` read joins its batch's bank as `ScrapPrice.bank` for imported rows only (a typed price, or an
  imported one edited by hand, which keeps its batch id, reads null); an unknown stored value reads as null.
- Schema V6 adds `bank_stock`, one row per card or /items row with a SKU of every recognised saved page (F17, below):
  what that page had at that moment and which page of its bank it was (`page`), so two saves of a page can be compared. A 0.5 database gains an empty table, so
  a bank saved before 0.6 has no snapshot until it is saved again.
- Schema V7 adds `scraptf_events`, one row per change between a save of a bank page and the previous save of that page
  (F20, below), with indexes on (at), (sku) and (bank, at). Nothing else changes; a database from before gains an empty
  table, and its saves start writing changes from their next save.
- Schema V8 (F20) adds the index (bank, id) on `scraptf_events` (the feed filtered by a bank walks it back and stops at
  the limit, where (bank, at) sorted the bank's every event) and `bank_stock_saves` (batch_id primary key, bank, page,
  items): one entry per save with rows, written and deleted with its `bank_stock` rows (`insertBankStock`,
  `pruneBankStock` and its orphan sweep), backfilled from `bank_stock`. The save lists read it, so they cost per kept
  save, not per stored row or per import batch ever written (`import_batches` is never purged).
- Schema V9 (F21) adds `import_batches.origin` (see "The scrap.tf window (F21)", S3). Schema V10 (0.7.1) adds the
  index `idx_import_batches_bank_saved` on `import_batches(bank, COALESCE(file_mtime, imported_at))` behind
  `Repo.bankNewestSaves()` (each bank's newest non-empty save over all batches, DM-7). No table or column changes.
- `shopping.list` and `opps.exportCsv {kind:'shopping'}` are built from the stored opportunities: one row per SKU with a
  ceiling above 0 and buyers; when a SKU has several inputs, the one with the highest confidence wins. The known cost is
  that row's own when it is typed or imported, else the newest typed/imported one, and `underCeiling` compares it only
  with its own row's ceiling (`knownMaxCostScrap`): painted, spelled and plain copies share a SKU. The scrap.tf bank-page
  URLs are only passed to `links.open` (the user's browser), never fetched (R1). From 0.7.1 (ACT-9) every row carries
  `knownObservedAt` (the known row's input time), `knownStale` (the known row carries the engine's `stale-input` flag:
  older than `profit.inputStaleMs`) and, on `shopping.list` only, `knownStock` (the stock scrap.tf showed with the
  price behind the known row, `opts.stockOf`, one `getScrapPrice` per returned row; null for a typed price). The
  dashboard counts only fresh known prices as at or under the ceiling.
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
  From 0.6 the payload may carry `openUrl`, kept only when it is exactly a `SCRAPTF_BANKS` page and checked again when
  the toast is clicked (F20, "Notification links" below); a bad one costs the toast its link, never the toast.
  From 0.6 an imported opportunity whose item a "New on scrap.tf" notification named in the last 30 minutes (F17) is
  recorded as notified without a toast of its own (`EngineDeps.toldElsewhere`), so one find makes one toast.
  From 0.7.1 (ACT-2, ACT-3, ACT-7, ACT-8): an opportunity flagged `stale-input` (its input older than
  `profit.inputStaleMs`) is never toasted and stays in the lists. `NOTIFY_META_KEY` stores `{ key: { t, f: { obs, lid, p } } }`
  (the input's observedAt, for a rule its update time; the revenue order's listing id; the toasted profit); an old
  `{ key: ts }` map parses as records with no fingerprint. Past `notifications.dedupMs` a row toasts again only if
  `obs` or `lid` changed or its profit rose by `CHANGE_PROFIT_DELTA` or more. Records are not capped by count: one
  stays while inside the window, and after it while it has a fingerprint and its row is still stored. The
  `toldElsewhere` branch records the fingerprint too, so F17's one toast per find lasts past 30 min, and it also covers
  an input of kind 'user' whose `inputObservedAt` or `firstSeenAt` is under `USER_PRICE_TOLD_MS` (5 min) old: a price
  just saved from the check popup or quick entry gets no "Profit:" toast. `EngineDeps.boughtSince(base, at)` (core:
  `newestScraptfBuys` over the journal, the newest buy per base on venue scrap.tf, reset by `journalChanged`) skips,
  without recording, the toast of a base the user recorded buying on scrap.tf at or after the input's observedAt (for a
  rule, at or after max(rule time, now - inputStaleMs)). `EngineDeps.recentBankSaveAt(bank)` (core: the bank's newest
  bank stock save with rows, `repo.bankStockSaves(bank, 1)`, cached per bank and reset by `pricesChanged` and
  `bankStockChanged`; a partial or unsettled look writes none, so it holds nothing back) skips "Candidate:" toasts of a
  single-page bank (not 'unusuals') saved within `profit.inputStaleMs` (0 means 2 h): the item was not on that save.
  Never for an australium (DC-5): its category is 'stranges', but scrap.tf's items bank holds australiums too, so a
  fresh /buy/stranges save is no proof it is off sale.
  In main (F16) the clipboard watcher's "Flip:" notification is sent only while `check.popup` is off, so one check
  makes one alert.
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
  From 0.6 the same rebuild keeps which saved page last listed each base, joined with the bank stock's saves into
  `MarketRow.scraptfLink`, the page the row's scrap.tf button opens (F19, below).
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
  so a missing folder or a failed OS watch reads off, `coverage`, below, and `allItems`, the saved scrap.tf list's chip, F14), `stats()` and the key price. `opps.exportCsv {kind:'market', market}` drops paging and writes
  `flipdesk-market-YYYY-MM-DD.csv` (0.4 appends scraptf_pays, scraptf_stock, scraptf_limit and scraptf_list_saved).
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
  `lastSavedAt` is the newest import batch (of the last 500, `COVERAGE_BATCHES`, `repo.listImportBatches`) that counts
  for it, at the batch's file time when known, else its import time; `items` is that batch's item count. Which page a
  batch counts for is `batchBankOf` (`src/shared/market.ts`): from 0.5 the bank the parser recognised and V5 recorded
  on the batch decides, whatever the page held (F15). Only a batch without one (imported before 0.5, or a page the
  parser did not recognise) falls back: kind 'items-list' is the list, any other page counts for the page its stored
  items fall at least half into. From 0.7.1 (DM-7, CQ-3) each bank's newest non-empty save over **all** batches
  (`Repo.bankNewestSaves`: `item_count > 0` or the list, file time else import time, ties to the higher id, the V10
  index `idx_import_batches_bank_saved`) is merged in, newer wins (`mergeBankNewestSaves`, `scraptfCoverage(batches,
  categoriesOf, extra?)`), so a bank saved before 500 newer batches (a day of window reads) stays dated; the 500
  batches still classify batches without a bank. A bank page is then dated and counted by its newest whole look, its
  newest bank stock save (`Repo.bankStockSaves(bank, 1)`, with that batch's itemCount: `wholeLookNewestSaves`,
  `scraptfCoverage(…, wholeLookOf?)`, DC-2), as its stock page and the engine's ACT-8 are: a partial (DM-2) or unsettled
  (ACT-4) look records a batch with cards but no stock save, and dates nothing; a bank with no stock save (saved before
  0.6) keeps the batch-based date. The list counts for no page (the saved list has its own "All items" chip, F14). The
  fallback reads the categories a batch stored when imported (`ImportBatch.categories`), because a later import
  rewrites the rows it shares in place under its own batch id (an /items list takes over a bank page's plain rows);
  only a batch from 0.2, without them, is classified from the rows carrying its id today (that map is collected while
  the known prices are rebuilt). The result is cached: recomputed only after `pricesChanged()` or when categories may
  change (a schema reload, `markAllDirty`), never per `list()`. From 0.5 it is read even when no saved-page item is
  stored. From 0.6 a bank page whose batch stored nothing does not date its bank (`isEmptyBankSave`, F18 S3: such a
  page was saved without its cards); the strip keeps that bank's newest save with items. A failed batch read is logged once
  per failure streak and not cached: that `list()` returns the last good strip (all "never saved" before the first),
  and the next one reads again. The page's strip is a row of chips (green up to 15 min, amber up to 2 h, else muted),
  hidden while import is off. From 0.5 a click opens that page's card on the scrap.tf banks page (`#/banks/<bank>`,
  F15), whose Open in browser passes the static page URL to `links.open` (the user's browser). Nothing fetches it (R1).
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
  buyer, profit_now, profit_all, status, confidence, and from 0.4 exit, exit_venue, scraptf_pays (money as "1 key 2.00 ref";
  sells_for stays the backpack.tf revenue, profit_now follows the better exit).
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
  later still notify it once; from 0.4 it gates backpack.tf exits only, see F14). Main applies `notifications.silent`. Dedupe is per SKU for `notifications.dedupMs`,
  saved in repo meta `holdings.lastNotified` and expired by age (the engine's own records keep a fingerprint from
  0.7.1, see Integration), so a restart
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
  only while visible). Holdings also refetches on `market.changed`, `prices.changed` and `scraptf.listChanged` (2 s throttle, only while
  visible), when `settings.profit` or the blocklist changes, and once when a scrap.tf exit's list row turns a day old (F14).

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

## scrap.tf price list (F14)

The user's saved copy of scrap.tf/items, scrap.tf's public list of every item it trades ("Price to buy", "Price we
pay", "Item Limits" n/limit), held as one row per base SKU and read by every feature. It adds **no network traffic of
any kind** and never contacts scrap.tf (R1). The only data path is the user's own browser: the dashboard hands
`SCRAPTF_ITEMS_URL` to `links.open` (main's allowlist: that exact URL, so `/items/2`, queries and subdomains are
refused), the user saves the page with Ctrl+S (as "Webpage, Complete" from 0.6, F18) into the opt-in watch folder, and the existing folder watcher imports it
behind the R10 acknowledgement. List SKUs never join `core.watchedSet()`. `test/compliance/static.test.ts` fails if a
`src/` file passes a scrap.tf address (a literal, a link constant or a field that carries one) to fetch, the
HttpClient, a websocket or socket.io factory or an Electron window or view, embeds web content (webview, iframe,
BrowserView), loads an image from scrap.tf (an `<img src>`, or a CSS `url()` or `@import`: style sheets are scanned
too, protocol-relative URLs included), writes the scrap.tf/items URL anywhere but `shared/links.ts`, or assigns
`SCRAPTF_ITEMS_URL` to a src, href or location (or passes it to window.open / location.assign). Each F14 scan also
runs on synthetic files that break it, so a scan that cannot see anything fails.

- **Parser** (`import/scraptfHtml.ts`). /items rows gain `pays` ({keys, scrap} or null), from the column whose
  header matches `/price we pay/i` in the "Price to buy" header row, and `stockLimit`, from `title="n/limit"`. The
  "Item Limits" cell is found by header (`/item limits?/i`), falling back to the first n/m cell after the price, so a
  reordered table still reads stock. Warnings: `no-pays-price` (missing, empty, dashes or zero), `unparsed-pays-price`
  (not a price; a cell over 200 characters is never parsed) and the page warning `no-pays-column`: without the header
  the column is never guessed by position, because a wrong column would become a holding's exit. None of them makes an
  item unimportable. Bank-page cards leave both fields absent. `sellsPriceOf(item)` is the price to buy, or null for
  "Sold out"; `isImportableItem` uses it and behaves as before.
- **Store** (schema V4). `scraptf_list` (sku TEXT primary key = canonical base SKU, name, sells_keys, sells_scrap,
  pays_keys, pays_scrap, stock, stock_limit, batch_id, observed_at; index on observed_at). Repo:
  `upsertScraptfList(rows)` (one transaction; a row is replaced only when the incoming observed_at is at least the
  stored one; prices rounded to integer scrap; returns the rows written), `scraptfList()`, `scraptfListRow(sku)`,
  `scraptfListSummary()` ({items, newestAt, oldestAt, batches}) and `purgeScraptfListOlderThan(ts)`. The daily
  maintenance job purges rows older than `RETENTION.scraptfListMs` (30 days) and calls `ctx.scraptfListChanged` only
  when it removed some.
- **Write path** (`importSavedPage`, page kind 'items-list' only). Every parsed row whose SKU passes `looksLikeSku`
  becomes a list row keyed by `splitSku(sku).base`, out-of-stock rows included (scrap.tf still buys them). A SKU listed
  twice keeps its first row with a price to buy; a row with neither price is skipped. observed_at is the file time
  capped at now, else the import time. The rows go into the import's own transaction after `createImportBatch`, so a
  failed import leaves neither prices nor list rows. The price path is unchanged: in-stock rows become source 'import'
  prices (a known cost), out-of-stock rows are skipped as prices. `ImportResult.listRows` is the number of list rows
  written (absent for other pages). Bank pages write no list rows. Several saved /items pages merge by SKU, newest
  first; an older copy arriving later changes nothing and announces nothing.
- **Cache** (`domain/scraptfList.ts`). The table in memory, loaded on first use and re-read by `refresh()`. `rowFor(sku,
  K?)` maps any SKU to its base row valued at the caller's key price (else the engine's, read once until
  `keyPriceChanged()`); `keyRow()` is the `5021;6` row's metal prices and never reads the key price, so
  `selectKeyPrice` can read it without a cycle; `version()` grows on every data or key change. No query per row; a
  failed read keeps the last rows and logs once per failure streak.
- **Change path** (core). Rows written: `ctx.scraptfListChanged()` (after `ctx.pricesChanged()`, before the
  `import.done` push) → `scraptfList.refresh()` → `keyQuotesChanged()` (the key row may move the cap; a move of
  1 scrap or more marks everything dirty and drops list valuations) → `holdings.settingsChanged()` → push
  `scraptf.listChanged {at, items}`. It is in `PUSH_EVENTS`, so the service host and the preload forward it. Market rows
  need nothing: they join the list per read.
- **RPC.** `scraptf.listStatus` (no params) returns `ScraptfListStatus`: items, newestAt, oldestAt, pages (distinct
  batches behind the rows), importEnabled (enabled and acknowledged), watchFolder (as configured), watchActive and
  watchError (the watcher's last error, 'Folder not found', or null).

Where the list is read (S4):

- **Live market** (`market.ts`). `toRow` joins the base's row at the read's key price: `scraptfPaysScrap`,
  `scraptfStock`, `scraptfStockLimit`, `scraptfFull` and `scraptfListAt` (`marketListFields`).
  `MarketListResult.scraptf.allItems` is the "All items" chip: the newest row's time and the rows stored.
  `MarketQuery.onScraptfList` keeps only bases on the list. It runs with the buy-side filters, before the verdict counts,
  as in the mock; only a filtered pass keys its cache on `version()`, and membership is remembered per version (about
  85 ms for the first filtered pass at 50k bases, about 11 ms after). The verdict is unchanged (S5): an in-stock list row
  is an import price, a known cost, so the row is *flip* or *over* and never *rule-flip*. An out-of-stock row has no
  import price, so a rule can still decide its verdict; the row still shows stock 0 and what scrap.tf pays.
- **Item detail** (`views.ts`). `ItemDetail.scraptfList` is `rowFor(base, engine.keyPrice().valueScrap)`. An item known
  only from the list opens in the drawer, named from the list when the schema has no name.
- **Holdings** (`holdings.ts`, `shared/holdings.ts`). `rowsOf` passes each held base's row, at the lots' key price
  and judged at now, to `holdingRow`. `bestExitOf`: scrap.tf when its row has a pays price, is not full, is at most
  24 h old (`SCRAPTF_LIST_FRESH_MS`) and pays more than the backpack.tf revenue (or there is none); else backpack.tf
  when there is a revenue. A tie goes to backpack.tf. `exitScrap` drives profit now and all, margin, status and the
  totals' worth now; `revenueScrap` keeps its backpack.tf meaning. A "Sell:" for a scrap.tf exit reads
  `scrap.tf's bank pays <price> (price list saved 12 min ago), +<profit> over your cost`. `notifications.minConfidence`
  gates only backpack.tf exits, because confidence scores backpack.tf buyers (an item only scrap.tf buys would
  otherwise never notify). Such an item has no market entry, so the first `start()` queues one check of the held items
  on the list, and a timer re-checks a scrap.tf 'sell' when its row turns 24 h old, so the next day's save is told as a
  new entry into 'sell' (dedupe across restarts still applies). A failing list read logs once per streak and leaves
  backpack.tf as the only exit.
- **Key price** (`keyprice.ts`). `effectiveScraptfKey` takes the newer of the typed values (`scraptfSellScrap` = what
  scrap.tf pays, `scraptfBuyScrap` = what it charges, dated `scraptfObservedAt`; undated counts as older) and the list's
  key row (dated observed_at); a value the newer source lacks comes from the other one. Only the pays price caps
  automatic values, never a manual one. `KeyPriceState.scraptfFromList` holds the key row's values the cap could use
  (18 to 18,000 scrap, rounded), or null. Without a key row the key price is exactly as in 0.3.
- **Engine.** Unchanged: in-stock list rows already arrive as import prices. List rows are valued at the current key
  price everywhere (the market read's, the lots', the drawer's).

Dashboard:

- **`components/ScraptfListCard.tsx`** (pure helpers in `scraptfListModel.ts`), at the top of the Live market (its
  steps fold away once the sync works, decided once per visit; the user's toggle is remembered) and on the Import page
  (steps always shown). The status line from `scraptf.listStatus` is toned like the coverage chips (15 min, 2 h). The
  steps: Open scrap.tf/items (`openOrCopy` → `links.open`), Ctrl+S into the folder (path and Copy path; from 0.6 with
  the save type, `SaveModeChoice`, F18), and the pick-up
  text. States: import off (steps disabled, "Turn on Import first"), no folder (`import.pickWatchFolder`, then settings),
  watch error, starting. It refetches on `scraptf.listChanged` and `import.done`, on import settings changes and every
  60 s while visible (2 s while the watch is starting); all local IPC.
- **Live market:** "scrap.tf pays" and "Stock" columns before Verdict (n/limit with a Full pill, out of stock struck
  through, full or day-old rows dimmed), the "All items" chip leading the coverage strip (0.4: the static
  `SCRAPTF_ITEMS_URL`, whatever the service sent; from 0.5 it opens the list's card on the banks page, F15), "On scrap.tf's list" in the Source popover, and a refetch on
  `scraptf.listChanged`. Six grid layouts keep the width budget (Category drops at 1400 px, Buyers at 1230, Confidence
  at 1140, Updated at 1060; at 950 Stock folds into the pays cell), pinned by a test that parses `market.css`.
- **Item drawer:** a "scrap.tf price list" block (sells · pays · stock · saved ago, Full and "Over a day old" pills,
  "(plain copy)" for a painted item) with Use as my price (one `prices.upsert`: base SKU, the list's keys and metal,
  source 'user', note 'from scrap.tf list', observedAt the list's save time; disabled when sold out, when the row
  shows stock 0 (the import refuses that as a price, so a typed copy would be a known cost scrap.tf cannot sell;
  `scraptfListUsePrice`), or when already saved: `ItemDetail.scraptfListSaved`, which the service reads from the base
  SKU's plain rows, because a painted drawer's `scrapPrices` never list the plain copy the price is saved under),
  Open scrap.tf/items and Open bank page. **Open on scrap.tf (copies name)** in the drawer header and the ItemMenu copies
  the unpainted name, then opens the item's bank page through `links.open`: from 0.5 the bank page it was last seen on
  (`ItemDetail.seenOn`, F15), else `scraptfPageFor(category)` (pages pass `ItemMenuTarget.category`), else the
  `scraptf-page` link from `links.forSku` when it is one of `SCRAPTF_BANK_PAGES`, else scrap.tf/items.
- **Quick entry:** "scrap.tf list: sells X · stock n, saved 3 min ago" from `item.detail {history:false,
  target:'plain'}`, with Use (not for a sold-out or stock-0 row); saving an unchanged used price keeps the list's date and note.
- **Holdings:** Sells now for shows the exit, with a scrap.tf pill and a second line for the other venue. Record sale
  prefills venue scrap.tf, what it pays in the list's own keys and metal (`HoldingRow.scraptfPaysKeys` /
  `scraptfPaysScrapRaw` through `scraptfSaleInit`, the drawer's and ItemMenu's prefill, so no key scrap.tf does not pay
  is invented; `splitAtKey` only for a row without them) and 'Sold to scrap.tf'. The page refetches on
  `scraptf.listChanged`, and once when the first scrap.tf exit's list row turns 24 h old (`useScraptfExitLapse`; no
  push says so). Until that answer lands, a lapsed exit (`scraptfExitLapsed` at the page's clock) shows as the day-old
  list it is, and Record sale prefills the buyer instead.
- **Settings → Key price:** "From your saved scrap.tf list (3 min ago): scrap.tf sells a key for X, pays Y" with In use /
  Partly in use / Not in use, copying `effectiveScraptfKey` per price (`scraptfListKeySources`, tested against the
  service function). Data health's key price table lists the typed values and the list's key row, each labelled by
  what is used from it (`scraptfKeyHealthRows`: only the row whose pays price is in effect says it caps the automatic
  value), and the top bar's key tip shows that pays price and its source (`scraptfKeyTipText`).
- **Import page:** a list import's result adds "Price list: N scrap.tf items updated…" (`ImportResult.listRows`).
- **Mock:** `seedScraptfList` (most catalogue items; three pages of mixed ages, one 26 h old; out-of-stock and full rows;
  the key row), `scraptf.listStatus`, every new field, and `import.html` of a file named like "items" re-dates the list
  and pushes `scraptf.listChanged` when a row changed.

Decisions and deviations from the F14 spec:

1. Sells prices are nullable (`sells_keys`, `sells_scrap`, `ScraptfListRow.sells*`): a "Sold out" row shows no price to
   buy but still what scrap.tf pays, which can be a holding's exit.
2. "All items" is a separate field, `MarketListResult.scraptf.allItems`, not a `ScraptfCoverage` entry with category
   'all'. `coverage` keeps the seven bank pages of F13.
3. `ScraptfListStatus.watchError` was added for the card's watch-error state.
4. `notifications.minConfidence` applies to backpack.tf exits only (Holdings, above).
5. Only metal prices on the key row are used; a key priced in keys is ignored.
6. Known limits: the list is as fresh as the user's last save, and stock changes between saves. A key row keeps capping
   the automatic key value until newer typed values or the 30-day purge, like typed values (it can only lower it).
   `profitAllScrap` and worth now value every held unit at the scrap.tf exit even when scrap.tf has room for fewer.

## scrap.tf banks (F15)

The spec calls this "F15. Every scrap.tf category"; the UI says "scrap.tf banks". One card per scrap.tf page the user
saves (the seven bank pages and the /items price list): when it was last saved, the flips its prices make and what to
look for there. It adds **no network traffic of any kind** and never contacts scrap.tf (R1). Its data is only what the
user saved with their own browser into the opt-in watch folder (R10, behind the import acknowledgement). Bank URLs come
only from `SCRAPTF_BANKS` (links.ts) and are only handed to `links.open` (`openOrCopy`). `STATIC_EXTERNAL_URLS` is the
0.4 set, byte for byte (a test pins it): `/buy/unusuals` and `/items/<n>` are recognised in saved pages but never
opened. `test/compliance/static.test.ts` treats `SCRAPTF_BANKS`, `SCRAPTF_BANK_PAGES`, `scraptfBankInfo`,
`scraptfSeenOn` and `seenOn` as scrap.tf addresses: passing one to fetch, the HttpClient, a socket factory, an Electron
window or view, or an `src` fails the build, and synthetic files prove each scan sees it.

| Bank | Page | Categories (`bankForCategory`) |
|---|---|---|
| hats, weapons, stranges, killstreaks, skins | `https://scrap.tf/buy/<bank>` | the category of the same name |
| items | `https://scrap.tf/buy/items` | taunts and other (tools, paints, crates, promos), and anything unknown |
| unusuals | `https://scrap.tf/unusuals` (`/buy/unusuals` is recognised too) | unusuals |
| list ("All items") | `https://scrap.tf/items` (`/items/<n>` pages merge) | none (it lists everything, F14) |

- **Bank detection** (`import/scraptfHtml.ts`, S1). `ScrapTfParseResult.bank` is set at both return sites (null on the
  page-not-importable early return). The page's address decides first: the saved-from comment, the canonical link and
  og:url, with web.archive.org nesting followed (`pageKindFromUrl`, `PageHint.bank`); from 0.6 an .mhtml page part's
  Content-Location (`ParseOptions.address`, F18) is read before them. `/buy/<slug>` maps by slug (case
  ignored; extra path segments and queries ignored), `/unusuals[/n]` and `/buy/unusuals` give unusuals, `/items` and
  `/items/<n>` give the list. An unknown `/buy/<slug>` gives null and the page warning `unknown-bank: <slug> …` (slug
  clipped to 40 characters); its items still import and the batch falls back to the majority rule. Only a page with no
  scrap.tf address uses the body id (`pid-buy-<slug>`, `pid-unusuals`, `pid-items`, as the saved fixtures carry them;
  `pid-items` needs list rows, the others need cards). The title can tell the kind (an 'unusuals' or 'items-list' kind
  implies its bank) but never which /buy bank, because the /items list is titled "Item Trading" too. A page saved from
  another site gets null whatever its body id says. Nothing else sets a bank.
- **Every category parses** (S2). One synthetic fixture per bank in `test/fixtures/import/` (`buy_weapons`,
  `buy_stranges`, `buy_killstreaks`, `buy_skins`, `buy_items`, beside 0.4's `buy_hats`, `unusuals` and `items_list`),
  built on `buy_hats.html`'s card markup (DESIGN_BRIEF §3.3) and NetroScript's name rules. `test/import/scraptfBanks.test.ts`
  pins every card's SKU, name, keys and scrap, stock, warning codes, sheen and killstreaker, plus each page's kind, bank
  and warnings, a URL-to-bank table and the body-id fallback. Parser changes the fixtures forced: the `★Unusual ` title
  prefix; an unusual skin (paintkit, wear and effect) keyed as Decorated 15 plus the effect, while a Decorated card that
  the title, a quality5 class or an `Effect:` tooltip line calls Unusual but whose effect cannot be read stays quality 5
  and is refused (`unusual-without-effect`), never given the plain skin's SKU (only an item that exists only as
  Unusual, `SchemaService.itemQuality` 5 such as Haunted Metal Scrap, is keyed `<defindex>;5` without an effect); an
  effect named only in the tooltip reads the title; `War Paint: X (Wear)` titles read as "X War Paint" (paintkit from
  the name, cross-checked against the defindex, which is 16000 + paintkit: a War Paint whose name and defindex disagree
  is refused with `paintkit-mismatch`, in either title form, because one of them is wrong and the name's SKU cannot
  exist); Steam's `Crate Series #N` tooltip line gives the series (`series-mismatch` when the title disagrees,
  `unparsed-modifier` on an item that is no crate); a crate the schema does not know keeps "Series #N", or a bare "#N"
  the tooltip confirms, and a bare "#N" on an unknown item is refused (`series-unresolved`). A crate (card or /items
  row) that shows no series anywhere is priced per series like every crate backpack.tf and PriceDB know: a case with a
  single series takes the schema's (`series-inferred`: the resolver's exact match on the same defindex), any other is
  refused (`series-unresolved`), except the few crates that have none (`SERIESLESS_CRATES`). Strange parts, spells and
  paint stay extras under the clean SKU (the stored copy is flagged `has-extras`); paint cans, sheens, killstreakers
  and parts never reach a SKU; kits and fabricators without a resolvable target are skipped (`needs-target`). An
  unparseable card is skipped with its reason in the import result; a SKU is never guessed.
- **Store** (V5, S3). `importSavedPage` passes `parsed.bank` to `createImportBatch` inside the import's own transaction
  and returns it as `ImportResult.bank`. Every price read joins its batch's bank (`ScrapPrice.bank`, imported rows only,
  see Integration). A later import rewrites the rows it shares in place under its own batch, so the bank moves with them
  (an /items list taking over a bank page's plain rows makes them the list's); the batch keeps the bank it recorded, so
  the coverage strip and the cards' dates do not move.
- **Coverage** (S3). The Live market strip and every per-bank view classify a batch with `batchBankOf` (F13, above): the
  recorded bank, else the majority rule for batches without one. `scraptfBankSaves(batches, categoriesOf)` gives each
  batch's bank and each bank's newest save. The "All items" chip reads the saved list (F14), not the batches: a list
  purged after 30 days is not "saved" there. The list card does too while the list holds rows (below).

**Service** (`src/service/domain/banks.ts`, `createBanksSummary`, S4). One `ScraptfBankSummary` per `SCRAPTF_BANKS`
entry, in that order, built in memory. No query runs per row, and nothing is read until `summary()` asks. Four parts,
each cached until its scope is invalidated:

- **Saves** ('all'): one `listImportBatches(500)` and one `listScrapPrices()`. Per bank page: `lastSavedAt` and `items`
  are its newest save's (`scraptfBankSaves`; file time, else import time; the batch's item count); `pages` is the
  distinct saves behind its prices today plus that newest save even when it stored nothing (only the list's can; a page
  re-saved all day is not "400 pages"); `inStock` is `items` minus that save's rows known to show stock 0 (an import
  stores only cards on sale, so normally all of them). A bank saved only before the 500 batches read, or since then
  only without its cards, is dated and counted by its newest row (the prices still in use). From 0.6 a bank page that
  stored nothing is never a bank's newest save (`isEmptyBankSave`, F18 S3); the /items list that stored nothing (every
  row sold out) still is. The same read builds the imported price id → bank map (the batch's bank, else the joined
  `ScrapPrice.bank`).
- **Flips** ('all', 'flips'): one `queryOpportunities({ status: ['profitable'], inputKinds: ['import'] })`, mapped through
  `inputRef 'price:<id>'` (`opportunityBank`), then `bankFlips`: count, summed profit, the top 3 by profit, then name,
  then SKU. Flips are never rebuilt against an empty map while the saves read fails. From 0.7.1 (UX-2b) a bank page
  with a bank stock save takes its count, top 3 and profit sum from `BankStock.list({ filter: 'flips', sort: 'profit' })`
  (`bankStockFlips`): the card equals its stock page's Flips chip, painted and clean copies counted apart, suspect
  margins included as on the chip. Only the All items card, and a bank with no stock save, keep the opportunity rule.
  `readSaves` merges `repo.bankNewestSaves()` and dates a bank page by its newest whole look (`repo.bankStockSaves(bank, 1)`,
  DC-2) as the strip does, so a partial or unsettled look never dates the card, counts its items or heads its "Not in
  your save".
- **What to look for** ('all', 'market'): `market.uncheckedBy(bankForCategory, BANK_LOOK_FOR, now)`, one pass over the
  Live market's "Not checked" rows (buyers, no scrap.tf price of yours, no rule flip) in its default order: per bank the
  count and the 5 with the highest Pay up to above 0 and a revenue, as full rows (`bankLookFor` cuts and orders them
  as the mock does). It does not evict the Live market page's cached pass; about 20 ms at 50k bases. The list has no
  categories, so nothing to look for.
- **The list card**: `scraptfList.summary()` and `all()` (the same data as `scraptf.listStatus`), keyed on the cache's
  `version()`: newest row, pages (batches behind the rows), items, rows with stock above 0. Its flips are the prices the
  list's import still holds. Those outlive the list's rows: maintenance purges rows older than 30 days but never the
  prices or batches, and a 0.3 database has /items imports as prices with no list rows (V4 is new). So while the list
  holds no rows, the card's saved state comes from the list's batches as for a bank page (newest save, its items),
  and it reads "Stale · saved 31 days ago" above those flips, never "Never saved".
- `importEnabled` (enabled and acknowledged) and `watchActive` are read live on every `summary()`: the watch dies or
  comes back without a settings change.
- A failed read is logged once per failure streak and not cached; the last good part is served. `summary()` never
  throws and returns copies.

**Change path** (core). Invalidation drops the caches at once (a read before the push is already fresh), then the
listeners hear of it once per `BANKS_PUSH_MS` (2 s, trailing throttle), as the push `scraptf.banksChanged { at }`.
Every invalidation is told; the summary is not compared first, because that would compute the lookFor pass on every
market change with no banks page open. Hooks: `ctx.pricesChanged` (every import, manual or folder watch, and every
price, bulk, rule, rules-import and delete write) and `scraptfList.onChanged` → 'all'; the engine's `onChanged` →
'flips' (it re-evaluates imported SKUs about 1 s after an import, so flips are invalidated twice per import);
`market.changed` → 'market'; `updateSettings` with a changed `settings.import` → 'switches'; and the 10 s status tick
(`checkBanksWatch`, also once at start) → 'switches' when the folder watch died or came back. `stop()` drops a pending
push. Maintenance reaches it through `engine.markAllDirty`, `market.markAllDirty` and `ctx.scraptfListChanged`.

**RPC and push.** `scraptf.banks` (params: none, `{}` or null, strict) returns `ScraptfBanksResult` (`banks`,
`importEnabled`, `watchActive`, `generatedAt`). `scraptf.banksChanged` is in `PUSH_EVENTS`: the service host and the
preload allow it and main broadcasts it to every window.

**Item detail.** `ItemDetail.seenOn` (`itemSeenOn`, views.ts) is the newest imported price with a bank (by observedAt,
ties to the higher id; typed prices never count), with that bank's static URL and the price's time. A painted SKU
none of whose own prices was imported falls back to the base SKU's copies from bank pages, never the list. It is on
every `item.detail` path: the drawer, the ItemMenu and quick entry (`history:false`, `target:'plain'`).

**Dashboard** (S5):

- **scrap.tf banks page** (`pages/BanksPage.tsx`, pure helpers in `banksModel.ts`, styles in `styles/banks.css`), the
  nav entry after Live market (`#/banks`; `#/banks/<bank>` focuses that card once). Header: "N of 8 scrap.tf pages
  saved in the last hour", the price list card's import and watch-folder notes (`useScraptfListStatus`,
  `SetupNoteView`; import off, no folder, watch error, starting; until the status is read the banks answer's
  `importEnabled` says import is off), "Save into <folder>" with Copy path, and the boundary note. A responsive grid
  (`minmax(min(100%, 300px), 1fr)`, no sideways scroll) holds one card per bank: an h3 title, the page's path, a
  freshness pill (Fresh up to 15 min, Aging up to 2 h, Stale, Never saved: the strip's tones), "saved 4 min ago · 48
  items (31 in stock)", **Open in browser** (`openOrCopy` → `links.open`, disabled while import is off) with the Ctrl+S
  tip (naming "Webpage, Complete" from 0.6, F18), "Flips from this page: N (+X)" with the top 3 ("Flips from your price list" on the list card), and "What to look
  for" with the top 5 and **See all N not checked**. A row click opens the drawer; right-click or Shift+F10 opens the
  ItemMenu with the card's bank (`ItemMenuTarget.bank`). Keyboard: one tab stop for the grid; the arrows (up and down
  by row of the wrapped grid), Home and End move between cards; Enter on the card itself opens the page once per press
  (not per key repeat), or says import is off. Labels and URLs always come from `SCRAPTF_BANKS`, whatever the service
  sent (unknown, repeated and `__proto__` ids are dropped).
- **Live refresh.** `useVisiblePush('scraptf.banksChanged')` through a 2 s throttle (`BANKS_REFRESH_MS`), only while the
  window is visible (one catch-up when shown). `createBanksLoader` keeps one read in flight and coalesces a burst into
  one follow-up read; because reads never overlap, an older answer can never replace a newer one (`generatedAt` is not
  compared: a service clock stepped back would freeze the cards). Unmount and StrictMode dispose it.
- **See all** goes to `#/market/bank/<bank>` (`marketBankPath`; none for the list). `marketRouteIntent` turns it into
  the bank's categories plus the Not checked verdict with the default sort (Pay up to, highest first), every other
  filter reset, applied during render so the first `market.list` already carries it (the route's empty search and
  minimum are used, not the debounced saved ones, so no second read follows); `history.replaceState` then swaps the
  address back to `#/market`, so Back returns to the banks page.
- **Live market strip.** Every coverage chip, and the All items chip, opens its card on the banks page
  (`coverageBank`: by static URL, else by category) instead of the browser.
- **Item drawer.** "· Seen on scrap.tf/buy/stranges · 12 min ago" under the SKU (`seenOnText`, the static path), and
  every "Open bank page" and "Open on scrap.tf (copies name)" goes to where the item was seen (`bankPageUrl`,
  `scraptfOpenUrl`), else its category's bank. A price last seen on the /items list says so, and its bank page stays
  its category's.
- **ItemMenu.** A target that names its bank uses it; otherwise the menu reads `seenOn` once on open with a local
  `item.detail {history:false}` and the category's bank stands in until it answers.
- **Import page.** The result names the page it counts for ("scrap.tf page: Stranges · scrap.tf/buy/stranges", or "Not
  recognised", `importBankText`), and the history's Page column adds the bank of batches that recorded one. From 0.6
  a bank page that stored nothing reads "Hats · scrap.tf/buy/hats · not counted" (F18).
- **Mock.** Seeded batches carry banks (hats 4 min, unusuals 12 min, stranges 70 min, the list 2 h, weapons 5 h,
  killstreaks 26 h; skins and items never saved). Seeded imported prices belong to their bank's batch (else the list's)
  and are dated at its save. `scraptf.banks` uses the shared rules (`bankFlips`, `bankLookFor`) and counts pages as the
  service does; in-stock counts on bank pages are made up (65 %). `scraptf.banksChanged` is emitted unthrottled after
  every price write and import, every `market.changed` and an import settings change. `ScrapPrice.bank` is joined for
  imported rows only, and `seenOn` follows `scraptfSeenOn`.
- **Tests.** Besides the unit tests per module: `test/import/importBank.test.ts` runs the real parser over all eight
  fixtures through `importSavedPage` (bank on the batch and on every stored price); `test/service/banksFixtures.test.ts`
  takes the same eight saves through the real engine into the summary (lastSavedAt, items, inStock, flips), the
  coverage strip and `seenOn`; `test/service/banksCore.test.ts` runs the real core (RPC, push throttle, watch tick).

Decisions and deviations from the F15 spec:

1. The list's saved state (its card and the All items chip) comes from the saved list (F14), not from the import
   batches, so it agrees with `scraptf.listStatus`. Only while the list holds no rows does the card fall back to the
   list's batches, so it agrees with the flips it lists (see The list card).
2. In 0.5 a recognised page that stored no item counted as a save, so a page saved before its items loaded read Fresh
   with 0 items. From 0.6 (F18 S3) only the /items list counts with nothing stored: a bank page that stored nothing
   keeps its bank on the batch but dates nothing, and the card stays on the save before it.
3. `pages` counts the saves behind a bank's current data plus its newest save, not every save.
4. Pushes are not compared with the last summary before sending (see Change path); the page throttles its refetch.
5. Bank detection falls back to the body id only; the title never names a /buy bank.
6. The mock leaves two banks never saved (skins and items), not one, because a mock test pins the strip with both.
7. `ImportResult.bank` is shown on the Import page, beyond the spec.
8. Known limits: README "Known limits" (fixtures synthesized from public markup, not live pages; strange skins' SKU
   followed the card's quality class until 0.7.1, which keys every skin the backpack.tf way, P2; re-tagging moves a
   price's bank).

## Live check (F16)

The spec calls this "F15 Live check"; F15 in this codebase is the scrap.tf banks page, so code comments say **F16** and
the UI says "Live check". The user copies an item while browsing scrap.tf (its name, or a row of scrap.tf/items) and sees
its flip at once: the price, what it sells for on backpack.tf, a verdict and Pay up to.

**Boundary.** The feature adds **no network traffic of any kind**. It never contacts scrap.tf (R1): no polling, fetching or
headless browser, no embedded view, `/ajax`, `ws.scrap.tf` or userscript. Nothing is injected into the user's browser, and
the app never reads the browser's DOM, history or windows (R3). A scrap.tf link in the copied text is answered as not an
item and is never resolved or opened. The only input is the user's own clipboard, read locally (R10), and the evaluation
reads only the local order book (`item.detail {history:false}` semantics) and the saved scrap.tf list.

**Clipboard rules** (local only, never logged; enforced in code and tested):

- Main reads plain text only, with Electron's `clipboard.readText()` (a promise in Electron 44). HTML, RTF, images,
  bookmarks, buffers, `read`, `availableFormats` and `has` are never called, and renderers never read the clipboard (they
  only write copies). It is read in two cases only: once per press of the check hotkey, and every 700 ms while the
  opt-in watcher is on.
- `shouldCheckClipboardText` runs in main before the text leaves main, on both paths. It refuses empty text, more than
  400 characters, `<` (page markup), more than 3 non-blank lines, text without a letter or digit, and anything that looks
  like a secret: a space-free token of 20 or more characters mixing two of letters, digits and symbols, a 32-hex (Steam)
  or 24-hex (backpack.tf) key, a URL with credentials, a query or fragment parameter whose name contains key, token,
  secret, pass, pwd, auth, sig, credential, session or code, or a 13 to 19 digit number passing Luhn. Exempt from the
  token rule: a valid SKU, an item link (`shared/itemUrl.ts`, the hosts and paths `parseItemUrl` reads, with only
  next.backpack.tf's item query keys, an optional trailing separator before a price) and a scrap.tf link without a
  query; neither may have a login or fragment, and no decoded path segment or query value may itself be such a token.
  Every other link is a long mixed token, so a webhook, OAuth callback or signed download is refused (reason `link`,
  `CHECK_REFUSALS.link` on the hotkey). The watcher also skips the text it saw last, compared as an HMAC-SHA256 with a
  per-process random key; the text itself is never kept.
- The text goes in memory to the local service's `check.text` and nowhere else. It is never logged, persisted, or put
  into a reason, an error, a CheckResult, the popup or a notification: those are built from the resolved item or fixed
  texts (`src/shared/check.ts`). Log lines on this path carry fixed messages and error class names. `check.text`'s zod
  messages are fixed, and anything thrown past validation is logged by class and rethrown as `CHECK_FAILED_MESSAGE`.
- A renderer's `check.text` must say `source: 'manual'` (ipc.ts, `CHECK_TEXT_SOURCE_REFUSAL`): 'hotkey' and 'watch' mean
  main read and filtered the clipboard.
- Tests: `test/compliance/clipboard.test.ts` (no rich read anywhere; exactly one Electron read, the reader main.ts hands
  to `createLiveCheckMain`, called only from the watcher's `poll()` and the hotkey's `checkForHotkey()`; the filter before
  the text leaves main on both paths; the live check modules' log calls may name only error classes and the resolved
  SKU; main's wiring names no text in a log call), `test/main/liveCheckMain.test.ts` (the real main logger with the text
  in every failure path), `test/main/clipboardWatch.test.ts` and `test/service/liveCheckRpc.test.ts` (the service log
  files on disk).

**Service** (`src/service/domain/liveCheck.ts`):

- `parseCheckText(text, resolve, opts?)` is pure. Refusals come first (`checkTextRefusal`), then a scrap.tf link (not-item),
  then the forms in order: a copied /items row (fields split on tabs or runs of 2+ spaces: the name, optionally after an
  icon cell; "Price to buy", a price or "Sold out"; "Price we pay"; n/limit, "n of limit", n and limit as two cells, or
  wrapped onto the next lines; a selected header row and labels such as "we pay:" are ignored); the item alone (a name,
  SKU or backpack.tf / marketplace.tf item URL, exact matches first); `<item> <sep> <price>` through the bulk paste grammar
  (`parsePriceLine`, bare numbers in ref; tried before the item alone when a link is followed by more text, because as
  one URL the price would land in its last path segment); two lines, name then price or "Sold out". At most
  `CHECK_MAX_RESOLVES` (8) resolver calls per text, memoised; a resolver error counts as no match.
- A closest-match (fuzzy) name is accepted only when it is the item's own name apart from case, spacing, punctuation,
  accents and a leading "The" (scrap.tf writes "Bills Hat"), or when `confirmFuzzy` says it is unique: core uses
  `schema.search(itemText, 2)` returning exactly one hit with the same base SKU, at most 2 searches per check. Anything
  else is not-item: a wrong item would be a wrong flip. Exact matches the resolver flagged (an unusual without its effect, a
  crate without its series, an unknown paint) are checked as the general item with a fixed note; the resolver's own
  warnings are never passed on, because they can quote the text.
- Evaluation is `buildItemDetail` with `history: []`, `target: 'plain'` and `scraptfList: rowFor(base, K)`, the
  `item.detail {history:false, target:'plain'}` path: no request. The price (`chooseCheckPrice`) is the copied one first,
  else the saved list's price to buy (`scraptfListUsePrice`; plain SKUs only, as the list prices plain copies), else the
  newest typed or imported price (`newestStoredPrice`, a copy without extras first for a plain SKU; when a plain SKU has
  only copies with paint, spells or parts, the newest is still shown but `CHECK_EXTRAS_NOTE` joins the notes, as the Live
  market flags that row `has-extras`). A copied "Sold out"
  or stock-0 row has no price at all: it is newer than anything stored. What scrap.tf pays comes from a copied pays cell
  (even a dash, which means nothing now), else the list; stock and limit from the copy, else the list. `listAt` is set
  when the list supplied any of them. Profit is revenue minus cost minus `frictionOf(settings.profit)`, margin is profit
  over cost, and `profitStatus` gives the verdict (profitable is `flip`, no-buyers `no-buyers`, anything else `over`;
  `no-price` without a price). Pay up to is `revenue.maxCostScrap` (`maxCostFor`). Confidence is the Live market entry's;
  without one but with an eligible revenue order, `evaluateMarketBase` scores the base on demand over the local book,
  exactly as the entry would be scored. Before the schema has loaded, a name that does not resolve gets
  `CHECK_SCHEMA_LOADING_REASON`. Item notes (`CHECK_FUZZY_NOTE`, `CHECK_INCOMPLETE_NOTE`, `CHECK_SOLD_OUT_NOTE`,
  `CHECK_EXTRAS_NOTE`) go in `reason`, in that order.
- An in-memory ring keeps the last 30 item results (copies, never text), newest first; a restart empties it. The
  `check.text` handler pushes `check.done` for every item result.

**RPC and pushes.** `check.text {text (at most 400 characters), source}` and `check.recent` are service methods
(from 0.6 `check.text` also takes main's optional `hint`, and main has `check.arm`, F19).
`app.hotkeys` (main) returns both global hotkeys' registration (`{ accelerator, registered, error }` each).
`app.showQuickEntry` takes an optional `price` text (trimmed, 1 to 60 characters, no control characters, `<` or `>`),
passed on only with a SKU as `ui.quickPrefill { sku, price }`. `check.done` is in `PUSH_EVENTS` and reaches every
window (the Recent checks panel listens; the popup ignores it). `ui.checkShow` is main's own (`MAIN_ONLY_PUSH_EVENTS`):
the preload holds it until the popup page subscribes, and `showCheck` holds it until `did-finish-load`; the latest wins.

**Main** (`src/main/liveCheck.ts`, `clipboardWatch.ts`, `hotkeys.ts`, `settingsStore.ts`, `windows.ts`, `tray.ts`):

- **Settings group `check`**: `hotkey` ('CommandOrControl+Alt+C'; validated like the quick-entry hotkey, '' turns it
  off), `watchClipboard` (false), `notifyFlips` (true), `popup` (true). One chord cannot be both hotkeys
  (`sameAccelerator`): an update is refused with `CHECK_HOTKEY_CONFLICT`, and a lenient load turns `check.hotkey` off. A
  changed hotkey is registered before the change is committed, so a refused chord throws `SettingsValidationError` (shown
  in Settings), nothing is saved and the old one keeps working; a patch that changes both releases both, then registers
  both; a failed save undoes the registration. A stored hotkey another app holds at start-up gets one desktop notice for
  both hotkeys, a tray tooltip line, and Settings shows it through `app.hotkeys`.
- **Hotkey** (`createLiveCheckMain().hotkey()`): reads the clipboard once and filters it; a refused text, a service that
  is not ready and a failed or malformed answer each show a fixed reason. Otherwise `check.text {source:'hotkey'}` with a
  10 s timeout. The popup always shows (the `popup` switch governs the watcher only), focused when the answer came within
  2 s (`CHECK_HOTKEY_FOCUS_MS`) and without focus after that, so a late popup cannot catch keys typed elsewhere (Enter
  saves, B records a buy). A held chord repeats, so key events less than `CHECK_HOTKEY_MIN_GAP_MS` (1.1 s, longer than
  Windows' longest key-repeat delay) apart are one press, measured from the last event: a held key checks once, and the
  next press counts after a quiet gap. The copy is marked as seen so the watcher does not show it again.
- **Watcher** (`createClipboardWatch`): started and stopped by `syncWatch()` on every settings change and after the
  start-up effects; never in a smoke test, which also registers no hotkey. It polls every 700 ms. The first read after a
  start or a pause only records the hash, so what was already on the clipboard is never checked. It reads nothing while the
  session is locked or the machine suspended (`createSystemPause(powerMonitor)`) or the network is paused. Async reads
  never stack, and one unsettled for 10 ticks is abandoned. One check is in flight at a time; the newest copy waits in
  memory and older waiting copies are dropped; a copy is dropped while the service is down, and a reply after a stop is
  ignored. Only item results act: the popup with `showInactive` when `popup` is on, at most one per 1.5 s, the newest
  waiting result replacing older ones; and for a flip, when `notifyFlips` and `notifications.enabled` are on, a desktop
  notification (`flipNotification`, from the result only; `silent` applies; a click opens the drawer; never for a price
  from a copy with extras, `checkPriceIsOtherCopy`), once per SKU per minute. One sequence number across hotkey and watcher keeps an older result from replacing a newer one.
- **Popup window** (kind `'check'`, `CHECK_URL`): 380 x 220, frameless, always on top ('floating'), off the taskbar, placed
  bottom-right of the work area of the display under the cursor (16 px margin) on every show. Same sandbox, context
  isolation, CSP, preload and trusted-sender checks as every window (an `app://app/` page). Never hidden on blur: the page's
  10 s timer and Esc call `app.hideWindow`, and Details and Quick entry… hide it in main. A dead renderer is rebuilt on the
  next show. `broadcast` reaches it (theme, prices), `destroyAll` includes it.
- **Tray**: a "Clipboard check" checkbox sets `check.watchClipboard` (turning it on shows `CHECK_PRIVACY_SENTENCE` as a
  notice); `menuKey` includes the flag. The tooltip says "Clipboard check on" (or "paused" while the network is paused)
  and "Live check hotkey unavailable".

**Renderer**:

- **Popup** (`pages/CheckPopup.tsx`, pure helpers in `checkModel.ts`): the item name in its quality colour and the category;
  "scrap.tf <price> (copied / saved list 3 min ago / your price / imported page)" with stock n/limit and a Full pill;
  "Sells for <revenue> to <buyer> (bot/human, online)" with the buyer count; the verdict pill (Flip +X (margin), Over by Y,
  Not profitable, No buyers, No scrap.tf price); Pay up to, always, leading for no-price; the compact confidence badge. Save
  price is one `prices.upsert` (source 'user', note 'live check', dated at the copy or the list's save); Bought it one
  `journal.add` buy on venue scrap.tf with an Undo toast (`journal.delete`); Details `app.openItem`; Quick entry…
  `app.showQuickEntry { sku, price }` (`formatKeysMetal`). With `CHECK_EXTRAS_NOTE` (a painted or spelled copy's price on a
  plain check) Bought it is off, Quick entry… passes the SKU only and the price tooltip repeats the note, so the plain item
  is never booked or saved at that price. Each writes once per result (keyed by id and check time, since ids
  restart with the service). Keys: Enter, B, D, Esc (not with Ctrl/Alt/Win, not repeats, not in a text field; a focused
  button keeps its own Enter). It hides 10 s after each result, held while hovered, keyboard-focused or showing an Undo,
  and resumes with at least 3 s. Not-item and refused results show the reason and `CHECK_HINT`.
- **Quick entry** fills its price field from `ui.quickPrefill.price` when `prefillPriceText` accepts it (parsePrice reads it).
- **Recent checks** (`RecentChecks` on the Live market): collapsed by default (remembered); `check.recent` on mount and on
  opening, then `check.done`, deduped by id and check time, newest first, 30 at most; a click opens the drawer. Its box
  sends `check.text {source:'manual'}` (at most 400 characters) and lives in component state only.
- **Settings → Live check** (`CheckSection`): every `check.*` setting. The hotkey field (conflict checked both ways)
  shows main's registration from `app.hotkeys` (re-read on every `settings.changed`), or the last save's refusal; the
  quick-entry field shows its own registration failure the same way. The watch switch carries the privacy sentence and
  "Off by default"; Test checks `CHECK_SAMPLE_TEXT` as a manual check and shows the result inline.
- **Mock**: `check.text` (`mockCheck.ts` follows the service's price choice and notes), `check.recent`, `check.done`,
  `app.hotkeys`, the hotkey conflict refusal, `#/check?demo=flip|over|no-price|not-item` for the popup in a browser, and
  quick entry's price prefill.

Decisions and deviations from the F15 Live check spec:

1. `CheckResult.verdict` is nullable (non-items have none); `id`, `source`, `keyScrap` and `CheckPrice.observedAt` were added.
2. Reasons and item notes are fixed texts in `src/shared/check.ts`, so the service, main and the mock word them alike and
   none can quote the text.
3. A copied row showing stock 0 counts as sold out, as `scraptfListUsePrice` and the saved-page import read it; a copied
   pays cell, even a dash, wins over the saved list's.
4. A painted check never takes the list's price (the list prices plain copies); it still shows the list's pays and stock.
5. The hotkey popup takes focus only for an answer within 2 s; the `popup` switch governs the watcher only.
6. A renderer may send manual checks only; `app.hotkeys` was added so Settings can show a hotkey taken at start-up.
7. Known limits: README "Known limits" (the default chord equals AltGr+C on some layouts; the app's own copy buttons
   trigger the watcher, which from 0.6 no longer holds for "Open on scrap.tf" and the Live market's scrap.tf button, F19;
   a password manager's "do not monitor" clipboard mark cannot be read with plain text only).
8. A plain check whose only stored prices are copies with extras keeps the newest one (the contract: a clean copy
   first, else the newest) but says so with `CHECK_EXTRAS_NOTE`, and nothing acts on it as the plain item's cost.
9. Main's filter lets only item links and scrap.tf links past the long-token rule, not every http(s) link: any other
   link can carry a token in its path or under a query name of its own. Such a link is refused with its own reason
   (`link`), so the hotkey does not call it a password.
10. Presses of the check hotkey are debounced over 1.1 s, not 250 ms, so the OS key-repeat delay of a held chord is not
    read as a release.

## scrap.tf bank stock (F17)

Every item on every scrap.tf bank page the user saved, what changed between their two newest saves of that page, and
each item joined to live backpack.tf data. F15 is the banks page and F16 the live check, so code comments say **F17**.

**Boundary.** The feature adds **no network traffic of any kind** and never contacts scrap.tf (R1): no fetch, polling,
headless browser, embedded view or userscript (R3). `/buy/*` needs the user's Steam login behind a Cloudflare challenge,
and the terms forbid automation and external tools. The only data is pages the user saved from their own browser into
the opt-in watch folder (or picked on the Import page), behind the import acknowledgement (R10). Each save is a
snapshot of what the bank had **at that moment**; nothing is known between two saves. Bank URLs come only from
`SCRAPTF_BANKS` / `scraptfBankInfo`, are handed only to `links.open` through `openOrCopy`, and the allowlist
(`STATIC_EXTERNAL_URLS`) is unchanged. `BankStockResult.url` is that same static URL, but the page takes its label and
URL from `SCRAPTF_BANKS`. The rules live in `src/shared/bankStock.ts`, shared by the service, the dashboard and the mock.

**Store** (schema V6, S1). `bank_stock` (batch_id, bank, sku, special_key DEFAULT '', name, cost_keys, cost_scrap,
stock, asset_id, page DEFAULT ''; primary key (batch_id, sku, special_key); index (bank, batch_id)). `page` is which
page of its bank the save is (`ScrapTfParseResult.page`, `scraptfPageKey`: the scrap.tf path lower-cased with no
trailing slash, query or hash, `/buy/unusuals` and `/unusual` as `/unusuals`, so `/buy/hats`, `/items/2`,
`/unusuals/378`; a file with no scrap.tf address gets its body id, which never equals a path; at most 200
characters), the same on every row of a batch. `sku` is the base SKU and
`special_key` the import's extras key (`bankStockSpecialKey`: '' for a clean copy, else the JSON of paint, sorted
spells, sorted parts, sheen, killstreaker, name and description tags, with the SKU's paint moved in), so painted and
spelled copies are rows of their own and match across saves. A row with no price to buy stores NULL costs.

- **Write path.** `importSavedPage` writes, for a recognised page (`parsed.bank` set: the seven bank pages and the
  list), every parsed card or /items row with a SKU, sold out included, in the import's own transaction after
  `createImportBatch` (`bankStockRowsOf`). Cards without a SKU stay skipped. A key on several cards takes the price of
  its cheapest card on sale (else its first card) and the stock of all its cards on sale added up (null when one of
  them shows no count): scrap.tf stacks identical copies as one "3x" card but shows a reserved copy on a card of its
  own, and the parser already drops the selected-item duplicates. Invariant (tested): the rows on sale are exactly
  the prices the import stored. A recognised page that stored no row with a SKU writes no bank stock save, so a page
  saved before its items loaded does not read as "everything gone" (from 0.6 it dates no F15 card either, F18 S3). As
  a second guard, `bankStockPagePairs` skips any save known to hold 0 rows (`BankStockPageSave.items`), so such a save
  is neither a page's newest nor its previous one.
- **Retention.** From F20 `pruneBankStock(now, opts?)` thins each bank page's saves for price history
  (`bankStockThinning`, see "scrap.tf history (F20)", S1), still per bank and page, and never removes a page's newest
  save or the save it is compared with. It runs after every import (a failed prune only keeps old saves longer; the
  orphan sweep is maintenance's) and in the daily maintenance job, which calls `ctx.bankStockChanged()` when it
  removed rows. Until F20 it kept each page's 10 newest saves for 30 days.
- **Repo.** `insertBankStock(batchId, bank, rows, page?)`, `bankStockSaves(bank, limit?, opts?)` (newest first: file
  time, else import time; ties to the higher id; with each save's page; F20: `{ perPage }` keeps each page's newest
  `perPage`, page by page, the page saved last first), `bankStockRows(batchId)`, `bankStockLatestPair(bank)` and
  `pruneBankStock(now, opts?)`.

**Diff** (S2, `diffBankStock`). **Per page** (`bankStockPagePairs`, F17-C1): several pages give one bank (`/items` and
`/items/<n>` the list, `/unusuals` and `/unusuals/<n>` the unusuals), and two different pages compared as two saves of
one page read as everything on the second "new" and everything on the first "gone", with "New on scrap.tf" toasts for
items that had not changed. So each page's newest save is compared with the newest kept save **of that page** from
**strictly before** it (`previousOf`): a save at the newest one's own time is the same file imported twice (the Import
page's picker on a page the folder watch took), and a page compared with itself would wipe every change. A page's first
save compares with nothing. The bank shows its pages together (`bankStockMergePages`, newest page first): an item on
several pages shows once, from the newest page whose newest save lists it, else as gone from the newest page that lost
it, so an item that moved to another page of the list is not gone from the bank (it can still read as new on the page it
moved to). At most `BANK_STOCK_MAX_PAGES` (50) pages of a bank are read. Rows are matched by SKU + special key. **On
sale** = a price to buy and stock not known to be 0.

- **new**: on sale now, absent or not on sale before (a sold-out item back on sale is new). **gone**: on sale before,
  absent or not on sale now. **cheaper / pricier**: on sale in both with another raw keys + metal, the direction decided
  at the current key price (equal value in other currencies goes by keys), so a key price move alone is never a change.
  A stock move alone is no change; `previousStock` carries it ("5 → 3"). First save: every change null.
- A row shown is on sale now, or gone (at its **last price**, from the previous save; `stock` is the newest save's: 0
  when still listed sold out, null when absent). Sold out in both: not shown.
- Each row is joined per read to the Live market entry of its base SKU (`market.entryFor`): revenue, revenue order,
  buyers, Pay up to and confidence. `profit = revenue - cost - frictionOf(profit)`, `margin = profit / cost` (null for a
  free item), verdict `profitStatus` mapped to flip / over / no-buyers. A row with extras is flagged and its Pay up to is
  for a clean copy.
- Counts are over the whole bank, **ignoring filter and search**: `items` = rows on the pages' newest saves (sold out
  included, each item once), `inStock` = the 'all' chip, `flips` exclude gone rows. 'all' never lists gone rows, 'gone' only them, 'changed' =
  cheaper + pricier. Sort: profit descending by default, `cost` and `name` ascending; missing values last both ways;
  ties by name then key.

**Cache** (`domain/bankStock.ts`, `createBankStock`). Loaded on first use; `refresh()` (core: after an import that wrote
bank stock, after maintenance pruned some, and on a key price move of 1 scrap or more) reads each bank's kept saves
(one `bankStockSaves` per bank, each page's `BANK_STOCK_KEEP_SAVES` newest: F20 keeps up to 300 saves a page, so a cap
on the bank's newest saves overall could leave a quiet page, or its compare save, out while the history and the feed
read it) and only the rows of a save not read yet (rows never change once written, so they are
cached by batch id and dropped when no longer one of a kept pair). It keeps each page's diff at the engine's key price,
merged per bank, `bankStockNewAt` and `bankStockItemOf` over every page (each dated by its own save) and a `version()`
that grows only when a diff changed. A bank's answer is dated by its newest page (`savedAt`), with `previousSavedAt` the
earliest previous save among its pages (every change shown is since then) and, with several pages, `pages` and
`oldestSavedAt` (the stock page's header says "2 pages, oldest saved 2 h ago"). `list`, `all`, `whatsNew` and
`newFlips` join the kept diff rows to the market entries per call, with **no query per row** and no network; categories
are memoised per refresh and dropped when the schema loads. A failed read keeps the last good diffs, is logged once per
failure streak and is retried at most every `BANK_STOCK_RETRY_MS` (10 s) by reads, at once by `refresh()`. Nothing
throws.

**Session baseline** (0.7.1, CQ-2; covers DM-4's core symptom). A window reads a page every 30 s or more, so "the
previous save" was often half a minute old and the next read emptied "What's new" and the New badges. A session is a
run of a page's saves less than `BANK_STOCK_SESSION_GAP_MS` (30 min) apart; `bankStockBaselineOf` gives the newest
save from before the newest save's session, else the save just before the newest (a page's first session). Each
page's pair carries `baseline` (up to `BANK_STOCK_SESSION_READ`, 1,000, saves are read per page for it; `saves` still
counts at most 10). In the cache each page keeps two diffs: `diff` (newest vs baseline) feeds the stock page, its
chips and counts, `whatsNew`, `newAtFor`, `detailFor` and `seenFor`, and `previousSavedAt` is the baseline's time;
`stepDiff` (newest vs previous) feeds `newFlips` and the S3 notifier, so toasts stay per read. `scraptf_events` are
still written per read (F20). For daily file saves the baseline is the previous save, as before. `pageFlips(bank,
batchId)` (UX-3) reads the newest save's own rows on sale with verdict flip and no suspect margin, most profit first,
for a batch that is the first of its page's newest look. Staleness (DM-5): pages whose newest save is more than
`BANK_STOCK_OLDER_PAGE_MS` (48 h) older than the bank's newest page drop out of counts, chips, `whatsNew` and
`previousSavedAt` (`bankStockCurrentPages`; the newest page always stays) and are reported as
`BankStockResult.olderPages` { count, newestSavedAt }; history, the feed, `detailFor` and `seenFor` keep every page.
`bankStockNewAt(banks, now)` skips banks whose newest save is over `BANK_STOCK_NEW_MAX_AGE_MS` (24 h) old, and the
cache moves `version()` when a bank turns stale so the market's cached New pass filters again.

**RPC and push.** `scraptf.bankStock` (`BankStockQuery`, zod: bank required, filter and sort enums, dir, search up to
200 characters, limit 1-2000 with default 200, offset 0 or more) returns `BankStockResult` (label, url, savedAt,
previousSavedAt, saves, counts, rows, total, keyPrice, generatedAt). `opps.exportCsv {kind:'bankStock', bankStock}`
drops paging and writes `flipdesk-bank-stock-<bank>-YYYY-MM-DD.csv` (sku, name, category, extras, change, scraptf_price,
previous_price, stock, previous_stock, sells_for, buyer, buyers, pay_up_to, profit, margin, verdict, confidence). No new
push: after a bank import core refreshes the cache, runs the notifications, then invalidates the banks summary, so the
existing `scraptf.banksChanged` follows (2 s throttle). Push order on import: `bankStockChanged` → `pricesChanged`
(`prices.changed`) → `scraptfListChanged` → `engine.markDirty` → `import.done`; a failure in the first is logged and
does not stop the rest.

**Readers.**

- **Banks summary** (`banks.ts`). `ScraptfBankSummary.whatsNew` = `BankStock.whatsNew(bank)`, read live on every
  `summary()` (not inside a cached part): new, newFlips, gone, cheaper, pricier and `since` (the previous save; from
  0.7.1 the session baseline, below), or null with fewer than 2 saves. A failed read is logged once and shows null.
- **Live market** (`market.ts`). `MarketRow.scraptfNewAt` = `bankStockNewAt` of the base SKU (the newest save of any
  bank in which any copy of it is new), joined in `toRow`. `MarketQuery.newOnScraptf` keeps only such rows
  (`marketNewSideMatches`), with the other source filters and before the verdict counts, as the mock does; only a
  filtered pass keys its cache on the bank stock `version()`. The dependency is optional and late-bound in core (the
  cache reads `market.entryFor`).
- **Item detail** (`views.ts`). `ItemDetail.bankStock` = `bankStockItemOf`: the **exact copy** (a plain SKU never takes
  a painted row), from the newest bank save that lists it (ties: on sale, then listed sold out, then gone). A copy absent
  from a bank's newest save but in its previous one reads `change: 'gone', stock: null`, dated by the newest save.

**Notifications** (S3, `notifyNewBankFlips`, `createNewFlipNotifier`). After an import wrote a bank's save, and only
when that batch is the first import of its page's newest look (the page's newest kept save, or the lowest batch id among
the page's saves at that time: the same file imported again is no new look) and the page has a previous save
(`BankStock.newFlips`, judged by the look rather than by the newest batch id, F17-C2): the rows of that page's diff that
are new and a flip, most profit first. Gates:
`notifications.enabled`, `notifications.newOnScraptf` (default true), 'import' in `notifications.inputKinds` (read as
`notifyKinds` reads it), `minConfidence` (the buy side's) and `minProfitScrap`. A suspect margin is never notified: F5's
rule (`isSuspectMargin`, shared with `scoreConfidence`) over the market entry's `eligibleCount` and `referenced` (a
usable PriceDB or community price, age-gated). Dedupe per bank and base SKU for 30 min (a painted and a clean copy new on
one save are one notification), saved before the push in repo meta `bankStock.lastNotified` and expired by age. At most
3 toasts `New on scrap.tf (<Bank>): <name>` / `<cost>, sells for <revenue> to <buyer>, +<profit>` (`sku` set), then one
`+N more new flips on scrap.tf/buy/hats` with body `From the page you saved. Open TF2 Flip Desk to see them.` (`sku`
null). Main applies `notifications.silent`. From 0.7.1 (ACT-6) the notifier reads the told batch's save time
(`BankStock.savedAtOf`): a save older than `profit.inputStaleMs` (a catch-up import at start, an old file picked
later) gets one summary toast, "3 new flips in your save of scrap.tf/buy/hats from 2 d ago"
(`bankStockOldSaveNotice`), and no per-item toasts; a save `BANK_STOCK_NOTIFY_AGE_NOTE_MS` (15 min) old or more adds
"; in your save 40 min ago" to each body (`bankStockSaveAgeText`).

- **Held until the Live market has built.** The verdicts read market entries, which do not exist before the first
  build; the folder watch's catch-up at start runs right then. Every such import is held (per bank, each batch: the
  newest look may have come first and an older page or the same file again after it) and notified on the next
  `market.changed` or 10 s status tick after the build; `newFlips` lets only the first import of each page's newest look
  through, so that look is told exactly once and a save no longer its page's newest tells nothing. A market whose
  status cannot be read notifies at once.
- **One toast per find, both ways.** The engine judges the same new import price about a second later and would toast
  `Profit: <name>` too. The notifier remembers (in memory) the base SKUs it told of, the summary's included, for 30 min,
  and core passes `EngineDeps.toldElsewhere` = an 'import' opportunity of such a SKU: the engine records it as notified
  (dedupe map, no 'notified' event) and sends no toast. On the held start-up path the engine comes first (it runs 1 s
  after the import, the held notification only after the market's first build), so the engine reports every opportunity
  it toasted, the summary's included (`EngineDeps.notified`), and core hands the 'import' ones' base SKUs to
  `newFlipNotifier.toastedElsewhere`: for 30 min such a row is recorded in `bankStock.lastNotified` but not toasted
  (`BankStockNotifyDeps.toldBefore`, F17-C3). A failing check either way toasts as before.

**Dashboard.**

- **Banks page cards** (U1, `banksModel.ts` `bankWhatsNew`): "Since your save 3 h ago: **5 new** (2 flips) · 3 gone ·
  2 cheaper · 1 pricier" (zero counts left out), "First save: save it again later to see what changed" when `whatsNew`
  is null and the page was saved, nothing for a page never saved; a **View stock** button on every card →
  `#/banks/<bank>/stock` (`bankStockPath`).
- **Bank stock page** (U2, `pages/BankStockPage.tsx`, helpers in `bankStockModel.ts`, `styles/bank-stock.css`, the last
  sheet `index.css` imports). App reads the route with `bankStockRouteBank(segments)` and renders the page keyed by
  bank, under the scrap.tf banks nav entry; an unknown bank stays on the banks page. Header: back to "All scrap.tf
  banks" (`#/banks/<bank>`), "<Bank> stock" and its path, the freshness pill (after the first answer), "saved 12 min ago
  · N items (M in stock) · previous save 3 h ago" (or "first save"; with several pages of the bank "· 2 pages, oldest
  saved 2 h ago" after the time), the import and folder notes (`SetupNoteView`),
  **Open in browser** (`openOrCopy(info.url)`, disabled while import is off), the Ctrl+S tip (with the save type from
  0.6, F18), the "Save into" folder and
  the boundary line plus the snapshot note. Toolbar: search (debounced, `/`, Esc), sort picker and direction, sortable
  headers, Export CSV. Chips with counts: All, New, Flips, Price changes, Gone; the change chips are disabled on a first
  save and a remembered change filter falls back to All. Filter, search, sort and direction persist per bank
  (`bankStock.view.<bank>`). The table is virtualised like the Live market (2,000 rows at most, "Load 200 more", which
  reads "Loading…" and is disabled only while its own bigger page is read, `bankStockLoadingMore`, never for a
  background refresh; F17-UI-3): Item
  (New badge, an extras badge naming the extras with the clean-copy caveat, "↓ was X" / "↑ was X"), scrap.tf price,
  Stock ("5 → 3"), Sells for (buyer, bot/human, online), Pay up to, the verdict pill (Flip +X (m%), Over by Y, Over, No
  buyers) and Confidence; the Gone view shows Last price and Last seen. A click opens the drawer by base SKU,
  right-click or Shift+F10 the ItemMenu with the bank; j/k, arrows, PageUp/PageDown, Home/End, Enter. It refetches on
  `scraptf.banksChanged` and `market.changed` through a 2 s throttle, only while visible (`useVisiblePush`), and when the
  profit settings or the key price change; `createBankStockLoader` keeps one read in flight and drops an answer to a
  query or bank the user has since left. Empty states: never saved (the save steps), import off (Open Import), first
  save, no match, empty chip, nothing on sale, loading, first-read error with Retry. Seven grid columns (narrower
  tracks at a grid of 1,060 px or less), Confidence dropped at 960 px or less; no sideways scroll at the 960 px minimum
  window (a test parses the CSS). F20 adds the Listed and Since listed columns and two chips, and moves these
  budgets (see "scrap.tf history (F20)", U2).
- **Live market** (U3): a **New** badge in the Item cell for `scraptfNewAt` (info up to 24 h, then muted; no new column,
  so the pinned grid budget is unchanged), and "New on scrap.tf" in the Source popover (`MarketFilters.newOnScraptf`,
  off by default, persisted with the other filters); the empty table says how to get rows back.
- **Item drawer**: "On scrap.tf/buy/hats in your save 12 min ago: 3 in stock, new since your previous save" (or "↓
  cheaper than before (was X)", "↑ pricier than before (was X)", "sold out, gone since your previous save (was X)", "Not
  on scrap.tf/buy/hats in your save …: gone since your previous save (was X)"), toned by the change, with **View stock**
  (in the app; nothing opened in the browser). The path comes only from `SCRAPTF_BANKS` (`bankStockPagePath`).
- **Settings → Notifications**: "New flips on scrap.tf pages you save" (`notifications.newOnScraptf`), its description
  naming whatever keeps it silent (notifications off, "Imported pages" not ticked, import off) first.
- **Mock.** Two saves of hats, unusuals, stranges, weapons and the list (new, gone, cheaper, pricier, back on sale and
  sold-out rows; painted copies with extras), one save of killstreaks, skins and items never saved; `scraptf.bankStock`,
  the CSV, `whatsNew`, `scraptfNewAt` and the filter, `ItemDetail.bankStock`, and `import.pickFile` makes a new hats save
  and pushes `scraptf.banksChanged`.
- **Tests.** Unit tests per module, plus `test/service/bankStockWiring.test.ts`: the real core takes `buy_hats.html` and a
  later save of it (one card gone, one new, one cheaper, one pricier) from `import.html` to the rows on disk, the diff,
  the card's `whatsNew`, the stock rows' live revenue, the market's `scraptfNewAt`, `item.detail`, one notification
  (none for the first save, no second `Profit:`), `scraptf.banksChanged`, and Live check, with no request after start;
  `test/renderer/bankStockRoute.test.ts` follows View stock and back in the real App root against the mock;
  `test/import/bankStockPages.test.ts` imports the /items and unusuals fixtures split into sub-pages through the real
  `importSavedPage` (nothing new or gone, no toast, each page compared with itself only).

Decisions and deviations from the F17 spec:

1. `BankStockRow.key` (`${sku}|${specialKey}`) was added for React keys and selection; `ItemBankStock` names the drawer
   type; the rules live in `src/shared/bankStock.ts` rather than in the domain module.
2. `bankStockLatestPair` returns saves, not bare ids, and `pruneBankStock(now, opts?)` takes the time. The cache does not
   diff that pair as is: it pairs saves per page (`bankStockPagePairs`), `previousOf` skips a save at the newest one's
   own time (a re-import), and a re-import notifies nothing. Retention is **per page** of a bank (F17: the 10 newest
   saves; from F20 the thinning), not per bank, and a save carries its page (`bank_stock.page`), so /items/2 is never
   diffed against /items (F17-C1). The diff still reads at most the 10 newest saves of a page (`BANK_STOCK_KEEP_SAVES`).
3. The spec's source filter `'new'` is `MarketQuery.newOnScraptf`, a boolean like `onScraptfList`.
4. Counts ignore filter and search; `cost` and `name` sort ascending by default.
5. Rows with no price to buy store NULL costs. "New" and "gone" follow **on sale** (a price, stock not 0), so a sold-out
   item coming back is new and one selling out is gone; the spec's stockChange is `previousStock` on the row, not a
   change of its own.
6. A key's stock is the sum over its cards on sale, its price the cheapest card's; it can exceed the Live market's
   stock for that price, which is the single card behind the stored price.
7. Additions to the domain contract: `BankStock.version()` and `newFlips()`, `BANK_STOCK_RETRY_MS`, the optional
   `schemaLoaded()` dependency, the optional `MarketIndexDeps.bankStock` and `BanksSummaryDeps.bankStock`,
   `createNewFlipNotifier` (held until the first build), `MarketEval.referenced` with `isSuspectMargin` (no toast for a
   suspect margin), `EngineDeps.toldElsewhere` and `EngineDeps.notified` with `NewFlipNotifier.toastedElsewhere` (one
   toast per find both ways, beyond the spec), and the optional `BankStockResult.pages` / `oldestSavedAt`.
8. S3's dedupe key is bank + base SKU (one notification for a painted and a clean copy), recorded before the push; the
   summary's body is fixed text.
9. The Live market's New badge is per base SKU across banks, while the drawer shows the newest save listing the exact
   copy (often a later /items save where it is unchanged): the two can disagree, and the badge's tooltip says so.
10. The Live market and the drawer do not refetch on `scraptf.banksChanged` (the service sends it on every market
    change, so it would double their refreshes); every import pushes `prices.changed`, which both refetch on. After a
    maintenance prune alone they catch up on the next `market.changed`.
11. A bank whose only saves predate 0.6 reads "First save" on its card and "no save yet" on its stock page: the summary
    carries no count of bank stock saves.
12. Known limits: README "Known limits" (changes are only as complete as the saves; stock between saves is unknown;
    changes are compared per page, so a page's first save shows none and an item that moved between pages of the list
    can read as new; pages saved before 0.6).

## Save modes, MHTML and the reference helper (F18)

scrap.tf adds bank cards after its page has loaded: new stock appears live. The reference userscript (VeBeshka's
tf2-scraptf-profit-helper, read-only under `reference/`) runs in the tab and re-scans on every DOM change for that
reason. In Chrome, Edge and Firefox "Webpage, HTML only" writes the page's original HTML, not the current DOM, so a
save can miss those cards, or all of them. Chromium's "Webpage, Complete" writes the current DOM plus a `<name>_files`
folder, and "Webpage, Single File" writes it as one `.mhtml` file. F18 fixes the guidance, reads MHTML and says when a
save is missing its cards.

**Boundary** (unchanged). No request to scrap.tf (R1). The import stays behind the acknowledgement (R10). No new
network traffic. A saved file is untrusted input. Nothing inside it is fetched, opened or followed: no part, URL,
`cid:` link or Content-Location. Sizes are bounded, parts are counted but never decoded beyond the page, and parse5
never runs scripts. `test/compliance/static.test.ts` adds an F18 block. The readers (`mhtml.ts`, `savedPage.ts`,
`scraptfHtml.ts`) may import only parse5, zod, `shared/`, `contracts`, `schemaNames` and each other. They contain no
`eval`, `Function` or loader call. The names the MHTML address travels under (`contentLocation`, `Content-Location`,
`Snapshot-Content-Location`) appear nowhere outside `service/import/` and never in a loader's arguments. A synthetic
file proves each scan sees what it should.

**S1 Guidance** (`renderer/importModel.ts`). `SAVE_MODE` ('Webpage, Complete') and `SAVE_MODE_ALT` ('Webpage, Single
File (.mhtml)') carry the short reason `SAVE_MODE_REASON` ("so cards scrap.tf added after the page loaded are
included"). HTML only stays accepted (`SAVE_MODE_HTML_ONLY_NOTE`), and `SAVE_MODE_FILES_NOTE` says the `_files`
folder is ignored. `SaveModeChoice` (components/ScraptfListCard.tsx) renders the choice in these places:
- the Import page's step 2, plus the file hint (`IMPORT_FILE_HINT`) as the description of "Import saved page…";
- the price list card's step 2 (Live market and Import page);
- the Banks page header (each card's tip names `SAVE_MODE`, with `BANK_SAVE_TIP` as its tooltip);
- the Bank stock page's header tip and never-saved steps.

scrap.tf/items gets no Single File alternative: `SaveModeChoice alt={false}` on the price list card's step 2 and on the
list's Bank stock page, `LIST_SAVE_TIP` on its Banks card (the tip and the Open in browser tooltip) and as the
Open in browser tooltip of its Bank stock header, and README step 1. The list has an icon per row, and
Chromium writes each image as a part of its own, so one .mhtml file of a full list goes over 20 MB or
`MHTML_MAX_PARTS` and is refused (`SAVE_MODE_LIST_NOTE`, the tooltip). /items is a static table, so "Webpage,
Complete" loses nothing. Where the choice with its alternative covers every page (the Import page's step 2 and the
Banks page header), the visible `SAVE_MODE_LIST_ONLY` follows it: "For scrap.tf/items, choose 'Webpage, Complete'
only: …".

A manual import refused for its size (main's "larger than 20 MB", or the service's "too large") is the likely result
of a large Single File save, so its toast (`importFailedToast`) appends `TOO_LARGE_FIX` ("Save it again as 'Webpage,
Complete': its images go into the _files folder, and the page stays small.") and stays 20 s, as the folder watch's
notice does. Any other failure reads "Import failed: …" as before. `TOO_LARGE_REASON` is built from the same sentence.

Tooltips and empty states name the save type too: `bankFreshness`, `bankSavedText`, the list's tooltips, the bank
stock texts, the Live market's `COVERAGE_TIP`, `emptyFiltersText` and `drawerBankStockLine`, and the item drawer's
price list block. `test/renderer/importGuidance.test.ts` fails if any of them recommends HTML only or leaves the
save type out.

**S2 MHTML** (`service/import/mhtml.ts`, pure; `savedPage.ts`).

- **Routing.** MHTML is unpacked in the service. Main's `import.pickFile` (ipc.ts) and the folder watch both read the
  file as UTF-8 text (`decodeHtmlBuffer`) and pass it on, so `'import.html'` still carries text. Its zod cap of 20 MB
  applies to that raw text, before unpacking. `import.pickFile` takes `.html`, `.htm`, `.mhtml` and `.mht`, and any
  other pick is refused with `PICK_PAGE_REFUSAL`. Main's dialog filter lists the same four; a test reads it as source.
  `importSavedPage` calls `parseSavedPage(text, basename, schema)`.
- **Detection.** MHTML is told by its MIME headers, whatever the file is called (`looksLikeMhtml`): the file starts
  with a header line, and its strict header block has MIME-Version or a multipart or text/html Content-Type. An
  `.mht`/`.mhtml` file that starts with `<` is read as HTML. One that is neither gets `mhtml-invalid`. Chromium
  writes 7-bit MHTML (quoted-printable and base64 parts), so the UTF-8 text keeps every byte those parts need.
- **Parts.** The boundary comes from the file's own Content-Type, folded headers included. A delimiter counts only at
  a line start, so the search is one linear pass. Header blocks are bounded at 16 KB, values are clipped to 4,096
  characters, and a part's header scan stops at the next delimiter. A header line is split at its first colon with
  `indexOf` (`headerLine`), not one regex: `[ \t]*(.*)$` retried every split of a run of spaces before an inner CR,
  about 115 ms a line and 150 s for a 20 MB file of such parts. A line with an inner CR, LF, U+2028 or U+2029 is still
  no header. A value at its clip takes no further folds. Every part is counted, and more than
  `MHTML_MAX_PARTS` (2,000) is rejected before any is decoded. Only the first text/html part is decoded; a nested
  multipart is never descended into. A single-part file whose own type is text/html is read the same way. An empty
  first text/html part (its blank line runs straight into the next delimiter) is still the page and reads as '', so a
  bank address gives `no-cards-saved`; a later frame document, and its Content-Location, is never read in its place.
- **Decoding.** Quoted-printable: `=XX` in either case, soft breaks after CRLF, LF or `=` plus spaces, trailing
  whitespace dropped, a stray `=` kept. Base64 rejects any character outside its alphabet. 7bit, 8bit and binary are
  read as is. Then the part's charset applies (UTF-8 by default); an unknown charset is read as UTF-8 with the note
  `mhtml-charset`.
- **Address hint.** `contentLocation` is the page part's Content-Location, else the file's
  Snapshot-Content-Location, as clipped text. `parseScrapTfHtml(html, schema, { address })` reads it first, before
  the saved-from comment, the canonical link and og:url. It is only ever parsed by `pageKindFromUrl` (http/https
  scrap.tf addresses) for bank detection and `scraptfPageKey`, and never fetched.
- **Limits and results.**
  - A file over `MAX_IMPORT_BYTES` (20 MB, counted in UTF-8 bytes) throws `ImportTooLargeError`, as an HTML file
    does. The bound is checked four times: main's file check, the zod cap, the extractor, and the parser on the page
    inside. Main and the watch count bytes on disk, the extractor and the parser count the decoded text, so the
    limit applies to the decoded page: a file under 20 MB on disk can still be refused (`decodeHtmlBuffer` makes
    each invalid UTF-8 byte a 3-byte U+FFFD, and a base64 part in a single-byte charset can triple).
  - A malformed file, an unsupported transfer encoding, too many parts, no text/html part or a page cut short imports
    nothing. The result has pageKind 'unknown' and one warning, `mhtml-invalid`, `mhtml-too-many-parts`,
    `mhtml-no-html` or `mhtml-truncated`, each ending "save the page again". Too many parts is a Single File save's
    images, which the same save type would repeat, so that one goes on, as `tooLargeWarning` does, "as 'Webpage,
    Complete', which keeps its images out of the page file". The batch keeps the file's name.
  - Cut short means the page part has no delimiter after it and its decoded HTML does not end in `</html>` (a copy cut
    off, a read mid-write). Such a page is refused, not read: a partial look at a bank would write a bank stock save
    whose cards after the cut read as gone, then as new (and notified) on the next save, and it would become the
    bank's newest save. A page that ends in `</html>` and lost only the closing delimiter is read whole.
  - The same page imports identically as `.html` or `.mhtml`: the same ImportResult, stored prices and bank stock
    rows (tested).
- **Folder watch.** `isImportCandidate` accepts `.mhtml` and `.mht` with the existing rules: temp and download
  files (`.crdownload`, `.part`, `.tmp` and the like, names starting with `.` or `~`) and anything inside a `*_files`
  (or `*-Dateien`) folder are skipped.
- **A save over the limit is reported.** A Single File save holds every image, so 20 MB is within reach. The watch
  does not read such a file. It calls `onSkip(path, 'too-large', detail, mtimeMs)` once per version, and core's
  `recordSkippedImport` records a batch (the file name, pageKind 'unknown', no bank, 0 items) with
  `tooLargeWarning` ("too-large: 24 MB is over the 20 MB import limit; save the page again as 'Webpage, Complete', ...")
  and pushes 'import.done'. Before, it was only logged, and nothing in the dashboard changed. Nothing of the file is
  read. A file the watch did read but whose page goes over the limit once decoded (`ImportTooLargeError` from
  `importSavedPage`) is recorded the same way by core's `importWatchedFile`, with `decodedTooLargeWarning`
  ("too-large: the page decodes to 24 MB, over the 20 MB import limit; save the page again"), which gives no
  save-type advice because images are not the cause.

**S3 Saved without its items** (`no-cards-saved`).

- **Parser.** A recognised bank page with no card gets `NO_CARDS_SAVED_WARNING` instead of `no-items`. Recognised
  means a scrap.tf `/buy/<slug>` or `/unusuals[/n]` address, or, on a page with no address, a body id
  `pid-buy-<known bank>` or `pid-unusuals`. The warning is "This page was saved without its items. 'HTML only' keeps
  the page as it first loaded, before scrap.tf added the cards. Save it again as 'Webpage, Complete'." The /items
  list keeps `no-items`.
- **Store.** Such an import stores nothing and removes nothing. Its batch records the bank and the file time with
  `itemCount` 0, and it writes no bank stock rows.
- **Readers.** `isEmptyBankSave(batch, bank)` (shared/market.ts) is true for a batch of any bank but the list whose
  finite `itemCount` is 0 or less. `scraptfBankSaves` keeps such a batch in `bankOf` but never makes it a bank's
  `newest`. So the coverage strip, the Banks cards and the mock stay on the previous save with cards, or show "never
  saved" when there is none. A sold-out /items list still counts. `bankStockPagePairs` also skips a save known to
  hold 0 rows, so the next real save is compared with the last save that had cards, never read as "everything gone".
- **Dashboard.**
  - The Import page's Last import shows a warn banner first (`importWarningsView`: the fixed `NO_CARDS_SAVED_REASON`
    and the .mhtml alternative, or, for a save that was an .mhtml file already, `NO_CARDS_MHTML_HINT` "Wait until the
    items show on the page, then save it again.") and drops the duplicate `no-items` line. Recent batches and Last import read "Hats ·
    scrap.tf/buy/hats · not counted" (`importBankText(bank, stored, savedWithoutCards)`). Its tooltip names the save
    type only when the result says `no-cards-saved`: Last import passes `importSavedWithoutCards(r)`, so a page whose
    cards were all read but skipped (every price already set by a newer save, say) says "The skipped items say
    why." A Recent batches row has no warnings (`ImportBatch`), so its tooltip hedges: "If it was saved before its
    items showed, save it again as 'Webpage, Complete'."
  - `AppProvider` toasts `<file name>: <reason>` on `import.done` (`importNoticeToastText`: no cards, or
    `TOO_LARGE_REASON` for a save the folder watch passed over), in the dashboard window only, with **How to save**
    (opens `#/import`). It shows once per batch, a newer one replaces the last, and it stays 20 s, held while hovered,
    focused or while the dashboard is hidden (ToastHold 'hidden', from `useDocumentVisible`): the user saves in the
    browser with the dashboard behind it or in the tray, and the countdown runs only while it is shown. A manual
    import skips its own toast for a no-cards result, so the notice shows once.
    `AppContextValue.lastImport` keeps the newest result, so the Import page that How to save opens starts on it.
  - A test ties the renderer's code and reason to the parser's `NO_CARDS_SAVED_WARNING`.

**S4 Parity with the reference helper.** Each rule the reference uses to read a card is proven by a describe in
`test/import/referenceParity.test.ts`; two gaps were fixed.

| Rule (reference) | Flip Desk (`scraptfHtml.ts`) | Status |
|---|---|---|
| Price from `data-item-value` (scrap), else the `.item-value-indicator` text "X refined" / "X key(s)" | `cardPrice`: the value when above 0, else `parsePrice` of the indicator. A key-priced card stays in keys and is valued at the live key price; the reference uses a fixed 54.49 ref | fixed: `data-item-value="0"` read as free with a mismatch warning; it now counts as no value and the indicator decides |
| Quality from the `quality{N}` class (default 6) | `qualityFromClasses`: the first non-strange quality class; none reads Unique (6) with `unknown-quality`; quality11 + quality5 is a strange unusual | already handled |
| Festivized from `data-content` / `data-title` | a "Festivized" token in the title's modifiers or a tooltip line; "Festive Minigun" is not festivized | already handled |
| Unusual effect from the title prefix, else `data-content` | scrap.tf's particle image, then the tooltip's `Effect:` / `★ Unusual Effect:` line, then the title; an unusual whose effect cannot be read is refused (`unusual-without-effect`), never keyed without one | already handled (stricter) |
| Quality and effect prefixes stripped from the base name | `parseName` / `locateBaseName` strip quality tokens, "The", "Festivized" and effect names; the name comes from `schema.nameForSku` | already handled |
| Painted detection | `cardPaint`: the `.paintcolor` swatch (hex or rgb) and a "Painted X" tooltip line into `special.paint`, kept as extras under the clean SKU (`has-extras`); paint cans are not painted. On the buy side attribute matching (`classifyOrder`) replaces its keywords | already handled |
| `/unusuals/<sub-page>` URLs | `pageKindFromUrl` maps `/unusuals`, `/unusuals/<n>` and `/buy/unusuals` to unusuals; `scraptfPageKey` keeps `/unusuals/378` a page of its own (F17-C1); an .mhtml Content-Location reads the same | already handled |
| The same card in two containers (a "new items" strip and the grid) | asset-id dedupe across the page, the selected-items container skipped; the reference dedupes nothing | fixed: a card without `data-id` that repeats an earlier card's parsed identity (title, SKU, price, stock, extras, warnings) counts once, with `duplicate-cards: ignored N cards without an asset id shown twice`; a reserved copy differs by its warning and is kept |

Reference behaviours deliberately **not** copied, and why:

1. **Running inside the scrap.tf tab** (its `@match` on `/buy/*` and `/unusuals/*`). scrap.tf's terms name
   user-scripts, and staff ruled scripts out on banking pages (R1, R3, R10). Flip Desk reads only pages the user
   saved, behind the import acknowledgement. There is no userscript, extension, embedded view or tab access, which
   the static compliance test enforces.
2. **The MutationObserver re-scan** for cards added after load. There is no live DOM to watch. The save-mode guidance
   replaces it ("Complete" and "Single File" write the current DOM), together with MHTML import and the
   `no-cards-saved` warning for a bank page saved without its cards.
3. **Scraping backpack.tf classifieds HTML** (`GM_xmlhttpRequest` plus `DOMParser`, several pages per item). R2 and
   backpack.tf's API terms forbid it. Buy orders come only from backpack.tf's official websocket and snapshot API
   through `src/service/net` (`bptfSocket.ts`, `bptfApi.ts`), and the compliance scan forbids HTML fetching.
4. **Its notes keyword filter** ('cash', 'paypal', 'usd' among others). Marketplace and USD orders are excluded by
   their structure, not their wording: `connectors/bptfItem.ts` sets `isMarketplace` from `currencies.usd` and the
   marketplace keys, and `matcher.ts`'s `EXCLUDING_FLAGS` holds 'marketplace'. Attribute-specific orders (paint,
   spells, parts) are told apart by their attributes. The user's `profit.notesKeywords` only flags an order
   (`notes-flag`, lower confidence) instead of hiding it.

**Mock.** `'import.html'` of a file named with "empty" or "no cards" is a Hats save without its cards: the warning, a
batch with its bank and 0 items, and `import.done`, with the strip, the card and bank stock unchanged. The banks card
follows `isEmptyBankSave`, as the service does.

**Tests.**
- `test/import/mhtml.test.ts`: the extractor, charsets, base64, a missing page, oversize and too many parts,
  malformed and truncated files, hostile delimiters, nested multipart, detection, Content-Location bank detection,
  nothing fetched, and `parseSavedPage` giving exactly the HTML fixture's items.
- `test/import/mhtmlFixture.ts` builds Chromium-style MHTML from `buy_hats.html` at test time, so the two cannot
  drift apart.
- `test/import/saveModes.test.ts`: `importSavedPage`, `'import.html'` and a real-fs watcher, plus the S3 checks.
- `test/service/saveModesWiring.test.ts`: the real core and its folder watch. An .mhtml save and its .html twin, in
  two cores, give the same result, batch, prices and bank stock rows on disk and the same readers. A later .mhtml save
  without cards warns and moves nothing. The next save is compared with the last one with cards. Nothing is requested
  after start, and no address in the files ever is.
- `test/import/referenceParity.test.ts`, `test/renderer/importGuidance.test.ts`, the timed linear-delimiter, header
  line and fold cases in `test/import/scraptfHtml.slowInput.test.ts`, the F18 compliance block, and
  `test/renderer/mockBanks.test.ts` for the mock.
- `test/import/saveModes.test.ts` and `test/import/folderWatch.test.ts`: a cut-short .mhtml stores no partial look,
  and a save over the limit is reported (`onSkip`); `test/service/saveModesWiring.test.ts` records and pushes it
  through the real core, and a 7 MB file whose 8-bit windows-1252 page decodes to over 20 MB too.

Decisions and deviations from the F18 spec:

1. MHTML is unpacked in the service, not in main (the spec allowed either). Both paths send the file's text, so the
   20 MB bound applies to the file, one parser path serves both, and the RPC is unchanged.
2. `readMhtml` (with failure reasons and notes for the warnings) sits beside the spec's `extractMhtmlHtml`, and
   `parseSavedPage` is the one entry for both file types.
3. A malformed .mhtml still records a batch (its file name, pageKind 'unknown', 0 items), as an unrecognised HTML
   page does.
4. The parser decides `no-cards-saved` (a recognised bank page with no card). Coverage and the Banks cards decide by
   the batch's stored count, because `ImportBatch` has no parsed-card count, which would need a schema change. So a
   bank page that had cards but stored none (schema not loaded, every card refused, every price already set by a
   newer save) is passed over too, and its bank keeps the previous save's date. Bank stock keys on its own rows and is
   unaffected.
5. A 0-card page that names its bank only through its body id gets the warning but records bank null. `guessPage`
   trusts a body id only when cards are present (F15), which keeps a logged-out "Sign in through Steam" page out.
   Such a batch dates no bank either way.
6. A legitimately empty `/unusuals/<defindex>` sub-page also reads `no-cards-saved`.
7. A key-priced card keeps its price in keys (the reference converts at a fixed 54.49 ref).
8. No .mhtml fixture is committed. It is built at test time, and the repository's `core.autocrlf` could rewrite a
   committed file's CRLF lines.
9. `AppContextValue.lastImport` and the mock's no-cards import go beyond the spec.
10. Known limits: README "Known limits": dynamic cards only in "Complete"/"Single File" saves, a bank page that stored
    nothing for any reason is not counted, a large Single File save (over 20 MB or 2,000 parts, scrap.tf/items above
    all) refused, an `.mhtml` cut short importing nothing, MHTML checked against synthesized files, and an 8-bit
    non-UTF-8 page part (it can lose accented letters, and decoded it can go over the 20 MB limit though its file
    does not).
11. A page cut short is refused whole rather than read in part (the spec left both open). The prices of its cards
    would be right, but storing them would make the batch the bank's newest save, and a partial bank stock save
    cannot be told from a complete one later. From 0.7.1 the same reasoning covers looks the app can tell are
    partial: a look at a bank page (not the list) with fewer than `PARTIAL_READ_RATIO` (half) of the on-sale keys of
    the newest save of the same page made up to `PARTIAL_READ_MAX_AGE_MS` (6 h) before it, when that save had at least
    `PARTIAL_READ_MIN_KEYS` (8) (DM-2, file or window), an /items page with a row whose stock cannot be read (P1), and a
    window snapshot imported without its settle read (`settled: false`, ACT-4). These store their cards' prices and
    the batch (the prices are right) but no bank stock save, so no events, run breaks, new flips or gone-price deletes
    follow (`stockSave` 'partial' or 'unsettled'; the partial and stock warnings come first in `warnings`).

## Live market ↔ scrap.tf link (F19)

From any Live market row the user gets to the item on scrap.tf in their own browser and back with its price, in a few
keystrokes. "Link" means two things, and neither is a request from the app:

- **Out.** The app hands a static scrap.tf bank page to the user's browser through `links.open`, and only on a click
  or a key press. The page is the one a saved page last listed the item on, else its category's bank. The item's name
  is copied for scrap.tf's own search box.
- **Back.** The price the user sees there returns through their own clipboard and the Live check (F16): the check
  hotkey, or the opt-in watcher. A bare price is enough, because main remembers which item the user just opened.

**Boundary** (unchanged; R1, R3, R10). The app never loads, fetches or embeds scrap.tf, and adds no network traffic.
Every scrap.tf URL this feature hands to `links.open` is an entry of `SCRAPTF_BANKS`, all of them in
`STATIC_EXTERNAL_URLS`, and main's allowlist matches scrap.tf only against those exact addresses. No URL is ever built
from item data: no search query, no item path. `MarketRow.scraptfLink.url` is that same static page, but the dashboard
never opens a URL a row carries: the row button takes its page from `SCRAPTF_BANKS` by the row's bank. The clipboard
rules of F16 apply unchanged. The text is read in main only and secret-filtered first, goes nowhere but `check.text`,
and is never logged, stored or put into a result. The armed name is kept only as the watcher's keyed hash and is never
logged. `test/compliance/static.test.ts` has an F19 block. Every scrap.tf open of the Live market, the item drawer and
the row menu must trace back to a static-page helper or constant. Those helpers must build no URL and read `.url` only
off a `SCRAPTF_BANKS` entry (or a links page gated by `BANK_PAGE_URLS`). No dashboard file reads a row's or a detail's
own URL. Synthetic sources prove each scan sees what it should.

**S1 `MarketRow.scraptfLink`** (`src/service/domain/market.ts`). `{ bank, url, seenAt, source }` is joined when rows
are read, like the other `scraptf*` fields, and never stored in the index's entries. It comes from two in-memory
lookups and never a query per row:

- `KnownState.seen`, per base SKU, is the newest imported price whose batch names a known bank (`ScrapPrice.bank`). It
  is rebuilt with the known prices on `pricesChanged()`, and ties at one time go to the higher price id, as
  `scraptfSeenOn` (`ItemDetail.seenOn`) breaks them.
- `BankStock.seenFor(base)` is the newest kept bank-stock save listing any copy of the base (a diff row with a current
  row: a gone item was not on that save). It is memoised per `version()` from the kept diffs, so it reads no repo.
  Core wires it like `newAtFor`.

The two are folded with `preferScraptfSeen`: a bank page beats the scrap.tf/items list, then the newer one wins. A
failed bank stock read leaves the prices' sighting. `scraptfLinkFor(category, seen)` then gives `source: 'seen'` with
that bank and save time, or `source: 'category'` with `bankForCategory(category)` (never the list) and `seenAt: null`.
The bank is `'list'` only for an item known from scrap.tf/items alone. `list()`, `all()` and `uncheckedBy()` agree. A
row's bank equals `ItemDetail.seenOn.bank` whenever both exist. The market CSV is unchanged (deviation 4).

**S2 the Live check hint** (`src/service/domain/liveCheck.ts`, `rpcHandlers.ts`).

- `check.text` takes an optional `hint: { sku }` under the service's SKU rule. An invalid hint is refused with a fixed
  message (never the text), and unknown keys are dropped. The handler passes it on only when one was sent.
- `LiveCheck.check(text, source, now, hint?)` uses it only when the parser found no item (`CHECK_NOT_ITEM_REASON`) and
  `checkHintPrice(text, source)` reads the text as one non-blank line holding one non-zero price ("1.33 ref", "2 keys
  5.11", a copied price cell). A refused text never qualifies. The rule is the shared `checkHintPriceOf`, which the
  mock uses too:
  - A number without a unit is ref only when it is short (at most three whole digits and two decimals: "5", "1.33",
    "63.11"). A SteamID64, a year, an order id or a phone number is no price.
  - Over `CHECK_HINT_MAX_KEYS` (5,000) keys or `CHECK_HINT_MAX_REF` (50,000) ref is no price either, so a price is
    always a safe integer.
  - For `source: 'watch'`, which reads whatever the user copies in any app, a bare whole number ("49", a one-time
    code) and a one-letter unit ("5k", "3s", "2r") are no price: scrap.tf writes its prices with a unit word. A
    decimal ref figure ("1.33") still is. The hotkey and a typed check keep "5" and "5k", since the user asked.
- `hintedCheck` then evaluates the hinted SKU as it is, never resolved by name and never fuzzy, with the copied price
  (`source: 'clipboard'`, observed now). This happens before the schema-loading reason, since a SKU needs no names.
- The result's reason is `checkHintedNote(name)`: "Price copied, matched to <name>, the item you opened from the Live
  market.", where the name is the schema's. It is kept in the ring and pushed as `check.done` like any item result.
- Text that names an item ignores the hint (text wins), and without a hint nothing changes.

**M1 `check.arm`** (main, `src/main/liveCheck.ts`, `ipc.ts`, `main.ts`).

- `check.arm { sku, name } | null` is a main method. Its zod uses the service's SKU rule, and the name is trimmed, 1
  to 200 characters (`CHECK_ARM_NAME_MAX`) with no control character. The messages are fixed, because a failed call's
  message reaches main's debug log.
- `LiveCheckMain.arm()` keeps `{ sku, nameHash, until: now + CHECK_ARM_MS (10 min), ownCopyDropped }` in memory. A new
  arm replaces the old one whole, and `null` or `stop()` disarms. Expiry is checked on every read, so no timer runs.
- While the arm lasts, the hotkey's and the watcher's `check.text` calls carry a fresh `{ sku }`, read when each check
  is sent (a copy that waited past the expiry goes without). Otherwise the call keeps its two arguments.
- A page's `check.text` may not carry a hint (`CHECK_TEXT_HINT_REFUSAL`), just as it may only be `source: 'manual'`.
- A smoke test has no controller, so it answers `{ armedUntil: null }`.

**M2 own-copy suppression.** The page arms first, then copies the name.

- While armed, the first watcher text whose keyed hash (trimmed) equals `nameHash` is the app's own copy. It is
  dropped once, before the service-ready check and the queue, so it never takes the waiting slot from a copy the user
  made.
- There is nothing to drop, and so nothing of the user's own is ever swallowed, in these cases:
  - the watcher is off or paused when the arm comes (it primes afresh when it resumes);
  - it already saw the name last (`ClipboardWatch.isLastSeen`; the same row opened twice changes nothing);
  - a hotkey check of the name ran first: the user asked, it checks, and it uses up the drop;
  - the watcher was running but not yet primed (just started or resumed), and its priming read found the name
    (`ClipboardWatchOptions.onPrimed`, a keyed hash only). A priming read of anything else leaves the drop waiting,
    since it may have run before the page copied;
  - the page's copy has not come within `CHECK_OWN_COPY_MS` (5 s, at least three polls) of the arm: the copy failed or
    stalled. The page copies within milliseconds of arming, so after that a copy of the name is the user's own.
- The name itself is never stored.

**M3 privacy and disarm.** Main logs no arm, name, hint or text. The arm lapses on its own. The service does not know
about saves, so the check popup calls `check.arm(null)` right after a successful Save price (`prices.upsert`) or Bought
it (`journal.add`), never after a failure or an Undo.

**Renderer.**

- **U1, the row button** (`pages/MarketPage.tsx`, `marketScraptfButton` in `marketModel.ts`). A real
  `<button type="button">` sits in the Item cell, with the external-link icon and the bank's short label. It is out of
  the Tab order, the grid's `o` key does the same on the selected row (not on repeat or with Ctrl, Alt or Meta), and
  the keyboard help line and the grid's aria-label say so.
  - Its tooltip reads "Seen on scrap.tf/buy/hats in your save 12 min ago" (a `'seen'` link with a finite time on that
    bank) or "scrap.tf's Hats bank (not in your saves yet)", then "Opens it and copies the name (o). The app never
    visits scrap.tf."
  - A click stops propagation and selects the row, and the rest of the row still opens the drawer. A busy flag stops a
    double press from opening two tabs.
  - The action is `openOnScraptf(url, name, toast, { sku, settings })`: `check.arm`, then `copyText(name)`, then
    `links.open`, then a toast.
  - The toast reads "Opened scrap.tf/buy/hats in your browser. The name is copied; paste it into scrap.tf's search.",
    then how the price comes back (`scraptfBackHint`): "Copy the price there and press Ctrl+Alt+C to check it here.",
    or the watcher's wording. There are variants for the watcher on, the hotkey off or taken, the network paused, an
    arm refused (it asks for the name and price), and a failed copy or open. The hotkey label comes from
    `settings.check.hotkey`, checked against `app.hotkeys`, which runs alongside and never delays the copy.
  - The name is `scraptfSearchName` (unpainted), and `checkArmFor` skips names main would refuse.
- **U2, the bank header.** While the category filter covers exactly one bank (`marketSingleBank`; the
  `#/market/bank/<bank>` route and a bank card's See all included, with taunts and other mapping to Items), the summary
  bar shows "Open scrap.tf/buy/<bank> ↗" through `openOrCopy` (`links.open`).
- **U3, elsewhere.** The drawer's "Open on scrap.tf (copies name)" and the row menu's action call the same
  `openOnScraptf` with the arm, so the way back works from there too. Without `arm` it behaves exactly as in 0.4.
  - The popup's note line shows `CHECK_MATCHED_NOTE` ("Price copied, matched to the item you opened.") with an icon in
    place of the service's sentence, which stays in the tooltip. Other notes follow it, and the price line stays
    "(copied)".
- **U4, the mock.** Every mock row carries `scraptfLink`, a mix of seen and category. The mock's `check.arm` validates
  like main and lapses after `CHECK_ARM_MS`. Its `check.text` checks a bare price as the hinted item
  (`mockHintedParse`, by the shared `checkHintPriceOf` and the check's source): its own hint, or the arm on a hotkey
  or watcher check.

**Tests.**

- Shared and service: `test/shared/marketLink.test.ts`, `test/domain/marketLink.test.ts` (no repo read per row,
  parity with `seenOn`), `test/domain/liveCheckHint.test.ts`, `test/service/liveCheckHint.test.ts` (the log files on
  disk), `test/service/checkHintParams.test.ts` and `test/service/marketLink.test.ts`.
- Main: `test/main/checkArm.test.ts`, the F19 block of `test/main/liveCheckMain.test.ts` (the real main logger with a
  marked name), `test/main/clipboardWatch.test.ts` and `test/main/liveCheckWiring.test.ts`.
- Renderer: `test/renderer/marketScraptfLink.test.ts`, `checkMarketLink.test.ts`, `itemMenuScraptf.test.ts`,
  `checkPopup.test.ts`, `checkWiring.test.ts` and `mockMarketLink.test.ts`.
- End to end: `test/service/marketLinkWiring.test.ts` runs the real core, main's router and live check controller, and
  the real Live market page and check popup over `window.flipdesk`.
  - A saved hats page links its rows to scrap.tf/buy/hats; the click arms, copies and opens that static page.
  - The watcher drops the app's own copy once; the hotkey checks a bare price as the item; Save price disarms; a later
    bare price is no item.
  - Nothing is requested, and main's log names no text.

Decisions and deviations from the F19 spec:

1. The row action arms before it copies (the spec listed copy, arm, open). Main's watcher polls every 700 ms and must
   already know the name when the copy lands (M2). The copy still comes before `links.open`, while the page has focus.
2. At 1280 and 1440 px windows (containers up to 1400 px) the bank label shows only on the selected row. Other rows are
   icon-only, which keeps a long name readable in the Item cell. The tooltip and the aria-label always name the page,
   and from 950 px down the button is icon-only on every row. The aria-label starts with the bank label ("All items:
   open scrap.tf/items in your browser and copy the name"), so the visible text is in the accessible name (WCAG 2.5.3).
3. The popup shows "price copied, matched to the item you opened" on its note line, not inside the price line's
   "(copied)": the 380 px price line does not wrap, and the note line replaces the service's longer sentence, so the
   match is said once.
4. No market CSV column: `test/service/marketRpc.test.ts` pins the whole CSV data line, and the spec allowed the column
   only if the pinned tests did.
5. An item known only from a saved scrap.tf/items list links to scrap.tf/items (bank `'list'`), as the contract allows.
6. Own-copy suppression goes beyond the spec in one way: nothing is dropped when the page's copy cannot reach the
   watcher as new (watcher off or paused, name already seen, hotkey first, taken by a priming read) or has not come
   within `CHECK_OWN_COPY_MS`, so a later copy of the name, the user's own, is checked.
7. The bank stock's sighting reads the merged pages (`bankStockMergePages` keeps an item on the first page of its bank
   that lists it). For a bank saved as several pages, `seenAt` can be that first page's save time. The bank is still
   right, and the imported price's sighting usually gives the newer time.
8. The market folds imported prices by base SKU, so a price stored under a painted SKU counts for its base row, while
   `ItemDetail.seenOn` for the base reads exact-SKU rows. Imports store under the base SKU with the paint in extras, so
   the two agree in practice.
9. Known limits: README "Known limits" (the clipboard check still sees the menus' plain copy actions; a bare price is
   checked as the item opened last, for 10 minutes or until saved).

## scrap.tf history (F20)

The sequence of the user's saves of each bank page, read as history: scrap.tf's price of an item in every save, how
long it has been listed, a feed of every change between two saves, and opt-in reminders to save a bank again so the
data stays as close to live as the user wants. Code comments say **F20**.

**Boundary** (unchanged; R1, R3, R10). The app never loads, fetches or embeds scrap.tf, and F20 adds **no network
traffic of any kind**: every input is a bank page the user saved with their own browser (the `bank_stock` snapshots,
F17) or the local Live market index. The app cannot refresh scrap.tf, so a reminder only asks the user to save the
page again. The one URL F20 hands out is a notification's `openUrl`: a `SCRAPTF_BANKS` page (never built from item
data, never an event's `page`), opened only on the user's click, only after main checks it again at click time, and
only in the user's browser (`shell.openExternal`, the opener `links.open` uses). `test/compliance/static.test.ts` has
an F20 block: the history, feed and reminder modules make no request, load nothing and open nothing (with the Live
log's changes tab, the step chart and Settings' reminder fields; every dashboard file that shows a change event or an
item history must be in that list), and the bank stock page opens only a traced static page (every opener traced, not
only those that look like scrap.tf); every `openUrl` set in `src/` (an object key, bare, quoted or computed, or an
assignment, `+=` refused) traces back to a `SCRAPTF_BANKS` entry, and `openUrl` named any other way (a string key in
a variable, say) fails, so a helper spread or assigned into a payload is caught where it names the key; main opens a
notification's URL only behind `notificationOpenUrl`'s three checks; `isScraptfBankUrl` is an exact comparison.
Synthetic sources prove each scan.

**S1 Thinning** (`bankStockThinning` in `shared/bankStock.ts`, `Repo.pruneBankStock`). Retention is per bank page
(`bank` + `bs.page`, F17-C1), from 0.7.1 (DM-3, CQ-1): every save of the last 2 h (`BANK_STOCK_KEEP_ALL_MS`); from
2 h to 24 h (`BANK_STOCK_RECENT_TIER_MS`) the newest save of each clock-aligned 10 minutes
(`BANK_STOCK_RECENT_BUCKET_MS`, well above `READ_AUTO_MIN_GAP_MS`); from 24 h to 7 d the newest of each UTC clock
hour; from 7 d to 90 d the newest of each UTC day; nothing older. The cap of 300 saves per page applies to the 2 h
tier only, so heavy window browsing never evicts hourly or daily history (in 0.7.0 it capped the whole page, and 300
window reads pushed out every older save). A page's newest save, the save it is compared with (the newest from
**strictly** before it, `previousOf`) and its session baseline (F17, `bankStockBaselineOf`) are never removed,
whatever their age or the cap: the stock page, its chips and the feed read them. Nor are the few saves that keep the
newest session one session (DC-3, `sessionChainOf`: walking from the newest, a save is kept when the next older one
would be 30 min or more after the last kept), so an idle page's session, re-tiered to one save an hour past 24 h or cut
by the cap, never opens a gap inside itself that would move its baseline into it. Buckets are clock-aligned, so a kept
save stays its bucket's newest at the next run. `importSavedPage` prunes after its transaction with `orphans: false`
(so `previous` exists when `onImport` runs inside it); the daily maintenance job prunes with the orphan sweep and
calls `ctx.bankStockChanged()` when rows went. `Repo.bankStockSaveIndex()` lists `{ batchId, savedAt, bank, page }` of
every save with rows (oldest first) in one query, from `bank_stock_saves` (V8), so it costs per kept save whatever
the number of import batches; `bankStockRowsOf(ids)` reads many saves' rows with a chunked `IN`. At 300 saves x 8
pages x 300 rows: the save index about 3-6 ms (about the same with 100,000 batches that hold no rows), a prune after an
import with nothing to delete about 5-15 ms, the orphan sweep about 80-200 ms (`test/db/bankStockThinPerf.test.ts`,
timed). `BANK_STOCK_KEEP_SAVES` (10) is still how many saves per page the F17 diff reads and counts, read per page.

**S2 Change events** (schema V7 `scraptf_events`: id, at, bank, page, sku (base), special_key, name, kind, from_keys,
from_scrap, to_keys, to_scrap, from_stock, to_stock, batch_id; indexes (at), (sku), (bank, at), and from V8 (bank, id)
for the feed filtered by bank).

- **Where.** `importSavedPage` calls `ctx.scraptfHistory.onImport(batchId)` inside its transaction, right after
  `insertBankStock` wrote a recognised page's rows; a repo error rolls the whole import back. After the commit, and
  after `bankStockChanged` (core refreshes the bank stock cache and the history index there), it pushes
  `'scraptf.changed' { at: the save's time, count }` when events were written, before `prices.changed` and
  `import.done`. F17's `scraptf.banksChanged` still follows every bank import.
- **What.** The save is compared with the **previous save of the same page** by F17's own matching and rules
  (`diffBankStock`, through `scraptfEventsOf`; never a fork): `new`, `gone`, `cheaper`, `pricier` as on the stock
  page; **restocked** = F17's new when the previous save listed the row (sold out or without a price) or a retained
  save of the bank (any page) listed it before this one (the runs index without this save, `seenBefore`); **stock** =
  on sale in both, the raw price unchanged, both counts known and different. Prices are stored as raw keys + metal.
- **When not.** No events for a page's first save, a save not newer than the page's newest stored save (out of time
  order, or the same file again: a save's time is its file's), a 0-row save (F18's `no-cards-saved` stores none), or a
  bad batch id. In a bank saved as several pages, a `gone` is dropped when another page's newest save lists the copy:
  it moved (`/items/2` -> `/items/3`) and is not gone from the bank, as `bankStockMergePages` shows it.
- **Retention.** 90 days (`pruneScraptfEvents` in maintenance; `ctx.scraptfEventsPruned()` refreshes the index).

**S3 History index, item history and time listed** (`domain/scraptfHistory.ts`, rules in `shared/scraptfHistory.ts`).

- **Runs index.** Each retained save's rows are read once (`bankStockRowsOf`), cached by batch id, compacted (strings
  interned, a row unchanged since the page's previous save shares its object) and sorted by copy; ids the save index
  no longer lists are dropped. Per bank, `scraptfRunsOf` over its saves (pages read together) gives one `ScraptfKeyRun`
  per copy: `seenAt`, `firstSeenAt`, `lastSeenAt`, `listedSince` (the start of the current unbroken run of saves that
  have it on sale; null when the newest observation does not), the run's first price and the current one. **Listed**
  is on sale (`bankStockOnSale`), as F17's new and gone. A save covers a copy when it lists it, or when it is a save of
  the copy's home page (the page of the newest save that listed it) that does not; another page that does not list it
  says nothing. Only a bank whose saves changed is rebuilt, a per-base map makes `listedSinceFor` one lookup, and
  `version()` grows only on a real change. Loaded lazily on first use; `refresh()` comes from core's `bankStockChanged`
  (import and maintenance) and `scraptfEventsPruned`. A failed read keeps the last good index, is logged once per
  failure streak and is retried after `SCRAPTF_HISTORY_RETRY_MS` (10 s) by reads, at once by `refresh()`. Never a
  query per row, never throws. Measured at 8 banks x 250 saves x 300 rows (600,000 rows): first load about 2 s (mostly
  `bankStockRowsOf`), a refresh after one import 20-35 ms, `onImport` about 10 ms, an item read 2-5 ms.
- **`'scraptf.itemHistory'`** `{ sku, special? }` (zod: the service's SKU rule, lower-cased; `special` a bank stock
  special key up to 2,000 characters, or null). One copy: the SKU's base and `special`, else the SKU's paint, else a
  clean copy. Each cached save is bisected for that copy, then `scraptfItemHistoryOf` reads **one bank**: the one whose
  newest observation has it on sale (a bank page before the list, then the newer), else the one that last had it on
  sale, else the one that last listed it. `points` are that bank's observations, oldest first (costs 0 when
  `listed` is false: never plotted). `change.hN` compares the current price with the newest observation at or before
  now - N (null when it was not on sale then, or nothing is on sale now); `change.listed` with the run's first save.
  Raw keys + metal are valued at today's key price (the last good one when it cannot be read, else the default), so a
  key price move alone is no change. `events` are that copy's newest 50 (`scraptfEvents({ sku, specialKey })`); from
  0.7.1 (DM-6) 50 price events (`SCRAPTF_PRICE_KINDS`: new, restocked, cheaper, pricier, gone) plus at most
  `SCRAPTF_ITEM_STOCK_EVENTS` (10) 'stock' events, read apart and merged newest first, so stock moves never push a
  price drop out. An item
  never saved reads `bank: null` with the schema's name.
- **Bank stock rows.** `BankStock` joins `listedSince`, `firstSeenAt` and `changeSinceListed` from
  `history.runsFor(bank)` (one runs read per `list`/`all`/`whatsNew`/`newFlips`). `BankStockQuery` gains the filters
  `'long-listed'` (on sale for at least `minListedMs`, default 24 h, zod 0 to 90 d) and `'dropped'` (cheaper since
  listed), the sorts `'listed'` (longest first) and `'sinceListed'` (biggest drop first), and the counts `longListed`
  and `dropped`. A failing history gives null fields, logged once per streak.
- **Live market.** `MarketRow.scraptfListedSince` = `listedSinceFor(base, link.source === 'seen' ? link.bank : null)`
  (without a bank: the bank listing it now, a bank page before the list). `MarketQuery.listedOnScraptf` keeps rows
  listed at least 24 h (`marketListedSideMatches`) next to the other source filters, before the verdict counts. Only
  that filtered pass keys its cache on `history.version()`, the bank stock's version and the minute.

**S4 The feed** (`'scraptf.changes'`, zod: bank, kinds (up to 6), sku (its base is used; paint dropped), beforeId at
least 1, limit 1 to 500, default 100). Newest first (`id DESC`; within one save, its gone rows come first), each event
valued at the key price now (`fromValueScrap`, `toValueScrap`, `deltaScrap` 0 for an equal raw price, `pct`) and
joined to the Live market entry of its base SKU, one `entryFor` per base: `revenueScrap`, `maxCostScrap` and `flip`
(the new price at or under Pay up to; never for `gone`). `opps.exportCsv {kind:'scraptfChanges', scraptfChanges}`
drops paging, caps at 5,000 events and writes `flipdesk-scraptf-changes-YYYY-MM-DD.csv` (time, bank, page, sku, name,
extras, kind, from, to, change, change_pct, from_stock, to_stock, sells_for, pay_up_to, flip). Never throws.

**Push.** `'scraptf.changed' { at, count }` is in `PUSH_EVENTS`, so `SERVICE_PUSH_EVENTS`, main's default broadcast
and the preload's allowlist carry it to every loaded page (`test/main/scraptfChangedBridge.test.ts`); it is not held
for a page still loading.

**S5 Re-save reminders** (`domain/resaveReminders.ts`; opt-in). Settings `import.resaveReminderMin` (int 0 to 1440,
default 0 = off; the lenient load turns an out-of-range value into 0) and `import.resaveBanks` (default `[]`, meaning
every bank saved at least once; the lenient load keeps valid distinct banks). A `setTimeout` chain every minute
(`RESAVE_TICK_MS`; `start()` is idempotent, `stop()` clears it) checks its gates first and reads nothing while one is
closed: minutes at least 1, import enabled **and** acknowledged, `notifications.enabled`, and the network not paused
(`settings.networkPaused || http.isPaused()`; a failing check counts as paused). Then, for each bank of
`scraptfResaveBanksOf(resaveBanks, banks with a save)`, with its newest save from `bankStockSaveIndex()`,
`scraptfResaveDue` (not saved for N minutes, and not reminded in the last N minutes since that save) gives one
`notify` push: "Re-save scrap.tf/buy/hats" / "Last saved 1 h 05 m ago. Save it again (Ctrl+S, 'Webpage, Complete') to
refresh prices and see what changed", `sku: null`, `openUrl` = the bank's `SCRAPTF_BANKS` url
(`scraptfResaveNotice`). Main applies `notifications.silent`. No reminder for a never-saved bank. The last reminder
per bank is kept in memory and set before the push, so a failing push is not retried every minute; a failed read is
logged once per streak.

**Notification links** (main, `notify.ts`, `main.ts`). `notifySchema` takes `openUrl` (a string up to 4,096
characters; anything else is dropped, never the toast). `notificationOpenUrl(url)` returns it only when `isHttpsUrl`,
`isAllowedExternalUrl` and `isScraptfBankUrl` (an exact `SCRAPTF_BANKS` url) all accept it: another scrap.tf path, a
query, hash, trailing slash, port, userinfo, case change, backslash, `javascript:`, `file:` or `data:` is refused.
`notificationContent` keeps the key only then; `droppedOpenUrl` lets main log a refusal on receipt with a fixed
message, never the URL. A click goes through `handleNotificationClick`, which checks the URL again (the data object
lives on in the click's closure) and opens it with `shell.openExternal`, nothing else; a refused link is logged
without the URL and the click does what it did before 0.6 (the SKU's drawer, else the dashboard); a failing opener
falls back to the dashboard. `isHttpsUrl` moved to `paths.ts`, so `links.open` and the click share it.

**Dashboard.**

- **U1, item drawer** (`components/ScraptfHistory.tsx`, `historyModel.ts`, `styles/scraptf-history.css`). A "scrap.tf
  history" block after the price list block, read lazily when the drawer opens (`useRpcQuery`) and re-read on
  `scraptf.changed` and `prices.changed` (a first or unchanged save writes no event but still adds a point) through a
  2 s throttle, only while the window is visible. "Listed since 2 d 4 h (since your save on Oct 14 09:12)", the price
  and stock now, chips for 1 h / 24 h / 7 d / since listed (↓/↑ amount and %, toned), a step chart
  (`StepSparkline`, the PriceDB sparkline unchanged: each price held until the next save, a gap and a baseline tick
  where a save did not have it on sale, the nearest save on hover), the last 5 changes with "Show all N", and empty
  states (never saved, one save so far). A chip shows a dash, with "save the page again to compare", when it would
  compare a save with itself. A change from another bank (the list) is prefixed with that bank's label. It opens and
  builds no URL.
- **U2, bank stock page** (`BankStockPage.tsx`, `bankStockModel.ts`, `styles/bank-stock.css`). Columns **Listed**
  ("2 d 4 h", bold from 24 h) and **Since listed** ("↓ 8 %", green when cheaper), both sortable; chips **Listed >
  24 h** and **Dropped since listed**; the sort picker gains both sorts; the header's retention note
  (`RETENTION_NOTE`) describes the thinning. Width budgets: nine columns above 1,060 px; Confidence hidden at 1,060 px
  or less, Stock too at 960 px or less; the Gone view always hides the two F20 columns and keeps F17's. No sideways
  scroll at the 960 px minimum window (the CSS test covers both views). The retention note and the "Not saved yet" title
  never say a page's newest save or its compare save expires: the thinning keeps both whatever their age.
- **U3, Live log** (`LogPage.tsx`, `changesModel.ts`). Tabs **Opportunity events** (`#/log`, the old page unchanged)
  and **scrap.tf changes** (`#/log/changes`; the route picks the tab). Newest first: saved time, bank label (from
  `SCRAPTF_BANKS`), kind pill, item, "1.33 → 1.22 ref (−8 %)", stock, live Sells for and Pay up to, a **Flip** pill
  (and a green edge). Bank select and kind chips, remembered (`log.scraptfChanges`); "Load older changes" up to 2,000
  kept, of which 300 are rendered before "Show N more"; refreshes never overlap and drop a stale view's answer. A click
  opens the drawer by base SKU, right-click the ItemMenu with the bank; re-read on `scraptf.changed` (2 s throttle,
  visible only); the rows shown valued again on `market.changed` (`ChangesFeed.revalue`: the same `scraptf.changes`
  read from the newest id shown down, in place, nothing added; 20 s throttle, visible only), so Sells for, Pay up to and
  Flip follow the buyers; Export CSV. A refresh or "Load older" whose merge goes over the 2,000 kept keeps "Load older"
  (the events cut off are still in the feed). The nav badge counts unseen opportunity events and clears only on their tab.
- **U4, Settings → Saved-page import** (`SettingsPage.tsx` `ImportSection`, `settingsFields.ts`). The helper text
  `SCRAPTF_RESAVE_HELP`, "Remind me to save a bank again after" N minutes (0 to 1440, as the schema), and one checkbox
  per bank: `[]` shows every box ticked, ticking all saves `[]`, and the last ticked box is disabled so `[]` is never
  saved meaning "none". The description names what keeps reminders silent first (import off, notifications off, the
  network paused).
- **U5, Live market.** "Listed on scrap.tf > 24 h" in the Source popover (`MarketFilters.listedOnScraptf`, off by
  default, persisted, counted, in the export query), so the grid budget is unchanged; the empty table says how to get
  rows back.

**Mock.** Hats, unusuals, stranges, weapons and the list have about 18 saves over 10 to 12 days
(`seedBankStockHistory`, thinned with `bankStockThinning`), with drift, items coming and going and restocks; killstreaks
keeps one save, skins and items none. Events are written save by save with `scraptfEventsOf` (every kind occurs).
`scraptf.changes`, `scraptf.itemHistory`, the CSV, the bank stock and market listed fields and filters use the shared
rules, and `import.pickFile` writes events and pushes `scraptf.changed`.

**Tests.**

- Shared and db: `test/shared/bankStockThinning.test.ts` (the policy as a table of save times),
  `test/shared/scraptfHistory.test.ts`, `test/shared/bankStockListed.test.ts`, `test/db/scraptfEvents.test.ts` (V7, V8's
  feed-by-bank plan and the repo), `test/db/bankStock.test.ts` (V8's `bank_stock_saves`: kept with the rows,
  backfilled) and the timed `test/db/bankStockThinPerf.test.ts` (also with 100,000 batches that hold no rows).
- Service: `test/domain/scraptfHistory.test.ts` (event parity with the shared rules, restocked, out of order, the same
  file, multi-page moves, rollback, the runs index, item history, the feed and CSV, failures),
  `test/domain/resaveReminders.test.ts` (fake timers: gates, banks, once per N minutes, the payload),
  `test/domain/bankStockHistory.test.ts` (with a quiet page of a bank whose other pages are saved often: its rows,
  pair and change chip agree with the history and the feed), `test/domain/marketScraptfHistory.test.ts`,
  `test/import/importSavedPageScraptfHistory.test.ts` (the real `importSavedPage`, thinning after an import),
  `test/service/scraptfHistoryRpc.test.ts` and `test/service/scraptfHistoryCore.test.ts`.
- Main: `test/main/notify.test.ts` (30-odd refused links, at receipt and at click time; the real reminder payload of
  every bank opens exactly its page) and `test/main/scraptfChangedBridge.test.ts`.
- Renderer: `historyModel`, `changesModel` (the cap and "Load older", re-valuing in place), `drawerScraptfHistory`,
  `logScraptfChanges` (re-valued on `market.changed`), `logBadge`,
  `settingsResave`, `marketListedFilter`, `bankStockModel` / `bankStockPage` and `mockScraptfHistory` tests.
- End to end: `test/service/scraptfHistoryWiring.test.ts` runs the real core over `buy_hats.html` and two later saves
  of it (new, gone, cheaper, pricier, then restocked, gone, cheaper and a stock move): the `scraptf_events` rows on disk,
  `scraptf.changed`, the feed with the Live market's revenue and Pay up to, paging, filters and CSV, the item history's
  points, gap, listedSince and changes, the bank stock rows' time listed and F20 filters and sorts, the market's
  `scraptfListedSince` and filter, thinning that deletes a save past 90 days and keeps the compare save, then one
  reminder for the stale bank from the core's own timer (held and played by the test) whose link main opens, and only
  that link. Nothing is requested after start.

Decisions and deviations from the F20 spec:

1. `ScraptfItemHistory` also carries `specialKey` and `bank` (the one bank it is read from), and `ScraptfKeyRun` names
   the runs index entry; `BankStockSort` gains `'sinceListed'` beside the spec's `'listed'`.
2. Item history reads one bank's observations (the spec's points per covering save), so an item on a bank page and on
   the list shows the bank page's history; a change line from the other bank is labelled with it.
3. An item's events are read per copy (bank stock special key), not the spec's per base SKU: a busy clean copy's
   `stock` events would otherwise push a painted copy's out of the newest 50.
4. In a bank saved as several pages, a `gone` is dropped when another page's newest save lists the copy; an item that
   moved can read `restocked` on its new page (the stock page shows it as new there, F17).
5. `restocked` counts only retained saves: once the save that listed an item before is thinned, its return reads `new`.
6. The bank stock CSV has no listed columns: `test/service/bankStockRpc.test.ts` pins its header and the spec did not
   ask for them.
7. The F17 cache still loads each bank's saves with `bankStockSaves` (per-bank failure isolation, pinned by its tests)
   rather than one `bankStockSaveIndex()`, each page's 10 newest (`perPage`); about 5 ms per refresh at the
   300 x 8 x 300 extreme.
8. The history index loads lazily and synchronously on its first read (about 2 s at 600,000 rows, far less for
   typical data); making it incremental would change `refresh()`'s contract.
9. The drawer knows only a SKU, so a change of a painted copy opens the clean copy's history (`ScraptfHistory` takes
   an optional `special` for a caller that knows the copy).
10. Reminders live in Settings → Saved-page import (the import switches stay on the Import page); the last ticked bank
    cannot be unticked, since `[]` means every bank (minutes 0 turns reminders off). Their last-reminded times are in
    memory, so a restart may remind once more.
11. A notification whose link is valid opens only the bank page (not the dashboard too); one whose link is refused
    behaves exactly as before 0.6.
12. The Live log's tab comes from the route (`#/log/changes`), not a stored preference, and only the opportunity events
    tab clears the nav badge.
13. Known limits: README "Known limits" (gaps between saves, only pages saved, thinner older history and time listed
    counted over kept saves, restocked needing a kept earlier save, painted copies in the drawer, reminders only while
    the app runs, the first history read).

## The scrap.tf window (F21)

An opt-in window in which the user browses scrap.tf themselves, while Flip Desk reads what is on screen and
feeds it to the saved-page import, as if the user had saved the page with `Ctrl+S` ("Webpage, Complete").
Code comments say **F21**. This is the brief's option D (§3.1, §3.5), built without scrap.tf's written
permission at the user's explicit, informed choice on 2026-10-19 (deviation 10 below). The boundary
paragraphs of F14 to F20 describe those features and still hold for them; F21 is the one exception they
predate.

**Decision and boundary.** The user chose this feature after being told that scrap.tf's ToS forbids
"automation, scripts, user-scripts, auto-refreshers, external tools" for advantage, that staff ruled scripts out
on banking pages, and that scrap.tf can see the app and may ban the account, possibly on backpack.tf too (same
owner). Still refused, and never built:

- the app fetching scrap.tf on its own: no HTTP client request, `/ajax`, `ws.scrap.tf` socket, download, polling,
  auto-refresh, or load, reload or history step driven by a timer, an event or a promise callback;
- reading, exporting or reusing the user's cookies or session (`session.cookies` appears nowhere in `src/`);
- setting or spoofing the user agent (`setUserAgent` appears nowhere; Electron's default names the app and
  Electron);
- solving or bypassing Cloudflare or any challenge (its frame may load so that the **user** solves it);
- clicking, typing, scrolling, input events or any DOM write in the page; buying, queueing or trading.

The service's net policy (`src/service/net/policy.ts`) is unchanged and still refuses every scrap.tf host and
`ws.scrap.tf`. Every scrap.tf page load in the window is the user opening it (a static start page), a toolbar
click (back, forward, reload, home, a bank chip, Log out & clear) or the user's own click in the page. The one
thing the app adds is a read-only snapshot of the DOM already loaded, which adds no network traffic.

**S1 Settings** (`settings.scraptfWindow`, `settingsSchema.ts`, defaults in `defaults.ts`). `{ enabled: false,
acknowledgedAt: null, keepLoggedIn: false, readOnLoad: true, openLinksInWindow: false }`, in the full and the
patch schema. The strict setter (`applySettingsPatch` → `gateScraptfWindow(next, turnsOn)`) refuses turning the
window on without `import.enabled`, `import.acknowledgedAt` and `scraptfWindow.acknowledgedAt`, with a fixed
message (`SCRAPTF_WINDOW_NEEDS_IMPORT`, `SCRAPTF_WINDOW_NEEDS_ACK`). A change that removes a gate while the window
is on (import off, an acknowledgement withdrawn) turns the window off instead of being refused, and main closes
the window when `enabled` flips to false. The lenient load fills a pre-0.7 file with the defaults silently and
loads a file with the window on but a gate missing with the window off (`invalid` gets `scraptfWindow.enabled`).
The mock applies the same gate.

**S2 Policy** (`shared/scraptfWindowPolicy.ts`, pure, zod-free; unit-tested with URL tables).

- `isScraptfPageUrl` (also `shouldReadUrl` and the service's `address` rule): https on exactly `scrap.tf`, no port,
  no userinfo, the raw string checked too.
- Start pages: `SCRAPTF_WINDOW_START_URLS` = `SCRAPTF_HOME_URL` (`https://scrap.tf/`, not in
  `STATIC_EXTERNAL_URLS`), the seven `SCRAPTF_BANKS` bank pages and `/items`; `isAllowedWindowStart` is an exact
  `Set.has` (no other path, query, hash, case or trailing slash).
- `topLevelNavigationDecision`: `'allow'` for scrap.tf and Steam's sign-in (`steamcommunity.com` `/openid`,
  `/openid/*`, `/login`, `/login/*`); `'external'` for anything `isAllowedExternalUrl` accepts (Steam's linkfilter is
  not); `'block'` for everything else (http, other hosts, `file:`, `javascript:`, `data:`).
- `subframeNavigationDecision`: scrap.tf, `challenges.cloudflare.com`, Steam's sign-in, and exactly `about:blank`
  and `about:srcdoc` (they load nothing from the network, and pages build them for their own scripts).
- `windowDisplayUrl` (origin and path, never a query or hash) for every URL in a push or a log; `scraptfPathOf`
  and `windowReadFileName` (`'scrap.tf window /buy/hats'`).
- `READ_SCRIPT`, pinned verbatim: `((h) => (typeof h === 'string' && h.length <= 20971520 ? h : null))(document.documentElement ? document.documentElement.outerHTML : null)`.
  It reads one property. `READ_SCRIPT_FORBIDDEN` / `readScriptProblems` reject assignments, `++`/`--`, request
  APIs, events, click, focus and scroll, DOM writes, page state (location, history, cookie, storage, window…),
  `new`, `delete` and `await`. `readResultHtml` checks the result (a non-empty string within `READ_MAX_CHARS`,
  20 MiB, equal to main's `MAX_IMPORT_BYTES`).
- Timings: `READ_WORLD_ID` 1001 (not the page's world 0, not Electron's preload world 999), `READ_SETTLE_MS`
  4 s, `READ_MANUAL_MIN_GAP_MS` 2 s, `READ_AUTO_MIN_GAP_MS` 30 s, `READ_DEDUPE_MS` 60 s,
  `EXTERNAL_OPEN_MIN_GAP_MS` 1 s. Fixed texts: `SCRAPTF_READ_REASONS`, `SCRAPTF_WINDOW_OFF`,
  `IMPORT_HTML_ORIGIN_REFUSAL`.

**M1 The window** (`main/scraptfWindow.ts`, `createScraptfWindowManager`; built at start, opened only on a click).
A `BrowserWindow` titled "scrap.tf · Flip Desk" (kept when the page title changes) whose own page is the toolbar,
`SCRAPTF_BAR_URL` (`app://app/index.html#/scraptf-bar`, window kind `'scraptf'`, the normal preload and
`windowWebPreferences`, a trusted sender like every app:// page). Below its 48 px sits one `WebContentsView` built
only from `scraptfViewWebPreferences(partition, devTools)`: **no preload**, `sandbox`, `contextIsolation`, no Node
(also in workers and subframes), `webSecurity`, no insecure content, no webview tag, `spellcheck` off, devTools
only in development. Its bounds follow resize, maximise, unmaximise, restore and full-screen changes.

- **Session.** `session.fromPartition('scraptf')` (memory) or `'persist:scraptf'` (keepLoggedIn: Chromium's own
  cookie store on disk, encrypted with Windows DPAPI in packaged builds by the `enableCookieEncryption` fuse in
  `electron-builder.yml`, pinned by a test; an unpackaged development run has no fuses and stores it in plain text,
  so the user-facing text makes no claim either way), passed
  once through `hardenScraptfSession` (`windows.ts`) before the first load: every permission and device request
  denied, downloads cancelled, and, unlike `hardenSession`, no request filter (the page loads its own resources;
  the app adds none). `fromPartition` and `persist:scraptf` appear only in this module.
- **Generic hardening.** `'web-contents-created'` fires inside the view's constructor, so main passes
  `hardenWebContents(contents, log, { ownNavigation: (c) => scraptfWindow.ownsContents(c) })`: the view's
  navigation is left to this module's policy (asked at event time; a throwing predicate fails closed), webviews
  stay blocked, and every other webContents keeps app:// only.
- **Navigation.** `will-navigate`, `will-frame-navigate` and `will-redirect` apply `topLevelNavigationDecision` to the
  main frame and `subframeNavigationDecision` to frames. `setWindowOpenHandler` always denies. A page the policy
  calls `'external'` reaches the user's browser only through `openOutside()`, which checks the decision again, needs
  a real input to the view (`input-event` mouseDown, rawKeyDown, keyDown or gestureTap, never a mouse move or wheel)
  within `USER_ACTIVATION_MS` (5 s, Chromium's transient activation, so a server redirect after a click still opens)
  and consumes it, so one input opens one tab at most and a page's script cannot open any on its own;
  `EXTERNAL_OPEN_MIN_GAP_MS` only dedupes the twin will-frame-navigate and will-navigate of one click
  (`deps.openExternal` is main.ts's third `shell.openExternal`). A scrap.tf popup is dropped, never loaded. Blocked
  URLs are logged by `windowDisplayUrl` only, and every line a page can trigger at its own rate (a blocked page,
  frame or popup, a link out without input, and in `hardenScraptfSession` a denied permission or download) goes
  through `main/pageLog.ts`: one line per kind a minute, the rest counted and logged with the next line or when a
  new document commits or the window closes, so a page cannot flush `main.log`.
- **Client certificates.** main.ts answers app `'select-client-certificate'` with `refuseClientCertificate`
  (`windows.ts`): `preventDefault()` and no certificate. Without it Electron hands the first matching certificate in
  the user's store to any host that asks, and the view's pages (no request filter) can reach any host.
- **Loads.** Every `loadURL`, `reload`, `navigationHistory.goBack` / `goForward` of the view sits in
  `function userNavigate`, called only from the user actions `open`, `back`, `forward`, `reload`, `home`, `go` and
  `clear`. It does nothing while the window is off, quitting or disposed, checks `isAllowedWindowStart` before
  `loadURL`, and passes the URL alone (no user agent, headers, referrer or body). From 0.7.1 (F21-11) the view's
  `before-input-event` (key-down of F5, Ctrl+R, Alt+Left, Alt+Right, Alt+Home, never a repeat, with `preventDefault`)
  and the window's `app-command` (browser-backward, browser-forward) call `pressKey`, which calls only `back`,
  `forward`, `reload` and `home`; the compliance scan allows it from exactly those two listeners (`windowKeyProblems`).
  Nothing moves the focus (deviation 12). `open(start)` of the page already on screen (same page key, main frame not
  loading, no failure notice) only reveals the window (F21-7); a page that failed or crashed is loaded again. `open(start?)` and `go(url)`
  take the static list only (`SCRAPTF_START_REFUSAL`, never quoting the URL); `open` throws `SCRAPTF_WINDOW_OFF`
  while off; a new window loads `start` or Home, an open one only the page asked for; `home` and `go` open a closed
  window. Nothing retries on `did-fail-load` or `render-process-gone`; a dead toolbar renderer closes the window.
- **keepLoggedIn.** A partition is fixed per view. From 0.7.1 (F21-6) it is chosen only when the window is created:
  a change while the window is open waits for close and reopen (`ensureWindow` returns false for any live window),
  `state().pendingPartitionChange` is true meanwhile, and the toolbar shows a "Reopen to apply" pill (it asks
  `'scraptfWindow.state'` again when the setting changes). In 0.7.0 the next `open()` rebuilt the view, losing the page.
- **Bounds** (0.7.1, F21-12, `windowBounds.ts`). `getNormalBounds()` and `isMaximized()` are saved on 'close' and in
  main's close() to `userData/scraptf-window-bounds.json` (version 1, x, y, width, height, maximized; zod-checked,
  written atomically, only when changed), not settings.json. They are restored only if at least 120 x 48 px
  (`MIN_VISIBLE`) lies on a current display's work area; otherwise the window opens at 1280 x 900, fitted and centred
  on the display under the cursor. A maximised window is maximised again at first show. main.ts passes
  `bounds: { file, screen }`; tests inject a fake screen.
- **Close and dispose.** Closing the window (the user, `close()` when the window is turned off, `dispose()` at
  quit) closes the view's webContents (not destroyed with its window), clears the settle timer and forgets the
  window; `dispose()` blocks later opens.

**M2 Reads.**

- **Triggers.** The main frame's `did-finish-load`, and its `did-navigate-in-page` once the document has had its
  own `did-finish-load` (or nothing is loading; one during the load leaves the read to `did-finish-load`), when
  `readOnLoad` is on and `shouldReadUrl` passes. These follow the user's browsing and also what the page's own
  scripts do (a reload, a `replaceState` to a new query); the app cannot tell the two apart. From 0.7.1 only a page
  `scraptfImportablePath` accepts is read (F21-4; Read page now elsewhere answers `SCRAPTF_READ_REASONS.notImportable`
  and the toolbar disables it from `nav.importable`), and a page notice blocks automatic reads until the next commit
  (F21-3, F21-10): a scrap.tf main-frame document answered 403 or 503 (a challenge or error page) or 429 (rate limit)
  from `did-navigate`, Chromium's error page after a failed load, or a crashed renderer. Read page now still reads
  such a page and words an empty result by its notice; the gap and `autoEmpty` are left alone. Each starts a cycle: one
  read now (`readPage('load')`) and exactly one `timers.setTimeout(() => void readPage('settle'), READ_SETTLE_MS)`,
  the module's only timer, because scrap.tf adds cards after load. While the main frame is still loading
  (`canRunNow`: `getURL()` and `!isLoadingMainFrame()`, Electron's own test) the cycle waits for `did-stop-loading`;
  a commit in between drops the wait. A cycle ends (`endCycle`: no settle read, its held load snapshot imported) when
  a new main-frame document commits (`did-navigate`), when a main-frame load fails with Chromium's error page (not
  `ERR_ABORTED`), when the view's renderer goes, at every toolbar move (`userNavigate`: start, back, forward,
  reload), when another cycle starts, on close and on a keepLoggedIn rebuild; dispose and Log out & clear drop it
  unimported. A click the policy blocked or sent to the browser keeps it. **Read page now** (`readNow`) reads at once,
  at most every `READ_MANUAL_MIN_GAP_MS`, and ends the page's cycle (its snapshot is the newest look).
- **One look, one save.** The load read only holds its snapshot (`held`, the toolbar's nav says `reading`); the
  settle read imports its own snapshot, or the held one when it got nothing, at the cycle's start time. A cycle
  that ends before its settle read imports the held snapshot then: HTML already read, never a new read or load.
  So a page whose cards arrive late is saved once, compared with the user's previous save, and never shows a card
  as gone and restocked, or as a new flip, 4 s apart. From 0.7.1 (ACT-4) a held snapshot imported without its settle
  read (`flushHeld`, the settle read falling back to it, or a load read whose cycle ended mid-script) is sent with
  `settled: false`; the service stores its prices but no bank stock save (S3). Only settled imports count for the
  dedupe, so the same HTML read settled later is imported again.
- **Gap and dedupe.** Automatic read cycles of one page (its URL without the hash; up to 64 pages remembered) start
  at least `READ_AUTO_MIN_GAP_MS` apart; the settle read belongs to its load's cycle. An automatic read whose
  sha256 equals that page's last imported read within `READ_DEDUPE_MS` is skipped. A new document of a page whose
  last cycle recognised no item (a Cloudflare check served at the page's own address, a failed read) starts a new
  cycle within the gap, so the real page the user lands on after solving the check is read. A failed import is not
  remembered, so the next read tries again. A load or settle read checks `readOnLoad` again when it runs. Read page
  now is deduped the same way: an unchanged page within `READ_DEDUPE_MS` is not imported again, and its last read is
  pushed again with the reason `unchanged`. From 0.7.1 (F21-10) a page shown again within the gap, or unchanged
  within the dedupe, re-pushes that page's own last read with the warning `SCRAPTF_NOT_READ_AGAIN` ("Read page now to
  read it again"), only while that page is the document on screen. An automatic read that ends while a page notice is
  up (UX-071-1: the held load snapshot of the page before, imported at the commit of a 429, a check or a failed load,
  or of the same address reloaded into one) is remembered for its page but not pushed, so it never hides that notice;
  no automatic read runs on such a document, and Read page now still takes the line. While the item schema loads the service refuses
  the import with `IMPORT_SCHEMA_LOADING_MESSAGE`; main matches `IMPORT_SCHEMA_LOADING_CODE` and pushes the fixed
  `SCRAPTF_READ_REASONS.schemaLoading` read, remembers nothing and keeps `autoEmpty`, so the next read imports (F21-1).
- **The read.** `executeJavaScriptInIsolatedWorld(READ_WORLD_ID, [{ code: READ_SCRIPT }])` on the view's main frame,
  only for the URL of the document on screen (`mainFrame.url`, the last committed one: `getURL()` already names a
  toolbar load still pending, which would file the old DOM under the new page's bank), and only when `canRunNow`
  holds, checked with no await before the call: Electron 44 waits for `did-stop-loading` otherwise and then runs the
  script on whatever document is there, such as Steam's sign-in after the user clicked "Sign in through Steam"
  (refused with `SCRAPTF_READ_REASONS.loading`). Dropped when the document changed while the script ran. One read
  at a time per view (`readingIn`): a read whose renderer never answers (the view closed or its renderer died
  mid-read) holds back only that view, until it is dropped or its renderer goes, with no extra timer. Then
  `deps.importHtml({ html, fileName: windowReadFileName(url), mtimeMs, address: url, origin: 'window' })`, which
  main.ts sends straight to the service (`host.call('import.html', p)`), never through the router. The name is cut to
  `WINDOW_READ_NAME_MAX` (260, the service's `fileName` cap, pinned by a test), so a long path is not refused on
  every read.
- **Status.** Each read pushes `'scraptfWindow.read' { at, path, items, bank, newFlips, warning, stored, pageFlips,
  bestFlip }` (the last three from 0.7.1: `ImportResult.stored`, `pageFlips` and `topFlips[0]`, its SKU checked against
  the openItem shape and its name cleaned and cut to 120 characters) to the toolbar
  and keeps it as `lastRead` (forgotten by Log out & clear). `warning` is the import's first warning cut at its `:`
  (the code, never the clipped page text after it); for a read the service recorded nothing for (`batchId: 0`),
  `no-cards-saved` on a bank or list page ("no items on screen yet; wait for them, then Read page now") and
  `SCRAPTF_NOTHING_TO_IMPORT` elsewhere; or a fixed `SCRAPTF_READ_REASONS` text for an empty or failed read. From
  0.7.1 `importWarning` picks by priority: partial-read, layout-changed (preferred over no-cards-saved), no-stock-limit,
  no-sku, no-price-column, unknown-bank, no-pays-column, then any other code but duplicate-cards and
  page-kind-guessed, with counts as digits only ('partial-read: 3 48', 'no-sku: 2 48'); every code has toolbar text in
  `WINDOW_WARNINGS`. Logs carry the path and counts only: never the HTML, a URL query or an error's cause.

**M3 Toolbar, tray, links and IPC.**

- `'scraptfWindow.nav' { url (windowDisplayUrl), canGoBack, canGoForward, loading, reading, importable, notice }` goes
  to the toolbar on `did-navigate`, in-page navigation and start/stop loading. From 0.7.1 `notice` is fixed text
  (`SCRAPTF_WINDOW_NOTICES`): a response notice (403/503 challenge or error, 429 rate limit; scrap.tf documents only), a
  load failure by Chromium net-error group (offline, insecure, bad response, other) or a crash, each ending "press
  Reload" and cleared at the next commit, or a link notice (a blocked link, a dropped popup, a link out without a
  click), which never replaces a page notice and changes at most once a second (`LINK_NOTICE_MIN_GAP_MS`); pushed only
  when it changes. Pushes wait (the latest per event) until the toolbar
  page's `did-finish-load`, then go out before the current nav. `send()` forwards only main's `settings.changed`
  (the theme) and `service.state`; both F21 pushes are in `MAIN_ONLY_PUSH_EVENTS`, so the service host and
  `handlePush` drop them if the service sends them.
- **Log out & clear** (`clear()`): `clearStorageData()` and `clearCache()` on both partitions (a login kept on disk
  before keepLoggedIn was turned off goes too), the read memory, a cycle under way and `lastRead` forgotten, a null
  `'scraptfWindow.read'` pushed (so the toolbar drops its read whether it or Settings asked), then Home if the window
  is open (the user's click). It works while the window is off.
- **Tray.** "Open scrap.tf window" after Quick entry, only while the window is enabled (`TrayState.scraptfWindow`,
  part of `menuKey`); its click checks the setting again and logs a refusal safely.
- **Router** (`ipc.ts`). `'scraptfWindow.open' { start? }`, `back`, `forward`, `reload`, `home`, `go { url }`, `read`, `clear`
  and `state` are main methods; every action but `clear` and `state` is refused while the window is off
  (`SCRAPTF_WINDOW_OFF`) or missing (`SCRAPTF_WINDOW_UNAVAILABLE`), and `start`/`url` pass a zod rule with a fixed
  message. A page's `'import.html'` that carries `address` or `origin` (any value) is refused with
  `IMPORT_HTML_ORIGIN_REFUSAL`; only main's own window read sets them. `links.open` hands a URL to the window
  (`{ opened: true, reason: null, openedIn: 'window' }`) only when the caller sends `allowWindow: true`, the window
  is enabled, `openLinksInWindow` is on and `isAllowedWindowStart(url)`. Only the opens worded through
  `scraptfLinksInWindow` send it: the Live market's scrap.tf button and header bank link, Open on scrap.tf in the
  drawer and the row menu (`openOnScraptf`), the banks cards and, from 0.7.1, the Bank stock page's Open (F21-9).
  Everything else (Shopping, the scrap.tf/items card's browser button, the drawer's list buttons, every other link)
  goes to the browser exactly as its words say, and Home never does. The scrap.tf/items card and the Bank stock page
  also get a click-only "Open in Flip Desk window" (`'scraptfWindow.open'` with the static page) while the window is
  on (UX-5). `'app.showBankStock' { bank, filter }` (0.7.1, zod: `isScraptfBank`, 'flips' | 'new') shows the dashboard
  and sends it `'ui.openBankStock'`; it loads nothing in the scrap.tf view.

**S3 Service** (`import/savedPage.ts`, `rpcHandlers.ts`, schema V9).

- `'import.html'` takes optional `address` (at most 4,096 characters, `isScraptfPageUrl`, fixed message
  `'not a scrap.tf page address'`) and `origin` (`'file' | 'window'`). `importSavedPage` checks both again for
  callers that skip zod: anything but `'window'` is a file, and an address `isScraptfPageUrl` rejects is no hint.
- The address is a page-address hint only, exactly like an `.mhtml` part's Content-Location:
  `parseSavedPage(text, fileName, schema, { address })` passes it to `parseScrapTfHtml`, read before the saved-from
  comment, the canonical link and `og:url`. It is never stored, logged or pushed.
- A window read is refused with `SCRAPTF_WINDOW_OFF` while the window is off, after the import gate. Its name is
  kept whole (`'scrap.tf window /buy/hats'`, not cut to a basename), cut at the first `?` or `#`, without control
  characters, trimmed and at most 200 characters, and never used to detect `.mhtml`.
- A window read that gives no items (scrap.tf's front page, a profile, a bank read before its cards arrive)
  records nothing: no batch, no push, no price, stock or event change. It answers `batchId: 0` with the one warning
  `WINDOW_NOTHING_TO_IMPORT`. A file save of a bank page without its cards is recorded as before (F18).
- **V9** `import_batches.origin TEXT NULL`: every batch stores `'file'` or `'window'` (`recordSkippedImport`
  `'file'`); batches from before 0.7 read null. `ImportResult.origin` is always set, and `ImportResult.newFlips`
  only for window reads that wrote bank stock (`BankStock.newFlips(bank, batchId).length` after
  `bankStockChanged`; 0 on a page's first save).
- Everything downstream is unchanged: a window read and a file save of the same page give the same parse, result,
  batch (apart from id, name and origin), prices, bank stock rows, page keys, change events, pushes and "What's
  new". From 0.7.1 a window read that wrote a save also carries `pageFlips` and `topFlips` (UX-3), and `settled:
  false` (main only) stores prices and the batch but no bank stock save (`stockSave: 'unsettled'`).

**Renderer.**

- **U1 Toolbar** (`pages/ScraptfWindowBar.tsx`, window kind `'scraptf'`, `styles/scraptf-window.css`, @imported
  last). One 48 px line: Back, Forward, Reload, Home; bank chips from `SCRAPTF_BANKS` through `'scraptfWindow.go'`
  (`aria-current` on the page on screen); a read-only address (origin and path); **Read page now** (disabled off
  scrap.tf and while a read runs, and from 0.7.1 on a page the import does not read; main's reason shown when none is
  taken); the status line "Read 48 items from /buy/hats · 2 new flips · 3 s ago" (from 0.7.1 "Read 48 items from
  /buy/hats · stored 46 · 10 flips (2 new) · best Team Captain +0.44 ref · 3 s ago", 'stored' only when it differs;
  the best flip's name is a click-only `'app.openItem'`, and a click-only **Show flips** calls `'app.showBankStock'`
  always on the Flips chip (UX-071-2: the read's "k new" counts new since the read before, the New chip new since the
  session baseline, non-flips included, so it could hold none of them; Flips holds every flip with its New badge; the
  'new' route stays for other callers); the notice line; the "Reopen to apply" pill) (the live region
  changes only with a new read); **Log out & clear** behind a
  confirmation; and the always-visible "External-tool risk" pill, whose tooltip is the one-line risk and whose click
  puts the full text in the status line. Keys: Alt+Left, Alt+Right, F5 or Ctrl+R, Alt+Home (held keys ignored), and
  the arrow, Home and End keys between controls. It asks `'scraptfWindow.state'` once on mount (pushes that came
  first win). Window moves and reads are called only from click and key handlers.
- **U2 Settings → scrap.tf window (opt-in)** (`ScraptfWindowSection`, after Saved-page import). What it does and
  never does, the risk (the ToS words, the staff stance, what scrap.tf can see, a ban possible on both sites), the
  acknowledgement (writes `acknowledgedAt`, shows when it was accepted), the switch (disabled until import is on and
  the box is ticked; main's refusal shown as an alert), toggles for keepLoggedIn, readOnLoad and openLinksInWindow,
  **Open the scrap.tf window** and **Log out & clear**. The ToS link goes to the About page, which already links
  it: Settings stays on F20's opener-free list.
- **U3 Entry points**, only while the window is on: the "scrap.tf window" nav button under scrap.tf banks (not a
  route; `'scraptfWindow.open'`, a toast when refused); "Open in Flip Desk window" on each Banks card (its static
  `SCRAPTF_BANKS` page; "Open in browser" goes while openLinksInWindow is on). The Live market row, header bank
  link, drawer and ItemMenu keep their static URLs and F19's scans; `openedIn: 'window'` only changes their toast
  ("the Flip Desk window") and wording.
- **U4 Import page.** Batches and results with origin `'window'` show a "Flip Desk window" pill with their page
  (`scrap.tf/buy/hats`) in place of a file name; window reads get their own no-cards wording, and
  `importNoticeToastText` returns null for them so the dashboard does not toast every read.
- **U5 About page** words R1, R3, R9 and R10 as above.
- **Mock.** `mockScraptfWindow.ts`: a fake history, main's validation, made-up reads with
  `MOCK_WINDOW_READ_WARNING` and `openFromLink`; `mock.ts` gates `settings.set`, routes `links.open`, refuses a
  page's `address`/`origin`, answers all nine methods, and serves the toolbar at `#/scraptf-bar` with import and the
  window on. No page is ever loaded in the browser mock.

**Compliance** (`test/compliance/static.test.ts`, "the scrap.tf window loads only what the user asks for …"; the R1
checks rewritten precisely, nothing else weakened). Only `main/scraptfWindow.ts` may carry a scrap.tf address into
`.loadURL(` or `new BrowserWindow(`/`new WebContentsView(`, and only it may name `WebContentsView` (`BrowserView`
nowhere), `fromPartition`, `persist:scraptf` or `origin: 'window'`; fetch, `.request`, `downloadURL`, sockets and the
service's net modules stay forbidden there, and so do a session's `preconnect` and `resolveHost` (in `LOADERS` too,
so no file passes them a scrap.tf address). Every load or history step sits in `function userNavigate`, outside any
deferred callback, called only from a user action and only after `isAllowedWindowStart` (the toolbar's own
`loadURL(SCRAPTF_BAR_URL)` aside); a bare call of a user action (`reload()`, `home()`…) is allowed only inside another
user action, never in a deferred callback or any other function. In the other `main/*.ts` files a call of the manager
(`scraptfWindow?.open(`, the router's `windowOn().x(` and `w.x(`, `openScraptfWindow(`) never sits in a timer, a
listener, a subscription (`.onX(`) or a promise callback. The module's timers are the pass-through and the one
settle read, and `readPage`, `importRead`, `flushHeld` and `endCycle` neither navigate nor start a timer. `executeJavaScriptInIsolatedWorld` appears only there, exactly as
`(READ_WORLD_ID, [{ code: READ_SCRIPT }])`; `executeJavaScript`, input events, `insertCSS`, edit commands and a second
`READ_SCRIPT` appear nowhere else. `READ_SCRIPT` is pinned and token-checked. One view, built from
`scraptfViewWebPreferences`, which has no preload and every locked-down flag; no `preload:` key in the module and
no `setPreloads`/`registerPreloadScript` anywhere. No `setUserAgent`/`userAgentFallback`/`.userAgent =`, header option or header
hook, and no `.cookies`, `cookies.get/set/remove/flushStore`, `document.cookie` or `cookieStore.` anywhere in
`src/`. `openExternal(` in the module follows a `topLevelNavigationDecision(…) 'external'` check. A dashboard file
calls a window move or read only from a click: never in an effect, a push listener, a timer or a promise callback.
`checkUrl` still refuses `https://scrap.tf/`, `/buy/hats`, `/ajax/`, `www.scrap.tf` and `wss://ws.scrap.tf/`.
Synthetic sources prove each scan.

**Tests.**

- Shared: `test/shared/scraptfWindowPolicy.test.ts` (URL tables for every rule, the pinned script run against a
  stand-in document, the gate).
- Main: `test/main/scraptfWindow.test.ts` (Electron fakes in `scraptfWindowFakes.ts`, whose cookies getter throws
  and whose `executeJavaScriptInIsolatedWorld` waits for `did-stop-loading` while the main frame loads, as Electron
  44 does, recording the document it ran on: prefs and no preload, the hardened session, bare loads, refusals,
  off/quit/dispose, keepLoggedIn, layout, no user agent, cookie or other script over a whole session, the
  navigation, frame and popup decisions, links out only after the user's input, query-free and throttled logs, no
  load from any event, timer or failure, one move per control, every read rule including the Cloudflare re-read,
  one save per look, no read during a pending navigation (never on Steam's sign-in), a hung read holding back only
  its view, clear, close, the toolbar's pushes), `scraptfWindowRpc.test.ts`, `settingsScraptfWindow.test.ts`,
  `tray.test.ts`, `windows.test.ts` (the session's throttled lines, `refuseClientCertificate` and its registration)
  and `scraptfWindowWiring.test.ts`: main's real settings store and router, the real manager and the service's real
  `'import.html'` over an in-memory repo. Enabling is refused without the acknowledgements; `open()` loads only a
  static start page; nothing loads without a user action; a scrap.tf `did-finish-load` runs `READ_SCRIPT` in world
  1001 and imports the page with origin `'window'` and its address, giving the same batch as a file save of that
  page; a load whose cards arrive late is one save compared with the previous file save (no gone, restocked or new
  card, no new flip); a bank page with no cards yet says to read again; a long path imports; Settings' Log out &
  clear empties the toolbar; Steam's sign-in is never read; external pages reach the browser only through the
  allowlist and after a click; `links.open` uses the window only with openLinksInWindow and `allowWindow`. From
  0.7.1 also `windowBounds.test.ts` (a real temp-dir file round trip) and `scraptfWindowWiring.integration.test.ts`:
  the window wired to the real service core (schema loading then loaded, the toolbar's flips through Show flips to
  the stock page's chip, an unsettled snapshot writing no save).
- Service and db: `test/import/importWindowRead.test.ts` (all eight fixtures as a window read and as a file save,
  the address hint, refusals, origins, names, nothing to import, the window off), `test/service/importOriginParams.test.ts`,
  `test/db/importOrigin.test.ts`.
- Renderer: `scraptfWindowModel`, `scraptfWindowBar` (mounted against the mock: no move on mount or on a push),
  `settingsScraptfWindow`, `scraptfWindowNav`, `scraptfWindowLinks`, `mockScraptfWindow` and the F21 block of
  `banksPage` tests.

**Window test** (0.7.1, `--smoke-window=<report.json>`, `main/smokeWindow.ts` with the pure router
`main/smokeWindowFixtures.ts`). It is a diagnostics-only live run of the real window, toolbar, view and service
import, and it never contacts scrap.tf or any other site from the window.

- **Gate** (`smokeWindowRefusal`, paths.ts). The run needs diagnostics (as `--smoke-test`), a report path and a
  `--user-data-dir` that is not, is not inside and does not hold `appData/<app name>`. It cannot run beside
  `--smoke-test`. Otherwise main prints a fixed refusal and exits 1 before the profile, the lock or any window.
  Only then does main load the harness, with a gated `import()` before `start()`.
- **Local network.** The harness's `session-created` and `web-contents-created` hooks give every non-default
  session `protocol.handle('https'|'http')` through the router, never a real fetch. A `webRequest.onBeforeRequest`
  filter, installed first, cancels every other scheme, and http(s) too until both handlers are in (fail closed).
  main also sets `host-resolver-rules` `MAP * ~NOTFOUND` and `no-proxy-server` (Chromium only; the service's
  Node traffic is unchanged), so a request no handler sees, such as a resource-hint preconnect, has no name to
  connect to and no proxy to resolve one. Preconnects are recorded and fail the run.
- **Nothing to the user's browser.** The window hands a page its policy calls `external` to the browser after a
  click or key, and synthetic input counts. The harness replaces `shell.openExternal` with a recorder before
  `start()`, checks the replacement before the window opens, and fails the run on any attempt.
- **What it records.** It taps the toolbar's `push` sends, the view's navigations and `before-input-event`, and the
  view's script calls. Each is passed through unchanged.
- **Steps.** It sets the window's settings in that profile and waits up to 60 s for the item schema. It then
  file-imports `buy_hats.html` and `unusuals.html` an hour back, and runs the nine steps of its spec.
- **Reads.** Each window read must match the file save of its fixture: the same on-sale rows, no change event
  and the same card count.
- **Keys.** These steps are reported `untestable`, not failed, when synthetic input does not reach
  `before-input-event` or lacks a real key's fields.
- **Report.** Steps, every request, script runs and a search for the Steam page's sentinel in the toolbar's
  pushes, batches, parser reports, logs and database. The network check also needs every document the view
  showed to be one the router served, and the script check needs the spy to have seen the reads the toolbar
  got. The sentinel is cut out of the report file if anything carried it there, which fails the run. The
  report has its own two-minute ceiling. A diagnostic run also registers no hotkey, clipboard watcher or
  notification (`diagnosticRun`).
- **Compliance.** Only `smokeWindow.ts` may send input events, focus a page, `loadURL` outside `windows.ts` and
  `scraptfWindow.ts` (into the view, `SMOKE_…_URL` only), call `protocol.handle` (besides app://) or use
  `webRequest` (besides `hardenSession`). Only main.ts imports it (a type, plus the one gated `import()`), and only
  the harness imports the router. The gate's lines in main.ts are pinned.
- **Deviations from its spec.**
  - The window reads only importable paths (F21-4), so step 6 first checks that `/smoke/partial-hats` is not
    read, then loads the same partial page at `/buy/hats?smoke=partial-hats`. That address is importable, and its
    hint and page key are `/buy/hats`.
  - Step 5 also loads the challenge at `/buy/hats?smoke=challenge`. `/smoke/challenge` is not importable, so
    only at an importable address does "a challenge is never read" depend on the window seeing the 403.
  - Step 4 clicks the local home page's Steam link, so `will-navigate` asks the policy (Electron asks it nothing
    for a `loadURL`). A click the policy was asked about and that did not load fails the step. Only a click
    that never reached the link falls back to `loadURL`, after checking the policy's answer for the address.
  - `scraptfWindow.ts` and `READ_SCRIPT` are unchanged.

Decisions and deviations from the F21 spec:

1. Removing a gate while the window is on (import off, an acknowledgement withdrawn) turns the window off instead
   of refusing the change, so the user can always turn import off; main then closes the window.
2. Frames may also load `about:blank` and `about:srcdoc`, which load nothing from the network.
3. `links.open`'s result gains `openedIn: 'window'` (absent: the browser) so the toasts say where the page went, and
   its params `allowWindow`, so only the opens worded for the window go there (the spec routed every static link).
4. `hardenWebContents` takes an `ownNavigation` predicate for the view, and the view's session gets its own
   `hardenScraptfSession` (no request filter, which would block scrap.tf). main.ts has a third `shell.openExternal`,
   the window's `openExternal` dependency.
5. Log out & clear clears both partitions and forgets the reads and the last read; it is allowed while the window
   is off. A login kept on disk before keepLoggedIn was turned off stays until then.
6. Reads use the main frame's committed URL, not `getURL()`, and are dropped if the document changed during the
   script; none runs while the main frame loads, and an automatic read that came then starts at `did-stop-loading`.
   The settle read is cleared at a commit, an error page, a renderer crash or a toolbar move rather than at
   `did-start-navigation`, so a blocked click keeps it. An in-page navigation during the initial load is left to
   `did-finish-load`; after it, one reads even while a frame (a challenge, an embed) is still loading.
7. The settle read belongs to its load's cycle: exempt from the 30 s gap, still deduped. The gap and dedupe key is
   the URL without its hash, for up to 64 pages.
8. Beyond the spec's gap rule: a new document of a page whose last automatic cycle recognised no item reads within
   the 30 s gap. A Cloudflare check served at the page's own address otherwise used up the gap, and the real page
   the user reached by solving it was not read. Nothing was imported in that cycle, and in-page navigations still
   wait out the gap.
9. A window read with no items records nothing (`batchId: 0`, `WINDOW_NOTHING_TO_IMPORT`), so the Import page does not
   fill with front-page and profile rows and a bank read before its cards is not a "saved without its items"
   notice; main shows "Nothing to import on this page.", or for a recognised bank or list page the import's
   `no-cards-saved` ("no items on screen yet; wait for them, then Read page now").
10. The service refuses a window read while the window is off, and cuts a window read's name at `?` or `#`.
    `ImportResult.newFlips` is filled for window reads only.
11. Popups are always denied: one to an allowlisted site goes to the browser (only right after the user's own input
    to the view, one tab per input), one to
    scrap.tf is dropped. A dead toolbar renderer closes the window rather than reloading anything.
12. The default partition is in memory; `persist:scraptf` only with keepLoggedIn, applied when the window is next
    created (0.7.1: never by rebuilding an open window). Main never focuses the view (`webContents.focus()`), so
    keyboard users click into the page first; from 0.7.1 the toolbar's keys also work with the page focused (M1).
13. Settings' terms link points to the About page (Settings is on F20's opener-free list).
14. A load and its settle read are one save (the spec imported each): the settle snapshot, or the load one when it got
    nothing, at the load's time. Read page now is deduped like automatic reads (the spec let it always import) and
    ends the page's cycle. Without that a page whose cards arrived late was saved twice 4 s apart, and its "What's
    new", F20 history and new-flip notice compared the two. From 0.7.1 a snapshot imported without its settle read
    is marked `settled: false` and writes no bank stock save (ACT-4), so a cycle cut short can no longer store a
    partial look as the page's newest save.
15. Main refuses client certificates for the whole app and logs page-triggered lines through a per-kind throttle;
    the window's busy state is per view.
16. Known limits: README "Known limits" (Cloudflare challenges the user solves, tested with stand-ins, reads as
    snapshots, popups, Stay signed in, the keyboard).

## 0.7.1 round: import truth, bank history, alerts and the window

One round of fixes from an audit of the scrap.tf side (parser, data, UX flow, window, actionability, code quality).
**Boundary unchanged** (R1, R3, R6, R9, R10): every change is local parsing, local SQLite or local UI, or less
reading and loading than 0.7.0 (F21-3 and F21-4 remove reads, F21-7 a load). `READ_SCRIPT` is byte-identical, no
`loadURL`, `executeJavaScript*`, timer, cookie, user-agent or request call site was added, and the compliance scan
gained the checks below. Schema V10 adds one index. Section names are the audit's finding ids.

**Import truth** (`rpcHandlers.ts` `importSavedPage`, `import/scraptfHtml.ts`, `import/reports.ts`).

- **P3 schema gate.** Right after the enabled and window-off checks, `importSavedPage` throws
  `IMPORT_SCHEMA_LOADING_MESSAGE` while `schema.isLoaded()` is false (a throwing `isLoaded` counts as not loaded),
  for files and window reads: nothing is parsed or recorded, so no SKU from a half-loaded schema is ever stored.
  The folder watch waits for the schema (Integration), and the window says so (F21 M2).
- **ACT-4 unsettled.** `importParams` accepts `settled`; only origin 'window' with `settled === false` counts:
  prices and the batch are stored, but not `insertBankStock`, `onImport`, the gone deletes or the flips.
- **DM-2 partial look** (`partialLookWarning`) and the **P1** tie-in: see F18 deviation 11. The page warnings
  `partial-read: N of ~M items on screen; read the page again once every card shows` and `no-stock-limit: N rows
  with no readable stock, so this look stores no bank stock save` come first in `warnings`.
- **DM-1, UX-2a, ACT-1 gone prices.** Inside the transaction, after `onImport`, only when the save wrote stock and
  the bank is not 'list': this batch's 'gone' events delete the 'import' prices that pass `replaceable` and match the
  event's SKU and `bankStockSpecialKey`, with the page's bank, observed before the save and not kept by this import.
  Their SKUs go to `affected`, so the engine records the price as removed. Typed prices, list-tagged prices and other
  banks' prices are never touched, and the events already skip first saves, out-of-order saves, the same file again
  and copies another page of the bank still lists. DC-1: a card only a look that stored no save caught (partial or
  unsettled) has no gone event, so on a one-page bank (not 'unusuals', whose no-save looks record no page) the page's
  newest save also deletes the replaceable import prices of its bank observed after the page's previous save and before
  this one, not kept and not on sale in this save (`noSaveLookPricesGone`; the table is scanned only when the bank's
  newest look before this one, `Repo.bankNewestSaves`, came after that previous save).
- **P1 /items stock.** `limitsIn` reads `title`, `data-original-title`, `data-bs-original-title`, `aria-label`,
  then the bar's leaf elements (a bare integer pair, or 'n/m'), never the whole cell. A row of a table with an Item
  Limits column that yields nothing warns `no-stock-limit` (a refusal) and is not a price; its list row keeps stock
  null.
- **P2 strange skins.** `skinQuality` (paintkit and wear set, whatever the class): with an effect quality 15, plus
  `quality2` 11 when strange; strange without an effect quality 11 and no `quality2` (`15000;11;w2;pk14`); otherwise
  15. An Unusual card with no effect stays 5 and is refused. DESIGN_BRIEF §3.3 describes this form.
- **P7 layout.** `scanDocument` counts lookalikes (`data-defindex` + `data-title` elements that fail `isCard`, and
  `tr[data-defindex]` without `data-quality`); with no cards, no rows and lookalikes, the page warns `layout-changed:
  N item elements not recognised` instead of no-cards-saved or no-items. A table with headers but no 'Price to buy'
  warns `no-price-column` and reads no price (each row warns `no-price`); name, pays and limits still go by their
  headers, and headerless tables keep the old layout. A window read that imports nothing returns
  `[WINDOW_NOTHING_TO_IMPORT, layout-changed …]` when the page had lookalikes.
- **P5 skip reasons.** A skip's reason is its first refusal-coded warning, else its first warning, else the old
  fallback; `SKIP_*` texts for the benign skips. Refused entries come first, then the list is cut at 500;
  `skippedTotal` and `skippedCounts` (keyed by the benign reason text, else the warning code) count every skip.
  Every result carries `stockSave`.
- **UX-3, ACT-5, F21-2 page flips.** A window read that wrote a save calls `BankStock.pageFlips(bank, batchId)`
  after `bankStockChanged`: `pageFlips` = its length, `topFlips` = the best 3 with schema names.
- **P4 parser report.** `parseScrapTfHtml(html, schema, { diagnostics: true })` returns `diagnostics` (counts,
  header columns, at most 200 whitelisted records of refused cards and rows, of cards with a guess or mismatch code,
  and of lookalikes): defindex, filtered class tokens, the title only without a custom name, content lines without
  gift, receipt, craft, tool or custom-description lines (any wording), the indicator and value attributes, the
  limit attributes, the SKU and the item's warnings; never the nav, scripts, asset ids or avatars. `reports.ts`
  keeps the newest `IMPORT_REPORT_RING` (20) in memory only (`scrubReportText` masks 9+ digit runs, links and control
  characters and clips every text); refused parses and empty window reads are kept as counts only.
  `'import.report' { limit? }` returns copies, newest first; the Import page's **Copy parser report** puts them on
  the clipboard as JSON and sends nothing.

**Bank stock and history** (`shared/bankStock.ts`, `domain/bankStock.ts`, `shared/scraptfHistory.ts`,
`domain/scraptfHistory.ts`, `banks.ts`, `market.ts`): DM-3/CQ-1 thinning (F20 S1), CQ-2 session baseline and
DM-5 staleness (F17), DM-7/CQ-3 one coverage source (F13, F15), UX-2b card flips (F15), DM-6 item history (F20 S3),
ACT-6 old-save toasts (F17 S3), plus:

- **DM-5 listed span.** The 'long-listed' filter and count, the 'listed' sort (`bankStockComparator(sort, dir,
  now)`) and the Live market's "Listed > 24 h" (`marketListedSideMatches`) measure `lastSeenAt - listedSince` of one
  run (`scraptfListedOf`, the copy seen last), not to now, so a page saved once 60 days ago is not "listed 60 days".
  `BankStockRow.lastSeenAt` and `MarketRow.scraptfLastSeenAt` (`ScraptfHistory.listedFor`, wired in core; without
  it the market falls back to the 'seen' link time) carry it; the dashboard says "last seen N ago" past 48 h.
- **ACT-10 superseded flips.** `flip` stays true only on a copy's newest event of its sort while the copy is on sale
  in its page's newest save: a price event is superseded by a later price or on-sale change, a 'stock' event by any
  change (`ScraptfKeyState.priceSince`, `pricePrevAt`). Other qualifying events get `wasFlip: true`. Worked out from
  the cached saves, never a query; while the saves cannot be read, events are left as they are.
- **F21-9 reminder.** `scraptfResaveNotice(bank, lastSavedAt, now, window?)`: with the window on and acknowledged and
  openLinksInWindow on, the body says to open the page in the Flip Desk window; the click still opens the static bank
  page in the browser.
- **Mock parity** (`mock.ts`, `mockData.ts`): lastSeenAt, baseline what's new and New badges, the 24 h New rule,
  `wasFlip`, card flips from the stock page, Shopping's known fields, `skippedTotal`/`skippedCounts` keyed as the
  service keys them, an `'import.report'` sample, and the window demo's best flip from the mock's own stock page.

**Alerts and the buy loop** (`engine.ts`, `core.ts`, `shopping.ts`, `liveCheck.ts`): ACT-2, ACT-3, ACT-7 and ACT-8
(Integration, Notifications), ACT-9 (Integration, shopping) and P3's folder-watch gate (Integration).

**The window** (F21, package D): F21-1, F21-3, F21-4, F21-6, F21-7, F21-10, F21-11 and F21-12 (M1 to M3), ACT-4's
flag, the toolbar's flips and Show flips (U1). Compliance (F21-8): `clear` is in the deferred-literal scan, a
`deferredWindowOpens` scan flags `allowWindow`, `openOnScraptf(` and `'app.showBankStock'` inside any deferred call
span in renderer files, and `windowKeyProblems` allows `pressKey` only from the two input listeners after their
checks; synthetic proofs show each flags what it should.

**Dashboard** (package E): `#/market/flips` (flips priced from a saved page, the 'seen' sort, newest first) and the
banks header's "N flips on your saves, newest X ago · View all"; `ui.openBankStock` routes the dashboard to
`#/banks/<bank>/stock/<flips|new>`, which the stock page applies once and replaces with `#/banks/<bank>/stock`;
window-aware data-in (the 'window-only' setup state, "Open in Flip Desk window" on the list card and the stock page,
`scraptfOpenedToast`'s read-on-load hint); first run leads with "Save scrap.tf/items once"; one boundary sentence
(`SCRAPTF_BOUNDARY_SHORT`, "Flip Desk never loads scrap.tf on its own."); one bank-page opener in the drawer (UX-11);
the import-off warning names the window; Record buy from a bank stock row books that exact copy at its listed price
(`ItemMenuTarget.copy`, ACT-11; a gone row prefills no price); Shopping's "Your price · 3 h ago" and stale rule; the
banks card's "Not in your save N ago: watch for restocks" (single-page banks only); the muted "was a flip" pill; the
change feed's default of every kind but 'stock' (`DEFAULT_CHANGE_KINDS`, key `log.scraptfChanges.v2`, the 0.7.0 key read
once by `changesViewFromLegacy`) and the drawer's separate price and stock lists; the Import page's skip totals and
**Copy parser report**; `checkNotifyHint` naming the popup rule; the waiting folder watch as a muted note.

**Tests.** Each package's own, plus `test/service/integration0_7_1.test.ts` (a gone card across the banks card,
stock page, market, drawer, opps and Shopping; 450 window reads on 60 daily saves keeping history, "listed since",
"Listed > 24 h" and the coverage of a bank saved before 510 newer batches) and
`test/main/scraptfWindowWiring.integration.test.ts` (the window over the real core: schema loading, Show flips,
an unsettled snapshot).

**Known limits** (README): in the window each read re-dates the prices on screen, so
a flip still listed past the repeat time can toast again; a page's first session compares with the save just before
the newest; more than 300 manual reads of one page within 2 h drop the oldest of them without a 10-minute bucket.

## Conventions

- TypeScript strict, ESM `import` without file extensions, named exports only.
- All money is integer scrap; keys are separate numbers (see `src/shared/currency.ts`).
- Timestamps: `UnixMs` for our own times, `UnixSec` where backpack.tf or PriceDB use seconds. The name says which.
- Every external payload is validated with zod (`.passthrough()` / loose objects) and unknown shapes are counted, not thrown.
- Tests use vitest, live in `test/<area>/`, and never hit the network. Fixtures captured from real APIs go in `test/fixtures/<area>/` with secrets and other users' trade URLs removed.
- A test file that asserts wall-clock bounds goes in `TIMED` in `vitest.config.ts`. Those files run as a second group
  (`timed`) after the rest of the suite, one file at a time, so a saturated CPU (or another timed file) does not
  decide their results.
- Comments are short and explain why, not what.

## Deviations from the design brief

1. Saved-page import is available once the user ticks an explicit acknowledgement in Settings, which states that scrap.tf's ToS lists "external tools". Recording written permission is optional rather than required, because the import never contacts scrap.tf and the risk decision belongs to the user. It stays off by default.
2. Folder watch (auto-import of pages the user saves into one folder) is part of that same opt-in.
3. Up to 0.6 there was no embedded scrap.tf browser in any form (brief option D). From 0.7 there is one, opt-in:
   deviation 10.
4. The dashboard can run in a plain browser against mock data (`npm run dev:renderer`), for UI development only.
5. The live feed's default daily data cap is 25 GB, not the brief's 12 GB (§2.1, Appendix A). The cap counts decompressed websocket payload bytes, measured at about 13 GB on a busy day (far less on the wire with permessage-deflate), so a 12 GB default would pause the feed most evenings. Users on capped or metered connections can lower it in Settings > Live feed.
6. `pauseOnMetered` (Appendix A) is not implemented in v1: the app does not detect metered Windows connections. The daily cap and the Pause-network switch are the controls.
7. Opportunity thresholds are global in v1, as in the brief's Appendix A config: one minimum profit (`profit.minProfitScrap`, `minProfitPctOfCost`), one minimum margin (`profit.minMargin`) and one set of notification thresholds (`notifications.minConfidence`, `minProfitScrap`, `dedupMs`) apply to every category. §5.6's "all configurable per category" is not implemented. Per-category overrides would be merged in `evaluateOpportunity` by the opportunity's category and included in the engine fingerprint (through `settings.profit`).
8. The brief's optional clipboard watcher (§3.2, off by default) is the Live check's watcher (F16): besides reading the
   item it shows the check result (a popup without focus, a notification for flips), and a check hotkey reads the
   clipboard once on demand. Both are local only and never store or send the text.
9. The brief has the user save a page with "HTML only" (§3.1 option C, §3.4). From F18 every instruction recommends
   "Webpage, Complete" instead, or "Webpage, Single File (.mhtml)" for any page but scrap.tf/items: scrap.tf adds bank
   cards after its page has loaded, and HTML only writes the page as it first loaded, so it can miss some cards or
   all of them. HTML only still imports. The import also reads `.mhtml` and `.mht` files, through the file dialog and
   the folder watch, under the brief's §3.4 rules (20 MB, untrusted, no script execution, nothing fetched); see
   "Save modes, MHTML and the reference helper (F18)".
10. **Option D without written permission (F21), at the user's explicit, informed choice on 2026-10-19.** Brief
    §1.7 rates an "embedded scrap.tf browser that reads the DOM passively" *not in v1, only if scrap.tf gives
    written permission that explicitly covers it* (§3.1 option D, §3.5): it is functionally a script on banking
    pages, the Electron token in its user agent is visible to scrap.tf, and Steam sign-in happens inside the app.
    On 2026-10-19 the user, told that scrap.tf's ToS forbids "automation, scripts, user-scripts, auto-refreshers,
    external tools" for advantage, that staff ruled scripts out on banking pages, and that scrap.tf can see the app
    and may ban the account, possibly on backpack.tf too, chose to have it built without that permission. It is
    the scrap.tf window ("The scrap.tf window (F21)"): off by default, and gated like saved-page import (deviation
    1), by import on and acknowledged plus the window's own risk acknowledgement, in place of §3.1's recorded
    written permission. The rest of §1.7 stands: the app never fetches scrap.tf itself (no pages, `/items`,
    `/ajax/*` or `ws.scrap.tf`), never injects into the page, never automates a buy, queue or trade, and never
    spoofs the user agent, solves a challenge or reuses the session. Where it differs from §3.5:
    - the partition is in memory (`scraptf`) unless the user chooses to stay signed in (`persist:scraptf`);
    - the read script returns `document.documentElement.outerHTML` for the saved-page parser rather than
      `querySelectorAll` JSON, so saves and reads share one parser; the script is pinned and token-checked;
    - besides `did-finish-load`, `did-navigate-in-page` and the user's button, there is one settle read 4 s after a
      load, because scrap.tf adds its cards late;
    - frames may load Cloudflare's challenge (for the user to solve), `about:blank` and `about:srcdoc`.

    §3.5's known downsides (Steam credentials typed into the app's view, the moderator's ruling on banking pages,
    long sessions read as botting) are the user's accepted risk. Settings and the README state the risk before the
    window can be turned on.
