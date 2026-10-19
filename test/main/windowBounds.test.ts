// 0.7.1 (F21-12): the scrap.tf window's remembered size and place (main/windowBounds.ts): the file's shape,
// what counts as shown by a display, where a new window goes, and the remembering itself, once against an
// in-memory file and once against a real file in a temporary folder. Nothing here opens a window.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWindowBounds, MIN_VISIBLE, parseWindowBounds, placeWindow, visibleOn, type BoundsSource } from '../../src/main/windowBounds';
import { fakeScreen } from './scraptfWindowFakes';

const SIZE = { width: 1280, height: 900, minWidth: 640, minHeight: 480 };
const LEFT = { x: 0, y: 0, width: 1920, height: 1040 };
const RIGHT = { x: 1920, y: 0, width: 2560, height: 1400 };
const saved = (over: Record<string, unknown> = {}) => JSON.stringify({ version: 1, x: 100, y: 80, width: 1300, height: 950, maximized: false, ...over });
const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function source(b: { x: number; y: number; width: number; height: number }, maximized = false, destroyed = false): BoundsSource {
  return { getNormalBounds: () => ({ ...b }), isMaximized: () => maximized, isDestroyed: () => destroyed };
}

describe('the file', () => {
  it('reads back what is written, and nothing else', () => {
    expect(parseWindowBounds(saved())).toEqual({ x: 100, y: 80, width: 1300, height: 950, maximized: false });
    expect(parseWindowBounds(saved({ x: -1500, maximized: true }))).toEqual({ x: -1500, y: 80, width: 1300, height: 950, maximized: true });
    // Unknown keys are dropped, not kept.
    expect(parseWindowBounds(saved({ extra: 'x' }))).toEqual({ x: 100, y: 80, width: 1300, height: 950, maximized: false });
    for (const bad of [
      null,
      undefined,
      42,
      '',
      '{',
      'null',
      '[]',
      saved({ version: 2 }),
      saved({ x: 1.5 }),
      saved({ width: 0 }),
      saved({ height: -10 }),
      saved({ x: 1e9 }),
      saved({ maximized: 'yes' }),
      saved({ y: '80' }),
      JSON.stringify({ x: 1, y: 1, width: 900, height: 700, maximized: false }),
      `${saved()}${' '.repeat(5000)}`,
    ]) {
      expect(parseWindowBounds(bad), String(bad)).toBeNull();
    }
  });
});

describe('placement', () => {
  it('counts a window as shown when enough of it to grab lies on a work area', () => {
    expect(visibleOn({ x: 100, y: 100, width: 800, height: 600 }, LEFT)).toBe(true);
    // Hanging off the right edge with a strip still to grab.
    expect(visibleOn({ x: LEFT.width - MIN_VISIBLE.width, y: 100, width: 800, height: 600 }, LEFT)).toBe(true);
    expect(visibleOn({ x: LEFT.width - MIN_VISIBLE.width + 1, y: 100, width: 800, height: 600 }, LEFT)).toBe(false);
    expect(visibleOn({ x: 100, y: LEFT.height - MIN_VISIBLE.height + 1, width: 800, height: 600 }, LEFT)).toBe(false);
    expect(visibleOn({ x: 3000, y: 100, width: 800, height: 600 }, LEFT)).toBe(false);
    expect(visibleOn({ x: -2000, y: -2000, width: 800, height: 600 }, LEFT)).toBe(false);
  });

  it('restores the remembered place on the display that shows it, at least the minimum size', () => {
    const screen = fakeScreen([LEFT, RIGHT]);
    expect(placeWindow({ x: 2100, y: 60, width: 1500, height: 1000, maximized: true }, screen, SIZE)).toEqual({ bounds: { x: 2100, y: 60, width: 1500, height: 1000 }, maximized: true });
    expect(placeWindow({ x: 50, y: 50, width: 300, height: 200, maximized: false }, screen, SIZE)).toEqual({ bounds: { x: 50, y: 50, width: 640, height: 480 }, maximized: false });
  });

  it('opens at the default size, centred on the display under the cursor, when nothing shows the remembered place', () => {
    const screen = fakeScreen([LEFT, RIGHT], { x: 2500, y: 300 });
    // The right monitor is gone: only the left one is there now.
    expect(placeWindow({ x: 2100, y: 60, width: 1500, height: 1000, maximized: true }, fakeScreen([LEFT]), SIZE)).toEqual({
      bounds: { x: (1920 - 1280) / 2, y: (1040 - 900) / 2, width: 1280, height: 900 },
      maximized: false,
    });
    expect(placeWindow(null, screen, SIZE)).toEqual({ bounds: { x: 1920 + (2560 - 1280) / 2, y: (1400 - 900) / 2, width: 1280, height: 900 }, maximized: false });
    // A small display: the default fits it, never under the minimum.
    expect(placeWindow(null, fakeScreen([{ x: 0, y: 0, width: 1024, height: 700 }]), SIZE)).toEqual({ bounds: { x: 0, y: 0, width: 1024, height: 700 }, maximized: false });
    expect(placeWindow(null, fakeScreen([{ x: 0, y: 0, width: 600, height: 400 }]), SIZE).bounds).toMatchObject({ width: 640, height: 480 });
  });

  it('falls back to the size alone when the screen cannot be asked', () => {
    const broken = {
      getAllDisplays: () => {
        throw new Error('not ready');
      },
      getCursorScreenPoint: () => {
        throw new Error('not ready');
      },
      getDisplayNearestPoint: () => ({ workArea: LEFT }),
    };
    expect(placeWindow({ x: 1, y: 1, width: 900, height: 700, maximized: false }, broken, SIZE)).toEqual({ bounds: { width: 1280, height: 900 }, maximized: false });
  });
});

