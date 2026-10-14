// Saved scrap.tf page import (opt-in, R10). Reads local files only; never
// contacts scrap.tf.

export {
  ImportTooLargeError,
  MAX_IMPORT_BYTES,
  cssColorToHex,
  htmlAttrLines,
  isImportableItem,
  pageKindFromUrl,
  parseScrapTfHtml,
  warningCode,
  type PageHint,
  type ScrapTfParseResult,
} from './scraptfHtml';

export {
  WATCH_DEBOUNCE_MS,
  createFolderWatcher,
  decodeHtmlBuffer,
  isImportCandidate,
  type FolderWatcher,
  type FolderWatcherOptions,
  type WatchFactory,
  type WatchHandle,
} from './folderWatch';
