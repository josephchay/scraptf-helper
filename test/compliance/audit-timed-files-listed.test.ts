// Audit r4-tests-2 (0.7.3): a test file that bounds wall-clock time must be in vitest.config.ts's TIMED
// group, which runs one file at a time after the others, or a saturated CPU decides its result
// (test/import/audit-parser-depth.test.ts was missed once). A static scan of every file vitest runs: an
// elapsed time is a clock read, or a name holding one, minus a start that was itself a bare clock read
// (`performance.now() - t0`, `t1 - t0`; `Date.now() - DAY` is a time, not an elapsed one), followed
// through the names it is stored in, returned under or computed from; a bound is an expect() of one, or
// of the subtraction itself, ending in toBeLessThan / toBeLessThanOrEqual. Every listed file must still hold one, so the scan
// keeps recognising each pattern the timed files use.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blockEnd, callArgs, enclosing, functionSpans, lineAt, sourceFile, walk, type Span } from './windowWrapperScan';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');
/** This file: its examples below are elapsed-time bounds by design. */
const SELF = rel(fileURLToPath(import.meta.url));

const CLOCK = String.raw`(?:performance|Date)\s*\.\s*now\s*\(\s*\)`;
/** `t0 = performance.now()` with nothing else in the value: the start of a measurement. */
const START = new RegExp(String.raw`([\w$]+)\s*(?::\s*number\s*)?(?<![=!<>])=(?![=>])\s*${CLOCK}(?=\s*[;,)\n])`, 'g');
/** A clock read minus a name: an elapsed time when the name is a start. */
const DELTA = new RegExp(String.raw`${CLOCK}\s*-\s*([\w$]+)(?![\w$])`, 'g');
/** A name minus a name (`t1 - t0`): an elapsed time when both are starts (bare clock reads). */
const PAIR = /(?<![\w$.])([\w$]+)\s*-\s*([\w$]+)(?![\w$])/g;
/** `name = …` (a typed declaration too) and `name.push(…)`; KEY: `name: …` (an object key). */
const ASSIGN = /([\w$]+)\s*(?::\s*[\w$.<>[\]|, ]+?)?\s*(?:(?<![=!<>])=(?![=>])|\.\s*push\s*\()/g;
const KEY = /([\w$]+)\s*:(?!:)/g;
const BOUND = /^\s*\.\s*toBeLessThan(?:OrEqual)?\s*\(/;

const mentions = (text: string, name: string) => new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(text);

/** `const name = (…) => {…}` bodies, as functionSpans reads `function name(…) {…}`. */
function arrowSpans(code: string): Span[] {
  const out: Span[] = [];
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = open + callArgs(code, open).length + 1;
    // The arrow on the same line as the parameters' end (a return type may sit between them).
    const arrow = /^[^\n]*?=>\s*\{/.exec(code.slice(close + 1));
    if (!arrow) continue;
    const brace = close + arrow[0].length;
    out.push({ name: m[1]!, start: brace, end: blockEnd(code, brace) });
  }
  return out;
}

/** The lines of `code` (comments already blanked) that bound an elapsed wall-clock time from above. */
function wallClockBounds(code: string): number[] {
  const starts = new Set([...code.matchAll(START)].map((m) => m[1]!));
  const elapsed = (text: string) => [
    ...[...text.matchAll(DELTA)].filter((m) => starts.has(m[1]!)),
    ...[...text.matchAll(PAIR)].filter((m) => starts.has(m[1]!) && starts.has(m[2]!)),
  ];
  const deltas = elapsed(code);
  if (deltas.length === 0) return [];
  const isDelta = (text: string) => elapsed(text).length > 0;
  // Where each elapsed time goes: the name it is assigned to or stored under, or the function returning it.
  const names = new Set<string>();
  const spans = [...functionSpans(code), ...arrowSpans(code)];
  for (const d of deltas) {
    const before = code.slice(code.lastIndexOf('\n', d.index) + 1, d.index);
    const assigned = [...before.matchAll(ASSIGN)].at(-1)?.[1];
    const key = [...before.matchAll(KEY)].at(-1)?.[1];
    if (assigned) names.add(assigned);
    if (key) names.add(key);
    if (!assigned && !key && /\breturn\b/.test(before)) {
      const fn = enclosing(spans, d.index);
      if (fn) names.add(fn.name);
    }
  }
  // ...and every value computed from one of those (`const took = ms(() => …)`, `runs.push(r.ms)`).
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of code.matchAll(new RegExp(`${ASSIGN.source}([^;\\n]*)`, 'g'))) {
      if (names.has(m[1]!) || ![...names].some((n) => mentions(m[2]!, n))) continue;
      names.add(m[1]!);
      grew = true;
    }
  }
  const lines: number[] = [];
  for (const m of code.matchAll(/(?<![\w$.])expect\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const arg = callArgs(code, open);
    if (!BOUND.test(code.slice(open + arg.length + 2, open + arg.length + 80))) continue;
    if (isDelta(arg) || [...names].some((n) => mentions(arg, n))) lines.push(lineAt(code, m.index));
  }
  return lines;
}

/** The TIMED list of vitest.config.ts, as written (comments blanked). */
function timedList(): string[] {
  const cfg = sourceFile('vitest.config.ts', readFileSync(path.join(ROOT, 'vitest.config.ts'), 'utf8')).code;
  const list = /\bconst\s+TIMED\s*=\s*\[([\s\S]*?)\]/.exec(cfg);
  expect(list, 'vitest.config.ts declares `const TIMED = [...]`').not.toBeNull();
  return [...list![1]!.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]!);
}

