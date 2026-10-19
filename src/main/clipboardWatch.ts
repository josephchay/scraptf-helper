// Live check (F16) in main: the privacy filter every piece of clipboard text passes before it
// leaves main, and the opt-in clipboard watcher. Main only; nothing here touches the network.
//
// Privacy rules (spec "Privacy rules", tested in test/main/clipboardWatch.test.ts):
// - The caller reads plain text only (clipboard.readText()); HTML, RTF and other formats are never
//   read, so markup the browser put on the clipboard never reaches the app.
// - Clipboard text is never logged, persisted or sent anywhere. Text that passes the filter goes
//   in memory to the local service's 'check.text', and nowhere else.
// - Refused before that: more than CHECK_MAX_CHARS characters, more than CHECK_MAX_LINES lines,
//   markup ("<"), no letter or digit, and anything that looks like a secret, a long link other than an
//   item link included (shouldCheckClipboardText).
// - "Same text as last time" compares a keyed hash, never a stored copy of the text.
// - While paused (system locked or suspended, network paused) the watcher reads nothing.

import { createHmac, randomBytes } from 'node:crypto';
import { CHECK_MAX_CHARS, CHECK_REFUSALS, CHECK_WATCH_INTERVAL_MS, checkLineCount, CHECK_MAX_LINES } from '../shared/check';
import { itemUrlHost, itemUrlParts, NEXT_STATS_PARAMS } from '../shared/itemUrl';
import { isValidSku } from '../shared/sku';

export type ClipboardSkipReason = 'same' | 'empty' | 'too-long' | 'markup' | 'too-many-lines' | 'no-text' | 'secret' | 'link';

export interface ClipboardFilterResult {
  /** True when the text may be sent to 'check.text'. */
  ok: boolean;
  /** Keyed hash of the text: the watcher's next `lastHash`. Never the text, and useless outside this process. */
  hash: string;
  reason: ClipboardSkipReason | null;
}

// Per process, so a hash cannot be matched against hashes of guessed texts anywhere else.
const HASH_KEY = randomBytes(32);
/** Past this length only the length, head and tail are hashed: the text is refused anyway, and a huge copy stays cheap. */
const HASH_FULL_MAX = 16 * 1024;

/** The keyed hash the filter compares (exported for the watcher's first read and for tests). */
export function clipboardTextHash(text: string): string {
  const t = String(text ?? '');
  const material = t.length <= HASH_FULL_MAX ? t : `${t.length}\u0000${t.slice(0, 2048)}\u0000${t.slice(-2048)}`;
  return createHmac('sha256', HASH_KEY).update(material, 'utf8').digest('hex');
}

