// F18 S2: one entry for every saved page the import reads, an .html save or an .mhtml one.
// importSavedPage ('import.html' and the folder watch) calls it with the file as text; nothing
// here reads a file, and nothing in the file is executed, opened or fetched.

import type { SchemaService } from '../contracts';
import { isMhtmlFileName, looksLikeMhtml, readMhtml } from './mhtml';
import { ImportTooLargeError, MAX_IMPORT_BYTES, parseScrapTfHtml, type ScrapTfParseResult } from './scraptfHtml';

export interface SavedPageParse extends ScrapTfParseResult {
  /** How the file was read: a web page, or the web page inside an MHTML file. */
  format: 'html' | 'mhtml';
}

function startsLikeHtml(text: string): boolean {
  return /^\s*</.test(text.slice(0, 1024).replace(/^\uFEFF/, ''));
}

/** The remedy for a Single File save too big to read (size or part count): its images go into a _files folder instead. */
const SAVE_AS_COMPLETE = "save the page again as 'Webpage, Complete', which keeps its images out of the page file";

/**
 * The warning for a saved page the folder watch would not read (over the size limit, F18): its code,
 * the size, and the save type that keeps the page small. recordSkippedImport (rpcHandlers.ts) uses it.
 */
export function tooLargeWarning(detail: string): string {
  return `too-large: ${detail}; ${SAVE_AS_COMPLETE}`;
}

/**
 * The warning for a save under the limit on disk whose page goes over it once decoded (the limit counts
 * UTF-8 bytes: an invalid byte becomes a 3-byte U+FFFD, a single-byte charset part can triple). Its
 * images are not the cause, so it gives no save-type advice.
 */
export function decodedTooLargeWarning(bytes: number, limit: number = MAX_IMPORT_BYTES): string {
  return `too-large: the page decodes to ${Math.ceil(bytes / 1024 / 1024)} MB, over the ${Math.round(limit / 1024 / 1024)} MB import limit; save the page again`;
}

export interface SavedPageOptions {
  /**
   * F21: the address the page was read at, given from outside the HTML (main's read of the opt-in scrap.tf
   * window). Used exactly as an .mhtml part's Content-Location: a page-address hint for page and bank
   * detection, read first, only parsed as text, never fetched. An .mhtml file keeps its own part's address.
   */
  address?: string | null;
  /** 0.7.1 (P4): also return the parse's diagnostics for the parser report (ParseOptions.diagnostics). */
  diagnostics?: boolean;
}

/** A file that is no page at all: imported as nothing, with one clear warning (the batch keeps its name). */
function unreadable(warning: string): SavedPageParse {
  return { format: 'mhtml', pageKind: 'unknown', bank: null, page: '', items: [], warnings: [warning] };
}

/**
 * Parses a saved page. MHTML is told by its MIME headers, whatever the file is called; an .mhtml or
 * .mht name without them is still read as HTML when it starts like a web page. The web page inside is
 * parsed with its Content-Location as the address hint (F15 bank detection), a web page with
 * `opts.address` (F21) when given. Throws
 * ImportTooLargeError over MAX_IMPORT_BYTES (the file, then the page); a file that is malformed, has
 * too many parts, holds no web page or ends inside it (mhtml-truncated) imports nothing, with a
 * warning saying so.
 */
export function parseSavedPage(text: string, fileName: string, schema: SchemaService, opts: SavedPageOptions = {}): SavedPageParse {
  if (typeof text !== 'string') throw new TypeError('parseSavedPage expects the file as a string');
  const named = isMhtmlFileName(fileName);
  // Passed on only when asked, so a parse without it is exactly as before (no diagnostics key).
  const diagnostics = opts.diagnostics === true ? { diagnostics: true } : {};
  if (!looksLikeMhtml(text)) {
    if (named && !startsLikeHtml(text)) return unreadable('mhtml-invalid: the file does not start with MIME headers; save the page again');
    const address = typeof opts.address === 'string' ? opts.address : null;
    return { format: 'html', ...parseScrapTfHtml(text, schema, { address, ...diagnostics }) };
  }
  const r = readMhtml(text, { maxBytes: MAX_IMPORT_BYTES });
  if (!r.ok) {
    if (r.reason === 'too-large') throw new ImportTooLargeError(Buffer.byteLength(text, 'utf8'));
    // Too many parts is a Single File save's images: saving it the same way again cannot help.
    if (r.reason === 'mhtml-too-many-parts') return unreadable(`${r.reason}: ${r.detail}; ${SAVE_AS_COMPLETE}`);
    return unreadable(`${r.reason}: ${r.detail}; save the page again`);
  }
  const parsed = parseScrapTfHtml(r.html, schema, { address: r.contentLocation, ...diagnostics });
  return { format: 'mhtml', ...parsed, warnings: [...r.notes, ...parsed.warnings] };
}
