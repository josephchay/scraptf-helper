// F18 S2: the web page inside a saved .mhtml file ("Webpage, Single File" in Chromium
// browsers). Pure: no I/O and no parser. The file is untrusted. Only its first text/html part is
// decoded; every other part (images, style sheets, frames) is skipped unread, and no address in the
// file (Content-Location, cid: links, the page's own URLs) is ever opened, resolved or fetched.
// Content-Location is returned as text, a page-address hint for bank detection only (like the
// saved-from comment), and the parser just reads it.
//
// Where it runs: in the service. Main's "Import file" and the folder watch both deliver the file as
// text (decodeHtmlBuffer: UTF-8, as for an .html save), and parseSavedPage (savedPage.ts) tells MHTML
// from HTML by its MIME headers. MHTML is 7-bit text (Chromium writes quoted-printable and base64
// parts), so the text keeps every byte the encoded parts need, and the RPC still carries text.

import { MAX_IMPORT_BYTES } from './scraptfHtml';

/** More parts than this is not a saved page this app reads (spec F18 S2); a scrap.tf bank save has far fewer. */
export const MHTML_MAX_PARTS = 2_000;
/** A header block (the file's or a part's) longer than this is malformed; real ones are a few hundred bytes. */
const MAX_HEADER_CHARS = 16 * 1024;
/** Header values (boundary, charset, Content-Location) are clipped to this before anything reads them. */
const MAX_HEADER_VALUE_CHARS = 4096;

/** Why a file could not be read as MHTML; each is a warning code of the import (savedPage.ts). */
export type MhtmlFailure = 'too-large' | 'mhtml-invalid' | 'mhtml-too-many-parts' | 'mhtml-no-html' | 'mhtml-truncated';

export type MhtmlRead =
  | {
      ok: true;
      html: string;
      /** The HTML part's Content-Location, else the file's Snapshot-Content-Location (Chromium), else null. Never fetched. */
      contentLocation: string | null;
      /** Page warnings ("code: detail"): mhtml-charset. */
      notes: string[];
      /**
       * 0.7.4 (F82): when the page was saved, from the file's own Date header (Chromium writes the save time
       * there), as Unix ms; null without one, or one that is unreadable or before MHTML_DATE_MIN. Only a time:
       * importSavedPage dates the page by it when it is clearly older than the file's modified time.
       */
      date: number | null;
    }
  | { ok: false; reason: MhtmlFailure; detail: string };

export interface MhtmlLimits {
  maxBytes?: number;
  maxParts?: number;
}

/** 0.7.4 (F82): a Date header before this (2015-01-01 UTC) is no save time of a scrap.tf page. */
export const MHTML_DATE_MIN = Date.UTC(2015, 0, 1);

/** The top Date header as Unix ms (RFC 5322 dates, as Date.parse reads them), or null (MhtmlRead.date). */
function headerDate(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 100) return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) && ms >= MHTML_DATE_MIN ? ms : null;
}

