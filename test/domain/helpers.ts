// Test doubles for the domain tests: listings, settings, a fake clock and
// timers, a small schema stub and recording engine events. Nothing here
// touches the network.

import { categorize, categoryOfSkuOnly } from '../../src/shared/categories';
import { mergeSettings, DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { fromString } from '../../src/shared/sku';
import { KILLSTREAK_NAMES, QUALITY_NAMES } from '../../src/shared/types';
import type {
  Category,
  ConnectorHealth,
  DeepPartial,
  Listing,
  Settings,
  SpecialAttrs,
  UnixMs,
} from '../../src/shared/types';
import type {
  EngineEvents,
  HttpClient,
  Logger,
  SchemaItemRow,
  SchemaService,
  ServiceDeps,
  Repo,
} from '../../src/service/contracts';
import type { TimerApi } from '../../src/service/net/ratelimit';

export const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;

export function special(over: Partial<SpecialAttrs> = {}): SpecialAttrs {
  return { paint: null, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false, ...over };
}

let listingSeq = 0;

export function makeListing(over: Partial<Listing> = {}): Listing {
  listingSeq++;
  return {
    id: `buy_${listingSeq}`,
    sku: '378;6',
    baseSku: '378;6',
    intent: 'buy',
    steamid: `7656119800000${String(listingSeq).padStart(4, '0')}`,
    userName: `Buyer ${listingSeq}`,
    keys: 0,
    metalScrap: 27,
    isBot: false,
    uaClient: null,
    uaLastPulse: null,
    userOnline: null,
    userBanned: false,
    isMarketplace: false,
    special: special(),
    details: '',
    listedAt: Math.floor((T0 - HOUR) / 1000),
    bumpedAt: null,
    lastEventAt: T0 - MIN,
    origin: 'ws',
    itemName: 'Team Captain',
    marketName: null,
    ...over,
  };
}

export function testSettings(patch: DeepPartial<Settings> = {}): Settings {
  return mergeSettings(DEFAULT_SETTINGS, patch);
}

export class FakeClock {
  constructor(public t: UnixMs = T0) {}
  now = (): UnixMs => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Manual timers driven by the fake clock; advance() fires due timers in order. */
export class FakeTimers implements TimerApi {
  private seq = 0;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();

  constructor(private readonly clock: FakeClock) {}

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.pending.set(id, { at: this.clock.t + Math.max(0, ms), fn });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  get count(): number {
    return this.pending.size;
  }

  advance(ms: number): void {
    const end = this.clock.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.pending) {
        if (entry[1].at > end) continue;
        if (!next || entry[1].at < next[1].at || (entry[1].at === next[1].at && entry[0] < next[0])) next = entry;
      }
      if (!next) break;
      this.pending.delete(next[0]);
      this.clock.t = Math.max(this.clock.t, next[1].at);
      next[1].fn();
    }
    this.clock.t = end;
  }
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function recordingLogger(): Logger & { lines: { level: string; msg: string; meta?: unknown }[] } {
  const lines: { level: string; msg: string; meta?: unknown }[] = [];
  const at = (level: string) => (msg: string, meta?: unknown) => {
    lines.push({ level, msg, meta });
  };
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** An HttpClient that fails the test if the domain ever tries to use the network. */
export const noNetwork: HttpClient = {
  request: () => Promise.reject(new Error('domain code must not make HTTP requests')),
  setPaused: () => undefined,
  isPaused: () => false,
  nextAllowedAt: () => 0,
  budgets: () => [],
  hostBlocked: () => null,
  blockHost: () => undefined,
  unblockHost: () => undefined,
  userAgent: () => 'TF2FlipDesk/0.1.0 (+test)',
};

export interface RecordedEvents extends EngineEvents {
  changed: { appeared: number; changed: number; gone: number; at: UnixMs }[];
  notified: { title: string; body: string; sku: string | null }[];
}

export function recordingEvents(): RecordedEvents {
  const changed: RecordedEvents['changed'] = [];
  const notified: RecordedEvents['notified'] = [];
  return {
    changed,
    notified,
    onChanged: (s) => {
      changed.push(s);
    },
    onNotify: (n) => {
      notified.push(n);
    },
  };
}

function item(defindex: number, itemName: string, itemClass: string, slot: string | null): SchemaItemRow {
  return { defindex, name: itemName, itemName, properName: false, itemClass, slot, craftClass: null, usedByClasses: [], imageUrl: null };
}

export const DOMAIN_ITEMS: SchemaItemRow[] = [
  item(378, 'Team Captain', 'tf_wearable', 'head'),
  item(126, "Bill's Hat", 'tf_wearable', 'head'),
  item(205, 'Rocket Launcher', 'tf_weapon_rocketlauncher', 'primary'),
  item(15000, 'Sniper Rifle', 'tf_weapon_sniperrifle', 'primary'),
  item(5021, 'Mann Co. Supply Crate Key', 'tool', null),
  item(30920, 'Taunt: The Bunnyhopper', 'tf_wearable', 'taunt'),
];

export interface StubSchemaOptions {
  items?: SchemaItemRow[];
  /** Overrides the category of SKUs whose defindex is not in `items`. */
  categoryOf?: (defindex: number) => Category;
  nameOf?: (sku: string) => string;
  loaded?: boolean;
}

/** In-memory SchemaService with the lookups the domain uses. */
export function createStubSchema(opts: StubSchemaOptions = {}): SchemaService & { calls: Record<string, number> } {
  const items = new Map((opts.items ?? DOMAIN_ITEMS).map((i) => [i.defindex, i]));
  const calls: Record<string, number> = {};
  const count = (k: string): void => {
    calls[k] = (calls[k] ?? 0) + 1;
  };
  const effects: Record<number, string> = { 13: 'Burning Flames', 702: 'Isotope' };
  const paintkits: Record<number, string> = { 14: 'Night Owl', 102: 'Sand Cannon' };

  const baseName = (sku: string): string => items.get(fromString(sku).defindex)?.itemName ?? sku;
  const nameForSku = (sku: string): string => {
    if (opts.nameOf) return opts.nameOf(sku);
    const o = fromString(sku);
    const it = items.get(o.defindex);
    if (!it) return sku;
    const parts: string[] = [];
    if (!o.craftable) parts.push('Non-Craftable');
    if (o.quality2 === 11) parts.push('Strange');
    if (o.effect) parts.push(effects[o.effect] ?? `Effect ${o.effect}`);
    else if (o.quality !== 6) parts.push(QUALITY_NAMES[o.quality] ?? `Quality ${o.quality}`);
    if (o.killstreak) parts.push(KILLSTREAK_NAMES[o.killstreak] ?? 'Killstreak');
    if (o.australium) parts.push('Australium');
    parts.push(it.itemName);
    return parts.join(' ');
  };

  const health: ConnectorHealth = {
    id: 'schema',
    label: 'Item schema',
    state: 'idle',
    detail: 'stub',
    lastOkAt: null,
    lastErrorAt: null,
    lastError: null,
    disabledReason: null,
  };

  return {
    calls,
    init: async () => undefined,
    refresh: async () => undefined,
    isLoaded: () => opts.loaded ?? true,
    health: () => health,
    itemByDefindex: (d) => items.get(d) ?? null,
    itemQuality: (d) => (items.has(d) ? 6 : null),
    nameForSku: (sku) => {
      count('nameForSku');
      return nameForSku(sku);
    },
    baseNameForSku: (sku) => baseName(sku),
    marketHashName: (sku) => {
      const it = items.get(fromString(sku).defindex);
      return it ? it.itemName : null;
    },
    resolve: () => null,
    search: () => [],
    categoryForSku: (sku) => {
      count('categoryForSku');
      const o = fromString(sku);
      const it = items.get(o.defindex);
      if (it) return categorize(o, it);
      if (opts.categoryOf) return opts.categoryOf(o.defindex);
      return categoryOfSkuOnly(o);
    },
    effectName: (id) => effects[id] ?? null,
    effectIdByName: () => null,
    canonicalEffectId: (id) => id,
    paintByDecimal: () => null,
    paintDecimalByHex: () => null,
    paintkitName: (id) => paintkits[id] ?? null,
    paintkitIdByName: () => null,
    paintkits: () => [],
  };
}

export function makeDeps(repo: Repo, clock: FakeClock, settings: () => Settings, log: Logger = silentLogger): ServiceDeps {
  return { clock, log, repo, http: noNetwork, settings, secret: () => null };
}
