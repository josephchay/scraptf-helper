// Request budgets, set below every published limit (DESIGN_BRIEF §2.0 "Our
// budget" column). Cadences such as "IGetPrices every 2 h" are driven by the
// scheduler; these specs are the hard ceilings the HTTP client enforces.

import type { BudgetSpec } from '../contracts';
import { normalizeHost } from './policy';

/** BudgetSpec plus optional network-layer behaviour. Extra fields are optional, so this stays a BudgetSpec. */
export interface NetBudgetSpec extends BudgetSpec {
  /** Minimum pause after any 429 on this budget (SCM lockouts last hours). */
  on429PauseMs?: number;
  /** Pause until RateLimit-Reset whenever RateLimit-Remaining drops below this. */
  minRemaining?: number;
}

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

export const BUDGETS: NetBudgetSpec[] = [
  {
    id: 'bptf-snapshot',
    host: 'api.backpack.tf',
    minIntervalMs: 10 * SEC,
    maxPerHour: 300,
    concurrency: 1,
    description: 'Classifieds snapshot: 1 per 10 s, at most 300 per hour (user-driven or watched items only)',
  },
  {
    id: 'bptf-prices',
    host: 'api.backpack.tf',
    minIntervalMs: 15 * MIN,
    maxPerDay: 96,
    concurrency: 1,
    description: 'IGetPrices v4: full fetch once, then deltas every 2 h; never more often than every 15 min',
  },
  {
    id: 'bptf-currencies',
    host: 'api.backpack.tf',
    minIntervalMs: 5 * MIN,
    maxPerHour: 3,
    concurrency: 1,
    description: 'IGetCurrencies v1: every 60 min (at most 3 per hour, 5 min apart, so key tests still work)',
  },
  {
    id: 'bptf-users',
    host: 'api.backpack.tf',
    minIntervalMs: 10 * SEC,
    concurrency: 1,
    description: 'User info: at most 1 per 10 s, steamids batched',
  },
  {
    id: 'bptf-misc',
    host: 'api.backpack.tf',
    minIntervalMs: 10 * SEC,
    maxPerHour: 60,
    concurrency: 1,
    description: 'Other backpack.tf API calls (token tests): at most 1 per 10 s, 60 per hour',
  },
  {
    id: 'pricedb',
    host: 'pricedb.io',
    minIntervalMs: 500,
    maxPerMinute: 60,
    concurrency: 2,
    minRemaining: 36,
    description: 'PriceDB: at most 60 per minute; pauses while RateLimit-Remaining < 36',
  },
  {
    id: 'sku',
    host: 'sku.pricedb.io',
    minIntervalMs: 500,
    maxPerMinute: 30,
    concurrency: 1,
    description: 'sku.pricedb.io: lookups at most 30 per minute; schema at most once per 24 h with If-None-Match',
  },
  {
    id: 'steam-webapi',
    host: 'api.steampowered.com',
    minIntervalMs: SEC,
    maxPerDay: 5_000,
    concurrency: 1,
    description: 'Steam Web API: at most 1 per second, hard cap 5,000 per day',
  },
  {
    id: 'scm',
    host: 'steamcommunity.com',
    minIntervalMs: 5 * SEC,
    maxPerHour: 120,
    // 0.9 (#14): at most 300 a day, under the community-measured 1,000 (RESEARCH §4.6); a rolling 24 h, seeded at start.
    maxPerDay: 300,
    concurrency: 1,
    on429PauseMs: 6 * HOUR,
    description: 'Market priceoverview: on click only, at most 1 per 5 s and 300 per day; a 429 disables it for 6 h',
  },
  {
    id: 'mannco',
    host: 'api.mannco.store',
    minIntervalMs: MIN,
    concurrency: 1,
    description: 'mannco.store API: bulk pricing at most 1 per minute',
  },
  {
    id: 'mannco-prices',
    host: 'api.mannco.store',
    minIntervalMs: HOUR,
    concurrency: 1,
    description: 'mannco.store /item/prices: at most 1 per hour (published limit 1 per 5 min)',
  },
  {
    id: 'mannco-login',
    host: 'api.mannco.store',
    minIntervalMs: MIN,
    maxPerDay: 10,
    concurrency: 1,
    description: 'mannco.store login: at most 1 per minute, 10 per day (the JWT lasts about 31 days)',
  },
  {
    id: 'mptf',
    host: 'marketplace.tf',
    minIntervalMs: 5 * SEC,
    maxPerHour: 60,
    concurrency: 1,
    description: 'marketplace.tf API: on click only, at most 1 per 5 s',
  },
  {
    id: 'stn',
    host: 'api.stntrading.eu',
    minIntervalMs: 5 * SEC,
    maxPerHour: 60,
    concurrency: 1,
    description: 'STN Trading API: on click only, at most 1 per 5 s (calls may cost credits)',
  },
];