/** True for a file name the folder watch and the file picker treat as MHTML (.mhtml, .mht). */
export function isMhtmlFileName(name: string): boolean {
  return /\.mht(?:ml)?$/i.test(name.trim());
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/** An RFC 5322 field name (printable ASCII but the colon), whole. */
const HEADER_NAME = /^[!-9;-~]{1,76}$/;
/** A line break inside a line: such a line is no header (CR, LF, U+2028, U+2029). */
const INNER_BREAK = /[\r\n\u2028\u2029]/;

/**
 * "Name: value" -> the name and the value with its leading blanks dropped; null for anything else.
 * Split with indexOf, not one regex: "X:" + 16 KB of spaces + an inner CR made `[ \t]*(.*)$` retry
 * every split of the spaces (quadratic, about 115 ms a line, 150 s for a 20 MB file of such parts).
 */
function headerLine(line: string): { name: string; value: string } | null {
  const colon = line.indexOf(':');
  if (colon < 1 || colon > 76) return null;
  const name = line.slice(0, colon);
  if (!HEADER_NAME.test(name)) return null;
  const value = line.slice(colon + 1);
  if (INNER_BREAK.test(value)) return null;
  let i = 0;
  while (i < value.length && (value[i] === ' ' || value[i] === '\t')) i++;
  return { name, value: value.slice(i) };
}

interface HeaderBlock {
  /** Lower-cased names; the first of a repeated field wins. */
  headers: Map<string, string>;
  /** Where the body starts (just after the blank line). */
  bodyStart: number;
}

function clipValue(v: string): string {
  return v.length > MAX_HEADER_VALUE_CHARS ? v.slice(0, MAX_HEADER_VALUE_CHARS) : v;
}

/**
 * The header block starting at `start`, up to its blank line. `strict` (the file's own headers): the
 * first line must be a header and every line a header or a folded continuation; a part's block skips
 * lines that are neither. Null when the block has no end before `stop` (a part's: the next delimiter, so
 * no part's scan runs into the parts after it) and within MAX_HEADER_CHARS, or breaks the rules.
 */
function readHeaders(text: string, start: number, strict: boolean, stop = text.length): HeaderBlock | null {
  const headers = new Map<string, string>();
  const limit = Math.min(text.length, stop, start + MAX_HEADER_CHARS);
  let pos = start;
  /** The field a folded line continues; '' while skipping a repeated field's folds; null before any field. */
  let last: string | null = null;
  while (pos < limit) {
    const nl = text.indexOf('\n', pos);
    // A header block that never ends (no blank line in reach) is not one.
    if (nl < 0 || nl >= limit) return null;
    const line = text.charCodeAt(nl - 1) === 13 && nl - 1 >= pos ? text.slice(pos, nl - 1) : text.slice(pos, nl);
    pos = nl + 1;
    if (line === '') return headers.size > 0 || !strict ? { headers, bodyStart: pos } : null;
    if (line[0] === ' ' || line[0] === '\t') {
      // A folded line continues the field above it.
      if (last === null) {
        if (strict) return null;
        continue;
      }
      // A value already clipped stays as it is: each further fold would build a 4 KB string to drop.
      const prev = last === '' ? undefined : (headers.get(last) ?? '');
      if (prev !== undefined && prev.length < MAX_HEADER_VALUE_CHARS) headers.set(last, clipValue(`${prev} ${line.trim()}`));
      continue;
    }
    const m = headerLine(line);
    if (!m) {
      if (strict) return null;
      last = null;
      continue;
    }
    const name = m.name.toLowerCase();
    if (headers.has(name)) {
      last = ''; // a later copy is ignored, its folded lines included
      continue;
    }
    headers.set(name, clipValue(m.value.trim()));
    last = name;
  }
  return null;
}

interface ContentType {
  /** Lower-cased "type/subtype". */
  type: string;
  /** Lower-cased parameter names. */
  params: Map<string, string>;
}

/** "multipart/related; type=\"text/html\"; boundary=\"----X\"" -> type and parameters (quoted values unquoted). */
function parseContentType(value: string | undefined): ContentType | null {
  if (value === undefined) return null;
  const v = value.trim();
  const semi = v.indexOf(';');
  const type = (semi < 0 ? v : v.slice(0, semi)).trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) return null;
  const params = new Map<string, string>();
  let i = semi < 0 ? v.length : semi + 1;
  while (i < v.length) {
    while (i < v.length && (v[i] === ' ' || v[i] === '\t' || v[i] === ';')) i++;
    const eq = v.indexOf('=', i);
    if (eq < 0) break;
    const name = v.slice(i, eq).trim().toLowerCase();
    i = eq + 1;
    let val = '';
    if (v[i] === '"') {
      i++;
      while (i < v.length && v[i] !== '"') {
        if (v[i] === '\\' && i + 1 < v.length) i++;
        val += v[i];
        i++;
      }
      i++; // the closing quote
    } else {
      const end = v.indexOf(';', i);
      val = (end < 0 ? v.slice(i) : v.slice(i, end)).trim();
      i = end < 0 ? v.length : end;
    }
    if (name && !params.has(name)) params.set(name, val);
  }
  return { type, params };
}

