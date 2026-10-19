// Saved scrap.tf page import (opt-in, R10). Reads local files only; never
// contacts scrap.tf.

export {
  ImportTooLargeError,
  MAX_IMPORT_BYTES,
  NO_CARDS_SAVED_WARNING,
  cssColorToHex,
  htmlAttrLines,
  isImportableItem,
  pageKindFromUrl,
  parseScrapTfHtml,
  scraptfPageKey,
  sellsPriceOf,
  warningCode,
  type PageHint,
  type ParseOptions,
  type ScrapTfParseResult,
} from './scraptfHtml';

// F18: .mhtml saves ("Webpage, Single File"), read in the service from the file's text.
export {
  MHTML_MAX_PARTS,
  decodeQuotedPrintable,
  extractMhtmlHtml,
  isMhtmlFileName,
  looksLikeMhtml,
  readMhtml,
  type MhtmlFailure,
  type MhtmlLimits,
  type MhtmlRead,
} from './mhtml';

export { decodedTooLargeWarning, parseSavedPage, tooLargeWarning, type SavedPageOptions, type SavedPageParse } from './savedPage';

export {
  WATCH_DEBOUNCE_MS,
  createFolderWatcher,
  decodeHtmlBuffer,
  isImportCandidate,
  type FolderWatcher,
  type FolderWatcherOptions,
  type WatchFactory,
  type WatchHandle,
  type WatchSkipReason,
} from './folderWatch';

// 0.7.1 (P4): the in-memory ring of sanitized parser reports behind 'import.report' (never persisted).
export { clearImportReports, importReports, recordImportReport, scrubReportText, type ImportReportInput } from './reports';
