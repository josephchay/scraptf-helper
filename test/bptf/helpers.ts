// Test doubles for the backpack.tf connectors: a small SchemaService, a fake
// HttpClient, a fake WebSocketLike and a recording logger. Nothing here touches
// the network.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromString } from '../../src/shared/sku';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { ConnectorHealth, DeepPartial, HostBudget, ItemSuggestion, ResolvedItem, SecretName, Settings } from '../../src/shared/types';
import { KILLSTREAK_NAMES, QUALITY_NAMES, WEAR_NAMES } from '../../src/shared/types';
import type {
  EffectRow,
  HttpClient,
  HttpRequestOptions,
  HttpResponse,
  Logger,
  PaintRow,
  PaintkitRow,
  SchemaItemRow,
  SchemaService,
  WebSocketLike,
} from '../../src/service/contracts';

export const FIXTURES = fileURLToPath(new URL('../fixtures/bptf/', import.meta.url));

export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

export interface WsEvent {
  id: string;
  event: string;
  payload: Record<string, unknown> & { id: string; intent: string; item: Record<string, unknown> & { name: string } };
  _synthetic?: string;
}

export interface WsSample {
  _meta: Record<string, unknown>;
  events: WsEvent[];
  synthetic: WsEvent[];
}

// ---------------------------------------------------------------------------
// Schema stub
// ---------------------------------------------------------------------------

function item(defindex: number, itemName: string, itemClass: string, slot: string | null, name = itemName): SchemaItemRow {
  return { defindex, name, itemName, properName: name.startsWith('The '), itemClass, slot, craftClass: null, usedByClasses: [], imageUrl: null };
}

export const STUB_ITEMS: SchemaItemRow[] = [
  item(5021, 'Mann Co. Supply Crate Key', 'tool', null),
  item(5022, 'Mann Co. Supply Crate', 'supply_crate', null),
  item(5041, 'Mann Co. Supply Crate', 'supply_crate', null),
  item(5831, 'Pyroland Weapons Case', 'supply_crate', null),
  item(154, 'Pain Train', 'tf_weapon_shovel', 'melee', 'The Pain Train'),
  item(378, 'Team Captain', 'tf_wearable', 'head', 'The Team Captain'),
  item(126, "Bill's Hat", 'tf_wearable', 'head'),
  item(205, 'Rocket Launcher', 'tf_weapon_rocketlauncher', 'primary'),
  item(18, 'Rocket Launcher', 'tf_weapon_rocketlauncher', 'primary'),
  item(15000, 'Sniper Rifle', 'tf_weapon_sniperrifle', 'primary'),
  item(6522, 'Strangifier', 'tool', null),
  item(6526, 'Kit', 'tool', null),
  item(20003, 'Fabricator', 'tool', null),
  item(30920, 'Taunt: The Bunnyhopper', 'tf_wearable', 'taunt'),
  item(6011, 'Strange Part: Headshot Kills', 'tool', null),
  item(5633, 'Strange Bacon Grease', 'tf_wearable', 'head'),
];

export const STUB_EFFECTS: EffectRow[] = [
  { id: 13, name: 'Burning Flames', canonicalId: 13, type: 'cosmetic' },
  { id: 38, name: 'Cloudy Moon', canonicalId: 38, type: 'cosmetic' },
  { id: 360, name: 'Searing Stove', canonicalId: 360, type: 'cosmetic' },
  { id: 361, name: 'Searing Stove', canonicalId: 360, type: 'cosmetic' },
  { id: 701, name: 'Hot', canonicalId: 701, type: 'weapon' },
  { id: 3010, name: 'Mega Strike', canonicalId: 3010, type: 'taunt' },
];

export const STUB_PAINTS: PaintRow[] = [
  { decimal: 12073019, hex: '#B8383B', name: 'Team Spirit', bluHex: '#5885A2' },
  { decimal: 5801378, hex: '#5885A2', name: 'Legacy Paint', bluHex: null },
  { decimal: 15308410, hex: '#E9967A', name: 'Dark Salmon Injustice', bluHex: null },
  { decimal: 8208497, hex: '#7D4071', name: 'A Deep Commitment to Purple', bluHex: null },
];

