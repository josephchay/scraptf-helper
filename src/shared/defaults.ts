import type { DeepPartial, Settings } from './types';

export const DEFAULT_NOTES_KEYWORDS: readonly string[] = [
  'painted',
  'paint',
  'spell',
  'spelled',
  'spells',
  'part',
  'parts',
  'only',
  'dupe',
  'duped',
  'clean only',
  'no dupes',
  'specific',
  'level',
];

export const DEFAULT_SETTINGS: Settings = {
  contactUrl: '',
  keyPrice: {
    mode: 'auto',
    manualScrap: null,
    scraptfBuyScrap: null,
    scraptfSellScrap: null,
    scraptfObservedAt: null,
  },
  profit: {
    minProfitScrap: 9,
    minProfitPctOfCost: 0.05,
    minMargin: 0.08,
    frictionScrap: 0,
    // 0.8 (PC-1): no price-move reserve, so profit and Pay up to are exactly as before.
    exitReservePct: 0,
    // 0.9 (#2): about 10% (one 2019 forum comment); used for break-even and the journal hint only.
    marketplaceFeePct: 0.1,
    outlierVsMedian: 1.3,
    outlierVsRef: 1.5,
    unusualRiskKeys: 10,
    useOrder: 'conservative',
    inputStaleMs: 2 * 60 * 60 * 1000,
    notesKeywords: [...DEFAULT_NOTES_KEYWORDS],
    // Brief §8: about a third of PriceDB SKUs are older than 30 days; older references are ignored.
    referenceMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
    // 200% with few buyers and no usable reference is usually the wrong variant or unit.
    suspectMargin: 2,
  },
  // Brief §2.1 says 12 GB, but the cap counts decompressed payload (~13 GB on a
  // measured day), so 12 GB would pause the feed most evenings. See the
  // deviations list in docs/ARCHITECTURE.md; users on capped links lower it.
  liveFeed: { enabled: true, dailyCapBytes: 25_000_000_000, keepSellListings: 'watched' },
  connectors: { bptfApi: true, pricedb: true, pricedbSocket: true, scm: false },
  // F20: re-save reminders are off (0 min); [] reminds of every bank saved at least once.
  import: { enabled: false, acknowledgedAt: null, watchFolder: null, permission: null, resaveReminderMin: 0, resaveBanks: [] },
  notifications: {
    enabled: true,
    minConfidence: 45,
    minProfitScrap: 18,
    dedupMs: 30 * 60 * 1000,
    inputKinds: ['user', 'import', 'rule'],
    silent: false,
    holdings: true,
    newOnScraptf: true,
    watches: true,
    // 0.8 (G4): "Buy now" toasts are opt-in; 0.7.4 sent none (D25).
    buyTiming: false,
    // 0.9 (#3): the risk control is off, so every flip toasts as in 0.8.
    minProfitableDepth: 0,
  },
  app: { startAtLogin: false, startHidden: false, closeToTray: true, quickEntryHotkey: 'CommandOrControl+Alt+F' },
  // Live check (F16): the watcher reads the clipboard, so it stays off until the user turns it on.
  check: { hotkey: 'CommandOrControl+Alt+C', watchClipboard: false, notifyFlips: true, popup: true },
  // F21: the scrap.tf window carries a ban risk the user must accept first, so it starts off.
  scraptfWindow: { enabled: false, acknowledgedAt: null, keepLoggedIn: false, readOnLoad: true, openLinksInWindow: false },
  networkPaused: false,
  blocklist: [],
  ownSteamIds: [],
  // 0.9 (#1): not answered, not sure: Holdings asks once and changes no number (Trade Protection's TF2 scope is contested).
  tradeLock: { mode: 'unknown', answeredAt: null },
  ui: { theme: 'system', density: 'comfortable' },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Shapes of settings fields that may be null, so a patch filling them in cannot add unknown keys. */
const NULLABLE_OBJECT_KEYS: Record<string, readonly string[]> = {
  'import.permission': ['grantor', 'contact', 'grantedAt', 'scope'],
};

/**
 * Deep-merges a partial update into settings. Arrays and nulls replace;
 * unknown keys are ignored so stale or hostile input cannot add fields.
 * Value types are not checked here; main validates the result with settingsSchema.
 */
export function mergeSettings(base: Settings, patch: DeepPartial<Settings> | undefined | null): Settings {
  const merge = (b: unknown, p: unknown, path: string): unknown => {
    if (p === undefined) return b;
    if (b === null && isPlainObject(p) && NULLABLE_OBJECT_KEYS[path]) {
      const out: Record<string, unknown> = {};
      for (const k of NULLABLE_OBJECT_KEYS[path]!) if (k in p) out[k] = structuredClone(p[k]);
      return out;
    }
    if (!isPlainObject(b) || !isPlainObject(p)) return Array.isArray(p) ? structuredClone(p) : p;
    const out: Record<string, unknown> = { ...b };
    for (const k of Object.keys(b)) {
      if (k in p) out[k] = merge(b[k], p[k], path ? `${path}.${k}` : k);
    }
    return out;
  };
  return merge(structuredClone(base), patch ?? {}, '') as Settings;
}