describe('remembering', () => {
  it('writes the normal bounds and the maximised state, once per change, and places the next window there', () => {
    const file: { text: string | null } = { text: null };
    const writes: string[] = [];
    const l = log();
    const b = createWindowBounds({
      file: 'bounds.json',
      screen: fakeScreen([LEFT]),
      log: l,
      readFile: () => {
        if (file.text === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return file.text;
      },
      writeFile: (_f, t) => {
        file.text = t;
        writes.push(t);
      },
    });
    expect(b.place(SIZE).bounds).toEqual({ x: 320, y: 70, width: 1280, height: 900 });
    b.remember(source({ x: 10.4, y: 20, width: 1000, height: 700 }, true));
    b.remember(source({ x: 10, y: 20, width: 1000, height: 700 }, true));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(file.text!)).toEqual({ version: 1, x: 10, y: 20, width: 1000, height: 700, maximized: true });
    expect(b.place(SIZE)).toEqual({ bounds: { x: 10, y: 20, width: 1000, height: 700 }, maximized: true });
    // A gone window, or bounds no file would read back, are not written.
    b.remember(source({ x: 50, y: 50, width: 900, height: 600 }, false, true));
    b.remember(source({ x: 1e9, y: 0, width: 900, height: 600 }));
    b.remember({ getNormalBounds: () => ({ x: Number.NaN, y: 0, width: 1, height: 1 }), isMaximized: () => false, isDestroyed: () => false });
    expect(writes).toHaveLength(1);
    // No file yet is no warning.
    expect(l.warn).not.toHaveBeenCalled();
  });

  it('logs a file it cannot read or write without its path or contents, and goes on with the default', () => {
    const l = log();
    const b = createWindowBounds({
      file: 'C:/Users/Someone/AppData/bounds.json',
      screen: fakeScreen([LEFT]),
      log: l,
      readFile: () => {
        throw Object.assign(new Error('EACCES: C:/Users/Someone'), { code: 'EACCES' });
      },
      writeFile: () => {
        throw new Error('EBUSY: C:/Users/Someone');
      },
    });
    expect(b.place(SIZE).bounds).toEqual({ x: 320, y: 70, width: 1280, height: 900 });
    b.remember(source({ x: 10, y: 20, width: 1000, height: 700 }));
    expect(l.warn.mock.calls.map(([m]) => m)).toEqual(['scrap.tf window: its remembered size could not be read', 'scrap.tf window: its size could not be remembered']);
    expect(JSON.stringify(l.warn.mock.calls)).not.toContain('Someone');
  });

  describe('on disk', () => {
    let dir: string | null = null;
    afterEach(() => {
      if (dir !== null) rmSync(dir, { recursive: true, force: true });
      dir = null;
    });

    it('writes a small JSON file of its own, read back by the next start', () => {
      dir = mkdtempSync(path.join(tmpdir(), 'flipdesk-bounds-'));
      const file = path.join(dir, 'scraptf-window-bounds.json');
      const first = createWindowBounds({ file, screen: fakeScreen([LEFT, RIGHT]), log: log() });
      expect(first.place(SIZE).maximized).toBe(false);
      first.remember(source({ x: 2000, y: 40, width: 1400, height: 1000 }));
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, x: 2000, y: 40, width: 1400, height: 1000, maximized: false });
      const next = createWindowBounds({ file, screen: fakeScreen([LEFT, RIGHT]), log: log() });
      expect(next.place(SIZE).bounds).toEqual({ x: 2000, y: 40, width: 1400, height: 1000 });
      // Someone else's file there: ignored, the default used.
      writeFileSync(file, '{"x": "<script>"}');
      expect(next.place(SIZE).bounds).toMatchObject({ width: 1280, height: 900 });
    });
  });
});
