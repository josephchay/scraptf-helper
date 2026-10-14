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
| `src/shared/settingsSchema.ts` | zod schema for `Settings` (owned by main) |
| `src/service/net/*` | `policy.ts`, `budgets.ts`, `http.ts`, `redact.ts`, `ratelimit.ts`, `errors.ts` |
| `src/service/db/*` | `openRepo(path)` implementing `Repo` with `node:sqlite` |
| `src/service/connectors/schema.ts`, `schemaNames.ts` | `createSchemaService` (sku.pricedb.io), names and resolver |
| `src/service/connectors/pricedb.ts`, `steamMarket.ts` | PriceDB REST and socket; optional SCM priceoverview |
| `src/service/connectors/bptfSocket.ts`, `bptfApi.ts`, `bptfItem.ts` | backpack.tf websocket, snapshot/IGetPrices/IGetCurrencies, item → SKU mapping |
| `src/service/domain/*` | matcher, pricing, confidence, key price, engine, views (list/group/detail), journal, CSV |
| `src/service/import/*` | saved scrap.tf page parser (parse5, no script execution), folder watcher |
| `src/service/core.ts`, `scheduler.ts`, `rpcHandlers.ts`, `entry.ts`, `logger.ts` | wiring and periodic jobs (integration) |
| `src/main/*` | Electron main, preload, windows, tray, settings store, secrets, service host |
| `src/renderer/*` | dashboard UI; `api.ts` uses `window.flipdesk` or, in a plain browser, `mock.ts` |
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
  (SKUs with a scrap.tf price) unless `liveFeed.keepSellListings` is 'all'; affected base SKUs are marked dirty.
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
- Main pushes `service.state` (starting/ready/restarting/stopped) and `ui.openItem` (notification click, or the
  quick-entry window's `app.openItem`). The service pushes `opps.changed`, `status.changed`, `import.done`, `prices.changed` (any price or rule write, so
  every window's price sheet refreshes) and `notify`.
- `npx electron . --smoke-test=<report.json> [--smoke-wait=<s>]`: with a wait, the app runs live for that long and
  fails unless the feed is live with listings, the schema loaded and a key price arrived. Packaged builds ignore
  `--dev`, `--smoke-test` and `--smoke-wait` unless `FLIPDESK_DIAGNOSTICS=1` is set.
- One copy per machine: besides Electron's per-userData lock, main holds the named pipe
  `\\.\pipe\io.github.tf2flipdesk.app.instance`, so another `--user-data-dir` or Windows account cannot open a
  second backpack.tf feed from the same IP (a smoke test then fails with that reason).
- Main drops service pushes it owns (`settings.changed`, `ui.openItem`, `service.state`) and any `status.changed`
  that fails its shape check. The service runs with main's environment minus proxy variables (R5); if Node's
  env-proxy support is on anyway, the service keeps the network paused.
- A service that exits unexpectedly 5 times within an hour is restarted at most every 15 min. Request budgets are
  restored at service start from the request log plus the saved start of the last slow-budget request
  (`net.lastSent.<budget>` meta, written before sending), so restarts never reset them. The IGetCurrencies and
  IGetPrices jobs also keep the previous process's cadence (the last backpack.tf key quote, `bptf.pricesFetchedAt`).

## Conventions

- TypeScript strict, ESM `import` without file extensions, named exports only.
- All money is integer scrap; keys are separate numbers (see `src/shared/currency.ts`).
- Timestamps: `UnixMs` for our own times, `UnixSec` where backpack.tf or PriceDB use seconds. The name says which.
- Every external payload is validated with zod (`.passthrough()` / loose objects) and unknown shapes are counted, not thrown.
- Tests use vitest, live in `test/<area>/`, and never hit the network. Fixtures captured from real APIs go in `test/fixtures/<area>/` with secrets and other users' trade URLs removed.
- Comments are short and explain why, not what.

## Deviations from the design brief

1. Saved-page import is available once the user ticks an explicit acknowledgement in Settings, which states that scrap.tf's ToS lists "external tools". Recording written permission is optional rather than required, because the import never contacts scrap.tf and the risk decision belongs to the user. It stays off by default.
2. Folder watch (auto-import of pages the user saves into one folder) is part of that same opt-in.
3. No embedded scrap.tf browser in any form (brief option D).
4. The dashboard can run in a plain browser against mock data (`npm run dev:renderer`), for UI development only.
5. The live feed's default daily data cap is 25 GB, not the brief's 12 GB (§2.1, Appendix A). The cap counts decompressed websocket payload bytes, measured at about 13 GB on a busy day (far less on the wire with permessage-deflate), so a 12 GB default would pause the feed most evenings. Users on capped or metered connections can lower it in Settings > Live feed.
6. `pauseOnMetered` (Appendix A) is not implemented in v1: the app does not detect metered Windows connections. The daily cap and the Pause-network switch are the controls.
