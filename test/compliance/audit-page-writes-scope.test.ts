// 0.7.3: the R3 page-write scan (F21) covers every src/ file, not only the window module. hardenWebContents
// (windows.ts) and main's 'web-contents-created' listener see every webContents, the scrap.tf view included,
// so a page write or a main-world script there would run in the user's scrap.tf page. main.ts keeps exactly
// one executeJavaScript: the --smoke-test bridge check on the dashboard, pinned to runSmokeTest.
//
// windowExecProblems lives in static.test.ts (importing that file would register its suites twice), so its
// text and the declarations it uses are taken from there and compiled here, with the shared helpers injected.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import * as helpers from './windowWrapperScan';
import { lineAt, sourceFile, stripComments, walk, type SourceFile } from './windowWrapperScan';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const STATIC = readFileSync(new URL('./static.test.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** The top-level `function`s and `const`s of static.test.ts, by name. */
const DECLS = new Map<string, string>();
for (const m of STATIC.matchAll(/^(?:async\s+)?function\s+([\w$]+)|^const\s+([\w$]+)/gm)) {
  const fn = m[1] !== undefined;
  const end = STATIC.indexOf(fn ? '\n}\n' : ';\n', m.index) + 2;
  DECLS.set((m[1] ?? m[2])!, STATIC.slice(m.index, end));
}

/** `name` from static.test.ts with every declaration of the file it uses (the shared helpers come from the module). */
function load<T>(name: string): T {
  const order: string[] = [];
  const visit = (n: string) => {
    if (order.includes(n) || n in helpers || !DECLS.has(n)) return;
    order.push(n);
    for (const id of stripComments(DECLS.get(n)!).match(/[A-Za-z_$][\w$]*/g) ?? []) if (id !== n) visit(id);
  };
  visit(name);
  const js = transformSync(order.map((n) => DECLS.get(n)!).join('\n'), { loader: 'ts' }).code;
  const names = Object.keys(helpers);
  return new Function(...names, `${js}\nreturn ${name};`)(...names.map((n) => (helpers as Record<string, unknown>)[n])) as T;
}

const windowExecProblems = load<(files: readonly SourceFile[]) => string[]>('windowExecProblems');

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');
const raw = (r: string) => readFileSync(path.join(SRC, r), 'utf8').replace(/\r\n/g, '\n');
const tree = (): SourceFile[] => walk(SRC).map((f) => sourceFile(rel(f), raw(rel(f))));

/** The tree with `r` replaced by `edit(its text)`. */
function edited(r: string, edit: (src: string) => string): SourceFile[] {
  const src = raw(r);
  const next = edit(src);
  expect(next, r).not.toBe(src);
  return tree().map((f) => (f.rel === r ? sourceFile(r, next) : f));
}

/** `src` with `line` put before the line holding `anchor`; the added line takes that line's number. */
function insert(src: string, anchor: string, line: string): string {
  expect(src.includes(anchor), anchor).toBe(true);
  const i = src.lastIndexOf('\n', src.indexOf(anchor)) + 1;
  return `${src.slice(0, i)}${line}\n${src.slice(i)}`;
}

const WILL_ATTACH = "contents.on('will-attach-webview'";
const CREATED = "app.on('web-contents-created', (_e, contents) =>";
const BRIDGE = 'await contents.executeJavaScript(';
const lineOf = (r: string, anchor: string) => lineAt(raw(r), raw(r).indexOf(anchor));

describe('no page write or main-world script outside the pinned ones, in any src/ file (F21, R3)', () => {
  it('passes the real tree, whose one main-world script is the smoke test bridge check', () => {
    expect(windowExecProblems(tree())).toEqual([]);
    const main = sourceFile('main/main.ts', raw('main/main.ts')).code;
    expect([...main.matchAll(/\.\s*executeJavaScript\s*\(/g)]).toHaveLength(1);
  });

  for (const line of [
    "  contents.on('dom-ready', () => void contents.insertCSS('#ad{display:none}'));",
    '  contents.selectAll(); contents.paste();',
    "  contents.insertText('x');",
    '  contents.replace();',
  ]) {
    it(`flags ${line.trim()} in hardenWebContents, which every webContents passes`, () => {
      const hits = windowExecProblems(edited('main/windows.ts', (src) => insert(src, WILL_ATTACH, line)));
      expect(hits.length).toBeGreaterThan(0);
      for (const h of hits) expect(h).toMatch(new RegExp(`^main/windows\\.ts:${lineOf('main/windows.ts', WILL_ATTACH)}: `));
    });
  }

  it("flags a main-world script in main's web-contents-created listener", () => {
    const line = "  app.on('web-contents-created', (_e, c) => c.on('dom-ready', () => void c.executeJavaScript(\"document.querySelector('#buy').click()\")));";
    const hits = windowExecProblems(edited('main/main.ts', (src) => insert(src, CREATED, line)));
    // A second executeJavaScript in main.ts: neither is the one bridge check any more.
    expect(hits).toEqual(expect.arrayContaining([`main/main.ts:${lineOf('main/main.ts', CREATED)}: executeJavaScript`]));
    expect(hits).toHaveLength(2);
  });

  it('flags the one main.ts script moved out of runSmokeTest, or into a listener inside it', () => {
    const moved = edited('main/main.ts', (src) => insert(src.replace(BRIDGE, 'await contents.getURL('), CREATED, "  app.on('browser-window-created', (_e, w) => void w.webContents.executeJavaScript('1'));"));
    expect(windowExecProblems(moved)).toHaveLength(1);
    const deferred = edited('main/main.ts', (src) =>
      src.replace(/await contents\.executeJavaScript\(\n[^\n]*\n\s*\);/, "await new Promise((r) => contents.once('dom-ready', () => r(contents.executeJavaScript('1'))));"),
    );
    expect(windowExecProblems(deferred)).toHaveLength(1);
  });

  it("flags an edit command on a webContents in any main file, the settings store's hotkey rollback aside", () => {
    const store = edited('main/settingsStore.ts', (src) => src.replace('hotkeys.undo();', 'hotkeys.undo();\n        contents.undo();'));
    expect(windowExecProblems(store)).toEqual([`main/settingsStore.ts:${lineAt(raw('main/settingsStore.ts'), raw('main/settingsStore.ts').indexOf('hotkeys.undo();')) + 1}: .undo()`]);
    const harness = edited('main/smokeWindow.ts', (src) => src.replace(/(\n\s*)(wc\.sendInputEvent\()/, '$1wc.paste();$1$2'));
    expect(windowExecProblems(harness).map((h) => h.split(': ')[1])).toEqual(['.paste()']);
  });
});
