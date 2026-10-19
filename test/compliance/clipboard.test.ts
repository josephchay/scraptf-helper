// F16 live check, static side of the clipboard rules: the app reads plain clipboard text only, in
// main only (never HTML, RTF, images or other formats, and never from a renderer, which only
// writes copies); the one Electron read is the reader main hands to the live check controller, which
// calls it from exactly two places, the watcher's poll and the hotkey handler; and no logger call in
// the live check modules can receive the text. The runtime side is test/main/clipboardWatch.test.ts,
// test/main/liveCheckMain.test.ts (the real logger) and test/service/liveCheckRpc.test.ts.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|js|mjs|cjs|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Blanks block and line comments, keeping line numbers ("://" inside strings stays). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\/])\/\/.*$/, '$1'))
    .join('\n');
}

type SourceFile = { rel: string; code: string };
const FILES: SourceFile[] = walk(SRC).map((f) => ({ rel: path.relative(SRC, f).split(path.sep).join('/'), code: stripComments(readFileSync(f, 'utf8')) }));
const file = (rel: string): SourceFile => {
  const f = FILES.find((x) => x.rel === rel);
  if (!f) throw new Error(`missing ${rel}`);
  return f;
};

function offenders(re: RegExp, allowed: (rel: string) => boolean = () => false, files = FILES): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (allowed(f.rel)) continue;
    for (const m of f.code.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) {
      out.push(`${f.rel}:${f.code.slice(0, m.index).split('\n').length}: ${m[0]}`);
    }
  }
  return out;
}

// ----- a small scanner: strings and bracket pairs, enough for call arguments and function bodies -----

