// 0.7.3: the R1 loader scans know Electron's two other ways to make a request from a webContents or a
// session: downloadURL (a download) and savePage (which re-requests the page or its resources). A scrap.tf
// address handed to either, anywhere, is the app requesting scrap.tf itself; savePage takes no address at all,
// so it is banned outright (the user saves a page with Ctrl+S in their own browser, R1 and R10).
//
// LOADERS and WINDOW_REQUEST live in static.test.ts (importing it would register its suites twice), so their
// regex literals are read from its text.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceFile, walk } from './windowWrapperScan';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const STATIC = readFileSync(new URL('./static.test.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** The regex literal on the line after `const name =` in static.test.ts. */
function regexOf(name: string): RegExp {
  const at = STATIC.indexOf(`\nconst ${name} =\n`);
  expect(at, name).toBeGreaterThan(-1);
  const line = STATIC.slice(at + `\nconst ${name} =\n`.length).split('\n')[0]!.trim();
  const m = /^\/(.+)\/([a-z]*);$/.exec(line);
  expect(m, name).not.toBeNull();
  return new RegExp(m![1]!, m![2]!.replace('g', ''));
}

const LOADERS = regexOf('LOADERS');
const WINDOW_REQUEST = regexOf('WINDOW_REQUEST');
const SAVE = 'await wc.savePage(tmpFile, \'HTMLOnly\');';

describe('downloadURL and savePage are loaders to the R1 scans (F21, R1)', () => {
  it('sees a download of a scrap.tf address and a page save as loads', () => {
    for (const line of ['contents.downloadURL(SCRAPTF_ITEMS_URL);', 'session.defaultSession.downloadURL(SCRAPTF_BANKS[0].url);', SAVE]) expect(LOADERS.test(line), line).toBe(true);
    // A loadURL was always one.
    expect(LOADERS.test('mainContents.loadURL(SCRAPTF_ITEMS_URL);')).toBe(true);
  });

  it("holds the window module to no page save or download of its own", () => {
    expect(WINDOW_REQUEST.test(SAVE)).toBe(true);
    expect(WINDOW_REQUEST.test('wc.downloadURL(SCRAPTF_HOME_URL);')).toBe(true);
  });

  it('finds neither in src/: no page save at all, no download', () => {
    const files = walk(SRC).map((f) => sourceFile(path.relative(SRC, f).split(path.sep).join('/'), readFileSync(f, 'utf8')));
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((f) => /\.\s*(?:savePage|downloadURL)\s*\(/.test(f.code)).map((f) => f.rel)).toEqual([]);
  });
});
