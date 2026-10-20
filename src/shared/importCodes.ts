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

/** Warning codes that mean an item was refused (not stored as a price), not just noted. */
export const IMPORT_REFUSAL_CODES: readonly string[] = Object.freeze([
  'needs-target',
  'no-defindex',
  'series-unresolved',
  'unusual-without-effect',
  'paintkit-unresolved',
  'wear-unresolved',
  'paintkit-mismatch',
  'no-price',
  'unparsed-price',
  'parse-error',
  NO_STOCK_LIMIT,
]);

// Skip reasons that are no fault of the page or the parser (ImportResult.skipped).
export const SKIP_OUT_OF_STOCK = 'out of stock on scrap.tf';
export const SKIP_SAME_OR_CHEAPER = 'another copy at the same or a lower price is on this page';
export const SKIP_NEWER_SAVE = 'a newer saved page already set this price';
export const BENIGN_SKIP_REASONS: readonly string[] = Object.freeze([SKIP_OUT_OF_STOCK, SKIP_SAME_OR_CHEAPER, SKIP_NEWER_SAVE]);

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
