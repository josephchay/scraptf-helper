// Public surface of the network layer. Service code imports from here only.

export {
  ForbiddenHostError,
  HostBlockedError,
  HttpStatusError,
  HttpTimeoutError,
  NetworkPausedError,
  RateLimitedError,
} from './errors';

export {
  allowedHosts,
  assertAllowed,
  checkUrl,
  isBackpackHost,
  isScrapTfHost,
  normalizeHost,
  type PolicyDecision,
  type UrlKind,
} from './policy';

export {
  BUDGETS,
  DEFAULT_HOST_CONCURRENCY,
  HOST_CONCURRENCY,
  budgetById,
  defaultBudgetFor,
  tightenBudgets,
  type NetBudgetSpec,
} from './budgets';

export {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  BudgetScheduler,
  CONSECUTIVE_429_LIMIT,
  ConcurrencyGate,
  LONG_PAUSE_MS,
  backoffMs,
  realTimers,
  type AcquireOptions,
  type BudgetState,
  type PauseResult,
  type Permit,
  type Priority,
  type TimerApi,
} from './ratelimit';

export {
  DEFAULT_SECRET_HEADERS,
  DEFAULT_SECRET_KEYS,
  REDACTED,
  SecretRegistry,
  globalSecrets,
  redactHeaders,
  redactText,
  redactUrl,
  registerSecret,
  scrubText,
  unregisterSecret,
  type RedactOptions,
} from './redact';

export {
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_TIMEOUT_MS,
  ERROR_TEXT_LIMIT,
  MAX_REDIRECTS,
  NetworkRequestError,
  assertHonestUserAgent,
  buildUserAgent,
  createHttpClient,
  isBrowserLikeUserAgent,
  parseHostBlocks,
  parseRateLimit,
  parseRetryAfter,
  retryDelayFromResponse,
  type CreateHttpClientOptions,
} from './http';
