// parsePriceLine (priceSheetIo.ts): one line of the bulk paste grammar, exported for live check (F16).
// parseBulkPrices reads every line through it, so its own tests pin the shared behaviour.

import { describe, expect, it, vi } from 'vitest';
import { parsePriceLine } from '../../src/service/priceSheetIo';
import type { ResolvedItem } from '../../src/shared/types';

const item = (sku: string, name: string, match: ResolvedItem['match'] = 'exact'): ResolvedItem => ({
  sku,
  name,
  skuObject: {} as ResolvedItem['skuObject'],
  category: 'hats',
  match,
  warnings: [],
});

const resolve = (t: string): ResolvedItem | null => {
  const s = t.trim().toLowerCase();
  if (s === 'team captain') return item('378;6', 'Team Captain');
  if (s === 'rock, paper, scissors') return item('1157;6', 'Rock, Paper, Scissors');
  if (s === 'team captian') return item('378;6', 'Team Captain', 'fuzzy');
  return null;
};

describe('parsePriceLine', () => {
  it('splits on a separator or the trailing price words, the cleanly resolving split winning', () => {
    expect(parsePriceLine('Team Captain, 1.33 ref', 'ref', resolve)).toMatchObject({ item: { sku: '378;6' }, itemText: 'Team Captain', price: { keys: 0, scrap: 12 }, problem: null });
    expect(parsePriceLine('  Team Captain 1 key 5.33 ref ', 'ref', resolve)).toMatchObject({ item: { sku: '378;6' }, price: { keys: 1, scrap: 48 } });
    expect(parsePriceLine('Team Captain - 2 keys', 'ref', resolve)).toMatchObject({ price: { keys: 2, scrap: 0 } });
    expect(parsePriceLine('Rock, Paper, Scissors, 3 ref', 'ref', resolve)).toMatchObject({ item: { sku: '1157;6' }, price: { keys: 0, scrap: 27 } });
    expect(parsePriceLine('Team Captain, 9', 'scrap', resolve)).toMatchObject({ price: { keys: 0, scrap: 9 } });
  });

  it('reports a fuzzy or unknown item as a problem, and null without a price', () => {
    expect(parsePriceLine('Team Captian, 1 ref', 'ref', resolve)).toMatchObject({ item: { match: 'fuzzy' }, problem: expect.stringMatching(/^Closest match only/) });
    expect(parsePriceLine('Nothing Known, 1 ref', 'ref', resolve)).toMatchObject({ item: null, problem: expect.stringMatching(/^Item not recognised/) });
    expect(parsePriceLine('Team Captain', 'ref', resolve)).toBeNull();
  });

  it('spends at most the spare budget on extra resolver calls', () => {
    const spy = vi.fn(() => null);
    parsePriceLine('a, b, c, d, e, f, g, 1 ref', 'ref', spy, { left: 0 });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
