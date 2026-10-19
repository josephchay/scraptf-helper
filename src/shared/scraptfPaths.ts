// 0.7.1 (F21-4): which scrap.tf pages the saved-page import can read, so the scrap.tf window reads
// only those (fewer reads, never more). Pure and zod-free; it inspects an address string and never
// fetches, opens or follows it (R1). The path rules mirror the parser's pageKindFromUrl
// (service/import/scraptfHtml.ts): a test pins that both agree on every https scrap.tf address.

import { isScraptfPageUrl } from './scraptfWindowPolicy';

/** /buy/unusual(s) and /unusual(s), with or without a sub-path (one effect's page). */
const UNUSUALS_PATH = /^\/(?:buy\/)?unusuals?(?:\/|$)/;
/** /buy/<slug>, any slug (an unknown one still imports; its bank is then null). */
const BUY_PATH = /^\/buy\/[^/]+/;
/** The price list: /items and its later pages /items/<n>. */
const ITEMS_PATH = /^\/items(?:\/\d+)?$/;

/**
 * True for an https address on exactly scrap.tf (isScraptfPageUrl) whose path, trailing slashes, query
 * and hash ignored, is one the import reads: /buy/<slug>, /unusual(s)(/…), /buy/unusual(s)(/…), /items or
 * /items/<n>. False for anything else, the front page, raffles and settings included.
 */
export function scraptfImportablePath(url: string): boolean {
  if (!isScraptfPageUrl(url)) return false;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  const p = (pathname.replace(/\/+$/, '') || '/').toLowerCase();
  return UNUSUALS_PATH.test(p) || BUY_PATH.test(p) || ITEMS_PATH.test(p);
}