/** RFC 2046: 1 to 70 characters of a fixed set, not ending in a space. */
function validBoundary(b: string | undefined): b is string {
  return typeof b === 'string' && /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/.test(b);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * True when the text starts with MIME headers naming a MIME message (MIME-Version, or a multipart or
 * text/html Content-Type): a saved .mhtml/.mht file, whatever its name. A web page starts with "<".
 */
export function looksLikeMhtml(text: string): boolean {
  const t = withoutBom(text);
  if (t === '' || t[0] === '<' || headerLine(t.slice(0, Math.min(t.length, 200)).split(/\r?\n/, 1)[0] ?? '') === null) return false;
  const block = readHeaders(t, 0, true);
  if (!block) return false;
  if (block.headers.has('mime-version')) return true;
  const ct = parseContentType(block.headers.get('content-type'));
  return ct !== null && (ct.type.startsWith('multipart/') || ct.type === 'text/html');
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

/**
 * RFC 2045 quoted-printable: "=XX" escapes (either case), soft line breaks ("=" ending a line, spaces
 * after it allowed) removed, trailing spaces before a hard line break dropped. A stray "=" stays as is,
 * as browsers read it. Never longer than its input.
 */
export function decodeQuotedPrintable(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length);
  let o = 0;
  /** Start in `out` of a run of literal spaces or tabs, else -1: dropped if a hard line break follows. */
  let wsFrom = -1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === 0x20 || c === 0x09) {
      if (wsFrom < 0) wsFrom = o;
      out[o++] = c;
      continue;
    }
    if (c === 0x0d || c === 0x0a) {
      if (wsFrom >= 0) o = wsFrom;
      wsFrom = -1;
      out[o++] = c;
      continue;
    }
    wsFrom = -1;
    if (c !== 0x3d) {
      out[o++] = c;
      continue;
    }
    // "=" then optional spaces and a line break (or the end): a soft line break.
    let j = i + 1;
    while (j < src.length && (src[j] === 0x20 || src[j] === 0x09)) j++;
    if (j >= src.length) {
      i = j - 1;
      continue;
    }
    if (src[j] === 0x0a) {
      i = j;
      continue;
    }
    if (src[j] === 0x0d && src[j + 1] === 0x0a) {
      i = j + 1;
      continue;
    }
    const hi = i + 2 < src.length ? hexValue(src[i + 1]!) : -1;
    const lo = hi >= 0 ? hexValue(src[i + 2]!) : -1;
    if (hi >= 0 && lo >= 0) {
      out[o++] = hi * 16 + lo;
      i += 2;
      continue;
    }
    out[o++] = c;
  }
  return out.subarray(0, o);
}

/** Base64 with line breaks; null when anything but the alphabet, padding and white space is in it. */
function decodeBase64(body: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/=\s]*$/.test(body)) return null;
  return Buffer.from(body.replace(/\s+/g, ''), 'base64');
}

/** The part's bytes as the file held them: one byte per char for binary input, else UTF-8 (decodeHtmlBuffer's reading). */
function rawBytes(body: string, binary: boolean): Uint8Array {
  return Buffer.from(body, binary ? 'latin1' : 'utf8');
}

