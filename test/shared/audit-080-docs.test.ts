// 0.8 integration: the docs describe the round that shipped. ARCHITECTURE's "0.8 round" section names every shipped
// id and the new settings keys, its test lists name files that exist, the README has the round's release notes, and
// no build marker is left behind. In the style of audit-074-docs-consistency.test.ts (which still pins the installer
// path, the ownership table and the README's counted phrases).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCRAPTF_TIMING_GAP_SLACK } from '../../src/shared/scraptfHistory';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const README = read('README.md');
const ARCH = read('docs/ARCHITECTURE.md');
// 0.9: the 0.8 round ends where the 0.9 round starts (before 0.9, at the conventions).
const ROUND_END = ARCH.indexOf('## 0.9 round') > 0 ? ARCH.indexOf('## 0.9 round') : ARCH.indexOf('## Conventions');
const ROUND = ARCH.slice(ARCH.indexOf('## 0.8 round'), ROUND_END);

/** The README's `## <title>` section, without its heading line. */
function section(doc: string, title: string): string {
  const parts = doc.split(/\r?\n## /);
  const hit = parts.find((p) => p.startsWith(`${title}\n`) || p.startsWith(`${title}\r\n`));
  expect(hit, `section "${title}"`).toBeDefined();
  return hit!;
}

/**
 * Every id the text names: single ids (`T3`, `LC-7`) and ranges with one prefix (`J1-J6`, `T1–T7`, `LC-3–LC-6`),
 * expanded, so a range counts for each id inside it.
 */
function namedIds(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z]{1,2})(-?)(\d+)\s*[-–]\s*\1\2(\d+)\b/g)) {
    const [, prefix, dash, from, to] = m;
    for (let i = Number(from); i <= Number(to); i++) out.add(`${prefix}${dash}${i}`);
  }
  for (const m of text.matchAll(/\b([A-Z]{1,2}-?\d+)\b/g)) out.add(m[1]!);
  return out;
}

/** The ids 0.8 shipped (plan scope: LC-1/LC-2, T8-T10, G6-G9, H9 and PC-3 to PC-7 as a feature are not built). */
const SHIPPED = [
  'PC-1',
  'PC-2',
  'H2',
  ...['J1', 'J2', 'J3', 'J4', 'J5', 'J6'],
  'H5',
  ...['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'],
  ...['LC-3', 'LC-4', 'LC-5', 'LC-6', 'LC-7'],
  ...['G1', 'G2', 'G3', 'G4', 'G5'],
  ...['H1', 'H3', 'H4', 'H6', 'H7', 'H8'],
  'V15',
];

describe('ARCHITECTURE 0.8 round summary', () => {
  it('exists, ends before the conventions, and names every shipped id', () => {
    expect(ARCH.indexOf('## 0.8 round')).toBeGreaterThan(0);
    expect(ARCH.indexOf('## Conventions')).toBeGreaterThan(ARCH.indexOf('## 0.8 round'));
    const named = namedIds(ROUND);
    for (const id of SHIPPED) expect(named.has(id), id).toBe(true);
  });

  it('expands ranges for the id check, and only ranges with one prefix', () => {
    expect([...namedIds('(T1–T7, LC-3–LC-6)')]).toEqual(expect.arrayContaining(['T5', 'LC-4']));
    expect(namedIds('J1-J6').has('J4')).toBe(true);
    expect(namedIds('T1-G3').has('T2')).toBe(false);
  });

  it('names the four new settings keys', () => {
    for (const key of ['profit.exitReservePct', 'notifications.watches', 'notifications.buyTiming', 'ownSteamIds']) expect(ROUND, key).toContain(`\`${key}\``);
  });

  it("states the round's boundary: no new request kind, no openUrl but a bank page's, nothing traded", () => {
    expect(ROUND).toMatch(/\*\*Boundary unchanged\*\* \(R1-R10\): no request kind, host, endpoint, budget or cadence was added or raised\./);
    // Watched items join every reader of core.watchedSet(), the 30-min PriceDB bulk refresh too (not only the snapshot job).
    expect(ROUND).toMatch(/`pricedb-watched` bulk\s+refresh includes them too \(100\s+bases per request\), so watches do send more PriceDB requests: up to 2 more bulk requests per 30-min run at the cap of\s+200 watches/);
    expect(ROUND).not.toMatch(/watched items only join\s+the snapshot/);
    // Review: watches add up to 2 PriceDB requests per run, so the round never claims no higher rate toward any site.
    expect(ROUND).not.toMatch(/no higher\s+rate/);
    expect(ROUND).toMatch(/no `openUrl` beyond an exact SCRAPTF_BANKS page \(summaries carry `openBankStock`, an in-app route\)/);
    expect(ROUND).toMatch(/nothing is bought, queued, listed or traded \(R4\)/);
  });

  it('has a subsection per package, and every test file it names by path exists', () => {
    for (const h of ['### Schema V15 and contracts (Foundation)', '### Profit:', '### Journal:', '### Cycles:', '### Holdings:', '### Alerts:', '### Tests and version']) {
      expect(ROUND, h).toContain(h);
    }
    const paths = [...new Set([...ROUND.matchAll(/`(test\/[\w/.-]+\.test\.ts)`/g)].map((m) => m[1]!))];
    expect(paths.length).toBeGreaterThan(40);
    for (const p of paths) expect(existsSync(join(root, p)), p).toBe(true);
    expect(paths).toContain('test/shared/audit-080-docs.test.ts');
  });

  it('states its own version (0.8.0; package.json moved on in 0.9)', () => {
    const tests = ROUND.slice(ROUND.indexOf('### Tests and version'));
    expect(tests).toContain('**Version.** 0.8.0');
  });

  it('keeps no build marker (the waves wrote under markers; integration removed them)', () => {
    expect(ROUND).not.toContain('<!-- 0.8');
    expect(ARCH).not.toContain('<!-- 0.8');
    expect(read('test/compliance/static.test.ts')).not.toMatch(/0\.8 \w+ \(Wave \d\): add files below this line/);
  });
});