/** Concurrent requests per host across all of its budgets (§2.0: 1 per host, 2 for pricedb.io). */
export const HOST_CONCURRENCY: Readonly<Record<string, number>> = {
  'pricedb.io': 2,
};

export const DEFAULT_HOST_CONCURRENCY = 1;

/** Budget id the HTTP client uses for `url` when the caller does not name one; null for unknown hosts. */
export function defaultBudgetFor(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = normalizeHost(u.hostname);
  const p = u.pathname.toLowerCase();
  switch (host) {
    case 'api.backpack.tf':
    case 'backpack.tf':
      if (p.includes('/classifieds/listings/snapshot')) return 'bptf-snapshot';
      if (p.includes('/igetprices/')) return 'bptf-prices';
      if (p.includes('/igetcurrencies/')) return 'bptf-currencies';
      if (p.includes('/users/info') || p.includes('/igetusers/')) return 'bptf-users';
      return 'bptf-misc';
    case 'pricedb.io':
    case 'ws.pricedb.io':
      return 'pricedb';
    case 'sku.pricedb.io':
      return 'sku';
    case 'api.steampowered.com':
      return 'steam-webapi';
    case 'steamcommunity.com':
      return 'scm';
    case 'api.mannco.store':
      if (p === '/user/login') return 'mannco-login';
      if (p === '/item/prices' || p.startsWith('/item/prices/')) return 'mannco-prices';
      return 'mannco';
    case 'marketplace.tf':
      return 'mptf';
    case 'api.stntrading.eu':
      return 'stn';
    default:
      return null;
  }
}

export function budgetById(id: string, budgets: readonly BudgetSpec[] = BUDGETS): BudgetSpec | undefined {
  return budgets.find((b) => b.id === id);
}

function stricterMin(def: number, v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > def ? v : def;
}

function stricterMax(def: number | undefined, v: number | undefined): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return def;
  return def === undefined ? v : Math.min(def, v);
}

/**
 * Applies user/config overrides that may only tighten the defaults (§8: budgets
 * above the §2.0 defaults are refused). Unknown ids are ignored.
 */
export function tightenBudgets(
  overrides: readonly (Partial<BudgetSpec> & { id: string })[],
  base: readonly NetBudgetSpec[] = BUDGETS,
): NetBudgetSpec[] {
  return base.map((spec) => {
    const o = overrides.find((x) => x.id === spec.id);
    if (!o) return { ...spec };
    const concurrency =
      typeof o.concurrency === 'number' && Number.isInteger(o.concurrency) && o.concurrency >= 1
        ? Math.min(spec.concurrency, o.concurrency)
        : spec.concurrency;
    return {
      ...spec,
      minIntervalMs: stricterMin(spec.minIntervalMs, o.minIntervalMs),
      maxPerMinute: stricterMax(spec.maxPerMinute, o.maxPerMinute),
      maxPerHour: stricterMax(spec.maxPerHour, o.maxPerHour),
      maxPerDay: stricterMax(spec.maxPerDay, o.maxPerDay),
      concurrency,
    };
  });
}
