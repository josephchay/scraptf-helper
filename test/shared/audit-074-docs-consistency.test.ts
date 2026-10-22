// 0.7.4 review (R15, R33, R41, R43, R44, R45, R47): the README and ARCHITECTURE say what the code does. Each case
// reads the docs next to the code they describe, so a later change to one without the other fails here. History
// sections ("New in 0.7.3" and older) describe their own release and are left alone.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pickRevenueOrder } from '../../src/service/domain/pricing';
import { PARTIAL_READ_MAX_AGE_MS, PARTIAL_READ_MIN_KEYS, PARTIAL_READ_RATIO } from '../../src/shared/importCodes';
import { CONN_STATE_LABELS } from '../../src/renderer/format';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const README = read('README.md');
const ARCH = read('docs/ARCHITECTURE.md');

/** The README's `## <title>` section, without its heading line. */
function section(doc: string, title: string): string {
  const parts = doc.split(/\r?\n## /);
  const hit = parts.find((p) => p.startsWith(`${title}\n`) || p.startsWith(`${title}\r\n`));
  expect(hit, `section "${title}"`).toBeDefined();
  return hit!;
}

/** The README's current text: everything but the release notes of 0.7.3 and older. */
function currentReadme(): string {
  return README.split(/\r?\n## /)
    .filter((p) => !/^New in 0\.(?:[0-6]|7\.[0-3]|7)\b(?!\.4)/.test(p))
    .join('\n## ');
}

const lines = (text: string): string[] => text.split(/\r?\n/);

describe('README install path (review R41)', () => {
  it('names the installer of the version in package.json', () => {
    const version = (JSON.parse(read('package.json')) as { version: string }).version;
    const named = [...README.matchAll(/Setup (\d+\.\d+\.\d+)\.exe/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const v of named) expect(v).toBe(version);
  });
});

describe('README on old buy orders (reviews R15, R33, R45)', () => {
  it('names the Best exception wherever profit and Pay up to use the orders seen in the last day', () => {
    const hits = lines(currentReadme()).filter((l) => l.includes('seen in the last day'));
    expect(hits.length).toBe(2);
    for (const l of hits) {
      expect(l).toMatch(/Revenue used for profit\* (?:set to|=) \*Best\*/);
      expect(l).toMatch(/top order/);
    }
  });

  it("Best is the top order, as the README says (pickRevenueOrder), and the Settings tooltip says it can be old", () => {
    const best = { id: 'stale-top' };
    const cons = { id: 'fresh' };
    expect(pickRevenueOrder({ best, conservative: cons, instant: null }, 'best')).toBe(best);
    expect(pickRevenueOrder({ best, conservative: cons, instant: null }, 'conservative')).toBe(cons);
    expect(read('src/renderer/pages/SettingsPage.tsx')).toContain(
      "title: 'Highest eligible order, even if it looks like an outlier or was not seen for a day'",
    );
  });

  it('scopes the background snapshots to items priced or held with a token, and sends rule candidates to the feed', () => {
    const hits = lines(currentReadme()).filter((l) => /background snapshots check those/.test(l));
    expect(hits.length).toBe(2);
    for (const l of hits) {
      expect(l).toMatch(/price or hold with an access token saved/);
      expect(l).toMatch(/rule candidate/);
      expect(l).toMatch(/Refresh from backpack\.tf/);
    }
    // ARCHITECTURE's Snapshots text says the same (watched SKUs only; rule candidates are never watched).
    expect(ARCH).toMatch(/Rule candidates are never watched/);
  });

  it("names Holdings' Sell: and the New on scrap.tf toast among the notifications held back (reviews R39, R40)", () => {
    const l = lines(section(README, 'New in 0.7.4')).find((x) => x.startsWith('- **Old buy orders.**'))!;
    expect(l).toContain("Holdings' *Sell:*");
    expect(l).toContain('*New on scrap.tf*');
  });
});

describe('README partial looks (review R43)', () => {
  it('uses the code thresholds: half the cards for bank pages, about 90% of the rows for scrap.tf/items', () => {
    // The /items ratio is a private constant of the import handler; pin its source text.
    expect(read('src/service/rpcHandlers.ts')).toMatch(/const LIST_WHOLE_RATIO = 0\.9;/);
    expect(PARTIAL_READ_RATIO).toBe(0.5);
    expect(PARTIAL_READ_MAX_AGE_MS).toBe(6 * 60 * 60 * 1000);
    expect(PARTIAL_READ_MIN_KEYS).toBe(8);
    const current = lines(currentReadme());
    const half = current.filter((l) => l.includes('half the cards'));
    expect(half.length).toBe(3);
    for (const l of half) {
      expect(l, l.slice(0, 80)).toMatch(/bank page/);
      expect(l, l.slice(0, 80)).toMatch(/90%/);
    }
    // The Daily workflow's window step gives the /items rule in full.
    const step = current.find((l) => l.includes('**A look that caught only part of a page**'))!;
    expect(step).toMatch(/fewer than about 90% of the rows of your save of it from the last 6 hours/);
    expect(step).toMatch(/8 or more/);
    // ARCHITECTURE states the same ratio.
    expect(ARCH).toMatch(/LIST_WHOLE_RATIO/);
  });
});

describe('README outages (review R44)', () => {
  it('says the budget pauses and only PriceDB reads Backing off, as the Health page and connectors show it', () => {
    const l = lines(section(README, 'New in 0.7.4')).find((x) => x.startsWith('- **Outages.**'))!;
    expect(l).not.toMatch(/Data health says \*backoff\*/);
    expect(l).toMatch(/\*Request budgets\* shows that host \*Paused\* with a countdown/);
    expect(l).toMatch(/PriceDB's connection reads \*Backing off\*/);
    expect(l).toMatch(/backpack\.tf's reads \*Error\*/);
    expect(CONN_STATE_LABELS.backoff).toBe('Backing off');
    expect(CONN_STATE_LABELS.error).toBe('Error');
    expect(read('src/renderer/pages/HealthPage.tsx')).toMatch(/Paused \{fmtCountdown\(b\.pausedUntil, now\)\}/);
    // PriceDB maps an unavailable status to backoff; bptfApi's backoff stays a 429's (RateLimitedError) only.
    expect(read('src/service/connectors/pricedb.ts')).toMatch(/isUnavailableStatus\(err\.status\)\)\) restErrorState = 'backoff'/);
    expect(read('src/service/connectors/bptfApi.ts')).toMatch(/if \(err instanceof RateLimitedError\) s\.rateLimitedUntil = err\.retryAt;/);
  });
});

describe('ARCHITECTURE source layout and ownership (review R47)', () => {
  const table = ARCH.slice(ARCH.indexOf('## Source layout and ownership'), ARCH.indexOf('## Agreed module entry points'));

  function filesUnder(rel: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(join(root, rel))) {
      const p = join(rel, name);
      if (statSync(join(root, p)).isDirectory()) out.push(...filesUnder(p));
      else if (/\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }
  const importsOf = (rel: string, mod: string): boolean => new RegExp(`shared/${mod}'`).test(read(rel));

  it('has a row for every shared module both the mock and the service import (mock parity)', () => {
    const mocks = readdirSync(join(root, 'src/renderer')).filter((n) => /^mock.*\.ts$/.test(n)).map((n) => `src/renderer/${n}`);
    const service = filesUnder('src/service');
    const shared = readdirSync(join(root, 'src/shared')).filter((n) => n.endsWith('.ts')).map((n) => n.replace(/\.ts$/, ''));
    const both = shared.filter((m) => mocks.some((f) => importsOf(f, m)) && service.some((f) => importsOf(f, m)));
    for (const m of ['buyerSeen', 'copyExtras', 'ruleEvidence', 'ceiling']) expect(both).toContain(m);
    for (const m of both) expect(table, `${m}.ts in the ownership table`).toMatch(new RegExp(`\`(?:src/shared/)?${m}\\.ts\``));
  });

  it("lists priceCopy.ts and ceiling.ts's 0.7.4 cost checks", () => {
    expect(table).toMatch(/`src\/shared\/priceCopy\.ts` \| 0\.7\.4 \(F80\)/);
    const ceiling = lines(table).find((l) => l.startsWith('| `src/shared/ceiling.ts`'))!;
    for (const name of ['costSanity', 'costSanityReason', 'COST_SANITY_FLAGS', 'costSuspectFlagged', 'craftabilityTwin', 'pricedbBand']) {
      expect(ceiling).toContain(`\`${name}\``);
      expect(read('src/shared/ceiling.ts')).toMatch(new RegExp(`export (?:const|function) ${name}\\b`));
    }
  });
});

describe('ARCHITECTURE 0.7.4 round summary', () => {
  it('names every confirmed review finding and the re-read of scrap.tf/items after updating', () => {
    const round = ARCH.slice(ARCH.indexOf('## 0.7.4 round: trading accuracy audit'), ARCH.indexOf('## Conventions'));
    const named = new Set([...round.matchAll(/R(\d\d)\b/g)].map((m) => Number(m[1])));
    for (let i = 1; i <= 47; i++) expect(named.has(i), `review R${String(i).padStart(2, '0')}`).toBe(true);
    expect(round).toMatch(/the user reads scrap\.tf\/items once/);
    expect(section(README, 'New in 0.7.4')).toMatch(/\*\*save or read scrap\.tf\/items once after updating\*\*/);
  });
});
