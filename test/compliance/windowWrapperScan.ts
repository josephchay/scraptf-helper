// The source helpers the compliance scans share, and the dashboard's scrap.tf window scans (F21, R1): a window
// move, read or clear, an open worded for the window or a Show flips happens on a click, never in an effect, a
// push listener, a timer or a promise callback. A module, not a test file: static.test.ts and the audit tests
// both import it (a *.test.ts imported elsewhere would register its suites twice).

import { readdirSync } from 'node:fs';
import path from 'node:path';

export function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    // Style sheets too: a CSS url() or @import is a request from the dashboard.
    else if (/\.(ts|tsx|js|mjs|cjs|html|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Blanks block comments, keeping line numbers. */
export function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Blanks block and line comments (keeping line numbers); `://` inside strings is left alone. */
export function stripComments(src: string): string {
  return stripBlockComments(src)
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\/])\/\/.*$/, '$1'))
    .join('\n');
}

export interface SourceFile {
  rel: string;
  code: string;
}

/**
 * A file as the scans read it. CSS has no line comments, and the `//` stripper would blank a
 * protocol-relative `url(//host/...)` (the `//` follows a "("), so style sheets lose block comments only.
 */
export function sourceFile(rel: string, src: string): SourceFile {
  return { rel, code: rel.endsWith('.css') ? stripBlockComments(src) : stripComments(src) };
}

/** The text of a call's argument list from the "(" at `open` to its matching ")"; quotes are skipped. */
export function callArgs(code: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  const end = Math.min(code.length, open + 4000);
  for (let i = open; i < end; i++) {
    const c = code[i]!;
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return code.slice(open + 1, i);
  }
  return code.slice(open + 1, end);
}

/** Where the "{" at `open` is closed (quotes skipped), or the end of `code`. */
export function blockEnd(code: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return code.length;
}

export interface Span {
  name: string;
  start: number;
  end: number;
}

/** Every `function name(…) {…}` body in `code`. */
export function functionSpans(code: string): Span[] {
  const out: Span[] = [];
  for (const m of code.matchAll(/\bfunction\s+([\w$]+)\s*(?:<[^>]*>)?\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const brace = code.indexOf('{', open + callArgs(code, open).length + 2);
    if (brace < 0) continue;
    out.push({ name: m[1]!, start: brace, end: blockEnd(code, brace) });
  }
  return out;
}

/** The innermost function body holding `at`, or null at the top level. */
export function enclosing(spans: readonly Span[], at: number): Span | null {
  let best: Span | null = null;
  for (const s of spans) if (at > s.start && at < s.end && (best === null || s.start > best.start)) best = s;
  return best;
}

/**
 * Calls whose arguments run later or on someone else's schedule: listeners, promise callbacks, timers, React effects.
 * 0.7.3: useVisiblePush too (usePush plus a catch-up effect), and useRpcQuery, which calls its method in an effect
 * on mount and on every params change.
 */
export const DEFERRED_CALL =
  /(?:\.\s*(?:on|once|addListener|prependListener|prependOnceListener|then|catch|finally)|(?<![\w$.])(?:on|usePush|useVisiblePush|useRpcQuery|useEffect|useLayoutEffect|useInterval|useThrottled|useNow)|(?<![\w$])(?:[\w$]+\s*\.\s*)?(?:setTimeout|setInterval|setImmediate|queueMicrotask|requestIdleCallback|requestAnimationFrame))\s*\(/g;

/** The argument spans of every deferred call in `code`. */
export function deferredSpans(code: string): Span[] {
  return [...code.matchAll(DEFERRED_CALL)].map((m) => {
    const open = m.index + m[0].length - 1;
    return { name: m[0], start: open, end: open + callArgs(code, open).length + 1 };
  });
}

export const lineAt = (code: string, at: number) => code.slice(0, at).split('\n').length;

/** A dashboard call that moves, reads or clears the window: main's method name, quoted. */
export const WINDOW_METHOD = /'scraptfWindow\.(?:open|back|forward|reload|home|go|read|clear)'/g;
/** Before a push name ('scraptfWindow.read' is a push too): it only subscribes and calls nothing. */
export const PUSH_NAME_BEFORE = /(?:use(?:Visible)?Push|(?<![\w$.])on)\s*\(\s*$/;
/** 0.7.3: how far before a method name PUSH_NAME_BEFORE looks; "useVisiblePush(" alone is 15 characters. */
const PUSH_LOOKBACK = 24;

/** Dashboard lines that move, read or clear the window outside a click: in an effect, a push listener or a timer. */
export function deferredWindowCalls(files: readonly SourceFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const later = deferredSpans(f.code);
    for (const m of f.code.matchAll(WINDOW_METHOD)) {
      if (PUSH_NAME_BEFORE.test(f.code.slice(Math.max(0, m.index - PUSH_LOOKBACK), m.index))) continue;
      if (later.some((s) => m.index > s.start && m.index < s.end)) out.push(`${f.rel}:${lineAt(f.code, m.index)}: ${m[0]}`);
    }
  }
  return out;
}

/**
 * 0.7.1 (F21-8): what else opens the window or shows the dashboard from a page: an open worded for the window
 * (an `allowWindow` key, openOrCopy and openLink included), openOnScraptf (it always asks for the window) and
 * the toolbar's Show flips ('app.showBankStock'). Each sits in a click or key handler, never in an effect, a
 * push listener, a timer or a promise callback.
 */
export const DEFERRED_WINDOW_OPEN = /\ballowWindow\b|(?<![\w$.])openOnScraptf\s*\(|'app\.showBankStock'/g;

export function deferredWindowOpens(files: readonly SourceFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const later = deferredSpans(f.code);
    for (const m of f.code.matchAll(DEFERRED_WINDOW_OPEN)) {
      if (later.some((s) => m.index > s.start && m.index < s.end)) out.push(`${f.rel}:${lineAt(f.code, m.index)}: ${m[0]}`);
    }
  }
  return out;
}

/** Where the statement from `from` ends: its `;` outside brackets, the bracket closing its block, or the end of `code`. */
function statementEnd(code: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < code.length; i++) {
    const c = code[i]!;
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth--;
    } else if (c === ';' && depth === 0) return i;
  }
  return code.length;
}