/** A token this long or longer that mixes character kinds reads as a key, token or password. */
export const SECRET_TOKEN_MIN = 20;
// 32-hex is a Steam Web API key, 24-hex a backpack.tf API key or access token; bounded by non-alphanumerics.
const HEX_KEY = /(?<![0-9a-z])(?:[0-9a-f]{32}|[0-9a-f]{24})(?![0-9a-z])/i;
// Any scheme with a user (and maybe a password) before the host: "https://user:pass@host".
const URL_WITH_CREDENTIALS = /[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]*@/i;
// A link that carries a credential in its query or fragment (an API call, a trade offer token, an OAuth
// callback, a signed download). Any name containing one of these words, so client_secret, refresh_token,
// X-Amz-Signature and code count too; none of the item-link query keys (NEXT_STATS_PARAMS) does.
const URL_SECRET_PARAM = /[?&#;][\w.-]*(?:key|token|secret|pass|pwd|auth|sig|credential|session|code)[\w.-]*=[^&\s#]/i;
// 13 to 19 digits, optionally grouped by single spaces or dashes: checked with Luhn as a card number.
const DIGIT_RUN = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;

function luhnOk(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Letters, digits and other characters: how many of the three kinds `token` mixes. */
function classCount(token: string): number {
  const letters = /\p{L}/u.test(token) ? 1 : 0;
  const digits = /\p{N}/u.test(token) ? 1 : 0;
  const symbols = /[^\p{L}\p{N}]/u.test(token) ? 1 : 0;
  return letters + digits + symbols;
}

/** The long-token rule for one space-free token: SECRET_TOKEN_MIN or more characters mixing two kinds, not a valid SKU. */
function secretToken(token: string): boolean {
  return token.length >= SECRET_TOKEN_MIN && !isValidSku(token.toLowerCase()) && classCount(token) >= 2;
}

function decodePiece(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/** Bulk paste separators a link may end in when a price follows it ("<link>, 1.33 ref"). */
const TRAILING_SEPARATORS = /[,;=@]+$/;

/**
 * A link that may skip the long-token rule: an item link the live check reads (the hosts and path
 * shapes of shared/itemUrl.ts, which parseItemUrl uses), with no query key but the item ones, or a
 * scrap.tf link without a query (the service answers it as a scrap.tf link and never opens it). No
 * login, no fragment, and no secret-shaped piece in its decoded path or query values: wrapping a
 * token in a link must not get it through. Every other link is a long mixed token like any other.
 */
function isCheckableLink(token: string): boolean {
  if (!/^https?:\/\//i.test(token) || token.includes('#')) return false;
  let u: URL;
  try {
    u = new URL(token.replace(TRAILING_SEPARATORS, ''));
  } catch {
    return false;
  }
  if (u.username !== '' || u.password !== '') return false;
  const host = itemUrlHost(u);
  const scraptf = host === 'scrap.tf' || host.endsWith('.scrap.tf');
  if (scraptf ? u.search !== '' : itemUrlParts(u) === null) return false;
  const keys = [...u.searchParams.keys()];
  if (!keys.every((k) => NEXT_STATS_PARAMS.includes(k))) return false;
  const pieces = [...u.pathname.split('/'), ...u.searchParams.values()].map(decodePiece);
  return !pieces.some((p) => p.split(/\s+/).some(secretToken));
}

/** Why looksLikeSecret refused: a secret shape, or a long link that is not one the live check reads. */
function secretKind(t: string): 'secret' | 'link' | null {
  if (HEX_KEY.test(t) || URL_WITH_CREDENTIALS.test(t) || URL_SECRET_PARAM.test(t)) return 'secret';
  for (const m of t.matchAll(DIGIT_RUN)) {
    if (luhnOk(m[0].replace(/[ -]/g, ''))) return 'secret';
  }
  for (const token of t.split(/\s+/)) {
    if (secretToken(token) && !isCheckableLink(token)) return /^https?:\/\//i.test(token) ? 'link' : 'secret';
  }
  return null;
}

/**
 * True when `text` looks like a secret: a token of SECRET_TOKEN_MIN or more characters with no spaces
 * that mixes at least two of letters, digits and symbols (a valid SKU, an item link and a scrap.tf
 * link are fine: isCheckableLink; any other link is such a token), a 32-hex or 24-hex key shape
 * anywhere, a URL with credentials or a credential parameter, or a card-like number (13 to 19 digits
 * passing Luhn). Errs toward refusing: an item name has none of these.
 */
export function looksLikeSecret(text: string): boolean {
  return secretKind(String(text ?? '')) !== null;
}

/**
 * The privacy filter (pure). `lastHash` is the watcher's previous hash, or null for a hotkey press
 * (read once, never "the same"). Order: same, empty, too long, markup, a list, no letter or digit,
 * a secret (or a long link that is not an item link: 'link'). Only an `ok` text may be passed to
 * 'check.text'; nothing about it is kept but `hash`.
 */
export function shouldCheckClipboardText(text: string, lastHash: string | null): ClipboardFilterResult {
  const t = typeof text === 'string' ? text : '';
  const hash = clipboardTextHash(t);
  const no = (reason: ClipboardSkipReason): ClipboardFilterResult => ({ ok: false, hash, reason });
  if (lastHash !== null && hash === lastHash) return no('same');
  if (t.trim() === '') return no('empty');
  if (t.length > CHECK_MAX_CHARS) return no('too-long');
  if (t.includes('<')) return no('markup');
  if (checkLineCount(t) > CHECK_MAX_LINES) return no('too-many-lines');
  if (!/[\p{L}\p{N}]/u.test(t)) return no('no-text');
  const secret = secretKind(t);
  if (secret !== null) return no(secret);
  return { ok: true, hash, reason: null };
}

/** The popup's reason for a hotkey press the filter refused (the text itself never reaches the service). */
export function clipboardSkipMessage(reason: ClipboardSkipReason): string {
  switch (reason) {
    case 'empty':
    case 'same':
      return CHECK_REFUSALS.empty;
    case 'too-long':
      return CHECK_REFUSALS.tooLong;
    case 'markup':
      return CHECK_REFUSALS.markup;
    case 'too-many-lines':
      return CHECK_REFUSALS.list;
    case 'no-text':
      return 'That is not an item name.';
    case 'secret':
      return CHECK_REFUSALS.secret;
    case 'link':
      return CHECK_REFUSALS.link;
  }
}

// ---------------------------------------------------------------------------
// The opt-in watcher
// ---------------------------------------------------------------------------

export interface ClipboardWatchTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ClipboardWatchOptions {
  /**
   * clipboard.readText(): plain text only. Never pass a reader of HTML, RTF or any other format.
   * Electron 44's is async; a sync reader (tests) is handled the same way.
   */
  readText(): string | Promise<string>;
  /** A new text that passed shouldCheckClipboardText; called from the poll and not awaited. */
  onText(text: string): void;
  /**
   * F19: a priming read (the first after start() or a pause) recorded this keyed hash as already there,
   * so onText never sees that text. Only the hash, never the text.
   */
  onPrimed?(hash: string): void;
  /** System locked or suspended, or network paused: nothing is read while true. */
  isPaused(): boolean;
  /** Default CHECK_WATCH_INTERVAL_MS (700). */
  intervalMs?: number;
  timers?: ClipboardWatchTimers;
  /** A read or onText threw; never given the text. */
  onError?(what: 'read' | 'check', err: unknown): void;
}

export interface ClipboardWatch {
  start(): void;
  stop(): void;
  running(): boolean;
  /**
   * The hotkey just checked `text`: the next poll treats it as already seen, so the same copy does
   * not pop up a second time. Keeps only its keyed hash.
   */
  markChecked(text: string): void;
  /**
   * F19: the text the watcher saw last (or the hotkey marked) has this keyed hash, so copying that
   * text again changes nothing it can see. False while stopped or before the priming read.
   */
  isLastSeen(hash: string): boolean;
}

const realTimers: ClipboardWatchTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/** Ticks an async read may stay unsettled (about 7 s at 700 ms) before it is abandoned and the clipboard read again. */
export const CLIPBOARD_READ_STALL_TICKS = 10;

/**
 * Polls the clipboard's plain text while started. The first read after start() or after a pause
 * only records the hash: the watcher reacts to text copied while it watches, never to what was
 * already on the clipboard. src/main/liveCheck.ts owns the rest (one check in flight, rate limit,
 * popup, notifications) and starts and stops it with settings.check.watchClipboard.
 */
export function createClipboardWatch(opts: ClipboardWatchOptions): ClipboardWatch {
  const timers = opts.timers ?? realTimers;
  const intervalMs = Math.max(100, Math.floor(opts.intervalMs ?? CHECK_WATCH_INTERVAL_MS));
  let handle: unknown = null;
  let lastHash: string | null = null;
  let primed = false;
  /** The async read in flight (its number): the next tick skips instead of stacking reads. */
  let reading: number | null = null;
  let readSeq = 0;
  /** Ticks skipped behind the read in flight. */
  let stalledTicks = 0;
  /** Bumped by start, stop, every paused tick and an abandoned read, so a read that resolves after them is dropped. */
  let generation = 0;

  function take(text: unknown): void {
    if (typeof text !== 'string') return;
    if (!primed) {
      const hash = clipboardTextHash(text);
      lastHash = hash;
      primed = true;
      try {
        opts.onPrimed?.(hash);
      } catch (err) {
        opts.onError?.('check', err);
      }
      return;
    }
    const r = shouldCheckClipboardText(text, lastHash);
    lastHash = r.hash;
    if (!r.ok) return;
    try {
      opts.onText(text);
    } catch (err) {
      opts.onError?.('check', err);
    }
  }

  function poll(): void {
    if (opts.isPaused()) {
      // Text copied while paused is not "new" once the pause ends.
      primed = false;
      generation++;
      return;
    }
    if (reading !== null) {
      // A read that never settles must not end the watching for good: give up on it and read again.
      if (++stalledTicks < CLIPBOARD_READ_STALL_TICKS) return;
      generation++;
      reading = null;
    }
    stalledTicks = 0;
    let value: string | Promise<string>;
    try {
      value = opts.readText();
    } catch (err) {
      opts.onError?.('read', err);
      return;
    }
    if (typeof value === 'string') {
      take(value);
      return;
    }
    if (!value || typeof (value as Promise<string>).then !== 'function') return;
    const id = ++readSeq;
    reading = id;
    const gen = generation;
    // Only this read frees the slot: an abandoned or earlier-run read settling late must not.
    const settled = () => {
      if (reading === id) reading = null;
    };
    value.then(
      (text) => {
        settled();
        if (gen === generation && handle !== null) take(text);
      },
      (err: unknown) => {
        settled();
        if (gen === generation && handle !== null) opts.onError?.('read', err);
      },
    );
  }

  return {
    start() {
      if (handle !== null) return;
      lastHash = null;
      primed = false;
      // A read left from an earlier run is dropped by its generation; it must not hold this run up.
      reading = null;
      stalledTicks = 0;
      generation++;
      handle = timers.setInterval(poll, intervalMs);
      poll();
    },
    stop() {
      if (handle === null) return;
      timers.clearInterval(handle);
      handle = null;
      lastHash = null;
      primed = false;
      generation++;
    },
    running: () => handle !== null,
    markChecked(text) {
      // Before the priming read there is nothing to compare with; that read records it anyway.
      if (handle === null || !primed || typeof text !== 'string') return;
      lastHash = clipboardTextHash(text);
    },
    isLastSeen: (hash) => handle !== null && primed && lastHash === hash,
  };
}

// ---------------------------------------------------------------------------
// System pause (powerMonitor)
// ---------------------------------------------------------------------------

export type PowerEvent = 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume';

/** The part of Electron's powerMonitor used here (usable only after app 'ready'). */
export interface PowerMonitorLike {
  on(event: PowerEvent, listener: () => void): unknown;
  removeListener(event: PowerEvent, listener: () => void): unknown;
  getSystemIdleState(idleThreshold: number): string;
}

export interface SystemPause {
  /** True while the session is locked or the machine is suspended: the watcher reads nothing. */
  paused(): boolean;
  dispose(): void;
}

/**
 * Tracks lock and suspend from powerMonitor events. Seeded from getSystemIdleState, so a
 * watcher turned on while the screen is already locked starts paused.
 */
export function createSystemPause(pm: PowerMonitorLike): SystemPause {
  let locked = false;
  let suspended = false;
  try {
    // Electron throws for a threshold below 1 s; 'locked' is reported whatever the threshold.
    locked = pm.getSystemIdleState(1) === 'locked';
  } catch {
    // Unknown state: the lock events still arrive.
  }
  const handlers: [PowerEvent, () => void][] = [
    ['lock-screen', () => (locked = true)],
    ['unlock-screen', () => (locked = false)],
    ['suspend', () => (suspended = true)],
    ['resume', () => (suspended = false)],
  ];
  for (const [event, fn] of handlers) pm.on(event, fn);
  return {
    paused: () => locked || suspended,
    dispose() {
      for (const [event, fn] of handlers) pm.removeListener(event, fn);
    },
  };
}
