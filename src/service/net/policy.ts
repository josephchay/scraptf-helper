// Network policy: the single place that decides which URLs the service may
// contact. The denylist is checked before the allowlist, and anything that is
// not explicitly allowed is denied (DESIGN_BRIEF §0 R1/R2, §1.7, §2.0).

import { ForbiddenHostError } from './errors';
import { redactUrl } from './redact';

export type UrlKind = 'http' | 'ws';

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

interface AllowRule {
  host: string;
  label: string;
  /** Protocols accepted for plain HTTP requests (kind 'http'). */
  http: readonly ('https:')[];
  /** Protocols accepted for websocket connections (kind 'ws'). */
  ws: readonly ('wss:' | 'https:')[];
  path(path: string): boolean;
}

const underApi = (p: string): boolean => p.startsWith('/api/');

/** Every endpoint the app may contact. Order is irrelevant; hosts are unique. */
const ALLOW_RULES: readonly AllowRule[] = [
  { host: 'api.backpack.tf', label: 'backpack.tf API', http: ['https:'], ws: [], path: underApi },
  { host: 'backpack.tf', label: 'backpack.tf API', http: ['https:'], ws: [], path: underApi },
  {
    host: 'ws.backpack.tf',
    label: 'backpack.tf websocket',
    http: [],
    ws: ['wss:'],
    path: (p) => p === '/events' || p === '/events/',
  },
  { host: 'pricedb.io', label: 'PriceDB API', http: ['https:'], ws: [], path: underApi },
  {
    host: 'ws.pricedb.io',
    label: 'PriceDB socket',
    // socket.io-client is given an https:// base URL and upgrades to wss://.
    http: ['https:'],
    ws: ['wss:', 'https:'],
    path: (p) => p.startsWith('/socket.io/'),
  },
  { host: 'sku.pricedb.io', label: 'sku.pricedb.io API', http: ['https:'], ws: [], path: underApi },
  { host: 'api.steampowered.com', label: 'Steam Web API', http: ['https:'], ws: [], path: () => true },
  {
    host: 'steamcommunity.com',
    label: 'Steam Community Market priceoverview',
    http: ['https:'],
    ws: [],
    path: (p) => p === '/market/priceoverview/' || p === '/market/priceoverview',
  },
  { host: 'marketplace.tf', label: 'marketplace.tf API', http: ['https:'], ws: [], path: underApi },
  {
    host: 'api.mannco.store',
    label: 'mannco.store API',
    http: ['https:'],
    ws: [],
    // The three documented endpoints (§2.13); nothing that buys, sells or withdraws.
    path: (p) => p === '/user/login' || p === '/item/prices' || p === '/item/pricing/bulk',
  },
  { host: 'api.stntrading.eu', label: 'STN Trading API', http: ['https:'], ws: [], path: () => true },
];

const ALLOW_BY_HOST: ReadonlyMap<string, AllowRule> = new Map(ALLOW_RULES.map((r) => [r.host, r]));

/** The only non-GET requests the app ever makes. */
const POST_ALLOWED: ReadonlySet<string> = new Set([
  'https://pricedb.io/api/items-bulk',
  'https://api.mannco.store/user/login',
]);

/** backpack.tf web hosts whose non-/api/ paths are HTML pages. */
const BPTF_WEB_HOSTS: ReadonlySet<string> = new Set([
  'backpack.tf',
  'www.backpack.tf',
  'next.backpack.tf',
  'forums.backpack.tf',
  'api.backpack.tf',
]);

/** Lower-cases and strips trailing dots, so `API.Backpack.TF.` matches `api.backpack.tf`. */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, '');
}