interface Binding extends Span {
  /** The function body its name is declared in (null: the file), where its uses are looked for. */
  scope: Span | null;
  /** A function, a hook's callback or a literal map: it holds a call for later instead of making it. */
  wraps: boolean;
}

const DECLARATION = /\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=;]+)?=(?![=>])\s*/g;

/** True when the initialiser at `at` is a function, useCallback/useMemo, or an object or array literal. */
function wrapsAt(code: string, at: number): boolean {
  const head = code.slice(at, at + 200);
  if (/^(?:async\s+)?function\b|^use(?:Callback|Memo)\s*\(|^[{[]|^(?:async\s+)?[\w$]+\s*=>/.test(head)) return true;
  const open = /^(?:async\s*)?\(/.exec(head);
  if (!open) return false;
  const close = at + open[0].length + callArgs(code, at + open[0].length - 1).length;
  return /^\s*(?::[^=;{}()]+)?=>/.test(code.slice(close + 1, close + 200));
}

/** Every `function` declaration and `const`/`let`/`var` name in `code`, with what it spans. */
function bindings(code: string): Binding[] {
  const fns = functionSpans(code);
  const out: Binding[] = fns.map((s) => ({ ...s, scope: enclosing(fns, s.start), wraps: true }));
  for (const m of code.matchAll(DECLARATION)) {
    const init = m.index + m[0].length;
    out.push({ name: m[1]!, start: m.index, end: statementEnd(code, init), scope: enclosing(fns, m.index), wraps: wrapsAt(code, init) });
  }
  return out;
}

export interface WrapperScan {
  /** `file:name` of every function, hook callback or literal map holding such a call, directly or through another. */
  holders: string[];
  /** `file:line: name` for every use of one in an effect, a push listener, a timer or a promise callback. */
  hits: string[];
}

/**
 * 0.7.3: the calls above sit in local wrappers (the toolbar's NAV_METHODS, act, readNow…, a page's
 * openInWindow), so the literal is never in the deferred span itself. Each function, hook callback or literal
 * map holding one is a holder, and so is whatever holds a use of a holder, in its scope. A use in a deferred
 * span is a hit. Not a use: the declaration, a JSX tag or attribute name, an object key or parameter, an
 * assignment, and a name in an effect's dependency list. A wrapper handed to a child as a prop is not followed
 * into the child (the mounted tests cover those).
 */
export function windowWrappers(files: readonly SourceFile[]): WrapperScan {
  const holders: string[] = [];
  const hits: string[] = [];
  for (const f of files) {
    const code = f.code;
    const later = deferredSpans(code);
    const all = bindings(code);
    const queue: Binding[] = [];
    const found: { at: number; text: string }[] = [];
    const hold = (at: number) => {
      let best: Binding | null = null;
      for (const b of all) if (b.wraps && at >= b.start && at < b.end && (best === null || b.start > best.start)) best = b;
      if (best !== null && !queue.includes(best)) queue.push(best);
    };
    for (const m of code.matchAll(WINDOW_METHOD)) if (!PUSH_NAME_BEFORE.test(code.slice(Math.max(0, m.index - PUSH_LOOKBACK), m.index))) hold(m.index);
    for (const m of code.matchAll(DEFERRED_WINDOW_OPEN)) hold(m.index);
    for (let i = 0; i < queue.length; i++) {
      const b = queue[i]!;
      holders.push(`${f.rel}:${b.name}`);
      const from = b.scope?.start ?? 0;
      const to = b.scope?.end ?? code.length;
      for (const m of code.matchAll(new RegExp(`(?<![\\w$.])${b.name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'))) {
        const at = m.index;
        if (at < from || at > to || (at >= b.start && at < b.end)) continue;
        const before = code.slice(Math.max(0, at - 20), at);
        const after = code.slice(at + m[0].length, at + m[0].length + 20);
        if (/\b(?:const|let|var|function)\s+$|<\/?\s*$/.test(before) || /^\s*=(?![=>])/.test(after)) continue;
        if (/[{,(]\s*$/.test(before) && /^\s*\??:(?!:)/.test(after)) continue;
        let span: Span | null = null;
        for (const s of later) if (at > s.start && at < s.end && (span === null || s.start > span.start)) span = s;
        if (span === null) hold(at);
        else if (!/^[\w$]+[\w$.?!,\s]*\]\s*$/.test(code.slice(at, span.end))) found.push({ at, text: `${f.rel}:${lineAt(code, at)}: ${b.name}` });
      }
    }
    hits.push(...found.sort((a, b) => a.at - b.at).map((h) => h.text));
  }
  return { holders, hits };
}

export const deferredWindowWrappers = (files: readonly SourceFile[]): string[] => windowWrappers(files).hits;