/** Bytes in the part's charset (UTF-8 by default); an unknown label reads as UTF-8 with a note. */
function decodeCharset(bytes: Uint8Array, charset: string | undefined, notes: string[]): string {
  const label = (charset ?? '').trim().slice(0, 40) || 'utf-8';
  let text: string;
  try {
    text = new TextDecoder(label, { ignoreBOM: false }).decode(bytes);
  } catch {
    notes.push(`mhtml-charset: unknown charset "${label.replace(/[^\x20-\x7e]/g, '?')}"; read as UTF-8`);
    text = new TextDecoder('utf-8').decode(bytes);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

interface Delimiter {
  /** Index of the "--boundary" line. */
  start: number;
  /** Index just past that line. */
  lineEnd: number;
  /** "--boundary--": the last one. */
  close: boolean;
}

/**
 * The next "--boundary" (or "--boundary--") line at or after `from`. A delimiter starts a line, so a
 * match anywhere else (or a longer "--boundaryX" line) resumes the search on the next line: one pass
 * over the text, even when a hostile file repeats the boundary's characters (a boundary of dashes
 * over megabytes of dashes) and a restart one character on would rescan every line.
 */
function nextDelimiter(text: string, delim: string, from: number): Delimiter | null {
  let i = from;
  for (;;) {
    const j = text.indexOf(delim, i);
    if (j < 0) return null;
    if (j === 0 || text.charCodeAt(j - 1) === 10) {
      let k = j + delim.length;
      let close = false;
      if (text.startsWith('--', k)) {
        close = true;
        k += 2;
      }
      while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
      if (k === text.length) return { start: j, lineEnd: k, close };
      if (text[k] === '\n') return { start: j, lineEnd: k + 1, close };
      if (text[k] === '\r' && text[k + 1] === '\n') return { start: j, lineEnd: k + 2, close };
    }
    const nl = text.indexOf('\n', j);
    if (nl < 0) return null;
    i = nl + 1;
  }
}

/** Where a part's body ends: before the line break that belongs to the next delimiter. */
function bodyEndBefore(text: string, delimStart: number, floor: number): number {
  let e = delimStart;
  if (e > floor && text.charCodeAt(e - 1) === 10) e--;
  if (e > floor && text.charCodeAt(e - 1) === 13) e--;
  return e;
}

interface HtmlPart {
  headers: Map<string, string>;
  type: ContentType;
  body: string;
  /** The part ran to the end of the file: no delimiter after it. */
  unterminated: boolean;
}

function utf8Length(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function overLimit(input: Uint8Array | string, max: number): number | null {
  if (typeof input !== 'string') return input.byteLength > max ? input.byteLength : null;
  if (input.length > max) return utf8Length(input);
  if (input.length * 3 > max) {
    const n = utf8Length(input);
    return n > max ? n : null;
  }
  return null;
}

function fail(reason: MhtmlFailure, detail: string): MhtmlRead {
  return { ok: false, reason, detail };
}

/** The decoded page ends with its closing </html> tag (blanks after it allowed); only its tail is looked at. */
function endsWholePage(html: string): boolean {
  return /<\/html\s*>\s*$/i.test(html.slice(-256));
}

/**
 * Reads the web page out of a saved MHTML file: the first text/html part, decoded by its
 * Content-Transfer-Encoding (quoted-printable, base64, or 7bit/8bit/binary as is) and charset
 * (UTF-8 by default). Rejects a file over the import size limit, with more than MHTML_MAX_PARTS
 * parts, without MIME headers or a boundary, without a text/html part, or ending inside that part
 * (no delimiter after it and no closing </html>). Other parts are counted, never decoded. A
 * single-part file whose own type is text/html is read the same way.
 */
export function readMhtml(input: Uint8Array | string, limits: MhtmlLimits = {}): MhtmlRead {
  const maxBytes = limits.maxBytes ?? MAX_IMPORT_BYTES;
  const maxParts = limits.maxParts ?? MHTML_MAX_PARTS;
  const big = overLimit(input, maxBytes);
  if (big !== null) return fail('too-large', `${Math.ceil(big / 1024 / 1024)} MB is over the ${Math.round(maxBytes / 1024 / 1024)} MB import limit`);

  const binary = typeof input !== 'string';
  let text: string;
  if (typeof input === 'string') text = withoutBom(input);
  else {
    // latin1: one char per byte, so a decoded part gets its exact bytes back (rawBytes).
    const start = input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf ? 3 : 0;
    text = Buffer.from(input.buffer, input.byteOffset + start, input.byteLength - start).toString('latin1');
  }
  if (!looksLikeMhtml(text)) return fail('mhtml-invalid', 'the file does not start with MIME headers');
  const top = readHeaders(text, 0, true)!;
  const ct = parseContentType(top.headers.get('content-type'));
  const snapshot = top.headers.get('snapshot-content-location') ?? null;
  const date = headerDate(top.headers.get('date'));

  let part: HtmlPart | null = null;
  if (ct !== null && ct.type === 'text/html') {
    part = { headers: top.headers, type: ct, body: text.slice(top.bodyStart), unterminated: false };
  } else {
    if (ct === null || !ct.type.startsWith('multipart/')) return fail('mhtml-invalid', 'the file is not a multipart MIME message');
    const boundary = ct.params.get('boundary');
    if (!validBoundary(boundary)) return fail('mhtml-invalid', 'the file names no valid MIME boundary');
    const delim = `--${boundary}`;
    let d = nextDelimiter(text, delim, top.bodyStart);
    if (d === null) return fail('mhtml-invalid', 'the file has no MIME parts');
    let parts = 0;
    // Every part is counted (a cheap scan for the next delimiter); only the first text/html part is read.
    while (d !== null && !d.close) {
      parts++;
      if (parts > maxParts) return fail('mhtml-too-many-parts', `the file has more than ${maxParts.toLocaleString('en-US')} parts`);
      const next = nextDelimiter(text, delim, d.lineEnd);
      if (part === null) {
        const end = next === null ? text.length : bodyEndBefore(text, next.start, d.lineEnd);
        const block = readHeaders(text, d.lineEnd, false, next === null ? text.length : next.start);
        if (block !== null) {
          const type = parseContentType(block.headers.get('content-type'));
          if (type !== null && type.type === 'text/html') {
            // An empty body (its blank line is the delimiter's line break) is still the page: a frame's
            // document after it must never be read in its place.
            const body = block.bodyStart < end ? text.slice(block.bodyStart, end) : '';
            part = { headers: block.headers, type, body, unterminated: next === null };
          }
        }
      }
      d = next;
    }
  }
  if (part === null) return fail('mhtml-no-html', 'the file holds no web page (no text/html part)');

  const notes: string[] = [];
  const cte = (part.headers.get('content-transfer-encoding') ?? '7bit').trim().toLowerCase();
  let html: string;
  if (cte === 'quoted-printable') {
    html = decodeCharset(decodeQuotedPrintable(rawBytes(part.body, binary)), part.type.params.get('charset'), notes);
  } else if (cte === 'base64') {
    const bytes = decodeBase64(part.body);
    if (bytes === null) return fail('mhtml-invalid', 'the web page part is not valid base64');
    html = decodeCharset(bytes, part.type.params.get('charset'), notes);
  } else if (cte === '7bit' || cte === '8bit' || cte === 'binary' || cte === '') {
    // Text input is already decoded (UTF-8); only bytes still need the part's charset. An 8-bit part in
    // another charset (Chromium never writes one) lost its non-UTF-8 bytes in that decoding: they read as U+FFFD.
    html = binary ? decodeCharset(rawBytes(part.body, true), part.type.params.get('charset'), notes) : part.body;
  } else {
    return fail('mhtml-invalid', `the web page part uses an unsupported encoding (${cte.replace(/[^\x20-\x7e]/g, '?').slice(0, 30)})`);
  }
  // Cut short (a copy cut off, a read mid-write): a partial look at a bank would read every card after
  // the cut as gone, then as new on the next save. A page that ends in </html> lost only the delimiter.
  if (part.unterminated && !endsWholePage(html)) return fail('mhtml-truncated', 'the file ends inside its web page, so the page is incomplete');
  const location = (part.headers.get('content-location') ?? snapshot ?? '').trim();
  return { ok: true, html: withoutBom(html), contentLocation: location === '' ? null : location, notes, date };
}

/** The spec's entry point: the page and its address hint, or null for anything readMhtml rejects. */
export function extractMhtmlHtml(input: Uint8Array | string): { html: string; contentLocation: string | null } | null {
  const r = readMhtml(input);
  return r.ok ? { html: r.html, contentLocation: r.contentLocation } : null;
}
