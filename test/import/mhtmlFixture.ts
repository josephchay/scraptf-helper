// Builds synthetic .mhtml files ("Webpage, Single File") for the F18 import tests, the way
// Chromium writes them: a MIME multipart/related message with CRLF line breaks, the page first as a
// quoted-printable text/html part (76-character lines, "=" soft breaks, "=3D" escapes), then its
// resources (base64 images, a quoted-printable style sheet, a frame's own text/html part). Built
// from the saved-page fixtures at test time, so the HTML and the MHTML can never drift apart.
// The addresses inside are only text; nothing here or in the tests is fetched (R1).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)), 'utf8');

/** Chromium's boundary shape. */
export const BOUNDARY = '----MultipartBoundary--F18fixtureBoundary0123456789abcdef----';

const CRLF = '\r\n';
const MAX_LINE = 76;

function hex(b: number): string {
  return `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * RFC 2045 quoted-printable of `text`'s bytes in `charset` (UTF-8 or latin1): printable ASCII as is but
 * "=", every other byte escaped, spaces and tabs escaped before a line break, the text's own line
 * breaks as CRLF, and lines wrapped at 76 characters with "=" soft breaks (never inside an escape).
 */
export function encodeQuotedPrintable(text: string, charset: 'utf-8' | 'latin1' = 'utf-8'): string {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const bytes = Buffer.from(line, charset === 'utf-8' ? 'utf8' : 'latin1');
    const tokens: string[] = [];
    bytes.forEach((b, i) => {
      const last = i === bytes.length - 1;
      if ((b === 0x20 || b === 0x09) && last) tokens.push(hex(b));
      else if ((b >= 33 && b <= 126 && b !== 0x3d) || b === 0x20 || b === 0x09) tokens.push(String.fromCharCode(b));
      else tokens.push(hex(b));
    });
    let cur = '';
    const wrapped: string[] = [];
    for (const t of tokens) {
      // Room for the soft break's "=".
      if (cur.length + t.length > MAX_LINE - 1) {
        wrapped.push(`${cur}=`);
        cur = '';
      }
      cur += t;
    }
    wrapped.push(cur);
    out.push(wrapped.join(CRLF));
  }
  return out.join(CRLF);
}

/** Base64 in 76-character lines. */
export function encodeBase64(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += MAX_LINE) lines.push(b64.slice(i, i + MAX_LINE));
  return lines.join(CRLF);
}

export interface MhtmlPartSpec {
  /** The Content-Type value as written ("text/html", "image/png", "text/html; charset=windows-1252"). */
  type: string;
  /** The Content-Transfer-Encoding header (omitted: none). */
  encoding?: string;
  /** The part's body exactly as it appears in the file (already encoded). */
  body: string;
  location?: string;
  id?: string;
}

export interface MhtmlSpec {
  parts: MhtmlPartSpec[];
  boundary?: string;
  /** Chromium's file-level address (Snapshot-Content-Location). */
  snapshot?: string | null;
  subject?: string;
  /** Overrides the file's Content-Type line (malformed-input tests). */
  contentType?: string;
  /** Leaves out the closing "--boundary--" (a truncated file). */
  unterminated?: boolean;
  /** Line break between lines of the MIME structure (CRLF, as Chromium writes). */
  eol?: string;
}

export function buildMhtml(spec: MhtmlSpec): string {
  const eol = spec.eol ?? CRLF;
  const boundary = spec.boundary ?? BOUNDARY;
  const head = [
    'From: <Saved by Blink>',
    ...(spec.snapshot === null ? [] : [`Snapshot-Content-Location: ${spec.snapshot ?? 'https://scrap.tf/buy/hats'}`]),
    `Subject: ${spec.subject ?? 'Hat Trading - TF2 - Scrap.TF'}`,
    'Date: Fri, 16 Oct 2026 12:00:00 -0000',
    'MIME-Version: 1.0',
    spec.contentType ?? `Content-Type: multipart/related;${eol}\ttype="text/html";${eol}\tboundary="${boundary}"`,
  ];
  let out = `${head.join(eol)}${eol}${eol}${eol}`;
  for (const p of spec.parts) {
    const headers = [
      `Content-Type: ${p.type}`,
      ...(p.id ? [`Content-ID: <${p.id}>`] : []),
      ...(p.encoding ? [`Content-Transfer-Encoding: ${p.encoding}`] : []),
      ...(p.location ? [`Content-Location: ${p.location}`] : []),
    ];
    out += `--${boundary}${eol}${headers.join(eol)}${eol}${eol}${p.body}${eol}`;
  }
  if (!spec.unterminated) out += `--${boundary}--${eol}`;
  return out;
}

/** A 1x1 PNG, as an image part's bytes. */
export const PNG_1PX = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
);

/** The resources a Chromium save of a bank page carries after the page: images, a style sheet, a frame. */
export function resourceParts(): MhtmlPartSpec[] {
  return [
    { type: 'text/css', encoding: 'quoted-printable', location: 'https://scrap.tf/css/styles.1791488770.css', body: encodeQuotedPrintable('.item { width: 64px; } .item::after { content: "=" }') },
    { type: 'image/png', encoding: 'base64', location: 'https://community.akamai.steamstatic.com/economy/image/FIXTURE-378/96fx96f', body: encodeBase64(PNG_1PX) },
    // Never decoded: not even valid base64.
    { type: 'image/png', encoding: 'base64', location: 'https://scrap.tf/img/particles_440/380_380x380.png', body: '!!! not base64 at all ***' },
    // A frame's own document: a second text/html part, never read (only the first one is the page).
    {
      type: 'text/html',
      encoding: 'quoted-printable',
      id: 'frame-2@mhtml.blink',
      body: encodeQuotedPrintable('<html><body><div class="item hoverable quality6 app440" data-id="9999999999" data-defindex="126" data-title="Bill\'s Hat" data-item-value="99"></div></body></html>'),
    },
  ];
}

/**
 * `html` as Chromium's "Webpage, Single File" would hold it: the page first (quoted-printable, its
 * Content-Location `location`), then resourceParts().
 */
export function mhtmlOf(html: string, opts: { location?: string | null; encoding?: 'quoted-printable' | 'base64'; snapshot?: string | null; eol?: string } = {}): string {
  const encoding = opts.encoding ?? 'quoted-printable';
  const body = encoding === 'base64' ? encodeBase64(Buffer.from(html, 'utf8')) : encodeQuotedPrintable(html);
  const location = opts.location === undefined ? 'https://scrap.tf/buy/hats' : opts.location;
  return buildMhtml({
    snapshot: opts.snapshot === undefined ? location : opts.snapshot,
    ...(opts.eol ? { eol: opts.eol } : {}),
    parts: [{ type: 'text/html', encoding, id: 'frame-1@mhtml.blink', ...(location ? { location } : {}), body }, ...resourceParts()],
  });
}

/** Removes every address the HTML itself carries (saved-from comment, canonical link, og:url), as a Chromium MHTML page has none of its own. */
export function withoutAddress(html: string): string {
  return html
    .replace(/<!--\s*saved from url=[^>]*-->/gi, '')
    .replace(/<link rel="canonical"[^>]*>/gi, '')
    .replace(/<meta property="og:url"[^>]*>/gi, '');
}