export const STUB_PAINTKITS: PaintkitRow[] = [
  { id: 14, name: 'Night Owl' },
  { id: 114, name: 'Night Owl Mk.II' },
  { id: 415, name: 'Business Class' },
];

function normHex(hex: string): string {
  return hex.trim().replace(/^#/, '').toLowerCase();
}

export function createStubSchema(opts: { throwing?: boolean } = {}): SchemaService {
  const guard = <T>(fn: () => T): T => {
    if (opts.throwing) throw new Error('stub schema failure');
    return fn();
  };
  const byDef = (d: number) => STUB_ITEMS.find((i) => i.defindex === d) ?? null;
  const effectName = (id: number) => STUB_EFFECTS.find((e) => e.id === id)?.name ?? null;
  const nameForSku = (sku: string): string => {
    const o = fromString(sku);
    const it = byDef(o.defindex);
    if (!it) return sku;
    const parts: string[] = [];
    if (!o.craftable) parts.push('Non-Craftable');
    if (o.quality2 === 11) parts.push('Strange');
    if (o.effect) parts.push(effectName(o.effect) ?? `Effect ${o.effect}`);
    else if (o.quality !== 6) parts.push(QUALITY_NAMES[o.quality] ?? `Quality ${o.quality}`);
    if (o.killstreak) parts.push(KILLSTREAK_NAMES[o.killstreak]!);
    if (o.festive) parts.push('Festivized');
    if (o.australium) parts.push('Australium');
    parts.push(it.itemName);
    if (o.wear) parts.push(`(${WEAR_NAMES[o.wear]})`);
    if (o.crateseries) parts.push(`#${o.crateseries}`);
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
    init: async () => undefined,
    refresh: async () => undefined,
    isLoaded: () => true,
    health: () => health,
    itemByDefindex: (d) => guard(() => byDef(d)),
    nameForSku: (sku) => guard(() => nameForSku(sku)),
    baseNameForSku: (sku) => guard(() => byDef(fromString(sku).defindex)?.itemName ?? sku),
    marketHashName: () => null,
    resolve: (): ResolvedItem | null => null,
    search: (): ItemSuggestion[] => [],
    categoryForSku: () => 'other',
    effectName: (id) => guard(() => effectName(id)),
    effectIdByName: (name) =>
      guard(() => {
        const hits = STUB_EFFECTS.filter((e) => e.name.toLowerCase() === name.trim().toLowerCase()).map((e) => e.id);
        return hits.length ? Math.min(...hits) : null;
      }),
    canonicalEffectId: (id) => guard(() => STUB_EFFECTS.find((e) => e.id === id)?.canonicalId ?? id),
    paintByDecimal: (d) => guard(() => STUB_PAINTS.find((p) => p.decimal === d) ?? null),
    paintDecimalByHex: (hex) =>
      guard(() => {
        const h = normHex(hex);
        const red = STUB_PAINTS.find((p) => normHex(p.hex) === h);
        if (red) return red.decimal;
        const blu = STUB_PAINTS.find((p) => p.bluHex !== null && normHex(p.bluHex) === h);
        return blu ? blu.decimal : null;
      }),
    paintkitName: (id) => guard(() => STUB_PAINTKITS.find((p) => p.id === id)?.name ?? null),
    paintkitIdByName: (name) => guard(() => STUB_PAINTKITS.find((p) => p.name.toLowerCase() === name.trim().toLowerCase())?.id ?? null),
    paintkits: () => guard(() => STUB_PAINTKITS),
  };
}

// ---------------------------------------------------------------------------
// Logger, settings, secrets
// ---------------------------------------------------------------------------

export interface RecordingLogger extends Logger {
  lines: { level: string; msg: string; meta?: unknown }[];
  text(): string;
}

export function createLogger(): RecordingLogger {
  const lines: { level: string; msg: string; meta?: unknown }[] = [];
  const rec = (level: string) => (msg: string, meta?: unknown) => {
    lines.push({ level, msg, meta });
  };
  return {
    lines,
    debug: rec('debug'),
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
    text: () => lines.map((l) => `${l.level} ${l.msg} ${l.meta === undefined ? '' : JSON.stringify(l.meta)}`).join('\n'),
  };
}

export function settingsWith(patch: DeepPartial<Settings> = {}): Settings {
  return mergeSettings(DEFAULT_SETTINGS, patch);
}

export function secretsFrom(map: Partial<Record<SecretName, string>>): (name: SecretName) => string | null {
  return (name) => map[name] ?? null;
}

// ---------------------------------------------------------------------------
// Fake HttpClient
// ---------------------------------------------------------------------------

export interface HttpCall {
  url: string;
  opts: HttpRequestOptions;
  /** URL with the query applied, as the real client would send it. */
  fullUrl: string;
}

export type HttpHandler = (call: HttpCall) => Partial<HttpResponse> & { status: number };

export function jsonResponse(status: number, data: unknown): Partial<HttpResponse> & { status: number } {
  return { status, data: data as never };
}

export class FakeHttp implements HttpClient {
  readonly calls: HttpCall[] = [];
  paused = false;
  blocked = new Map<string, string>();
  next = new Map<string, number>();

  constructor(public handler: HttpHandler = () => ({ status: 404, data: null })) {}

  async request<T = unknown>(url: string, opts: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== null && v !== undefined) u.searchParams.append(k, String(v));
    }
    const call: HttpCall = { url, opts, fullUrl: u.href };
    this.calls.push(call);
    if ((opts.method ?? 'GET') !== 'GET') throw new Error('FakeHttp: only GET expected');
    const r = this.handler(call);
    const status = r.status;
    return {
      status,
      ok: status >= 200 && status < 300,
      data: (r.data ?? null) as T | null,
      text: r.text ?? null,
      headers: r.headers ?? {},
      etag: null,
      notModified: false,
      bytes: 0,
      ms: 0,
    };
  }

  setPaused(p: boolean): void {
    this.paused = p;
  }
  isPaused(): boolean {
    return this.paused;
  }
  nextAllowedAt(budget: string): number {
    return this.next.get(budget) ?? 0;
  }
  budgets(): HostBudget[] {
    return [];
  }
  hostBlocked(host: string): string | null {
    return this.blocked.get(host) ?? null;
  }
  unblockHost(host: string): void {
    this.blocked.delete(host);
  }
  userAgent(): string {
    return 'TF2FlipDesk/0.1.0 (+https://example.test/contact)';
  }
}

