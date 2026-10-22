// 0.9 (#3) review: the Live market's risk sorts ('backup', 'depth') tie by profit (most first, missing last, whatever
// the direction) before the name, as Opportunities' compareOpps and the repo's OPP_SORT do. Rows share a depth of
// 0-3 buyers often, so a name tie would list an 8 ref flip after a 0.11 ref one. The service index reads
// marketProfitTiesFirst too; test/domain/market.test.ts pins its order to marketComparator over every sort.

import { describe, expect, it } from 'vitest';
import { compareOpps } from '../../src/renderer/oppModel';
import { MARKET_SORTS, marketComparator, marketProfitTiesFirst } from '../../src/shared/market';
import type { MarketRow, Opportunity } from '../../src/shared/types';

type Side = Pick<
  MarketRow,
  'sku' | 'name' | 'maxCostScrap' | 'revenueScrap' | 'buyerCount' | 'profitScrap' | 'backupProfitScrap' | 'profitableDepth' | 'lastOrderChangeAt' | 'knownObservedAt'
>;

function row(sku: string, name: string, profitScrap: number | null, profitableDepth: number | null, backupProfitScrap: number | null): Side {
  return {
    sku,
    name,
    maxCostScrap: 50,
    revenueScrap: 60,
    buyerCount: 3,
    profitScrap,
    ...(backupProfitScrap === null ? {} : { backupProfitScrap }),
    profitableDepth,
    lastOrderChangeAt: null,
    knownObservedAt: null,
  };
}

/** The same row as an Opportunity, for compareOpps (only the fields it sorts by). */
function opp(r: Side): Opportunity {
  return { key: r.sku, name: r.name, profitScrap: r.profitScrap, backupProfitScrap: r.backupProfitScrap, profitableDepth: r.profitableDepth ?? undefined } as unknown as Opportunity;
}

const names = (rows: readonly { name: string }[]) => rows.map((r) => r.name);

describe('the risk sorts tie by profit before the name', () => {
  // Same depth (3) and same backup profit (5): only the tie-break orders them.
  const alpha = row('1;6', 'Alpha', 1, 3, 5);
  const zulu = row('2;6', 'Zulu', 90, 3, 5);
  const mike = row('3;6', 'Mike', null, 3, 5);
  const bravo = row('4;6', 'Bravo', 40, 3, 5);
  const deeper = row('5;6', 'Yankee', 2, 4, 9);
  const none = row('6;6', 'Echo', 70, null, null);
  const all = [alpha, zulu, mike, bravo, deeper, none];

  it('marks seen, backup and depth (and no other sort) as profit-first', () => {
    expect([...MARKET_SORTS.filter(marketProfitTiesFirst)].sort()).toEqual(['backup', 'depth', 'seen']);
  });

  for (const key of ['depth', 'backup'] as const) {
    it(`${key}: most profit first among equal values, missing profit last, then the name, in both directions`, () => {
      expect(names([...all].sort(marketComparator(key, 'desc')))).toEqual(['Yankee', 'Zulu', 'Bravo', 'Alpha', 'Mike', 'Echo']);
      // The tie goes most profit first whatever the direction (as 'seen' and compareOpps); missing values stay last.
      expect(names([...all].sort(marketComparator(key, 'asc')))).toEqual(['Zulu', 'Bravo', 'Alpha', 'Mike', 'Yankee', 'Echo']);
    });

    it(`${key}: the Live market and Opportunities give the same order`, () => {
      for (const dir of ['asc', 'desc'] as const) {
        const market = names([...all].sort(marketComparator(key, dir)));
        const opps = names(all.map(opp).sort(compareOpps(key, dir)));
        expect(market, dir).toEqual(opps);
      }
    });
  }

  it('the finding: two rows at depth 3, profits 1 and 90 scrap, list the 90 scrap flip first', () => {
    expect(names([alpha, zulu].sort(marketComparator('depth', 'desc')))).toEqual(['Zulu', 'Alpha']);
    expect(names([alpha, zulu].map(opp).sort(compareOpps('depth', 'desc')))).toEqual(['Zulu', 'Alpha']);
  });

  it('the other sorts still tie by name', () => {
    const a = row('1;6', 'Alpha', 1, 3, 5);
    const z = row('2;6', 'Zulu', 90, 3, 5);
    for (const key of ['ceiling', 'revenue', 'buyers'] as const) expect(names([z, a].sort(marketComparator(key, 'desc'))), key).toEqual(['Alpha', 'Zulu']);
  });
});
