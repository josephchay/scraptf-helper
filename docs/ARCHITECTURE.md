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

**Chromium's log** (0.7.4, F54). Chromium's processes (the network service, the GPU process) print their own ERROR
lines, which a terminal run shows unattributed. main's `bootstrap()`, before 'ready' and with the instance lock held,
appends `enable-logging=file`, `log-file=<logs>/chromium.log` and `log-level=2` (ERROR and up: Chromium logs a web
page's console messages at INFO, so those stay out), unless the developer passed `--enable-logging` or set
`ELECTRON_ENABLE_LOGGING`. The folder is `resolveAppPaths(...).logDir`, beside main.log (the `--user-data-dir`
profile's when given). Chromium only appends to an explicit log file, so `prepareChromiumLog` (`paths.ts`) bounds it
at each start: over `CHROMIUM_LOG_MAX_BYTES` (1 MB) it becomes `chromium.log.old` (one kept), or is emptied when it
cannot be moved; when it can be neither, the switches are left out for that run. While the app runs (a tray session
lasts days), main checks the size again at most every `CHROMIUM_LOG_CHECK_MS` (10 min) on the `status.changed` pushes
it already handles, no timer of its own and nothing of the scrap.tf window: over 1 MB the file is emptied in place
(`boundChromiumLogWhileRunning`; Chromium holds it open, so it is not moved). Logging only, no network behaviour:
the compliance pin lists main's five switches (these three and the window test's two). Chromium still echoes ERROR
lines to an attached console when its only log destination is a file, so a terminal run can show them as well.

## Source layout and ownership

| Path | Owner / contents |
|---|---|
| `src/shared/types.ts`, `rpc.ts`, `sku.ts`, `currency.ts`, `defaults.ts` | foundation; change only through integration |
| `src/shared/links.ts`, `categories.ts` | link generator (rebuild of scrap.tf-item-information), category classifier; `SCRAPTF_BANKS`, the one list of scrap.tf bank ids, labels and URLs (F15); `scraptfLinkFor`, the page a Live market row links to (F19); `scraptfBankForItem`, the bank an item of its kind is sold on (0.7.4, F36) |
| `src/shared/ceiling.ts` | profit status and the "pay up to" ceiling, shared by the engine, the dashboard and the mock so all three classify alike; from 0.7.4 (F22, F70) the cost checks: `costSanity`, `costSanityReason`, `COST_SANITY_FLAGS` / `costSuspectFlagged` (`variant-suspect`, `cost-below-market`; PriceDB only, age-gated by the caller), `craftabilityTwin`, `pricedbBand` and their thresholds, shared by confidence (the engine), shopping, the bank stock cost gate (review R14/R40), the Live check's `checkCostNote` and the mock; from 0.8 (PC-1, PC-2, H2) the one buy-side profit path `flipProfit`, `exitCostsOf`, `reservePctOf`, `reserveOf`, `flipProfitBound`, `profitBreakdown`, and the backup-buyer check `buyerDepthOf`, `exitOrdersOfSummaries`, `singleExitOf`, `singleExitText` / `singleExitReason`; from 0.9 (#2) the break-even price per exit (`breakEvenFor`, `breakEvensOf`, `grossBeforeFee`, `scmGrossValue`) |
| `src/shared/referenceAge.ts` | the reference age gate's community floor (`communityMaxAgeMs`), shared the same way so the drawer marks a reference "ignored" exactly when the engine drops it |
| `src/shared/buyerSeen.ts` | 0.7.4 (F23, F63) a buy order's liveness: `ORDER_CONFIRMED_MS` (2 h), `orderSeenRecently`, `buyerOnlineNow` (an old online flag is not presence), `seenAgeText`, `buyerPresenceText`; shared by confidence, the engine, core's snapshot job, bptfApi's online carry (review R36) and the Live log's buyer tag in the service, by every renderer buyer line (Opportunities, drawer, Live market, Holdings, Shopping, Bank stock, Live check) and by the mock; from 0.8 `ORDER_UNVERIFIED_AFTER_MS` (24 h) and `unverifiedRevenue`, moved from the holdings service so Holdings, the advice (`holdingAdvice.ts`) and the mock share them (matcher's `UNVERIFIED_AFTER_MS` and the mock's `MOCK_UNVERIFIED_AFTER_MS` are the same constant); from 0.9 the bot service a client names (`botServiceOf`) |
| `src/shared/copyExtras.ts` | 0.7.4 (F66, F27, F33) which copy an opportunity prices and one profit per buy order: `opportunityCopyKey`, `copyExtrasOf`, `copyExtrasWords`, the sheen and killstreaker names, `markSharedBuyers` (the 'shared-buyer' flag) and, from review R27, `onceByOrderProfit` (group totals at the best copy shown); shared by the engine, the repo, views, priceSheetIo, the dashboard and the mock |
| `src/shared/priceCopy.ts` | 0.7.4 (F80) which stored price is a given copy's: `priceIsForSku`, `newestTypedPriceFor` (`prices.upsert` `replaceTyped`); shared by rpcHandlers, the item menu model (Record buy's price, the drawer's price form), Quick entry and the mock |
| `src/shared/ruleEvidence.ts` | 0.7.4 (F78) a rule never undercuts a price scrap.tf showed: `scraptfSeenPriceOf`, `boundRuleCost` (the `rule-under-scraptf` flag), `ruleUnderScraptfReason`; local saved data only (R1); shared by the engine's rule rows, the Live market's rule verdict, core and the mock |
| `src/shared/accelerator.ts`, `contact.ts`, `htmlDecode.ts` | the hotkey accelerator rule (settings schema, Settings page, mock), the User-Agent contact rule (R6: settings schema and Settings page), the decoding of a saved page's bytes (main's Import file and the service's folder watch) |
| `src/shared/market.ts` | Live market rules (verdict, profit, filters, search words, comparator, paging, CSV cells), shared by the market index, the dashboard and the mock so counts, order and pages match |
| `src/shared/holdings.ts` | Holdings rules (status, profit figures, row, comparator, search, totals, CSV cells), shared by the holdings service, the dashboard and the mock the same way; from 0.8 the ask side (`askSideOf`, `AskCandidate`), references (`holdingRefsOf`), the row's extras (`HoldingRowExtras`) and `scraptfAlternative` (moved from the service); from 0.9 `holdingLockedNow`, the locked count in the totals, and the valuation `holdingsValuationOf`, `lotValueOf`, `journalValuerOf` (Journal card and ledger CSV) |
| `src/shared/scraptfList.ts` | scrap.tf price list rules (F14): valuing a saved list row, full, fresh, the key row, a held item's better exit, the market and holdings list fields, and from 0.7.4 the family rows (`scraptfListFamilyOf`, `scraptfListLookup`, `scraptfListCraftProven`, `scraptfListIsFamily`), shared the same way |
| `src/shared/banks.ts` | scrap.tf banks rules (F15): flips per bank and what to look for there (`bankFlips`, `bankLookFor`), shared by the banks summary, the dashboard and the mock the same way; from 0.9 (#13) the bank's newest "not trading" look (`bankNoticeNewestAt`, `bankUnavailableAt`: `ScraptfBankSummary.unavailableAt`) |
| `src/shared/bankStock.ts` | scrap.tf bank stock rules (F17): the extras key, on sale, the diff of two saves, rows, verdict, filters, counts, order, paging, "What's new", the market's New join, the drawer's line, the notification texts and CSV cells, and from 0.7.4 the list's family rows (`bankStockListFamily`, review R01/R06) and a copy's saved prices (`bankStockPricesOf`, the Live check's craftability), shared by the bank stock cache, the dashboard and the mock the same way; from 0.9 (#13) a card's price-drop wording as `bank_stock.markdown` stores it (`bankStockMarkdownText`, `bankStockMarkdownOf`) and on an on-sale row (`BankStockRow.markdown`, never a gone or family row) |
| `src/shared/scraptfHistory.ts` | scrap.tf history rules (F20): a save's change events, valuing an event now with the live buy side, the runs index ("listed since"), one item's history, the feed's limits and CSV cells (from 0.7.4 an /items family row's event meets no buyer: `scraptfEventListFamily`), and the re-save reminder's banks, timing and texts, and from 0.8 (T1, LC-3, LC-5) the per-bank lifecycle builder (`scraptfLifecycleOf`: price states, listing runs, asset-id stability with its pre-pass `scraptfAssetStabilityOf`; `scraptfKeyStatesOf` now wraps it; `scraptfCopyBankOf`) and the one restock rule (`scraptfSeenBefore`, `scraptfIsRestock`), shared by the service, the dashboard and the mock the same way |
| `src/shared/scraptfTiming.ts` | 0.8 (T2-T4, LC-4) buy-timing estimators (pooled drop / gone / rose table, still-listed turnover), the Wait / Buy now verdict and the row briefs (`scraptfTimingTableOf`, `scraptfLookGapMs`, `scraptfBankCyclesOf`, `scraptfTimingEv` through `flipProfit`, `scraptfBuyTimingOf`, `scraptfTimingForKey`, `scraptfTimingBrief`, `scraptfTurnoverOf`, `scraptfItemTimingOf`, `scraptfOpportunityTiming`), shared by the service and the mock; estimates from the user's own saves, never forecasts; from 0.9 (#10) the copy-clustered infinitesimal jackknife (`scraptfTimingInfluenceOf`, `scraptfTimingSpreadOf`, memoised per table), the share ranges (`scraptfWilson`, `scraptfShareRange`), the Wait gate on the gain's low end with the drop size at its own low end (`scraptfMedianLowRank`, `scraptfDropLowOf`, `scraptfTableDropLowOf`) and the save-timing check ('left' placement) |
| `src/shared/check.ts` | Live check (F16) limits, fixed user-facing texts (refusals, reasons, item notes, the privacy sentence, `CHECK_HOTKEY_CONFLICT`), `checkTextRefusal`, `checkPriceIsOtherCopy`, `blankCheckResult`, F19's `checkHintPriceOf` (a price copied on its own) and 0.7.4's craftability rules (`checkTextStatesCraft`, `checkCraftTwinOf`, `checkListCopyPrices`, `checkCraftCopy`, `checkWorseCopy`, `checkCraftUndecided`, `checkPriceReadAsRef`; review fixes `checkListFamilyOnSale`, `checkDecideCopy`, `checkHasRevenue`, `checkRevenueUnverified`, `checkCostNote`, `checkCostSuspect`); zod-free, shared by main, the service, the dashboard and the mock so all of them refuse and word things alike |
| `src/shared/itemUrl.ts` | the item links the app reads (marketplace.tf and PriceDB item pages, backpack.tf stats pages): hosts, path shapes and next.backpack.tf's query keys, shared by the schema resolver (`parseItemUrl`) and main's clipboard filter, which lets exactly these links through |
| `src/shared/settingsSchema.ts` | zod schema for `Settings` (owned by main) |
| `src/shared/importCodes.ts`, `scraptfPaths.ts`, `boundaryText.ts` | 0.7.1: the import's warning and refusal codes, fixed messages, skip reasons, partial-read thresholds and report limits (`importWarningCode`); `scraptfImportablePath`, the scrap.tf pages the import reads (parity with `pageKindFromUrl`, tested); the one boundary sentence (`SCRAPTF_BOUNDARY_SHORT`, `scraptfDataSourcesText`) every dashboard text uses; from 0.9 (#13) the bank-not-trading code (`BANK_UNAVAILABLE`, `BANK_UNAVAILABLE_WARNING`), the evidence codes `PRICE_MARKDOWN`, `PRICE_COUNTDOWN`, `RECENT_SECTION` and `IMPORT_REPORT_NOTICES_MAX` |
| `src/shared/scraptfWindowPolicy.ts` | F21's rules for the opt-in scrap.tf window, pure and zod-free: which URLs it starts on, keeps, sends to the browser or blocks (top level and frames), which pages it reads, the pinned `READ_SCRIPT` and its forbidden tokens, the read timings, the fixed texts and the settings gate; shared by main, the settings schema, the service, the mock and the tests; the challenge phrases (`scraptfChallengeIn`) |
| `src/shared/opportunityEvents.ts` | 0.7.3: the Live log's opportunity-event filters (`OPPORTUNITY_EVENT_KINDS`, `EVENTS_EXPORT_MAX` = 5000, `eventMatches`: the category plus `marketSearchTokens` words across name, SKU and summary), shared by the events view, the service's events export and the mock, so the file matches the page |
| `src/shared/journal.ts` | 0.8 (J1, J2, J5, H5) the journal's rules: FIFO (`journalSummary`, `journalOrder`, `journalValue`, moved from service/domain/journal.ts), the closed-trade ledger (`JournalSummary.closed`), fees (`feeOf`, `feePatchOf`, `applyJournalPatch`), write-offs, the user's typical hold (`typicalHoldOf`, `withTypicalHold`, `closedTradesOf`) and the ledger CSV (`journalLedger`, `JOURNAL_CSV_COLUMNS`, `journalCsvCells`); shared by the service (journal RPCs, holdings, CSV), the dashboard and the mock, which keeps no copy of its own; from 0.9 the ledger CSV's valuation columns (`journalLedger`'s valuer, `JournalLotValuer`) |
| `src/shared/venues.ts` | 0.8 (J2, J4) the one journal venue list (`JOURNAL_VENUES`, `WRITE_OFF_VENUE`), the read-time normaliser (`venueKey`, `venueLabel`, `isScraptfVenue`) and brief §5.4's fee hints (`venueFeeHint`, text only); shared by core (ACT-3), the dashboard and the mock; from 0.9 the documented fee rules in cents (`scmBuyerPaysCents`, `scmSellerNetCents`, `manncoNetCents`) and mannco.store |
| `src/shared/watches.ts` | 0.8 (G1, G3): the user's scrap.tf watches: covering a copy (bankStockIsOwnCopy), targets at the key price, what a row meets now and on a read (the edge), the rows' join, a watch's copy on sale now, the engine's profit bar, input rules; shared by the service, the dashboard and the mock |
| `src/shared/bankStockNotify.ts` | 0.8: the S3 notifier's rules: one ordered candidate list per told look (watch, new, cheaper, back, timing: `bankStockNotifyCandidates`, `bankStockNotifyOrder`, the dedupe keys `bankStockNotifyKey` and `bankStockWatchNotifyKey`), G4's memory of Wait (`bankStockTimingParse`, `bankStockTimingNext`), every toast and summary text (`bankStockNoticeOf`, `bankStockSummaryNotice`, `bankStockOldSaveSummary`), the summary's chip (G5, `bankStockSummaryChip`); pure, read by the service's notifier; from 0.9 (#9) `bankStockNoticeWithGuard`, the checkout guard's sentence on a watch hit or G4 toast that tells a flip |
| `src/shared/checkoutGuard.ts` | 0.9 (#9) the checkout guard's sourced lines, titles and the toast suffix rule (`withCheckoutGuard`); shared by the dashboard, the S3 notifier and the engine's "Watch:" toast |
| `src/shared/holdingAdvice.ts` | 0.8 (H1, H6, H7) valuing recorded exit runs (`markExitScrap`, `holdingMarkValuesOf`, `sameHoldingMarkValues`), a holding's history and trend (`holdingExitHistory`) and the advice (`holdingAdvice`, `attachHoldingAdvice`) with their thresholds; shared by the holdings service, the dashboard and the mock; from 0.9 the trade lock (`TRADE_LOCK_MS`, `tradeLockModeOf`, `tradableAtOf`, `holdingTradeLockOf`, `withTradeLock`), the trend size (`HoldingTrend.size`, `HOLDING_TREND_SIZE_*`) and the key move band (`keyMoveBandOf`, `KEY_BAND_*`) |
| `src/shared/robustStats.ts` | 0.9: `median`, `quantile`, `theilSen`, `medianAbsDeviation` (robust statistics for small samples), shared by holdingAdvice and any later rule; pure |
| `src/shared/exitRisk.ts` | 0.9 (#3) the risk-aware ranking keys over a book already read: `exitDepthOf`, `profitableDepthAt`, `backupProfitOf`, `exitRiskAt`, `opportunityRiskFields`, `marketRiskFields`, the book-depth tag `liquidityTagOf`, and the notification gate (`minProfitableDepthOf`, `depthGateOk`); shared by the engine, the Live market, the bank stock notifier, the dashboard and the mock. Buyer counts are demand, never a chance of a sale |
| `src/shared/reserveSuggest.ts` | 0.9 (#12) the suggested price-move reserve: per value band (`reserveBandOf`), the 10th percentile (`lowerQuantile`, `suggestedPctOf`) of the exit's change over the user's typical hold (`reserveHoldOf`), from recorded exit runs (`recordedWindows`) and the PriceDB history the drawer loaded (`pricedbWindows`); `reserveSuggestionOf` is shared by 'profit.reserveSuggestion' and the mock. Text beside the setting, never applied |
| `src/shared/orderPersistence.ts` | 0.9 (history, RESEARCH #6) buy-order persistence: the follow rule (`orderSpellFollows`, `ORDER_SPELL_FOLLOW_SHARE`), spell ends (`orderSpellEndOf`), Kaplan-Meier with delayed entry (`spellObservationOf`, `persistenceWindowOf`, `orderPersistenceOf`), the summary and `itemBookHistoryOf`, with retention and gate constants; shared by the tracker, `'item.bookHistory'`, the dashboard and the mock; order persistence, never a fill rate |
| `src/shared/communityHistory.ts` | 0.9 (history, RESEARCH #7) recorded community prices: which IGetPrices rows are kept (`communityHistoryPointsOf`), the point key, `communityValueScrap` (pricing.ts's rule, parity-tested), the drawer's steps (`communityHistoryOf`), retention; shared by the scheduler, the feed recorder, the dashboard and the mock |
| `src/shared/scraptfLows.ts` | 0.9 (history) a scrap.tf copy's lowest price on sale in the user's saves: `rawPriceCompare`, `scraptfLowFold`, `scraptfLowMerge`, `scraptfLowSightingsOf`, `scraptfLowsOf`, `scraptfCopyLowOf`, `SCRAPTF_LOWS_MAX_AGE_MS`; shared by the history index, the bank stock join, the dashboard and the mock |
| `src/service/net/*` | `policy.ts`, `budgets.ts`, `http.ts`, `redact.ts`, `ratelimit.ts`, `errors.ts` |
| `src/service/db/*` | `openRepo(path)` implementing `Repo` with `node:sqlite` |
| `src/service/connectors/schema.ts`, `schemaNames.ts` | `createSchemaService` (sku.pricedb.io), names and resolver; from 0.9 (#22) renamed effects resolved per kind of item (`EFFECT_NAME_ALIASES`, `effectTypeForItem`, `effectIdByName(name, type?)`) and twins scoped by effect kind |
| `src/service/connectors/pricedb.ts`, `steamMarket.ts` | PriceDB REST and socket; optional SCM priceoverview |
| `src/service/connectors/bptfSocket.ts`, `bptfApi.ts`, `bptfItem.ts` | backpack.tf websocket, snapshot/IGetPrices/IGetCurrencies, item → SKU mapping |
| `src/service/domain/*` | matcher, pricing, confidence, key price, engine, views (list/group/detail), shopping list, Live market index (`market.ts`), journal, holdings (`holdings.ts`), the saved scrap.tf list cache (`scraptfList.ts`), the per-bank summary (`banks.ts`, F15), the live check parser and evaluation (`liveCheck.ts`), the bank stock cache and its notifications (`bankStock.ts`, F17), the scrap.tf history index and change feed (`scraptfHistory.ts`, F20) and the re-save reminders (`resaveReminders.ts`, F20), one item's buy book across its defindex twins (`bookTwins.ts`, 0.7.4), recorded exit runs (`holdingMarks.ts`, 0.8), the copy-matched ask side (`asks.ts`, 0.8), the user's scrap.tf watches in memory (`watches.ts`, the watch cache, 0.8 G1), buy-order spells (`orderSpells.ts`, 0.9), the feed's community prices (`communityFeed.ts`, 0.9), the drawer's order book history read (`bookHistory.ts`, 0.9), CSV |
| `src/service/priceSheetIo.ts`, `buyerCheck.ts`, `rpcSchemas.ts` | bulk paste and backups (pure); `buyer.check` lookups; zod schemas shared by more than one handler |
| `src/service/import/*` | saved scrap.tf page parser (`scraptfHtml.ts`, parse5, no script execution), the MHTML extractor (`mhtml.ts`, F18, pure), the one entry for both file types (`savedPage.ts`), folder watcher; from 0.7.1 the in-memory ring of sanitized parser reports behind `'import.report'` (`reports.ts`, P4, never persisted) |
| `src/service/core.ts`, `scheduler.ts`, `rpcHandlers.ts`, `entry.ts`, `logger.ts` | wiring and periodic jobs (integration) |
| `src/main/*` | Electron main, preload, windows, tray, settings store, secrets, service host; the live check's controller (`liveCheck.ts`, with F19's `check.arm`), clipboard filter and watcher (`clipboardWatch.ts`) and global hotkey registration (`hotkeys.ts`); the opt-in scrap.tf window (`scraptfWindow.ts`, F21), the only module that may show scrap.tf, and from 0.7.1 its remembered size and place (`windowBounds.ts`, F21-12); diagnostics only, the window's hermetic test (`smokeWindow.ts`, loaded by main's gated `--smoke-window` branch alone, and its pure local router `smokeWindowFixtures.ts`) |
| `src/renderer/*` | dashboard UI; `api.ts` uses `window.flipdesk` or, in a plain browser, `mock.ts`. Page logic lives in pure, unit-tested `*Model.ts` files; from 0.9 the pure models `breakEvenModel.ts`, `checkoutGuardModel.ts`, `aboutModel.ts`, `riskModel.ts` and `bookHistoryModel.ts`, and the components `CheckoutGuard.tsx`, `TradeLockCard.tsx` and `BookHistorySection.tsx` |
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
journalSummary(entries: readonly JournalEntry[]): JournalSummary   // 0.8: src/shared/journal.ts, re-exported by service/domain
opportunitiesCsv(rows, keyScrap), eventsCsv(events), journalCsv(entries)   // 0.8: journalCsv is the FIFO-order ledger
// import
parseScrapTfHtml(html: string, schema: SchemaService, opts?: ParseOptions): ScrapTfParseResult   // { pageKind; bank; page; items; warnings }; opts.address from 0.6 (F18)
parseSavedPage(text: string, fileName: string, schema: SchemaService): SavedPageParse          // F18: .html or .mhtml, + format
createFolderWatcher(opts: { folder: string; log: Logger; onFile(path: string, html: string, mtimeMs: number): void; onSkip?(path, reason: 'too-large', detail, mtimeMs): void }): { stop(): void; alive(): boolean; lastError(): string | null }
// shared
buildLinks(ctx: LinkContext): LinkSpec[]
isAllowedExternalUrl(url: string): boolean
categorize(obj: SkuObject, item: { itemClass: string; slot: string | null; craftClass: string | null; itemName?: string } | null): Category
scraptfBankForItem(category, obj, item | null): Exclude<ScraptfBank, 'list'>   // 0.7.4 (F36): the bank an item of its kind is sold on
```

v0.2 additions (imported by `rpcHandlers.ts`, the engine and the dashboard):

```ts
// shared/ceiling.ts
// 0.8: CeilingSettings = Pick<ProfitSettings, 'minProfitScrap' | 'minProfitPctOfCost' | 'minMargin' | 'frictionScrap'> & Partial<Pick<ProfitSettings, 'exitReservePct'>>
//      ExitCostSettings = Pick<ProfitSettings, 'frictionScrap'> & Partial<Pick<ProfitSettings, 'exitReservePct'>>
maxCostFor(revenueScrap: Scrap | null, p: CeilingSettings): Scrap | null   // judged with flipProfit (0.8: the reserve included)
profitStatus(profitScrap, costScrap, p): OpportunityStatus;  minProfitFor(costScrap, p): Scrap
// 0.8 (PC-1): the one buy-side profit path; a sale into a live order (holdingFigures, sellComparison) takes friction only
flipProfit(revenueScrap: Scrap | null | undefined, costScrap: Scrap | null | undefined, p: ExitCostSettings): Scrap | null
exitCostsOf(revenueScrap, p: ExitCostSettings): ExitCosts;  reservePctOf(p): number;  reserveOf(revenueScrap, p): Scrap
flipProfitBound(maxRevenueScrap, costScrap, p): number   // the engine's rule prefilter: <= 0 means no revenue up to max profits
profitBreakdown(revenueScrap, costScrap, p): ProfitBreakdown | null   // flipProfit with its parts, for the dashboard's hovers
// 0.8 (PC-2, H2): the next buyer and the thin-flip check
buyerDepthOf(orders: readonly ExitOrder[], revenueOrderId: string | null | undefined, useOrder?): BuyerDepth   // { revenueBuyer, nextBuyer, verifiedBuyerCount }
exitOrdersOfSummaries(orders: readonly OrderSummary[], outlierIds?: ReadonlySet<string> | null): ExitOrder[]
singleExitOf(revenueScrap, costScrap, next: NextBuyer | null, p: CeilingSettings): SingleExit | null
singleExitText(s, money): string;  singleExitReason(s, money): string   // '0 Only this buyer makes it a flip: …' (SINGLE_EXIT_TEXT)
costSanity(costScrap, own: PricedbSides | null, twin: () => PricedbSides | null): CostSanity   // 0.7.4 (F22, F70)
costSanityReason(s, twinCraftable, money): string;  craftabilityTwin(sku): string | null;  costSuspectFlagged(flags): boolean
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
exitOrdersOfBook(book): ExitOrder[]   // 0.8 (PC-2, H2): the eligible orders as buyerDepthOf reads them (buyerCountOf's buyer rule)
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
JournalSummary.waitingSales: { id; ts; sku; name; keys; scrap }[]          // 0.7.4: sales with no buy dated at or before them
// shared/journal.ts (0.8; service/domain/journal.ts only re-exports journalSummary, journalOrder, journalValue)
JournalSummary.closed: JournalClosedTrade[]   // J1: every sale or write-off that closed a buy, as booked; sum(profitScrap) === realizedProfitScrap
typicalHoldOf(closed, open) → (sku) => TypicalHold | null   // H5: built once per read; typicalHold(closed, open, sku) for one SKU
withTypicalHold(row, hold); closedTradesOf(closed, sku)   // the row with typicalHold (no key on null); one SKU's pairs, newest first
journalLedger(entries), journalCsvCells(r), JOURNAL_CSV_COLUMNS   // J5: rows in journalOrder with their FIFO state
feeOf(e), feePatchOf(p), applyJournalPatch(e, patch)   // J2, J6
Repo.getJournal(id): JournalEntry | null; Repo.updateJournal(id, patch): JournalEntry | null   // J6: venue, note, fee only
// shared/venues.ts (0.8, J4)
JOURNAL_VENUES, WRITE_OFF_VENUE, venueKey(v), venueLabel(v), isScraptfVenue(v), venueFeeHint(venue, side)
// shared/holdings.ts
holdingStatusOf, holdingFigures, holdingRow(pos, category, buy, p, keyScrap?), lotCostAt, holdingComparator, holdingsMatching, holdingsTotals, holdingsResult, holdingsCsvCells, HOLDINGS_CSV_COLUMNS
// shared/market.ts
MARKET_MAX_LIMIT = 2000; scraptfCoverage(batches, categoriesOf), batchSavedAt, bankPageIndexOf, cleanCategoryCounts, countCategories
ImportBatch.categories?: CategoryCounts | null                  // items per category, fixed at import time (schema V3)
// renderer
useRecordTrade(): { open(init: RecordTradeInit): void; element: ReactNode }
  // 0.8: init.side 'writeoff' (Write off), init.editOf + editPair (J6 edit mode: venue, note and fee via journal.update)
toast(text, tone?, opts?: { action?: { label: string; onClick(): void }; timeoutMs?: number }): number   // useApp(); also dismissToast(id), holdToast(id, why, on)
```

v0.8 Holdings: recorded exits, asks, references and advice ("0.8 round", Holdings, below):

```ts
// service/domain/holdingMarks.ts (H1)
createMarkRecorder(deps: { repo: Pick<Repo, 'transaction' | 'latestHoldingMarks' | 'insertHoldingMark' | 'extendHoldingMark'>; log }): MarkRecorder
  // MarkRecorder: record(seen: Map<base, HoldingMarkValues>, now, liveSince, keyScrap): HoldingMark[]; flush(); reset()
HOLDING_MARK_EXTEND_MS = 10 min (to_at written at most this often), HOLDING_MARK_HEARTBEAT_MS = 30 min
// service/domain/asks.ts (H3)
askCopyMatches(l: Listing, paint): boolean; askCandidatesOf(sells, paint, match: MatchContext, keyScrap): AskCandidate[]
// shared/holdings.ts
askSideOf(asks: readonly AskCandidate[], now, ownSteamIds: ReadonlySet<string>): HoldingAskSide | null   // H3
holdingRefsOf(usable: ReferencePrices, ignored: readonly string[]): HoldingRefs | null                    // H4
holdingRow(pos, category, buy, p, keyScrap?, scraptf?, extras?: HoldingRowExtras | null)   // { ask; refs; snapshotAt }; + nextLotKeyPriceScrap
scraptfAlternative(r, p, now)                                   // moved from the service (friction only, R-PC1-sell)
// shared/buyerSeen.ts
ORDER_UNVERIFIED_AFTER_MS = 24 h; unverifiedRevenue(order, now)   // the service's holdings.ts re-exports it
// shared/holdingAdvice.ts (H1, H6, H7)
holdingMarkValuesOf(side, ask, list, now); sameHoldingMarkValues(a, b); markExitScrap(m, keyScrap); markExitSources(m)
holdingExitHistory(marks, sinceAt, keyScrap, now): HoldingExitHistory
holdingAdvice(r, history, p, keyScrap, now): HoldingAdvice; attachHoldingAdvice(r, history, p, keyScrap, now): HoldingRow
// service/domain/holdings.ts
Holdings.detail(sku, now): HoldingDetail                        // 'holdings.detail' (H7); sku canonical, the handler splits it
Holdings.markBasesChanged(): void                               // the watched bases changed (alerts calls it, D10)
HoldingsDeps.feedLiveSince?(): UnixMs | null                    // core: since when the feed has been live; null: record nothing
HoldingsDeps.markBases?(): ReadonlySet<string>                  // watched bases recorded like held ones (alerts wires it, D10)
HOLDINGS_ASK_CACHE_MS = 60 s, HOLDINGS_REFS_CACHE_MS = 10 min, HOLDINGS_HISTORY_CACHE_MS = 60 min
// service/domain/views.ts
ItemDetail.ask?: HoldingAskSide | null                          // buildItemDetail: the same copy rule over the stored sells
// renderer
ADVICE_LABELS, ADVICE_TONES, ADVICE_HELP, adviceReasonText(r, keyScrap, now), adviceTitle(a, keyScrap, now),
askSideText(ask, keyScrap, now), refsText(refs, keyScrap)       // holdingsModel.ts
holdingChartSeries, holdingChartGeom, holdingChartReadout, holdingChartLabel, recordedSinceText, holdingLotLines,
closedTradeLines, typicalHoldLine, holdingSectionTitle          // holdingDetailModel.ts
HoldingSection({ sku, keyScrap, now }); OwnAccountsSection({ s })   // components/HoldingSection.tsx; pages/SettingsPage.tsx
mockHoldingAsk, mockHoldingRefs, seedHoldingMarks               // mockData.ts
```

v0.8 Alerts: watches and one S3 notifier ("0.8 round", Alerts, below):

```ts
// service/domain/watches.ts (G1)
createWatchCache(deps: { repo: Pick<Repo, 'listWatches'>; log: Logger; clock?: Clock }): WatchCache
  // WatchCache: all(); index(): ScraptfWatchIndex; bases(): ReadonlySet<string>; invalidate()   (never throws)
// service/domain/bankStock.ts
BankStock.lookOf(bank, batchId, opts?: { timing?: boolean }): BankStockLook | null; isSuspect(r, 'flip' | 'cost')
BankStock.droppedFlips(bank, batchId); watchRows(bases)
BankStockDeps.watches?(): ScraptfWatchIndex; BankStockNotifyDeps.watches?(); BANK_STOCK_TIMING_META_KEY = 'bankStock.timing'
// service/domain/engine.ts
EngineDeps.watchFloorFor?(baseSku, copyKey): Scrap | null       // G1 path B: a watched copy's own profit bar, "Watch: <name>"
notificationTitle(o, paintName?, watched = false)
// shared/watches.ts
watchCovers, watchIndexOf, watchesFor, watchTargetScrap, watchMetOf, watchFresh, watchHitOf, watchJoinOf, watchNowOf,
watchViewsOf, watchFloorOf, watchInputProblem, watchWriteOf, watchTargetsText, watchRowSpecialKey; WATCHES_MAX = 200
watchRestoreOf(input: ScraptfWatchRestore, nameOf, now): { write; createdAt; updatedAt }   // 'watches.restore' (Undo)
// shared/bankStockNotify.ts
bankStockNotifyCandidates(a): BankStockNotifyCandidate[] (each with doubt and tellsFlip); bankStockNotifyOrder; bankStockNoticeOf(c, label, K, savedAgoMs, timing?)
bankStockSaleDoubtText(doubt); BANK_STOCK_WAIT_NOTE, BANK_STOCK_WAIT_NOTE_FIRST
bankStockSummaryNotice(rest, url); bankStockOldSaveSummary(due, url, ago); bankStockSummaryChip(cs); bankStockTimingParse; bankStockTimingNext
// shared/bankStock.ts
bankStockDroppedIntoFlip(r); BANK_STOCK_MORE_BODY; bankStockSaveAgeNote(ago); bankStockNewFlipNotice(label, r, K, ago?, note?)
// main/notify.ts
notificationBankStock(v): BankStockOpen | null; NotificationClickDeps.openBankStock?(open)   // G5: a click shows the bank's stock on a chip
// renderer
WATCH_MENU_LABEL, WATCH_BOUNDARY_NOTE, watchFormInit, watchFormInput, watchCopyText, watchNowView, watchNotifyNote,
watchesForCopy, watchUndoInput (→ 'watches.restore'), watchesCountText, oppMenuTarget, priceMenuTarget, changeMenuTarget   // watchesModel.ts
WatchForm, WatchSection({ d, copyKey, keyScrap, now, ceiling }), useWatchDialog(): { open({ sku, name, special? }); element },
WatchesCard({ keyScrap, now, onItem })                          // components/Watch*.tsx
bankStockWatchTag(r, keyScrap)                                  // bankStockModel.ts
mockSeedWatches(hatsRows, now)                                  // mockData.ts
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
importBatchItemsRemoved (0.7.3), bankGridMove, gridColumns, banksPath, banksRouteBank, createBanksLoader, BANKS_REFRESH_MS   // banksModel.ts
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
// 0.7.4: CHECK_BARE_REF_NOTE, checkPriceReadAsRef(result) (F44); CHECK_CRAFT_TWIN_NOTE, CHECK_CRAFT_UNSURE_NOTE,
// checkCraftUndecided(result), checkTextStatesCraft(itemText), checkCraftTwinOf(sku), checkListCopyPrices(row, craft),
// checkCraftCopy({ price, craftable, twin, familyOnSale? }): 'keep' | 'twin' | 'unsure' | 'unknown', checkWorseCopy(a, b) (F41);
// 0.7.4 review: checkListFamilyOnSale(row), checkHasRevenue(result), checkDecideCopy(choice, evaluate) (R20, R21);
// CheckCopyPrice.bank?, CHECK_NONCRAFT_BANKS (items, killstreaks: a repriced card of any other bank stays Craftable);
// CHECK_COST_VARIANT_NOTE, CHECK_COST_BELOW_MARKET_NOTE, checkCostNote(cost, own, twin), checkCostSuspect(result) (R14);
// checkRevenueUnverified(result) (R22)
// shared/itemUrl.ts
itemUrlParts(u: URL): ItemUrlParts | null; itemUrlHost(u); NEXT_STATS_PARAMS   // parseItemUrl and main's filter share these
// shared/accelerator.ts
sameAccelerator(a, b): boolean                                    // canonical chords; '' never matches
// service
parsePriceLine(line, bareUnit, resolve, spare?): PriceLine | null     // priceSheetIo.ts; parseBulkPrices uses it
parseCheckText(text, resolve, opts?: { confirmFuzzy?(itemText, item): boolean }): ParseCheckResult   // domain/liveCheck.ts, pure
createLiveCheck(deps: { repo; schema; log; settings(); keyPrice(); market: Pick<MarketIndex, 'entryFor'>; scraptfList: Pick<ScraptfListCache, 'rowFor'>; bankStock?: Pick<BankStock, 'pricesFor'> }): LiveCheck
  // ParsedCheck: 0.7.4 craftStated (F41), priceAmbiguous (F44)
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
bankStockKeyWithoutKillstreak(specialKey); bankStockIsOwnCopy(row, target)   // 0.7.3: a sheen or killstreaker alone is no other copy
diffBankStock(newest, previous | null, keyScrap): BankStockDiffRow[]; bankStockVerdict(profit, cost, p); bankStockRow(diffRow, { category, buy, keyScrap, profit })
bankStockPagePairs(saves): { page; newest; previous; firstBatchId; saves }[]; bankStockMergePages(pages)   // F17-C1: per page
bankStockRows(...); bankStockFilterOf, bankStockFilterMatches, bankStockSearchMatches, bankStockDefaultDir, bankStockComparator, bankStockPage, bankStockMatching
emptyBankStockCounts(); bankStockCounts(rows, items); bankStockWhatsNew(counts, previousSavedAt); bankStockResult(...); emptyBankStockResult(bank, keyPrice, now)
bankStockNewAt(banks): Map<baseSku, UnixMs>; marketNewSideMatches(row, q); bankStockItemOf(banks, sku, keyScrap): ItemBankStock | null
bankStockPagePath(url); bankStockNewFlipNotice(label, row, keyScrap); bankStockMoreNotice(n, url); BANK_STOCK_CSV_COLUMNS; bankStockCsvCells(row, keyScrap)
// service
Repo.insertBankStock(batchId, bank, rows, page?); bankStockSaves(bank, limit?, { perPage? }?); bankStockRows(batchId); bankStockLatestPair(bank); pruneBankStock(now, opts?)   // V6 (perPage, V8: F20)
ScrapTfParseResult.page; scraptfPageKey(hint, bodyId)               // import/scraptfHtml.ts: which page of its bank a file is
createBankStock(deps: { clock; log; repo; market: Pick<MarketIndex, 'entryFor'>; keyPrice(); settings(); categoryOf(sku); schemaLoaded?(); costSuspect?(base, cost, now) }): BankStock
bankStockCostCheck({ repo, schema?, keyPrice(), settings() }) -> costSuspect   // 0.7.4 review R14/R40: costSanity on a flip row's price
bankStockListFamily(bank, row); BankStockStored.craft?; BankStockRow.listFamily?; scraptfEventListFamily(e, rowOf); ScraptfChangeEvent.listFamily?; ScraptfListStored.page?   // 0.7.4 review R01/R06, R02
  // BankStock: refresh(); list(q, now); all(q, now); whatsNew(bank); newAtFor(baseSku); detailFor(sku); pricesFor(sku) (0.7.4, F41: bankStockPricesOf, each price with its bank); version(); newFlips(bank, batchId)
previousOf(saves); BANK_STOCK_RETRY_MS = 10_000; BANK_STOCK_NOTIFY_META_KEY = 'bankStock.lastNotified'; bankStockCsv(rows, keyScrap)   // domain/bankStock.ts
notifyNewBankFlips(deps & { toldBefore?(base, now, since?) }, { bank, batchId }, now): number   // 0.8: `since` for a watch hit (the look's save)
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
readMhtml(input: Uint8Array | string, limits?: { maxBytes?; maxParts? }): MhtmlRead   // { ok: true; html; contentLocation; notes; date } | { ok: false; reason: MhtmlFailure; detail }; 0.7.4 date: the Date header (ms) or null
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
ScraptfChangesQuery { bank?; kinds?; sku?; beforeId?; limit? }; ScraptfHistoryPoint, ScraptfPriceChange, ScraptfItemHistory, ScraptfKeyRun (+ lastOnSale, 0.7.3)
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
scraptfItemCopyOf({ sku, specialKey?, banks, keyPrice })          // 0.7.3: the copy 'scraptf.itemHistory' reads without `special`
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
// 0.8 cycles (T1-T7, LC-3-LC-6; "0.8 round", Cycles, below)
// shared/scraptfHistory.ts
SCRAPTF_FLAP_MAX_MS = 60 min, SCRAPTF_TIMING_MAX_BRACKET_MS = 24 h, SCRAPTF_ASSET_STABLE_SHARE = 0.95, SCRAPTF_ASSET_STABLE_MIN_PAIRS = 50,
SCRAPTF_ITEM_RUNS_MAX = 20, HISTORY_LAST_SEEN_STALE_MS = 48 h (moved from historyModel.ts, which re-exports it)
SCRAPTF_TIMING_GAP_SLACK = 1.25, SCRAPTF_TIMING_MIN_GAP_MS = 2 h, SCRAPTF_TIMING_GAP_WINDOW_MS = 7 d (moved here: the walk needs them)
scraptfLookGapMs(times); scraptfGapLimitMs(times)                    // a page's look gap; its gap limit (cutAt, wideStart), review fix
ScraptfStateOutcome, ScraptfPriceState, ScraptfCopyLifecycle, ScraptfBankLifecycle   // internal, not RPC (lifecycle: lookGaps per page)
scraptfLifecycleOf(saves, { bank?, keyScrap?, flapMaxMs?, maxGapMs?, assetStability? }): ScraptfBankLifecycle; scraptfAssetStabilityOf(saves)   // the one walk, its pre-pass (given: not walked twice)
scraptfKeyStatesOf(saves)                                            // now scraptfLifecycleOf(saves).keyStates (ACT-10 unchanged)
scraptfCopyBankOf(banks: { bank; life }[], key): ScraptfBank | null  // copyPickOf's rule over lifecycles
scraptfSeenBefore(run, savedAt); scraptfIsRestock(d, seenBefore)     // the one restock rule (D8): the feed's 'restocked', the notifier's "Back on scrap.tf"
ScraptfListed.key?                                                   // scraptfListedOf: the copy whose run was picked
// shared/scraptfTiming.ts (pure; the service and the mock)
SCRAPTF_TIMING_MIN_DROPS = 5, SCRAPTF_TIMING_MIN_COPIES = 3, SCRAPTF_TIMING_MIN_ENDED = 15, SCRAPTF_TIMING_MIN_AT_RISK = 8, SCRAPTF_TIMING_MIN_AT_RISK_END = 3,
SCRAPTF_TIMING_HORIZONS_MS (6 h, 1 d, 3 d, 7 d), SCRAPTF_OWN_MIN_DROPS = 3, SCRAPTF_OWN_CADENCE_MAX_CV = 0.35,
SCRAPTF_OWN_CADENCE_MIN_BRACKETS = 4, SCRAPTF_OWN_CADENCE_MIN_LOOKS = 2, SCRAPTF_WAIT_MIN_GAIN_SCRAP = 3, SCRAPTF_WAIT_MIN_GAIN_SHARE = 0.1,
SCRAPTF_WAIT_MIN_GAIN_LOW_SCRAP = 1, SCRAPTF_TIMING_Z = 1.6448536269514722, SCRAPTF_TIMING_RANGE_PCT = 90, SCRAPTF_TIMING_SPREAD_CACHE_MAX = 4096,
SCRAPTF_DROP_LOW_ALPHA = 0.05, SCRAPTF_DROP_SHORT_BRACKET_MIN = 5,   // 0.9 (#10)
SCRAPTF_TIMING_STEPS_MAX = 10, SCRAPTF_TIMING_BRIEF_STEPS = 5, SCRAPTF_TIMING_RUN_ENDS_MAX = 5,
SCRAPTF_TIMING_TABLES_MAX = 64, SCRAPTF_TURNOVER_CURVE_MAX = 50 (SCRAPTF_TIMING_MAX_BRACKET_MS and the gap-limit names re-exported)
ScraptfTimingTable (+ events, copyIx, placement, dropSizes, dropBrackets); ScraptfTimingPlacement = 'right' | 'left'; scraptfTimingTableOf(states, keyScrap, scope, placement = 'right')
scraptfTimingAt(t, ageMs); scraptfAtRiskAt(t, ageMs); scraptfLookGapMs(times)
ScraptfBankCycles; scraptfBankCyclesOf(bank, saves, keyScrap, { assetStability? }); scraptfTimingTableFor(c, valueScrap, keyScrap, placement = 'right')   // band, else the bank; 'left' cached beside as …|left
scraptfTimingInfluenceOf(t, fromMs, toMs): ScraptfTimingInfluence; scraptfTimingSpreadOf(t, fromMs, toMs, lookGapMs): ScraptfTimingSpread   // memoised per table
scraptfWilson(p, n, z?); scraptfShareRange(p, variance, states, copies): ScraptfShareRange
scraptfMedianLowRank(n, alpha?); scraptfDropLowOf(sizes, brackets, lookGapMs): ScraptfDropLow | null; scraptfTableDropLowOf(t, lookGapMs)   // T9-3b, memoised per table
scraptfTimingEv({ revenueScrap, costScrap, nextScrap, pDrop, pNone, q, profit }): { evBuyScrap; evWaitScrap }   // through flipProfit
scraptfBuyTimingOf({ bank, copy, table, buy, profit, keyScrap, lookGapMs, now, tableLeft? }): ScraptfBuyTiming   // + uncertainty?, saveTiming?
scraptfTimingForKey({ cycles, key, buy, profit, keyScrap, now }): ScraptfBuyTiming | null; scraptfTimingBrief(t): ScraptfTimingBrief
scraptfCyclesLookGapMs(c, page)   // the home page's look gap the lifecycle kept (life.lookGaps): never re-sorted per row
scraptfTurnoverOf(life, bank); scraptfBankTurnover(c) (memoised); scraptfItemCyclesOf(c, key)
scraptfItemTimingOf(h, { cyclesOf, buy, profit, keyScrap, now }): Pick<ScraptfItemHistory, 'cycles' | 'timing'>
scraptfOpportunityTiming(o, timingForCopy, now): ScraptfTimingBrief | null   // 'import' rows only
// shared/bankStock.ts
bankStockRow(d, { …, timing? }); bankStockRows({ …, timingOf?(key, buy) }); bankStockResult({ …, turnover? })
// service
createScraptfHistory(deps: { …, profit?(): CeilingSettings })      // core: () => settings.profit; omitted (tests): no timing
  // ScraptfHistory += timingFor(bank, key, buy, now, inputs?); timingForBase(baseSku, bank, buy, now, inputs?);
  //   timingForCopy(baseSku, specialKey, buy, now, inputs?); turnoverFor(bank); assetStability(): ScraptfAssetIdsHealth[]
  //   (timingFor never throws: logged once per streak, null). inputs?: ScraptfTimingInputs { keyScrap, profit }: the
  //   read's own key price and settings.profit (bank stock rowsFor, market list(), opps.list pass them once per read),
  //   so a join of hundreds of rows reads no key price per row; omitted, the history reads both itself.
  //   assetStability() is the pre-pass alone (scraptfAssetStabilityOf, kept per runs rebuild and reused by the lifecycle
  //   through scraptfLifecycleOf's opts.assetStability): Health's 5 s poll builds no bank's lifecycle.
BankStockDeps.history?: Pick<ScraptfHistory, 'runsFor'> & Partial<Pick<ScraptfHistory, 'timingFor' | 'turnoverFor'>>   // rowsFor(…, timingAt = null)
MarketIndexDeps.history?: Pick<ScraptfHistory, 'listedSinceFor' | 'version'> & Partial<Pick<ScraptfHistory, 'listedFor' | 'timingForBase'>>   // list() only
HandlerContext.scraptfHistory: Pick<ScraptfHistory, 'onImport' | 'itemHistory' | 'changes' | 'csv'> & Partial<Pick<ScraptfHistory, 'timingForCopy'>>
listOpportunities(repo, q, keyPrice, now, useOrder?, joins?: { timingForCopy? })   // views.ts: Opportunity.timing on 'import' rows
HealthReport.scraptfAssetIds (computeHealth); ImportReport.counts.reserved / notTradable, ImportReportItem.dataBot   // LC-5, LC-6
// renderer
timingBadge(t, now), timingVerdictTitle(t, now), timingWhyText(why, ctx), timingDurText(ms), timingRangeText(r), timingRangesText(t), timingSaveTimingText(t), assetIdsLines(list), TIMING_ESTIMATE_NOTE   // timingModel.ts
historyTimingView(t, h, keyScrap, now), historyRunLines(c, h, keyScrap, now), HISTORY_RUNS_SHOWN   // historyModel.ts
stepChartGeom(points, box?, marks?: { downAts? }) -> StepGeom.downs? (only with marks); StepSparkline draws a tick under each
bankStockSinceListedCell(r & { timing? }, keyScrap), bankStockTurnoverText(t, path)   // bankStockModel.ts
importReportToast(copied, count, markers?: { reserved; notTradable })   // importModel.ts
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
importBankText(bank, stored?, savedWithoutCards?, fromWindow = false, removedByUpdate = false)  // banksModel.ts
createMockScraptfWindow({ now; settings; emit; itemsOn?; bestFlipOn?; flipsOn? }): MockScraptfWindow; MOCK_WINDOW_READ_WARNING   // mockScraptfWindow.ts
```

v0.7.1 import truth, bank history, alerts and the window ("0.7.1 round", below):

```ts
// shared/types.ts (every new field optional)
ImportResult + skippedTotal?, skippedCounts? (benign reason text or warning code -> count), stockSave? ('written' | 'partial' | 'unsettled' | 'none'),
  pageFlips?, topFlips?: ImportTopFlip[] (<= 3; { sku; name (app data); costScrap; maxCostScrap; profitScrap })
ImportReport { id; at; origin; name; pageKind; bank; page; format; batchId; counts; headerColumns; warningCodes; items: ImportReportItem[] (<= 200) }
ScraptfWindowRead + stored?, pageFlips?, bestFlip? (0.7.4: + stockSave?); ScraptfWindowNav + importable?, notice?; ScraptfWindowState + pendingPartitionChange?
MarketSort + 'seen'; MarketRow.scraptfLastSeenAt?; BankStockRow.lastSeenAt?; BankStockResult.olderPages?; ScraptfChangeEvent.wasFlip?
ShoppingRow.knownObservedAt?, knownStock?, knownStale? (0.7.4: + knownSuspect?)
// shared/rpc.ts
'import.html' params + settled?: boolean (main only; false = an unsettled window snapshot); 'import.report' (service) { limit? } -> ImportReport[]
'app.showBankStock' (main) { bank; filter: 'flips' | 'new' (0.8: | 'watched', BANK_STOCK_OPEN_FILTERS) } -> { ok: true }; push 'ui.openBankStock' (main only, held by the preload like ui.openItem)
// shared/importCodes.ts, scraptfPaths.ts, boundaryText.ts
IMPORT_SCHEMA_LOADING_CODE, IMPORT_SCHEMA_LOADING_MESSAGE, LAYOUT_CHANGED, NO_PRICE_COLUMN, PARTIAL_READ, NO_STOCK_LIMIT, IMPORT_REFUSAL_CODES,
SKIP_OUT_OF_STOCK, SKIP_SAME_OR_CHEAPER, SKIP_NEWER_SAVE, (0.7.4) SKIP_NOT_ON_SALE_NEWER, BENIGN_SKIP_REASONS, PARTIAL_READ_MAX_AGE_MS (6 h), PARTIAL_READ_RATIO (0.5),
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
scraptfCoverage(batches, categoriesOf, extra?, wholeLookOf?); MARKET_SORTS; marketProfitTie; marketProfitTiesFirst(key) ('seen', 0.9 'backup' / 'depth')
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
listSetupState(s, windowOn?) ('window-only', 'watch-waiting'); listStepsAutoOpen(s, windowOn?); listBoundaryNote, marketBoundaryNote; FIRST_PRICE_LEAD (0.7.4: + FIRST_PRICE_LIST_NOTE)
bankStockBuyCopy(row, bank) (ItemMenuTarget.copy, recordBuyInit(item, prices, copy?, keyScrap?)); bankStockHeader(bank, r, now, inWindow?); SESSION_NOTE
DEFAULT_CHANGE_KINDS (all but 'stock'), CHANGES_PREF_KEY 'log.scraptfChanges.v2', changesViewFromLegacy; historyEventGroups; changeRowView.wasFlip
importSkipSummary, IMPORT_REPORT_NOTE, importOffText(windowOn); checkNotifyHint(notificationsOn, popupOn?); scraptfOpenedToast(..., readOnLoad?)
showFlipsView(read), bestFlipTitle, windowNoticeText   // scraptfWindowModel.ts
```

v0.7.3 audit fixes ("0.7.3 round", below; every new field optional):

```ts
// shared/types.ts, rpc.ts
ImportResult.listRowsRead?                                        // list rows an /items page gave, written or not
'opps.exportCsv' kind 'events' + events?: EventsExportQuery { kinds?; category?; search? }
PERMISSION_FIELD_MAX                                              // the permission record's field limits (schema and Import page)
// shared
UNUSUALS_INDEX ('unusuals-index', importCodes.ts); OPPORTUNITY_EVENT_KINDS, EVENTS_EXPORT_MAX, eventMatches   // opportunityEvents.ts
positionCostAt(pos, keyScrap)                                     // holdings.ts: a held position's cost, Holdings and the Journal page
// service
UNUSUALS_INDEX_WARNING                                            // import/scraptfHtml.ts
BptfApi.credentialRejected(name: 'bptfApiKey' | 'bptfAccessToken'): string | null   // in memory only; the bp.tf jobs wait on it
RateLimitedError.busy                                             // net/errors.ts: a wait behind the same host's gate timed out
LOAD_ALL_SLACK_MS = 60_000                                        // connectors/pricedb.ts: the pricedb-all freshness slack
STABLE_CONNECTION_MS = 30_000                                     // connectors/bptfSocket.ts: a connection this long resets the backoff
// main
ServiceHostStatus.failure                                         // the ready message's reason (tray: "Cannot open its data")
// renderer
OPP_MAX_SEARCH_CHARS (oppModel.ts); KEY_SANE_SCRAP (settingsFields.ts); SCRAPTF_CHALLENGE_NOTICE_READ_OFF (scraptfWindowModel.ts)
```

v0.9 exits (#2 exact exit fees and break-even, #11 buyer signals, #14 hardening; "0.9 round", below):

```ts
// shared/venues.ts (integer cents; no URL, no request)
ScmFeeRule, SCM_FEE_RULE (5% Steam, 10% TF2, min 1 cent), FEE_MAX_CENTS (1,000,000)
scmBuyerPaysCents(receivedCents, rule?) (100 -> 115, 193 -> 221, 1 -> 3), scmSellerNetCents(buyerPaysCents, rule?) (the inverse; null under 3)
MANNCO_FEE_BPS (500), MANNCO_MIN_FEE_CENTS (1), manncoNetCents(priceCents); MARKETPLACE_FEE_DEFAULT (0.1), MARKETPLACE_FEE_MAX (0.5), marketplaceFeeOf(v)
parseUsdCents(text), usdText(cents); venueFeeHint(venue, side, marketplaceFeePct?); JOURNAL_VENUES + 'mannco.store'
// shared/ceiling.ts
BreakEvenSettings, marketplaceFeePctOf(p), breakEvenFor(cost, p, mode = 'buy'), grossBeforeFee(net, fee), scmGrossValue(net), breakEvensOf(cost, p, mode?)
// shared/buyerSeen.ts, scraptfWindowPolicy.ts
BOT_SERVICES, botServiceOf(uaClient), botServiceTitle(o)   // a label only
SCRAPTF_READ_REASONS.challenge; SCRAPTF_CHALLENGE_PHRASES, SCRAPTF_CHALLENGE_SCAN_CHARS (262,144), scraptfChallengeIn(html)
// service
bptfListingActive(raw, stats?), truthyBan(v), isBannedFromBans(bans) (moved from bptfApi.ts, which re-exports it)   // connectors/bptfItem.ts
BptfMapStats.inactive; WsMapResult ok arm + active   // the socket drops an inactive listing like a delete (FeedBatch.inactive)
CHALLENGE_BODY_MARKERS, hasChallengeMarkers(text); STEAM_RATE_LIMIT_ERESULTS ('25', '84'), steamRateLimitEresult(host, headers)   // net/http.ts
opportunitiesCsv(rows, keyScrap, profit?: BreakEvenSettings | null) + break_even_ref   // domain/csv.ts
// renderer
BREAK_EVEN_NOT_A_FORECAST, breakEvenText, venueBreakEvensText, breakEvenTitle(b, keyScrap, { estimate? }), oppCostTitle, holdingBreakEvenTitle   // breakEvenModel.ts
BreakEvenView, quickBreakEvenView, inputBreakEvenView, CheckBreakEvenView, checkBreakEvenView; ScmNetView, SCM_NET_TITLE, scmNetView(r)   // breakEvenModel.ts
MARKETPLACE_FEE_PCT, MARKETPLACE_FEE_HINT (settingsFields.ts); feeHint(venue, side, marketplaceFeePct?) (recordTradeModel.ts); FLAGS.impersonator (format.ts)
```

v0.9 scrap.tf (#9, #13, #25, #22; "0.9 round", below):

```ts
// shared/checkoutGuard.ts (pure, zod-free, no address: an F20 file)
CheckoutGuardSource ('help' | 'community' | 'inferred' | 'rule'), CheckoutGuardId, CheckoutGuardLine, CHECKOUT_GUARD_LINES, CHECKOUT_GUARD_SOURCE_LABELS
CHECKOUT_GUARD_CHECKED ('2026-10-22'), CHECKOUT_GUARD_HEAD, CHECKOUT_GUARD_NEVER, CHECKOUT_GUARD_SHORT, CHECKOUT_GUARD_TAG, CHECKOUT_GUARD_POPUP
CHECKOUT_GUARD_TOAST, CHECKOUT_GUARD_TOAST_BODY_MAX (200); checkoutGuardItems(), checkoutGuardTitle(), withCheckoutGuard(body, max?)
// shared/importCodes.ts, banks.ts, bankStock.ts, bankStockNotify.ts
BANK_UNAVAILABLE ('bank-unavailable'), BANK_UNAVAILABLE_WARNING; PRICE_MARKDOWN, PRICE_COUNTDOWN, RECENT_SECTION (report only); IMPORT_REPORT_NOTICES_MAX (5)
bankNoticeNewestAt(batches, bank), bankUnavailableAt(noticeAt, lastSavedAt)   // ScraptfBankSummary.unavailableAt
bankStockMarkdownText(marks), bankStockMarkdownOf(v) (Foundation); bankStockRow(...).markdown (an on-sale row only)
bankStockNoticeWithGuard(c, label, K, savedAgoMs, timing?)   // the S3 notifier's send
// service
SchemaService.effectIdByName(name, type?); EFFECT_NAME_ALIASES ([{ id: 408, names: ['Polar Prism', 'Northern Nights'] }]), effectTypeForItem(item, skin)   // connectors/schemaNames.ts
ScrapTfParseResult.bankNotice?: 'unavailable'; ParseDiagnostics.notices; DocScan.probes, DocScan.recentCards   // import/scraptfHtml.ts
ImportReport.counts + markdownSoon, markdownOff, countdownCards, recentlyTraded, recentCards, bankNotices; ImportReport.notices?   // import/reports.ts
importSavedPage: a bankNotice look is stockSave 'partial'; a window read of one with 0 items records its batch; ImportBatch.bankNotice
// main
WARNING_ORDER: BANK_UNAVAILABLE first   // scraptfWindow.ts
// renderer
checkGuardLine(r), timingGuardShown(t), shoppingGuardLine()   // checkoutGuardModel.ts
CheckoutGuard({ variant: 'list' | 'line' })   // components/CheckoutGuard.tsx; timingBadge's title ends with CHECKOUT_GUARD_TAG on Buy now
bankStockMarkdownTag(r) ('Drops soon' | 'Marked down')   // bankStockModel.ts
BankCardView.unavailable, bankUnavailableText(s, now, path); importBankText(..., unusualsIndex?, bankUnavailable = false)   // banksModel.ts
importBankUnavailable(r), ImportReportMarkers, importReportMarkers(reports), importReportToast(copied, count, markers?: ImportReportMarkers)   // importModel.ts
WINDOW_WARNINGS[BANK_UNAVAILABLE]   // scraptfWindowModel.ts
BoundaryGrade, BoundarySource, UnsupportedRow, UNSUPPORTED_CHECKED, BOUNDARY_GRADE_LABELS, UNSUPPORTED_INTRO, SCRAPTF_UNSUPPORTED (9 rows)   // aboutModel.ts
PERMISSION_QUESTIONS, PERMISSION_TEMPLATE (moved from ImportPage.tsx, which re-exports it), boundarySourceTitle(s)   // aboutModel.ts
UnsupportedPanel()   // pages/AboutPage.tsx: copies, never opens
```

v0.9 holdings and ledger (#1 trade lock, #17 trend size and key band, the ledger's valuation; every new field optional):

```ts
// shared/robustStats.ts (pure; other packages may import it, never edit it)
median(values), quantile(values, q) (R type 7), theilSen(points) -> { slope; intercept; pairs } | null, medianAbsDeviation(values, center?)
// shared/holdingAdvice.ts
TRADE_LOCK_MS (7 d); tradeLockModeOf(settings) ('unknown' unless 'none' / '7d'); tradableAtOf(boughtAt, mode) (+7 d with '7d', else null)
holdingTradeLockOf(lots, mode, now) -> HoldingTradeLock | null; withTradeLock(row, lots, mode, now) (no key without a lock)
HOLDING_TREND_SIZE_MIN_POINTS (5), HOLDING_TREND_SIZE_MAX_POINTS (60); HoldingTrend.size (Theil-Sen over the newest stretch's sources)
KEY_BAND_SPAN_MS (7 d), KEY_BAND_STEP_MS (1 d), KEY_BAND_MAX_POINT_AGE_MS (2 d), KEY_BAND_MIN_SPANS (28), KEY_BAND_MAX_SPANS (180), KEY_BAND_LOW_Q / HIGH_Q (0.1 / 0.9)
keyMoveBandOf(points, loadedAt) -> KeyMoveBand | null; HoldingAdviceOptions.keyBand
holdingAdvice: kind 'locked' (first reason 'trade-locked' with todayKind), context reasons 'trend-size', 'units-locked', key-exposure.band
// shared/holdings.ts
holdingLockedNow(row); HoldingsResult.totals.locked (absent at 0; locked rows leave sellable)
holdingsValuationOf(res) -> HoldingsValuation; lotValueOf(lot, sku, v, profit) -> JournalLotValue; journalValuerOf(v, profit) -> JournalLotValuer
// shared/journal.ts
JournalLotValuer { at; valueOf(lot, sku) }; journalLedger(entries, valuer = null); JournalLedgerRow.value
JOURNAL_CSV_COLUMNS + worth_now_ref, unrealised_ref, valued_at (23 columns; blank without a valuer and on every row but an open buy)
// shared/links.ts
STEAM_TRADE_PROTECTION_FAQ_URL (in STATIC_EXTERNAL_URLS; opened only in the user's browser, never fetched)
// service
PriceDb.loadedKeyHistory() -> LoadedKeyHistory | null   // the key curve cache ('|' first); history('5021;6') now fills it; sends nothing
HoldingsDeps.keyHistory?() -> LoadedKeyHistory | null    // core: pricedb.loadedKeyHistory(); a throw gives no band, never a failed list
journalCsv(entries, valuer = null)                       // domain/csv.ts; 'journal.exportCsv' values over ctx.holdings.list({}, now)
// renderer
keyBandText(band, netKeys); TRADE_LOCK_QUESTION, TRADE_LOCK_BODY, TRADE_LOCK_LABELS, TRADE_LOCK_TITLES, TRADE_LOCK_CARD_ORDER, TRADE_LOCK_HELP
TRADE_LOCK_CARD_FOOTER, TRADE_LOCK_CAUTION, TRADE_LOCK_FAQ_LABEL; tradeLockAnsweredText(at), tradeLockSetToast(mode), tradeLockCautionOn(settings)
tradeLockDrawerCaution(heldSince, now); SELLABLE_TITLE, sellableTitle(totals); tradeLockLapseAt(rows), holdingsLapseAt(rows)   // holdingsModel.ts
holdingLotLines(lots, keyScrap, now, mode = 'unknown') (" · tradable <date>")                     // holdingDetailModel.ts
INVENTORY_TITLE, inventoryStat(valuation, keyScrap, error?)                                    // journalModel.ts
TradeLockCard(), TradeLockCaution({ held })                                                   // components/TradeLockCard.tsx
TradeLockSection({ s })                                                                       // pages/SettingsPage.tsx ('set-trade')
mockKeyHistory(t0, keyScrap)                                                                  // mockData.ts: 45 daily points, no RNG
```

v0.9 ranking (#3 risk-aware keys and the risk control, #12 the suggested reserve; "0.9 round", below):

```ts
// shared/exitRisk.ts (pure; imports ./ceiling and ./types only)
EXIT_DEPTH_CAP (20), BOOK_DEPTH_MANY_MIN (5), MIN_PROFITABLE_DEPTH_MAX (10); ExitDepth { values; buyers }, ExitRisk { backupProfitScrap; profitableDepth; bookDepth }
exitDepthOf(orders, useOrder?), profitableDepthAt(d, cost, p) (= values >= breakEvenFor(cost, p, 'buy')), backupProfitOf(next, cost, p)
exitRiskAt(e: { exitDepth?; nextBuyer? }, cost, p) -> ExitRisk | null; opportunityRiskFields(r) (nulls absent), marketRiskFields(r) (profitableDepth null kept)
liquidityTagOf(bookDepth) ('none' | 'one' | 'few' | 'many'); minProfitableDepthOf(v), depthGateOk(depth, minDepth)   // notifications.minProfitableDepth
// shared/reserveSuggest.ts (pure)
RESERVE_LOOKBACK_MS (90 d), RESERVE_MAX_MARKS (50,000), RESERVE_BANDS, RESERVE_BAND_REF10_SCRAP (90), RESERVE_DEFAULT_HOLD_MS (1 d), RESERVE_MIN_HOLD_MS (1 h), RESERVE_MAX_HOLD_MS (14 d)
RESERVE_MIN_WINDOWS (20), RESERVE_MIN_ITEMS (3), RESERVE_MAX_WINDOWS_PER_ITEM (30), RESERVE_QUANTILE (0.1), RESERVE_POINT_TOLERANCE_MIN_MS (1 h), RESERVE_KEY_POINT_MAX_AGE_MS (2 d)
reserveBandOf(value, keyScrap), lowerQuantile(sorted, q), suggestedPctOf(p10), ReserveHold, reserveHoldOf(hold), ReserveWindow, keyPriceAtOf(keyHistory) -> (t) => Scrap | null, markRevenueScrap(m, keyScrap)
recordedWindows(marks, holdMs, settingsAt, now, keyAt?), pricedbWindows(histories, holdMs, now), reserveSuggestionOf({ marks, histories, hold, keyScrap, settingsAt, now, keyHistory? }) -> ReserveSuggestion
// shared/market.ts, bankStockNotify.ts
marketRiskCost(r) (your price, else a rule flip's estimate, else null); MARKET_CSV_COLUMNS + backup_profit, profitable_depth, book_depth, book_depth_tag
BankStockNotifyArgs.minDepth?, depthOf?(row)   // candidateOf's flip gates
// service
'profit.reserveSuggestion' -> ReserveSuggestion   // rpcHandlers.ts: holdingMarksSince, the journal, historyCache, pricedb.loadedKeyHistory() only
MarketEval.exitDepth?; sortValueOf(key, e, profit, knownObservedAt, risk); toRow(c, now, K, kn, p, withTiming?)   // domain/market.ts
BankStock.depthOf?(r); Holdings.buyerSettingsAt?(now); opportunitiesCsv + backup_profit_ref, profitable_depth, book_depth, book_depth_tag
// renderer
OPP_SORT_LABELS, OPP_SORT_HELP; compareOpps ties 'backup' / 'depth' by profit   // oppModel.ts
MIN_PROFITABLE_DEPTH, MIN_PROFITABLE_DEPTH_LABEL, minProfitableDepthHint(n)   // settingsFields.ts
DEMAND_NOT_SALES, BOOK_DEPTH_LABELS, BOOK_DEPTH_BOT_LABELS, depthPopulationNote(useOrder?), depthCountText(n), riskSentences(r, keyScrap, at, hasRevenue, useOrder?), oppBuyersTitle(o, keyScrap, useOrder?)   // riskModel.ts
marketRiskTitle(r, keyScrap), marketSellsTitle(r, keyScrap, now?), DRAWER_RISK_HELP, DrawerRiskLine, drawerRiskLine(o, buyOrders, p, keyScrap)   // riskModel.ts
RESERVE_BAND_LABELS, RESERVE_SUGGEST_HELP, reserveBandText(b), ReserveSuggestionView, reserveSuggestionView(s)   // riskModel.ts
OppSortPicker (OpportunitiesPage.tsx); ReserveSuggestionNote (SettingsPage.tsx, under Profit thresholds' fields)
```

v0.9 history (#6 order persistence, #7 recorded community prices, scrap.tf lows; "0.9 round", below):

```ts
// shared/orderPersistence.ts (pure, zod-free; order persistence, never a fill rate)
ORDER_SPELLS_MAX_AGE_MS (60 d), ORDER_SPELLS_PER_BASE_MAX (300), ORDER_SPELLS_MAX_ROWS (400,000), ORDER_SPELLS_DETAIL_MAX (2,000), BOOK_HISTORY_ORDERS_MAX (5)
ORDER_SPELL_FOLLOW_SHARE (0.7), ORDER_SPELL_TOUCH_MS (10 min), ORDER_SPELL_OPEN_MAX (20,000), ORDER_SPELL_RELIST_GRACE_MS (60 s)
ORDER_PERSISTENCE_HORIZONS_MS (1 h, 1 d, 7 d), ORDER_PERSISTENCE_MIN_AT_RISK (8), ORDER_PERSISTENCE_MIN_AT_RISK_END (3), ORDER_PERSISTENCE_VALUE_BAND (0.15), ORDER_PERSISTENCE_NOTE
SpellObservation; orderSpellFollows(l, topScrap, keyScrap), orderSpellEndOf(prev, next, keyScrap) ('same' | 'lowered' | 'raised'), spellObservationOf(s, keyScrap)
persistenceWindowOf(obs, ageMs, horizonMs), orderPersistenceOf(spells, order, keyScrap, now), orderSpellSummaryOf(spells), spellsEntryCutOf(spells), itemBookHistoryOf(a)
// shared/communityHistory.ts (accepted price suggestions, never sales)
COMMUNITY_HISTORY_MAX_AGE_MS (365 d), COMMUNITY_HISTORY_PER_SKU_MAX (200), COMMUNITY_HISTORY_MAX_ROWS (300,000), COMMUNITY_HISTORY_DETAIL_MAX (200), COMMUNITY_CURRENCY_MAX (16)
COMMUNITY_FEED_MEMO_MAX (20,000), COMMUNITY_NOTE; communityHighOf(p) (a high equal to the low is null), sameCommunityPrice(a, b), communityPointKey(p)
communityValueScrap(currency, value, keyScrap) (pricing.ts's communityScrap, parity-tested), communityHistoryPointsOf(before, incoming, { delta, recordedAt }), communityHistoryOf(points, current)
// shared/scraptfLows.ts
SCRAPTF_LOWS_MAX_AGE_MS (365 d), ScraptfLowSighting; rawPriceCompare(a, b, keyScrap), scraptfLowFold(low, s, keyScrap), scraptfLowMerge(a, b, keyScrap), sameScraptfLow(a, b)
scraptfLowSightingsOf(rows, bank, at), scraptfLowsOf(saves, bank, keyScrap), scraptfCopyLowOf(core, keyScrap)
// shared/types.ts (Foundation)
OrderSpell, OrderSpellEnd (deleted | inactive | lowered | raised | relisted | unwatched), ORDER_SPELL_ENDS, PersistenceScope, PersistenceShort, PersistenceWindow, OrderPersistence
OrderSpellSummary, BookOrderPersistence, CommunityPoint(Source), CommunityHistory(Step), ItemBookHistory, ScraptfLowCore, ScraptfLowStored, ScraptfCopyLow; BankStockRow.low?, ScraptfItemHistory.low?
// service
wsCommunityPriceOf(payload, stats?) -> WsCommunityPrice | null   // connectors/bptfItem.ts: item.price.community; never user, steam or deal
FeedBatch.community? (FeedCommunityPrice, newest per base), FeedBatch.epoch? (grows per connection and buffer-limit-exceeded)   // contracts.ts, connectors/bptfSocket.ts
createOrderSpellTracker(deps): OrderSpellTracker { start(), onBatch(b, tracked, now), tick(live, now), stop(), following() }   // domain/orderSpells.ts
createCommunityFeedRecorder(deps): CommunityFeedRecorder { record(prices, tracked) }   // domain/communityFeed.ts
readItemBookHistory(a) -> ItemBookHistory   // domain/bookHistory.ts ('item.bookHistory': local reads only)
ScraptfHistory.lowsFor(bank), ScraptfHistory.recordLows(batchId); ScraptfHistoryDeps.lows?   // domain/scraptfHistory.ts
BankStockDeps.history.lowsFor?   // domain/bankStock.ts: BankStockRow.low, after the watch join
Repo.insertOrderSpell, endOrderSpell, touchOpenOrderSpells(at, exceptIds?), endOpenOrderSpells, orderSpells, pruneOrderSpells   // db/repo.ts (Foundation)
Repo.communityFor, insertCommunityHistory, communityHistory, pruneCommunityHistory; Repo.scraptfLows, upsertScraptfLows, pruneScraptfLows
RETENTION.orderSpellsMs / communityHistoryMs / scraptfLowsMs; runMaintenance(...) + orderSpells, communityHistory, scraptfLows   // domain/engine.ts
'item.bookHistory' { sku, orders? } -> ItemBookHistory   // no push
// renderer
BOOK_HISTORY_REFRESH_MS (30 s), BOOK_HISTORY_ORDERS_SHOWN (3), PERSISTENCE_SCOPE_SHORT, PERSISTENCE_SCOPE_WORDS, PERSISTENCE_SHORT_WORDS, SCRAPTF_LOW_NOTE, BOOK_HISTORY_NOTHING_FOLLOWED
bookHistoryOrderIds(orders), bookOrderWho(o, orders), fmtPersistencePct(p), bookHistorySummaryText(s), bookHistorySummaryTitle(s), orderPersistenceLine(o, who, keyScrap)
communityChartPoints(h, keyScrap, now), communityReadout(step, keyScrap), communitySinceText(h), scraptfLowLine(h, keyScrap), scraptfLowSentence(low, costScrap, keyScrap)   // bookHistoryModel.ts
BookHistorySection({ sku, orders, keyScrap, now })   // components/BookHistorySection.tsx: ItemDrawer, after the Sell listings
bankStockPriceTitle(r & { low? }, keyScrap)   // bankStockModel.ts: + scraptfLowSentence
mockOrderListedAt(listingId, now), seedOrderSpells(book, now), seedCommunityHistory(book, now)   // mockData.ts
```

v0.9 timing (#10 honest uncertainty in buy timing; "0.9 round", below): its entries extend the 0.8
`// shared/scraptfTiming.ts` block and the `timingModel.ts` renderer line above in place (the jackknife, the share
ranges, the drop size's low end, 'left' placement, `tableLeft?`, `timingRangeText`, `timingRangesText`,
`timingSaveTimingText`); 0.8's fixed drop-chance constant is gone from it.

## Integration (src/service/core.ts and friends)

```ts
createLogger({ dataDir, post? }): ServiceLogger          // <dataDir>/../logs/service.log, 5 MB x 2, every line redacted
createServiceCore({ dataDir, version, settings, secrets, log, fetchImpl?, wsFactory?, socketFactory?, clock?, timers? })
  -> { start(); stop(); handle(method, params); updateSettings(s); updateSecrets(s); onPush(cb) }
createScheduler({ clock, timers, log, isPaused }) + buildJobs(ctx)   // fixed cadences, no overlap, skipped while paused/blocked;
                                                          // a wall clock that moved back never pushes a job beyond one
                                                          // cadence (or its start delay)
createRpcHandlers(ctx)                                    // every SERVICE_METHODS entry, zod-validated params
importSavedPage(ctx, { html, fileName, mtimeMs })         // shared by 'import.html' and the folder watcher; `html` is the
                                                          // file's text, .mhtml included (parseSavedPage unpacks it, F18)
```

- The database is `<dataDir>/flipdesk.sqlite`. A database from a newer app version (SchemaVersionError) leaves the
  service running in a failed state where every RPC answers with that message, instead of crash-looping.
  0.7.2: the core's `failure` rides on its ready message (`{ type: 'ready', failure }`, optional), so main logs
  WARN "service started without its database: …" instead of "service ready". The dashboard shows
  `DataTooNewScreen` (`dataTooNewModel.ts` parses the message) in place of "Can't reach the background service":
  this copy is older than its data, nothing was changed, and which copy runs (`app.info`: version, `appDir`, data
  folder; main answers it itself). `AppInfo.appDir` is the install folder (`dirname(execPath)`) when packaged, else
  `app.getAppPath()`; Settings shows it as *Runs from*. 0.7.3: the host keeps the ready message's reason in
  `ServiceHostStatus.failure`, apart from `lastError` (still the banner detail) and cleared on respawn. While it is
  set, the tray tooltip shows the fixed line "Cannot open its data: open the dashboard", never the raw reason, in place
  of "Waiting for data..." or "Network paused". A UtilityProcess fatal `'error'` event is logged as "service process
  error: <type>" with `{ location, report }`, where `report` is a summary only (event, trigger and nodejsVersion, the
  JS stack message and at most 10 frames, heap total and used): the raw Node diagnostic report, which holds the
  environment variables, is never logged.
- backpack.tf credentials (0.7.3): `key-bptf`, `bptf-prices` and `snapshot-watched` also wait, with no request, while
  backpack.tf has rejected the stored credential (`BptfApi.credentialRejected(name)`, in memory only). They resume on
  the next tick once the user saves a different value (`core.updateSecrets` kicks them) or a Settings test of that
  credential passes. The key test's "accepted it … ago" shortcut counts only a 2xx answer without `success: 0`, and
  any API-key rejection forgets an earlier acceptance.
- PriceDB's full list (0.7.3): `pricedb.loadAllAt` meta holds the start time of the last successful /autob/items load.
  The `pricedb-all` job runs every 4 h; `loadAll` skips only while that stamp is less than 4 h minus
  `LOAD_ALL_SLACK_MS` (60 s) old, and a stamp in the future counts as stale. The job reports OK only when it loaded
  the list or the list is still fresh; a failed load is a failed run, retried after 15 min (during an outage at most 4
  extra requests an hour, well within the pricedb budget, R7). The `sku_aliases` cache (PriceDB's own spelling of a
  SKU) follows the form of the newest /autob/items record on each full load, back to the legacy form included, so a
  stale swapped w/pk alias, or one cached after a 404, is reset. A stored PriceDB row keeps its newest record
  (`Repo.upsertPricedb`: an older `time` never replaces a newer stored one; an equal time rewrites, an undated record,
  0, writes), because /autob/items is CDN-cached up to 4 h and would otherwise roll back newer socket, /item and
  /items-bulk prices.
- The backpack.tf feed (0.7.3): a connection that delivered frames or pings for at least `STABLE_CONNECTION_MS` (30 s)
  resets the 1 s to 60 s reconnect backoff however it ends (server close, the silence watchdog, sleep and resume, a
  pause), and Data health counts the remaining wait down while the feed is in backoff.
- Feed batches: names, deletes and listings in one transaction; sell listings are kept only for watched base SKUs
  (SKUs with a scrap.tf price or an open journal lot, see Holdings) unless `liveFeed.keepSellListings` is 'all';
  affected base SKUs are marked dirty. 0.7.4 (F14): "watched" here is the watched bases with every twin of their
  book (`watchedBookSet`, "Book twins" below), so a watched item's sell listing filed under its twin defindex is kept
  too. Storage only: the snapshot and PriceDB jobs still walk `watchedSet`.
- Opportunity events are appended to `<dataDir>/../logs/opportunities-YYYY-MM-DD.jsonl` (local date) after each
  engine change, oldest first from repo meta `oppLog.lastEventId` (the position across restarts). Files older than
  the 90-day event retention, and the oldest ones while all of them exceed 512 MB, are removed once a day.
- Snapshots: user refreshes run at once (user priority); the background job takes at most one watched SKU per
  minute, and only when the snapshot budget has a free slot; a SKU whose snapshot fails waits 30 min, doubling up
  to a day. A fresh snapshot reconciles the stored order book; listings the feed updated or deleted after the
  snapshot was taken keep the feed's version. A snapshot served from the 10-min cache changes nothing.
  0.7.4 (F16, F24, F30): the background pick is the queue (typed prices), then `ctx.snapshotPriority` (core:
  'profitable', then 'below-threshold' opportunities whose revenue order is unverified or not seen within
  `CONFIRMED_MS`, 2 h, most profit first; then explicit-price rows of any other status whose unverified, non-outlier
  best order would clear the profit thresholds against their cost, `unverifiedUpside` in engine.ts, most potential
  profit first: the verified-order preference prices them lower, as Strange Archer's Sterling at a loss on a verified
  100 scrap order beside a 114-115 scrap bot not seen for a day; then held items in `sell` on such a backpack.tf
  order; the order's own book when that is watched; then (0.8, H8) held items whose advice says refresh first
  (`HoldingAdvice.refreshFirst`: the revenue order unseen for 24 h, or no eligible order and neither an order change nor
  a snapshot for 24 h), most cost first, added by their base when they have no revenue order: ordering only), then
  the oldest snapshot as before. An order a name snapshot of
  the row's item cannot return (a generic any-effect order filed under another base, outside the item's book twins)
  gives no pick: snapshotting the effect name confirms nothing and would take the slot every 30 min; such an order is
  confirmed by the live feed only. Every pick still skips a cooling-down or under-30-min-old base and a base whose
  last background snapshot returned under 30 min ago (`lastTried`, per process: a cached answer stamps nothing).
  The ranking is read at each pick, so the most profitable unconfirmed row is served first; package G2 retired the
  engine's FIFO confirm queue (`EngineDeps.confirmOrders`), which served its 50 entries ahead of the ranking and,
  when full, dropped the most profitable of a burst. Watched bases only, and the job needs an access token: a rule
  candidate on an old order waits for the live feed or Refresh from backpack.tf. Same job, cadence and budget, watched
  SKUs only: only the order changed. 0.7.4 (F51): bp.tf returns at
  most `SNAPSHOT_SIDE_PAGE` (30) listings per side, best first (`SnapshotResult.sides` counts the raw rows); a full
  side deletes stored orders it lacks only inside the range the page covered, with a 1% band at its edge
  (`snapshotPageDeletes`), so deeper live orders stay with the feed and the 14-day purge. A short side is the whole
  book, as before. 0.7.4 (F23): a snapshot row keeps the stored feed row's ban flag and names, but its online flag
  only from a feed row (origin 'ws') whose last event is within `ORDER_CONFIRMED_MS`; the snapshot stamps the row as
  seen now, so a row a snapshot already stored never passes the flag on (a carried flag lasts until the next
  snapshot at most; a feed event sets it afresh).
  0.7.4 (F09/F14/F49): a name snapshot is the whole book of every base of the item (`bookBasesOf`, "Book twins"
  below), so the reconcile (whole side or F51 page) runs for each twin base, the rows kept are the group's, each
  twin's snapshot time moves with the base's (the job does not fetch the same name again for a watched twin), and
  the log line counts the listings over the group. 0.7.4 (F18 guard): when a side's mapped rows all key to bases outside
  the group (mapper drift: every row of a name snapshot is the requested item), that side is not reconciled and a
  warning names the SKUs, so a misread can no longer empty the real book. 0.7.4 (F74): a kit or tool SKU without its
  target (`SchemaService.isTargetlessTool`) is left out of `watchedSet`, never queued (`queueSnapshot`, so
  `prices.upsert` queues nothing for it), and `item.refresh` answers "This tool names no target
  item; backpack.tf has no listings for it." The watch list is re-read once the schema has loaded at start.
  0.7.4 (F52): an `HttpStatusError` with an unavailable status (`isUnavailableStatus`: 500, 502-504, 52x, 530) is a
  global failure for `snapshot-watched`: the budget is paused by then, so the job waits and the SKU gets no 30-min
  cooldown. So that one name that keeps failing cannot take every slot once the pause ends, such a base goes behind
  every other stale candidate for 30 min (`lastUnavailable`, per process; taken only when nothing else is stale), and
  a second unavailable answer for it after another base's book was fetched in between cools it down like a 4xx (the
  name fails, not the host). A real outage cools no base down; still one request a run at most, none while paused.
- The folder watch is reported as an error when fs.watch fails and is retried about once a minute. A file the
  service died importing (repo meta `import.watchImporting`) is skipped once at the next start. From 0.7.1 (P3) it
  starts only once the item schema has loaded, and reports `WATCH_WAITING_FOR_SCHEMA` ('Waiting for item data to load')
  until then (`scraptf.listStatus`, Data health; the dashboard shows it as a muted wait, `listSetupState` 'watch-waiting');
  it starts on the next 10 s status tick after the load, and its catch-up scan imports the pages saved meanwhile: its
  start is fixed when the watch begins waiting (DC-4), so an import between the load and that tick (a window read, a
  page picked by hand) does not skip them. 0.7.4 (F82): the catch-up scan passes over a file modified more than
  `FUTURE_MTIME_SLACK_MS` (2 min) ahead of the clock, with a warning in the log: it would stay at or after every
  start's threshold and be imported again each time; a watch event still delivers it, and the import stores it as no
  bank stock save (F18 page time).
- Generic "any effect" unusual buy orders (`<defindex>;5` without `u`) are eligible exits for every effect of
  that item, flagged `any-effect`.
- **Book twins (0.7.4, F09/F14/F49/F73, F08).** A backpack.tf buy order is one per buyer and full name (its id is
  md5 of the name) but keeps the defindex of the document its maker sent, so one item's book is split across
  defindex twins: the stock weapon and its Upgradeable copy (18/205), the class shotguns and pistols, promo,
  Genuine-only and autogrant copies (160/294, 810/831), the duplicate Name Tag 2093, a skin-specific weapon and the
  plain weapon of its paintkit (15000/201), War Paint 9536 and its paintkit's own War Paint, crates of one name (the
  series stays), a kit's or fabricator's target (td-18/td-205). `SchemaIndex.bookTwinDefindexes` names them (same
  item_name and item_class; never kit tiers, targeted tools, retired keys or a skin of another paintkit) and
  `SchemaService.bookBases` adds an unusual skin's quality forms and (0.7.4 review R19) a strange skin's or War
  Paint's Strange 11 and Decorated-15-plus-strange forms, the 11 one canonical. A target is twinned only with
  targets a SKU can hold (R17): the Upgradeable Bat's twin, the stock Bat (defindex 0), is no td-, so a Bat kit,
  Bat kit fabricator or Bat strangifier keeps its own book, never the targetless tool's. A targeted strangifier and
  a Collector's Chemistry Set are twinned across every defindex of their item_name (R18,
  `SchemaIndex.toolBookTwins`: 6522 with 5661 and the other named strangifiers, td- kept; 20006/20007 with 20001
  and the other chemistry sets, od-/oq-14 kept), keyed by the parser's defindex (6522, 20006, or 20007 for a
  festive output); kit and fabricator tiers stay apart, and a snapshot order under such a twin defindex takes the
  requested output (`listingFromSnapshot`). Every book read goes through
  `src/service/domain/bookTwins.ts` (`bookBasesOf`, `mergedBook`: twin rows filed under the base read, so
  `dedupeOrders` counts a buyer once): the engine, the Live market, Holdings, `buildItemDetail` (so the Live check
  too) and `previewRule`. `markDirty` of a base marks its twins. Rule rows only go on the canonical base
  (`bookBase`, the resolver's `pickDefindex` choice) and never beside a price of yours on a twin. Stored SKUs
  (prices, saves, the journal) are never rewritten; listings keep the defindex bp.tf sent. The snapshot reconcile
  covers every twin (Snapshots above). References (F09 step 4): `lookupReferences(repo, base, schema)` fills a
  source a non-canonical twin base (811;1, 833;14, 18;11;australium) has no row of from the canonical base's row,
  the copy PriceDB and backpack.tf price the name under (engine, Live market, Holdings, Live check, the drawer).
  Local reads only.
- Main pushes `service.state` (starting/ready/restarting/stopped), `ui.openItem` (notification click, or the
  quick-entry window's or the check popup's `app.openItem`), `ui.quickPrefill` (`app.showQuickEntry` with a SKU, and
  from 0.5 an optional price text; held until the quick-entry page has loaded, and by the preload until it subscribes)
  and `ui.checkShow` (the live check popup's result, F16; held the same way, the latest wins). The service pushes `opps.changed`, `status.changed`, `import.done`, `prices.changed` (any price or rule write, so
  every window's price sheet refreshes), `market.changed` (the Live market index, see below), `journal.changed`
  (after `journal.add`, `journal.update` and `journal.delete`, see Holdings), `scraptf.listChanged` (the saved scrap.tf list, see F14),
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
  the highest integer cost that is still 'profitable' by `flipProfit` (0.8: after friction and the price-move
  reserve). Rows from 0.1 read NULL until the engine's start-up sweep
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
  `pruneBankStock` and its orphan sweep; V11 broke this once and V12 repaired it, below), backfilled from
  `bank_stock`. The save lists read it, so they cost per kept save, not per stored row or per import batch ever
  written (`import_batches` is never purged).
- Schema V9 (F21) adds `import_batches.origin` (see "The scrap.tf window (F21)", S3). Schema V10 (0.7.1) adds the
  index `idx_import_batches_bank_saved` on `import_batches(bank, (CASE WHEN file_mtime > 0 THEN file_mtime ELSE
  imported_at END))` behind `Repo.bankNewestSaves()` (each bank's newest non-empty save over all batches, DM-7). The
  expression is a save's time as `batchSavedAt` and repo.ts `BANK_STOCK_SAVED_AT` read it (`file_mtime` is NOT NULL
  and 0 means unknown, so `COALESCE` would never fall back), and a query must repeat it exactly for SQLite to use the
  index. No table or column changes.
- Schema V11 (0.7.2) deletes the killstreak kits an import stored without their target weapon (SKU `6527;6`,
  `6523;6` or `6526;6`, optionally followed by more `;` tokens, with no `;td-`: every kit of a tier shared one SKU and
  one price): their `source = 'import'` rows in `scrap_prices` (a typed price stays) and all their rows in
  `bank_stock` and `scraptf_events`. A kit with its target (`td-`) stays. V11 left the `bank_stock_saves` entries it
  emptied in place. Schema V12 (0.7.2) runs V11's deletes again (a /buy/killstreaks look made before the parser read
  real kit cards had stored them again), then sets `import_batches.item_count` to 0 for each batch whose save has no
  `bank_stock` rows left, deletes those `bank_stock_saves` entries and recounts `items` on the rest, so the Banks page
  and the coverage strip (`Repo.bankNewestSaves`, `item_count > 0`) read an emptied bank as never saved, not as N
  items. Only V11 and V12 can leave a save without rows. Schema V13 (0.7.3) covers the killstreaks looks that stored
  prices but wrote no bank stock save (a partial look DM-2, an unsettled window snapshot ACT-4, a file import from
  before 0.6): such a batch with no `scrap_prices` row tagged with it any more gets `item_count` 0, so it no longer
  dates the bank with the deleted kits' count. Only where a batch count can still date the bank (killstreaks has no
  `bank_stock_saves` entry at all; with one, the newest save dates it) and only for a batch newer (by its save time,
  then id) than every killstreaks batch that still has a price: a later look re-tags the rows it shares with an
  earlier one, thinning drops older saves and a sale deletes prices, so an older look with no price tagged to it is
  still real and keeps its count. Killstreaks only: an /items list took over other banks' plain rows under its own
  batch id too (until 0.7.4). Schema V14 (0.7.4) removes everything a scrap.tf/items read stored before rows read their
  craftability (every unmarked row was stored as the plain Craftable copy; a stored row cannot tell which copy it
  priced): the `source = 'import'` prices of every `page_kind = 'items-list'` batch (typed prices stay, "Use as my
  price" copies included), every `scraptf_list` row, and the 'list' bank's `bank_stock` rows, `bank_stock_saves`
  entries (the pre-0.7.1 save whose rows all had no stock, read as on sale, among them) and `scraptf_events`; then
  `item_count` 0 on every items-list batch. It adds `scraptf_list.craft TEXT NOT NULL DEFAULT 'any'` (F14) and
  `key_prices.price_at INTEGER` (nullable). Opportunities need no SQL: the engine's first full run at start drops the
  ones whose price is gone. The user reads scrap.tf/items once more to rebuild the list (README, the Import page's
  note). V11, V12 and V14 are the only migrations that delete stored data, and V12, V13 and V14 the only ones that
  rewrite stored counts. Schema V15 (0.8, `V15_ROUND_080`) only adds: the nullable `journal.fee_keys` and
  `journal.fee_scrap` (J2) and the tables `scraptf_watches` (G1) and `holding_marks` (H1) with their indexes; it reads
  and rewrites no row ("0.8 round", Schema V15). `SCHEMA_VERSION` is 15, so an older build opening a 0.8 database
  fails with SchemaVersionError (the data-too-new screen above).
- `shopping.list` and `opps.exportCsv {kind:'shopping'}` are built from the stored opportunities: one row per SKU with a
  ceiling above 0 and buyers; when a SKU has several inputs, the one with the highest confidence wins, and ties go to the
  higher ceiling. Between typed or imported rows the next tie-break is the newer row, then, among copies seen at one
  time (a look stores a kit once per sheen/killstreaker combo), the cheaper, then the higher price id, as the Live
  market's `knownAt` (0.7.3); the known price when a rule sets the ceiling follows the same order. The known cost is
  that row's own when it is typed or imported, else the newest typed/imported one, and `underCeiling` compares it only
  with its own row's ceiling (`knownMaxCostScrap`): painted, spelled and plain copies share a SKU. The scrap.tf bank-page
  URLs are only passed to `links.open` (the user's browser), never fetched (R1). From 0.7.1 (ACT-9) every row carries
  `knownObservedAt` (the known row's input time), `knownStale` (the known row carries the engine's `stale-input` flag:
  older than `profit.inputStaleMs`) and, on `shopping.list` only, `knownStock` (the stock scrap.tf showed with the
  price behind the known row, `opts.stockOf`, one `getScrapPrice` per returned row; null for a typed price). The
  dashboard counts only fresh known prices as at or under the ceiling. 0.7.4 (F22, F70): a known row flagged
  `variant-suspect` or `cost-below-market` (`costSuspectFlagged`, shared/ceiling.ts) sets `knownSuspect`, and the
  dashboard neither counts nor colours it as at or under the ceiling (its tooltip says it is probably another copy's
  price); `underCeiling` and the CSV keep the plain comparison. Mirrored in the mock. From 0.7.4 (F36) a row's `bankPageUrl` is the
  bank page a save last listed the item on, else the bank its kind is sold on (`opts.bankOf`, core: the in-memory
  `MarketIndex.bankFor`; the category's page when absent or failing), and a group header links one page only when
  every row in it opens that page (`mixedBanks` otherwise: the header says "on several pages" and `o` on it opens
  nothing; each row keeps its own). The CSV's `bank_page` follows the row.
- Copies and totals (0.7.4, F66, F27, F33). Imports store a painted hat or a kit's sheen/killstreaker combo under
  the plain SKU with the extras in `ScrapPrice.special`, one row per copy. `Opportunity.copyKey` names the copy
  (`opportunityCopyKey` in `src/shared/copyExtras.ts`: the copy's `bankStockSpecialKey`, the SKU's paint moved in;
  absent for a plain copy or a rule). It is derived on every read (repo `OPP_SELECT`: one rowid seek into
  `scrap_prices` per row) and by `explicitInput`, never stored, and `materiallyEqual` ignores it. Opportunities shows
  it as a tag beside the name (`copyLabelOf`: "Noble Hatter's Violet", "Team Shine, Fire Horns"; 0.7.4 review R30:
  without a paint the row's SKU already shows as a chip, and a hover that says each copy is priced against the
  buyers who take it), the drawer's input
  card title and "other copy" hover name it (`inputCardLabel`, `otherCopyName`), and a row opens the drawer on its
  copy (`openItem(sku, copyKey)`), whose scrap.tf history reads that copy. Copies of one base priced against one
  revenue order (`revenueOrderOf`): every copy after the most profitable (ties by key) is flagged `shared-buyer`
  (`markSharedBuyers`, the engine per base and the mock), since the buyer may take only one. Each row keeps its own
  profit; the group totals count each item's revenue order once per group, at the best copy among the rows the
  query matches (0.7.4 review R27: `onceByOrderProfit` in `copyExtras.ts`, the `opportunityGroupStats` SQL with
  `useOrder`, views and oppModel `summarizeGroups`; over every copy that is adding 0 for each `shared-buyer` row, and
  a filter that hides the best copy counts the next one, not none), and the summary bar's "together" counts one
  profit per revenue listing over every loaded
  profitable row (`profitableTotals`, so a generic order shared by several items counts once too), with "(N copies
  share a buyer, counted once)".
- `item.detail {history:false}` skips the PriceDB history request, so quick entry's live preview is local only.
  `ItemDetail.revenue` uses the engine's pricing over the same book (including generic any-effect orders), with the same
  reference gate, so the drawer, quick entry and the opportunity row agree. The drawer classifies the book against the
  newest stored copy's extras; quick entry asks with `target:'plain'`, a clean copy of the SKU (paint from the SKU
  only), because that is the row its `prices.upsert` creates. Prices are stored under the base SKU with the paint in
  their extras, so a painted SKU's `scrapPrices` are the base SKU's rows of that paint (plus rows stored under the
  painted SKU itself); a plain SKU still lists every copy stored under it. The drawer's price form offers and updates
  only this copy's typed prices (`priceIsForSku`, as Record buy uses); other copies' price lines are marked "other
  copy" (0.7.3).
- Price writes (0.7.3). `prices.upsert` keeps omitted fields on an update of the same item. A row moved to another
  base SKU keeps its id, but an omitted `special`, `assetId`, `stock` and `importBatch` are reset to null, as on a new
  price, and both the old and the new base SKU are re-evaluated. The Prices page's Add/Edit form, like the drawer's,
  always saves a typed price ('user'), so an imported price edited by hand there leaves the import's control; only
  "Mark as seen now" keeps the row's source.
- Steam Market (`item.scm`, 0.7.3): it returns null only when the Steam Market check is off. A failed lookup (a 429
  and the 6 h lockout after it, an HTTP error, a paused network, a blocked host) is an RPC error naming the cause,
  never an all-null reading. Steam's own "no listing" answer is still a reading with no prices.
- Reference age (`profit.referenceMaxAgeMs`, default 30 days): a PriceDB price whose `ageMs` is older, or a community price
  whose `lastUpdate` is older than max(that, 365 days), counts as absent for the outlier rule and for confidence, and the row
  is flagged `stale-reference`. Community prices are hand-set and stay right for months, hence the one-year floor.
  Suspect margin (`profit.suspectMargin`, default 2, 0 = off): a margin above it with fewer than 3 eligible orders and no
  usable reference is flagged `suspect-margin`, capped at Low (44) and never notified.
  Cost checks (0.7.4, F22 and F70; `costSanity` in `src/shared/ceiling.ts`, shared with the mock): the references above
  check the buy order, so nothing checked the cost. With a usable (age-gated) PriceDB price of the item, a typed or
  imported cost under 0.9x the low end of its PriceDB band and within 10% of its craftability twin's band
  (`craftabilityTwin`: 5040;6 and 5040;6;uncraftable; the twin's PriceDB row is age-gated too and read only when the
  cost is that far under) is flagged `variant-suspect`, the reason naming the twin's craftability; else a cost under
  0.95x its PriceDB buy price by 1 ref or more is flagged `cost-below-market`. Either caps the row at Low and blocks its
  toast, like `stale-input`. PriceDB only (community prices are hand-set and often a year old); rule estimates, free
  items and the Live market's buy side (no cost) are never checked. A cost above the item's band is normal markup.
- Revenue picks and buyer liveness (0.7.4; `computePrices` and `scoreConfidence`, so the engine, `item.detail`, the
  Live market, Holdings and Live check agree). An order with no feed event or snapshot for 24 h stays eligible and
  'unverified' (brief §2.1), but when any eligible order is verified, Conservative and the outlier median come from
  the verified orders only; Best stays the overall top order (still flagged). With none verified, Conservative is
  picked as before (the row is capped at Medium and never toasted). Verified orders are preferred, not exclusive:
  when every verified order is an outlier (one fresh order over 1.5x PriceDB's sell price on an older book),
  Conservative is the top non-outlier unverified order, as with none verified (still flagged, Medium at most, never
  toasted), so the book is not 'all-outliers' and prices as it would without the fresh order (package G2; the mock's
  `mockPrices` alike). Instant never picks an unverified bot order, so
  "no realistic bot order" includes "none seen in the last day". A zero-valued order ("0.05 ref" weapon-priced orders
  round to 0 scrap, F19) is left out of the median and never called an outlier. Confidence gives "+5 Buyer is online"
  only while the order's last event is within `CONFIRMED_MS` (2 h; the flag is as old as that event) (0.9, #11: no
  longer added; the flag was true on every captured event, RESEARCH §4.2), and counts
  only verified orders (and the order itself) as buyers within 10%, never around a zero price. The renderer's
  online dots and "Sells for" lines say "last seen N ago" past 2 h (`buyerPresenceText`, `src/shared/buyerSeen.ts`),
  and Opportunities and the drawer headline mark an unverified revenue order with a warn clock and its age.
- Key price age (0.7.4, F71). backpack.tf's IGetCurrencies key price is its community price, which can stand for weeks
  (the audited one was last changed 72 days earlier) while the quote is fetched hourly. A quote keeps `observedAt`
  (the fetch, or PriceDB's price time: what the 6 h stale gate reads, unchanged) and `KeyPriceQuote.priceAt`, when its
  source last changed the price (`parseIGetCurrencies` reads `price.last_update`; PriceDB its price time; stored in
  `key_prices.price_at`, V14; NULL and an old row read as absent). `selectKeyPrice` keeps the documented priority
  (backpack.tf, then PriceDB, brief §5.3) and adds `KeyPriceState.priceAt` (the chosen quote's) and `divergence` when
  another fresh automatic quote differs from the chosen one by `KEY_PRICE_DIVERGENCE_SCRAP` (9, 1 ref) or more (never
  in manual mode, never against a stale quote). The value, and so the engine's fingerprint, never depends on either.
  The top bar adds "set 2 mo ago" once the price is an hour or more older than its check, and a warning icon and line
  for a divergence (`keyPriceNotes`); Data health's table adds a Price set column.
- Notifications skip input kinds missing from `notifications.inputKinds`. Rule candidates are titled `Candidate: <name>`,
  others `Profit: <name>`, and the body adds the ceiling when there is one. 0.7.4 (F66): a copy with extras is
  named by its first two (`Profit: The Last Laugh (After Eight)`, the Opportunities tag's words: shared
  `copyExtrasWords`, the paint's name from the item schema). Main's `notify.ts` checks and clips the payload and passes `notifications.silent`.
  From 0.6 the payload may carry `openUrl`, kept only when it is exactly a `SCRAPTF_BANKS` page and checked again when
  the toast is clicked (F20, "Notification links" below); a bad one costs the toast its link, never the toast.
  From 0.6 an imported opportunity whose item a "New on scrap.tf" notification named in the last 30 minutes (F17) is
  recorded as notified without a toast of its own (`EngineDeps.toldElsewhere`), so one find makes one toast.
  Copies stored under one SKU (a kit's or killstreak weapon's sheen/killstreaker combos, painted or spelled copies)
  make one toast, the most profitable copy's; the other copies are still logged as notified and recorded as told, and
  the "N more" summary counts items, not copies (0.7.3).
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
  From 0.7.4 (F36) the bank is the one an item of its kind is sold on (`scraptfBankForItem`, below the bank table),
  so a strange cosmetic is judged by a /buy/hats save and a killstreak weapon by a /buy/items one. An australium
  (DC-5; 0.7.4, F79) only when both its category's page and the items bank, which sells australiums, were seen whole
  within `profit.inputStaleMs`: one fresh page alone is no proof it is off sale.
  From 0.7.4 (F13, F21, F47): a row whose revenue order (`revenueOrderOf(opp, useOrder)`) is 'unverified' (no feed
  event or snapshot for 24 h: it may have been filled or removed while the app or the feed was off, and the feed has
  no catch-up) is not toasted and not recorded, so it toasts once a snapshot or feed event confirms the order; core's
  `snapshotPriority` ranks its stored row for the background snapshot (Snapshots above). Holdings' "Sell:" toast
  holds a backpack.tf exit on such an order the same way (Holdings, Notifications). The "New on scrap.tf" toast (F17) skips such a row the same way
  (`notifyNewBankFlips`, the row's `revenueOrder`), leaving the import to the engine's "Profit:" toast once confirmed.
  `variant-suspect` and `cost-below-market` rows are never toasted either: the engine's own flags, and for the "New on
  scrap.tf" toast and the window's page flips the same check on the card's price (`BankStockDeps.costSuspect`, core:
  `bankStockCostCheck`, 0.7.4 review R14/R40). The Live log's buyer tag says
  "(bot, last seen 4 d ago)" for an order past `ORDER_CONFIRMED_MS` instead of a frozen "online".
  In main (F16) the clipboard watcher's "Flip:" notification is sent only while `check.popup` is off, so one check
  makes one alert.
- `buyer.check` runs only on a click. It sends one users/info request on the `bptf-users` budget at user priority: it waits at
  most 15 s for a slot and then times out after 12 s, inside main's 30 s RPC timeout. From 0.7.3 a wait that times out
  behind another request to the same host (the shared api.backpack.tf gate) raises `RateLimitedError` with `busy:
  true`, whose `retryAt` is only the time of the failure: the drawer and the Settings tests then say backpack.tf is
  busy instead of giving a retry time. It needs the access token and the
  backpack.tf API switch, and it refuses while the network is paused or the host is blocked. Successful answers are cached
  in memory for 1 h (at most 500), and served even while paused. Failures are not cached.
- `prices.parseBulk` writes and fetches nothing. A paste containing `<` or `scrap.tf/` is refused as a whole, so it cannot
  route around the opt-in saved-page import (R10). So is a paste over 500 lines or 100 KB, and any item line before the
  schema has loaded (the error says it is still loading). A row carries a `sku` only when it can be saved: fuzzy names, incomplete SKUs and zero prices are
  errors. A repeated item stays saveable, and the dashboard keeps the last line. `prices.bulkUpsert` writes at most 500 rows
  as whole typed prices (source 'user') in one transaction, with one `prices.changed` push.
- Backups: `prices.exportCsv` is a record of the price sheet, not a backup (0.7.4, F81). The `sku` column includes
  the paint and `cost` uses the `parsePrice` format, so those two columns paste back into bulk paste, but only as
  typed prices dated now: the source, the date and the extras are not restored, an import pasted back is no longer
  retired by a later bank save, and the copies of one SKU (a kit's sheen/killstreaker combos) collapse into one line.
  Every copy's extras are written all the same, with `sheen`, `killstreaker`, `name_tag`, `description_tag` and
  `copy_key` (`opportunityCopyKey`) appended after the older columns. `rules.exportJson` writes `{ format:
  'tf2-flip-desk-rules', version, exportedAt, rules }`, version 1 unless a rule uses the Festivized or Elevated
  Strange filter (0.7.4, F79: then 2, which a build before them refuses instead of importing a broader rule).
  `rules.importJson` validates each rule with `ruleInputSchema` and reads versions up to 2. It skips rules that are
  already stored or repeated (same name, filter and price), each with a reason. It never deletes, and it caps a
  future `observedAt` at now.
- Rule filters (0.7.4, F79). `RuleFilter` adds `festive` and `elevated` (quality2 11, a "Strange" on another quality)
  tri-states beside `australium` (`ruleFilterSchema`, the repo's stored-filter schema, `ruleMatches`, the mock's
  `ruleMatches`, `describeRuleFilter`; unset or null means either, so stored rules and older backups keep their
  meaning). The editor (`RulesPanel.tsx`) shows both, and a new rule starts from `NEW_RULE_FILTER` (unique craftable
  hats with no effect, not australium, not festivized), so switching it to stranges or weapons does not price Strange
  Australiums or Festivized copies at a plain weapon's price; existing rules keep what they were saved with. A rule
  never undercuts a price scrap.tf showed (F78, F14 "Engine" and the Live market's rule estimate).
- Server waits survive restarts too (R7): budget pauses and 429 streaks are repo meta `net.pauses`, and the
  websockets' waits after a refused upgrade (with their 429 streaks) are `bptf.feedRetry` and `pricedb.socketRetry`.
  socket.io hides the PriceDB upgrade's headers, so a 429/503 there backs off 60 s doubling to 15 min, and 1 h after
  three 429s in a row. A restored wait is clamped to 24 h and the
  clamped value is written back, so frequent restarts cannot stretch it. Challenge or refusal stops of the
  websockets (`ws.backpack.tf`, `ws.pricedb.io`) are host blocks in `net.blockedHosts`, cleared only by the user.
  While the service runs (0.7.3), grant times recorded on a wall clock that has since moved back count as now, and a
  pause keeps at most its own length from the moment the step is noticed, so spacing, windows and pauses still hold
  in elapsed time (R7) and never stop requests for as long as the clock moved back.
- Unavailable answers (0.7.4, F52). `http.ts` treats 500, 502, 504 and Cloudflare's 520-527 and 530
  (`UNAVAILABLE_STATUSES`, `isUnavailableStatus`) like a 503: the budget pauses for the server's hint (Retry-After,
  a body `retry_after`) or else the 60 s doubling backoff, with the pause reason `HTTP <status>`
  (`BudgetScheduler.recordUnavailable(ms, now, status)`, 'HTTP 503' by default as saved pauses read), and the answer
  neither counts toward nor ends a 429 streak, per budget or per host. Before, they counted as a success: an outage
  was polled at the budget's spacing and a 502 between 429s reset the 1 h escalation. 501 and the 4xx still end a
  streak, and only an HTML 403 or 503 disables a host (a Cloudflare 52x page reports a broken origin, not a challenge).
  The same set makes such an answer a global failure of `snapshot-watched` (no per-SKU cooldown, though a name that
  keeps failing while others succeed rotates behind them and then cools down, Snapshots above) and PriceDB's REST
  health `backoff`, not `error` (display only). A caller may mark a 5xx whose parsed body answers its one request
  (`HttpRequestOptions.isAnswer`; never a 429 or a challenge page): such an answer counts as a success. The only one is
  Steam Market's priceoverview, whose 500 `{"success":false}` means no listing under that name
  (`unknownItemAnswer`), so one unknown name no longer pauses the scm budget, persisted, for every other item.

## Live market index (F10, `src/service/domain/market.ts`)

The Live market page lists every base SKU with at least one eligible backpack.tf buy order, plus every base SKU the user
has a scrap.tf price for, and compares the two sides live. It adds **no network traffic**: it reads the local book that
the backpack.tf websocket (and snapshots) already fill. The scrap.tf side is only what R10 allows: typed prices, rules and
saved pages. Nothing here fetches or polls scrap.tf (R1).

- **Entries.** One in-memory entry per base SKU with an eligible order, valued as an opportunity on a clean copy
  (`evaluateMarketBase`): `priceBook` (dedupe, classify, value, outliers), `itemRevenue`, `maxCostFor`, `bookFlags`,
  and (0.8, PC-2/H2) `nextBuyer` / `verifiedBuyerCount` (`buyerDepthOf` over `exitOrdersOfBook`). An
  effect-specific unusual also reads the generic `<defindex>;5` book, as the engine does. Buy-side confidence is
  `scoreConfidence` with a fresh typed input and `margin: null`, so input age and the suspect-margin guard play no part
  (a free item would otherwise read as an unbounded margin and be capped at Low). An entry is dropped when its last
  eligible order goes. An effect SKU bought only through the generic book has no buy orders of its own to enumerate, so
  it is listed only while the user has a price for it (the engine has the same limit).
- **One row per book (0.7.4, F09/F14).** A book filed under defindex twins (Integration "Book twins") is one entry, on
  its row base (`rowBaseOf`): the twin carrying a price of yours (the canonical one first), else the canonical base;
  every other twin has no entry and no known-only "no buyers" row. `entryFor` answers for any twin, so Holdings, bank
  stock and the Live check find the row from the base they hold. A mark on a base re-reads all its twins. The row
  shows the newest price of yours across every twin of its book (0.7.4 review R29, `rowKnownAt`: `knownAt` per twin,
  the newest, at one time `knownAt`'s tie rule), so a price stored under a twin is that row's, as the engine prices it.
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
  copy). Of several prices seen at one time the row shows the cheapest at the read's K (`knownAt`); from 0.7.4 (F40)
  equal costs go to a copy without extras, then the higher id, so a plain copy at a painted or parted copy's price is
  the row's price and stock (as the drawer's `bankStockItemOf`) with no `has-extras`; kits, every copy with a sheen,
  still tie on the id. The rule estimate is the cheapest enabled valid rule that matches (`ruleMatches`, `validRule`), cached per
  base. The cache is dropped only when the rule list or the key price really changed (not by `markAllDirty`); an
  estimate also remembers the name and category it matched, so a renamed or recategorised item is matched again alone.
  From 0.7.4 (F78) the estimate is never under a price scrap.tf showed the plain copy at (`boundRuleCost` over
  `MarketIndexDeps.scraptfSeenPriceOf`, the engine's own hook, read per rule-matched row, not cached): such a row's
  `ruleCostScrap` is that price and it carries `rule-under-scraptf`, so its verdict agrees with the Opportunities rule row.
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
  changed its revenue, ceiling, buyer count or revenue order id, or (0.7.4 review R11) its revenue order turned
  verified or unverified at the same price, so Holdings re-checks a "Sell:" held for an unconfirmed order and the
  row's clock mark updates. Main forwards it like `opps.changed` (it is in
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
  0.6) keeps the batch-based date. 0.7.3 (migration V13): in a killstreaks bank with no stock save, a batch left with no
  price after the bare-kit cleanup (V11, V12) and newer than every batch that still has one counts no items, so it no
  longer dates the bank.
  The list counts for no page (the saved list has its own "All items" chip, F14). The
  fallback reads the categories a batch stored when imported (`ImportBatch.categories`), because a later import
  rewrites the rows it shares in place under its own batch id (a later look of the bank; an /items list did so with a
  bank page's plain rows until 0.7.4);
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
  nothing. 0.7.4 (F38): a sale closes the oldest buy dated at or before it; a sale with none (an item owned before
  the app, a buy not recorded) is a waiting sale (`JournalSummary.waitingSales`, oldest first) and never consumes a
  later buy, which is another copy: before, it did, and the copy the user held left Holdings, the watch list and its
  "Sell:" alerts (and every later flip of the item shifted by one). A waiting sale counts as neither profit nor a
  holding; recording its buy dated before the sale matches it. Holdings and the Journal page say how many there are
  (`waitingSalesText`), and the Journal page lists them with "Record its buy" (Record buy dated a minute before the
  sale, `waitingSaleBuyInit`). The Record sale comparison compares a sale dated before the open lot with no lot.
  0.8 (J2, H5): a lot's cost basis includes its buy's recorded fee (`JournalLot.keys`/`scrap`, so `nextLotKeys`,
  `nextLotScrapRaw`, `nextLotCostScrap` and the Record sale preview include it), a write-off closes a lot like a sale
  that receives nothing, and each row carries the user's `typicalHold` (`typicalHoldOf` over the same read's
  `closed` and every open position, `withTypicalHold`; absent with too few sales), worded by `typicalHoldText` in the
  Held for tooltip as the user's habit, never a forecast.
  0.7.4 review (R25): rows at the same time go buys first (`journalOrder`, the mock alike), so a buy dated exactly at
  a sale is "at or before" it: the dialog keeps minutes only, and a sale and its buy logged within one minute used to
  leave a waiting sale beside a phantom held copy.
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
  as profit, a loss or a "Sell:" (the Record sale dialog compares with the same next-lot cost; 0.7.4 review R23: for a
  backfill it nets the sale against `HoldingRow.nextLotKeys`/`nextLotScrapRaw`, the next lot's own currencies, at
  the *Key price then*, as the journal books that pair). From 0.7.3
  `positionCostAt` (`lotCostAt` summed over the lots, or the stored total when `lots.length !== qty`) is the one rule
  `holdingRow` and the Journal page's Holding total and Still holding use for a held position's cost;
  `JournalPosition.costScrap` stays the buy-time cost.
  `profitNowScrap = revenue - next lot cost - friction`, `profitAllScrap = revenue x qty - total cost - friction x qty`,
  `margin = profitNow / next lot cost`. No price-move reserve: a sale into a live order has no price move left to
  cover (0.8, PC-1). 0.8 (H2): rows carry the market entry's `nextBuyer` and `verifiedBuyerCount`; the Buyers hover
  (`holdingBuyersTitle`) says what the next buyer pays. The status is `profitStatus(profitNow, next lot cost, settings.profit)` mapped to
  `sell` (profitable), `hold` (below threshold), `loss` or `no-buyers` (no exit at the chosen revenue pick: no eligible
  order; every eligible order an outlier, the row carrying 'all-outliers'; or, with useOrder 'instant', no realistic
  bot order; the renderer tells these apart from the row's `buyerCount` and flags, `holdingsModel` `noSaleReason` /
  `holdingStatusHelp`, 0.7.3; Quick entry and Record buy read the same three ways, "No usable buyer" when eligible
  orders exist but none is usable, `quickModel` `noRevenueText`). Rows sort by status in
  that order, then profit now descending, then name. Totals cover everything held whatever the search; worth now and
  the unrealised P/L (the sum of `profitAllScrap`) count only rows with a revenue; `sellable` counts `sell` rows.
  0.8 (H6, D11): the status pills read *Clears target*, *Below target*, *Loss* and *No buyers* (until 0.7.4 *Sell now*
  and *Hold*): they say where the thresholds stand, and the new *Advice* column (*Sell now*, *List and wait*, *Hold*,
  *No clear signal*, `HoldingRow.advice`, see the 0.8 round) says what the book and the recorded exits support, so a
  row never shows two answers that contradict each other. Rows also carry the copy's ask side (`ask`, H3), the age-gated
  references (`refs`, H4), the last snapshot (`snapshotAt`) and the next lot's key price then (`nextLotKeyPriceScrap`).
- **RPC.** `holdings.list` (`HoldingsQuery`, zod: search up to 200 characters, optional) returns `HoldingsResult`
  (`rows`, `totals`, `keyPrice`, `generatedAt`). `opps.exportCsv {kind:'holdings', holdings}` writes
  `flipdesk-holdings-YYYY-MM-DD.csv` with the columns sku, name, qty, cost, next_lot_cost, held_since, sells_for,
  buyer, profit_now, profit_all, status, confidence, and from 0.4 exit, exit_venue, scraptf_pays (money as "1 key 2.00 ref";
  sells_for stays the backpack.tf revenue, profit_now follows the better exit), and from 0.8 advice (the advice kind),
  next_buyer (the next distinct buyer's price, H2) and lowest_ask (the lowest matching ask, H3), appended so earlier
  columns keep their place. 0.8 (H7): `holdings.detail {sku}` answers one SKU's `HoldingDetail` for the item drawer's
  *Your holding & trades*: the row (advice included), the open lots, the SKU's closed trades (newest first, at most 50),
  the base's recorded exit runs (from a week before the oldest lot, or the last 30 days when not held; at most 500,
  `truncated` past that), their history and the user's typical hold. Local reads only.
- **Trigger path.** The market index's `fireChanged` hands the changed bases to `holdings.onBasesChanged`, which keeps
  only held bases (and the generic book of a held effect). `ctx.journalChanged` (after `journal.add`,
  `journal.update` and `journal.delete`) calls `journalChanged()`; `core.updateSettings` calls `settingsChanged()` when `settings.profit`,
  `blocklist`, (0.8) `ownSteamIds` or `notifications` changed, and `keyQuotesChanged` does on a key move of 1 scrap or more. Triggers are
  coalesced into one check `HOLDINGS_CHECK_MS` (250 ms) later; the timer runs only between `start()` and `stop()`
  (core calls them after the market index's), and a failed check is logged, never thrown. 0.8 (H1): while the
  backpack.tf feed is live (`HoldingsDeps.feedLiveSince`, core's `feedLiveSince`), each check also records what it saw
  for the held and watched bases in scope (`holding_marks`, see the 0.8 round), a 30-minute heartbeat
  (`HOLDING_MARK_HEARTBEAT_MS`) re-records every held and watched base, `onBasesChanged` takes watched bases too
  (`HoldingsDeps.markBases`, wired by alerts), `markBasesChanged()` records them from the next run, and `stop()` writes
  each open run's last sighting. Without the feed nothing is recorded and no heartbeat runs.
- **Notifications.** A check notifies a held SKU that entered `sell`, or whose `profitNowScrap` rose by
  `CHANGE_PROFIT_DELTA` (9 scrap) or more since its last notification while still in `sell`: title `Sell: <name>`,
  body `<buyer> pays <revenue> (<bot|human>), +<profitNow> over your cost`, `sku` set so a click opens the item. Gates:
  `notifications.enabled`, the new `notifications.holdings` (boolean, default true; Settings > Notifications has the
  switch), and `notifications.minConfidence` (an item that entered `sell` below it stays pending, so more buyers
  later still notify it once; from 0.4 it gates backpack.tf exits only, see F14). 0.7.4 (F13, package G2): a
  backpack.tf exit whose revenue order nobody has confirmed for 24 h (`unverifiedRevenue`: flagged 'unverified', or
  aged past `UNVERIFIED_AFTER_MS` since its entry was built) is not told and nothing is recorded, as the engine's
  "Profit:" toast: an entry stays pending and a rise keeps its old baseline, so it is told once a snapshot (core's
  `snapshotPriority` ranks held items to sell on such an order) or a feed event confirms the order. The market index
  counts a revenue order turning verified (or unverified) as a change (`moved`), so that confirmation re-runs the
  check even when the price is the same. A scrap.tf exit is not gated. 0.7.4 review: a backpack.tf exit held back
  (unverified, or below `minConfidence`) is told through scrap.tf instead when the row's saved list price is fresh,
  not full and clears the thresholds on its own (`scraptfAlternative`: the row judged on `scraptfPaysScrap` with
  `holdingFigures`); its profit is then the baseline, so the same figures never read as a rise, and a confirmed
  buyer paying 1 ref more later is told as one. `bestExitOf` still picks by value for the row itself. The "Sells now for" tip and a warn clock on
  the Holdings row say so (`HOLDING_UNVERIFIED_NOTE`, `UnverifiedOrderMark`). Main applies `notifications.silent`. Dedupe is per SKU for `notifications.dedupMs`,
  saved in repo meta `holdings.lastNotified` and expired by age (the engine's own records keep a fingerprint from
  0.7.1, see Integration), so a restart
  does not notify again. At most `MAX_NOTIFICATIONS_PER_RUN` (3) per check, then one summary ("N more held items to
  sell", `sku: null`). The sell state is tracked while notifications are off, so switching them on replays nothing.
- **Watched set.** `core.watchedSet()` is the base SKUs with a scrap.tf price plus `holdings.heldBases()` (open lots,
  currencies excluded; it never throws), cached and reset by `prices.changed` and `journal.changed`. Everything that
  reads the list keeps doing what it did, now also for held SKUs: the feed keeps their sell listings, the background
  snapshot job (`bptf-snapshot` budget, at most one watched SKU per minute when the budget has a free slot) keeps
  their book fresh (0.7.4: unconfirmed profitable rows first, then held items to sell, then (0.8, H8) held items whose
  advice says refresh first (`HoldingAdvice.refreshFirst`), most cost first and by base when they have no revenue
  order, then the oldest; with a large watch list it reaches the rest only slowly), and the `pricedb-watched` job (bulk, 100 per request, every 30 min) includes them. Same endpoints,
  same budgets, no new request kind. If the journal cannot be read while the list is built, it is built without
  the held SKUs until the next price or journal change.
- **Push.** `journal.changed {at}` after `journal.add`, `journal.update` and `journal.delete`. It is in `PUSH_EVENTS`, so the service host
  and the preload forward it like `prices.changed`. The Journal and Holdings pages refetch on it (300 ms throttle,
  only while visible). Holdings also refetches on `market.changed`, `prices.changed` and `scraptf.listChanged` (2 s throttle, only while
  visible), when `settings.profit`, the blocklist or (0.8) `ownSteamIds` changes, and once when a scrap.tf exit's list
  row turns a day old (F14). 0.8 (H7): the drawer's *Your holding & trades* refetches `holdings.detail` on
  `journal.changed` (300 ms) and on `market.changed`, `scraptf.listChanged` and `prices.changed` (2 s), only while visible.

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
  confirmation toast's Undo calls `journal.delete`. 0.7.4 (F39): a When more than 10 min back (`BACKFILL_MS`,
  `isBackfill`) shows *Key price then* (empty: today's, its placeholder), and `checkTrade` sends it as
  `JournalInput.keyPriceScrap` (zod: whole scrap, 9 to 100,000), so a backfilled mixed-currency pair is valued at the
  key price of its day, not the day it was logged; the Journal page's form does the same. A trade logged now sends
  none and the service stamps today's, as before. While focus is outside the dialog (a toast's Undo or Dismiss took it
  and the toast went, leaving it on `<body>`), a capture-phase document listener still gives Esc (closes the dialog,
  never the drawer behind it), `Ctrl+Enter` (saves) and Tab (back into the dialog); focus landing anywhere behind it
  but the toasts is moved back to the price. From 0.7.3 an open tooltip claims Esc first (a window capture listener
  with `preventDefault`), so Esc closes the tooltip, never the dialog, the drawer or quick entry behind it.
  Entry points: the drawer (*Record buy*: venue scrap.tf and the newest
  scrap.tf price for that very copy, `priceIsForSku`: the SKU's paint, or no extras for a plain SKU, else no price (0.7.2: a sheen or killstreaker
  is not an extra, as in liveCheck `isOtherCopy`; of the prices left, `newestScrapPrice(prices, keyScrap)` takes the
  newest look's cheapest copy at the key price, equal costs to the higher id; market.ts `knownAt` from 0.7.4 first
  prefers a copy without extras, F40); *Record sale*: venue backpack.tf, the revenue order's price and `Sold to <buyer>`; *Record sale to this
  buyer* on each buy order), the ItemMenu (*Record buy…*, *Record sale…*, prefilled from `item.detail
  {history:false}`), and Holdings rows. 0.7.4 (F80): Quick entry's Save and the check popup's Save price send
  `prices.upsert` with `replaceTyped`: the service updates the user's newest typed price of the same copy (shared
  `priceIsForSku` and `newestTypedPriceFor`, `src/shared/priceCopy.ts`; its stored extras, asset id and stock kept; its
  price, time and note become the new one's, the time being the price's own, so a list price keeps its list date), in
  one transaction, or adds a row when there is none. Before, every save added a row and the engine evaluated each as
  its own input, so a price typed a day earlier stayed a (false) flip beside today's. The Prices page's Add, the
  drawer's form and bulk paste are unchanged; Quick entry's card says which earlier price it replaced. Existing
  duplicates are not merged. Quick entry's **Bought it** (after a successful Save) is a single click instead:
  one `journal.add` buy on scrap.tf at the saved price (paint kept), with Undo in the toast. The card re-reads the saved
  row by id on `opps.changed` and `prices.changed` (an edit in the drawer or on the Prices page keeps the id), and Bought
  it reads it once more before writing; a row deleted since keeps the last known price.
- **Toast actions** (H3, `toastModel.ts`). `toast(text, tone?, opts?)` takes an optional action and timeout and
  returns the toast id; existing calls are unchanged. An action toast stays 12 s (`TOAST_ACTION_MS`; `timeoutMs`
  overrides, capped at 120 s), pauses while hovered or focused and resumes with at least 1.5 s left; its button runs
  the action and dismisses it. At most 4 show, and a new toast evicts the oldest one without an action first. Block
  buyer's Undo and every recorded trade's Undo use it; the in-drawer undo bar is gone. The drawer's focus trap
  includes the toast buttons, so a keyboard user can Tab to an Undo while the drawer is open. From 0.7.3 the trap
  counts a `<details>`' `<summary>` as a tab stop and treats any other focused element in the panel (a
  keyboard-focusable scroll box, say) as being at its place in the document, so only the true ends wrap.
  A toast removed while
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
  **Family rows (0.7.4).** An /items row is one entry for every copy scrap.tf sells at its price (Craftable and
  Non-Craftable, killstreak tiers, festivized and parted copies alike: the user's list counted plain, kt-1 and kt-2
  C.A.P.P.E.R.s on one row, and Craftable and Non-Craftable Backpack Expanders), listed apart only when scrap.tf
  prices a copy apart ("Non-Craftable Tour of Duty Ticket" beside "Tour of Duty Ticket"). So no row is assumed to be
  the Craftable copy. `ParsedScrapItem.listCraft`, in order: 'uncraftable' when the name starts with Non-Craftable,
  or any class token containing "uncraft" (a substring test, as the reference helper reads a card) sits on the `<tr>`
  or on an element inside it whose classes include "item" (the icon), or the item is keyed Non-Craftable anyway (a
  kit); then a page pass (`listRowsPass`): an unmarked row whose family (`scraptfListFamilyOf`: defindex, SKU
  quality, elevated strange, australium, effect, wear and paintkit, crate series and craft number; craftability,
  killstreak tier, festivizing and paint dropped) also has a Non-Craftable row on the page is 'craftable'; else
  'any', a family row. The SKU stays the family key (the plain SKU, `;uncraftable` when marked). A family row is kept
  in the P4 parser report (after every other kept item, so the 200-item cap never drops a refusal), noted
  `craft-unverified` with its row and icon class tokens: REPORT_CLASS_RE's (quality, killstreak, effect, item), and
  (0.7.4 review R46) on an /items row any class naming "craft" or a bare "nc" (`REPORT_LIST_CRAFT_RE`, at most 40
  characters; page-authored class names, P4), so a read of the user's own window shows a marker scrap.tf may put on a
  list row or icon that the parser does not read yet (an "uncraft" one makes the row Non-Craftable and leaves the
  report); the note is the report's only, never an item warning.
  Rows that key to one SKU: an identical repeat (title, price, pays, stock and limit) is the same row shown again
  and is dropped (`counts.duplicates`); rows that still differ each get `duplicate-row` (a refusal code:
  `isImportableItem` refuses it) and the page warns `duplicate-rows: N rows share an item…`.
- **Store** (schema V4; V14 adds `craft` and `page`). `scraptf_list` (sku TEXT primary key = canonical base SKU, name, sells_keys, sells_scrap,
  pays_keys, pays_scrap, stock, stock_limit, batch_id, observed_at, craft 'craftable' | 'uncraftable' | 'any' (NOT
  NULL, default 'any'; an unknown value reads 'any'), page (the list page the row was last read on, '/items',
  '/items/2'; NOT NULL, default '' = not known, `ScraptfListStored.page` absent); index on observed_at). Repo:
  `upsertScraptfList(rows)` (one transaction; a row is replaced only when the incoming observed_at is at least the
  stored one; prices rounded to integer scrap; returns the rows written), `scraptfList()`, `scraptfListRow(sku)`,
  `scraptfListSummary()` ({items, newestAt, oldestAt, batches}), `purgeScraptfListOlderThan(ts)` and (0.7.4)
  `deleteScraptfListRows(skus, beforeTs)`. The daily
  maintenance job purges rows older than `RETENTION.scraptfListMs` (30 days) and calls `ctx.scraptfListChanged` only
  when it removed some.
- **Write path** (`importSavedPage`, page kind 'items-list' only). Every parsed row whose SKU passes `looksLikeSku`
  becomes a list row keyed by `splitSku(sku).base`, out-of-stock rows included (scrap.tf still buys them), with its
  `craft`. A SKU listed twice keeps its first row with a price to buy (0.7.4: only identical repeats reach it; rows
  that differ write no row); a row with neither price is skipped. observed_at is the file time
  capped at now, else the import time. The rows go into the import's own transaction after `createImportBatch`, so a
  failed import leaves neither prices nor list rows. **Costs (0.7.4).** A row in stock becomes a source 'import' price
  (a known cost) only when it is proven to price its copy (`listCraft` 'craftable' or 'uncraftable'), its stock was
  read (a row with no readable stock is never a cost, Item Limits header or not: P1) and it is no `duplicate-row`.
  A family row is skipped as `SKIP_CRAFT_UNPROVEN` (benign) and a list price an older read stored for it is
  removed. The list replaces only what a list read wrote (list-tagged rows, or an untagged pre-0.5 row): a bank
  page's own price of the copy (its bank set, not 'list') is never taken over or re-tagged (`SKIP_BANK_CARD_PRICE`;
  its bank, asset id and card stock stay, and an older list price beside it goes), and a sold-out list row removes
  list prices only. A proven row whose home bank (`homeBankOf`, below) has a whole save newer than the list that
  shows no copy of the SKU on sale is skipped as `SKIP_NOT_ON_SALE_NEWER` ("a newer save of its bank page does not
  show it on sale", benign; 0.7.4 review R05: no newer page priced it): the list's stock counts copies that bank does
  not offer (a list saved before a gone save and imported after it brings nothing back). **DM-3.** A whole save
  of a one-page bank, the page's newest, deletes every list-tagged plain import price from before it
  (`Repo.importScrapPricesOfBank('list', mtime)`, never a read of every price) whose home
  bank is that bank and whose SKU it shows nowhere on sale (typed prices never). The home bank of a SKU is the
  bank of its newest bank stock row outside the list and /unusuals (`Repo.bankStockNewestBankOf`, one primary-key
  seek per kept save; asked once per SKU or twin per import, `homeBankOf`'s memo, review R04: an index on
  bank_stock.sku would double the thinning's delete time, test/db/bankStockThinPerf.test.ts), else of its craftability twin's, else the bank scrap.tf sells that kind of item on
  (`marketBankOfSku`, F36: a strange cosmetic on /buy/hats, never /buy/stranges, whose saves list no cosmetic) when
  that bank is one page; else none, and no bank save removes the price. **Retirement (F60).** A whole /items save takes its own
  'gone' events (per page, so /items/2 never retires an /items row; none on a first save) and deletes the
  list-tagged price of each gone copy and, for a copy the page no longer lists at all (`toStock` null), its list row
  (`deleteScraptfListRows`, rows observed before the save). 0.7.4 (review R02): and, when it is the newest save of its
  page, by set difference: every list row read on that page (`scraptf_list.page`) before the save that the save does
  not list in any state goes with its list prices, so a row last listed sold out, or written only by a look that
  stored no save (partial, unsettled, future-dated), is retired too; never a row whose page is not known, nor one
  another list page's newest save lists (one row per SKU). `scraptfListChanged` then fires too. `ImportResult.listRows` is the number of list rows
  written (absent for other pages), and from 0.7.3 `ImportResult.listRowsRead` the number of list rows the page gave,
  written or not. Bank pages write no list rows. Several saved /items pages merge by SKU, newest
  first; an older copy arriving later changes nothing and announces nothing.
- **Cache** (`domain/scraptfList.ts`). The table in memory, loaded on first use and re-read by `refresh()`. `rowFor(sku,
  K?)` maps any SKU to its base row valued at the caller's key price (else the engine's, read once until
  `keyPriceChanged()`); 0.7.4 (`scraptfListLookup`, shared with the mock): a copy with no row of its own (exact, then
  paint dropped) reads its family's row (`scraptfListFamilyOf`) when that row is 'any', as `match: 'family'` (absent
  on an exact row), never a row proven for other copies, never past a Non-Craftable row of the item's own, never for
  a kit; `has()` follows it. Only a row proven for the very copy (`scraptfListCraftProven`: exact and 'craftable' or
  'uncraftable') may be a cost; a family row's stock counts every copy. `keyRow()` is the `5021;6` row's metal prices and never reads the key price, so
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
  proven to price its copy (0.7.4) is an import price, a known cost, so the row is *flip* or *over* and never
  *rule-flip*. An out-of-stock row, and from 0.7.4 a family row, has no import price, so a rule can still decide its
  verdict, but from 0.7.4 (F78) never under that row's sells price when the row is the copy's own (`exact`; a family
  row is no proof): the rule estimate is the higher of the two; the row still shows its stock and what scrap.tf pays,
  and `MarketRow.scraptfListFamily` (0.7.4) marks a family row's fields (stock for every copy; the dashboard's label
  is its own).
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
  backpack.tf as the only exit. 0.7.4: a held copy with no row of its own reads its family row (scrap.tf pays one
  price for every copy the row stands for), flagged `HoldingRow.scraptfListFamily` so its exit is labelled so (the
  Holdings cell title, and the "Sell:" body: `(price list saved 12 min ago; one list row for every copy)`).
- **Key price** (`keyprice.ts`). `effectiveScraptfKey` takes the newer of the typed values (`scraptfSellScrap` = what
  scrap.tf pays, `scraptfBuyScrap` = what it charges, dated `scraptfObservedAt`; undated counts as older) and the list's
  key row (dated observed_at); a value the newer source lacks comes from the other one. Only the pays price caps
  automatic values, never a manual one. `KeyPriceState.scraptfFromList` holds the key row's values the cap could use
  (18 to 18,000 scrap, rounded), or null. Without a key row the key price is exactly as in 0.3. From 0.7.3 the typed
  pair still shares `scraptfObservedAt`, but saving only the display-only buy price re-dates it only when no usable
  typed sell price exists, so a buy-price edit never changes which source supplies the cap; saving the sell price
  still re-dates both. The Settings key fields (manual, scrap.tf buy, scrap.tf sell) refuse values outside 2 to
  2000 ref (`KEY_SANE_SCRAP`, the range of keyprice.ts `sane()`) and flag an older out-of-range saved value on its
  field; the schema and the service's fallback are unchanged.
- **Engine.** In-stock list rows proven to price their copy already arrive as import prices (0.7.4: a family row
  never does). List rows are valued at the current key price everywhere (the market read's, the lots', the drawer's).
  0.7.4 (F78): a rule row is evaluated at the higher of the rule's cost and the price scrap.tf showed the plain copy
  at (`ruleEvidence.ts` `scraptfSeenPriceOf`: the copy's exact list row, sold out or not, and the last on-sale price
  of its run on every retained bank save, from the history's runs index; core's `EngineDeps.scraptfSeenPriceOf`, in
  memory), flagged `rule-under-scraptf` with "scrap.tf/buy/hats listed it at X on <date>, more than your rule's Y" in
  its reasons. A candidate the saves never showed keeps the rule's cost.

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
  and 0.7.4 (F03) when the row is not proven to price the copy (a family row: "The scrap.tf/items list does not show
  whether this is the Craftable or Non-Craftable copy; check the bank page", `scraptfListCraftProven`; a typed copy
  would outlive every later import as the wrong copy's cost). The block names the copy it prices ("The list's
  Non-Craftable row") or says "One scrap.tf/items row for every copy at this price" with "stock n/limit for every
  copy" (`ScraptfListView.family`, `copy`). Open scrap.tf/items and Open bank page. **Open on scrap.tf (copies name)** in the drawer header and the ItemMenu copies
  the unpainted name, then opens the item's bank page through `links.open`: from 0.5 the bank page it was last seen on
  (`ItemDetail.seenOn`, F15), else `scraptfPageFor(category)` (pages pass `ItemMenuTarget.category`), else the
  `scraptf-page` link from `links.forSku` when it is one of `SCRAPTF_BANK_PAGES`, else scrap.tf/items.
- **Quick entry:** "scrap.tf list: sells X · stock n, saved 3 min ago" from `item.detail {history:false,
  target:'plain'}`, with Use (not for a sold-out or stock-0 row, and 0.7.4 not for a family row: a disabled Use says
  why, `QuickListHint.unproven`); saving an unchanged used price keeps the list's date and note.
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
  With `listRows` 0 it says "No list rows changed: this page gave no rows your price list can use." when
  `listRowsRead` is 0 (or `parsed` is 0 from an older service), and keeps "a newer save of scrap.tf/items is already
  stored" otherwise (0.7.3).
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
| unusuals | `https://scrap.tf/unusuals` (`/buy/unusuals` is recognised too; the bare address is the index of the effect pages and shows no card itself, F18 S3) | unusuals |
| list ("All items") | `https://scrap.tf/items` (`/items/<n>` pages merge) | none (it lists everything, F14) |

`bankForCategory` is the coarse page of a category filter. From 0.7.4 (F36) an item no saved page has shown is looked
for on the bank its kind is sold on, `scraptfBankForItem(category, obj, schemaItem)` (categories.ts): the user's saves
list strange cosmetics on /buy/hats (never /buy/stranges, weapons only), killstreak and australium weapons on
/buy/items, and only kits (item class tool) on /buy/killstreaks. So: unusuals and skins keep their page; any australium
goes to items; a killstreak tool to killstreaks, any other killstreak item to items; a strange cosmetic (cosmetic slot
or craft class hat) to hats, a strange weapon to stranges, any other strange item to items; hats, weapons, taunts and
the rest as the table. Without a schema entry the SKU decides what it can (an australium, a killstreak item with or
without a kit target), else the category. Only `SCRAPTF_BANKS` ids come back. `scraptfLinkFor(category, seen, fallback)`
takes it as the link when no save showed the item; the Live market keeps it per base (`Info.bank`, `marketBankOf`),
`MarketIndex.bankFor(sku)` gives the page a save listed the item on, else that bank (the shopping list's rows),
`ItemDetail.kindBank` carries it to the drawer's and item menu's "Open on scrap.tf", and ACT-8 judges a candidate by
it. A page a save did show the item on still wins everywhere. The /items list is no bank page, so an item last seen
only there (a `seenOn` or `scraptfLink` of 'list') goes by its kind's bank too (0.7.4 review: the banks' "What to look
for" through `MarketRow.kindBank`, R26; the item menu, which keeps `seenOn` and `kindBank` apart as the drawer does,
R28). The mock sends `kindBank` from `mockBankOf` (R32).

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
  prefix; an unusual skin (paintkit, wear and effect) keyed as Unusual 5 plus the effect (0.7.4, P2; Decorated 15 before), while a Decorated card that
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
- **What to look for** ('all', 'market'): `market.uncheckedBy(lookForBank, BANK_LOOK_FOR, now)`, one pass over the
  Live market's "Not checked" rows (buyers, no scrap.tf price of yours, no rule flip) in its default order: per bank the
  count and the 5 with the highest Pay up to above 0 and a revenue, as full rows (`bankLookFor(rows, categories,
  bank)` cuts and orders them as the mock does). 0.7.4 (F36): a row is the bank's whose scrap.tf button opens that
  page (`MarketRow.scraptfLink`: where a save showed it, else the bank its kind is sold on), so a strange cosmetic is
  the Hats card's; a row linked to the /items list goes by the bank its kind is sold on, as `bankFor` (0.7.4 review
  R26: `MarketRow.kindBank`, set for such a row, else its category's bank). It does not evict the Live market page's
  cached pass; about 20 ms at 50k bases. The list has no categories, so nothing to look for.
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

**0.9 (#13) A bank that is not trading.** When the bank's newest look said it was not trading (a batch with
`bankNotice` 'unavailable' at or after its newest save: `bankNoticeNewestAt`, `bankUnavailableAt`), the summary sets
`ScraptfBankSummary.unavailableAt` and the card adds a warning line under its saved line (`bankUnavailableText`:
"scrap.tf said it was not trading at your look 5 min ago"; `.bank-unavailable`). Its title says that look stored no
bank stock save, so the stock, changes and flips shown are from the save before it, and that the notice is read from
the page's text, a form no real save has confirmed. A later normal save clears it; the field is absent otherwise, so
older summaries and the mock's seeds read as before.

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
  per-process random key; the text itself is never kept. From 0.7.3 a blank read (an empty or non-text clipboard, or
  one another program holds open, which Chromium reads as '' on Windows) is not recorded, so the same text copied
  again after an image, or after another program briefly held the clipboard, is not checked again.
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
  `CHECK_MAX_RESOLVES` (8) resolver calls per text, memoised; a resolver error counts as no match. 0.7.4 (F44): a bare
  whole number read as ref ("Team Captain 2", a name then "21") is flagged `priceAmbiguous`. scrap.tf writes every
  price with a unit, so from the watcher, which sees copies from any app, the check drops it and checks the item alone,
  exactly as a copy of its name; the hotkey and a typed check keep the ref reading with `CHECK_BARE_REF_NOTE`, and
  `flipNotification` never sends a result carrying it. A decimal ("1.33") or a unit is a price from every source.
- A closest-match (fuzzy) name is accepted only when it is the item's own name apart from case, spacing, punctuation,
  accents and a leading "The" (scrap.tf writes "Bills Hat"), or when `confirmFuzzy` says it is unique: core uses
  `schema.search(itemText, 2)` returning exactly one hit with the same base SKU, at most 2 searches per check. Anything
  else is not-item: a wrong item would be a wrong flip. Exact matches the resolver flagged (an unusual without its effect, a
  crate without its series, an unknown paint) are checked as the general item with a fixed note; the resolver's own
  warnings are never passed on, because they can quote the text. From 0.7.3 a plain copied name that resolves to a
  Craftable Taunt Unusualifier (defindex 9258) is read as the Non-Craftable SKU the saved-page import stores, as
  backpack.tf keys nearly all of them; a SKU, an item link, or a name that starts with "Craftable" or "Non-Craftable"
  is kept as written. Kits are unchanged.
- **Craftability of a plain name (0.7.4, F41).** scrap.tf marks a Non-Craftable copy only with the "uncraft" class on
  its card or row, which copied text never carries, so a plain name resolves to the Craftable SKU; before 0.7.4 a copied
  /items row of the Non-Craftable "A Distinctive Lack of Hue" was judged against Craftable buyers (+52.22 ref, with a
  "Flip:" notification and Save price writing the Craftable SKU). `ParsedCheck.craftStated` (`checkTextStatesCraft`)
  is true for a SKU, an item link or a name with "Craftable", "Non-Craftable" or "Uncraftable" anywhere; F19's hinted
  price is never stated (the arm is a backpack.tf row, the price a scrap.tf card). For a Craftable item whose text does
  not state it (not a kit or anything with a target or output, not the Taunt Unusualifier), `judge` compares the prices
  the user's own saved data has each copy on sale at: the list row proven for that very copy (`checkListCopyPrices`:
  `scraptfListCraftProven`, exact, something to buy) and the bank pages' newest saves (`BankStock.pricesFor`,
  `bankStockPricesOf` over the shown pages, never the /items list's own save), and (0.7.4 review R20) whether the
  item's /items row is a family row with something to buy (`checkListFamilyOnSale`: one row for every copy, so
  scrap.tf has some copy, never known to be the Craftable one). `checkCraftCopy`: a copied price only one copy is at
  decides; a copied price no saved copy is at decides nothing (R21: undecided with the twin on sale, 'unknown' with
  only the Craftable copy, unless every saved Craftable price is a card of a bank page that never lists Non-Craftable
  copies: each bank price carries its bank, and `CHECK_NONCRAFT_BANKS` is items and killstreaks, the only banks whose
  saved pages hold Non-Craftable cards in the audited profile; a repriced /buy/hats, weapons, stranges, unusuals or
  skins card is then 'keep', where R21 had voided its Craftable flip, notification, Save price and Bought it whenever
  the twin had any buy order; a list row carries no bank and stays 'unknown'); with no copied price, only the
  Non-Craftable twin on sale means the twin, both mean undecided, only the Craftable copy keeps it; nothing proven saved but a family row on sale is 'unknown'; nothing
  saved keeps it as before. `checkDecideCopy` (shared with the mock) acts on the choice. The twin is checked with
  `CHECK_CRAFT_TWIN_NOTE` (its own name, book, prices and links; Save price and Bought it write its SKU). Undecided
  evaluates both copies and answers with the one that sells for less (`checkWorseCopy`: the worse verdict, then the
  lower profit, then the lower revenue), never the Craftable book alone, with `CHECK_CRAFT_UNSURE_NOTE`
  (`checkCraftUndecided`): no Save price, no Bought it, Quick entry… without the price, and no flip notification even
  when both copies are flips. 'unknown' is undecided the same way when the twin trades (an eligible buy order,
  `checkHasRevenue`), else the Craftable copy as written (an ordinary hat whose twin has no buyers is not shown as
  "no buyers"). So the copied /items row of "An Extraordinary Abundance of Tinge" (a family row, Non-Craftable buyers
  on bp.tf) is no "+37 ref" Craftable flip, and a Craftable card copied where the only save has the Non-Craftable one
  can no longer be saved over the twin's typed price. F19's hinted note names the armed item (`evaluate`'s
  `armedName`, the schema name of the Craftable SKU) also when its twin answers. Local reads only (R1, R10); nothing
  about the text is kept but the flag.
- Evaluation is `buildItemDetail` with `history: []`, `target: 'plain'` and `scraptfList: rowFor(base, K)`, the
  `item.detail {history:false, target:'plain'}` path: no request. The price (`chooseCheckPrice`) is the copied one first,
  else the saved list's price to buy (`scraptfListUsePrice`; plain SKUs only, as the list prices plain copies; 0.7.4:
  only a row proven to price the checked copy, `scraptfListCraftProven`, never a family row, whose stock and pays are
  still shown), else the
  newest typed or imported price (`newestStoredPrice`, a copy without extras first for a plain SKU; when a plain SKU has
  only copies with paint, spells or parts, the newest is still shown but `CHECK_EXTRAS_NOTE` joins the notes, as the Live
  market flags that row `has-extras`). A copied "Sold out"
  or stock-0 row has no price at all: it is newer than anything stored. What scrap.tf pays comes from a copied pays cell
  (even a dash, which means nothing now), else the list; stock and limit from the copy, else the list. `listAt` is set
  when the list supplied any of them. Profit is `flipProfit(revenue, price, settings.profit)` (revenue minus cost minus
  friction and, 0.8, the price-move reserve), margin is profit
  over cost, and `profitStatus` gives the verdict (profitable is `flip`, no-buyers `no-buyers`, anything else `over`;
  `no-price` without a price). 0.8: the result carries `exitCosts` (`exitCostsOf`, for the popup's breakdown) and, on
  a flip, `singleExit` (`singleExitOf` over the detail's own `buyOrders` for `revenue.order`). Pay up to is `revenue.maxCostScrap` (`maxCostFor`). Confidence is the Live market entry's;
  without one but with an eligible revenue order, `evaluateMarketBase` scores the base on demand over the local book,
  exactly as the entry would be scored. 0.7.4 review (R14): the price gets the engine's cost check (`checkCostNote`,
  the shared `costSanity` over the detail's PriceDB row and, only when the price is far under it, the craftability
  twin's `lookupTwinReferences`, both age-gated by `usableReferences`): `CHECK_COST_VARIANT_NOTE` or
  `CHECK_COST_BELOW_MARKET_NOTE`, confidence capped at Low, no flip notification (`checkCostSuspect`); the mock
  alike. Before the schema has loaded, a name that does not resolve gets
  `CHECK_SCHEMA_LOADING_REASON`. Item notes (F19's hinted note, 0.7.4's `CHECK_CRAFT_TWIN_NOTE` or
  `CHECK_CRAFT_UNSURE_NOTE`, the cost check's note, `CHECK_FUZZY_NOTE`, `CHECK_INCOMPLETE_NOTE`, 0.7.4's
  `CHECK_BARE_REF_NOTE`, `CHECK_SOLD_OUT_NOTE`, `CHECK_EXTRAS_NOTE`) go in `reason`, in that order.
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
  (`sameAccelerator`, on canonical chords; from 0.7.3 a bare Command or Cmd is the Win key, the same as Super or Meta
  and labelled Win, and only CommandOrControl or CmdOrCtrl mean Ctrl):
  an update is refused with `CHECK_HOTKEY_CONFLICT`, and a lenient load turns `check.hotkey` off. A
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
  from a copy with extras, `checkPriceIsOtherCopy`; from 0.7.3 never for a scrap.tf price, other than a copied one,
  older than `profit.inputStaleMs`, measured from the result's `checkedAt`, an unknown age counting as old, and a
  held-back result does not use up the per-SKU minute; from 0.7.4 never for an undecided craftability,
  `checkCraftUndecided`, nor for a number read as ref without a unit, `checkPriceReadAsRef`, nor (0.7.4 review R22,
  R14) on a revenue order not seen for 24 h, `checkRevenueUnverified`, as the engine's and the bank stock's toasts
  wait for a confirmed one, nor for a price the cost check flagged, `checkCostSuspect`; the popup still shows such a
  result), once per SKU per minute. Its body names the price's source
  as the popup does (`CHECK_PRICE_SOURCE_LABELS`: an import is "(imported page)", 0.7.3, since it may be a window read).
  One sequence number across hotkey and watcher keeps an older result from replacing a newer one.
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
  `app.showQuickEntry { sku, price }` (`formatKeysMetal`). With `CHECK_EXTRAS_NOTE` (a price for a copy with extras on a
  plain check; from 0.7.3 "Your price is for a copy with extras (paint, spells, parts or a tag), not a plain one.")
  Bought it is off, Quick entry… passes the SKU only and the price tooltip repeats the note, so the plain item is
  never booked or saved at that price. 0.7.4 (F41): with `CHECK_CRAFT_UNSURE_NOTE` Save price and Bought it are off
  (`CHECK_CRAFT_UNDECIDED_ACTION`), Quick entry… passes the SKU only, the price tooltip repeats the note and the note
  line shows in the warning colour (`.cp-craft`); a check decided as the twin saves and books the twin's SKU. Each
  writes once per result (keyed by id and check time, since ids
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
- **Mock**: `check.text` (`mockCheck.ts` follows the service's price choice and notes, and from 0.7.4 its judge,
  `mockJudgeCheck`: the watcher's bare number and a plain name's copy over the mock's list rows and bank saves),
  `check.recent`, `check.done`,
  `app.hotkeys`, the hotkey conflict refusal, `#/check?demo=flip|over|no-price|not-item` for the popup in a browser, and
  quick entry's price prefill.

Decisions and deviations from the F15 Live check spec:

1. `CheckResult.verdict` is nullable (non-items have none); `id`, `source`, `keyScrap` and `CheckPrice.observedAt` were added.
2. Reasons and item notes are fixed texts in `src/shared/check.ts`, so the service, main and the mock word them alike and
   none can quote the text.
3. A copied row showing stock 0 counts as sold out, as `scraptfListUsePrice` and the saved-page import read it; a copied
   pays cell, even a dash, wins over the saved list's.
4. A painted check never takes the list's price (the list prices plain copies); it still shows the list's pays and stock.
   0.7.4: neither does a check of a copy the row is not proven to price (a family row, one row for every copy at its
   price; the Live check reads a copied name as the Craftable copy, so the Non-Craftable copy's list price was its cost).
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
11. 0.7.4 (F41): the spec resolves the copied item as written; a plain name of a Craftable item is instead checked as
    the copy the user's saved scrap.tf data matches, and an undecided one answers with the copy that sells for less,
    noted, with Save price, Bought it and the flip notification off. Only local saved data decides. 0.7.4 review
    (R20, R21): a copied price no saved copy is at, or only a family /items row, is undecided too when the
    Non-Craftable twin trades, except a repriced card of a bank page that never lists Non-Craftable copies
    (`CHECK_NONCRAFT_BANKS`); the spec's flip notification also waits for a confirmed revenue order (R22) and a
    price the cost check does not flag (R14).
12. 0.7.4 (F44): the spec reads a bare number as ref; from the watcher a bare whole number after the item is no price
    (the item alone is checked), and the hotkey and a typed check note the ref reading.

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
spelled copies are rows of their own and match across saves. A row with no price to buy stores NULL costs. V14 adds
`craft` (`BankStockStored.craft`): the /items list's rows only, 'craftable' | 'uncraftable' | 'any' as
`ParsedScrapItem.listCraft` ('any' for `duplicate-row` rows and for a key whose rows disagree); NULL on a bank page's
card, and an unknown value reads 'any'.

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
  when still listed sold out, null when absent). Sold out in both: not shown. From 0.7.3 a gone row's price
  (`costKeys` / `costScrapRaw`) and `BankStockRow.lastSeenAt` come from the runs index (`ScraptfKeyRun.lastSeenAt` and
  `lastOnSale`, the price at that save, kept after the item goes off sale): the newest save that listed it on sale,
  often a window read inside the current run. Without history the price comes from the previous save (the session
  baseline); `previousCostScrap` stays the baseline's.
- Each row is joined per read to the Live market entry of its base SKU (`market.entryFor`): revenue, revenue order,
  buyers, Pay up to and confidence. `profit = flipProfit(revenue, cost, profit)`, `margin = profit / cost` (null for a
  free item), verdict `profitStatus` mapped to flip / over / no-buyers. A row with extras is flagged and its Pay up to is
  for a clean copy. 0.7.4 (review R01/R06, the calibration bug through the stock path): a row of the /items list not
  proven to price one copy (`bankStockListFamily`: its `craft` is not 'craftable' or 'uncraftable', a family row, rows
  of one item that differ, or no craft at all) is joined to **no** buy side (`bankStockRow`'s `bank`): revenue, Pay up
  to and profit null, verdict 'no-buyers', `listFamily: true`, so it is never a flip on the stock page, in "What's
  new", a page flip, a "New on scrap.tf (All items)" toast or a Changes feed flip (`scraptfEventListFamily`, from the
  event's own save). The page's Verdict reads "Every copy" and Record buy prefills no price for it. A proven row keeps
  its verdict against its own SKU's book (a Non-Craftable row the Non-Craftable copy's).
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
`BankStockResult.olderPages` { count, newestSavedAt }; history, the feed, `detailFor` and `seenFor` keep every page
(0.7.4: `pricesFor`, the Live check's craftability twin, reads the shown pages only, bank pages only).
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
  From 0.7.3 a sheen or killstreaker alone is not another copy (the 0.7.2 `isOtherCopy` / `priceIsForSku` rule,
  `bankStockIsOwnCopy`): a plain SKU reads its exact copy or one that differs only by sheen or killstreaker, and a
  painted SKU its paint copy with or without a sheen. Within one save, at equal rank, it takes the cheapest on sale at
  the key price, then the exact copy.

**Notifications** (S3, `notifyNewBankFlips`, `createNewFlipNotifier`). After an import wrote a bank's save, and only
when that batch is the first import of its page's newest look (the page's newest kept save, or the lowest batch id among
the page's saves at that time: the same file imported again is no new look) and the page has a previous save
(`BankStock.newFlips`, judged by the look rather than by the newest batch id, F17-C2): the rows of that page's diff that
are new and a flip, most profit first. Gates:
`notifications.enabled`, `notifications.newOnScraptf` (default true), 'import' in `notifications.inputKinds` (read as
`notifyKinds` reads it), `minConfidence` (the buy side's) and `minProfitScrap`. A suspect margin is never notified: F5's
rule (`isSuspectMargin`, shared with `scoreConfidence`) over the market entry's `eligibleCount` and `referenced` (a
usable PriceDB or community price, age-gated). 0.7.4 (review R14/R40): nor is a cost `costSanity` flags
(`variant-suspect`, `cost-below-market`) against the item's age-gated PriceDB price and its craftability twin's
(`BankStockDeps.costSuspect`, core: `bankStockCostCheck`, a few local reads per flip row), left out of `newFlips` and
`pageFlips` as the engine never toasts such a row; the Bank stock page still lists it. An /items row for every copy is
never a flip at all (`BankStockRow.listFamily`). Dedupe per bank and base SKU for 30 min (a painted and a clean copy new on
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

**From 0.8 (G1-G5, LC-7: one notifier).** `notifyNewBankFlips` stays the one entry point, but it now reads the told look
of the batch (`BankStock.lookOf`: newFlips' look rule, where a first save counts with `previousSavedAt` null): every row
on sale on its step diff, joined to the live book, the runs index, the buy timing (`timingAt` = now) and the watches, each
marked `scraptfIsRestock` (seen before on the bank's runs at the look's save time). Only G4 reads a look's verdicts (its
turn to Buy now, its Wait memory, the Wait note), so with `notifications.buyTiming` off (the default) the notifier reads
the look untimed (`lookOf(bank, batchId, { timing: false })`): an import judges no verdict and builds no lifecycle on its
path, as in 0.7.4. `bankStockNotifyCandidates`
(`src/shared/bankStockNotify.ts`) gives each row at most one candidate, in the priority order of
`BANK_STOCK_NOTIFY_KINDS`:

- **watch** (G1): `Watch (<Bank>): <name>`, when a covering watch meets the row (`watchMetOf`: the price at or under
  its target, or the row's own profit at or over its profit target with the confidence and order gates) on a read whose
  step diff says new or cheaper, or for a watch made or edited after the page's previous save (`watchFresh`). Never on a
  same-price re-read, a pricier price or key-price drift; a price hit skips a cost `costSanity` flags, a profit hit the
  flip suspect checks; /items family rows never fire.
- **new** (S3): `New on scrap.tf (<Bank>): <name>`, as before, for a new flip never seen before.
- **cheaper** (G2): `Cheaper on scrap.tf (<Bank>): <name>`, body `<prev> → <cost>, now under Pay up to <max>; …`, for a
  row this read made cheaper whose previous price was over today's Pay up to and which is a flip now
  (`bankStockDroppedIntoFlip`, judged at today's book).
- **back** (LC-7, G3): `Back on scrap.tf (<Bank>): <name>`, body `…; on sale again in your saves`, for a new flip that
  is a restock by the one rule (`scraptfIsRestock`, the change feed's 'restocked'); and for a watched copy whose watch
  asked for "back on sale" (`onRestock`), flip or not ("New on scrap.tf" with "you watch it" at a first sighting).
- **timing** (G4, opt-in): `Buy now (<Bank>): <name>`, only with `notifications.buyTiming` on (off by default), for a
  flip whose buy timing read 'buy-now' right after a told look that read 'wait' and whose data moved since that Wait
  streak began (a drop showed, or the first Wait's horizon passed); never on aging alone or on not-enough-data, over or
  no-buyers. The Wait memory is repo meta `bankStock.timing` (`{ "<bank>|<row key>": { at, since, drops, horizonMs } }`,
  7 days, 5,000 entries), read and written only while the switch is on.

One dedupe store (`bankStock.lastNotified`) and one cap (3 toasts, then one summary): a watch hit has its own key
`<bank>|<base>|w<id>`, exempt from the S3 key, and records the S3 key too, so the S3 kinds stay quiet after it. It is
held back by `toldBefore` only for an engine toast at or after the look's save (this read's find, the held start-up
path; recorded, not sent): an engine toast of an earlier read never holds it back. `told(base)` runs only for a toast
that tells a flip the engine would tell (the candidate's `tellsFlip`: the S3 gates passed, a profit hit, or a watch or
G3 toast quoting a verified, undoubted flip at the engine's bar for the copy), so the engine stays quiet about the same
find; a watch or G3 toast of an unconfirmed order, no buyer, no flip, a suspect margin or low confidence leaves the
engine's own "Profit:"/"Watch:" toast free once the find is a flip, as 0.7.4 left unverified rows unrecorded. A price
hit or G3 toast whose verified sale F5's margin check flags, or whose buy side is under `notifications.minConfidence`,
quotes no profit: "a suspect margin (few buy orders, no usable reference), so no profit is quoted" or "its buy side is
under your minimum confidence, so no profit is quoted" (`BankStockNotifyCandidate.doubt`). Summaries carry
`openBankStock { bank, filter }` (G5, never a URL): a click shows the bank's stock page on the summary's chip
(`bankStockSummaryChip`: Watched for watch hits, New for new and back, Flips for cheaper and Buy now). A look of new,
never-seen flips only reads exactly as before (titles, bodies, order, summary, dedupe). The engine's path B: for a typed
or imported opportunity of a watched copy, the watch's profit target replaces `notifications.minProfitScrap` (down to
`profit.minProfitScrap`, as only profitable rows toast) and the title reads `Watch: <name>`.

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
  buyers; from 0.7.3 "No usable buyer" when buyers exist but none is usable, by Settings' useOrder) and Confidence; the Gone view shows Last price and Last seen (from 0.7.3 `lastSeenAt`, the last save that had
  it on sale, else the baseline time). A click opens the drawer by base SKU,
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
  naming whatever keeps it silent (notifications off, "Imported pages" not ticked, import off) first. From 0.8 it reads
  "New, cheaper or back-in-stock flips on scrap.tf pages you save", followed by "Your scrap.tf watches"
  (`notifications.watches`) and "Buy now after Wait (estimate from your saves)" (`notifications.buyTiming`, off).
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

**0.9 (#13) The price-drop tag.** A bank page card that showed scrap.tf's own price-drop wording carries it in
`bank_stock.markdown` (V16; never on /items rows), and the shared `bankStockRow` puts it on an on-sale row of the newest
save only (`BankStockRow.markdown`; never a gone or family row). The Item cell shows it after the timing badge as a
pill (`bankStockMarkdownTag`, `.bs-markdown`): *Drops soon* for "This item will decrease in price shortly." (also with
both), *Marked down* for "… off original price" only. Its title says it is evidence only: no real save has confirmed
the wording, Flip Desk does not know when or by how much the price changes, and buy timing, profit and alerts do not
use it.

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
never runs scripts. From 0.7.3 nesting depth is bounded too: a page nested more than 512 levels deep (Chromium's own
parser limit; a scrap.tf page is about a dozen deep) is refused whole (`ImportTooDeepError`: the Import page shows
"The saved page is nested more than 512 levels deep, so it was not read", the parser report records 'parse-error',
and the folder watch logs it like any other parse failure). A card whose `data-title` or `data-content` snippet nests
more than 64 levels deep becomes that card's parse-error, and the other cards are still read. The "Price to buy"
header search reads each header cell's text from at most 256 nodes and 1,024 characters. The depth check sits inside
parse5, in a wrapped default tree adapter, because the slow part is parse5's own tree builder (quadratic in the
depth), so no check after the parse could stop it.
`test/compliance/static.test.ts` adds an F18 block. The readers (`mhtml.ts`, `savedPage.ts`,
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
- **Page time** (0.7.4, F82). A page is dated by its file's modified time (clamped to now), which a copy, a sync or
  an editor can reset: an old page with a fresh mtime became the bank's newest whole save, read cards on sale as gone
  (DM-1 deleted their prices) and sold ones as restocked. Now `readMhtml` also returns the file's own `Date:` header
  (`date`, Unix ms; Chromium writes the save time there; null without one, unreadable, or before 2015), carried as
  `SavedPageParse.savedAt`, and `importSavedPage` dates a file by it when it is more than `PAGE_DATE_SLACK_MS` (5 min)
  older than the mtime (a normal save writes its Date seconds before), everywhere the mtime was used (newer-page
  checks, the batch's `fileMtime`, prices, DM-2, the gone queries). A file whose mtime is more than
  `FUTURE_MTIME_SLACK_MS` (2 min) ahead of the clock stores its prices at now (or at its older Date) but is no bank
  stock save: stockSave 'partial' with the first warning `future-mtime: the file's modified time is ahead of this
  computer's clock, so this look stores no bank stock save` (`FUTURE_MTIME`), so it replaces only the copies it shows;
  the folder watch's catch-up scan passes over such a file (Integration). An .html save records no save time, and a
  web.archive.org capture still imports as the live page (not in this round).
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

- **Parser.** A recognised bank page with no card gets `NO_CARDS_SAVED_WARNING` instead of `no-items`. From 0.7.3
  scrap.tf's bare /unusuals index (address `/unusuals`, `/unusual`, `/buy/unusuals` or `/buy/unusual`) lists the
  unusual pages and never shows item cards: with no card it warns `unusuals-index` (fixed text,
  `UNUSUALS_INDEX_WARNING`) instead of `no-cards-saved` or `layout-changed`, and the parser report still lists any
  lookalike tiles. `/unusuals/<n>` sub-pages and an address-less `pid-unusuals` save keep `no-cards-saved`. A file
  save of the index still records a 0-item 'unusuals' batch (`isEmptyBankSave` keeps it out of coverage), with no
  no-cards banner or toast. Recognised
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
    items showed, save it again as 'Webpage, Complete'." 0.7.3: a batch the bare-kit cleanup emptied (schema V12
    zeroes `item_count` but keeps the categories counted at import; `importBatchItemsRemoved`) says an update removed
    the items it stored, not that it stored none or was saved or read too early.
  - `AppProvider` toasts `<file name>: <reason>` on `import.done` (`importNoticeToastText`: no cards, or
    `TOO_LARGE_REASON` for a save the folder watch passed over), in the dashboard window only, with **How to save**
    (opens `#/import`). It shows once per batch, a newer one replaces the last, and it stays 20 s, held while hovered,
    focused or while the dashboard is hidden (ToastHold 'hidden', from `useDocumentVisible`): the user saves in the
    browser with the dashboard behind it or in the tray, and the countdown runs only while it is shown. A manual
    import skips its own toast for a no-cards result, so the notice shows once.
    `AppContextValue.lastImport` keeps the newest result, so the Import page that How to save opens starts on it.
  - A test ties the renderer's code and reason to the parser's `NO_CARDS_SAVED_WARNING`.
- **0.9 (#13) A bank that is not trading.** A recognised bank page whose own visible text says its bank is not trading
  (a notice naming no bank or the page's own, such as "Hat Banking is temporarily disabled") warns `bank-unavailable`
  (`BANK_UNAVAILABLE_WARNING`) in place of `no-cards-saved`, which gave the wrong advice: the page was saved fine. The
  look stores the prices it shows but no bank stock save, whatever its cards (`stockSave: 'partial'`), and its batch
  keeps `bankNotice`. Last import and Recent batches read "Hats · scrap.tf/buy/hats · bank not trading"
  (`importBankText(…, bankUnavailable)`, from `importBankUnavailable(r)` or the batch's `bankNotice`).

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
6. A legitimately empty `/unusuals/<defindex>` sub-page also reads `no-cards-saved`. The bare /unusuals index, which
   never shows cards, reads `unusuals-index` from 0.7.3 (S3).
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
    follow (`stockSave` 'partial' or 'unsettled'; the partial and stock warnings come first in `warnings`). From
    0.7.3 such a look also replaces only the copies it shows: per base SKU, the earlier-price cleanup in
    `importSavedPage` removes only older duplicates of copies the look shows and copies it shows sold out; other
    copies (paint, spells, name, a kit's sheen or killstreaker) keep their prices until a whole look.

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
failed bank stock read leaves the prices' sighting. `scraptfLinkFor(category, seen, fallback)` then gives `source:
'seen'` with that bank and save time, or `source: 'category'` with the bank the item's kind is sold on (0.7.4, F36:
`fallback`, the index's `Info.bank` from `scraptfBankForItem`; `bankForCategory(category)` without it; never the list)
and `seenAt: null`.
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
  - The name is `scraptfSearchName` (unpainted; 0.7.2: a killstreak kit copies "<weapon> Kit", which every scrap.tf kit title contains), and `checkArmFor` skips names main would refuse.
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
  save of the bank (any page) listed it before this one (the runs index without this save, `seenBefore`): from 0.8 the
  one restock rule `scraptfIsRestock(d, seenBefore)`, with `seenBefore` from `scraptfSeenBefore(run, savedAt)` (the
  run's `seenAt` before the save), the rule the 0.8 "Back on scrap.tf" toast shares (D8, D20); **stock** =
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
  clean copy. From 0.7.3, with no `special` the copy is `scraptfItemCopyOf`: among the SKU's own copy and those that
  differ from it only by sheen or killstreaker, by the bank rule below (on sale on its newest observation, then last on
  sale, then last listed; a bank page before the list, then the newer), then the cheapest on sale, then the exact
  copy, then the lower key. The service narrows each cached save to the base's own copies (one bisection) and reads
  events for the chosen copy; the result's `specialKey` names the copy read. An explicit `special` stays exact. Each
  cached save is bisected for that copy, then `scraptfItemHistoryOf` reads **one bank**: the one whose
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
falls back to the dashboard. `isHttpsUrl` moved to `paths.ts`, so `links.open` and the click share it. From 0.8 the
click order is openUrl, then `openBankStock` (G5: a summary's `{ bank, filter }`, checked on receipt by `notifySchema`,
whose bad value costs the toast its link and never the toast, and again at click time by `notificationBankStock`; main's
`showBankStock` shows the dashboard on that bank's stock page and chip, no URL involved), then the SKU's drawer, then the
dashboard. `openExternal` is still called in one place only, behind `notificationOpenUrl`.

**Dashboard.**

- **U1, item drawer** (`components/ScraptfHistory.tsx`, `historyModel.ts`, `styles/scraptf-history.css`). A "scrap.tf
  history" block after the price list block, read lazily when the drawer opens (`useRpcQuery`) and re-read on
  `scraptf.changed` and `prices.changed` (a first or unchanged save writes no event but still adds a point) through a
  2 s throttle, only while the window is visible. "Listed since 2 d 4 h (since your save on Oct 14 09:12)", the price
  and stock now, chips for 1 h / 24 h / 7 d / since listed (↓/↑ amount and %, toned), a step chart
  (`StepSparkline`: each price held until the next save, a gap and a baseline tick where a save did not have it on
  sale, the nearest save on hover; the PriceDB sparkline is unchanged, except that from 0.7.3 a flat history shows its
  single value, "at X", and pads only its y scale), the last 5 changes with "Show all N", and empty
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
- **U3, Live log** (`LogPage.tsx`, `changesModel.ts`). Tabs **Opportunity events** (`#/log`, the old page; from 0.7.3
  its Export CSV follows the tab's kind chips, category and search, "Saves every event matching these filters, newest
  first (at most 5,000)", a failed first read shows the error with Retry and no empty state until the next good read
  (Retry or an 'opps.changed' push) clears it, and a read started under earlier kind chips, a multi-page catch-up or
  "Load older events", is dropped when it answers, as the changes tab drops a stale view's answer)
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
9. A change of a painted copy in the feed opens the clean copy's history (`ScraptfHistory` takes an optional
   `special` for a caller that knows the copy). From 0.7.4 (F66) an Opportunities row opens the drawer on its own copy
   (`openItem(sku, copyKey)`, `AppContextValue.itemCopy`), so its history is that copy's; the drawer's bank stock line
   still reads the SKU's own copy (`bankStockItemOf`).
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
  0.7.4 (F54): no `webRequest` listener at all, not even a passive `onErrorOccurred`, because any listener moves
  the session onto Electron's proxying URL loader in the browser the user drives. A page resource that fails (a
  third-party host whose TLS an antivirus, ad or DNS blocker resets: `ssl_client_socket_impl.cc ... net_error -101`)
  is reported by Chromium's network service itself; main's logging switches (Processes, Chromium's log) also put
  those lines in `logs/chromium.log`. They are never Flip Desk requests, which are the service's `request_log`.
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
  (`MIN_VISIBLE`) lies on a current display's work area, and from 0.7.3, when no display shows its top 48 px (title
  bar and toolbar), for example because a monitor above has gone, it is moved down to the top of the work area that
  shows it, keeping its size, x and maximised state; otherwise the window opens at 1280 x 900, fitted and centred
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
  (F21-3, F21-10; with `readOnLoad` off the toolbar words main's challenge notice as "Cloudflare check or error page
  on screen: solve it in the page, then press Read page now once the real page loads.", 0.7.3; main's text is
  unchanged): a scrap.tf main-frame document answered 403 or 503 (a challenge or error page) or 429 (rate limit)
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
  pushed again with the reason `unchanged`. A wall clock stepped back (0.7.3) counts as the gap passed, and as an
  expired user input for links out, as in `buyerCheck`. From 0.7.1 (F21-10) a page shown again within the gap, or unchanged
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
  mid-read) holds back only that view, until it is dropped or its renderer goes, with no extra timer. From 0.7.3 a
  read hung on a dead renderer or a dropped view ends then too: the script call is raced against a promise that
  `render-process-gone` and `dropView` settle (still no timer), and Read page now answers with the page notice (the
  crash notice) or "not open" and pushes no read. Then
  `deps.importHtml({ html, fileName: windowReadFileName(url), mtimeMs, address: url, origin: 'window' })`, which
  main.ts sends straight to the service (`host.call('import.html', p)`), never through the router. The name is cut to
  `WINDOW_READ_NAME_MAX` (260, the service's `fileName` cap, pinned by a test), so a long path is not refused on
  every read.
- **Status.** Each read pushes `'scraptfWindow.read' { at, path, items, bank, newFlips, warning, stored, pageFlips,
  bestFlip }` (the last three from 0.7.1: `ImportResult.stored`, `pageFlips` and `topFlips[0]`, its SKU checked against
  the openItem shape and its name cleaned and cut to 120 characters; from 0.8 (G2) `droppedFlips` too, when the service
  reported it: `ImportResult.droppedFlips`, the flips this read dropped under Pay up to, `BankStock.droppedFlips(bank,
  batchId).length`, which the status line words "10 flips (2 new, 1 cheaper)" and its title "1 of them dropped under
  your Pay up to on this read") to the toolbar
  and keeps it as `lastRead` (forgotten by Log out & clear). `warning` is the import's first warning cut at its `:`
  (the code, never the clipped page text after it); for a read the service recorded nothing for (`batchId: 0`),
  `no-cards-saved` on a bank or list page ("no items on screen yet; wait for them, then Read page now") and
  `SCRAPTF_NOTHING_TO_IMPORT` elsewhere; or a fixed `SCRAPTF_READ_REASONS` text for an empty or failed read. From
  0.7.1 `importWarning` picks by priority: partial-read, layout-changed (preferred over no-cards-saved), no-stock-limit,
  no-sku, no-price-column, unknown-bank, no-pays-column, then any other code but duplicate-cards and
  page-kind-guessed, with counts as digits only ('partial-read: 3 48', 'no-sku: 2 48'); every code has toolbar text in
  `WINDOW_WARNINGS`. From 0.7.3 a read of the bare /unusuals index returns the warnings `[nothing-to-import,
  unusuals-index]` and main sends `unusuals-index` (a page notice such as a challenge still wins); the toolbar says
  "this is the Unusuals index, which lists no items: open one of its pages to read it" as guidance, not in the warn
  tone. Logs carry the path and counts only: never the HTML, a URL query or an error's cause.

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
  on (UX-5). `'app.showBankStock' { bank, filter }` (0.7.1, zod: `isScraptfBank`, 'flips' | 'new', from 0.8 also 'watched': `BANK_STOCK_OPEN_FILTERS`) shows the dashboard
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
  false` (main only) stores prices and the batch but no bank stock save (`stockSave: 'unsettled'`). From 0.8 (G2) it
  carries `droppedFlips` too (absent when that count failed; main's `readFlipsOf` passes it on).
- 0.9 (#13): a read of a page whose own text says its bank is not trading records its batch even with no items (with
  `bankNotice`, `itemCount` 0 and no stock save), so the Banks card can date the notice; any other read with no items
  still records nothing. Main's `WARNING_ORDER` ranks `bank-unavailable` first, and the toolbar words it "scrap.tf
  says this bank is not trading right now: no stock save, and nothing on it reads as sold" (`WINDOW_WARNINGS`).

**Renderer.**

- **U1 Toolbar** (`pages/ScraptfWindowBar.tsx`, window kind `'scraptf'`, `styles/scraptf-window.css`, @imported
  last). One 48 px line: Back, Forward, Reload, Home; bank chips from `SCRAPTF_BANKS` through `'scraptfWindow.go'`
  (`aria-current` on the page on screen); a read-only address (origin and path); **Read page now** (disabled off
  scrap.tf and while a read runs, and from 0.7.1 on a page the import does not read; main's reason shown when none is
  taken); the status line "Read 48 items from /buy/hats · 2 new flips · 3 s ago" (from 0.7.1 "Read 48 items from
  /buy/hats · stored 46 · 10 flips (2 new) · best Team Captain +0.44 ref · 3 s ago", 'stored' only when it differs;
  0.7.4 (F53): "· no stock save" after the count, and a tooltip sentence saying to stay a few seconds or press Read
  page now, when the read carries `ScraptfWindowRead.stockSave` 'unsettled' (main passes the import's known values);
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
- **U5 About page** words R1, R3, R6, R9 and R10 as above. From 0.7.3 its R6 names the window's exception (Electron's
  own user agent, naming Flip Desk and Electron, without the contact address), and its R9 says key presses in the
  scrap.tf window, Steam's sign-in included, are only checked for the window's Back, Forward, Reload and Home keys
  (F21-11) and are never kept, logged or sent. It credits both ported MIT projects with their copyright and says
  where an installed copy keeps the licence notices (0.7.3 round, Packaging). 0.9 (#25): between "What it never
  does" and "Platform rules", *Unsupported by scrap.tf* (`UnsupportedPanel`, `aboutModel.ts`) lists nine things
  scrap.tf does not offer or allow, why, and what Flip Desk does instead, with dated, graded sources whose addresses
  are copied, never opened, then the email (`PERMISSION_TEMPLATE`, moved from the Import page, which re-exports it)
  behind "Show the email" and a Copy button.
- **Mock.** `mockScraptfWindow.ts`: a fake history, main's validation, made-up reads with
  `MOCK_WINDOW_READ_WARNING` and `openFromLink` (from 0.7.4 a read's `pageFlips` and `newFlips` are the mock bank
  stock page's Flips and new-flip counts, `flipsOn`, so an /items family row is no flip there either); `mock.ts` gates `settings.set`, routes `links.open`, refuses a
  page's `address`/`origin`, answers all nine methods, and serves the toolbar at `#/scraptf-bar` with import and the
  window on. No page is ever loaded in the browser mock.

**Compliance** (`test/compliance/static.test.ts`, "the scrap.tf window loads only what the user asks for …"; the R1
checks rewritten precisely, nothing else weakened). Only `main/scraptfWindow.ts` may carry a scrap.tf address into
`.loadURL(` or `new BrowserWindow(`/`new WebContentsView(`, and only it may name `WebContentsView` (`BrowserView`
nowhere), `fromPartition`, `persist:scraptf` or `origin: 'window'`; fetch, `.request`, `downloadURL`, `savePage`,
sockets and the service's net modules stay forbidden there, and so do a session's `preconnect` and `resolveHost` (in
`LOADERS` too, so no file passes them a scrap.tf address). From 0.7.3 `downloadURL` and `savePage` are in the R1
loader scan everywhere, and neither `.savePage(` nor `.downloadURL(` appears anywhere in `src/`: the app saves and
downloads no page itself, and the user saves a page with Ctrl+S in their own browser.
Every load or history step sits in `function userNavigate`, outside any
deferred callback, called only from a user action and only after `isAllowedWindowStart` (the toolbar's own
`loadURL(SCRAPTF_BAR_URL)` aside); a bare call of a user action (`reload()`, `home()`…) is allowed only inside another
user action, never in a deferred callback or any other function. In the other `main/*.ts` files a call of the manager
(`scraptfWindow?.open(`, the router's `windowOn().x(` and `w.x(`, `openScraptfWindow(`) never sits in a timer, a
listener, a subscription (`.onX(`) or a promise callback, nor (0.7.3) after an `await` in its function or switch case
(its own `await …clear()` aside; the smoke harness, a scripted diagnostics run against local pages, is exempt), and
the router's calls are pinned, one per case, like main.ts's one `open()`.
The module's timers are the pass-through and the one
settle read, and `readPage`, `importRead`, `flushHeld` and `endCycle` neither navigate nor start a timer. `executeJavaScriptInIsolatedWorld` appears only there, exactly as
`(READ_WORLD_ID, [{ code: READ_SCRIPT }])`; `executeJavaScript`, input events, `insertCSS`, edit commands and a second
`READ_SCRIPT` appear nowhere else in `src/` (`hardenWebContents` and main's `web-contents-created` listener included).
The exceptions are the `--smoke-test` dashboard bridge check (the one `executeJavaScript`, on the dashboard's
`contents` in `runSmokeTest`, not in a listener, timer or promise callback) and the window test's input. The settings
store's `hotkeys.undo()` is not a webContents call. `READ_SCRIPT` is pinned and token-checked. One view, built from
`scraptfViewWebPreferences`, which has no preload and every locked-down flag; no `preload:` key in the module and
no `setPreloads`/`registerPreloadScript` anywhere. No `setUserAgent`/`userAgentFallback`/`.userAgent =`, header option or header
hook, and no `.cookies`, `cookies.get/set/remove/flushStore`, `document.cookie` or `cookieStore.` anywhere in
`src/`. `openExternal(` in the module follows a `topLevelNavigationDecision(…) 'external'` check. A dashboard file
calls a window move or read only from a click: never in an effect, a push listener, a timer or a promise callback.
From 0.7.3 the scan also follows the local functions, hook callbacks and literal maps that hold such a call (the
toolbar's `NAV_METHODS`, `act`, `readNow`, a page's `openInWindow`…) into effects, push listeners, timers and promise
callbacks. A wrapper handed to a child component as a prop is not followed; the mounted tests cover those.
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
  file-imports `buy_hats.html`, `unusuals.html` and (0.7.2) `buy_killstreaks.html` an hour back, and runs the nine
  steps of its spec. 0.7.2 adds step 2b: `/buy/killstreaks` is read like steps 1-2, then `smokeKitProblems` checks
  the kits are stored by weapon (both Rocket Launcher copies, prices and stock), no kit without a target is stored
  anywhere, and *Professional Kit* is in the parser report with no SKU and `needs-target`. `/buy/hats` and
  `/unusuals` are then loaded again, because step 3's keys expect them side by side in the history.
- **Reads.** Each window read must match the file save of its fixture: the same on-sale rows, no change event,
  the same card count and (0.7.2) the same number of stored prices.
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
  prices and the batch are stored, but not `insertBankStock`, `onImport`, the gone deletes or the flips. From 0.7.3
  such a look replaces only the copies it shows (F18 deviation 11). 0.7.4 (F06, F53): not for the /items list, one
  server-rendered table whose rows are all there at load: an unsettled list snapshot is a whole save when every
  priced row's stock was read and it shows at least 90% (`LIST_WHOLE_RATIO`) of the rows of the page's newest stored
  save, or with none at least PARTIAL_READ_MIN_KEYS rows (`listLookShort`); else it stays unsettled. A settled list
  look with fewer than 90% of the rows of a save of its page at most PARTIAL_READ_MAX_AGE_MS older (of at least
  PARTIAL_READ_MIN_KEYS rows) is partial: `partial-read: N of ~M rows on screen; read the page again once every row
  shows`. Bank pages keep ACT-4 and DM-2 as they were.
- **DM-2 partial look** (`partialLookWarning`) and the **P1** tie-in: see F18 deviation 11 (from 0.7.3 it replaces
  only the copies it shows: other copies of its items keep their prices until a whole look). The page warnings
  `partial-read: N of ~M items on screen; read the page again once every card shows` and `no-stock-limit: N rows
  with no readable stock, so this look stores no bank stock save` come first in `warnings`.
- **DM-1, UX-2a, ACT-1 gone prices.** Inside the transaction, after `onImport`, only when the save wrote stock and
  the bank is not 'list': this batch's 'gone' events delete the 'import' prices that pass `replaceable` and match the
  event's SKU and `bankStockSpecialKey`, with the page's bank, observed before the save and not kept by this import.
  Their SKUs go to `affected`, so the engine records the price as removed. Typed prices, list-tagged prices and other
  banks' prices are never touched, and the events already skip first saves, out-of-order saves, the same file again
  and copies another page of the bank still lists. DC-1: a card only a look that stored no save caught (partial or
  unsettled) has no gone event, so on a one-page bank (not 'unusuals', whose no-save looks record no page) the page's
  newest save also deletes the replaceable import prices of its bank from before it that it does not show on sale.
  0.7.4 (F31, F37, F56, F62) widened that to every such price (`pricesGoneFromSave`): before, only prices observed
  after the page's previous save were swept, and a page's first save swept none, so a price a look set before the
  first save, a 'gone' event a 0.7.0 build recorded and never acted on (the user's The Classified Coif), or an older
  page arriving late stayed a cost forever. The rule now: a whole save (`stockSave` 'written'), the newest of its
  page, of a one-page bank deletes every 'import' price tagged to that bank (`Repo.importScrapPricesOfBank`: the V10
  index on `import_batches.bank`, then `scrap_prices_import_batch`, no table scan) observed before it whose SKU and
  `bankStockSpecialKey` it does not show on sale, not kept by this import. A page's first save does so only when it is
  not cut short against the bank's newest look before it (`firstSaveWhole`, DM-2's thresholds against that look's
  item count: a first save cannot be checked by DM-2). DM-1 stays for /unusuals; on one-page banks it is a subset.
  From 0.7.3 an older page arriving late does not write a copy of its bank that has a 'gone' event after the page's
  mtime: that copy is skipped as `SKIP_NEWER_SAVE` and its other rows stay untouched, so a sold card's price never
  comes back. 0.7.4: nor, on a one-page bank, a copy the bank's newest whole save (of any of its pages), newer than the
  page, does not show on sale, gone event or not (before, a card no stored save had listed came back, e.g. after a
  first save), skipped as `SKIP_NOT_ON_SALE_NEWER` (review R05: no newer page priced it, so not `SKIP_NEWER_SAVE`,
  which stays for a copy a newer page did price and for the gone event above). Restocks after the gone event and gone events at or before the page are unaffected. A one-time pass at
  core start (`reconcileBankPrices`, meta `import.bankPricesReconciled.v1`, before the engine's first run) applies the
  same rule to each one-page bank's newest save that has a previous save of its page, in JS (`bankStockSpecialKey`
  normalises the stored extras); on the audited profile it deletes exactly the Coif. 0.7.4: list-tagged prices are no longer
  beyond every bank: DM-3 (F14 Write path) lets a whole save of a one-page bank remove the list prices whose home bank
  it is and that it shows nowhere on sale, a list never re-tags a bank's own price (so DM-1 and DC-1 keep covering
  it), a proven list row skips a copy its home bank's newer whole save lacks, and a whole /items save retires the
  list prices and rows its own gone events show, and (review R02), as the page's newest save, every row read on its
  page that it no longer lists (F14 Write path, "Retirement").
- **P1 /items stock.** `limitsIn` reads `title`, `data-original-title`, `data-bs-original-title`, `aria-label`,
  then the bar's leaf elements (a bare integer pair, or 'n/m'), never the whole cell. A row of a table with an Item
  Limits column that yields nothing warns `no-stock-limit` (a refusal) and is not a price; its list row keeps stock
  null. 0.7.4 (F58): header or not, an /items row whose stock was not read is never a cost (`no-stock-limit: the list
  shows no stock for this row`) and counts toward P1, so such a look stores no bank stock save.
- **P2 strange skins.** `skinQuality` (paintkit and wear set, whatever the class): with an effect quality 15, plus
  `quality2` 11 when strange; strange without an effect quality 11 and no `quality2` (`15000;11;w2;pk14`); otherwise
  15. An Unusual card with no effect stays 5 and is refused. DESIGN_BRIEF §3.3 describes this form. From 0.7.3 the
  name resolver keys a strange unusual skin the same way, quality 15 plus the effect and `quality2` 11
  (`15000;15;u701;w4;pk14;strange`): typed or pasted names, and backpack.tf stats links with a priceindex, including
  quality=Strange, Unusual and Strange Unusual skin links. The old `15000;11;u701;…` form is no longer produced, and
  existing rows in that form are not rekeyed.
  **0.7.4 (F08/F43/F69): Unusual 5 plus the effect.** The live feed showed the 15 form was wrong for unusual skins: 1469
  of its 1477 unusual-skin buy orders were `<d>;5;u70N;w;pk` (market_name "Unusual X"), 8 were `…;5;u70N;…;strange`
  and 8 a Strange 11 primary with the effect (market_name "Strange X"); none was 15 plus an effect (that form was a
  synthetic fixture and sku.pricedb.io's). The canonical form is now Unusual 5 plus the effect, `quality2` 11 when
  strange (`15000;5;u701;w4;pk14;strange`, the cosmetics' convention): `skinQuality`, the /items row (whose effect is
  read from its title's first word, Hot, Isotope, Cool or Energy Orb, when no paintkit starts there), the resolver
  (`finish`, `applyPriceindex`: Decorated Weapon, Unusual, Strange and Strange Unusual stats links alike) and both
  backpack.tf mappers (`canonicalUnusualSkin` in `src/shared/sku.ts`, which also takes the feed's 11-primary form and
  a 15 plus effect document there; IGetPrices rows too). Plain skins stay 15 and strange skins without an effect 11.
  Stored rows are not rekeyed: books are read across every form (`SchemaService.bookBases`, Integration "Book twins"),
  so a price saved in the 0.7.3 form still meets the feed's buyers. nameForSku and the SCM name read the same.
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
  and of lookalikes; from 0.7.4 also /items family rows, `craft-unverified`): defindex, filtered class tokens
  (`REPORT_CLASS_RE`; on an /items row also any token naming "craft" or a bare "nc", `REPORT_LIST_CRAFT_RE`, at most
  40 characters, review R46), the title only without a custom name, content lines without
  gift, receipt, craft, tool or custom-description lines (any wording), the indicator and value attributes, the
  limit attributes, the SKU and the item's warnings; never the nav, scripts, asset ids or avatars. `reports.ts`
  keeps the newest `IMPORT_REPORT_RING` (20) in memory only (`scrubReportText` masks 9+ digit runs, links and control
  characters and clips every text); refused parses and empty window reads are kept as counts only.
  `'import.report' { limit? }` returns copies, newest first; the Import page's **Copy parser report** puts them on
  the clipboard as JSON and sends nothing. 0.9 (#13): `counts` gains `markdownSoon`, `markdownOff`, `countdownCards`,
  `recentlyTraded`, `recentCards` and `bankNotices`, and `notices` (absent when none) keeps at most
  `IMPORT_REPORT_NOTICES_MAX` (5) matched phrases ('bank notice: "…"', 'recently traded: "…"', 'countdown in a
  "recent" section: "…"'), scrubbed again. Cards with an evidence code (`price-markdown`, `price-countdown`,
  `recent-section`) are kept after the refused ones, with class tokens naming recent, countdown, drop, discount,
  markdown or timer. The copy toast sums them (`importReportMarkers`) and adds "They also showed scrap.tf wording Flip
  Desk only records (…); the report shows it." when any is above 0; the 0.8 texts are unchanged otherwise. It names
  'a "recently traded" section' only when `recentlyTraded` is above 0; cards under an id or class that merely names
  "recent" read 'N cards in a part of the page marked "recent"' (the two counts are kept apart).

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
checks; synthetic proofs show each flags what it should. From 0.7.3 the renderer scan also follows the wrappers that
hold such a call (F21 Compliance).

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

## 0.7.3 round: audit fixes

One round of fixes from an audit of the whole app. **Boundary unchanged** (R1-R10): every change is local parsing,
local SQLite, local UI or main-process housekeeping. No request kind was added: a rejected backpack.tf credential is
no longer retried, and PriceDB's full list runs on its intended 4 h cadence with a 15-min retry after a failure,
within its budget (R7). `READ_SCRIPT` is byte-identical, no `loadURL`, `executeJavaScript*`, cookie, user-agent or
request call site was added, the window module gained no timer, and the compliance scan gained the checks under F21
Compliance. Schema V13 recounts emptied killstreaks batches (Integration). Most fixes are described where their
feature is; the rest:

- **Opportunities.** The renderer caps the search at `OPP_MAX_SEARCH_CHARS` (200, the service bound of `market.list`,
  `holdings.list` and bank stock, which `opps.list` and `opps.exportCsv` share) in the box, the query and the restored
  filters. The empty list blames the paused network or the live feed only when no opportunity exists; otherwise it
  shows the filters or status-hidden state, as `emptyMarketReason` does. Its first-price screen follows
  `AppStatus.setupNeeded` 'first-price' instead of reading `prices.list` and `rules.list`, and its live region and
  Shopping's change only with the totals, not on every refresh.
- **Events export.** `'opps.exportCsv'` kind 'events' takes `events?: EventsExportQuery { kinds?, category?, search? }`:
  the service reads the newest `EVENTS_EXPORT_MAX` events of those kinds (as `opps.events` does), then applies the
  category and search with `eventMatches`; without `events` it writes every event, as before. The search is capped at
  `MARKET_MAX_SEARCH_CHARS`.
- **Journal page.** A trade logged with When left alone is dated when it is logged (not when the page opened), and a
  When more than 5 minutes ahead is refused ("That date is in the future."), as `recordTradeModel` does. The Live
  log, Journal and Prices pages show a failed first read as the error only, never their empty state.
- **CSV.** Text cells get the formula guard (a leading apostrophe) at the start of the cell and also after any `;`
  inside it that a formula start follows (after optional spaces or quotes), because Excel set to a `;` list
  separator splits on `;` even inside quoted cells.
- **Item names** (`schema.ts`, `schemaNames.ts`, `bptfItem.ts`). Target-less tools (a bare kit, fabricator, strangifier,
  unusualifier or chemistry set: no `td-`, and not a Collector's Chemistry Set keyed `od-`/`oq-14`) are never
  suggested. `resolve()` still returns their SKU but adds a "target is missing" warning, which bulk paste treats as a
  row error and the Live check as incomplete. backpack.tf listings keep paintkit 0 (Red Rock Roscoe) from the
  websocket's `texture.id` and from snapshot attribute 834, as `sku.ts` and `links.ts` keep `pk0`.
- **Settings.** The blocklist save applies the user's own edit (ids added and removed against the list the textarea
  was seeded from) to a fresh `settings.get`, as the drawer's block and unblock do; with no pending edit the textarea
  follows the stored list. `PERMISSION_FIELD_MAX` (shared/types.ts: who 200, contact 200, date 100, what was allowed
  1000) is read by both the settings schema and the Import page's inputs. The Live feed switch and the access token
  help say that turning the feed off only closes the websocket: with an access token and the backpack.tf API switch
  on, `snapshot-watched` still refreshes priced and held SKUs (at most one a minute, each at most every 30 min), and
  turning off the backpack.tf API, or pausing the network, stops every backpack.tf request. The *Price is stale
  after* hint names everything `profit.inputStaleMs` decides (confidence, notifications, Pay up to, the bank-save
  toasts), and Shopping refers to the field by that name.
- **Settings file** (`settingsStore.ts`, `paths.ts`). If settings.json exists but cannot be read at start, the app
  starts with defaults and the network paused, never overwrites the file, and leaves the OS login item as it is; the
  first save after the file can be read again syncs the login item to the saved `startAtLogin`. The global hotkeys
  are still registered from defaults for that session and reconciled with the file on the next save. A leading UTF-8
  BOM, as hand edits add, is ignored. `writeFileAtomicSync` removes its temp file on any write, fsync, close or rename
  failure.
- **Dashboard shell.** The top bar's Pause/Resume network button reflects the user's switch (`settings.networkPaused`),
  like the tray and Settings, not the service's effective state; an effective pause the user did not ask for (the
  env-proxy backstop, R5) shows through the Feed pill and the page banners. The price sheet nav count joins the
  push-triggered reloads that run only while the window is visible (`useVisiblePush`) and catch up once when it is
  shown. Segmented controls with no option checked make the first option the Tab stop (WAI-ARIA radiogroup). The
  browser mock flags 'all-outliers' like the engine's `bookFlags`.
- **Packaging.** `electron-builder.yml`'s `extraFiles` copies `NOTICE` (as `NOTICE.txt`) and
  `reference/scrap.tf-item-information-master/LICENSE` (as `LICENSE.Apache-2.0.txt`) into the install folder,
  outside app.asar: MIT requires the notice in every copy, esbuild drops the ported files' header comments, and
  Apache-2.0 4(a) requires a copy of the licence. The build depends on that LICENSE, so the folder must stay (only
  `reference/tf2-scraptf-profit-helper-main` is removed before publishing). `test/compliance/audit-licence-notices.test.ts`
  guards this.

**Tests.** Each fix carries its own `audit-*.test.ts` regression test beside the module's tests.

## 0.7.4 round: trading accuracy audit

A data-driven audit of trading accuracy, item identity and the integrations, each finding checked by independent
verifiers against the code and a copy of a real profile's database; this round fixes its 62 confirmed findings.
A review of the round's changes then reported 47 findings, each verified the same way (named "review R01" to
"review R47" below, not to be confused with the rules R1-R10): 43 confirmed and fixed in four packages plus an
integration pass, and 4 refuted as intended (R03: a sold-out /items row removes list prices only, F14 Write path; R07:
typed prices kept from 0.7.3 stay the user's; R24: a unit-less number read as ref keeps Save price, with its note;
R42: a 0.7.4 rule's Festivized default makes its backup version 2, which an older build refuses rather than broaden).
After updating, the user reads scrap.tf/items once (in the window or a save into the watch folder): V14 clears what
the list stored before rows read their copy, and the README, the Import page and the Banks list card say so.
**Boundary unchanged** (R1-R10): no request kind and no higher rate toward any site was added, and work was only
reordered inside the existing budgets (the review's fixes reorder picks or send fewer requests, never more); the scrap.tf session still
has no `webRequest` listener, and `test/compliance` passes. Fixes are described in their feature sections; the
bullets below list them.

- **Unavailable answers (F52, Integration).** 500, 502, 504 and Cloudflare's 520-527 and 530 pause their budget like
  a 503 (Retry-After, else 60 s doubling to 15 min) and neither count toward nor end a 429 streak; before, they
  counted as a success. Fewer requests during an outage, none more. The background snapshot job treats them as the
  host's failure, not the SKU's, and PriceDB's health reads backoff for them. `test/net/audit-5xx-backoff.test.ts`,
  `test/service/scheduler.test.ts`, `test/pricedb/pricedb.rest.test.ts`. Package G2 (reviews R16, R35, R34): a base
  answering so goes behind the other stale bases for 30 min, and cools down when it fails again after another book
  was fetched, so one failing name no longer takes every background slot (`test/service/audit-074-snapshot-5xx-rotate.test.ts`);
  Steam Market's 500 `{"success":false}` ("no listing") is an answer, not an outage (`HttpRequestOptions.isAnswer`),
  so it no longer pauses the scm budget for every item (`test/net/audit-074-scm-unknown-500.test.ts`).
- **Chromium's log (F54, Processes and F21 Session).** main routes Chromium's own ERROR lines (the TLS resets of
  third-party resources a scrap.tf page loads) to `logs/chromium.log`, bounded at start to 1 MB plus one `.old`, with
  logging-only switches; the scrap.tf session still has no `webRequest` listener. `test/main/audit-chromium-log.test.ts`
  and the appendSwitch pin in `test/compliance/static.test.ts`. While running (review R37) main empties it past 1 MB,
  checked at most every 10 min on the status pushes it handles anyway, no timer of its own.
  `test/main/audit-074-chromium-log-running.test.ts`.
- **Build output (F55).** `scripts/build.mjs` runs esbuild at logLevel 'warning' and prints one size line per bundle
  (`scripts/bundleSize.mjs`), so its 1 MiB size marker no longer reads as a failure; bundling options are unchanged.
  `test/scripts/audit-build-summary.test.ts`.
- **Stale buy orders (F13, F21, F47, F29, Integration "Revenue picks").** With any verified order, Conservative,
  Instant and the outlier median come from verified orders (Best stays the top order); Instant never takes an
  unverified bot (F23). Rows on an unverified revenue order are listed but never toasted until confirmed, and the
  "New on scrap.tf" toast skips them too, as (review R22) does the Live check's "Flip:" notification
  (`checkRevenueUnverified`). `test/domain/audit-074-verified-pricing.test.ts`,
  `test/domain/audit-074-unverified-notify.test.ts`, `test/main/audit-074-flip-notify-unverified.test.ts`. The mock
  sets 'unverified' from the order's age on every read, as the matcher does (`mockOrderFlags`, review R31).
  `test/renderer/audit-074-mock-unverified.test.ts`. Holdings' "Sell:" toast waits on such a backpack.tf buyer too,
  told once confirmed (reviews R11, R39; the market index counts a revenue order turning verified as a change), and
  the Holdings row shows the clock (`test/domain/audit-074-holdings-unverified.test.ts`). A fresh, not-full scrap.tf
  list price that clears the thresholds on its own is told meanwhile (`scraptfAlternative`), so an unconfirmed higher
  order no longer hides a profitable scrap.tf sale (without an access token it was never told). Verified orders are preferred,
  not exclusive: when every verified order is an outlier, Conservative is the top non-outlier unverified order, so the
  book is no longer 'all-outliers' (review R12, the mock alike; `test/domain/audit-074-verified-fallback.test.ts`).
- **Buyer liveness (F23, F63).** "+5 Buyer is online" and every online dot or line need the order's last event within
  2 h (0.9, #11: the +5 is no longer added, RESEARCH §4.2; the dots and lines keep the 2 h rule), else "last seen N
  ago"; a snapshot no longer carries a stale online flag onto the row it stamps as seen now;
  "buyers within 10%" counts verified orders only. Opportunities and the drawer headline mark an unverified revenue
  order. `test/domain/audit-074-cost-sanity.test.ts`, `test/renderer/audit-074-buyer-seen.test.ts`,
  `test/bptf/audit-074-snapshot-sides.test.ts`. The online flag carries only from a feed row ('ws'), so the next
  snapshot no longer re-reads its own stamp as the feed's and keeps "online" going (review R36;
  `test/bptf/audit-074-online-carry.test.ts`, `test/service/audit-074-snapshot-upside.test.ts`).
- **Snapshot priority (F16, F24, F30, Integration "Snapshots").** The background snapshot job serves its queue (typed
  prices), then unconfirmed profitable and below-threshold rows (most profit first), then rows whose unverified best
  order would be a flip the verified-order preference hides (`unverifiedUpside`, review R09: Strange Archer's
  Sterling), then held items to sell, then the oldest snapshot, and skips a base whose snapshot came from the cache
  within 30 min. An order a name snapshot cannot return (a generic any-effect order) gives no pick (review R10). The
  engine's FIFO confirm queue is gone: it ran ahead of the ranking and dropped a burst's most profitable rows (review
  R13). Rule candidates are never watched, so they wait for the feed or Refresh from backpack.tf (review R15). Same
  job, cadence and budget. `test/service/audit-074-snapshot-priority.test.ts`,
  `test/service/audit-074-core-snapshots.test.ts`, `test/service/audit-074-snapshot-upside.test.ts`.
- **Capped snapshot pages (F51).** A side with 30 raw rows is a page, not the book: stored orders it lacks are deleted
  only inside the range it covered (1% band). `test/service/audit-074-core-snapshots.test.ts`.
- **Zero-valued orders (F19).** "0.05 ref" orders (0 scrap) are out of the median and never outliers, and give no
  near-buyer bonus. `test/domain/audit-074-verified-pricing.test.ts`.
- **Cost checks (F22, F70, Integration "Reference age").** `variant-suspect` (cost under 0.9x the item's PriceDB band
  and within 10% of its craftability twin's) and `cost-below-market` (under 0.95x its PriceDB buy, by 1 ref or more),
  PriceDB only and age-gated: capped at Low and never toasted. Shared rule (`costSanity`), mirrored in the mock.
  `test/domain/audit-074-cost-sanity.test.ts`. The "New on scrap.tf" toast and the window's "N flips on this page"
  skip such a card too (review R14/R40, F17 S3: `BankStockDeps.costSuspect`, core's `bankStockCostCheck`).
  `test/domain/audit-074-bank-stock-cost-check.test.ts`. The Live check runs it on its price too (review R14, F16 Service:
  `checkCostNote`, a fixed note, Low, no "Flip:" notification). `test/domain/audit-074-live-check-undecided.test.ts`,
  `test/renderer/audit-074-check-undecided-mock.test.ts`. The Shopping list does not count such a known price as at or under
  the ceiling (`ShoppingRow.knownSuspect`). `test/domain/shopping.test.ts`, `test/renderer/shoppingModel.test.ts`.
- **scrap.tf/items rows are family rows (the calibration bug, F01, F14 Parser and Cache).** An unmarked list row is
  one entry for every copy scrap.tf sells at its price, so it is never assumed to be the Craftable copy (the user's
  "A Distinctive Lack of Hue" row, the Non-Craftable copy's price, read as a +52 ref flip against Craftable buyers).
  `listCraft`: Non-Craftable by name or by any "uncraft" class on the row or its icon, Craftable beside the item's
  Non-Craftable row, else 'any' (noted `craft-unverified` in the parser report with its class tokens, and from review
  R46 any class naming "craft", so an unread marker shows). Stored as
  `scraptf_list.craft`; lookups fall back to the family row (`match: 'family'`) for a copy with no row of its own.
  `test/import/audit-074-list-family-craft.test.ts`, `test/domain/audit-074-list-family-lookup.test.ts`. The list's
  stock saves carry it too (`bank_stock.craft`, review R01/R06): a family row, or rows of one item that differ, meets
  no buyer on the 'All items' Bank stock page, in "What's new", the window's page flips, a "New on scrap.tf (All
  items)" toast or the Changes feed (`bankStockListFamily`, `BankStockRow.listFamily`, `scraptfEventListFamily`,
  `ScraptfChangeEvent.listFamily`; the mock's seeded list stock alike, and its window read's flip counts come from
  that stock page, `flipsOn`). `test/import/audit-074-list-stock-family.test.ts`,
  `test/renderer/audit-074-list-stock-family-mock.test.ts`.
- **List costs (F01, F02, F28, F58, F14 Write path).** Only a row proven to price its copy, with its stock read, is a
  cost; it never takes over a bank page's own price of the copy (bank, asset id and stock stay), skips a copy a newer
  whole save of its home bank lacks (with no bank stock row of it or its twin, the bank `scraptfBankForItem` gives),
  and DM-3 removes it at the next whole save of that bank that shows it nowhere
  on sale (reading only the list's prices, and each SKU's home bank once per import: review R04).
  `test/import/audit-074-list-costs.test.ts`. First-run copy says so (review R38): the setup checklist and the empty
  Opportunities page lead with the bank pages (`FIRST_PRICE_LEAD`, `FIRST_PRICE_LIST_NOTE`: scrap.tf/items adds stock
  and what scrap.tf pays, and prices only rows that show which copy they are; the checklist's first button opens the
  scrap.tf banks page), as do the All items chip's tip and the README. `test/renderer/firstRunGuidance.test.ts`.
- **Retiring and duplicate rows (F60, F04, F61).** A whole /items save retires the list prices and rows its own gone
  events show, and (review R02), as its page's newest save, every row read on that page (`scraptf_list.page`, V14)
  that it no longer lists, sold out or written by a look that stored no save, with its list prices; identical
  repeated rows are read once, rows of one item that differ (`duplicate-row`) set no price
  and write no row. Same test files.
- **Whole /items snapshots (F06, F53, ACT-4 in the 0.7.1 round).** An unsettled /items window read is a save when it
  read every row's stock and about every row of the page's last save; a settled one far short of it is partial.
  `test/import/audit-074-list-costs.test.ts`. The window toolbar says when a bank page's read stored no stock save
  (`ScraptfWindowRead.stockSave` 'unsettled': "· no stock save", stay a few seconds or press Read page now).
  `test/main/scraptfWindow.test.ts`, `test/renderer/scraptfWindowModel.test.ts`.
- **V14 repair (F34, F57, F35, F59, Integration).** Deletes everything the list stored before rows read their
  craftability (its imported prices, rows, stock saves and events; the batches count nothing, yet the newest still
  dates the list: review R08), adds `scraptf_list.craft`, `scraptf_list.page`, `bank_stock.craft` and
  `key_prices.price_at`; typed prices stay. The user reads scrap.tf/items once more (README,
  the Import page and the Banks list card say so). `SCHEMA_VERSION` 14. `test/db/audit-v14-list-family-rows.test.ts`.
- **"Use as my price" and quick entry's Use (F03, F14 Dashboard).** Off for a row not proven to price the copy, with
  the reason; the Live check never takes such a row's price (`chooseCheckPrice`, and the mock's `mockCheckResult`).
  The drawer names the copy a row prices or calls it a row for every copy at its price, stock "for every copy";
  `MarketRow` and `HoldingRow.scraptfListFamily` carry the flag, and a "Sell:" toast on such an exit says so.
  `test/renderer/drawerScraptfList.test.ts`, `test/renderer/quickScraptfList.test.ts`, `test/domain/liveCheckEval.test.ts`,
  `test/domain/holdingsScraptfList.test.ts`.
- **The drawer's ages (F65, F68).** A newer look of the item's page that stored no save (`unsavedLookOf`) gets a
  note under the stock line, and the history says "In your save of …", never "Now", for the older save; the input
  card reads "Imported price #1554 · import #33". `test/renderer/audit-074-list-drawer.test.ts`.
- **Ghost bank prices (F31, F37, F56, F62, 0.7.1 round DM-1/DC-1).** A whole save of a one-page bank, the newest of
  its page, retires every imported price of that bank from before it of a copy it does not show on sale
  (`pricesGoneFromSave`, read per bank by `Repo.importScrapPricesOfBank`); a page's first save only when not cut short
  against the look before it (`firstSaveWhole`). An older page arriving late writes no copy the bank's newer whole save
  lacks (`SKIP_NOT_ON_SALE_NEWER`, review R05; an /items row whose home bank's newer save lacks it says the same). `reconcileBankPrices` runs once at core start for what older builds left (on the audited
  profile, The Classified Coif only). `test/import/audit-074-ghost-bank-prices.test.ts`,
  `test/service/audit-074-bank-price-reconcile.test.ts`.
- **Saved-page time (F82, F18 Page time).** An .mhtml file's own Date header dates the page when clearly older than its
  mtime (`PAGE_DATE_SLACK_MS`); a file dated ahead of the clock is no bank stock save (`future-mtime`) and the folder
  watch's catch-up scan passes over it. `test/import/audit-074-page-time.test.ts`.
- **Re-typed prices (F80, Dashboard Record trade).** Quick entry and the check popup's Save price update the newest
  typed price of the copy (`prices.upsert` `replaceTyped`, shared `priceIsForSku` in `src/shared/priceCopy.ts`, the mock
  alike) instead of adding a second input. `test/service/audit-074-typed-price-replace.test.ts`,
  `test/renderer/audit-074-record-trade-backfill.test.ts`.
- **Journal (F39, F38, Holdings).** A backfilled trade carries the key price then (`JournalInput.keyPriceScrap`, the
  dialog's and the Journal form's *Key price then*); a sale with no buy before it waits (`JournalSummary.waitingSales`,
  listed on the Journal page with "Record its buy", noted on Holdings) and never consumes a later buy.
  `test/domain/journal.test.ts`, `test/renderer/audit-074-journal-backfill-waiting.test.ts`. Review fixes: at one
  time a buy goes before a sale (`journalOrder`), so a sale and its buy logged within one minute (the dialog keeps
  minutes) match (R25); Record sale previews a backfill at its key price then, netting the next lot's own keys and
  metal (`HoldingRow.nextLotKeys`/`nextLotScrapRaw`, `saleAtKeyPrice`) as the journal books it, and the mock's
  journal books pairs that way too (R23). `test/domain/audit-074-journal-same-minute.test.ts`,
  `test/renderer/audit-074-record-sale-backfill-preview.test.ts`.
- **Unusual skins (F08, F43, F69, F15 P2).** Keyed Unusual 5 plus the effect (strange as `quality2`), the form the feed's
  buyers use; 0.7.3's Decorated 15 plus the effect matched none of 1477 orders. Import, resolver, stats links and
  both bp.tf mappers agree (`canonicalUnusualSkin`); books are read across the 5, 11 and 15 forms, so stored rows
  need no rekey. `test/import/audit-074-unusual-skin-feed-form.test.ts`, `test/pricedb/audit-strange-unusual-skin.test.ts`.
  DESIGN_BRIEF §4.2 and §4.3, `test/fixtures/bptf/FIELDS.md` and the ws-sample's synthetic unusual skin note say so
  (deviation 12).
- **Defindex twins (F09, F14, F49, F73, Integration "Book twins", F10 "One row per book").** One item's orders, filed
  by bp.tf under 18/205, 29/211, 9536/17xxx, 15000/201, 2093/5020, 5022/5045 or td-18/td-205, are one book on every
  read side, deduplicated by buyer, invalidated together, listed once. Read side only.
  `test/domain/audit-074-defindex-twin-books.test.ts`. A name snapshot reconciles every twin base (a stale order under
  the twin defindex is deleted), keeps a watched item's sell listings under its twins, and a twin base with no
  PriceDB or community row reads the canonical base's (`lookupReferences(repo, base, schema)`).
  `test/service/audit-074-snapshot-twins.test.ts`, `test/domain/audit-074-twin-references.test.ts`. Review fixes:
  a tool's target twins only with targets a SKU can hold, so a Bat kit no longer takes in (and its snapshot no longer
  deletes) the targetless kit's book (R17); targeted strangifiers (6522, 5661, 57xx ...) and Collector's Chemistry
  Sets (20006/20007, 20001 ...) are one book across their item_name's defindexes, the parser's defindex canonical,
  and a snapshot order under such a twin keeps the requested output (R18); a strange skin's 11 and
  15-plus-strange forms are one book (R19). `test/domain/audit-074-identity-twins.test.ts`,
  `test/service/audit-074-bat-kit-snapshot.test.ts`. A listed book's one row shows the newest price of yours across
  every twin (`rowKnownAt`), so a newer price stored under a twin no longer shows in no row (R29).
  `test/domain/audit-074-twin-row-price.test.ts`.
- **Name resolution (F15, F42, F72).** `schema.resolve` takes the schema's exact reading first (the rule the import
  keys cards by), and names learned from bp.tf only for text it cannot read; several learned SKUs are picked by
  `pickDefindex` with a warning, never by length or last seen (`Repo.findSkusByBptfName`, and `findSkuByBptfName`
  no longer orders by last_seen). `test/pricedb/audit-074-learned-name-twins.test.ts`.
- **Legacy kits (F17).** The schema's "X Killstreakifier Basic" kits (item_name "Kit", 5726-5801) are kits on the feed,
  the snapshot, IGetPrices and a card's data-defindex: keyed by their tier's kit (6526 ...), never `od-3;oq-<target>`;
  a canonical kit's defindex wins over a killstreakTier that disagrees (`kit-tier-conflict` in the map stats).
  `test/bptf/audit-074-kit-and-effect-names.test.ts`.
- **Effect names are no prefix (F18).** "Festivized Formation" no longer festivizes a taunt's snapshot rows (which
  emptied the real book at the reconcile); `nameHints` reads the name without the effect's own words, feed alike.
  Same test file. Guard in core's reconcile: a side whose rows all key to another item is left as it was, with a
  warning. `test/service/audit-074-snapshot-twins.test.ts`.
- **Craft and medal numbers (F46).** A "#N" after an item that is no crate is read as the plain item, with a warning
  (Live check: incomplete), unless PriceDB, a learned name or a listing prices that numbered SKU; a Mann Co. crate
  number in none of its series is noted; the import still refuses a tool whose "Series #N" read so.
  `test/pricedb/audit-074-learned-name-twins.test.ts`.
- **Snapshot names (F74).** A kit or tool without its target is refused before any call (`SchemaService.isTargetlessTool`
  in `resolveName`); after an empty book the second call goes only to a spelling bp.tf uses (`bptfNameVariant`: "The"
  dropped, or added before a plain Unique item and after "Non-Craftable " for a festivized one). Fewer calls, same
  budget. `test/bptf/audit-074-snapshot-names.test.ts`. Such a SKU is never watched or queued, and `item.refresh`
  refuses it with the reason. `test/service/audit-074-snapshot-twins.test.ts`.
- **Quality checks on cards and rows (F05, F76, F75, F11).** An Unusual-only item (item_quality 5, the Headtaker's
  `266;0` row) is keyed 5 (`quality-inferred`); a row's title qualities are checked like a card's class
  (`quality-mismatch`, now a report guess code); the Strange quality alone beside another quality or an effect is
  refused (`quality-conflict`), as are strange parts on a copy nothing marks Strange (`strange-conflict`), both
  refusal codes, no guessed rekey; a cosmetic's "(Kills: N)" is a part (its counter is Points Scored).
  `test/import/audit-074-quality-reconcile.test.ts`.
- **Live check craftability (F41, F16 "Craftability of a plain name").** A plain copied name, /items row or F19 hinted
  price of a Craftable item is checked as the copy the user's saved scrap.tf data matches (list rows proven for that
  copy, the bank pages' newest saves: `BankStock.pricesFor`, `bankStockPricesOf`): the Non-Craftable twin when only it
  matches (its saved price copied, or no price copied and only it on sale: `CHECK_CRAFT_TWIN_NOTE`; Save price and
  Bought it write the twin), undecided the copy that sells for less (`CHECK_CRAFT_UNSURE_NOTE`: no Save price, no
  Bought it, no flip notification). Review fixes (R20, R21): a copied price no saved copy is at, or only a family
  /items row, decides nothing, undecided when the Non-Craftable twin trades, else the Craftable copy as before
  (`checkDecideCopy`). Follow-up: a saved Craftable card of a bank page that never lists Non-Craftable copies (all but
  /buy/items and /buy/killstreaks, `CHECK_NONCRAFT_BANKS`; `bankStockPricesOf` tags each price with its bank) still
  decides when scrap.tf repriced it, so a repriced /buy/hats card is a Craftable flip with its notification again, and
  a hinted note names the armed item, not the twin that answers
  (`test/domain/audit-074-live-check-repriced-card.test.ts`). Text naming its copy, kits and the Taunt Unusualifier are unchanged; nothing saved keeps
  0.7.3's answer. Mirrored in the mock (`mockJudgeCheck`, the same shared rules).
  `test/domain/audit-074-live-check-craft.test.ts`, `test/main/audit-074-flip-notify-craft.test.ts`,
  `test/renderer/audit-074-check-craft.test.ts`, `test/domain/audit-074-live-check-undecided.test.ts`,
  `test/renderer/audit-074-check-undecided-mock.test.ts`.
- **Bare numbers in a Live check (F44, F16 Service).** A whole number without a unit after the item is
  `priceAmbiguous`: the watcher checks the item alone, the hotkey and a typed check keep it as ref with
  `CHECK_BARE_REF_NOTE`, and no flip notification carries it. `test/domain/audit-074-live-check-bare-number.test.ts`,
  `test/domain/liveCheckParse.test.ts`.
- **The bank an item is sold on (F36, F15 bank table, F19 S1, ACT-8).** `scraptfBankForItem`: strange cosmetics on
  /buy/hats, killstreak and australium weapons on /buy/items, kits on /buy/killstreaks. The Live market's scrap.tf
  link for an item no save showed, the banks' "What to look for" (grouped by the row's link), the shopping list's
  rows and group headers (`MarketIndex.bankFor`, `mixedBanks`), "Open on scrap.tf" (`ItemDetail.kindBank`),
  ACT-8 and DM-3's home bank of an /items price (`homeBankOf` via `marketBankOfSku`, so a /buy/stranges save no
  longer retires a strange cosmetic's list price) use it; a page a save showed wins. Static `SCRAPTF_BANKS` pages
  only. `test/domain/audit-074-scraptf-bank-for-item.test.ts`, `test/import/audit-074-list-costs.test.ts`. Review
  fixes: a row seen only on the /items list goes on its kind's bank card (`MarketRow.kindBank`, as `bankFor`), not
  its category's (R26); the item menu keeps `seenOn` and `kindBank` apart as the drawer does, so an item last seen on
  the list opens its kind's bank (R28); the mock's `item.detail` sends `kindBank` (`mockBankOf`, R32).
  `test/domain/audit-074-list-look-for-bank.test.ts`, `test/renderer/audit-074-item-menu-kind-bank.test.ts`.
- **Equal-price copies in the Live market (F40).** `knownAt` breaks a tie toward a copy without extras, then the
  higher id (the mock's `mockKnownAt` alike). `test/domain/audit-074-market-copy-tie.test.ts`.
- **Copies and totals (F66, F27, F33, Integration "Copies and totals").** `Opportunity.copyKey`, derived at read
  time, names the copy in Opportunities and the drawer and opens its history; copies after the best one on the same
  revenue order are flagged `shared-buyer`, and "together" and the group totals count that order once.
  `test/domain/audit-074-copies-and-totals.test.ts`. A Bank stock row opens the drawer on its copy too
  (`bankStockRowCopyKey`: the row key's special key, the same form), and a "Profit:" toast names the copy
  (`notificationTitle`, `copyExtrasWords`). `test/renderer/audit-074-bank-stock-copy.test.ts`,
  `test/domain/engineV2.test.ts`, `test/domain/audit-sku-copy-toasts.test.ts`. Review fixes: the group totals take
  each item's revenue order once at the best copy among the rows the filters show (`onceByOrderProfit`, the SQL of
  `opportunityGroupStats` with `useOrder`), so hiding the best copy no longer counts the buyer zero times (R27); the
  copy tag's hover says each copy is priced against its own buyers, and the tag leaves out a paint the row's SKU
  already shows as a chip (R30). `test/domain/audit-074-group-totals-filtered.test.ts`,
  `test/renderer/audit-074-copy-tag.test.ts`.
- **Key price age (F71, Integration "Key price age").** `KeyPriceQuote.priceAt` (`key_prices.price_at`, V14) from
  IGetCurrencies `last_update` and PriceDB's time, shown as "set 2 mo ago" and a Price set column, with a warning when
  a fresh second source disagrees by 1 ref or more; the source priority is unchanged.
  `test/domain/audit-074-key-price-age.test.ts`, `test/bptf/bptfItem.test.ts`.
- **Rules never undercut scrap.tf (F78 step 1, F14 "Engine").** A rule row, and the Live market's rule verdict, use
  the higher of the rule's cost and the plain copy's newest price on the saved list (exact rows) or a retained bank
  save (`ruleEvidence.ts`, `boundRuleCost`), flagged `rule-under-scraptf` with the page and date. The Rules banner
  says so. `test/domain/audit-074-rule-evidence.test.ts`.
- **Rule filters (F79, Integration "Rule filters", ACT-8 DC-5).** Festivized and Elevated Strange tri-states, a new
  rule leaves out australiums and Festivized copies, a backup using them is version 2, and an australium candidate is
  held back only when both its category's page and the items bank were seen whole within `profit.inputStaleMs`.
  `test/domain/audit-074-rule-filters.test.ts`.
- **Price sheet export (F81, Integration "Backups").** A record, not a backup: sheen, killstreaker, tags and the copy
  key are appended; pasting sku and cost back makes typed prices dated now (documented).
  `test/service/audit-074-price-sheet-copies.test.ts`.
- **Docs match the code (review R15, R33, R38, R41, R43, R44, R45, R46, R47).** README: profit and Pay up to use the
  orders seen in the last day except with Revenue used for profit = Best, which keeps the top order, clock and all
  (R33, R45; the Settings tooltip for Best says so too); the background snapshots check old-order rows first only for
  items priced or held with an access token, and rule candidates wait for the feed or Refresh from backpack.tf (R15);
  Holdings' "Sell:" and the "New on scrap.tf" toast wait on an unverified order as well (R39, R40); the first-run and
  import copy no longer say one scrap.tf/items save prices every item (R38); the installer path names 0.7.4 (R41); a
  look at scrap.tf/items is partial below about 90% of the rows of the page's save from the last 6 h, bank pages below
  half (R43); during an outage the budget reads Paused and PriceDB's connection Backing off, backpack.tf's Error
  (R44). Here: the P4 report's class tokens (R46) and the ownership table's new shared modules and ceiling.ts's cost
  checks (R47). `test/shared/audit-074-docs-consistency.test.ts` pins each of these against the code (the installer
  path against `package.json`, the ownership table against every `src/shared` module the mock and the service both
  import, the partial-look ratio against `LIST_WHOLE_RATIO`).
- **Version.** 0.7.4 (`package.json`, `package-lock.json`; README's installer path, review R41).

## 0.8 round: buy timing, watches, holdings advice and the journal ledger

Five feature packages on 0.7.4, built in waves on one Foundation. Foundation landed every cross-package contract
first (Schema V15, the shared types, the RPC methods and push, four settings keys, the bank stock filters and seeded
shared modules), so each package built on code that already compiled and left the tree green. Wave 1 was **profit**
(PC-1, PC-2, H2: one buy-side profit path, the price-move reserve, the next buyer) and the **journal** (J1-J6, H5:
the FIFO ledger, fees, venues, write-offs, results, the ledger CSV, edit); Wave 2 **cycles** (T1–T7, LC-3–LC-6:
listing runs and price-reduction cycles in the user's saves, buy timing) and **holdings** (H1, H3, H4, H6, H7, H8:
recorded exits, asks, references, advice, the drawer's section, snapshot priority); Wave 3 **alerts** (G1–G5, LC-7:
watches and one notifier for watch, cheaper, back-on-sale and Buy now toasts); then an integration pass (the version,
the README, this summary, the duplicate imports and the docs test). Every rule lives in `src/shared`, so the service,
the dashboard and the browser mock share it, and each package has a mock parity test. Decisions D1–D25 are the
round's settled conflicts between the package specs, named where they apply. Defaults keep 0.7.4's behaviour: no
price-move reserve (`profit.exitReservePct` 0), no watch, no fee recorded, "Buy now" toasts off
(`notifications.buyTiming` false, D25), and timing, advice and asks only add displays; "Cheaper on scrap.tf" and "Back
on scrap.tf" (under `notifications.newOnScraptf`) take the place of toasts 0.7.4 already sent for the same find. Every
estimate, verdict and piece of advice shows its sample size and the save or time it rests on, says "not enough data"
with a reason rather than guess, and never forecasts a price, a time to sell or a fill.

**Boundary unchanged** (R1-R10): no request kind, host, endpoint, budget or cadence was added or raised. Watched items
join `core.watchedSet()` as held items did in 0.7.4: the snapshot job walks them inside its budget (no more requests)
and the feed keeps their sell listings (storage only). The 30-min `pricedb-watched` bulk refresh includes them too (100
bases per request), so watches do send more PriceDB requests: up to 2 more bulk requests per 30-min run at the cap of
200 watches, also for a user who holds nothing (the job sends nothing only while the list is empty), inside PriceDB's
existing budget. scrap.tf data still comes only from the user's typing, saves and window reads; no `openUrl` beyond an exact SCRAPTF_BANKS page (summaries carry `openBankStock`, an in-app route);
nothing is bought, queued, listed or traded (R4). `ownSteamIds` only filters the user's own listings out of the ask
side and is no multi-account feature (R5). The one migration (V15) holds only nullable `ALTER TABLE … ADD COLUMN` and
`CREATE TABLE/INDEX` statements, and `test/compliance` passes with the new modules in its scans.

### Schema V15 and contracts (Foundation)

Foundation lands every cross-package contract first, so the packages build on types, methods and tables that already
compile. Nothing it adds changes what the user sees, apart from two empty chips on the bank stock page (Dropping,
Watched: 0 until cycles and alerts fill them), a fee and a write-off accepted by `journal.add`, and `journal.update`.

- **Schema V15 (`V15_ROUND_080`, migrations.ts), the release's one migration.** Only nullable `ALTER TABLE … ADD
  COLUMN` and `CREATE TABLE/INDEX` statements; no row is read or rewritten, so upgrading loses nothing, and a 0.7.4
  build refuses a V15 database (SchemaVersionError) as for every migration.
  - `journal.fee_keys REAL`, `journal.fee_scrap INTEGER` (J2): nullable with no default, because every row written
    before V15 never recorded a fee; NULL in both is "not recorded", 0 is "none". `journal.side` is TEXT, so
    `'writeoff'` needs no change.
  - `scraptf_watches` (G1, G3): new, one row per watched copy (`special_key` the bank_stock key) or per base for every
    copy (`special_key` NULL). The expression index `scraptf_watches_copy (sku, IFNULL(special_key, '*'))` keeps one
    watch per copy, the any-copy NULL included (V10 has the precedent). Price targets are raw keys + metal as typed,
    so each read values them at its own key price. `remind_at` is reserved for T9: 0.8 never reads or writes it.
    AUTOINCREMENT, so a removed watch's id (and its dedupe key) is never reused.
  - `holding_marks` (H1): new, runs of identical exit prices of held and watched bases seen while the live feed was
    up, from data the app already had. Every price side is nullable (that side had nothing), and `key_scrap` is NULL
    when the key price was not known rather than a default written as an observation. Indexes
    `holding_marks_base_from` (the per-base read) and `holding_marks_to_at` (retention).
- **Pins (decision D1).** `audit-v14-list-family-rows.test.ts` now pins migration 14 with `MIGRATIONS.slice(0, 14)`
  and `SCHEMA_VERSION >= 14`, and its re-migrate check reads `SCHEMA_VERSION`; `db.test.ts` lists the two new tables.
  `test/db/audit-v15-journal-fees.test.ts`, `watches.test.ts` and `holdingMarks.test.ts` pin V15 itself.
- **Repo.** `getJournal`, `updateJournal` (venue, note and fee only); `listWatches`, `getWatch`, `findWatch`,
  `countWatches`, `upsertWatch` (one transaction; an update may not take another watch's copy: `WATCH_COPY_TAKEN`),
  `deleteWatch`, `restoreWatch` (alerts review: Undo of a removal re-inserts the watch with its own id and times);
  `latestHoldingMarks`, `insertHoldingMark` (each side's keys and metal both or neither),
  `extendHoldingMark` (`to_at` only moves forward), `holdingMarks` and `pruneHoldingMarks` (180 days, at most 2,000
  runs per base, from `src/shared/holdingAdvice.ts`).
- **RPC (`src/shared/rpc.ts`).** New methods `journal.update` (J6), `holdings.detail` (H7) and `watches.list`,
  `watches.upsert`, `watches.delete`, `watches.restore` (G1; restore added by the alerts review for Undo), each
  zod-checked in rpcHandlers.ts. The journal bodies are final (D14):
  `journal.add` takes `'writeoff'` (a write-off receives nothing: no price, no fee) and a fee, `journal.update` edits
  venue, note and fee and refuses a fee on a write-off. `holdings.detail` and the watches methods are stubs until
  holdings (Wave 2) and alerts (Wave 3) build them (D15). New push `watches.changed`, a service event (not main
  only); `notify` gains `openBankStock?` (G5), and `BANK_STOCK_OPEN_FILTERS` gains `'watched'` (D7: main's
  `app.showBankStock` validator and the mock's derive from it). The mock answers every new method alike.
- **Settings (four keys, defaults keep 0.7.4's behaviour).** `profit.exitReservePct` 0 (no price-move reserve),
  `notifications.watches` true, `notifications.buyTiming` false ("Buy now" toasts are opt-in, D25) and a top-level
  `ownSteamIds` `[]` (at most 10 SteamID64s). A settings file from 0.7.4 loads with those values through the lenient
  load; the Settings page controls come with their packages.
- **Bank stock filters ship once (D6).** `BANK_STOCK_FILTERS` ends `'dropped', 'dropping', 'watched'`; Foundation wrote
  the matchers (`bankStockFilterMatches`: at least `BANK_STOCK_DROPPING_MIN` (2) reprice-downs in the run from
  `BankStockRow.timing`; a `BankStockRow.watch`), the counts, the chips, their help and their empty texts, all from
  typed row fields. Cycles and alerts fill `timing` and `watch` and never edit those switches.
- **Seeded modules.** `src/shared/journal.ts` (fee rules and refusals), `watches.ts` (limits and refusals) and
  `holdingAdvice.ts` (retention constants), completed by their packages (journal, alerts, holdings).

### Profit: one profit path, price-move reserve, next buyer (PC-1, PC-2, H2)

No migration, no new RPC method or push, no new request kind and no new `src/` file. With the default
`profit.exitReservePct = 0`, every number, verdict, Pay up to and notification is exactly 0.7.4's.

- **One buy-side profit path (PC-1).** `flipProfit(revenue, cost, p) = revenue - cost - frictionOf(p) - reserveOf(revenue,
  p)` (`src/shared/ceiling.ts`), null when either value is missing. Every buy decision goes through it: opportunity rows
  (the engine, and its unverified upside), Live market rows (`marketProfit`), bank stock rows (`bankStockRow`), the
  Live check, Quick entry and Record buy's comparison (`profitPreview`), and the mock (mockData, mockCheck).
  `maxCostFor` judges with it, so Pay up to includes the reserve. The engine's rule prefilter is `flipProfitBound`
  (`maxRevenue x (1 - pct) - cost - friction`, an upper bound on `flipProfit` for every revenue up to the book's best;
  at pct 0 it is 0.7.4's test).
- **The price-move reserve (`profit.exitReservePct`, Settings → Profit thresholds).** Default 0; the schema allows 0 to
  0.5, and `reservePctOf` reads anything else as none. `reserveOf = ceil(revenue x pct)` for a revenue above 0, the
  product's float noise ignored (`RESERVE_FLOAT_TOLERANCE`, 1e-9: a typed 7% is 0.07, and 7% of 100 scrap is 7, not
  8); `flipProfitBound` adds the same tolerance when a reserve is set, so it stays an upper bound. It is
  the user's own allowance for a price drop between buying on scrap.tf and the buyer accepting; Flip Desk does not
  measure price swings, and the field's hint (`exitReserveHint`) says so (0.9, #12: the hint now says
  Flip Desk never sets it, and Settings shows what your data suggests per value band; see the 0.9 round). It applies
  to buy decisions only.
- **Sells are unchanged (R-PC1-sell).** A sale into a live buy order (`holdingFigures`, the service's
  `scraptfAlternative`, `recordTradeModel.sellComparison`) keeps `sale - lot cost - friction`: nothing is left to move.
  Holdings' advice (Wave 2) applies the reserve only to exits nobody pays today (a listing, a recorded high, a
  reference), through `flipProfit`.
- **The path stays single.** `test/shared/profitPath.test.ts` scans `src/` (comments stripped): `.frictionScrap` is read
  only in ceiling.ts and the Settings page; a binary minus before `friction` / `frictionOf(` (decision D13:
  `/[\w$)\]]\s+-\s*(?:friction\b|frictionOf\s*\()/`, so `id="p-friction"` is not one) appears only in ceiling.ts,
  shared/holdings.ts (holdingFigures) and recordTradeModel.ts (sellComparison); and every buy decision's file calls
  `flipProfit(`. A later wave that adds a caller only extends that list.
- **The next buyer (R-PC2/H2, `buyerDepthOf`).** Over a book's eligible orders (`exitOrdersOfBook` in the service,
  `exitOrdersOfSummaries` over order summaries in the drawer, the Live check, Quick entry and the mock): the revenue
  order's buyer (SteamID, else the listing id, as `buyerCountOf`) is left out, and so are outliers, orders worth 0 and,
  with Instant, humans. The best verified other buyer wins (compareValued's order: value, a bot, the newest event, the
  lower id); with none, the best unverified one, flagged. `verifiedBuyerCount` is the distinct buyers with an order seen
  in the last 24 h.
- **`'single-exit'` (PC-2).** `singleExitOf` is set when the flip is 'profitable' on its revenue and no verified other
  buyer would still make it one (none, only an unverified one, or one that pays too little). The engine and the mock
  add the flag and a 0-delta reason (`singleExitReason`, last among the reasons; the engine's runInner puts a rule
  row's F78 'rule-under-scraptf' flag and reason before them, as the mock's evaluateOpportunity does): the score, the
  status and the notifications are unchanged. It judges a real cost, so Live market and Holdings rows never carry it
  (the mock drops it from its neutral cost-0 market evaluation, as the service's `MarketEval` flags never have it).
  A robustness check, never a fill probability. PC-2's `requireBackupBuyer` notification
  gate is deferred.
- **Fields.** `MarketEval.nextBuyer` / `verifiedBuyerCount` (always set by `evaluateMarketBase`; optional for
  hand-built entries); `HoldingBuySide` and `HoldingRow` carry them when the buy side has them (`buySideOf`,
  `holdingRow`); `CheckResult.exitCosts` (`exitCostsOf`) and, on a flip, `singleExit`. The mock's `item.detail` values
  every order at today's key price and flags its pricing's outliers 'outlier', as `buildItemDetail` does.
- **Display.** The 'single-exit' chip reads *One buyer*. Opportunities' Buyers cell is amber with a hover quoting the
  reason (`singleExitTitleOf`); the drawer's input card has a *Next buyer* line (`nextBuyerLine`: what the next buyer
  pays and the profit at this cost, "None: only this buyer", "not seen in 24 h") and a Profit hover
  (`profitBreakdownText`); Quick entry's Profit hover (`previewProfitTitle`) and the check popup's Flip and Pay up to
  titles name friction and the reserve, and the Live market and bank stock Flip hovers (`verdictPill`,
  `bankStockVerdictPill`, through `exitCostsWords`) name the reserve only when one is set; Holdings' Buyers hover (`holdingBuyersTitle`) says how many buyers were seen in
  the last 24 h and what the next one pays. Buy orders show demand, not sales: no text forecasts a fill.
- **Boundary.** Every number comes from data already in memory or already read by the same call: no request, no
  migration, no RPC method, no toast. A `settings.profit` change already re-evaluates the engine, the Live market and
  Holdings (core.ts), so the reserve needs no new invalidation.

### Journal: ledger, fees, venues, write-offs, results, CSV, edit (J1-J6, H5)

The journal books actual trades, so it keeps `frictionOf` for Record sale's status and never uses `flipProfit` (the
reserve is for buy decisions). New files: `src/shared/journal.ts` (completed from Foundation's seed),
`src/shared/venues.ts`, `src/renderer/journalModel.ts` and `src/renderer/styles/journal.css`.

- **One FIFO (J1, H5).** `journalSummary`, `journalOrder` and `journalValue` live in `src/shared/journal.ts`;
  `service/domain/journal.ts` only re-exports them, and the mock's `mockJournalSummary` is the same function, so no
  hand copy remains. `JournalSummary.closed` lists every sale or write-off that closed a buy (`JournalClosedTrade`):
  both rows' ids, times and venues (as typed), `heldMs` between the logged rows, the cost basis, the proceeds, the fees
  and the booked profit, all at the sale's key price, so `sum(closed.profitScrap) === realizedProfitScrap` and
  `closed.length === realizedTrades`. `typicalHoldOf(closed, open)`: the median hold of 3 or more of the SKU's own
  sales ('item'), else of 5 or more sales in all ('all'), else none (`TYPICAL_HOLD_MIN_ITEM`/`_ALL`); write-offs never
  count; the units still held (left out of the median, and the longer holds by construction) are counted
  (`stillHeld`) and named in the text. Holdings rows carry it (`withTypicalHold` in `rowsOf`, from the read behind
  `held`, over every open position; the mock's `holdingRows` alike), and `typicalHoldText` words it in the Held for
  tooltip as the user's habit ("Your sales of this item came a median 3 d after the buy"), never a forecast. Every
  hold between logged rows (the Journal's cells and cards, `typicalHoldText`, the drawer's `closedTradeLines` and the
  'held-vs-typical' advice reason) is written with `fmtHold` (format.ts): '< 1 min' under a minute, since When keeps
  minutes and a sale logged in its buy's own minute holds 0, which `fmtAge` would word as "now".
- **Fees (J2, V15).** `journal.fee_keys` / `fee_scrap`, NULL is "not recorded" and 0 is "none" (`feeOf`). A buy's fee
  joins its lot's cost basis per currency (so `JournalLot`, `JournalPosition.costScrap`, `HoldingRow.nextLot*` and the
  Record sale preview include it) and a sale's comes off its proceeds per currency; `pairProfit` is unchanged. Reports
  count the pairs without a fee on both sides (`feesKnown`). The Fees field (Record trade dialog and Log a trade) reads
  keys or metal like a price (`readFee`; empty is not recorded); its hint is brief §5.4's text for the venue
  (`venueFeeHint`, `feeHint`), never a filled-in value. Record sale's preview states what the journal books
  (`SellComparison.bookedScrap`, `bookedValue`, `saleAtLessFee` for a backfill) and, when friction is set, the
  friction-judged figure too; status and tone are still judged with friction, as Holdings judges them, and at the
  default friction of 0 every text is as in 0.7.4.
- **Venues (J4).** One list (`JOURNAL_VENUES`: scrap.tf, backpack.tf, marketplace.tf, Steam Community Market, Direct
  trade, other) for the dialog's and the form's datalist (`VENUE_SUGGESTIONS`). Stored venues are free text and never
  rewritten; aliases fold on read only (`venueLabel`: 'bp.tf' is backpack.tf, 'Steam' the Steam Community Market).
  ACT-3's newest scrap.tf buy uses `isScraptfVenue`. Both forms cap a venue at 100 characters, as zod does.
- **Write-offs.** `JournalSide` 'writeoff' (TEXT in the table): one unit used, lost or that will never sell. It closes
  the oldest lot dated at or before it (it ranks with the sale in `journalOrder`), receives nothing (zod and the mock
  refuse a price or a fee on one, `JOURNAL_WRITE_OFF_NOTHING`) and books exactly that lot's cost at the row's key
  price as a loss; with no lot it waits like a sale (`waitingSales[].writeoff`), counted and named apart from the
  waiting sales (`waitingCounts`; `waitingSalesText(sales, writeoffs)`, `waitingTitle`, `waitingBuyTitle` and
  `resultsNotes(t, sales, writeoffs)` say "write-off", never "sale"). It counts in the realised profit,
  `bySku`, the losses, the win rate and ROI, never in a hold time. It is recorded from Log a trade's *Written off* side
  or from Still holding's *Write off…* (`writeOffInit`, the Record trade dialog's write-off mode, which compares the
  next lot with `writeoffComparison` and still shows *Sells now*), and it sells nothing (R4).
- **Results (J3).** The Journal page's Results card groups the closed flips by month or week (local calendar, weeks
  from Monday 00:00, a flip counted in its sale's period: `periodStart`) or by venue route (`routeKey`, folded by
  `venueLabel`, a write-off going to "Written off"): flips, win rate (break-even is neither a win nor a loss), profit,
  fees, ROI (profit over cost, not annualised) and median hold (sales only). Stat cards add Win rate, ROI and Hold
  time; rates under `MIN_RATE_TRADES` (5) flips are muted, with the count they rest on. The Losing flips card lists
  `profit < 0`, write-offs included, worst first (50 shown, the rest in the CSV). Each trade row gets a P/L cell
  (`tradePnl`: a sale's booked profit with the buy it closed, a buy sold / written off / open, a sale with no buy).
  All of it is `journalModel.ts` over the summary the page already reads: switching Month, Week or Venues issues no RPC.
- **Ledger CSV (J5).** `journalCsv` sorts by `journalOrder` (before, `(ts, id)` listed a same-minute sale before its
  buy) and appends 9 columns to the 11 of 0.7.4 (`JOURNAL_CSV_COLUMNS`): `fee_keys`, `fee_metal_ref`, `fifo`
  (open, closed or waiting), `matched_buy_id`, `cost_ref`, `proceeds_ref`, `fees_ref`, `profit_ref`, `held_days`. The mock
  writes the same cells (`journalLedger`, `journalCsvCells`), and its `csvCell` leaves numbers unguarded as the
  service's does, so a negative profit stays a number.
- **Edit (J6).** `journal.update` changes a row's venue, note and fee only and pushes `journal.changed` once; side,
  item, price, time and key price stay (delete the row and log it again), so an edit never changes which buy a sale
  closes. The trades table's pencil opens the Record trade dialog in edit mode (`journalEditInit`: the row and its
  booked pair): the price and time are shown read-only (`editLockedText`), the comparison books the pair again with the
  typed fee (`editComparison`, "(was …)"), Save sends only what changed (`checkEdit`; nothing changed, no RPC) and the
  toast's Undo sends the old values back (`journalUndoPatch`). The fee opens as stored (`feePrefillText`: keys are not
  rounded to 2 decimals as `formatKeysMetal` shows them) and the untouched prefill is the recorded fee
  (`typedEditFee`), so opening Edit and saving never rewrites it. The pair comes from the summary (every row) and its
  other row from the page's list (the newest 2000): one outside the list is `editPair.other` null, and the dialog
  shows the booked profit (with a new fee: worked out on save) instead of "no recorded buy".
- **Boundary.** Nothing new reaches the network: fees, write-offs and edits are typed by the user and stored locally;
  the report and the ledger are pure functions over `repo.listJournal()`; the CSV goes through the existing `saveCsv`.
  The journal modules open and load nothing and name no web address (`static.test.ts`, `JOURNAL_FILES`).
- **Tests.** `test/shared/journal.test.ts`, `venues.test.ts`, `test/renderer/journalModel.test.ts`,
  `journalReport.test.ts`, `mockJournal.test.ts` (parity), `test/service/journalRpc.test.ts`; changed
  `test/domain/journal.test.ts`, `csv.test.ts`, `test/renderer/recordTradeModel.test.ts`, `recordTradeDialog.test.ts`,
  `holdingsModel.test.ts` (the typical hold), `holdingsPage.test.ts` (the dialog also calls `journal.update`).

### Cycles: price-reduction cycles, listing runs and buy timing (T1–T7, LC-3–LC-6)

Cycles reads the price-reduction cycles in the user's own scrap.tf saves and turns them into a Wait / Buy now verdict
that always shows its sample size and never forecasts. No settings, no DB change, no new RPC method or push: every new
field is optional on an existing result (`ScraptfItemHistory.cycles` / `timing`, `BankStockRow.timing`,
`BankStockResult.turnover`, `MarketRow.scraptfTiming`, `Opportunity.timing`, `HealthReport.scraptfAssetIds`, the
parser report's `counts.reserved` / `notTradable` and `dataBot`). New files: `src/shared/scraptfTiming.ts` and
`src/renderer/timingModel.ts`; every rule is in `src/shared`, and the mock calls the same functions over its own saves.

- **One walk (T1, LC-3).** `scraptfLifecycleOf(saves, opts)` is the single pass over one bank's retained saves, oldest
  first, with `scraptfRunsOf`'s home-page rule (a page move is not a break). It yields the ACT-10 key states
  (`scraptfKeyStatesOf` is now a one-line wrapper, equal by construction), every **price state** of every copy (one
  stretch at one raw price, with the save before it, its newest save, the save that ended it and how), every **listing
  run** (`ScraptfListingRun`: first and last save on sale, the save before and after, its first and last price, its
  reprice-downs, how it ended) and the bank's asset-id stability; `returns` counts runs after a known start that do not
  follow a flap. The history index builds it on first use per runs rebuild (`cyclesOf`, with the pooled tables and the
  turnover memoised beside it), so a read after an import sees that import (`onImport` marks the index stale). How a
  state ends: 'reprice-down' / 'arrival' (cheaper; an arrival when the stock grew, a cheaper card came in),
  'reprice-up' / 'sold-cheapest' (pricier; sold-cheapest when the stock fell, the card at today's price was sold),
  'gone' (off sale), 'untradable', or 'open'. A direction across a key boundary uses the key price at build time.
- **Asset ids and the stability gate (LC-5).** `compact()` keeps a single card's (stock 1) Steam asset id and `sameRow`
  compares it, so a shared row never carries a stale id. Every asset-id label ("the same item came back", a stock-1
  arrival versus a reprice, *became untradable*, the flap's id check) is gated on `ScraptfAssetStability.stable`: at
  least 95 % of at least 50 pairs kept their id. A pair is the same single card on two consecutive looks of its page at
  least `BANK_STOCK_SESSION_GAP_MS` (30 min) apart, counted in a cheap pre-pass (`scraptfAssetStabilityOf`) so the walk
  knows the gate when it decides a flap; the window's 30 s reads within one look never count, so they cannot pass the
  gate alone. Health's *scrap.tf saves* card shows the measured share per bank (`assetIdsLines`).
- **Flaps and the untradable label (T1).** A copy off sale and back within `SCRAPTF_FLAP_MAX_MS` (60 min) of its last
  on-sale sighting, at the same raw price, with stock not lower (and, with the gate on and single cards on both sides,
  the same asset id) is a flap: the run before is marked `flap`, the price state re-opens and nothing reads as gone.
  The rule is in time, not in saves, so ten 30 s reads of a 5-minute absence and an hourly save that never saw it give
  the same states and chains. A run whose single card shows, in the same save, under the item's `;untradable` SKU with
  the same asset id ends 'untradable' (gate on only).
- **Censoring decided by the save schedule, never by the outcome (T2, LC-4).** Each page has a **gap limit**
  (`scraptfGapLimitMs`): 1.25 x its usual longest gap in a day (the median, over the UTC days of its last 7 d, of each
  day's longest gap between looks: a night, say), at least 2 h (retention's hourly tier leaves gaps under 2 h) and at
  most `SCRAPTF_TIMING_MAX_BRACKET_MS` (24 h, also the limit of a page with fewer than two looks). A state or listing is
  left out (`imprecise`) only on its start side: already on sale at the first save of its page, begun after a gap over
  its page's limit (`wideStart`), or a family row. On the end side nothing is dropped: a gap over the limit between two
  observations of a copy censors whatever was at risk at the last sighting before it (`cutAt`, counted in `wideGap`),
  whether it ended after the gap or not. Why per page (0.8 review): retention keeps one save a day past 7 d
  (`bankStockThinning`). With one 24 h limit those day-wide brackets were pooled with an hourly user's own looks, and a
  bracket reads a drop and then a sale as one 'gone' and merges drops: on a synthetic bank of known rates, saved hourly
  for 45 days and thinned, the dropped-first share at 3 d fell from .59 to .51 and gone-first rose from .30 to .41, the
  median bracket became 24 h (so 6 h and 1 d were never offered), and wait verdicts turned to over. Cut at the page's
  limit, the thinned table matches the dense one (`audit-080-cycles-review.test.ts`), and an hourly user who sleeps keeps
  the nights (limit about 11 h). A page looked at once a day keeps 24 h: its own saves are no finer, and within a
  bracket that wide a drop then a sale still reads as 'gone' (the estimate note says several drops between two saves read
  as one). The table's median bracket (`resolutionMs`) and the turnover's are over the states and listings that add time
  at risk (a duration over 0 or an ending), so ones censored at 0 never widen it. Look gaps are per home page, with saves
  less than 30 min apart one look (`scraptfLookGapMs`: the median gap between looks over the last 7 d, read once per
  page by the walk, `lookGaps`), so a window user who looks once a day reads about 1 d, not 30 s. A horizon H (6 h, 1 d,
  3 d, 7 d) is offered only when H >= 2 x max(look gap, the table's median bracket), while `a + H` is within the data
  with at least 3 states still at risk there, and while at least half of it is still ahead (`now - lastSeenAt <= H /
  2`). The 24 h ceiling came from a prototype over the browser mock: at 6 h every mock state was imprecise; with the
  first rules at 24 h hats gave wait 4, buy-now 3, over 9; with the review's rules (competing outcomes, start-side
  exclusion, `cutAt`, look gaps, item counts) hats gave wait 1, buy-now 3, over 12. The implemented rules give the
  mock's hats bank no *Wait* at all (buy-now 4, all gone-risk; over 13; not enough data 1; no buyers 3; unchanged by the
  per-page limit), so the mock test asserts Buy now, Over and Not enough data only, `scraptfTiming.test.ts` covers every
  verdict, and the rules were never tuned to the mock.
- **The estimators (T2, LC-4).** The pooled table (`scraptfTimingTableOf`) is Aalen-Johansen with three competing
  outcomes: dropped (a reprice-down or an arrival: the price the buyer can pay fell), gone (off sale, untradable or the
  cheapest card sold) and rose (a reprice-up); only open states are censored, so none of them borrows another's
  probability. It pools the copy's neighbouring power-of-two value buckets ("between about a quarter and four times its
  value", cached by bucket), else the whole bank below 15 ended states. The turnover (`scraptfTurnoverOf`) is
  Kaplan-Meier over listings, flap chains joined, with the same start-side exclusion; below 15 ended listings it says
  "not enough data" with the counts. Thresholds, in states and in items: 5 drops from at least 3 distinct copies
  (`few-drops`: one copy repriced five times is one item), 15 ended (`few-ended`), 8 still at risk at the copy's age
  (`few-at-risk`), 3 at risk at the horizon's end (`past-data`).
- **The verdict (T3).** `scraptfBuyTimingOf`, in order: no revenue, *No buyers*; then *Not enough data* with its reason
  (`stale-save` past 48 h or past the horizon's half, `left-censored`, `few-drops`, `few-ended`, `few-at-risk`,
  `sparse-saves`, `past-data`); per eligible horizon pDrop / pGone / pRise / pNone from the table conditioned on the
  copy's age, the drop size from the copy's own median (3 or more own drops) else the table's, and
  `q = S + F_drop` at the look gap (the dropped price is neither gone nor risen by the next look); EV through
  `flipProfit` (`scraptfTimingEv`: evBuy = flipProfit(R, c0); evWait = pDrop x q x max(0, flipProfit(R, c1)) +
  pNone x max(0, evBuy), gone and rose first worth nothing to waiting), the best horizon by evWait; *Wait* when the gain
  is at least max(3 scrap, 10 % of the profit now), pDrop >= 0.3 (0.9: replaced by the gain's low end, see the 0.9
  round) and c0 or c1 is within Pay up to (`drop-makes-flip`
  when only c1 is); else *Over Pay up to* above it; else *Buy now* (`gone-risk` when pGone + pRise >= pDrop and the
  window saw a gone or a rise at all, else `flip-now`: a window with no event is no evidence of a risk). A drop rhythm is the copy's own (3 or more reprice-downs, CV <= 0.35, a median at least 4x its drops'
  end bracket and 2x the look gap, so daily saves never read as a daily rhythm), worded "by that rhythm the next drop
  would be due" or "was due"; else the bank's median time to a drop, shown without a date (it is biased short).
- **Where it shows (T4-T7).** The item drawer's *scrap.tf history* gains the Cycles block: the verdict pill and its
  lines (the run's drops and rhythm, the odds over their own denominator `n.atRisk` with `n.states`, `n.copies` and
  `n.atRiskEnd`, the expected profits, the earlier runs' last prices, or why there is not enough data), the estimate
  note, a tick under each save that showed a drop (`StepGeom.downs`, only when asked, so holdings' chart is unchanged)
  and each listing run newest first (`historyRunLines`). Bank stock rows carry the brief (`rowsFor(…, timingAt)`, on-sale
  rows only, never a gone or family row), feeding the *Dropping* chip (2 or more reprice-downs in the run), the Since
  listed cell's drop count (" · 1×", " · 2×", from one reprice-down) and its dated drops, a *Wait ~1 d* / *Buy now* tag
  in the Item cell and a sentence on the Verdict pill's title (`timingVerdictTitle`). The chip and the cell count only
  the drops since the row's own listing began (`dropsSinceListed`, `bankStockRunDrops`): a flap restarts the row's
  listing (its Listed and Since listed baseline, `scraptfRunsOf`) while the timing joins it to the run before, so the
  cell never shows "0 % · 2×" against the price it came back at. With a value band as the pool (`scope: 'band'`, now on
  the brief) the titles' counts say "of similar value", as the drawer's do; the header adds the bank's turnover
  line (`bankStockTurnoverText`: the median, or "no median yet" with the estimated share still listed, never worded as
  a count of the listings). The
  Live market (`list()` only, not the CSV or the banks cards) and Opportunities ('import' rows only, through
  `scraptfOpportunityTiming`) show the same tag; there its title also names the scrap.tf price judged and the Pay up
  to it was held against (`timingBadge(t, now, keyScrap)`, from the brief's `costScrap` / `maxCostScrap`), because a
  list-only Live market row shows no price of the user's and an Opportunities row's input price can differ from the
  bank's. **Width (D23):** no column is added and no track changes: the 148 px
  Verdict track keeps its 146 px pill, the tag sits in the flexible Item cell (`.timing-badge`, the New pill's metrics).
  On bank stock the Item cell's tags (New or "↓ was X", the timing tag, extras, the G1 watch tag) sit in `.bs-tags`,
  capped at the cell minus 70 px, so the name keeps at least 64 px; a crowded row's tags ellipse, each keeping its
  full text in its title (at the default window the Item track is about 197 px).
- **LC-6 parser markers (report only).** The parser report keeps a card's 'reserved' class token, its data-bot attribute
  (`dataBot`, an id-length digit run scrubbed to '#') and the cards kept only for a 'reserved' / 'not-tradable' warning
  (after the refused ones, before family rows), and counts them (`counts.reserved`, `counts.notTradable`); Copy parser
  report's toast says how many. Nothing stored changes: LC-1 waits for the user's real report.
- **Restock versus returns (D20).** "Back on scrap.tf" and the feed's `restocked` share one rule (`scraptfIsRestock`:
  diff 'new' and listed before, `scraptfSeenBefore`); the drawer's `returns` counts runs after a known start that do
  not follow a flap. A flap can still read as restocked in the feed; the lifecycle drawer shows it as one listing.
- **Caveats, said where they bite.** Drops are dated at the save that showed them and counted between saves (a lower
  bound); 'gone' can be a sale, a reservation or a move, and until LC-1 a reservation reads as gone and a reserved-only
  copy still counts as stock; the model is one step at today's revenue; scrap.tf's own repricing rule is unknown
  (`TIMING_ESTIMATE_NOTE` under every figure). Real data is often sparse, so most rows may read *Not enough data*: that
  is the honest answer, and each reason says how to get one (save the page more often, look again).
- **Boundary unchanged.** The inputs are the `bank_stock` rows the history index already caches, the Live market's
  in-memory entries and settings: no repo query, request kind, host, budget, timer, notification, `openUrl` or URL is
  added, and nothing reaches scrap.tf (R1, R10). Profit goes through `flipProfit` only (`profitPath.test.ts`).
  `scraptfTiming.ts` and `timingModel.ts` are held to the F20 scan (`static.test.ts`, `F20_FILES`).
- **Tests.** `test/shared/scraptfLifecycle.test.ts`, `scraptfTiming.test.ts`, `scraptfTurnover.test.ts`,
  `scraptfLifecyclePerf.test.ts` (timed), `test/renderer/timingModel.test.ts`, `mockCycles.test.ts` (parity),
  `test/service/oppsTimingRpc.test.ts`; changed `test/domain/scraptfHistory.test.ts`, `bankStockHistory.test.ts`,
  `marketScraptfHistory.test.ts`, `test/service/scraptfHistoryRpc.test.ts`, `scraptfHistoryWiring.test.ts`,
  `test/renderer/historyModel.test.ts`, `drawerScraptfHistory.test.ts`, `bankStockModel.test.ts`,
  `bankStockPage.test.ts`, `marketPage.test.ts`, `mockParity071.test.ts`, `test/import/importReport.test.ts` and
  `test/shared/scraptfHistory.test.ts`.

### Holdings: recorded exits, asks, references and advice (H1, H3, H4, H6, H7, H8)

Holdings learns what its exits did while the app ran, what other sellers ask, what the references say, and turns that
into dated advice that never forecasts. It reads only local data (the stored listings, `pricedb_prices`,
`bptf_community`, `snapshot_times`, the journal, the market index and the saved scrap.tf list) and writes one table,
`holding_marks`. New files: `src/service/domain/holdingMarks.ts`, `asks.ts`, `src/renderer/holdingDetailModel.ts` and
`components/HoldingSection.tsx`; `src/shared/holdingAdvice.ts` is completed from Foundation's seed.

- **Recorded exits (H1).** `createMarkRecorder` writes a run per held or watched base: what one check saw (the revenue
  and best orders, the next buyer, the clean copy's lowest ask, and scrap.tf's pays price only while the saved list
  row is fresh and not full: `holdingMarkValuesOf`), as raw keys and metal, so a key move alone is never a price move.
  Runs are written **only while the backpack.tf feed is live** (core's `feedLiveSince`, sampled each status tick), so
  a gap in the record means "not watched" and is never filled. A run is extended while the same prices are seen again
  within `HOLDING_MARK_GAP_MS` (60 min), `to_at` at most every 10 min; a new run starts only on a price change
  (`sameHoldingMarkValues` over `HOLDING_MARK_VALUE_KEYS`): the buyer, verified-buyer and ask counts, which move with
  every order on an active book, are kept as the run's latest instead. A changed run first ends at its last sighting,
  never at the new one; a clock step back starts a run; `key_scrap` is NULL when the key price was not known (no
  default is written as an observation). A check records the bases in its scope, a 30-minute heartbeat every held and
  watched base, watched bases even when nothing is held (`markBases`, wired by alerts, D10); `stop()` flushes. A failed
  write is logged once per streak and never thrown into the check. Maintenance keeps 180 days and at most 2,000 runs
  per base (`runMaintenance` → `pruneHoldingMarks`, logged as "N exit runs").
- **Asks and references (H3, PC-7 as corrected, H4).** The ask side is the service's, not the renderer's (PC-7's
  `lowestAskOf` is not built): the sell listings already kept for watched items (`listingsByBaseSku(b, 'sell')`, the
  base's book twins merged) that match the held copy (`askCopyMatches`: the same paint, or none for a clean copy; no
  spells, parts, custom name or description; sheen and killstreaker free), not marketplace.tf, banned or blocklisted,
  seen within 24 h (`ORDER_UNVERIFIED_AFTER_MS`), one per seller at their lowest, and not one of `settings.ownSteamIds`
  (counted in `ownLeftOut`; with none set, `mayIncludeOwn` says the lowest may be the user's own). `HoldingRow.ask` and
  `ItemDetail.ask` (`buildItemDetail`, the same rule) carry it; an ask is what a seller wants, never a price paid.
  References are the age-gated PriceDB and community prices (`usableReferences`), with the reasons any was left out
  (`holdingRefsOf`). Caches: asks 60 s (sell changes fire no `moved()`), references 10 min (cleared by
  `settingsChanged()`), the rows' runs 60 min (merged with each recording, cleared by `journalChanged()`). The rows'
  runs are every run overlapping the holding (`to_at >= heldSince`; the advice reads none that ended before it), up to
  `HOLDING_HISTORY_MAX_RUNS` = `HOLDING_MARKS_PER_BASE_MAX` (2,000, what retention keeps per base): the window is
  bounded by time and retention, never cut by the read, so a busy book (an exit change every few minutes) keeps its
  trend and its 7-day recorded high (perf review: at 500 the newest 2-3 days read as "not enough recorded history").
- **Advice (H6, `holdingAdvice`).** *Sell now*, *List and wait*, *Hold* or *No clear signal*, the deciding reason first,
  then context reasons in a fixed order, each with the date or age it rests on (`adviceReasonText`), and the footer
  "From what Flip Desk saw while it ran; never a forecast." Precedence: (0) a backpack.tf exit on a buyer unseen for a
  day sells to scrap.tf's fresh price when that clears on its own (`scraptfAlternative`), else no clear signal; (1) no
  buyers: list when a listing 1 scrap under the lowest ask would profit; (2) clears target: sell now, or list and wait
  only when the listing beats the sale by max(minimum, 9 scrap) with 2 verified buyers, no falling trend and nothing to
  refresh, with a *single-exit* reason when no other verified buyer would clear (an unverified next buyer is no backup,
  as R-PC2's `singleExitOf`; the reason's `nextUnverified` says "not seen in the last 24 h"); (3) below target or a
  loss: list when a listing
  clears, hold for a recorded high, no clear signal without a trend, else sell now (below target) or no clear signal (a
  loss). The next buyer is a live order, judged like the revenue order (`holdingFigures`, friction only); every exit
  nobody pays today (a listing, a recorded high, a reference) goes through `flipProfit`, the price-move reserve
  included. A reference is context (`reference-above`), never a reason to hold. A recorded high needs a run of an hour
  or more within 7 days (`HOLDING_RECENT_HIGH_MIN_RUN_MS`) and no falling streak; a high from scrap.tf whose list is now
  merely stale gives a *resave-list* reason, never *Hold*. The trend (`holdingExitHistory`) needs 3 counted runs with an
  exit, 2 different exits and 48 h observed (gaps excluded), and compares exits only between runs observing the same
  sources (`markExitSources`): a list aging out or an order going unconfirmed is "not observed", never a fall. Every
  duration rule (the 5-minute count, the hour for a recorded high) applies to a **stretch at one exit**
  (`exitStretchesOf`, review fix): consecutive runs the recorder split only on a value the exit does not read (the best
  order, the next buyer, the lowest ask, the bot flag) with the same exit and sources, at most 60 min apart, are one
  stretch from the first `from_at` to the last `to_at`; runs with identical values stay apart (only a feed or app
  restart splits those, a break in watching). A run keeps the price, not the buyer, so runs recorded before the **buyer
  settings** last changed (`holdingMarkSettingsKey`: blocklist, `useOrder`, outlier multiples, notes keywords; Holdings
  keeps the date in meta `holdings.markSettings`, stamped by `settingsChanged()`, the mock's on `settings.set`) are left
  out of the advice and the drawer's history (`settingsAt`, said in the `no-history` reason, and in the `below-target`
  reason when it decides *Sell now* on a trend recorded since): a buyer since blocklisted is never a reason to hold.
  Without a trend the advice never says *Sell now* on a below-target row: a first install reads "No clear signal" with
  `no-history`. When below target decides *Sell now* the hover's help says what set a higher exit aside (a falling
  streak, a stale scrap.tf list) or that none recorded while held would clear it (`ADVICE_BELOW_TARGET_HELP`; since the
  buyer settings last changed, `ADVICE_BELOW_TARGET_SINCE_SETTINGS_HELP`, when the reason carries `settingsAt`), never
  "nothing recorded was higher" beside a reason naming one, nor "while you held it" over a history cut short. A currency (no base) has no book: its advice
  asks for no refresh and waits for no history (`holdingAdvice`'s `book: false`). The status pills were renamed
  *Clears target* / *Below target* (D11) so they no longer read as advice; the "Sell:" notification title is
  unchanged.
- **Your holding & trades (H7).** One local `holdings.detail` read fills the drawer's section (between the trade row and
  *Profit by input*): "You hold N · held …", the advice and its reasons, the open lots, the recorded exits as a step
  chart (`StepSparkline` over `holdingChartSeries`: each run a step at its exit, a run with no exit a gap, a silence
  over 60 min an *unwatched* gap, nothing interpolated) with "Exit prices recorded since …", the typical hold
  (journal's `typicalHoldText`, D3) and the closed trades (10, then *Show all*). It opens, links and writes nothing.
  The Sell listings section says what others ask (`askSideText`). The Holdings page gains the *Advice* column (its
  hover lists the reasons; a warn refresh mark when `refreshFirst`); at the narrowest width the advice pill takes the
  status pill's place in *Profit now*. *Profit now*'s hover names the references; *Sells now for*'s the ask side.
- **Settings → Your accounts (`ownSteamIds`).** Up to 10 SteamID64s (`OwnAccountsSection`, the Blocklist's
  fresh-read save). They only leave the user's own listings out of "Others ask" (R5): Flip Desk signs in to nothing,
  acts for no account, and the list never leaves settings.json.
- **Snapshot priority (H8).** `core.snapshotPriority` adds, after the held items to sell, held rows whose advice says
  refresh first (`refreshFirst`: the revenue order unseen for 24 h, or no eligible order and neither an order change
  nor a snapshot for 24 h; never a held currency, which has no book), most cost first, by base when they have no
  revenue order. Ordering only: the
  `snapshot-watched` cadence, the `bptf-snapshot` budget, the 30-minute staleness rule and the watched-only rule are
  unchanged.
- **Boundary unchanged.** No request kind, host, budget, rate or push is added; nothing reaches scrap.tf (R1, R10);
  *List and wait* is text only and nothing is listed, bumped or traded (R4); `ownSteamIds` only filters and is no
  multi-account feature (R5); no `openUrl`. The new modules are held to the F20 scan (`static.test.ts`, `F20_FILES`).
- **Tests.** `test/domain/holdingMarks.test.ts`, `asks.test.ts`, `holdingsExits.test.ts`, `holdingsDetail.test.ts`,
  `test/shared/holdingAdvice.test.ts`, `holdingsAsks.test.ts`, `test/renderer/holdingsAdvice.test.ts`,
  `holdingDetailModel.test.ts`, `drawerHolding.test.ts`, `mockHoldings08.test.ts` (parity),
  `settingsOwnAccounts.test.ts`; changed `holdings.test.ts` (domain and shared), `holdingsScraptfList.test.ts`,
  `holdingsModel.test.ts`, `holdingsPage.test.ts`, `holdingsScraptf.test.ts` (the renamed pills, the Advice header),
  `holdingsRpc.test.ts`, `audit-074-core-snapshots.test.ts` and `engine.test.ts` (maintenance).

### Alerts: one notifier for watches, cheaper, back on sale and Buy now (G1–G5, LC-7)

The S3 notifier (`notifyNewBankFlips`, F17) becomes the one pipeline for everything a read or save of a scrap.tf bank
page is worth a toast for, and the user can watch items there. Every input is local: the user's own reads and saves,
the in-memory market, repo meta and `scraptf_watches`. New files: `src/shared/bankStockNotify.ts`,
`src/service/domain/watches.ts`, `src/renderer/watchesModel.ts` and `components/WatchForm.tsx`, `WatchSection.tsx`,
`WatchDialog.tsx`, `WatchesCard.tsx`; `src/shared/watches.ts` is completed from Foundation's seed. F17's "From 0.8"
paragraph lists the kinds, titles, gates and dedupe; F20 the click order.

- **G2 "Cheaper on scrap.tf".** A row the read made cheaper (diff 'cheaper') that is a flip now and whose previous
  price was over today's Pay up to (`bankStockDroppedIntoFlip`, judged at today's book: "now under Pay up to") is told
  `Cheaper on scrap.tf (<Bank>): <name>`, `<prev> → <cost>, now under Pay up to <max>; …`. It takes the place of the
  engine's "Profit:" for the same find (`told(base)`). A window read that wrote a save also reports the count
  (`ImportResult.droppedFlips`, `BankStock.droppedFlips`: newFlips' look rule, so a first save or a re-import has none),
  and the toolbar says "10 flips (2 new, 1 cheaper)".
- **G1 watches.** `scraptf_watches` (V15): a base SKU, a copy (`special_key`: a bank_stock special key, '' a clean
  copy, NULL every copy; one watch per copy, the unique index `scraptf_watches_copy`), the item's name from the app's
  data, a price target as typed (`max_cost_keys` + `max_cost_scrap`, valued at each read's key price), a profit target
  (`min_profit_scrap`), "back on sale" (`on_restock`), on or paused, the times; `remind_at` stays NULL (T9 is not
  built). RPCs: `watches.list` (optionally one item's, any SKU of it; each watch with where it stands now:
  `watchViewsOf` over `BankStock.watchRows`, the shown pages' newest on-sale rows of the watched bases), `watches.upsert`
  (`watchWriteOf`: an update keeps what it leaves out; refusals `WATCH_EMPTY`, `WATCH_ZERO_PRICE`, `WATCH_GONE`,
  `WATCH_COPY_TAKEN`, `WATCHES_FULL` at `WATCHES_MAX` = 200), `watches.delete` and `watches.restore` (Undo of a
  removal: the same watch back with its id and times, `watchRestoreOf` and `Repo.restoreWatch`, so its per-watch dedupe
  still holds and it is not judged afresh; a second Undo returns it; `WATCH_COPY_TAKEN` when the copy was watched again
  since, `WATCHES_FULL` at the cap); each write runs core's
  `watchesChanged` (the cache re-read, the snapshot watch list dropped, holdings told, `watches.changed` pushed). The
  cache (`createWatchCache`) never throws: a failed read keeps the last list. The edge is stateless: a watch fires
  when the row meets it (`watchMetOf`) on a read whose diff says new or cheaper, or when the watch is fresh (made or
  edited after the page's previous save, or a first save); a same-price re-read, a pricier price or key drift alone
  never fires. Gates: `notifications.enabled`, `notifications.watches` (default on), the profit target's confidence and
  verified-order gates, the cost checks for a price hit and the flip suspect checks for a profit hit; /items family rows
  never fire. Dedupe per watch (`<bank>|<base>|w<id>`, 30 min, in `bankStock.lastNotified`), exempt from S3's key,
  held back by `toldBefore` only for an engine toast at or after the look's save, recording S3's key too; `told(base)`
  only when the toast tells a flip the engine would tell (`tellsFlip`); a doubted sale quotes no profit (`doubt`); one
  cap of 3 per look with the other kinds, then one summary. Path B (engine):
  a typed or imported opportunity of a watched copy is toasted at the watch's profit target instead of
  `notifications.minProfitScrap` (`watchFloorOf`, the lowest of the covering watches), titled `Watch: <name>`; every
  other gate is unchanged, and the bar cannot go below `profit.minProfitScrap`. Watched bases join `core.watchedSet()`
  (the snapshot job's list, the feed's kept sell listings and the 30-min `pricedb-watched` bulk refresh, as held items
  do) and holdings' exit record (`markBases`, D10).
- **G1 UI.** "Watch on scrap.tf…" in the item menu (`ItemMenuAction` `'watch'`, after *Open on scrap.tf*; a row that
  prices one copy carries it, `ItemMenuTarget.special`: a Bank stock row its key's copy, an Opportunities row its
  `copyKey` (`oppMenuTarget`), a Prices row `opportunityCopyKey` of its SKU and extras (`priceMenuTarget`), a scrap.tf
  change its `specialKey` (`changeMenuTarget`), since imports keep a painted or kit copy under the plain base SKU and
  "This copy" would otherwise be the clean one; a row without a copy, the SKU's own) opens the Watch dialog (`useWatchDialog`, modelled on Record
  trade: a portal into the modal around the opener, a focus trap, Escape closes, focus goes back). The drawer's
  "scrap.tf watch" section (between the scrap.tf history and the price list) lists the item's watches with their copy,
  targets and where each stands ("At your target: 1.88 ref on Hats", dated by the save in its title), Pause/Resume and
  Remove with Undo, then the form: *This copy* / *Any copy*, "Tell me when it costs at most" (the price unit pref),
  "or makes at least" (ref), "Tell me when it is back on sale", with the boundary note and what keeps watches silent
  (`watchNotifyNote`). The Banks page lists every watch ("Your scrap.tf watches", `n of 200`). A Bank stock row carries a
  watch tag after its extras tag (`bankStockWatchTag`: *At target*, *Profit target*, "0.11 ref over", *Watched*), and
  the page re-reads on `watches.changed`; the Watched chip is Foundation's (D6). Nothing in these opens or loads a page.
- **G3 + LC-7 "Back on scrap.tf".** One restock rule, `scraptfIsRestock` (diff 'new' and seen before on the bank's
  runs at the look's save time: `scraptfSeenBefore`), shared with the change feed's 'restocked': a new flip that is a
  restock is told `Back on scrap.tf (<Bank>): <name>` ("on sale again in your saves", never "just"), a never-seen one
  `New on scrap.tf` as before. A watch with "back on sale" also tells its copy on sale again (or first seen), flip or
  not, with "you watch it (<targets>)". A flap can give a "Back" toast (D20); the 30-minute dedupe bounds it.
- **G5 summary links.** Summaries carry `openBankStock { bank, filter }` (an in-app route, never a URL): Watched when
  the summary holds watch hits, New for new and back, Flips for cheaper and Buy now (`bankStockSummaryChip`). A summary
  of new flips only keeps 0.7.4's text and opens on New. Main's `notifySchema` drops a bad value (the toast stays) and
  the click checks it again (`notificationBankStock`); `'app.showBankStock'` accepts 'watched' (D7).
- **G4 "Buy now", opt-in.** Behind `notifications.buyTiming` (off by default, D25) and the scrap.tf flips switch: a
  Wait→Buy now transition between two consecutive told looks of the page that coincides with a drop since the Wait
  streak began or with the first Wait's horizon passing, never the copy merely aging across a pooled event time, never
  on not-enough-data, over or no-buyers. The body says "an estimate from your saves, not a forecast". The Wait memory
  (`bankStock.timing`, 7 days, 5,000 entries) is neither read nor written while the switch is off. With the switch on,
  a New, Cheaper or Back flip toasted while its own timing reads Wait says so ("your saves say it may drop again
  (Wait)" after a drop in the copy's current run, "your saves say it may drop (Wait)" for a copy that has not dropped
  yet, such as a never-seen listing read on the bank's pooled saves); with it off (the default) those toasts carry no
  timing text, so a new flip's toast reads exactly as 0.7.4's
  (`bankStockNoticeOf(…, timing)`, the notifier's `timingOn`).
- **Settings.** `notifications.watches` ("Your scrap.tf watches", default on, changes nothing until a watch exists) and
  `notifications.buyTiming` ("Buy now after Wait (estimate from your saves)", default off) in Settings → Notifications,
  after the relabelled "New, cheaper or back-in-stock flips on scrap.tf pages you save" (`notifications.newOnScraptf`,
  which keeps "Cheaper" and "Back" since they replace toasts 0.7.4 already sent). Caveat: with "Buy now" on and
  `notifications.dedupMs` raised above 30 min, a "Buy now" toast can come inside that window where the engine would
  have stayed quiet.
- **Schema.** V15's `scraptf_watches` (Foundation); `bankStock.timing` is repo meta, no table.
- **Boundary.** No request kind and no budget, cadence or endpoint was added or raised. Watched items join the watched
  list as held items did in 0.7.4: the snapshot job (inside its budget), the feed's kept sell listings (storage only)
  and the 30-min `pricedb-watched` bulk refresh (at most 2 more PriceDB requests per run at the cap of 200 watches,
  inside PriceDB's budget). Notifications run only on the user's own reads and saves (R1, R10), carry no URL beyond the
  existing re-save reminder's, and nothing is bought (R4). The new modules are held to the F20 scan (`static.test.ts`,
  `F20_FILES`); the mock sends no notifications, so the notifier and path B have no mock counterpart, but the mock's
  watches, rows and chips come from the same shared rules (`mockWatches.test.ts`).
- **Tests.** `test/shared/watches.test.ts`, `bankStockNotify.test.ts`, `test/domain/bankStockNotifyKinds.test.ts`,
  `bankStockWatchNotify.test.ts`, `bankStockTimingNotify.test.ts`, `engineWatchFloor.test.ts`,
  `test/service/watchesRpc.test.ts`, `watchesCore.test.ts`, `test/renderer/watchesModel.test.ts`, `mockWatches.test.ts`
  (parity), `watchSection.test.ts`, `watchesCard.test.ts`; changed `bankStockNotifyAge.test.ts`, `notify.test.ts`,
  `ipc.test.ts`, `scraptfWindowWiring.test.ts`, `importWindowRead.test.ts`, `scraptfWindowModel.test.ts`,
  `mockScraptfWindow.test.ts`, `bankStockModel.test.ts`, `bankStockPage.test.ts` (the menu target's copy),
  `settingsFields.test.ts` and `static.test.ts` (`F20_FILES`).

### Tests and version

- **New test files.** 48: 5 from Foundation, 43 from the packages (each package's mock parity test marked), 1 from
  integration.
  - Foundation: `test/db/audit-v15-journal-fees.test.ts`, `test/db/watches.test.ts`, `test/db/holdingMarks.test.ts`,
    `test/service/contracts080.test.ts`, `test/shared/bankStockFilters080.test.ts`.
  - Profit: `test/shared/buyerDepth.test.ts`, `test/shared/profitPath.test.ts`, `test/domain/engineSingleExit.test.ts`,
    `test/domain/marketBuyerDepth.test.ts`, `test/renderer/mockProfit080.test.ts` (parity),
    `test/renderer/profitText080.test.ts`.
  - Journal: `test/shared/journal.test.ts`, `test/shared/venues.test.ts`, `test/renderer/journalModel.test.ts`,
    `test/renderer/journalReport.test.ts`, `test/renderer/mockJournal.test.ts` (parity),
    `test/service/journalRpc.test.ts`.
  - Cycles: `test/shared/scraptfLifecycle.test.ts`, `test/shared/scraptfTiming.test.ts`,
    `test/shared/scraptfTurnover.test.ts`, `test/shared/scraptfLifecyclePerf.test.ts` (in `TIMED`),
    `test/renderer/timingModel.test.ts`, `test/renderer/mockCycles.test.ts` (parity),
    `test/service/oppsTimingRpc.test.ts`.
  - Holdings: `test/domain/holdingMarks.test.ts`, `test/domain/asks.test.ts`, `test/domain/holdingsExits.test.ts`,
    `test/domain/holdingsDetail.test.ts`, `test/shared/holdingAdvice.test.ts`, `test/shared/holdingsAsks.test.ts`,
    `test/renderer/holdingsAdvice.test.ts`, `test/renderer/holdingDetailModel.test.ts`,
    `test/renderer/drawerHolding.test.ts`, `test/renderer/mockHoldings08.test.ts` (parity),
    `test/renderer/settingsOwnAccounts.test.ts`.
  - Alerts: `test/shared/watches.test.ts`, `test/shared/bankStockNotify.test.ts`,
    `test/domain/bankStockNotifyKinds.test.ts`, `test/domain/bankStockWatchNotify.test.ts`,
    `test/domain/bankStockTimingNotify.test.ts`, `test/domain/engineWatchFloor.test.ts`,
    `test/service/watchesRpc.test.ts`, `test/service/watchesCore.test.ts`, `test/renderer/watchesModel.test.ts`,
    `test/renderer/mockWatches.test.ts` (parity), `test/renderer/watchSection.test.ts`,
    `test/renderer/watchesCard.test.ts`.
  - Integration: `test/shared/audit-080-docs.test.ts`.
- **What pins the round.**
  - `test/shared/audit-080-docs.test.ts`: this section names every shipped id (PC-1, PC-2, H2, J1-J6, H5, T1–T7,
    LC-3–LC-7, G1–G5, H1, H3, H4, H6–H8, V15) and the four settings keys, states the boundary, has a subsection per
    package whose test files exist, gives `package.json`'s version and keeps no build marker; the README has "New in
    0.8" (before 0.7.4's notes, with the boundary in its intro and the toasts the code sends) and the three 0.8 known
    limits.
  - `test/shared/audit-074-docs-consistency.test.ts` still holds over the new text: the installer path equals
    `package.json`'s version (review R41); the ownership table has a row for every `src/shared` module both the mock
    and the service import (`journal.ts`, `venues.ts`, `scraptfTiming.ts`, `watches.ts`, `bankStockNotify.ts` and
    `holdingAdvice.ts` among them, D22) and `ceiling.ts` keeps its cost-check names; the README's current text, "New
    in 0.8" included, keeps its counted phrases (so the 0.8 text says "seen in the last 24 h", never "in the last day").
  - `test/compliance/static.test.ts`: `F20_FILES` holds cycles', holdings' and alerts' new modules (no request, socket,
    URL opener, `href=`/`src=` or http text, and no import of electron, node:http(s)/net or `../net`), `asks.ts`
    included, `JOURNAL_FILES` the journal's; every `src/service/domain` or `src/shared` module that 0.7.4 did not ship
    (`DOMAIN_AND_SHARED_BEFORE_080`, frozen) must be in one of the two, a domain module in `F20_FILES`, so a new module
    cannot miss the scan; `nonStaticOpenUrls` still finds only
    `scraptfResaveNotice`, and `notifyOpenProblems` one `openExternal`, guarded and first in main's click deps; the F21
    window checks are unchanged.
  - `test/shared/profitPath.test.ts`: friction is read and subtracted only on the profit path and in the two sales into
    a live order, and every buy decision's file calls `flipProfit` (`scraptfTiming.ts` and `holdingAdvice.ts` added by
    integration).
  - The migration pins (D1): audit-v14 checks migration 14 with `MIGRATIONS.slice(0, 14)` and `SCHEMA_VERSION >= 14`,
    `db.test.ts` lists `holding_marks` and `scraptf_watches`, and `SCHEMA_VERSION === MIGRATIONS.length` (15).
- **Totals.** `npx vitest run`: 545 test files and 7,546 tests, all passing, the timed group included (0.7.4: 497 files
  and 6,847 tests); `npm run typecheck` clean; `npm run build` succeeds.
- **Version.** 0.8.0 (`package.json`, `package-lock.json`'s root entries; README's installer path, which
  audit-074-docs-consistency pins). The mock's `MOCK_APP_VERSION` reads `package.json`.

## 0.9 round: exit fees and break-even, risk ranking, order history, honest buy timing, scrap.tf evidence and the trade lock

Six feature packages and a docs package on 0.8.0, built in two waves on one Foundation, from the ranked improvements
of the 2026-10-22 research (`docs/RESEARCH.md` §8; the `#` numbers below are its ranks). Foundation landed every
cross-package contract first (Schema V16, the shared types, two RPC methods, three settings keys, five seeded shared
modules and the compile-only edits that widened unions force), so each package built on code that already compiled
and left the tree green. Wave 1 was **exits** (#2, #11, #14: exact exit fees and a break-even price per exit, buyer
signals without the daily impersonator list, compliance hardening), **scrap.tf** (#9, #13, #25, #22: the checkout
guard, parser evidence and the bank-not-trading notice, the *Unsupported by scrap.tf* panel, effect names per kind of
item) and **holdings-ledger** (#1, #17: the trade lock, the trend size and key move band, the Journal's inventory
valuation); Wave 2 **ranking** (#3, #12: risk-aware sort keys, the depth gate, the suggested price-move reserve),
**history** (#6, #7: buy-order persistence, recorded community prices, scrap.tf lows), **timing** (#10: ranges on buy
timing and the Wait gate on the gain's low end) and **docs** (the DESIGN_BRIEF corrections and the FIELDS.md rows);
then an integration pass (the version, the README, this introduction and "Tests and version", the duplicate imports,
the build markers and the docs test). Every code package wrote its own subsection below, its ownership rows, its
feature-section notes and its entry points (D16); every rule lives in `src/shared`, so the service, the dashboard and
the browser mock share it, and each package has a mock parity test. Decisions D1-D30 are the build plan's settled
conflicts between the package specs, named where they apply. New settings: `profit.marketplaceFeePct` (0.1, for
marketplace.tf's break-even and fee hint only), `notifications.minProfitableDepth` (0, off) and the top-level
`tradeLock` (`{ mode: 'unknown', answeredAt: null }`). Defaults keep 0.8's behaviour except these deliberate changes
(D26), each explained in its subsection: rows whose revenue order had the online flag score 5 lower
(`notifications.minConfidence` stays 45, D30), inactive and impersonator orders leave the book, object-form bans
follow the `users/info` rule, the Steam Market's daily cap, `x-eresult` 25/84 as a rate limit, a challenge marker
disabling its host at any status and the F21 window refusing a 200 check page (exits); *Wait* gated on the gain's low
end, measured against max(evBuy, 0) (timing); the guard's toast suffix and the bank-notice import (scrap.tf); the
one-time rewrite of stored opportunities (ranking); and the Journal's *Unrealised P/L* card and the Holdings question
card (holdings-ledger). Every new figure shows its n, says "not enough data" with a reason rather than guess, and is
never a forecast: break-even is a price to clear, buyer counts are demand, not sales, order persistence is never a
fill rate, and the confidence score still multiplies nothing.

**Boundary unchanged** (R1-R10): no request kind, host, endpoint, credential or cadence was added, and no budget was
raised (the Steam Market's priceoverview gained a daily cap of 300); every new history is storage of data that already
arrives (the backpack.tf feed, the existing IGetPrices answer, the user's saves); the one new outbound link is Valve's
Trade Protection FAQ, opened only in the user's browser; no `openUrl` beyond an exact SCRAPTF_BANKS page; nothing is
bought, queued, listed or traded (R4). `x-eresult` and the challenge markers only stop or pause requests, and
`history('5021;6')` filling PriceDB's key curve cache can only save a later identical request. Flip Desk still sends
no request to scrap.tf (R1), and scrap.tf data still comes only from the user's typing, saves and window reads (R10).
The one migration (V16) holds only nullable `ALTER TABLE … ADD COLUMN` and `CREATE TABLE` / `CREATE [UNIQUE] INDEX`
statements, with no row read or rewritten (a 0.8 build refuses a V16 database), and `test/compliance` passes with the
new modules in its scans.

### Schema V16 and contracts (Foundation)

Foundation lands every cross-package contract first, so the packages build on types, methods and tables that already
compile and are tested. It adds no request kind, host, credential, endpoint, budget or cadence, and at its hand-off
nothing it added changed what the user sees, apart from these: `opps.list` accepted the sorts `backup` and `depth`
(nothing in the dashboard asked for them yet); the Live market's Sort select listed *If this buyer leaves* and *Buyers
at break-even*, which sorted by name until ranking filled them; settings files gained three keys with their defaults;
the Holdings advice texts knew a `locked` kind that nothing produced yet (holdings-ledger's trade lock does).

- **Schema V16 (`V16_ROUND_090`, migrations.ts), the release's one migration (D1).** Only nullable `ALTER TABLE …
  ADD COLUMN` and `CREATE TABLE` / `CREATE [UNIQUE] INDEX` statements; no row is read or rewritten, so upgrading loses
  nothing, and a 0.8 build refuses a V16 database (SchemaVersionError / DataTooNewScreen) as for every migration. V15
  and every earlier migration are unchanged.
  - `listings.user_impersonated INTEGER` (exits, #11): backpack.tf's `user.flagImpersonated`; NULL is "not flagged
    or not known" (every row before V16, snapshot rows), 1 flagged. The repo reads only a flagged row with the
    `userImpersonated` key, so every 0.8 row reads back as it did.
  - `opportunities.backup_profit_scrap`, `profitable_depth`, `book_depth INTEGER` (ranking, #3): NULL on every row
    stored before V16 until the engine's first full sweep rewrites it, as V2's `max_cost_scrap` was; NULL reads absent.
  - `order_spells` (history, #6): one row per spell (one buy order at one price as the live feed showed it), with no
    SteamID, listing id or name. Indexes `order_spells_base_first (base_sku, first_seen_at)` (the per-base read),
    `order_spells_first_seen` (retention) and the partial `order_spells_open (id) WHERE end_kind IS NULL` (the two
    updates of every followed spell). Every cut selects on `first_seen_at`, the spell's entry, never on its end: a cut
    on the end keeps long spells and drops their short siblings, which biases Kaplan-Meier up.
  - `bptf_community_history` (history, #7): recorded community prices, one row per distinct price per SKU and source
    through the unique expression index `bptf_community_history_point` (NULLs folded with `IFNULL`, as V10 and V15
    do), and `bptf_community_history_recorded` for retention. `bptf_community` is still overwritten as before.
  - `scraptf_lows` (history): a copy's lowest on-sale price in the user's saves, per bank, raw keys + metal, keyed
    `(bank, sku, special_key)`, with `scraptf_lows_seen` for retention.
  - `import_batches.bank_notice TEXT` and `bank_stock.markdown TEXT` (scrap.tf, #13): a bank page's own "not trading"
    notice and a card's price-drop wording ('off', 'soon' or 'off soon'); NULL reads absent.
- **Pins (D1).** `test/db/audit-v15-journal-fees.test.ts`, `watches.test.ts` and `holdingMarks.test.ts` migrate with
  `MIGRATIONS.slice(0, 15)` to pin V15 itself; `db.test.ts` lists the three new tables; `bankStock.test.ts` and
  `importBank.test.ts` append the new columns; `SCHEMA_VERSION === MIGRATIONS.length` (16).
- **Repo (`repo.ts`, implemented and tested, D2).** Listings and opportunities round-trip the V16 columns, and
  `OPP_SORT` orders `backup` and `depth` with missing values last in both directions, ties by profit, name and key.
  `holdingMarksSince` (ranking: every base's runs with `to_at` since a time, the newest 50,000 at most). The order
  spells (`insertOrderSpell`, `endOrderSpell` (an ended spell is never ended again; its `last_seen_at` becomes its end),
  `touchOpenOrderSpells` (but the tracker's held rows), `endOpenOrderSpells` ('unwatched', censored at `last_seen_at`),
  `orderSpells` (after the whole-table cap's entry cut), `pruneOrderSpells`: ended spells only, 60 days, 300 per base,
  400,000 in all). The community history (`communityFor`, `insertCommunityHistory` (INSERT OR IGNORE, the currency
  lower case and cut to 16, a high equal to the low stored as NULL),
  `communityHistory`, `pruneCommunityHistory`: 365 days, 200 per SKU, 300,000 in all). The scrap.tf lows
  (`scraptfLows`, `upsertScraptfLows`, `pruneScraptfLows`: 365 days after `seen_at`). `createImportBatch` stores
  `bankNotice`, and `insertBankStock` stores a card's wording on a bank page's rows (never on `/items` rows).
- **Contracts (`contracts.ts`).** `FeedBatch.inactive` (required: ids among `deletes` that a listing-update reported
  not live; the socket's flush sent `[]` until exits filled it), `FeedBatch.community?` (`FeedCommunityPrice`) and
  `FeedBatch.epoch?` (history); `SchemaService.effectIdByName(name, type?)` (scrap.tf, #22; the test doubles stay
  assignable); `PriceDb.loadedKeyHistory()` (holdings-ledger, #17; a `() => null` stub in the connector until Wave 1
  filled it).
- **RPC (`src/shared/rpc.ts`, no push, D14).** New methods `profit.reserveSuggestion` (ranking, #12) and
  `item.bookHistory` (history, #6/#7), both local reads. Their service and mock bodies were stubs that threw "… is not
  built yet." until Wave 2 replaced them (integration's grep of `src/` finds none left); `item.bookHistory`'s zod (a
  SKU and at most `BOOK_HISTORY_ORDERS_MAX` (5) order ids) and the mock's matching checks are final. The preload and
  main forward every `SERVICE_METHODS` entry, so neither changed.
- **Settings (three keys, defaults keep 0.8's behaviour, D3).** `profit.marketplaceFeePct` 0.1 (0 to 0.5; used for
  marketplace.tf's break-even and the journal hint only, never for profit), `notifications.minProfitableDepth` 0 (off;
  whole buyers up to `MIN_PROFITABLE_DEPTH_MAX`, 10) and a top-level `tradeLock` `{ mode: 'unknown', answeredAt: null }`
  (`'unknown' | 'none' | '7d'`). A settings file from 0.8 loads with those values through the lenient load, unreported;
  the Settings controls come with their packages.
- **Seeded modules (D13).** `src/shared/exitRisk.ts` and `reserveSuggest.ts` (ranking completes them),
  `orderPersistence.ts`, `communityHistory.ts` and `scraptfLows.ts` (history completes them), each holding only the
  constants a Foundation file reads (the settings maximum, the repo's read caps and retention defaults, the
  `item.bookHistory` zod). They were listed in `F20_FILES` from the start, where their packages' other modules joined
  them. scrap.tf's two pure markdown helpers (`bankStockMarkdownText`, `bankStockMarkdownOf`) sit in
  `src/shared/bankStock.ts`.
- **Compile-only edits (D12).** The widened unions and new required fields compile with final behaviour wherever a
  case reads only typed fields: `oppModel` `sortValue` and the shared `market.ts` `sortValue` read the risk keys
  (absent sorts last), `MARKET_SORTS` and `SORT_LABELS` gain `backup` and `depth` together, the service market
  index's `sortValueOf` returned null for both until ranking, the Holdings advice texts know `locked`
  (`ADVICE_LABELS`, `ADVICE_TONES`, `ADVICE_HELP`) and the reasons `trade-locked`, `units-locked` and `trend-size`,
  `timingWhyText` knows `unsure-gain`, and the six new `ImportReport.counts` fields started at 0 until scrap.tf counted
  them.
- **The 0.8 docs test (D15).** `test/shared/audit-080-docs.test.ts` ends the 0.8 round's slice at this section, so the
  0.8 checks never read 0.9 text.
- **Tests.** `test/db/v16Round090.test.ts` (the schema, the indexes the reads use, and 0.8 rows read back unchanged),
  `test/db/listingsImpersonated090.test.ts`, `test/db/opportunitiesRanking090.test.ts`,
  `test/db/orderSpells.test.ts`, `test/db/communityHistory.test.ts`, `test/db/scraptfLows.test.ts`,
  `test/db/audit-v16-scraptf-columns.test.ts` and `test/service/contracts090.test.ts` (both methods routed, zod-checked
  and answered by the mock); new cases in `test/main/settingsSchema.test.ts` and `test/shared/defaults.test.ts`.

### Exits: fees, break-even, buyer signals, hardening (#2, #11, #14)

Local arithmetic, parsing of data that already arrives, and tighter guards. Nothing adds a host, credential, request
kind, endpoint or cadence, and no budget rises. Every profit number, verdict, Pay up to and notification keeps 0.8's
behaviour, with these deliberate changes (A.2): the online bonus is gone (below), inactive and impersonator orders
leave the book, object-form bans use the stricter rule, and the hardening of #14.

- **Break-even (`breakEvenFor`, `breakEvensOf`, `src/shared/ceiling.ts`).** The lowest whole-scrap backpack.tf sale
  price that loses nothing at a cost. `'buy'` (every buy decision) is the smallest R ≥ 0 with
  `flipProfit(R, cost, p) >= 0`, so friction and the price-move reserve are in it and it goes through the one profit
  path (a short bisection over `flipProfit`); because `flipProfit` never falls as R grows, R ≥ break-even exactly when
  `flipProfit(R) >= 0` for every whole R (the equivalence ranking counts on). `'sell'` (a held lot sold into a live
  order, Holdings) is `ceil(cost + friction)`, never the reserve, as `holdingFigures` judges a sale. Thresholds (min
  profit, margin) are Pay up to's job, not break-even's. Worked: cost 100, friction 0, 7% → 108; friction 1, 5% → 107
  ('sell' 101). A price to clear, never a forecast that a buyer pays it.
- **Other exits, in value (D21, E-D2).** marketplace.tf and mannco.store pay cash and the Steam Market Wallet funds;
  Flip Desk has no rate between ref and either, so `breakEvensOf` gives the value a sale must bring in before the
  venue's fee, at the user's key value: `grossBeforeFee(backpack, fee)` for marketplace.tf (`profit.marketplaceFeePct`,
  default 0.1, 0 to 0.5; used for this and the journal hint only, never for profit) and mannco.store (5%), and
  `scmGrossValue` (`ceil(net × 1.15)`) for the Steam Market. The 1-cent minimums need dollars, so the texts say "each
  fee is at least $0.01, so items under about $0.20 need more".
- **The cent rules (`src/shared/venues.ts`).** `scmBuyerPaysCents` (received + Steam's 5% + TF2's 10%, each floored
  and at least 1 cent: 100 → 115, 193 → 221, 1 → 3) and its inverse `scmSellerNetCents` (the largest r with
  f(r) ≤ p: 115 → 100, 221 → 193, 116 → 101, 114 → 99; null under 3), `manncoNetCents` (price − max(1, floor 5%), all
  of a 1-cent sale: 100 → 95, 101 → 96, 20 → 19), `parseUsdCents` / `usdText`. mannco.store is a journal venue
  (`JOURNAL_VENUES`, aliases `mannco`, `manncostore`), and the journal's fee hints are built from the rules, so the
  examples never drift; marketplace.tf's names the user's setting (`venueFeeHint(venue, side, marketplaceFeePct?)`,
  `feeHint` in the Record trade dialog and the Journal form).
- **Where break-even shows (`src/renderer/breakEvenModel.ts`, pure).** Opportunities' Cost hover (`oppCostTitle`,
  after "Entered as …" for a keyed price) and its CSV's `break_even_ref`, appended after `updated_at`
  (`opportunitiesCsv(rows, keyScrap, profit)`; the mock's CSV appends `break_even`); the drawer input card's
  *Break-even* line; Quick entry's *Break-even* line for the typed price; the Live check popup beside the scrap.tf
  price (`CheckResult.breakEven`, set by `liveCheck.ts` and the mock's evaluator and demos whenever a check has a
  price); Holdings' Cost hover (`holdingBreakEvenTitle`, 'sell'). Each hover names friction and the reserve when above
  0, every venue's value and the not-a-forecast sentence; a rule row says its cost is an estimate. The model reads
  `BreakEvens.frictionScrap` only by destructuring (D7), so the profit-path scan stays as it was.
- **The drawer's Steam Market check.** `scmNetView` says what the seller receives at the lowest and the median price,
  exact to the cent ("You get $1.93 of the $2.21 lowest (Steam and TF2 keep $0.28, 12.7%) …, in Steam Wallet funds,
  not cash"), from the one priceoverview the click already returned; "about 15% fees" is gone. The mock's `item.scm`
  answers in Steam's "$" text so the line shows in a plain browser.
- **Settings.** Profit thresholds gains *marketplace.tf fee* (`MARKETPLACE_FEE_PCT` 0 to 50%, `MARKETPLACE_FEE_HINT`:
  about 10% rests on one 2019 forum report, check your seller page; Flip Desk reads nothing from marketplace.tf).
- **The online bonus is removed (#11, D30).** `scoreConfidence` and the mock no longer add "+5 Buyer is online": the
  live feed sent `user.online: true` on all 299 captured events (RESEARCH §4.2), so it said nothing. A row whose
  revenue order had the flag and an event within 2 h scores 5 lower; `notifications.minConfidence` stays 45. The online
  dots and `buyerPresenceText` still display the flag.
- **Inactive listings leave the book (E-D4).** `bptfListingActive`: a feed update or snapshot row with `archived:
  true` or a `status` of `listingInactive`, `hiddenByUser`, `notEnoughCurrency` or `archived` (any case, spaces
  ignored) is not live. The socket turns such a `listing-update` into a delete and reports it in `FeedBatch.inactive`
  (a later active update brings it back; a delete in the same window is a plain delete), so core deletes and
  tombstones it as any delete; a snapshot row is skipped. An unknown status, or a non-string one, is kept and counted
  in `BptfMapStats.unknownShapes.status`, so a renamed status never empties the book; `BptfMapStats.inactive` counts
  the dropped ones.
- **Impersonators (E-D5).** `user.flagImpersonated === true` sets `Listing.userImpersonated` (V16
  `listings.user_impersonated`), which raises the excluding flag `'impersonator'` ("Impersonator", tone bad) on buy
  orders (`classifyOrder`) and sell listings (`sellSummaries`), and the ask side excludes such sellers. It is not
  folded into `userBanned`, so the drawer says "Impersonator", not "banned". A snapshot row keeps the stored flag
  (`withStoredUserData`), as a ban is kept. The daily impersonator list is not fetched (D22).
- **Bans in object form (E-D6).** The feed's and the snapshots' `user.bans` are read with `isBannedFromBans`, the
  `users/info` rule moved into `bptfItem.ts` (bptfApi.ts re-exports it): a non-empty array is a ban, as before; an
  object counts only `all`, `steamrep_scammer`, `marketplace` and `valve.economy` (`{steamrep_caution: 1}` is no
  longer a ban).
- **Bot-service labels (E-D8).** `OrderSummary.botService` (`botServiceOf` over the first part of
  `userAgent.client`: TF2Autobot (PriceDB), TF2Autobot, Gladiator.tf, cobra.tf, Dolphin, Merchant.TF,
  Quicksell.store) is a label in the drawer's order book (the bot icon's hover, `botServiceTitle`, and a muted name).
  It changes no score, flag, eligibility, Instant or `isBot`; the mock sets none.
- **Hardening (#14).**
  - The Steam Market's priceoverview budget gains `maxPerDay: 300` (a rolling 24 h, seeded at start), under the
    community-measured 1,000.
  - An api.steampowered.com answer with `x-eresult` 25 or 84 (`steamRateLimitEresult`) is a rate limit even with
    status 200: the budget pauses, the host streak counts, and the caller sees the true status with `ok: false`.
  - Any HTML answer carrying a Cloudflare challenge marker (`hasChallengeMarkers`: the interstitial's
    `/cdn-cgi/challenge-platform/[h/<x>/]orchestrate/` script, `_cf_chl_opt`, `cf-chl` ids, the Turnstile host, a
    "Just a moment..." title) takes R7's challenge path whatever its status: the host is disabled until the user
    re-enables it on Data health ("challenge page (Cloudflare challenge script, HTTP 429)"). An HTML 429 without one
    stays a 429. Only challenge-specific signatures count: Cloudflare's JavaScript-detections snippet
    (`__CF$cv$params`, `/cdn-cgi/challenge-platform/scripts/jsd/main.js`) sits on ordinary pages, so an nginx 429 or a
    5xx outage page carrying it keeps its status's own path (backoff pause, then retry), as in 0.8
    (`test/fixtures/net/bptf-429-jsd.html`).
  - `test/compliance/static.test.ts` holds a deny-list of scrap.tf automation signatures (the /ajax actions bots
    call, the queue-confirmation hook, the session cookies by name, the CSRF hash object, the anti-detection drivers)
    that must not appear in `src/`, and no browser-automation package may be a dependency.
  - `policy.ts`'s STN comment now says the trade calls are POSTs (RESEARCH §4.5); the rule is unchanged.
  - The F21 window's `readPage` refuses a page carrying a check page's own words (`scraptfChallengeIn`,
    `SCRAPTF_CHALLENGE_PHRASES`: scrap.tf's captcha and browser-check sentences, the interstitial's `<title>`, its
    options object) whatever its status: nothing is imported, held or remembered, the page notice
    (`SCRAPTF_WINDOW_NOTICES.challenge`) stops automatic reads until the next document, the pushed read carries that
    notice (worded "Could not read …" by the toolbar) and `readNow()` returns `SCRAPTF_READ_REASONS.challenge`.
    Cloudflare's bot-detection script path is left out on purpose (it may sit on ordinary pages).
- **Mock parity.** The mock's confidence drops the bonus, its Live check and popup demos carry `breakEvensOf`, its
  Opportunities CSV appends `break_even`, and fees and settings flow through the shared rules and `mergeSettings`.
- **Tests.** `test/shared/exitFees090.test.ts` (the cent rules, a brute-force inverse over 3..200,000, the hints),
  `test/shared/breakEven090.test.ts` (the flipProfit property and the ranking equivalence), `test/renderer/breakEvenModel090.test.ts`,
  `test/renderer/mockExits090.test.ts`, `test/renderer/settingsExits090.test.ts`, `test/bptf/buyerSignals090.test.ts`
  (the 299 fixture events: all active, the one impersonator, the bot-service tally), `test/domain/impersonator090.test.ts`,
  `test/net/steamEresult090.test.ts`, `test/net/challenge429090.test.ts` (synthetic HTML-429 fixtures
  `test/fixtures/net/bptf-429-challenge.html` and `bptf-429-plain.html`) and `test/shared/scraptfChallenge090.test.ts`;
  new cases in `confidence.test.ts`, `audit-074-cost-sanity.test.ts`, `market.test.ts`, `venues.test.ts`,
  `recordTradeModel.test.ts`, `budgets.test.ts`, `csv.test.ts`, `liveCheckEval.test.ts`, `bptfSocket.test.ts`,
  `scraptfWindow.test.ts`, `mock.test.ts`, `mockContracts.test.ts` and the static compliance scan (the deny-list and
  `EXIT_FILES`).

### scrap.tf: checkout guard, parser evidence, the boundary panel, names (#9, #13, #25, #22)

Text, parsing of pages the user brought, and name rules. Nothing adds a host, credential, request kind, endpoint,
cadence, setting, timer or push, and nothing reaches scrap.tf: the probes read only the parsed tree of the user's own
save or window snapshot (R10), nothing in it is fetched, opened or followed (R1), and nothing is bought, queued, listed
or traded (R4). Two deliberate default changes (A.2): a watch or G4 toast that tells a flip gains the guard's sentence,
and a bank page saying its bank is not trading imports as a look with no stock save.

- **The checkout guard (#9, `src/shared/checkoutGuard.ts`, pure, no address).** Five lines on what to know before
  joining a scrap.tf bank's queue, each naming its source and how sure it is (sources read 2026-10-22, RESEARCH §4.1):
  joining the queue is what reserves the items (help pages, read from search-engine copies); accept the bot's offer
  promptly, since scrap.tf cancels offers after a time it does not publish (help); a lapsed offer can lock buying for
  about 2 hours (community reports on scrap.tf's forum, 2024, not confirmed by scrap.tf); keep one request pending
  (inferred); never leave and rejoin for a lower price (reportedly penalised; R4). It ends "Flip Desk never joins,
  leaves or watches a queue for you." It is text only, shown only where the app suggests buying, with no setting:
  - the Buy now tag's title (`timingBadge` appends `CHECKOUT_GUARD_TAG` last, so every Buy now surface has it: bank
    stock, Live market, Opportunities, the drawer pill; a Wait tag never does);
  - the drawer under a Buy now verdict (`CheckoutGuard variant="list"`, a sibling after `.stf-hist-timing`, never in it);
  - the Live check popup on a flip (`checkGuardLine`: `CHECKOUT_GUARD_POPUP` takes the key legend's line, its title
    the full guard; with a note neither shows, and the keys stay in the buttons' titles and `aria-keyshortcuts`);
  - the Shopping list (`CheckoutGuard variant="line"`, after its info banner);
  - toast bodies that suggest buying: `withCheckoutGuard` appends "Accept the bot's offer promptly." only when the
    body stays at or under 200 characters (`CHECKOUT_GUARD_TOAST_BODY_MAX`; main clips at 400). The S3 notifier sends
    `bankStockNoticeWithGuard` (a watch hit or a G4 "Buy now" with `tellsFlip` and no doubt), and the engine's own
    "Watch: <name>" toast (G1) gets it too. "Profit:" and "Candidate:" bodies, summaries and old-save summaries are
    unchanged, and so is the `notified` event text.
- **A bank that is not trading (#13).** The parser reads visible page text outside cards and rows (not inside
  `hidden`, `aria-hidden`, a `d-none`/`hidden`/`hide`/`invisible` class, a `display:none`/`visibility:hidden` style,
  `noscript`, script, style, template or the title; at most 64 KB) for a notice such as "Hat Banking is temporarily
  disabled" (`BANK_UNAVAILABLE_RE`, linear). A notice counts for a recognised bank page only when it names no bank or
  names the page's own (`NOTICE_WORD_BANKS`: "Hat" for /buy/hats, "Item" for /buy/items and the list, "Unusual Hat"
  for /unusuals, and the items bank's kinds "Australium", "Taunt", "Paint", "Crate" and "Tool" for /buy/items).
  "Key", "Card", "Auction" and "Raffle" name no page Flip Desk reads, and any other word right before a bare "banking"
  ("Promo Banking is …") names a category too (`noticeWordBefore`), so a banner about another category never turns
  every bank look into a notice look. Recheck: the site, determiners and the ordinary lead-ins a banner puts there
  without punctuation name none (`NOTICE_LEAD_WORDS`: "All", "The", "Our", "Scrap.TF" or "Scrap.TF's",
  "Unfortunately", "Currently", a bold "Notice" or "Warning" label, "Please note", "… maintenance", "… and"), so a
  page-wide notice in those forms stays the page's own: a missed notice would read the copies the page leaves out as
  sold, while a false one only skips one bank stock save. Block elements, cards and rows
  break the probe text (`PROBE_BREAK`), so a heading or nav link before a notice is never read as its word. Then:
  - the page warns `bank-unavailable` (`BANK_UNAVAILABLE_WARNING`) in place of `no-cards-saved` / `no-items`, and the
    result carries `bankNotice: 'unavailable'`;
  - `importSavedPage` stores the prices the page shows but no bank stock save (`stockSave: 'partial'`, as a DM-2
    partial look: it replaces only the copies it shows and reads none as gone), so a notice never reads as mass
    sell-outs and a false match never silently stops imports;
  - the batch stores `bankNotice` (V16 `import_batches.bank_notice`), and a window read of such a page with 0 items
    records its batch (it used to record nothing), so the Banks card can date it; main's `WARNING_ORDER` ranks the
    code first;
  - the Banks summary sets `unavailableAt` when the bank's newest notice look is at or after its newest save
    (`bankNoticeNewestAt` over the 500 batches it already reads, `bankUnavailableAt`); a later normal save clears it.
- **Report-first evidence (#13).** scrap.tf's own price-drop wording ("This item will decrease in price shortly.";
  "… off original price" / "(original price of …)"), in a card's tooltip or its own text, is no longer an
  `unparsed-modifier` (a quoted custom description using those words is the owner's own and is read first, as before:
  `customDesc`, no markdown, never quoted in a warning or the report): the card warns `price-markdown`, carries `markdown` ('soon', 'off'), and `bank_stock.markdown`
  (V16) keeps it on bank page rows (never /items rows). A countdown-like text in a card's own text (`price-countdown`),
  a card inside an element whose id or class names "recent" (`recent-section`) and "recently traded" phrases are noted
  for the report only. The report's six counts (`markdownSoon`, `markdownOff`, `countdownCards`, `recentlyTraded`,
  `recentCards`, `bankNotices`) and `notices` (at most 5 matched phrases, scrubbed) say what was seen; such cards are
  kept in the report after the refused ones. Buy timing, profit and alerts never read any of it. The bank stock row
  shows the newest save's wording as a tag (`bankStockMarkdownTag`: *Drops soon* / *Marked down*, tone info), whose
  title says no real save has confirmed the wording. No synthetic fixture holds any of these phrases, and a test pins
  zero false positives over all of them.
- **Names (#22).** The 2026-07-14 TF2 update renamed the hat effect Northern Nights to Polar Prism; sku.pricedb.io
  (2026-10-14) lists 408 "Polar Prism" (cosmetic) and 3221 "Northern Nights" (a taunt effect). `EFFECT_NAME_ALIASES`
  resolves a name per kind of item, wherever the schema does not give that name to an effect of that kind itself
  (`effectTypeForItem`: a skin is 'weapon', slot taunt 'taunt', a `tf_wearable` 'cosmetic'): "Northern Nights Team
  Captain" is `378;5;u408` (it was `u3221`, an effect no hat order can match), and "Northern Nights Taunt: The Shred
  Alert" stays `1015;5;u3221`. `effectIdByName(name)` without a kind answers as 0.8 did; the saved-page parser
  (tooltip effect lines, titles) and the snapshot mapper pass the item's kind. `schema.ts` scopes twins
  (`canonicalId`) by effect kind, so a name two kinds share never merges them (no change on today's data). An alias
  whose id the schema lacks is ignored, and names learned from the feed still win.
- **The visible boundary (#25).** About → *Unsupported by scrap.tf* (`UnsupportedPanel`, rows in
  `src/renderer/aboutModel.ts`): nine things scrap.tf does not offer or allow (automatic monitoring, crawling item
  pages, joining the queue automatically, leave-and-rejoin, queue state, automatic buying, its repricing schedule,
  per-user limits, a developer API), why, and what Flip Desk does instead, each with dated sources graded "read at the
  source", "a search-engine copy" or "a community report" (RESEARCH §6.1, checked 2026-10-22). A source button copies
  its address for the user's browser; nothing opens it (most are not on the `links.open` allowlist, which is
  unchanged). The Appendix C email moved to `aboutModel.ts` (the Import page re-exports and still shows it): it no
  longer says the tool "never connects to scrap.tf", which stopped being true with F21, and asks three more questions
  (the window, the queue and offer timings, a sanctioned feed). The app never sends it.
- **V16 (Foundation, B.1).** `import_batches.bank_notice` and `bank_stock.markdown`, nullable, no default or index; no
  row is rewritten and retention is unchanged.
- **Mock parity.** The mock's banks summary uses `bankNoticeNewestAt` / `bankUnavailableAt` (no seed carries a notice,
  so `unavailableAt` is absent, as in the service); its report counts hold the six fields at 0 and no `notices`; its
  bank stock rows go through the shared `bankStockRows`, so a stored `markdown` passes through; the guard reaches it
  through the shared `timingBadge`, CheckPopup, ShoppingPage and ScraptfHistory. The mock sends no toasts.
- **Known limits.** The markdown, countdown, "recently traded" and notice markup is unconfirmed: the probes may miss a
  real form (the report then shows unparsed lines), and a template hidden only by CSS could match (shown on the Import
  page and the Banks card; the parser report says why). A notice look keeps the prices it shows, so a bank that is not
  trading may still be priced as a flip elsewhere until a normal save, and the Bank stock page itself shows no notice
  line. The alias needs effect 408 in the schema. The guard's timings are community-reported; scrap.tf publishes none.
- **Compliance.** `F20_FILES` adds `shared/checkoutGuard.ts`, `renderer/checkoutGuardModel.ts` and
  `renderer/components/CheckoutGuard.tsx` (no request, loader, opener, `href=`/`src=` or http text). The describe "0.9
  scrap.tf boundary panel and guard (R1, R3)" pins that `aboutModel.ts` and `AboutPage.tsx` call no loader or opener
  beyond About's existing `ExternalLink`s (TERMS and the credits), that no `ExternalLink` takes a row's or source's url,
  that every panel address is `https://`, and that the guard holds no address, with a planted-offender case.
  `test/renderer/externalLinks.test.ts` skips `aboutModel.ts`, whose addresses are copied, never opened (D8). Exits'
  automation deny-list tokens appear in none of these strings.
- **Tests.** `test/shared/checkoutGuard.test.ts`, `test/shared/bankStockNotifyGuard090.test.ts`,
  `test/renderer/checkoutGuardModel.test.ts`, `test/renderer/aboutModel.test.ts`,
  `test/import/parserEvidence090.test.ts`, `test/service/bankUnavailable090.test.ts`,
  `test/shared/banksNotice090.test.ts`, `test/domain/banksUnavailable090.test.ts`,
  `test/renderer/banksUnavailable090.test.ts`, `test/renderer/bankStockMarkdown090.test.ts`,
  `test/renderer/importEvidence090.test.ts`, `test/pricedb/schema.names090.test.ts` (the alias, the type-scoped twins
  and the name-parsing regression pins), `test/import/effectAlias090.test.ts` (a card's tooltip effect and the effect
  in its title, per kind of item) and `test/renderer/mockScraptf090.test.ts`
  (parity); new cases in `checkPopup.test.ts`, `bankStockWatchNotify.test.ts`, `bankStockTimingNotify.test.ts`,
  `engineWatchFloor.test.ts`, `scraptfWindow.test.ts`, `externalLinks.test.ts` and the static compliance scan.

### Holdings and ledger: trade lock, trend size, inventory valuation (#1, #17)

- **Trade lock (#1, RESEARCH #1).** Steam's Trade Protection may keep a TF2 item the user receives untradable (and
  reversible) for 7 days; Flip Desk cannot read the account, so the top-level setting `tradeLock` holds the user's
  answer, `'unknown'` (Not sure, the default), `'none'` or `'7d'`, with `answeredAt` (deviation 13).
  - Holdings asks once (`TradeLockCard`: the question, three answers and Valve's Trade Protection FAQ) until
    `answeredAt` is set; Settings → Trade lock (`TradeLockSection`, after Your accounts) changes the answer, says when
    it was given and, while unanswered, offers *Keep "Not sure" and stop asking*. Every answer is a settings write.
  - An answered Not sure shows one caution line on Holdings and, in the drawer, a dated caution for a next unit bought
    less than 7 days ago. Nothing else changes.
  - With `'7d'` each open lot is locked until its journal time + `TRADE_LOCK_MS` (a lot exactly 7 days old is
    tradable; a time ≤ 0 is never locked). `withTradeLock` sets `HoldingRow.tradeLock` (`holdingTradeLockOf`: locked
    units, the next lot's unlock, the earliest unlock). A row whose next unit is locked reads `'locked'` advice whose
    first reason, `trade-locked`, dates the unlock and names what today's book alone would say (`todayKind`), never
    the price on that day; a row whose later units are locked adds the context reason `units-locked`. `holdingsTotals`
    leaves locked rows out of Sellable now and counts them in `totals.locked` (absent at 0), the card shows "N
    locked", the Held for hover and the drawer's lot lines say "tradable <date>", the "Sell:" toast waits
    (`check` skips a locked row and `trackListExpiry` arms the re-check 1 ms after the unlock), and the page refetches
    then (`holdingsLapseAt`). Prices, profits, Worth now and P/L are unchanged in every mode.
  - core's `holdingsKey` includes `tradeLock.mode`, so a change of answer re-checks Holdings (switching 7-day → none
    tells newly sellable rows, deduped per SKU as before); `answeredAt` alone re-checks nothing.
- **Trend size (#17).** `holdingExitHistory`'s trend gains `size`: a Theil-Sen line (`robustStats.theilSen`) through
  the newest ≤ 60 exit stretches that observed the same sources as the newest one, each at its midpoint, with the
  fitted change over the span and the median absolute residual. It needs ≥ 5 points over ≥ 48 h, adds the context
  reason `trend-size` after `falling`, and never changes a verdict (the advice kind is identical with and without
  it). "Measured, not a forecast."
- **Key move band (#17).** `keyMoveBandOf` takes the 10th and 90th percentile of the key's 7-day move over daily spans
  from the newest point back (at most 180), each counted only when both ends have a PriceDB point at most 2 days
  older. The first span failing that ends the walk, so only the newest unbroken run counts: the sparse months are
  skipped (never read as a flat key) and never stretch the dates or the separate weeks; a span resolving to the same
  two points as the previous counted one counts once. Nothing below 28 spans (neighbouring spans share 6 of 7 days,
  so 28 cover about 4 separate weeks). It reads only the history already in memory:
  `PriceDb.loadedKeyHistory()` returns the key curve cache (the window-less `'|'` curve first, ignoring the TTL,
  because the band says when it was loaded), and `history('5021;6')`, a request the drawer already sends, now also
  fills that cache, which can only save a later identical request. Holdings memoises the band per load
  (`HoldingsDeps.keyHistory?`, a throw gives no band and never fails a list), and the `key-exposure` reason quotes it
  as `band`: the overlapping spans, both dates, the separate weeks and the profit range such a move would give
  (`keyBandText`). Until PriceDB's dense key history is about 34 days long (early November 2026) the band is absent,
  which is the honest answer.
- **Inventory valuation.** `holdingsValuationOf` turns one unfiltered `holdings.list` read into the Journal's
  *Unrealised P/L* card (`inventoryStat`: Holdings' P/L, the worth now, the read's time and the items with no exit),
  read on mount and refetched on the same pushes as Holdings. The ledger CSV appends `worth_now_ref`, `unrealised_ref`
  and `valued_at`, filled only on open buys (`journalLedger`'s valuer, `journalValuerOf`): each lot at its SKU's
  exit, its unrealised P/L through `holdingFigures` (friction only), so over a SKU's lots they sum to the row's
  `profitAllScrap`; blank on every other row and when Holdings cannot answer (`journal.exportCsv` logs and exports
  without them). The mock values alike.
- **Boundary.** The trade lock is a setting and arithmetic on journal times, the trend size reads the
  `holding_marks` rows already read for the advice, and the valuation the local `holdings.list`. The key band reads
  only the key curve PriceDB already holds in memory. No host, credential, request kind, endpoint, budget, cadence,
  RPC method, push or V16 statement is added. The FAQ link is one exact `STATIC_EXTERNAL_URLS` entry opened on the
  user's click through `links.open` (the HTTP client's policy still denies `help.steampowered.com`). Nothing contacts
  scrap.tf (R1, R10), and nothing is bought, listed or traded (R4).
- **Defaults.** Not sure, not answered: nothing changes but the question card on Holdings. Every 0.8 number, verdict,
  toast and CSV cell is unchanged, apart from the three appended ledger columns, the Journal card, and the
  `trend-size` and band lines where the data exists.
- **Tests.** `test/shared/robustStats.test.ts`, `test/shared/holdingTradeLock.test.ts`,
  `test/shared/holdingTrendSize.test.ts`, `test/shared/keyMoveBand.test.ts`, `test/shared/holdingsValuation.test.ts`,
  `test/domain/holdingsTradeLock.test.ts` (no "Sell:" until the unlock, then exactly one; the band from
  `deps.keyHistory`), `test/service/journalValuationRpc.test.ts`, `test/pricedb/pricedb.keyHistory.test.ts` (no
  second key request, and reading sends nothing), `test/renderer/holdingsLedgerText.test.ts`,
  `test/renderer/tradeLock.test.ts`, `test/renderer/journalValuation.test.ts` and the mock parity test
  `test/renderer/mockHoldings09.test.ts`; `mockHoldings08`, `mockJournal`, `journal`, `csv`, `journalRpc` and
  `holdingsPage` follow the appended columns, the band and the settings effect.

### Ranking: risk-aware keys, the risk control and the suggested reserve (#3, #12)

Ranking and text over books and data Flip Desk already holds. With the defaults every number, verdict, Pay up to and
toast is 0.8's; the package adds two sort keys, hover text, four CSV columns per table, a drawer line, a Settings note
and an opt-in notification gate. The engine rewrites each stored opportunity once to fill the V16 columns (A.2).

- **Keys (#3).** Over the book each row already reads (the engine's priced book, a Live market entry), `exitRiskAt`
  (`src/shared/exitRisk.ts`) gives three figures at the row's cost:
  - *If this buyer leaves* (`backupProfitScrap`): `flipProfit` at `buyerDepthOf`'s best other buyer seen in the last
    24 h; none when only an unverified one is left (as `singleExitOf`). A negative value is kept and shown.
  - *Buyers at break-even* (`profitableDepth`): the distinct buyers seen in the last 24 h whose best usable order
    (eligible, so banned and impersonator orders are out; not an outlier; above 0; a bot under Instant: `exitDepthOf`,
    `buyerDepthOf`'s candidate rule, the revenue buyer included) gives `flipProfit >= 0` at the row's cost, capped at
    20 (`EXIT_DEPTH_CAP`, shown "20+"). It equals counting the orders at or above exits' `breakEvenFor(cost, p, 'buy')`
    (`test/shared/exitRisk.test.ts` checks both over a seeded sample).
  - The book depth (`bookDepth`, uncapped) and its tag (`liquidityTagOf`): none (0), one, a few (2-4), many (5+). The
    count is always shown beside the tag ("N of M usable buyers seen in the last 24 h"; with no price to judge,
    `riskSentences` puts it in the depth sentence instead: "a few usable buyers (3 seen in the last 24 h)").
  - Review: both counts are of `exitDepthOf`'s population, never every buyer the Buyers cell counts, so the texts
    name it: "usable buyers" (`BOOK_DEPTH_LABELS`), "bot buyers" under Instant (`BOOK_DEPTH_BOT_LABELS`), followed by
    `depthPopulationNote(useOrder)` ("Outlier orders are not counted."; under Instant "Under Instant only bots count;
    outlier orders never do."; without a `useOrder`, a caller without settings, both rules). The Opportunities hover
    passes the table's `useOrder`, the drawer its settings' and the Live market's Sells for and Buyers hovers the
    page's (`MarketTable`'s `useOrder`, the same setting the service's `exitDepthOf` counted with), so five human
    buyers under Instant read "0 of 0 bot buyers" and "no bot buyer seen in the last 24 h" beside a Buyers cell of 5,
    never "no buyer seen".

  `OppQuery` and `MarketQuery` sort by the first two (`'backup'`, `'depth'`), descending by default, with missing
  values last in both directions and ties by profit (missing last), then name, then key: the repo's `OPP_SORT`, the
  renderer's `compareOpps` and the shared `marketComparator` agree. Opportunities store the figures in V16's three
  nullable columns (`opportunityRiskFields`: null is absent, so the repo's read-back equals the engine's shape and an
  unchanged row is never upserted again); the engine reads the book once per row (`exitOrdersOfBook`, every row now,
  not only profitable ones) for the next buyer and the keys, and its first full sweep rewrites rows stored before V16.
  A row is rewritten again when a buyer it counts ages past 24 h or reprices, as 0.8 does when an order's
  'unverified' flag changes. The Live market keeps a compact `ExitDepth` on each entry (`MarketEval.exitDepth`, set by
  `evaluateMarketBase`) and computes the figures per read at `marketRiskCost` (your price, else a rule flip's
  estimate, else none: `profitableDepth` null), in `select()`'s sort and `toRow` alike; `moved()` is unchanged, since
  every `replace` already invalidates the read.

  No column was added (the 0.8 plan's D23 precedent). Opportunities gained a Sort select (`OppSortPicker`,
  `OPP_SORT_LABELS`, `OPP_SORT_HELP`; the column headers sort as before), the Live market's Sort select lists both
  keys, and the figures show in the Opportunities Buyers hover (`oppBuyersTitle`), the Live market's Sells for and
  Buyers hovers (`marketSellsTitle`, `marketRiskTitle`) and the drawer input card's *Buyers at break-even* line (D11,
  below exits' *Break-even* and the *Next buyer* line). The drawer's line (`drawerRiskLine`) reads the drawer's own
  book (`ItemDetail.buyOrders`) with the same `buyerDepthOf` call as `nextBuyerLine`, never the stored row, so the two
  adjacent lines cannot disagree; it is null when the revenue order is not in that book, and warns on a profitable row
  with at most one buyer at break-even. Both CSVs carry `backup_profit[_ref]`, `profitable_depth`, `book_depth` and
  `book_depth_tag` (D10): the Opportunities CSV after exits' `break_even_ref`, the market CSV at its end, the mock's
  Opportunities CSV after `break_even`; blank on a row with no figure. Nothing scales profit by the confidence score,
  and every risk text ends "Buy orders show demand, not sales." (`DEMAND_NOT_SALES`).
- **Why no EMA (D20).** The book changes only on feed events and snapshots, and deletes or reprices made while the app
  or the feed was off are never re-sent (deviation 11), so the app has no regular cycle to smooth over. An EMA
  updated per evaluation would weight event frequency, not time; a time-based one would need per-SKU state for every
  Live market base, kept across restarts, whose gaps would either freeze an old book or decay into an invented empty
  one (the reason `holding_marks` never fills a gap). The 24 h verification window is the smoothing: distinct usable
  buyers seen in the last 24 h needs no new state, table or request.
- **Risk control (D19).** `notifications.minProfitableDepth` (0 = off, the default; whole buyers 1-10, Settings →
  Notifications, `MIN_PROFITABLE_DEPTH_LABEL`, `minProfitableDepthHint`) holds back the toasts that tell a flip until
  that many buyers at break-even are seen: the engine's Profit, Watch (path B) and Candidate toasts (after the
  unverified gate, `depthGateOk(opp.profitableDepth, minDepth)`), and the S3 notifier's new, cheaper, back and Buy now
  flips (`BankStockNotifyArgs.minDepth` and `depthOf`, `BankStock.depthOf`: `profitableDepthAt` over the market
  entry's `ExitDepth` at the row's cost, read only when a minimum is set; unknown holds the row back). A held-back flip
  is not recorded as told, so a later run tells it once enough buyers are there. The S3 notifier's watch price or
  profit hits (a page read or saved: its `ws` loop runs before the gates), Sell toasts, the Live check and re-save
  reminders are not held back; the engine's "Watch: <name>" toast (a typed or imported price at a watch's profit
  target) is, as `minProfitableDepthHint` says. Lists, rows and verdicts are unchanged.
- **Suggested reserve (#12).** `profit.reserveSuggestion` (local reads only) runs `reserveSuggestionOf`
  (`src/shared/reserveSuggest.ts`):
  - per value band (under 10 ref, 10 ref to 1 key, 1 key and up; `reserveBandOf` at today's key price), the 10th
    percentile (`lowerQuantile`, Hyndman-Fan type 1) of the exit's relative change over the user's typical hold
    (`typicalHoldOf`'s median over every sale, clamped to 1 h-14 d, else 1 d, and the text says which; a clamped hold
    keeps the median in `ReserveSuggestion.holdClampedFromMs`, so the note reads "over a 1 h hold (the shortest it
    measures; your typical hold is 20 min, from 12 sales)", never calling the bound the user's hold), rounded up to a
    whole percent (`suggestedPctOf`; 0 when the 10th percentile is a rise, at most 50%);
  - windows on a fixed grid in the last 90 days, each needing both ends observed: a recorded run (`holding_marks`,
    `repo.holdingMarksSince`, the newest 50,000) at each end, or a PriceDB point at most max(1 h, hold / 4) older; no
    gap is filled;
  - recorded windows start at the last buyer-settings change (`Holdings.buyerSettingsAt`, the stamp the advice reads;
    the grid starts at max(first run, now - 90 d, the stamp)), so none is read from before it: only the latest change
    is kept, and a window before it could span an earlier change no stamp remembers (review; `holdingExitHistory` cuts
    at the same stamp). Each item gives at most its newest 30;
  - both sources value keys at PriceDB's key price of each end's own time, so a key move counts as a revenue move the
    same way from either (E.1 rule 9's exception): a PriceDB point as `history()` valued it, a recorded end with keys
    at `keyPriceAtOf(PriceDb.loadedKeyHistory())` at that instant (the newest key point at or before it, at most
    `RESERVE_KEY_POINT_MAX_AGE_MS` (2 d) older, and never after the history was loaded). Never the run's own
    `HoldingMark.keyScrap`: the recorder compares raw keys and metal, so a run goes on through a key move, and a
    start-of-run price made the figure depend on where the app restarted (review). With no key history in memory a
    recorded end with keys is not observed (the help says opening the history of an item priced in keys loads it);
    metal-only ends need none. Reading the key curve cache sends nothing;
  - the figure comes from the recorded exit runs when they hold 20 windows from 3 items, else from the PriceDB history
    `item.detail` loaded this session (`historyCache`, read, never filled: the method never calls `historyFor` or a
    connector method that sends a request, only `loadedKeyHistory`'s in-memory read, and answers with the network
    paused or PriceDB off), else "not enough data" with both counts; the two sources are never pooled;
  - Settings → Profit thresholds shows it under the fields (`ReserveSuggestionNote`, `reserveSuggestionView`: the hold
    it used and its sales, one line per band with its n and source, the units still held the typical hold leaves out),
    re-read on `journal.changed`. It is text only, never applied: "a suggestion from past data, never a forecast"; the
    reserve's hint now ends "Flip Desk never sets it" (`exitReserveHint`).
- **Mock parity.** The mock's `evaluateOpportunity` and `mockMarketRow` call the same `exitDepthOf`, `buyerDepthOf`,
  `exitRiskAt` and `marketRiskCost`; `'opps.list'` sorts with `sortOpportunities` and `'market.list'` with
  `marketComparator`; `'item.detail'` keeps the history it served per base (`historyOpened`, cleared past 200 bases,
  as `historyCache`), and `'profit.reserveSuggestion'` runs `reserveSuggestionOf` over the seeded exit runs, that
  history, the mock journal's typical hold, `markSettings.at` and the preview's key history (`mockKeyHistory(t0, …)`
  loaded at t0, the one Holdings' key band reads, as the service's `pricedb.loadedKeyHistory()`). The mock sends no
  notification, so the gate has nothing to hold back there.
- **Boundary.** No request kind, host, endpoint, budget, cadence, credential, push or `openUrl` was added, and
  `net/policy.ts`, `budgets.ts` and `http.ts` are untouched: the keys come from the local `listings` book the engine
  and the Live market already read, the suggestion from `holding_marks`, the journal, the in-memory history cache and
  the in-memory PriceDB key curve (`PriceDb.loadedKeyHistory`, which sends nothing), and the gate only suppresses
  toasts (opt-in). Nothing touches scrap.tf (R1, R10), and nothing is bought, listed or
  traded (R4). V16 adds three nullable columns. The new modules are held to the F20 scan, and `exitRisk.ts` is a
  listed `flipProfit` caller that neither reads `.frictionScrap` nor subtracts friction (`profitPath.test.ts`).
- **Tests.** `test/shared/exitRisk.test.ts` (the `breakEvenFor` equivalence), `test/shared/reserveSuggest.test.ts`
  (one meaning per band across sources), `test/domain/engineRanking090.test.ts` (the gate holds a one-buyer flip and
  writes no told record; a pre-V16 row is upserted once), `test/domain/marketRanking090.test.ts`,
  `test/domain/bankStockDepthNotify090.test.ts`, `test/service/reserveSuggestionRpc090.test.ts` (the PriceDB spy is
  called by `item.detail` only), `test/renderer/riskModel.test.ts` (the drawer line agrees with `nextBuyerLine` on one
  book; no "chance", "probability" or "will"), `test/renderer/oppSort090.test.ts` (`compareOpps` against the repo's
  SQL order), `test/renderer/mockRanking090.test.ts` (parity; nothing fetched) and `test/main/settingsRisk090.test.ts`;
  `settingsFields.test.ts` (the hint's last sentence), `marketRpc.test.ts` (the market CSV line's four blank cells),
  `profitPath.test.ts` (`exitRisk.ts` among the `flipProfit` callers) and the static scan's `F20_FILES`
  (`renderer/riskModel.ts`).

### History: order persistence, recorded community prices, scrap.tf lows (#6, #7)

From data that already arrives, Flip Desk keeps three histories and shows them; no number, verdict, notification or
ranking changes, and there is no settings key (H10: like 0.8's `holding_marks`, the recording is storage only).

- **Order persistence (#6).** For the buy orders of watched, held and scrap.tf-priced bases (core's
  `watchedBookSet()`) seen on the live feed, `createOrderSpellTracker` (`domain/orderSpells.ts`) writes one
  `order_spells` row per *spell*: one order at one price, with its base SKU, intent, bot flag, raw keys + metal,
  backpack.tf's `listedAt`, first seen, last confirmed, and the end time and kind. No SteamID, listing id or name is
  stored: the listing id is a key of the tracker's memory only (H4, R5).
  - *What is followed (H1).* A spell opens only on a feed **update** of a buy order of a tracked base that is worth at
    least `ORDER_SPELL_FOLLOW_SHARE` (0.7) of the base's top non-outlier order (`consScrap ?? bestScrap`, so one outlier
    does not exclude the real top), is not marketplace, not banned, not flagged as an impersonator (D9) and has a
    price (`orderSpellFollows`). Lowball orders persist for months and never matter for an exit. At most 20,000 orders
    are followed at once (logged once past it).
  - *How a spell ends (H2, D9).* `deleted` (a feed delete), `inactive` (the feed reported it not live: its id is in
    `FeedBatch.inactive`), `lowered` / `raised` (an update at another price, by `rawPriceCompare`), `relisted`, or
    `unwatched`. A delete or inactive report is held for `ORDER_SPELL_RELIST_GRACE_MS` (60 s) and at least to the next
    status tick: an update of the same id at the same or a higher price in that time ends it `relisted` at the delete
    (bots relist, and buy-order ids are deterministic, so without the grace a bot restart reads as a burst of ends); a
    lower re-create ends it `lowered`; a feed break, epoch change or stop inside the grace ends it `unwatched` at the
    delete. The Kaplan-Meier events are `deleted`, `inactive` and `lowered`; `raised`, `relisted` and `unwatched` are
    censored. "Still up at its price or higher" is the flipper's question, and an inactive order is not up.
  - *Continuity (H3).* The socket's `epoch` grows on every new connection and on every `buffer-limit-exceeded`, and the
    socket flushes before growing it, so a batch never mixes two streams. A new epoch, the status tick seeing the feed
    not live, a clock moved back and the app stopping end every followed spell `unwatched` at the stream's last batch;
    `start()` ends rows a crash left open at their `last_seen_at`. Gaps are never filled. `last_seen_at` is written at
    most every `ORDER_SPELL_TOUCH_MS` (10 min), never on a held row (review: a touch past its delete let a crash in the
    grace censor it after the order was gone), and an ended spell's `last_seen_at` is its end. One transaction runs per
    batch only when a followed id changes or a buy update of a tracked base arrives (R-3). The tracker logs the spells
    written per day.
  - *The age (H5).* The origin is `listedAt` on the update that opened the spell, and the entry age is first seen −
    origin (0 when bp.tf's clock is ahead): delayed entry, because most orders were already old when first seen. It is
    **time since backpack.tf's listing time**, never "time at this price": a price edit need not reset `listedAt` (two
    repriced listings in ws-sample.json kept theirs), so every text says "listed N ago". Spells without `listedAt` are
    counted, never estimated.
  - *The estimate (H6).* `orderPersistenceOf` answers "of orders like this one, at this age, how many were still up at
    their price (or higher) 1 h / 1 d / 7 d later" (`persistenceWindowOf`, O((n + k) log n) per window). It needs
    `ORDER_PERSISTENCE_MIN_AT_RISK` (8) spells followed at the order's age and `ORDER_PERSISTENCE_MIN_AT_RISK_END` (3) at
    every point of the window, its end included, mirroring timing's gates. The scope ladder is `like` (same bot flag,
    value within 15 %) → `band` (value within 15 %) → `all`: the first scope whose 1 h window passes, then every
    horizon in that scope. Otherwise the answer is "not enough data" with its reason (`no-listed-time`, `few-at-risk`,
    `past-the-data`).
  - *What is shown.* The item drawer's "Order book history" (`BookHistorySection`, between the Sell listings and
    "Reference prices") asks `'item.bookHistory'` for its top 3 eligible distinct buyers (`bookHistoryOrderIds`) and
    shows the spell summary (counts per end, worded as order-price spells: one order counts again after each price
    change or feed restart), one line per order ("listed 3 h ago · est. 82 % of orders like it still up 1 d later", with
    every horizon's spells followed and ended in its hover), and `ORDER_PERSISTENCE_NOTE`. It is order persistence,
    never a fill rate (Lo, MacKinlay and Zhang): an order ends because it bought an item or because its owner removed
    or repriced it or ran out of currency, and nobody can see which. Nothing is a forecast.
- **Recorded community prices (#7).** The `bptf-prices` job keeps, for each incoming IGetPrices row that differs from
  its stored row, both the stored row (the price it replaces) and the incoming one as `source 'prices'`; a SKU with no
  stored row is kept only on a delta, so a first full fetch (~100k rows) is not copied (H7,
  `communityHistoryPointsOf`). `bptf_community` is still overwritten exactly as in 0.8, and a failed history step costs
  only the history (a nested transaction). The feed's `item.price.community` (`wsCommunityPriceOf`; on 249 of the 299
  captured events) is batched per base and written by `createCommunityFeedRecorder` for tracked bases when it differs
  from the last one written for that SKU (H8, source `'feed'`); it is never written to `bptf_community` and never used
  as a reference. The unique point index makes repeats no-ops. The drawer draws the steps (`communityHistoryOf`: twin
  SKUs and both sources joined, the stored current price appended when new) as a step chart, valued with
  `communityValueScrap` (H12: `pricing.ts`'s `communityScrap` re-implemented in shared and pinned by a parity test, so
  the renderer and the mock need not import the service), worded "backpack.tf's accepted price suggestions, not sales".
  `deal` and `price.steam` are not read (their meaning is unverified). A high equal to the low is no range
  (`communityHighOf`, review): the feed always sends `valueHigh` (equal to `value` for a single price, 84 of the 249)
  where IGetPrices leaves `value_high` out, so `wsCommunityPriceOf` reads it as null and the point key, the comparison
  and the stored row treat both spellings as one price; the drawer shows one step for it, not two.
- **scrap.tf lows.** Per copy and bank, the lowest on-sale price in the user's saves, with when (the first and last save
  at that price) and since when (H9). The low is the minimum by `rawPriceCompare` (equal keys: the metal; else valued
  at the key price, fewer keys first on a tie), a total order, so the fold is order-independent; /items family rows
  and sold-out rows never count. `ScraptfHistory.lowsFor` merges the retained saves (in memory, rebuilt per runs
  rebuild and key price) with `scraptf_lows`, which `recordLows` writes at each import from 0.9 on (inside the
  import's transaction, as a nested SAVEPOINT, changed rows only), so the low reaches back past the 90-day thinned
  saves without a backfill. Raw keys + metal are kept and valued at the read's key price, so a key move alone never
  reads as a price move. It shows in the drawer's scrap.tf history block (`scraptfLowLine`: "Lowest in your saves since
  …" when the price now is at or under it) and in the bank stock price cell's hover (`scraptfLowSentence`, joined to
  `BankStockRow.low` after the watch join). No toast reads it.
- **`item.bookHistory` (H11).** One RPC, computed in the service through the shared rule (`readItemBookHistory` →
  `itemBookHistoryOf`; the mock calls the same rule). The drawer passes listing ids from its own `OrderSummary` objects
  (at most 5), and the service looks them up in the local book for their `listedAt` (an `OrderSummary` has none;
  adding one would ripple into the stored opportunity JSON); a sell listing, a foreign base's order and an unknown id
  are left out, and the ids are never stored or logged.
- **Tables and retention (V16, Foundation).**
  - `order_spells` (indexes `(base_sku, first_seen_at)`, `(first_seen_at)` and the partial `order_spells_open`): ended
    spells only, 60 days / 300 per base / 400,000 in all. Every cut (the age, both caps, the read's `since` and limit of
    2,000) selects on `first_seen_at`, the spell's entry, never on its end: a sample chosen by when spells ended keeps
    long spells and drops their short siblings, which delayed entry cannot undo. The prunes take ended spells only, so
    every read also cuts on entry what they leave behind (an open spell whose ended siblings were pruned is a
    survivor): by age, the read's `since`; the whole table, `orderSpells` reads only spells first seen after the
    newest entry that cap ever deleted (kept in `meta` as `orderSpells.entryCut`, never moved back); per base,
    `itemBookHistoryOf` applies `spellsEntryCutOf`: for a base with at least 300 ended spells in the read, spells (open
    or ended) first seen at or before its 300th newest ended spell are left out. That cut is at or after every boundary
    the cap drew, also once a survivor it left has ended, and a batch opened at the boundary instant goes whole (review:
    the cap splits such a batch by id but keeps all its open spells). A capped-base simulation reads 0.250 against a
    truth of 0.247 at 7 d. The 60 days are a ceiling: about 30,000-50,000 spells a day for a user
    tracking ~2,000 bases fill the 400,000 cap in 8-13 days and a busy base's 300 in a few days, so the caps usually
    set the window; the drawer's "since" date (and the summary's hover) says how far back the spells reach. About 150
    bytes a row, so 400,000 rows are about 60 MB; the 10-minute touch of followed rows updates no index.
  - `bptf_community_history` (the unique point index, `(recorded_at)`): 365 days / 200 per SKU / 300,000 in all.
  - `scraptf_lows` (primary key bank, SKU, special key): 365 days after `seen_at`.
  - The daily maintenance prunes all three (`runMaintenance` gains `orderSpells`, `communityHistory`, `scraptfLows`,
    and a pruned low refreshes the history index).
- **Boundary.** No new host, credential, request kind, budget, cadence, push or setting. The feed's community price is
  a field of payloads the socket already receives from `wss://ws.backpack.tf/events`, and the epoch is a counter; no
  connection, header, cadence or cap changes (R2, R7). The `bptf-prices` job's single request
  (`bptfApi.prices(since)`, its existing budget and 2 h cadence) is unchanged; the history is written from its answer.
  `'item.bookHistory'` reads only `order_spells`, `bptf_community_history`, `bptf_community` and `listings` by id. The
  lows come only from the user's saved pages and window reads, already imported (R1, R10): nothing is loaded, no URL
  is built and nothing is opened. Text and charts only (R4).
- **Mock parity.** The mock's `'item.bookHistory'` runs `itemBookHistoryOf` over each book's seeded spells and community
  prices (`seedOrderSpells`: eight per eligible buy order within 10 % of its value, on its own RNG per SKU;
  `seedCommunityHistory`: four points over 120 days around the book's community reference), memoised per base, with
  each asked order's listing time from its id (`mockOrderListedAt`). Its bank stock rows and item histories join the
  same `scraptfLowsOf` / `scraptfCopyLowOf` fold over its saves (the mock has no `scraptf_lows` table: its saves are
  all it has), rebuilt when the saves or the key price change.
- **Known limits.** An order that is never bumped or edited while the feed runs is not followed, so human orders are
  under-represented; persistence needs the feed running for the hours it measures. Counts are order-price spells, not
  distinct orders. A scrap.tf low covers only what the user saved: what happened between two saves is unknown.
- **Compliance.** `F20_FILES` lists the three shared rules, `service/domain/orderSpells.ts`, `communityFeed.ts`,
  `bookHistory.ts`, `renderer/bookHistoryModel.ts` and `renderer/components/BookHistorySection.tsx`.
  `test/compliance/history090.test.ts` pins that the three tables have no column naming a buyer, listing or offer,
  that the tracker and the feed recorder never name `steamid`, `userName`, `tradeOfferUrl` or `details`, that
  `wsCommunityPriceOf` reads no `user`, `steam` or `deal`, that the `bptf-prices` job calls `bptfApi.prices(` exactly once
  and no other `bptfApi`/`http` method, and that none of the eight new modules imports `service/net`, `electron` or
  `node:http(s)`. The drawer section calls only `item.bookHistory` and opens nothing (`drawerBookHistory.test.ts`).
- **Tests.** `test/shared/orderPersistence.test.ts` (the Kaplan-Meier worked example, the observation edges, the scope
  ladder and the capped-base bias check), `test/shared/communityHistory.test.ts` (with the `communityScrap` parity),
  `test/shared/scraptfLows.test.ts`, `test/bptf/bptfItem.community.test.ts`, `test/bptf/bptfSocket.history.test.ts`,
  `test/domain/orderSpells.test.ts` (the tracker over a real `:memory:` repo: relists, the grace, epochs, failures and
  no listing id in any row), `test/domain/communityFeed.test.ts`, `test/domain/scraptfLowsHistory.test.ts`,
  `test/domain/bookHistory.test.ts`, `test/service/bookHistoryRpc.test.ts`, `test/service/communityPricesJob.test.ts`,
  `test/service/bookHistoryCore.test.ts` (end to end from a fake feed, with no URL outside the 0.8 set),
  `test/renderer/bookHistoryModel.test.ts`, `test/renderer/drawerBookHistory.test.ts`, the mock parity test
  `test/renderer/mockBookHistory.test.ts` and `test/compliance/history090.test.ts`; `engine.test.ts`'s
  `runMaintenance` pin gains the three counts. The repo and V16 tests are Foundation's.

### Timing: how sure buy timing is (#10)

Buy timing (0.8, Cycles) now says how sure it is, from the same saves and pooled tables: no setting, no V16
statement, no RPC method or push, and no new file under `src/`; `ScraptfBuyTiming` and `ScraptfTimingBrief` gain the
optional `uncertainty` and `saveTiming`, and `ScraptfTimingWhy` gains `unsure-gain`.

- **Ranges clustered by copy.** `scraptfTimingInfluenceOf` is the infinitesimal jackknife of the Aalen-Johansen
  shares over (age, age + H], each copy's states summed (one item repriced five times is one item), checked against
  finite differences. `scraptfTimingSpreadOf` turns it into (co)variances times copies / (copies − 1), memoised per
  table (rows of a page share their ages). pDrop and *went or rose first* carry a 90 % Wilson range at the effective
  sample size p(1 − p) / variance (capped at the states behind it; at the copies behind it when every copy says the
  same, the share is 0 or 1, or one item is behind it), with the items behind it named: "Allowing for chance across the 13 items behind these (a 90 % range): 48-86 %
  dropped, 3-28 % went or rose first." (`timingRangesText`, rounded outward to whole percents).
- **The Wait gate.** The horizon is picked as in 0.8 (best evWait, a tie to the shorter; no search over horizons for
  one that passes). *Wait* needs c0 or c1 within Pay up to and the gain on the estimate over max(3 scrap, 10 %), as
  before, and now the gain's one-sided 95 % low end (q's spread included) at least 1 whole scrap
  (`SCRAPTF_WAIT_MIN_GAIN_LOW_SCRAP`), for the picked horizon taken alone: the pick among up to four horizons on the
  same saves is not allowed for, so the measured false-Wait rates below are what the gate gives, never 95 %. This
  replaces 0.8's fixed pDrop >= 0.3 (`SCRAPTF_WAIT_MIN_P_DROP`, removed). The gain is against the better of buying
  now and not buying (max(evBuy, 0)): 0.8's `evBuy ?? 0` could be negative over Pay up to, which its drop chance hid.
  When only the low end fails, the verdict is *Buy now* or *Over* with `unsure-gain` ("waiting looked worth more, but
  allowing for chance it may add nothing"). A share whose jackknife says nothing of its spread (one item behind the
  window, whose influence sums to 0 because the shares do not change when every weight is scaled alike; every copy the
  same; or no drop, or no gone or rise, in the window) is never taken as exact: the gate gives it the spread that puts
  it at the far end of its shown range (pDrop at its low end, *went or rose first* at its high end) and adds that
  beside the other terms' as an independent spread (review; before, such a share counted as exact whenever q had a
  spread, so a window resting on one item could pass on q's spread alone, and a window with no gone or rise ignored
  the gone risk its own range showed).
- **The drop size at its low end (T9-3b).** A false *Wait* is the costlier error (the item can sell while the user
  waits), so the low end is taken with c1 after a conservative drop. `scraptfDropLowOf` takes the k-th smallest of the
  drop sizes the point estimate uses (the copy's own with 3 or more, else the pool's), k the largest with
  P(Binomial(n, 1/2) < k) <= 5 % (`SCRAPTF_DROP_LOW_ALPHA`, `scraptfMedianLowRank`; the smallest below 5 sizes): a
  one-sided 95 % lower bound of the median single-step drop whatever the sizes' distribution, never above the point
  size. When at least 5 (`SCRAPTF_DROP_SHORT_BRACKET_MIN`) of those drops have a bracket no longer than the look gap,
  only those count, because several drops between distant saves read as one bigger step; `uncertainty.dropLow` and
  `dropSizeFrom` ('short-brackets' or 'all') say which, and the drawer's money line names the drop it took. The
  horizon pick and the gain bar keep the point size.
- **Measured false Waits, the pick included.** On a known-rate synthetic bank (0.8's generator, run from the
  scratchpad, not a repo test): 150 items with exponential times to a drop, going off sale and a rise (means below),
  a true drop of 7 %, Sells for the factor times the price, Pay up to at a 5 % margin, 8 seeds per setting. A false
  Wait is a *Wait* whose true gain at the picked horizon is under 1 scrap.

  | Saves; mean hours to drop / gone / rise; Sells for | Waits, false: 0.8 | low end at the point drop | 0.9 (shipped) | true gain under the low end, gated rows: at the point drop | 0.9 (shipped) |
  |---|---|---|---|---|---|
  | A: hourly for 10 d; 30 / 60 / 200; 1.12 x | 0 | 0 | 0 | none gated | none gated |
  | B: hourly for 10 d; 30 / 60 / 200; 1.20 x | 0 | 0 | 0 | none gated | none gated |
  | C: 3-hourly for 20 d; 20 / 80 / 300; 1.15 x | 19, 6 (32 %) | 13, 6 (46 %) | 5, 3 (60 %) | 11 of 19 | 4 of 19 |
  | D: hourly for 6 d; 15 / 40 / 300; 1.15 x | 6, 6 (100 %) | 2, 2 (100 %) | 1, 1 (100 %) | 3 of 6 | 2 of 6 |
  | E: hourly for 10 d; 60 / 40 / 200; 1.08 x (drops rare) | 0 | 0 | 0 | none gated | none gated |
  | F: 3-hourly ± 90 % jitter for 20 d; 20 / 80 / 300; 1.15 x | 31, 7 (23 %) | 24, 6 (25 %) | 19, 3 (16 %) | 14 of 31 | 9 of 31 |
  | G: 6-hourly for 20 d; 12 / 80 / 300; 1.15 x | 88, 1 (1 %) | 88, 1 (1 %) | 37, 0 | 56 of 88 | 2 of 88 |

  In all: 20 false of 144 Waits under 0.8's rule, 15 of 127 with the low end at the point drop, 7 of 62 as shipped.
  T9-3b's bar (at most 1 false Wait per setting or 15 % of its Waits, whichever is larger) holds in A, B, D, E and G
  and is missed in C (3 of 5) and F (3 of 19). The review fix above (a spreadless share at its range's far end) took
  out one false Wait in D, at 43 h, whose window had no gone or rise among its 8 items (true gain 0.01 scrap); every
  other row of the table is as before it. The variants tried (before that fix): a 1 % drop-size level and z = 1.69 gave
  the same table; z = 2.24 (one-sided Bonferroni over four horizons) and z = 2.6 meet the bar in more settings (2.6 in
  all) but turn the 0.8 `drop-likely` fixture of `scraptfTiming.test.ts`, whose own figures give a gain of 5 scrap,
  into *Buy now*. So, as T9-3b directs, the shipped gate (z = 1.645, the drop size at 5 %) is the most conservative
  variant that keeps that fixture a *Wait*. The false Waits left take the drop size right (6.6-7 % against the true
  7 %) but read pDrop high at their picked wait (0.69-0.79 against a true 0.60 in C and F, 0.49 against 0.31 in D,
  all at ages of 34-87 h): among many rows the gate passes the ones whose odds read high by chance, which a low end
  for one row taken alone does not allow for. Their true gains were 0.14-1.0 scrap: none loses in expectation (waiting
  gained less than the 1-scrap bar, never less than buying now), where 0.8's rule let Waits through at -0.09 scrap. The
  stricter gates would also have dropped Waits that cleared the bar: 20 at z = 2.24 and 25 at z = 2.6 (of the 55 the
  shipped gate keeps across the seven settings), to remove 5 or 7 of these near-misses.
- **Depends on save timing.** `scraptfTimingTableOf(…, 'left')` dates every price change at the left end of its
  bracket (a state runs startPrevAt to lastAt; a censoring at a sighting stays). When the same rules on that table,
  at the copy's left age, give another of wait / buy-now / over, `saveTiming` names it: the tag reads *Wait ~1 d?* /
  *Buy now?* (muted), and the titles and the drawer say "Depends on save timing: had each price change come just
  after your last save before it, not just before the save that showed it, your saves would suggest …". The verdict
  never changes. The left table is built lazily, only when the verdict could turn, and cached as `…|left`. G4's
  *Buy now* toast never fires on a flagged Buy now (`timingTurned`), and a flagged Buy now ends the Wait streak like
  any other non-wait, so the next unflagged one does not toast either.
- **Where it shows.** `timingBadge`'s title: lead, the judged price, the odds, the ranges, the save-timing sentence,
  the copy read, the save, then scraptf's checkout guard last on a *Buy now* (D5); `timingVerdictTitle` the same
  without the copy read and the guard. The drawer's odds line carries the ranges, its money line the low end ("waiting
  adds at least +0.11 ref (the low end for the wait your saves picked, taken alone, at a drop of 6 %)", or "waiting
  may add nothing (low end …)"), and the save-timing sentence follows it. Ranges and the flag appear only when
  present, so every 0.8 text without them is unchanged.
- **What the ranges do not cover**, said in `TIMING_ESTIMATE_NOTE`: when the user chose to save (a save prompted by
  a toast makes censoring informative), brackets merging events (on a synthetic known-rate bank the 90 % range of
  pDrop covered the truth 88-94 % of the time at hourly saves, but *went or rose first* only 60 % at 3-hourly saves),
  scrap.tf changing its rules, and, for the Wait check's low end, the pick among up to four waits; it also says the
  drop size is taken at its low end.
- **On the mock.** The stranges and list banks' one *Wait* each (both `drop-makes-flip`) became *Over* /
  `unsure-gain`; hats is unchanged (`mockCycles.test.ts`), and no mock row is flagged.
- **Performance.** Memoised per table (`SCRAPTF_TIMING_SPREAD_CACHE_MAX`), and the drop sizes' low end per (table,
  look gap). In this build, on a machine shared with the other Wave 2 runs, `marketTimingPerf.test.ts`'s 2,000-row
  window refresh took 64-70 ms against 0.8's 48-49 ms in the same conditions, and its cold page about 1.35-1.4 times
  0.8's; the test's bounds are unchanged.
- **Boundary unchanged.** Pure functions over the lifecycle the history index already caches: no repo query,
  request kind, host, budget, timer, notification kind, `openUrl` or URL; nothing reaches scrap.tf (R1, R10);
  profit still goes through `flipProfit` only; the edited modules were already in `F20_FILES`.
- **Tests.** New `test/shared/scraptfTimingCi.test.ts` and `test/renderer/timingUncertainty.test.ts` (with the mock
  parity case); changed `test/shared/scraptfTiming.test.ts` (the pDrop 0.25 case reads `unsure-gain`; the brief
  carries `uncertainty`) and `test/shared/bankStockNotify.test.ts` (G4 skips a flagged Buy now).

### Docs: brief corrections and feed fields

Documents and their test only: no code, setting, request, push or schema change. The texts state what exits, scrap.tf
and holdings-ledger landed in Wave 1 and history's `wsCommunityPriceOf` (Wave 2), from the 2026-10-22 research
(`docs/RESEARCH.md`).

- **DESIGN_BRIEF corrections (`docs/DESIGN_BRIEF.md`, D6).** Every original line is kept as written. A note under the
  opening caveat says how the notes are marked: a **Correction (2026-10-22)** quote block in the corrected line's own
  section, after the line (or, below a table, before the paragraph that follows it), and a **Note (0.9)** where 0.9
  changed a rule the brief states. A note on a list item is indented into its list.
  - §1.5: Trade Protection's CS2-only reading is contested (RESEARCH §4.6, §9 q15: Valve's FAQ did not render;
    DMarket's docs say every game); Settings → Trade lock asks the user.
  - §2.0 (Note): the SCM budget's cap of 300 a day, `x-eresult` 25/84 as a rate limit, and the host block on a
    Cloudflare challenge script (RESEARCH §4.6, §8 #14).
  - §2.7: PriceDB's key history is 900 s apart only in its recent tail (328 points since 2025-09-25, RESEARCH §4.7),
    which the key move band allows for.
  - §5.1: `Math.round(ref * 9)` is not safe for the capture's six half-scrap values (RESEARCH §4.2); integer scrap stays
    (half-scrap units, #20, are deferred).
  - §5.4: mannco's fee is 5%, the seller's net rounded up, per mannco's own docs (RESEARCH §4.4); mannco.store is a
    journal venue.
  - §5.5: a bot, and so Instant, is an event with a `userAgent` object, not `source` (253 against 294 events,
    RESEARCH §4.2); the bot service is a label only.
  - §5.7: the online +5 is gone (true on all 299 events, RESEARCH §4.2, #11); `notifications.minConfidence` stays 45.
  - §5.8: the Trade Protection flag did not exist before 0.9 (RESEARCH §1.2); Settings → Trade lock changes Holdings,
    not opportunities.
  - §8: the mannco fee is settled, and Trade Protection's TF2 scope is contested.
  - Appendix C: the email (`PERMISSION_TEMPLATE`, `src/renderer/aboutModel.ts`) no longer says "never connects to
    scrap.tf", untrue since F21, and asks three more questions.
- **Feed fields (`test/fixtures/bptf/FIELDS.md`).** Four rows: `payload.status` (read by `bptfListingActive`);
  `payload.deal` (on 9 of the 78 sell events, at the community price, on none of the 221 buys; it read "only on some
  deletes"; its meaning is RESEARCH §9 question 22, and the mapper does not read it); the `user` bullet
  (`flagImpersonated` on `events[288]`, object-form bans by `isBannedFromBans`, the `botServiceOf` label); and the
  `price` row (`community` read by `wsCommunityPriceOf`; `steam`, `suggested` and `deal` are not read). The intro now
  says the sample holds 299 events (its `_meta.eventsSelected`; it said 300) and which counts are out of the full
  1,556-event capture.
- **Test.** `test/shared/audit-090-brief-corrections.test.ts` pins each corrected line, verbatim, with its dated note
  in the same section naming its source, and exactly ten notes. It checks the notes' claims against the code (no
  online bonus in `confidence.ts`, the SCM budget, the `x-eresult` set, mannco's rounding, the Trade lock default,
  `isBot` from the `userAgent` object over the capture, the email's wording) and against `ws-sample.json` (the
  half-scrap values, the `source` and `userAgent` counts, the `deal` arithmetic, the one impersonator, every status
  active), and FIELDS.md's rows. The brief keeps `with "HTML only"`, which `importGuidance.test.ts` reads.

### Tests and version

- **New test files.** 74: 8 from Foundation, 64 from the packages (each package's mock parity test marked), 1 from
  docs and 1 from integration.
  - Foundation: `test/db/v16Round090.test.ts`, `test/db/listingsImpersonated090.test.ts`,
    `test/db/opportunitiesRanking090.test.ts`, `test/db/orderSpells.test.ts`, `test/db/communityHistory.test.ts`,
    `test/db/scraptfLows.test.ts`, `test/db/audit-v16-scraptf-columns.test.ts`, `test/service/contracts090.test.ts`.
  - Exits: `test/shared/exitFees090.test.ts`, `test/shared/breakEven090.test.ts`,
    `test/renderer/breakEvenModel090.test.ts`, `test/renderer/mockExits090.test.ts` (parity),
    `test/renderer/settingsExits090.test.ts`, `test/bptf/buyerSignals090.test.ts`,
    `test/domain/impersonator090.test.ts`, `test/net/steamEresult090.test.ts`, `test/net/challenge429090.test.ts`,
    `test/shared/scraptfChallenge090.test.ts`.
  - scrap.tf: `test/shared/checkoutGuard.test.ts`, `test/shared/bankStockNotifyGuard090.test.ts`,
    `test/renderer/checkoutGuardModel.test.ts`, `test/renderer/aboutModel.test.ts`,
    `test/import/parserEvidence090.test.ts`, `test/service/bankUnavailable090.test.ts`,
    `test/shared/banksNotice090.test.ts`, `test/domain/banksUnavailable090.test.ts`,
    `test/renderer/banksUnavailable090.test.ts`, `test/renderer/bankStockMarkdown090.test.ts`,
    `test/renderer/importEvidence090.test.ts`, `test/pricedb/schema.names090.test.ts`,
    `test/import/effectAlias090.test.ts`, `test/renderer/mockScraptf090.test.ts` (parity).
  - Holdings and ledger: `test/shared/robustStats.test.ts`, `test/shared/holdingTradeLock.test.ts`,
    `test/shared/holdingTrendSize.test.ts`, `test/shared/keyMoveBand.test.ts`, `test/shared/holdingsValuation.test.ts`,
    `test/domain/holdingsTradeLock.test.ts`, `test/service/journalValuationRpc.test.ts`,
    `test/pricedb/pricedb.keyHistory.test.ts`, `test/renderer/holdingsLedgerText.test.ts`,
    `test/renderer/tradeLock.test.ts`, `test/renderer/journalValuation.test.ts`,
    `test/renderer/mockHoldings09.test.ts` (parity).
  - Ranking: `test/shared/exitRisk.test.ts`, `test/shared/reserveSuggest.test.ts`,
    `test/domain/engineRanking090.test.ts`, `test/domain/marketRanking090.test.ts`,
    `test/domain/bankStockDepthNotify090.test.ts`, `test/service/reserveSuggestionRpc090.test.ts`,
    `test/renderer/riskModel.test.ts`, `test/renderer/oppSort090.test.ts`, `test/renderer/mockRanking090.test.ts`
    (parity), `test/main/settingsRisk090.test.ts`.
  - History: `test/shared/orderPersistence.test.ts`, `test/shared/communityHistory.test.ts`,
    `test/shared/scraptfLows.test.ts`, `test/bptf/bptfItem.community.test.ts`, `test/bptf/bptfSocket.history.test.ts`,
    `test/domain/orderSpells.test.ts`, `test/domain/communityFeed.test.ts`, `test/domain/scraptfLowsHistory.test.ts`,
    `test/domain/bookHistory.test.ts`, `test/service/bookHistoryRpc.test.ts`,
    `test/service/communityPricesJob.test.ts`, `test/service/bookHistoryCore.test.ts`,
    `test/renderer/bookHistoryModel.test.ts`, `test/renderer/drawerBookHistory.test.ts`,
    `test/renderer/mockBookHistory.test.ts` (parity), `test/compliance/history090.test.ts`.
  - Timing: `test/shared/scraptfTimingCi.test.ts`, `test/renderer/timingUncertainty.test.ts` (with the mock parity
    case).
  - Docs: `test/shared/audit-090-brief-corrections.test.ts`.
  - Integration: `test/shared/audit-090-docs.test.ts`.
- **What pins the round.**
  - `test/shared/audit-090-docs.test.ts`: this section names every shipped RESEARCH rank (#1, #2, #3, #6, #7, #9,
    #10, #11, #12, #13, #14, #17, #22, #25), V16 and the three settings keys, states the boundary (no budget raised;
    the SCM cap only lowers one), has a subsection per package whose test files exist and gives `package.json`'s
    version; the README has "New in 0.9" (before 0.8's notes, with the boundary in its intro, the not-a-forecast,
    demand-not-sales and order-persistence wording, and the one-time effects), names `docs/RESEARCH.md` in its
    Documentation list and lists the 0.9 known limits; no 0.9 build marker comment is left in this file, and no wave
    marker in `static.test.ts`.
  - `test/shared/audit-080-docs.test.ts`: the 0.8 round's slice ends at this section (D15), and its version check
    reads that round's own `**Version.** 0.8.0` line, no longer `package.json`.
  - `test/shared/audit-074-docs-consistency.test.ts` still holds over the new text: the installer path equals
    `package.json`'s version (review R41); the ownership table has a row for every `src/shared` module both the mock
    and the service import (`exitRisk.ts`, `reserveSuggest.ts`, `orderPersistence.ts` and `scraptfLows.ts` among the
    new ones) and `ceiling.ts` keeps its cost-check names; the README's current text, "New in 0.9" included, keeps its
    counted phrases (the 0.9 text says "seen in the last 24 h", never "in the last day", and never "half the cards").
  - `test/shared/audit-090-brief-corrections.test.ts`: the DESIGN_BRIEF corrections and the FIELDS.md rows, against
    the code and the capture.
  - `test/compliance/static.test.ts`: `F20_FILES` holds the new modules of holdings-ledger, scrap.tf, ranking and
    history (no request, socket, URL opener, `href=`/`src=` or http text, and no import of electron, node:http(s)/net or
    `../net`); `JOURNAL_FILES`, `DOMAIN_AND_SHARED_BEFORE_080` and `F20_OPENING_FILES` are unchanged; exits' automation
    deny-list finds nothing in `src/` and no browser-automation package among the dependencies, and `EXIT_FILES` opens
    and loads nothing; scrap.tf's boundary panel describe pins that the About panel copies and never opens; the
    dashboard file that shows a `StepSparkline` (`BookHistorySection.tsx`) is scanned; `nonStaticOpenUrls` still
    finds only `scraptfResaveNotice`, and `notifyOpenProblems` one guarded `openExternal`; the F21 window checks are
    unchanged (exits' phrase check loads nothing). `test/renderer/externalLinks.test.ts` skips only `aboutModel.ts`,
    whose addresses are copied, never opened (D8).
  - `test/shared/profitPath.test.ts`: rules (1) and (2) pass with no new allowlist entry (breakEvenModel.ts
    destructures `frictionScrap`, D7), and rule (3) lists `shared/exitRisk.ts` among the `flipProfit` callers.
  - The migration pins (D1): `audit-v15-journal-fees.test.ts`, `watches.test.ts` and `holdingMarks.test.ts` check V15
    with `MIGRATIONS.slice(0, 15)`, `db.test.ts` lists `bptf_community_history`, `order_spells` and `scraptf_lows`,
    `bankStock.test.ts` and `importBank.test.ts` pin the new columns, and `SCHEMA_VERSION === MIGRATIONS.length`
    (16); V15's text is byte-identical to 0.8.0's.
- **Totals.** `npx vitest run`: 625 test files and 8,404 tests, all passing, the timed group included
  (0.8.0 as committed: 551 files and 7,638 tests); `npm run typecheck` clean; `npm run build` succeeds.
- **Version.** 0.9.0 (`package.json`, `package-lock.json`'s root entries; README's installer path, which
  audit-074-docs-consistency pins). The mock's `MOCK_APP_VERSION` reads `package.json`.

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
11. **Unverified orders and buyer liveness (0.7.4).** Brief §2.1, §5.5 and §5.7 count an order unseen for 24 h like
    any other for Conservative and Instant, only lowering confidence, and give "+5 online" from the stored flag. The
    brief's premise is that bumps are not streamed, but deletes and reprices made while the app or the feed was off
    are never re-sent, so from 0.7.4 a verified order is preferred for Conservative and the median when one exists,
    Instant never takes an unverified bot, such rows are not notified until a snapshot or feed event confirms them
    (§5.6), "+5 online" needs an event within 2 h and the near-buyer count verified orders. The cost checks
    (`variant-suspect`, `cost-below-market`) add a cost-side rule to §5.7's buy-side table. Integration ("Revenue
    picks", "Reference age", Notifications). From 0.9 (#11) no "+5 online" is given at all (RESEARCH §4.2); the rest
    stands.
12. **Unusual skins and defindex aliases (0.7.4).** Brief §4.3 keyed an unusual skin as quality 15 plus the effect
    (the brief, §4.2 and test/fixtures/bptf/FIELDS.md now say 5); backpack.tf's buy orders key it as 5 plus the
    effect, so the app does (F15 P2). Brief §4.2's "defindex aliases"
    from IGetPrices' defindex[] are built from the schema instead (same item_name and item_class, `pickDefindex` as
    the canonical choice) and applied when books are read, not stored (Integration "Book twins"), so they hold before
    the first IGetPrices fetch and without a backpack.tf key.
13. **Trade lock (0.9).** Brief §5.8 and §8 planned a settings flag adding a 7-day lock warning to every opportunity.
    0.9's Settings → Trade lock (RESEARCH #1) defaults to Not sure and applies to Holdings only: a buy decision comes
    before the lock starts, and the lock delays only the resale. With a 7-day lock, Holdings shows Locked advice with
    the tradable date, leaves the item out of Sellable now and holds its "Sell:" toast until it unlocks. Prices and
    profits are unchanged.