// ---------------------------------------------------------------------------
// Fake websocket
// ---------------------------------------------------------------------------

// never[] lets any typed listener (open/message/close/...) be registered.
type Listener = (...args: never[]) => void;

export class FakeSocket implements WebSocketLike {
  readyState = 0;
  closed: { code?: number; reason?: string } | null = null;
  terminated = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}

  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) (l as (...a: unknown[]) => void)(...args);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  /** Sends a frame as the ws package would deliver a text message (a Buffer). */
  send(frame: unknown): void {
    const text = typeof frame === 'string' ? frame : JSON.stringify(frame);
    this.emit('message', Buffer.from(text, 'utf8'), false);
  }

  serverClose(code = 1006): void {
    this.readyState = 3;
    this.emit('close', code, Buffer.alloc(0));
  }

  /**
   * The server answers the upgrade with `status` instead of 101, as the default
   * factory reports it: 'handshake-rejected', then (via terminate) 'error' and close 1006.
   */
  reject(status: number, headers: { retryAfter?: string; cfMitigated?: string; contentType?: string } = {}): void {
    this.emit('handshake-rejected', {
      status,
      retryAfter: headers.retryAfter ?? null,
      cfMitigated: headers.cfMitigated ?? '',
      contentType: headers.contentType ?? '',
    });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('error', new Error('WebSocket was closed before the connection was established'));
    this.emit('close', 1006, Buffer.alloc(0));
  }

  /** When set, close() starts the handshake but the server never answers (like a stalled peer). */
  lingerOnClose = false;

  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) return;
    this.closed = { code, reason };
    if (this.lingerOnClose) {
      this.readyState = 2;
      return;
    }
    this.readyState = 3;
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
  }

  terminate(): void {
    if (this.readyState === 3) return;
    this.terminated = true;
    this.readyState = 3;
    this.emit('close', 1006, Buffer.alloc(0));
  }
}
