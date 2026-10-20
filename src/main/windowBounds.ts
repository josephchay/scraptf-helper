// 0.7.1 (F21-12): the scrap.tf window's size and place, remembered from one open to the next in a small
// JSON file of its own in userData. Not settings.json: it changes with every move and is nobody's setting.
// It is restored only onto a display that is there now; otherwise the window gets its default size,
// centred on the display under the cursor. The file and Electron's screen are injected (the tests' fakes).

import { z } from 'zod';
import type { Logger } from '../service/contracts';
import { readFileRetrySync, writeFileAtomicSync } from './paths';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What is remembered: the normal (not maximised) bounds, and whether the window was maximised. */
export interface SavedWindowBounds extends Rect {
  maximized: boolean;
}

/** The parts of Electron's `screen` the placement reads. */
export interface BoundsScreen {
  getAllDisplays(): readonly { workArea: Rect }[];
  getCursorScreenPoint(): { x: number; y: number };
  getDisplayNearestPoint(point: { x: number; y: number }): { workArea: Rect };
}

/** What a window gives to be remembered (a BrowserWindow). */
export interface BoundsSource {
  getNormalBounds(): Rect;
  isMaximized(): boolean;
  isDestroyed(): boolean;
}

export interface WindowSize {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
}

/** BrowserWindow options: a size always, a place when one is known (else Electron centres it). */
export interface WindowPlacement {
  bounds: { x?: number; y?: number; width: number; height: number };
  maximized: boolean;
}

export interface WindowBoundsDeps {
  /** The JSON file in userData. */
  file: string;
  screen: BoundsScreen;
  log: Logger;
  readFile?(file: string): string;
  writeFile?(file: string, text: string): void;
}

export interface WindowBounds {
  /** Where a new window goes: the remembered bounds when a display shows them now, else the default. */
  place(size: WindowSize): WindowPlacement;
  /** Remembers `w`'s bounds (on close); a failed write is logged and forgotten. */
  remember(w: BoundsSource): void;
}

/** How much of a remembered window must lie on a display's work area to be restored: enough to grab. */
export const MIN_VISIBLE = Object.freeze({ width: 120, height: 48 });
const MAX_COORD = 100_000;
const MAX_FILE_CHARS = 4096;

const coord = z.number().int().min(-MAX_COORD).max(MAX_COORD);
const extent = z.number().int().min(1).max(MAX_COORD);
const fileSchema = z.object({ version: z.literal(1), x: coord, y: coord, width: extent, height: extent, maximized: z.boolean() });

/** The file's contents, or null when it is missing, too big, not JSON or not the shape written. */
export function parseWindowBounds(text: unknown): SavedWindowBounds | null {
  if (typeof text !== 'string' || text.length > MAX_FILE_CHARS) return null;
  let raw: unknown;
  try {
    // 0.7.3: a copy saved as "UTF-8 with BOM" (Windows PowerShell 5.1) is the same file, not an unreadable one.
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
  const r = fileSchema.safeParse(raw);
  if (!r.success) return null;
  const { x, y, width, height, maximized } = r.data;
  return { x, y, width, height, maximized };
}

function isRect(r: unknown): r is Rect {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((k) => typeof o[k] === 'number' && Number.isFinite(o[k]));
}

/** True when at least MIN_VISIBLE of `r` lies on `area`. */
export function visibleOn(r: Rect, area: Rect): boolean {
  const w = Math.min(r.x + r.width, area.x + area.width) - Math.max(r.x, area.x);
  const h = Math.min(r.y + r.height, area.y + area.height) - Math.max(r.y, area.y);
  return w >= Math.min(MIN_VISIBLE.width, r.width) && h >= Math.min(MIN_VISIBLE.height, r.height);
}

/**
 * The remembered bounds when a display shows enough of them now (a monitor may have gone since), at least the
 * minimum size, moved down onto that display when its top edge would be on none; otherwise the default size,
 * fitted to and centred on the work area of the display nearest the cursor. Without a usable screen, the default
 * size alone.
 */
export function placeWindow(saved: SavedWindowBounds | null, screen: BoundsScreen, size: WindowSize): WindowPlacement {
  let areas: Rect[] = [];
  try {
    areas = screen
      .getAllDisplays()
      .map((d) => d.workArea)
      .filter(isRect);
  } catch {
    areas = [];
  }
  const shown = saved === null ? undefined : areas.find((a) => visibleOn(saved, a));
  if (saved !== null && shown !== undefined) {
    // 0.7.3: its top strip (title bar and toolbar, the only places the mouse can drag or use it) must be on a
    // display too. When none shows it (a monitor above has gone), the top is above `shown`: moved down to it.
    const strip = { x: saved.x, y: saved.y, width: saved.width, height: Math.min(MIN_VISIBLE.height, saved.height) };
    const y = areas.some((a) => visibleOn(strip, a)) ? saved.y : shown.y;
    return { bounds: { x: saved.x, y, width: Math.max(size.minWidth, saved.width), height: Math.max(size.minHeight, saved.height) }, maximized: saved.maximized };
  }
  let area: Rect | null = null;
  try {
    const a = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    area = isRect(a) ? a : null;
  } catch {
    area = null;
  }
  if (area === null) return { bounds: { width: size.width, height: size.height }, maximized: false };
  const width = Math.max(size.minWidth, Math.min(size.width, area.width));
  const height = Math.max(size.minHeight, Math.min(size.height, area.height));
  return { bounds: { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height }, maximized: false };
}

export function createWindowBounds(deps: WindowBoundsDeps): WindowBounds {
  const readFile = deps.readFile ?? ((f: string) => readFileRetrySync(f));
  const writeFile = deps.writeFile ?? ((f: string, text: string) => writeFileAtomicSync(f, text));
  let last: string | null = null;

  function load(): SavedWindowBounds | null {
    try {
      return parseWindowBounds(readFile(deps.file));
    } catch (err) {
      // No file yet is the normal first run; anything else just means the default place.
      if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') deps.log.warn('scrap.tf window: its remembered size could not be read');
      return null;
    }
  }

  return {
    place(size) {
      return placeWindow(load(), deps.screen, size);
    },
    remember(w) {
      let saved: SavedWindowBounds;
      try {
        if (w.isDestroyed()) return;
        const b = w.getNormalBounds();
        if (!isRect(b)) return;
        saved = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height), maximized: w.isMaximized() === true };
      } catch {
        return;
      }
      const text = JSON.stringify({ version: 1, ...saved });
      // Only what parses back is written (a window far off any plausible desktop is not remembered).
      if (text === last || parseWindowBounds(text) === null) return;
      try {
        writeFile(deps.file, text);
        last = text;
      } catch {
        deps.log.warn('scrap.tf window: its size could not be remembered');
      }
    },
  };
}
