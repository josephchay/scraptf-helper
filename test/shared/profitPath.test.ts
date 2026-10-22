// 0.8 (PC-1): one buy-side profit path. A static scan of src/ (comments stripped) that keeps every buy
// decision on flipProfit (src/shared/ceiling.ts): friction is read and subtracted only there, and in the two
// sales into a live order that take friction only (holdingFigures, sellComparison; R-PC1-sell). A later wave
// that adds a flipProfit caller only extends FLIP_PROFIT_CALLERS.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceFile, walk, type SourceFile } from '../compliance/windowWrapperScan';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

const FILES: SourceFile[] = walk(SRC).map((f) => sourceFile(path.relative(SRC, f).split(path.sep).join('/'), readFileSync(f, 'utf8')));

/** Rule (1): the raw setting is read only by the profit path and the Settings page's field. */
const FRICTION_READ = /\.frictionScrap\b/;
const FRICTION_READERS: readonly string[] = ['shared/ceiling.ts', 'renderer/pages/SettingsPage.tsx'];

/**
 * Rule (2), D13: an operand, whitespace, then a minus before `friction` or `frictionOf(` (prettier's binary minus),
 * so `id="p-friction"` is not a subtraction.
 */
const FRICTION_SUBTRACT = /[\w$)\]]\s+-\s*(?:friction\b|frictionOf\s*\()/;
const FRICTION_SUBTRACTORS: readonly string[] = ['shared/ceiling.ts', 'shared/holdings.ts', 'renderer/recordTradeModel.ts'];

/** Rule (3): the buy decisions that must go through flipProfit (later waves only add to this list). */
const FLIP_PROFIT_CALLERS: readonly string[] = [
  'service/domain/engine.ts',
  'service/domain/liveCheck.ts',
  'shared/market.ts',
  'shared/bankStock.ts',
  'renderer/quickModel.ts',
  'renderer/mockData.ts',
  'renderer/mockCheck.ts',
  // 0.8 cycles (T3: evBuy / evWait) and holdings (H6: an exit nobody pays today).
  'shared/scraptfTiming.ts',
  'shared/holdingAdvice.ts',
];

/** `file:line: text` for every match of `re` in `files` outside `allowed`. */
function matches(re: RegExp, files: readonly SourceFile[], allowed: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (allowed.includes(f.rel)) continue;
    for (const m of f.code.matchAll(new RegExp(re.source, 'g'))) out.push(`${f.rel}:${f.code.slice(0, m.index).split('\n').length}: ${m[0]}`);
  }
  return out;
}

/** Every friction read or subtraction outside the profit path, by rules (1) and (2). */
function profitPathOffenders(files: readonly SourceFile[]): string[] {
  return [...matches(FRICTION_READ, files, FRICTION_READERS), ...matches(FRICTION_SUBTRACT, files, FRICTION_SUBTRACTORS)];
}

describe('0.8 (PC-1): one buy-side profit path', () => {
  it('reads the source tree', () => {
    expect(FILES.some((f) => f.rel === 'shared/ceiling.ts')).toBe(true);
    for (const rel of [...FRICTION_READERS, ...FRICTION_SUBTRACTORS, ...FLIP_PROFIT_CALLERS]) expect(FILES.some((f) => f.rel === rel), rel).toBe(true);
  });

  it('(1) reads profit.frictionScrap only in ceiling.ts and the Settings page', () => {
    expect(matches(FRICTION_READ, FILES, FRICTION_READERS)).toEqual([]);
  });

  it('(2) subtracts friction only in ceiling.ts and the two sales into a live order', () => {
    expect(matches(FRICTION_SUBTRACT, FILES, FRICTION_SUBTRACTORS)).toEqual([]);
  });

  it('(3) every buy decision calls flipProfit', () => {
    for (const rel of FLIP_PROFIT_CALLERS) expect(FILES.find((f) => f.rel === rel)!.code, rel).toContain('flipProfit(');
  });

  it('(4) the scans catch what they claim (D13: an id is not a subtraction)', () => {
    const one = (code: string): string[] => profitPathOffenders([sourceFile('renderer/Bad.tsx', code)]);
    expect(one('const p = r - c - nonNegative(p.frictionScrap);')).toHaveLength(1);
    expect(one('x = rev - cost - frictionOf(p)')).toHaveLength(1);
    expect(one('y = rev - cost - friction;')).toHaveLength(1);
    expect(one('const friction = frictionOf(p);')).toEqual([]);
    expect(one('<input id="p-friction" htmlFor="p-friction" />')).toEqual([]);
    // Comments are stripped before the scan.
    expect(one('// rev - cost - friction\nconst a = 1;')).toEqual([]);
    // The allowed files are allowed by path only.
    expect(profitPathOffenders([sourceFile('shared/ceiling.ts', 'y = rev - cost - frictionOf(p) - p.frictionScrap;')])).toEqual([]);
  });
});
