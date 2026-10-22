// 0.9 (history, RESEARCH #6/#7, R1/R2/R5): static guards on the history package. Its three tables keep no SteamID,
// listing id or name; the spell tracker and the feed recorder never name a buyer's identity; the feed's community
// price is read without touching `user`, `steam` or `deal`; the 'bptf-prices' job still sends exactly its one
// IGetPrices request; and none of the package's new modules can reach the network. Storage of data that already
// arrives, local reads only.

import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrate } from '../../src/service/db/migrations';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const read = (rel: string): string => readFileSync(`${SRC}${rel}`, 'utf8');
/** The source without its comments, so a doc naming what is never read does not count. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** The package's eight new modules (the three shared rules, the three service modules, the renderer model and section). */
const MODULES = [
  'shared/orderPersistence.ts',
  'shared/communityHistory.ts',
  'shared/scraptfLows.ts',
  'service/domain/orderSpells.ts',
  'service/domain/communityFeed.ts',
  'service/domain/bookHistory.ts',
  'renderer/bookHistoryModel.ts',
  'renderer/components/BookHistorySection.tsx',
];

describe('0.9 (history): no SteamID, listing id or name is stored (R5, RESEARCH #6)', () => {
  it('the three tables have no column naming a buyer, a listing or an offer', () => {
    const db = new DatabaseSync(':memory:');
    try {
      migrate(db);
      for (const table of ['order_spells', 'bptf_community_history', 'scraptf_lows']) {
        const cols = db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((c) => String(c['name']));
        expect(cols.length, table).toBeGreaterThan(0);
        for (const c of cols) expect(c, `${table}.${c}`).not.toMatch(/steam|user|name|listing_id|^listing|offer|trade|details|token/i);
      }
    } finally {
      db.close();
    }
  });

  it('the spell tracker and the feed recorder never name steamid, userName, tradeOfferUrl or details', () => {
    for (const rel of ['service/domain/orderSpells.ts', 'service/domain/communityFeed.ts']) {
      expect(code(read(rel)), rel).not.toMatch(/\bsteamid\b|\buserName\b|\btradeOfferUrl\b|\bdetails\b/);
    }
  });
});

describe('0.9 (history): what the feed and the prices job read and send (R2, R7)', () => {
  it("wsCommunityPriceOf's body reads no `user`, `steam` or `deal`", () => {
    const src = read('service/connectors/bptfItem.ts');
    const start = src.indexOf('export function wsCommunityPriceOf(');
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toMatch(/price\['community'\]/);
    expect(code(body)).not.toMatch(/\buser\b|\bsteam\b|\bdeal\b/);
  });

  it("the 'bptf-prices' job calls bptfApi.prices( exactly once and no other bptfApi or http method", () => {
    const src = read('service/scheduler.ts');
    const start = src.indexOf("id: 'bptf-prices'");
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf("id: '", start + 1);
    const job = code(src.slice(start, end > start ? end : undefined));
    expect(job.match(/bptfApi\.prices\(/g)).toHaveLength(1);
    expect(job.match(/\bbptfApi\.\w+/g)).toEqual(['bptfApi.prices']);
    expect(job).not.toMatch(/\bhttp\.\w+\(/);
    // The history is written from the answer: the stored rows are read locally.
    expect(job).toMatch(/communityHistoryPointsOf\(repo\.communityFor\(/);
  });

  it('none of the new modules imports service/net, electron or node:http(s)', () => {
    expect(MODULES.filter((rel) => !existsSync(`${SRC}${rel}`))).toEqual([]);
    for (const rel of MODULES) {
      const imports = [...read(rel).matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
      expect(imports.length, rel).toBeGreaterThan(0);
      for (const spec of imports) expect(spec, `${rel} imports ${spec}`).not.toMatch(/(^|\/)net(\/|$)|^electron$|^(node:)?https?$|\bfetch\b|^ws$/);
    }
  });
});
