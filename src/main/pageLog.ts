// F21: log lines a page can trigger at its own rate (a blocked navigation, a dropped popup, a denied
// permission or download in the scrap.tf window). Written one per event, a script looping over
// location.href, window.open or a permission request would fill main.log within seconds, rotate the
// earlier diagnostics away and keep the main thread busy flushing. Each kind is logged at most once per
// PAGE_LOG_GAP_MS; the lines in between are only counted, and the count goes out with the kind's next
// line or at flush() (a new document in the view, the window closing). No timer: nothing here runs on
// its own.

import type { Logger } from '../service/contracts';

/** At most one line per kind this often. */
export const PAGE_LOG_GAP_MS = 60_000;

type PageLogLevel = 'debug' | 'info' | 'warn';

export interface PageLog {
  /**
   * `message` at `level`, unless a line of `kind` went out less than PAGE_LOG_GAP_MS ago (then it is
   * counted). `kind` and `message` are fixed text; anything about the page (its origin and path, never a
   * query) goes in `meta`, which only the logged line carries.
   */
  line(level: PageLogLevel, kind: string, message: string, meta?: unknown): void;
  /** One line per kind with lines counted since its last one, then a fresh start. */
  flush(): void;
}

interface KindState {
  at: number;
  level: PageLogLevel;
  message: string;
  skipped: number;
}

export function createPageLog(log: Logger, now: () => number = Date.now, gapMs: number = PAGE_LOG_GAP_MS): PageLog {
  const kinds = new Map<string, KindState>();
  const write = (level: PageLogLevel, text: string, meta?: unknown) => {
    if (meta === undefined) log[level](text);
    else log[level](text, meta);
  };
  return {
    line(level, kind, message, meta) {
      const t = now();
      const k = kinds.get(kind);
      if (k !== undefined && t - k.at < gapMs) {
        k.skipped++;
        return;
      }
      const more = k?.skipped ?? 0;
      kinds.set(kind, { at: t, level, message, skipped: 0 });
      write(level, more > 0 ? `${message} (and ${more} more like it since the last such line)` : message, meta);
    },
    flush() {
      for (const k of kinds.values()) if (k.skipped > 0) write(k.level, `${k.message}: ${k.skipped} more like it not logged`);
      kinds.clear();
    },
  };
}