function isSubdomainOrSelf(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function isScrapTfHost(host: string): boolean {
  return isSubdomainOrSelf(normalizeHost(host), 'scrap.tf');
}

export function isBackpackHost(host: string): boolean {
  return isSubdomainOrSelf(normalizeHost(host), 'backpack.tf');
}

function isIpLiteral(host: string): boolean {
  // WHATWG URL already normalises decimal/hex/octal IPv4 forms to dotted quads.
  return host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function deny(reason: string): PolicyDecision {
  return { allowed: false, reason };
}

/** Percent-decodes a path; null when it is malformed or decodes to control characters. */
function decodePath(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return /[\u0000-\u001f\u007f]/.test(decoded) ? null : decoded;
}

/**
 * Host-level denylist (R1, R2). Returns a reason when the host is never
 * contacted regardless of path, protocol or method.
 */
function denyHost(host: string): string | null {
  if (isSubdomainOrSelf(host, 'scrap.tf')) return 'scrap.tf and its subdomains are never contacted (R1)';
  for (const web of ['stntrading.eu', 'mannco.store']) {
    if (isSubdomainOrSelf(host, web) && host !== `api.${web}`) {
      return `${web} web pages are never fetched; only its API host is allowed (R2)`;
    }
  }
  return null;
}

/** Path-level denylist for hosts that serve both HTML and JSON (R2, §1.7). */
function denyPath(host: string, rawPath: string, decodedLower: string): string | null {
  if (isSubdomainOrSelf(host, 'backpack.tf')) {
    const segments = decodedLower.split('/');
    if (segments.includes('agent')) return 'backpack.tf /agent/ endpoints mark accounts as bots and are never called';
    if (segments.some((s) => s.startsWith('_'))) return 'backpack.tf internal (_-prefixed) APIs are never called';
    if (decodedLower.includes('/classifieds/search')) return 'backpack.tf classifieds search is never called (§2.15)';
    if (segments.includes('get_third_party_prices')) return 'backpack.tf get_third_party_prices is never called (§2.15)';
    if (BPTF_WEB_HOSTS.has(host) && !(rawPath.startsWith('/api/') && decodedLower.startsWith('/api/'))) {
      return 'backpack.tf HTML pages are never fetched; only /api/ is allowed (R2)';
    }
  }
  if (host === 'api.stntrading.eu') {
    // STN's trade calls (RequestKeyTrade, RequestItemTrade, CancelQueueRequest) are POSTs in its spec (RESEARCH §4.5),
    // which the method rule already refuses (POST_ALLOWED); this path rule refuses them on any method, in case STN also
    // answers them on GET.
    if (decodedLower.split('/').some((s) => s.startsWith('request') || s.startsWith('cancel'))) {
      return 'STN trade endpoints (RequestKeyTrade, RequestItemTrade, CancelQueueRequest) are never called (R4, §2.14)';
    }
  }
  if (isSubdomainOrSelf(host, 'marketplace.tf') && !(rawPath.startsWith('/api/') && decodedLower.startsWith('/api/'))) {
    return 'marketplace.tf HTML pages are never fetched; only /api/ is allowed (R2)';
  }
  if (isSubdomainOrSelf(host, 'steamcommunity.com')) {
    if (host !== 'steamcommunity.com' || !(rawPath === '/market/priceoverview/' || rawPath === '/market/priceoverview')) {
      return 'steamcommunity.com is only used for /market/priceoverview/ (R2)';
    }
  }
  return null;
}

/**
 * Decides whether the service may send a request to `url`.
 * kind 'http' requires https:, kind 'ws' requires wss: (or https: for the
 * socket.io handshake host). Only GET is allowed, except two documented POSTs.
 */
export function checkUrl(url: string, kind: UrlKind = 'http', method = 'GET'): PolicyDecision {
  if (typeof url !== 'string' || url.trim() === '') return deny('empty URL');
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return deny('not a valid absolute URL');
  }

  const host = normalizeHost(u.hostname);
  if (!host) return deny(`unsupported URL scheme ${u.protocol}`);

  // Denylist first, before anything that could make a forbidden host look allowed.
  const hostReason = denyHost(host);
  if (hostReason) return deny(hostReason);

  if (u.protocol === 'http:' || u.protocol === 'ws:') return deny(`insecure scheme ${u.protocol} is never used`);
  if (u.protocol !== 'https:' && u.protocol !== 'wss:') return deny(`unsupported URL scheme ${u.protocol}`);
  if (u.username || u.password) return deny('credentials in the URL are not allowed');
  if (u.port !== '') return deny(`non-default port ${u.port} is not allowed`);
  if (isIpLiteral(host)) return deny('IP-literal hosts are not allowed');
  if (host === 'localhost' || host.endsWith('.localhost')) return deny('localhost is not allowed');

  const rawPath = u.pathname;
  const decoded = decodePath(rawPath);
  if (decoded === null) return deny('malformed or control characters in the path');
  if (decoded.includes('\\')) return deny('backslash in the path');
  if (decoded.split('/').some((s) => s === '..' || s === '.')) return deny('dot segments in the path');
  const decodedLower = decoded.toLowerCase();

  const pathReason = denyPath(host, rawPath, decodedLower);
  if (pathReason) return deny(pathReason);

  const rule = ALLOW_BY_HOST.get(host);
  if (!rule) return deny(`${host} is not on the allowlist`);
  const protocols: readonly string[] = kind === 'ws' ? rule.ws : rule.http;
  if (!protocols.includes(u.protocol)) {
    return deny(`${u.protocol}//${host} is not allowed for ${kind === 'ws' ? 'websocket' : 'HTTP'} use`);
  }
  // Allowlist paths are matched on the raw path so encoded variants cannot sneak in.
  if (!rule.path(rawPath) || !rule.path(decoded)) return deny(`path is not allowed on ${host}`);

  const m = String(method || 'GET').toUpperCase();
  if (m !== 'GET') {
    if (m !== 'POST') return deny(`${m} requests are never sent`);
    if (kind !== 'http' || !POST_ALLOWED.has(`${u.protocol}//${host}${rawPath}`)) {
      return deny(`POST is not allowed to ${host}${rawPath}`);
    }
  }

  return { allowed: true, reason: `allowed: ${rule.label}` };
}

/** Throws ForbiddenHostError (with a redacted URL) when checkUrl denies the URL. */
export function assertAllowed(url: string, kind: UrlKind = 'http', method = 'GET'): void {
  const decision = checkUrl(url, kind, method);
  if (!decision.allowed) throw new ForbiddenHostError(redactUrl(String(url ?? '')), decision.reason);
}

/** Hostnames that appear on the allowlist (for the Data health page and tests). */
export function allowedHosts(): string[] {
  return ALLOW_RULES.map((r) => r.host);
}
