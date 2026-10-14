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
  createEngine,
  evaluateOpportunity,
  explicitInput,
  notificationBody,
  revenueOrderOf,
  ruleInput,
  runMaintenance,
  type EngineDeps,
  type EngineInput,
  type EvaluateArgs,
} from './engine';

export { DEFAULT_KEY_SCRAP, KEY_PRICE_STALE_MS, defaultKeyPrice, isQuoteStale, selectKeyPrice } from './keyprice';

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
  communityScrap,
  compareValued,
  computePrices,
  lookupReferences,
  median,
  outlierRefs,
  referencePrices,
  refreshReferenceAge,
  toOrderSummary,
  valueOrders,
  type ClassifiedOrder,
  type PriceRefs,
  type PriceResult,
  type RawReferences,
  type ValuedOrder,
  type ValuedOrderLike,
} from './pricing';

export {
  BASE_SCORE,
  BOT_PULSE_MS,
  CONFIRMED_MS,
  FRESH_INPUT_MS,
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
  MEDIUM_CAP,
  MEDIUM_CONFIDENCE,
  REF10_SCRAP,
  REF2_SCRAP,
  STATUS_ORDER,
  TIER_ORDER,
  confidenceLevel,
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
  listOpportunities,
  previewRule,
  summarizeGroups,
  type ItemDetailArgs,
} from './views';

export { journalSummary, journalValue } from './journal';

export { CSV_BOM, csvCell, eventsCsv, journalCsv, opportunitiesCsv, toCsv, type CsvCell } from './csv';
