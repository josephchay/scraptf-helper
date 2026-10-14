// Secret redaction for URLs, headers and free text (R8). Everything the network
// layer logs or writes to the request log passes through here first.

export const REDACTED = 'REDACTED';

/**
 * Query keys whose values are always redacted (compared case-insensitively).
 * Steam IDs are public and deliberately not on this list.
 */
export const DEFAULT_SECRET_KEYS: readonly string[] = [
  'key',
  'token',
  'apikey',
  'api_key',
  'access_token',
  'auth',
  'auth_token',
  'jwt',
  'password',
  'secret',
  'client_secret',
  'trade_offer_access_token',
  'webapi_key',
];

/** Header names whose values are always redacted (case-insensitive). */
export const DEFAULT_SECRET_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-auth-token',
  'x-access-token',
  'x-api-key',
  'x-webapi-key',
  'api-key',
  'apikey',
];

const SPECIAL_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lowerHex(s: string): string {
  return s.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
}

/**
 * Known secret values (API keys, tokens). Any registered value, and its
 * URL-encoded forms, is replaced with REDACTED by redactText. Values shorter
 * than minLength are ignored so common short strings are never mangled.
 */
export class SecretRegistry {
  private readonly secrets = new Set<string>();
  private pattern: RegExp | null = null;

  constructor(readonly minLength = 8) {}

  register(value: string | null | undefined): void {
    if (typeof value !== 'string' || value.trim().length < this.minLength) return;
    if (this.secrets.has(value)) return;
    this.secrets.add(value);
    this.pattern = null;
  }

  unregister(value: string | null | undefined): void {
    if (typeof value === 'string' && this.secrets.delete(value)) this.pattern = null;
  }

  clear(): void {
    this.secrets.clear();
    this.pattern = null;
  }

  get size(): number {
    return this.secrets.size;
  }

  redactText(text: string): string {
    const s = typeof text === 'string' ? text : String(text ?? '');
    if (this.secrets.size === 0 || s.length === 0) return s;
    return s.replace(this.compile(), REDACTED);
  }

  private compile(): RegExp {
    if (this.pattern) return this.pattern;
    const variants = new Set<string>();
    for (const v of this.secrets) {
      variants.add(v);
      const uri = encodeURIComponent(v);
      const form = new URLSearchParams({ v }).toString().slice(2);
      for (const enc of [uri, form, lowerHex(uri), lowerHex(form)]) variants.add(enc);
    }
    // Longest first so a secret that contains another one is replaced whole.
    const alternation = [...variants]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|');
    this.pattern = new RegExp(alternation, 'g');
    return this.pattern;
  }
}

/** Process-wide registry. The service registers every secret it receives from main. */
export const globalSecrets = new SecretRegistry();

export function registerSecret(value: string | null | undefined): void {
  globalSecrets.register(value);
}

export function unregisterSecret(value: string | null | undefined): void {
  globalSecrets.unregister(value);
}

/** Replaces every registered secret in `text`. */
export function redactText(text: string, registry: SecretRegistry = globalSecrets): string {
  return registry.redactText(text);
}

function keySet(extra: readonly string[] | undefined): Set<string> {
  return new Set([...DEFAULT_SECRET_KEYS, ...(extra ?? [])].map((k) => k.toLowerCase()));
}

function decodeQueryKey(raw: string): string {
  let k = raw.replace(/\+/g, ' ');
  try {
    k = decodeURIComponent(k);
  } catch {
    // keep the raw form
  }
  // `token[]=` and `token[0]=` style keys count as `token`.
  return k.replace(/\[[^\]]*\]$/, '').trim().toLowerCase();
}

/** Redacts values of secret keys in a `?a=b&c=d` string, keeping everything else verbatim. */
function redactSearch(search: string, keys: Set<string>): string {
  if (!search || search === '?') return '';
  const body = search.startsWith('?') ? search.slice(1) : search;
  const parts = body.split('&').map((part) => {
    const eq = part.indexOf('=');
    if (eq < 0) return part;
    const rawKey = part.slice(0, eq);
    return keys.has(decodeQueryKey(rawKey)) ? `${rawKey}=${REDACTED}` : part;
  });
  return `?${parts.join('&')}`;
}

