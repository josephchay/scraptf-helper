// 0.7.3 (audit window-4 / mainshell-3): a remembered scrap.tf window whose top edge (title bar and toolbar) is on
// no display now, because a monitor above the primary has gone, is moved down onto the display that shows it,
// keeping its size, x and maximised state. A window whose top is on a display is restored exactly as before.

import { describe, expect, it, vi } from 'vitest';
import { createWindowBounds, MIN_VISIBLE, placeWindow, visibleOn, type BoundsSource } from '../../src/main/windowBounds';
import { fakeScreen } from './scraptfWindowFakes';

const SIZE = { width: 1280, height: 900, minWidth: 640, minHeight: 480 };
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };
const UPPER = { x: 0, y: -1080, width: 1920, height: 1080 };
const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const at = (y: number, maximized = false) => ({ x: 100, y, width: 1300, height: 950, maximized });

function source(b: { x: number; y: number; width: number; height: number }): BoundsSource {
  return { getNormalBounds: () => ({ ...b }), isMaximized: () => false, isDestroyed: () => false };
}

describe('a remembered window whose top is on no display', () => {
  it('is moved down onto the display that shows it, its size and x kept', () => {
    // The upper monitor is gone; the bottom 350 px were on the primary.
    expect(placeWindow(at(-600), fakeScreen([PRIMARY]), SIZE)).toEqual({ bounds: { x: 100, y: 0, width: 1300, height: 950 }, maximized: false });
    expect(visibleOn({ x: 100, y: 0, width: 1300, height: MIN_VISIBLE.height }, PRIMARY)).toBe(true);
    expect(placeWindow({ x: 200, y: -700, width: 1280, height: 900, maximized: false }, fakeScreen([PRIMARY]), SIZE)).toEqual({
      bounds: { x: 200, y: 0, width: 1280, height: 900 },
      maximized: false,
    });
  });

  it('is moved down when only its bottom 48 px are shown, and keeps being maximised', () => {
    expect(placeWindow(at(-(950 - MIN_VISIBLE.height), true), fakeScreen([PRIMARY]), SIZE)).toEqual({ bounds: { x: 100, y: 0, width: 1300, height: 950 }, maximized: true });
    // One pixel less shown: not restored at all, the default centred place.
    expect(placeWindow(at(-(950 - MIN_VISIBLE.height) - 1), fakeScreen([PRIMARY]), SIZE)).toEqual({ bounds: { x: 320, y: 70, width: 1280, height: 900 }, maximized: false });
  });

  it('is moved down when its title bar lies across the line between two stacked monitors, in either order', () => {
    for (const areas of [
      [PRIMARY, UPPER],
      [UPPER, PRIMARY],
    ]) {
      expect(placeWindow(at(-20), fakeScreen(areas), SIZE).bounds).toEqual({ x: 100, y: 0, width: 1300, height: 950 });
    }
    expect(placeWindow(at(-1), fakeScreen([PRIMARY]), SIZE).bounds.y).toBe(0);
  });
});

describe('a remembered window whose top is on a display', () => {
  it('is restored exactly as saved', () => {
    // The upper monitor is still there.
    expect(placeWindow(at(-600), fakeScreen([UPPER, PRIMARY]), SIZE)).toEqual({ bounds: { x: 100, y: -600, width: 1300, height: 950 }, maximized: false });
    expect(placeWindow(at(-600), fakeScreen([PRIMARY, UPPER]), SIZE).bounds.y).toBe(-600);
    expect(placeWindow(at(0), fakeScreen([PRIMARY]), SIZE).bounds.y).toBe(0);
    expect(placeWindow(at(100), fakeScreen([PRIMARY]), SIZE)).toEqual({ bounds: { x: 100, y: 100, width: 1300, height: 950 }, maximized: false });
    // Hanging off the bottom with only its top strip shown.
    expect(placeWindow(at(PRIMARY.height - MIN_VISIBLE.height), fakeScreen([PRIMARY]), SIZE).bounds.y).toBe(PRIMARY.height - MIN_VISIBLE.height);
  });
});

describe('through the file', () => {
  it('places a window remembered on the gone monitor on the primary, and the next close remembers that', () => {
    const file: { text: string | null } = { text: null };
    const deps = {
      file: 'bounds.json',
      log: log(),
      readFile: () => {
        if (file.text === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return file.text;
      },
      writeFile: (_f: string, t: string) => {
        file.text = t;
      },
    };
    createWindowBounds({ ...deps, screen: fakeScreen([UPPER, PRIMARY]) }).remember(source({ x: 100, y: -600, width: 1300, height: 950 }));
    const next = createWindowBounds({ ...deps, screen: fakeScreen([PRIMARY]) });
    const placed = next.place(SIZE);
    expect(placed.bounds).toEqual({ x: 100, y: 0, width: 1300, height: 950 });
    next.remember(source({ x: placed.bounds.x!, y: placed.bounds.y!, width: placed.bounds.width, height: placed.bounds.height }));
    expect(JSON.parse(file.text!)).toMatchObject({ x: 100, y: 0, width: 1300, height: 950 });
  });
});
