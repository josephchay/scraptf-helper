// 0.7.1: the saved-page import's fixed codes, messages and thresholds, shared by the service (which
// throws and warns with them), main's scrap.tf window (which maps them to toolbar text) and the
// dashboard, so all of them read a code alike. Pure and zod-free. A code is the text before the first
// ':' of a warning; matching on codes means no page text is ever logged or shown.

/** The item schema is still loading: an import now would key cards by guesses, so it is refused. */
export const IMPORT_SCHEMA_LOADING_CODE = 'schema-loading';
/** The error importSavedPage throws while the schema loads; main matches it with includes(code). */
export const IMPORT_SCHEMA_LOADING_MESSAGE = `${IMPORT_SCHEMA_LOADING_CODE}: Item data is still loading, so this page cannot be read yet. Import it again in a moment.`;

/** Item-like elements were found, but none in a shape the parser knows (scrap.tf changed its page). */
export const LAYOUT_CHANGED = 'layout-changed';
/**
 * 0.7.3: scrap.tf's bare /unusuals index (also /unusual, /buy/unusuals) with no card: it lists the unusual
 * pages, never item cards itself, so neither "saved without its items" nor "layout changed" is true of it.
 */
export const UNUSUALS_INDEX = 'unusuals-index';
/** The /items table has headers but no "Price to buy" column: no price is guessed from a position. */
export const NO_PRICE_COLUMN = 'no-price-column';
/** Far fewer cards than a recent save of the page: prices stored, no bank stock save. */
export const PARTIAL_READ = 'partial-read';
/** An /items row whose stock limit could not be read. */
export const NO_STOCK_LIMIT = 'no-stock-limit';
/**
 * 0.7.4 (F82): a saved file whose modified time is ahead of this computer's clock: its prices are stored,
 * dated now, but it is no bank stock save (an old page with a reset time would rewrite the bank's history).
 */
export const FUTURE_MTIME = 'future-mtime';
/** 0.7.4 (F82): a file's modified time further ahead of the clock than this is in the future (FUTURE_MTIME). */
export const FUTURE_MTIME_SLACK_MS = 2 * 60_000;
/** 0.7.4: /items rows that key to one item with different prices or stock: none of them sets a price. */
export const DUPLICATE_ROW = 'duplicate-row';
/**
 * 0.7.4: an /items row that shows neither "Non-Craftable" nor a Craftable sibling: one entry for every copy
 * scrap.tf sells at its price (a family row). A note for the parser report, never a refusal.
 */
export const CRAFT_UNVERIFIED = 'craft-unverified';

/** Warning codes that mean an item was refused (not stored as a price), not just noted. */
export const IMPORT_REFUSAL_CODES: readonly string[] = Object.freeze([
  'needs-target',
  'no-defindex',
  'series-unresolved',
  'unusual-without-effect',
  'paintkit-unresolved',
  'wear-unresolved',
  'paintkit-mismatch',
  // 0.7.4 (F76/F75): a Strange-only quality naming another quality or an effect; strange parts on a non-strange copy.
  'quality-conflict',
  'strange-conflict',
  'no-price',
  'unparsed-price',
  'parse-error',
  NO_STOCK_LIMIT,
  DUPLICATE_ROW,
]);

// Skip reasons that are no fault of the page or the parser (ImportResult.skipped).
export const SKIP_OUT_OF_STOCK = 'out of stock on scrap.tf';
export const SKIP_SAME_OR_CHEAPER = 'another copy at the same or a lower price is on this page';
export const SKIP_NEWER_SAVE = 'a newer saved page already set this price';
/** 0.7.4: an /items family row is kept on the price list, never as a cost (CRAFT_UNVERIFIED). */
export const SKIP_CRAFT_UNPROVEN = 'the scrap.tf/items list does not show whether this is the Craftable or Non-Craftable copy';
/** 0.7.4: the /items list never replaces a bank page's own price of a copy (that bank's saves decide it). */
export const SKIP_BANK_CARD_PRICE = "its bank page's own price for this copy is stored";
/**
 * 0.7.4: a newer whole save of the copy's bank page does not show it on sale (an older bank page arriving late,
 * or an /items row whose home bank was saved after the list without it): no price is set, and none exists.
 * SKIP_NEWER_SAVE stays for a copy a newer page did price.
 */
export const SKIP_NOT_ON_SALE_NEWER = 'a newer save of its bank page does not show it on sale';
export const BENIGN_SKIP_REASONS: readonly string[] = Object.freeze([SKIP_OUT_OF_STOCK, SKIP_SAME_OR_CHEAPER, SKIP_NEWER_SAVE, SKIP_CRAFT_UNPROVEN, SKIP_BANK_CARD_PRICE, SKIP_NOT_ON_SALE_NEWER]);

// Partial look (DM-2): a save is partial when the newest stored save of the same page is at most this
// old, had at least the minimum on-sale keys, and this save has fewer than the ratio of them. The floor
// keeps tiny pages (and tests with 2-3 cards) from ever reading as partial.
export const PARTIAL_READ_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const PARTIAL_READ_RATIO = 0.5;
export const PARTIAL_READ_MIN_KEYS = 8;

/** ImportReport.items cap, and how many reports the in-memory ring keeps (P4). */
export const IMPORT_REPORT_MAX_ITEMS = 200;
export const IMPORT_REPORT_RING = 20;

/** A warning's code: the text before the first ':', trimmed (the whole text, trimmed, when it has none). */
export function importWarningCode(w: string): string {
  const s = typeof w === 'string' ? w : '';
  const i = s.indexOf(':');
  return (i < 0 ? s : s.slice(0, i)).trim();
}
