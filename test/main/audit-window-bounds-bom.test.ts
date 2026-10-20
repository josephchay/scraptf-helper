import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWindowBounds, parseWindowBounds } from '../../src/main/windowBounds';
import { fakeScreen } from './scraptfWindowFakes';

// Audit fu-main-2 (same root cause as mainshell-5): the scrap.tf window's remembered size and place, saved
// with a UTF-8 BOM (a copy written by Windows PowerShell 5.1, some editors), was "not JSON": the window
// opened at its default size and place instead of where it was left.

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_CHAR = String.fromCharCode(0xfeff);
const SIZE = { width: 1280, height: 900, minWidth: 640, minHeight: 480 };
const LEFT = { x: 0, y: 0, width: 1920, height: 1040 };
const saved = JSON.stringify({ version: 1, x: 100, y: 80, width: 1300, height: 950, maximized: true });
const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'flipdesk-audit-bounds-bom-'));
  file = path.join(dir, 'scraptf-window.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('window bounds: a file with a UTF-8 BOM', () => {
  it('reads back the same bounds as without it', () => {
    expect(parseWindowBounds(BOM_CHAR + saved)).toEqual({ x: 100, y: 80, width: 1300, height: 950, maximized: true });
    expect(parseWindowBounds(BOM_CHAR + saved)).toEqual(parseWindowBounds(saved));
  });

  it('still refuses what is not the shape written, BOM or not', () => {
    for (const bad of [BOM_CHAR, `${BOM_CHAR}{`, `${BOM_CHAR}null`, `${BOM_CHAR}${BOM_CHAR}${saved}`]) {
      expect(parseWindowBounds(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('places the window where it was left when the file on disk has one', () => {
    writeFileSync(file, Buffer.concat([BOM, Buffer.from(saved)]));
    const l = log();
    const wb = createWindowBounds({ file, screen: fakeScreen([LEFT]), log: l });
    expect(wb.place(SIZE)).toEqual({ bounds: { x: 100, y: 80, width: 1300, height: 950 }, maximized: true });
    expect(l.warn).not.toHaveBeenCalled();
  });
});
