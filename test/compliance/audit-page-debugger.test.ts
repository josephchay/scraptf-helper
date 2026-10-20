// 0.7.3: the R3/R6/R9 scans cover the Chrome DevTools Protocol. hardenWebContents (windows.ts) and main's
// 'web-contents-created' listener see every webContents, the scrap.tf view included, and its debugger can run a
// main-world script (Runtime.evaluate), send input (Input.dispatch*), override the user agent
// (Emulation.setUserAgentOverride) and read every cookie (Network.getAllCookies). The page-write scan, the user
// agent setters, the cookie ban and the window's request scan matched none of it.
//
// PAGE_DEBUGGER lives in static.test.ts (importing that file would register its suites twice), so its literal is
// read from there.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceFile, walk, type SourceFile } from './windowWrapperScan';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const STATIC = readFileSync(new URL('./static.test.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const literal = /^const PAGE_DEBUGGER = \/(.+)\/;$/m.exec(STATIC);
const PAGE_DEBUGGER = new RegExp(literal ? literal[1]! : '(?!)', 'g');

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');
const raw = (r: string) => readFileSync(path.join(SRC, r), 'utf8').replace(/\r\n/g, '\n');
const tree = (): SourceFile[] => walk(SRC).map((f) => sourceFile(rel(f), raw(rel(f))));

/** `file:line: match` for every PAGE_DEBUGGER match in `files`. */
function hits(files: readonly SourceFile[]): string[] {
  const out: string[] = [];
  for (const f of files) for (const m of f.code.matchAll(PAGE_DEBUGGER)) out.push(`${f.rel}:${f.code.slice(0, m.index).split('\n').length}: ${m[0]}`);
  return out;
}

describe('the DevTools Protocol on a webContents (F21, R3, R6, R9)', () => {
  it('is scanned in every src/ file, with no allow-list', () => {
    expect(literal).not.toBeNull();
    expect(STATIC).toContain('expect(offenders(PAGE_DEBUGGER)).toEqual([]);');
    expect(hits(tree())).toEqual([]);
  });

  it("flags it in hardenWebContents, which the scrap.tf view's webContents passes", () => {
    const r = 'main/windows.ts';
    const src = raw(r);
    const anchor = "  contents.on('will-attach-webview',";
    expect(src).toContain(anchor);
    const at = src.indexOf(anchor);
    const lines = [
      "  contents.debugger.attach('1.3');",
      "  void contents.debugger.sendCommand('Runtime.evaluate', { expression: \"document.querySelector('#buy').click()\" });",
      "  void contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter' });",
      "  void contents.debugger.sendCommand('Emulation.setUserAgentOverride', overrideFor(contents));",
      "  void contents.debugger.sendCommand('Network.getAllCookies');",
    ];
    const next = `${src.slice(0, at)}${lines.join('\n')}\n${src.slice(at)}`;
    const first = src.slice(0, at).split('\n').length;
    const found = hits(tree().map((f) => (f.rel === r ? sourceFile(r, next) : f)));
    expect(found).toContain(`${r}:${first}: .debugger`);
    for (let i = 1; i < lines.length; i++) {
      expect(found).toContain(`${r}:${first + i}: .debugger`);
      expect(found).toContain(`${r}:${first + i}: sendCommand(`);
    }
    expect(found).toHaveLength(1 + 2 * (lines.length - 1));
  });

  it('leaves a bare debugger statement and the word in text alone', () => {
    const f = sourceFile('renderer/pages/LogPage.tsx', "debugger;\nconst hint = 'Open the debugger';\n// contents.debugger.attach()");
    expect(hits([f])).toEqual([]);
  });
});