describe('the scrap.tf gap limit is stated as the code applies it (review)', () => {
  /** Every source file under src/, relative to the root. */
  function sources(): string[] {
    return (readdirSync(join(root, 'src'), { recursive: true }) as string[])
      .map((p) => `src/${p.replace(/\\/g, '/')}`)
      .filter((p) => /\.(ts|tsx)$/.test(p));
  }

  it('every "<slack> x its usual longest gap" names SCRAPTF_TIMING_GAP_SLACK or its value', () => {
    const hits: { file: string; slack: string }[] = [];
    for (const file of [...sources(), 'docs/ARCHITECTURE.md', 'README.md']) {
      // Comments and Markdown wrap: join the lines, dropping comment and list prefixes.
      const text = read(file).replace(/\s*\r?\n\s*(?:\*(?!\*)|\/\/)?\s*/g, ' ');
      // A figure or a constant's name before "x"/"times" ("this many times" in the constant's own doc is neither).
      for (const m of text.matchAll(/(\d+(?:\.\d+)?|[A-Z][A-Z0-9_]+)\s*(?:x|×|times)\s+its usual longest gap/g)) hits.push({ file, slack: m[1]! });
    }
    // The constant's doc, the timing header, ScraptfListingRun.cutAt, scraptfGapLimitMs and ARCHITECTURE at least.
    expect(hits.length).toBeGreaterThanOrEqual(4);
    for (const h of hits) expect([String(SCRAPTF_TIMING_GAP_SLACK), 'SCRAPTF_TIMING_GAP_SLACK'], `${h.file}: ${h.slack}`).toContain(h.slack);
    expect(SCRAPTF_TIMING_GAP_SLACK).toBe(1.25);
  });
});

describe('README 0.8 release notes', () => {
  it('has "New in 0.8" before "New in 0.7.4", with the boundary in its intro', () => {
    const notes = section(README, 'New in 0.8');
    expect(README.indexOf('## New in 0.8')).toBeLessThan(README.indexOf('## New in 0.7.4'));
    expect(notes).toMatch(/Flip Desk still never loads scrap\.tf on its own/);
    expect(notes).toMatch(/Nothing is bought, queued, listed or traded for you/);
    // Current text for audit-074-docs-consistency's counted phrases: the 0.8 notes add none of them.
    expect(notes).not.toContain('seen in the last day');
  });

  it('says buy timing is an estimate and the new toasts are what the code sends', () => {
    const notes = section(README, 'New in 0.8');
    expect(notes).toMatch(/never a forecast/);
    for (const t of ['*Cheaper on scrap.tf*', '*Back on scrap.tf*', '*Buy now*', '*Watched*', '*Clears target*', '*Below target*']) expect(notes, t).toContain(t);
    expect(read('src/shared/bankStockNotify.ts')).toMatch(/title: `Cheaper on scrap\.tf \(\$\{label\}\): \$\{r\.name\}`/);
    expect(read('src/shared/bankStockNotify.ts')).toMatch(/title: `Back on scrap\.tf \(\$\{label\}\): \$\{r\.name\}`/);
    expect(read('src/shared/bankStockNotify.ts')).toMatch(/title: `Buy now \(\$\{label\}\): \$\{r\.name\}`/);
  });

  it('lists the three 0.8 known limits', () => {
    const limits = section(README, 'Known limits');
    expect(limits).toContain('Buy timing and turnover are estimates from your own saves (sample sizes shown)');
    expect(limits).toContain('a reserved-only copy still counts as stock and a reservation can look like a sale');
    expect(limits).toContain('Exit prices are recorded only while Flip Desk runs with the live feed on.');
  });
});
