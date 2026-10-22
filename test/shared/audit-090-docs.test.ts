// 0.9 integration: the docs describe the round that shipped. ARCHITECTURE's "0.9 round" section names every shipped
// RESEARCH rank, V16 and the new settings keys, states the boundary, its test lists name files that exist, the README
// has the round's release notes and the research report in its Documentation list, and no build marker is left
// behind. In the style of audit-080-docs.test.ts (which keeps the 0.8 round's own checks, D15) and
// audit-074-docs-consistency.test.ts (the installer path, the ownership table and the README's counted phrases).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const README = read('README.md');
const ARCH = read('docs/ARCHITECTURE.md');
const ROUND = ARCH.slice(ARCH.indexOf('## 0.9 round'), ARCH.indexOf('## Conventions'));

/** The README's `## <title>` section, without its heading line. */
function section(doc: string, title: string): string {
  const parts = doc.split(/\r?\n## /);
  const hit = parts.find((p) => p.startsWith(`${title}\n`) || p.startsWith(`${title}\r\n`));
  expect(hit, `section "${title}"`).toBeDefined();
  return hit!;
}

/** Every RESEARCH rank the text names as `#<n>` (a heading anchor like `#/market` is no rank). */
function namedRanks(text: string): Set<number> {
  return new Set([...text.matchAll(/#(\d+)\b/g)].map((m) => Number(m[1])));
}

/** The RESEARCH.md §8 ranks 0.9 shipped (plan A.1; #4, #5, #8, #15, #16, #18-#21, #23, #24, #26-#28 are out of scope). */
const SHIPPED_RANKS = [1, 2, 3, 6, 7, 9, 10, 11, 12, 13, 14, 17, 22, 25];

/** One subsection per package, Foundation's and the integration's "Tests and version" included. */
const SUBSECTIONS = [
  '### Schema V16 and contracts (Foundation)',
  '### Exits:',
  '### scrap.tf:',
  '### Holdings and ledger:',
  '### Ranking:',
  '### History:',
  '### Timing:',
  '### Docs:',
  '### Tests and version',
];

describe('ARCHITECTURE 0.9 round summary', () => {
  it('exists, ends before the conventions, and names every shipped RESEARCH rank and V16', () => {
    expect(ARCH.indexOf('## 0.9 round')).toBeGreaterThan(ARCH.indexOf('## 0.8 round'));
    expect(ARCH.indexOf('## Conventions')).toBeGreaterThan(ARCH.indexOf('## 0.9 round'));
    const named = namedRanks(ROUND);
    for (const n of SHIPPED_RANKS) expect(named.has(n), `#${n}`).toBe(true);
    expect(ROUND).toMatch(/\bV16\b/);
  });

  it('reads ranks as #<n> only', () => {
    expect([...namedRanks('(#2, #11, #14)')]).toEqual([2, 11, 14]);
    expect(namedRanks('`#/market/flips`').size).toBe(0);
  });

  it('names the three new settings keys', () => {
    for (const key of ['profit.marketplaceFeePct', 'notifications.minProfitableDepth', 'tradeLock']) expect(ROUND, key).toContain(`\`${key}\``);
  });

  it("states the round's boundary: nothing added, no budget raised, nothing traded", () => {
    expect(ROUND).toMatch(
      /\*\*Boundary unchanged\*\* \(R1-R10\): no request kind, host, endpoint, credential or cadence was added, and no budget was\s+raised/,
    );
    expect(ROUND).toMatch(/no `openUrl` beyond an exact SCRAPTF_BANKS page/);
    expect(ROUND).toMatch(/nothing is\s+bought, queued, listed or traded \(R4\)/);
    // The Steam Market gained a daily cap: the round never claims "no higher rate" for a budget it did not raise.
    expect(ROUND).not.toMatch(/no higher\s+rate/);
  });

  it('has a subsection per package, and every test file it names by path exists', () => {
    for (const h of SUBSECTIONS) expect(ROUND, h).toContain(h);
    const paths = [...new Set([...ROUND.matchAll(/`(test\/[\w/.-]+\.test\.ts)`/g)].map((m) => m[1]!))];
    expect(paths.length).toBeGreaterThan(50);
    for (const p of paths) expect(existsSync(join(root, p)), p).toBe(true);
    expect(paths).toContain('test/shared/audit-090-docs.test.ts');
  });

  it("gives package.json's version", () => {
    const version = (JSON.parse(read('package.json')) as { version: string }).version;
    expect(version).toBe('0.9.0');
    const tests = ROUND.slice(ROUND.indexOf('### Tests and version'));
    expect(tests).toContain(`**Version.** ${version}`);
  });

  it('keeps no build marker (the waves wrote under markers; integration removed them)', () => {
    expect(ARCH).not.toContain('<!-- 0.9');
    expect(read('test/compliance/static.test.ts')).not.toMatch(/0\.9 [\w-]+ \(Wave \d\): add (?:files|describes) below this line/);
  });
});

describe('README 0.9 release notes', () => {
  it('has "New in 0.9" before "New in 0.8", with the boundary in its intro', () => {
    const notes = section(README, 'New in 0.9');
    expect(README.indexOf('## New in 0.9')).toBeLessThan(README.indexOf('## New in 0.8'));
    expect(notes).toMatch(/Flip Desk still never loads scrap\.tf on its own/);
    expect(notes).toMatch(/Nothing is bought, queued, listed or traded for you/);
    // Current text for audit-074-docs-consistency's counted phrases: the 0.9 notes add none of them.
    expect(notes).not.toContain('seen in the last day');
    expect(notes).not.toContain('half the cards');
    expect(notes).not.toMatch(/background snapshots check those/);
  });

  it('says what the new figures are not: a forecast, sales or a fill rate', () => {
    const notes = section(README, 'New in 0.9');
    expect(notes).toMatch(/never a forecast that a buyer pays it/);
    expect(notes).toMatch(/Buy orders show demand, not sales/);
    expect(notes).toMatch(/order persistence, not sales/i);
    expect(notes).toMatch(/\*\*One-time effects after upgrading:\*\*/);
  });

  it('names docs/RESEARCH.md in the Documentation list, and the file exists', () => {
    const docs = README.slice(README.indexOf('**Documentation:**'), README.indexOf('## Known limits'));
    expect(docs).toMatch(/^- `docs\/RESEARCH\.md`: /m);
    expect(existsSync(join(root, 'docs/RESEARCH.md'))).toBe(true);
  });

  it('lists the 0.9 known limits', () => {
    const limits = section(README, 'Known limits');
    for (const t of [
      'Trade lock is your answer (0.9).',
      'An order that is never bumped or edited while the feed runs is not followed',
      'The suggested reserve knows only what Flip Desk saw (0.9).',
      'The risk keys have no table column (0.9).',
      "Buy timing's ranges cover chance between items only (0.9).",
      "scrap.tf's price-drop, countdown and not-trading wording is unconfirmed (0.9).",
      'Each fee is at least $0.01',
    ]) {
      expect(limits, t).toContain(t);
    }
  });
});
