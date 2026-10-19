// Opportunity engine and its read-side views (design brief §5).

export {
  BACKGROUND_CHECK_KEYS,
  CHANGE_PROFIT_DELTA,
  DEBOUNCE_MS,
  MAX_NOTIFICATIONS_PER_RUN,
  MAX_NOTIFIED_EVENTS_PER_RUN,
  NOTIFY_META_KEY,
  RETENTION,
  SWEEP_INTERVAL_MS,
  bookFlags,
  buyerCountOf,
  cleanTarget,
  createEngine,
  evaluateOpportunity,
  explicitInput,
  notificationBody,
  notificationSummaryTitle,
  notificationTitle,
  notifyKinds,
  priceBook,
  revenueOrderByValue,
  revenueOrderOf,
  ruleInput,
  runMaintenance,
  validRule,
  type EngineDeps,
  type EngineInput,
  type EvaluateArgs,
  type PricedBook,
} from './engine';

export {
  DEFAULT_KEY_SCRAP,
  KEY_PRICE_STALE_MS,
  defaultKeyPrice,
  effectiveScraptfKey,
  isQuoteStale,
  selectKeyPrice,
  type ScraptfKeyPrices,
} from './keyprice';

export { createScraptfListCache, type ScraptfListCache, type ScraptfListCacheDeps } from './scraptfList';

export {
  BANK_STOCK_NOTIFY_META_KEY,
  BANK_STOCK_RETRY_MS,
  bankStockCsv,
  createBankStock,
  createNewFlipNotifier,
  notifyNewBankFlips,
  previousOf,
  type BankStock,
  type BankStockDeps,
  type BankStockNotifyDeps,
  type NewFlipNotifier,
  type NewFlipNotifierDeps,
} from './bankStock';

export {
  SCRAPTF_HISTORY_RETRY_MS,
  createScraptfHistory,
  scraptfChangedPush,
  scraptfChangesCsv,
  type ScraptfHistory,
  type ScraptfHistoryDeps,
} from './scraptfHistory';

export { RESAVE_TICK_MS, createResaveReminders, type ResaveReminders, type ResaveRemindersDeps } from './resaveReminders';

export {
  BANKS_PUSH_MS,
  createBanksSummary,
  emptyBankSummary,
  opportunityBank,
  type BanksInvalidation,
  type BanksSummary,
  type BanksSummaryDeps,
} from './banks';

export {
  EXCLUDING_FLAGS,
  UNVERIFIED_AFTER_MS,
  anyEffectBaseOf,
  classifyOrder,
  compileKeywords,
  dedupeOrders,
  foldText,
  isSpecialEmpty,
  listingSpecial,
  matchContext,
  normalizeSpecial,
  notesMatch,
  ruleMatches,
  specialCovers,
  specialEquals,
  type MatchContext,
  type MatchTarget,
  type OrderClass,
  type RuleSubject,
} from './matcher';

export {
  DEFAULT_REFERENCE_MAX_AGE_MS,
  communityScrap,
  compareValued,
  computePrices,
  hasReferenceValue,
  lookupReferences,
  median,
  outlierRefs,
  pickRevenueOrder,
  referencePrices,
  refreshReferenceAge,
  toOrderSummary,
  usableReferences,
  valueOrders,
  type ClassifiedOrder,
  type PriceRefs,
  type PriceResult,
  type RawReferences,
  type UsableReferences,
  type ValuedOrder,
  type ValuedOrderLike,
} from './pricing';

export {
  BASE_SCORE,
  BOT_PULSE_MS,
  CONFIRMED_MS,
  FRESH_INPUT_MS,
  SUSPECT_MIN_ORDERS,
  isSuspectMargin,
  scoreConfidence,
  type ConfidenceInput,
  type ConfidenceResult,
} from './confidence';

export {
  CONFIDENCE_LABELS,
  CONFIDENCE_ORDER,
  HIGH_CONFIDENCE,
  INPUT_KIND_LABELS,
  INPUT_KIND_ORDER,
  LOW_CAP,
  MEDIUM_CAP,
  MEDIUM_CONFIDENCE,
  REF10_SCRAP,
  REF2_SCRAP,
  STATUS_ORDER,
  TIER_ORDER,
  confidenceLevel,
  maxCostFor,
  minProfitFor,
  profitStatus,
  profitTier,
} from './tiers';

export {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  buildItemDetail,
  groupKeyOf,
  groupLabel,
  groupOrder,
  itemRevenue,
  itemSeenOn,
  listOpportunities,
  previewRule,
  summarizeGroups,
  type ItemDetailArgs,
} from './views';

export { journalSummary, journalValue } from './journal';

export { CSV_BOM, csvCell, eventsCsv, journalCsv, opportunitiesCsv, toCsv, type CsvCell } from './csv';

export { buildShoppingList, shoppingCsv } from './shopping';

export {
  MARKET_DIRTY_BATCH_MS,
  MARKET_FULL_EVERY_MS,
  MARKET_NOTIFY_MS,
  MARKET_RETRY_MAX_MS,
  MARKET_RETRY_MIN_MS,
  MARKET_SLICE_MS,
  COVERAGE_BATCHES,
  createMarketIndex,
  evaluateMarketBase,
  marketCategoryOf,
  marketCsv,
  type MarketEval,
  type MarketEvalArgs,
  type MarketIndex,
  type MarketIndexDeps,
  type UncheckedGroup,
} from './market';

export {
  HOLDINGS_CHECK_MS,
  HOLDINGS_NOTIFY_META_KEY,
  createHoldings,
  holdingNotification,
  holdingsCsv,
  type Holdings,
  type HoldingsDeps,
} from './holdings';

export {
  CHECK_EXTRAS_NOTE,
  CHECK_FUZZY_NOTE,
  CHECK_INCOMPLETE_NOTE,
  CHECK_MAX_RESOLVES,
  CHECK_SCHEMA_LOADING_REASON,
  CHECK_SCRAPTF_LINK_REASON,
  CHECK_SOLD_OUT_NOTE,
  checkVerdict,
  chooseCheckPrice,
  copiedSoldOut,
  createLiveCheck,
  looselySameName,
  newestStoredPrice,
  parseCheckText,
  storedPriceHasExtras,
  type CheckForm,
  type CheckMoney,
  type LiveCheck,
  type LiveCheckDeps,
  type ParseCheckOptions,
  type ParseCheckResult,
  type ParsedCheck,
} from './liveCheck';