/** Every test file vitest runs (its ALL globs: test/**, src/**), by its path from the repo root. */
function testFiles(): { rel: string; code: string }[] {
  return [...walk(path.join(ROOT, 'test')), ...walk(path.join(ROOT, 'src'))]
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => sourceFile(rel(f), readFileSync(f, 'utf8')))
    .filter((f) => f.rel !== SELF);
}

const scan = (src: string) => wallClockBounds(sourceFile('x.test.ts', src).code);

describe('the elapsed-time scan', () => {
  it('finds a bound on the subtraction, a stored delta, a helper returning one, a returned key and an array of them', () => {
    expect(scan('const t = performance.now();\nrun();\nexpect(performance.now() - t).toBeLessThan(100);\n')).toEqual([3]);
    expect(scan('const t0 = Date.now();\nrun();\nconst ms: number = Date.now() - t0;\nexpect(ms).toBeLessThanOrEqual(50);\n')).toEqual([4]);
    expect(
      scan('function took(fn: () => void): number {\n  const t = performance.now();\n  fn();\n  return performance.now() - t;\n}\nconst ms = took(run);\nexpect(ms).toBeLessThan(10);\n'),
    ).toEqual([7]);
    expect(
      scan('const timed = (fn) => {\n  const t = performance.now();\n  const value = fn();\n  return { ms: performance.now() - t, value };\n};\nconst { ms } = timed(run);\nexpect(ms).toBeLessThan(500);\n'),
    ).toEqual([7]);
    expect(
      scan('const took = (fn) => {\n  const t = performance.now();\n  fn();\n  return performance.now() - t;\n};\nconst runs = [1, 2].map(() => took(run));\nexpect(Math.min(...runs)).toBeLessThan(5);\n'),
    ).toEqual([7]);
    expect(scan('const runs: number[] = [];\nconst t = Date.now();\nrun();\nruns.push(Date.now() - t);\nexpect(Math.max(...runs)).toBeLessThan(5);\n')).toEqual([5]);
  });

  it('finds a start subtracted from a later clock read kept in a name (`t1 - t0`), bound directly or stored', () => {
    expect(scan('const t0 = performance.now();\nrun();\nconst t1 = performance.now();\nexpect(t1 - t0).toBeLessThan(100);\n')).toEqual([4]);
    expect(scan('const before = Date.now();\nrun();\nconst after = Date.now();\nconst took = after - before;\nexpect(took).toBeLessThan(5);\n')).toEqual([5]);
    // A fixed deadline minus a start is a time left, not an elapsed one.
    expect(scan('const t0 = Date.now();\nexpect(DEADLINE - t0).toBeLessThan(DAY);\nexpect(obj.t1 - t0).toBeLessThan(DAY);\n')).toEqual([]);
  });

  it('ignores a time ago, an elapsed time only logged, a lower bound and commented-out code', () => {
    expect(scan('const since = Date.now() - 60_000;\nexpect(rows.length).toBeLessThan(3);\nexpect(since).toBeLessThan(Date.now());\n')).toEqual([]);
    expect(scan('const t = performance.now();\nrun();\nconsole.info(performance.now() - t);\nexpect(rows.length).toBeLessThan(5);\n')).toEqual([]);
    expect(scan('const t = performance.now();\nrun();\nconst ms = performance.now() - t;\nexpect(ms).toBeGreaterThan(0);\nexpect(ms).not.toBeLessThan(0);\n')).toEqual([]);
    expect(scan('// const t = performance.now();\n/* expect(performance.now() - t).toBeLessThan(100); */\nexpect(1).toBeLessThan(2);\n')).toEqual([]);
  });
});

describe('vitest.config.ts TIMED', () => {
  it('lists every test file that bounds wall-clock time', () => {
    const timed = new Set(timedList());
    const missing = testFiles()
      .map((f) => ({ rel: f.rel, lines: wallClockBounds(f.code) }))
      .filter((f) => f.lines.length > 0 && !timed.has(f.rel))
      .map((f) => `${f.rel}:${f.lines.join(',')}`);
    expect(missing, 'add these to TIMED in vitest.config.ts (they assert wall-clock bounds)').toEqual([]);
  });

  it('lists only test files that exist and still bound wall-clock time', () => {
    const stale = timedList().filter((f) => !existsSync(path.join(ROOT, f)) || wallClockBounds(sourceFile(f, readFileSync(path.join(ROOT, f), 'utf8')).code).length === 0);
    expect(stale, 'missing from disk, or no elapsed-time bound the scan recognises').toEqual([]);
  });
});