/** Index just past the string literal opening at `i` (', " or `; a template's ${…} is skipped whole). */
function skipString(code: string, i: number): number {
  const q = code[i];
  let j = i + 1;
  while (j < code.length) {
    const c = code[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (q === '`' && c === '$' && code[j + 1] === '{') {
      const end = matchEnd(code, j + 1);
      j = end < 0 ? code.length : end + 1;
      continue;
    }
    if (c === q) return j + 1;
    j++;
  }
  return j;
}

/** Index of the bracket closing the one at `open` ((, { or [), skipping strings; -1 when unbalanced. */
function matchEnd(code: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < code.length) {
    const c = code[i]!;
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(code, i);
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** `code` with every string's text blanked: '…' and "…" become '', a template keeps only its ${…} expressions. */
function stripStrings(code: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    if (c === "'" || c === '"') {
      i = skipString(code, i);
      out += "''";
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      out += '`';
      while (j < code.length && code[j] !== '`') {
        if (code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code[j] === '$' && code[j + 1] === '{') {
          const end = matchEnd(code, j + 1);
          // The expression alone, in parentheses: "${" itself is not a name.
          out += ` (${stripStrings(code.slice(j + 2, end))}) `;
          j = end + 1;
          continue;
        }
        j++;
      }
      out += '`';
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The [start, end] of the block (or argument list) whose opening bracket is the first `bracket` after `marker`. */
function blockAfter(code: string, marker: string, bracket: '{' | '(' = '{'): [number, number] {
  const at = code.indexOf(marker);
  if (at < 0) throw new Error(`no ${marker}`);
  const open = code.indexOf(bracket, at + marker.length - (marker.endsWith(bracket) ? 1 : 0));
  return [open, matchEnd(code, open)];
}

/** Every logger or console call: its location and its argument text (balanced, strings intact). */
function logCalls(f: SourceFile): { where: string; args: string }[] {
  const out: { where: string; args: string }[] = [];
  for (const m of f.code.matchAll(/\b(?:log|logger|console)\s*\.\s*(?:debug|info|warn|error|log)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const end = matchEnd(f.code, open);
    out.push({ where: `${f.rel}:${f.code.slice(0, m.index).split('\n').length}`, args: f.code.slice(open + 1, end < 0 ? f.code.length : end) });
  }
  return out;
}

/** Identifiers a logger call's arguments use, string texts left out ("the clipboard" in a message is fine). */
function identifiersIn(args: string): string[] {
  return [...stripStrings(args).matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]);
}

/** Any clipboard read except plain text: Electron's readHTML/readRTF/readImage/readBookmark/readBuffer/read/availableFormats, and the web Clipboard API's read(). */
const RICH_CLIPBOARD_READ =
  /\bclipboard\s*\.\s*(?:readHTML|readRTF|readImage|readBookmark|readBuffer|readFindText|read|availableFormats|has)\s*\(|\bnavigator\s*\.\s*clipboard\s*\.\s*read\s*\(/;
/** A plain-text clipboard read (Electron's readText or the web API's readText). */
const TEXT_CLIPBOARD_READ = /\bclipboard\s*\.\s*readText\s*\(/;
/** Any call of a readText reader (the Electron one, or the reader main hands on). */
const READER_CALL = /\.\s*readText\s*\(/;
/** A log or console call whose arguments name `text` (the checked clipboard text) or `clip`. */
const TEXT_LOGGED = /\b(?:log|logger|console)\s*\.\s*(?:debug|info|warn|error|log)\s*\([^)]*\b(?:text|clip|clipboardText|copied)\b/;
/** Names that hold clipboard text on its way through main and the service. */
const TEXT_NAMES = new Set(['text', 'clip', 'clipboardText', 'copied', 'itemText', 'sent', 'value', 'v']);

/** The live check modules: their log calls may only use these names (error classes, the resolved SKU). */
const LIVE_CHECK_FILES = ['main/clipboardWatch.ts', 'main/liveCheck.ts', 'service/domain/liveCheck.ts'];
const LOG_ARGS_ALLOWED = new Set(['error', 'errorName', 'err', 'what', 'sku', 'base', 'name', 'instanceof', 'Error', 'typeof']);
/** Main's wiring around it: no log call there may name the text. */
const WIRING_FILES = ['main/main.ts', 'main/hotkeys.ts', 'main/ipc.ts'];

describe('clipboard reads (F16)', () => {
  it('never reads rich clipboard formats anywhere', () => {
    expect(offenders(RICH_CLIPBOARD_READ)).toEqual([]);
  });

  it('reads plain text in main only, never from a renderer or the service', () => {
    expect(offenders(TEXT_CLIPBOARD_READ, (rel) => rel.startsWith('main/'))).toEqual([]);
    // Not even the name outside the three main files of the feature: no reader is passed around elsewhere.
    expect(offenders(/\breadText\b/, (rel) => ['main/main.ts', 'main/liveCheck.ts', 'main/clipboardWatch.ts'].includes(rel))).toEqual([]);
  });

  it("has exactly one Electron read: the reader main.ts hands to the live check controller", () => {
    const reads = offenders(TEXT_CLIPBOARD_READ);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/^main\/main\.ts:\d+: clipboard\.readText\($/);
    const main = file('main/main.ts').code;
    const [open, close] = blockAfter(main, 'createLiveCheckMain(', '(');
    const call = main.slice(open, close + 1);
    expect(call).toMatch(/\breadText:\s*\(\)\s*=>\s*clipboard\.readText\(\)/);
    expect(main.indexOf('clipboard.readText(')).toBeGreaterThan(open);
    expect(main.indexOf('clipboard.readText(')).toBeLessThan(close);
  });

  it('calls that reader only from the watcher poll (clipboardWatch.ts) and the hotkey handler (liveCheck.ts)', () => {
    const calls = offenders(READER_CALL).map((o) => o.split(':')[0]);
    expect(calls.sort()).toEqual(['main/clipboardWatch.ts', 'main/liveCheck.ts', 'main/liveCheck.ts', 'main/main.ts']);
    const inside = (f: SourceFile, [a, b]: [number, number]) =>
      [...f.code.matchAll(new RegExp(READER_CALL.source, 'g'))].every((m) => m.index > a && m.index < b);

    // clipboardWatch.ts: opts.readText() in poll(), which only the interval and start() run.
    const watch = file('main/clipboardWatch.ts');
    expect(inside(watch, blockAfter(watch.code, 'function poll('))).toBe(true);

    // liveCheck.ts: once in the hotkey handler, once as the reader the watcher polls with.
    const ctl = file('main/liveCheck.ts');
    const hotkey = blockAfter(ctl.code, 'async function checkForHotkey(');
    const watcher = blockAfter(ctl.code, 'createClipboardWatch(', '(');
    const sites = [...ctl.code.matchAll(new RegExp(READER_CALL.source, 'g'))].map((m) => m.index);
    expect(sites).toHaveLength(2);
    expect(sites.filter((i) => i > hotkey[0] && i < hotkey[1])).toHaveLength(1);
    expect(sites.filter((i) => i > watcher[0] && i < watcher[1])).toHaveLength(1);
    expect(ctl.code.slice(watcher[0], watcher[1])).toMatch(/\breadText:\s*\(\)\s*=>\s*deps\.readText\(\)/);
    // The hotkey handler runs from the hotkey only.
    expect([...ctl.code.matchAll(/\bcheckForHotkey\(/g)]).toHaveLength(2); // its definition and the one call
    const hotkeyMethod = ctl.code.slice(...blockAfter(ctl.code, 'async hotkey()'));
    expect(hotkeyMethod).toContain('await checkForHotkey()');
  });

  it('the filter runs before the text leaves main, on both paths', () => {
    const ctl = file('main/liveCheck.ts').code;
    const hotkey = ctl.slice(...blockAfter(ctl, 'async function checkForHotkey('));
    expect(hotkey.indexOf('shouldCheckClipboardText(')).toBeGreaterThan(0);
    expect(hotkey.indexOf('shouldCheckClipboardText(')).toBeLessThan(hotkey.indexOf('deps.check('));
    const watch = file('main/clipboardWatch.ts').code;
    const take = watch.slice(...blockAfter(watch, 'function take('));
    expect(take.indexOf('shouldCheckClipboardText(')).toBeGreaterThan(0);
    expect(take.indexOf('shouldCheckClipboardText(')).toBeLessThan(take.indexOf('opts.onText('));
  });

  it('no logger call in the live check modules can receive the text: only error classes and the resolved SKU', () => {
    const files = FILES.filter((f) => LIVE_CHECK_FILES.includes(f.rel));
    expect(files.map((f) => f.rel).sort()).toEqual([...LIVE_CHECK_FILES].sort());
    const bad: string[] = [];
    for (const f of files) {
      for (const c of logCalls(f)) {
        const extra = identifiersIn(c.args).filter((id) => !LOG_ARGS_ALLOWED.has(id));
        if (extra.length > 0) bad.push(`${c.where}: ${extra.join(', ')}`);
      }
    }
    expect(bad).toEqual([]);
    expect(offenders(/\bconsole\s*\./, () => false, files)).toEqual([]);
    // The service's 'check.text' handler logs the error class only.
    const handlers = file('service/rpcHandlers.ts');
    const start = handlers.code.indexOf("'check.text':");
    const block = { rel: handlers.rel, code: handlers.code.slice(start, handlers.code.indexOf("'check.recent':", start)) };
    const handlerLogs = logCalls(block);
    expect(handlerLogs.length).toBeGreaterThan(0);
    for (const c of handlerLogs) expect(identifiersIn(c.args).filter((id) => !LOG_ARGS_ALLOWED.has(id))).toEqual([]);
  });

  it("main's wiring has no log call that names the text", () => {
    const bad: string[] = [];
    for (const f of FILES.filter((x) => WIRING_FILES.includes(x.rel))) {
      for (const c of logCalls(f)) {
        const named = identifiersIn(c.args).filter((id) => TEXT_NAMES.has(id));
        if (named.length > 0) bad.push(`${c.where}: ${named.join(', ')}`);
      }
    }
    expect(bad).toEqual([]);
    expect(offenders(TEXT_LOGGED, () => false, FILES.filter((x) => WIRING_FILES.includes(x.rel)))).toEqual([]);
  });

  it('each scan finds what it looks for (a scan that sees nothing would pass)', () => {
    const synthetic = [
      { rel: 'renderer/x.ts', code: "const h = clipboard.readHTML();\nawait navigator.clipboard.read();\nclipboard.availableFormats();" },
      { rel: 'renderer/y.ts', code: 'const t = clipboard.readText();' },
      { rel: 'main/clipboardWatch.ts', code: "log.info('checked', text);\nconsole.log(clip);" },
    ];
    expect(offenders(RICH_CLIPBOARD_READ, () => false, synthetic)).toHaveLength(3);
    expect(offenders(TEXT_CLIPBOARD_READ, (rel) => rel.startsWith('main/'), synthetic)).toEqual(['renderer/y.ts:1: clipboard.readText(']);
    expect(offenders(TEXT_LOGGED, () => false, synthetic)).toHaveLength(2);

    // The allowlist sees the text however it is passed: nested in a call, in a template, as a shorthand key.
    const leaky: SourceFile = {
      rel: 'main/liveCheck.ts',
      code: [
        "log.warn('read failed', { error: errorName(err) });",
        "log.warn('x', clip(copied, 40));",
        'deps.log.info(`checked ${itemText} (${what})`);',
        "log.debug('y', { text });",
        "log.error('the text was not logged', { error: errorName(err) });",
      ].join('\n'),
    };
    const flagged = logCalls(leaky).map((c) => identifiersIn(c.args).filter((id) => !LOG_ARGS_ALLOWED.has(id)));
    expect(flagged).toEqual([[], ['clip', 'copied'], ['itemText'], ['text'], []]);
    // Strings and brackets: a message with parentheses or quotes in it does not end the call early.
    expect(logCalls({ rel: 'a.ts', code: "log.warn('a (b', `c ${d(e)} ')`, f);" })[0]!.args).toBe("'a (b', `c ${d(e)} ')`, f");
    expect(identifiersIn("'a (b', `c ${d(e)} ')`, f")).toEqual(['d', 'e', 'f']);
    // A second Electron read, or a reader called outside the two places, is caught.
    const extraRead: SourceFile = { rel: 'main/liveCheck.ts', code: 'async function other() { await deps.readText(); }' };
    expect(offenders(READER_CALL, () => false, [extraRead])).toHaveLength(1);
    const sample = 'async function checkForHotkey() { a(); } other();';
    const [a, b] = blockAfter(sample, 'async function checkForHotkey(');
    expect(sample.slice(a, b + 1)).toBe('{ a(); }');
  });
});