/** Key-based redaction for text that is not a parseable URL (error messages, notes). */
function redactLooseQuery(text: string, keys: Set<string>): string {
  if (keys.size === 0) return text;
  const alternation = [...keys].map(escapeRegExp).join('|');
  const re = new RegExp(`([?&;]\\s*(?:${alternation})(?:\\[[^\\]]*\\])?=)[^&#\\s"'<>]*`, 'gi');
  return text.replace(re, `$1${REDACTED}`);
}

function replaceValues(text: string, values: Iterable<string> | undefined): string {
  if (!values) return text;
  let out = text;
  for (const v of values) {
    if (typeof v !== 'string' || v.length < 4) continue;
    for (const variant of new Set([v, encodeURIComponent(v), new URLSearchParams({ v }).toString().slice(2)])) {
      out = out.split(variant).join(REDACTED);
    }
  }
  return out;
}

export interface RedactOptions {
  /** Registry applied after key-based redaction; defaults to the global one, null skips it. */
  registry?: SecretRegistry | null;
  /** Extra literal secret values to remove (e.g. this request's token). */
  values?: Iterable<string>;
  /** Return only path + query (for the request log). */
  pathOnly?: boolean;
}

/**
 * Returns `url` with the values of secret query keys (DEFAULT_SECRET_KEYS plus
 * `secretKeys`), any userinfo and every registered secret replaced by REDACTED.
 * The fragment is dropped because it is never sent.
 */
export function redactUrl(url: string, secretKeys?: readonly string[], opts: RedactOptions = {}): string {
  const keys = keySet(secretKeys);
  const input = typeof url === 'string' ? url : String(url ?? '');
  let out: string;
  let parsed: URL | null = null;
  try {
    parsed = new URL(input);
  } catch {
    parsed = null;
  }
  if (parsed && SPECIAL_SCHEMES.has(parsed.protocol)) {
    const search = redactSearch(parsed.search, keys);
    if (opts.pathOnly) {
      out = `${parsed.pathname}${search}`;
    } else {
      const userinfo = parsed.username || parsed.password ? `${REDACTED}@` : '';
      out = `${parsed.protocol}//${userinfo}${parsed.host}${parsed.pathname}${search}`;
    }
  } else {
    out = redactLooseQuery(input.replace(/#.*$/s, ''), keys);
    out = out.replace(/(\/\/)[^/@\s]*@/, `$1${REDACTED}@`);
  }
  out = replaceValues(out, opts.values);
  const registry = opts.registry === undefined ? globalSecrets : opts.registry;
  return registry ? registry.redactText(out) : out;
}

/**
 * Scrubs free text such as error messages and log lines: `key=value` pairs for
 * secret keys, extra literal values, and every registered secret.
 */
export function scrubText(text: string, opts: { secretKeys?: readonly string[]; values?: Iterable<string>; registry?: SecretRegistry | null } = {}): string {
  const s = typeof text === 'string' ? text : String(text ?? '');
  let out = redactLooseQuery(s, keySet(opts.secretKeys));
  out = replaceValues(out, opts.values);
  const registry = opts.registry === undefined ? globalSecrets : opts.registry;
  return registry ? registry.redactText(out) : out;
}

type HeaderInput = Record<string, string> | Headers | Iterable<readonly [string, string]>;

function headerEntries(headers: HeaderInput): [string, string][] {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const out: [string, string][] = [];
    headers.forEach((v, k) => out.push([k, v]));
    return out;
  }
  if (typeof (headers as Partial<Iterable<unknown>>)[Symbol.iterator] === 'function') {
    return [...(headers as Iterable<readonly [string, string]>)].map(([k, v]) => [String(k), String(v)]);
  }
  return Object.entries(headers as Record<string, string>).map(([k, v]) => [k, String(v)]);
}

/** Copy of `headers` with secret header values replaced by REDACTED. Names are kept as given. */
export function redactHeaders(
  headers: HeaderInput,
  secretHeaders?: readonly string[],
  registry: SecretRegistry | null = globalSecrets,
): Record<string, string> {
  const secret = new Set([...DEFAULT_SECRET_HEADERS, ...(secretHeaders ?? [])].map((h) => h.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [name, value] of headerEntries(headers)) {
    if (secret.has(name.toLowerCase())) out[name] = REDACTED;
    else out[name] = registry ? registry.redactText(value) : value;
  }
  return out;
}
