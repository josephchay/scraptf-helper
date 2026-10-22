// 0.8 (J2, J4): the one journal venue list, the read-time normaliser and brief §5.4's fee hints.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOLDING_EXIT_VENUES } from '../../src/shared/types';
import {
  JOURNAL_VENUES,
  UNKNOWN_VENUE_LABEL,
  WRITE_OFF_VENUE,
  isScraptfVenue,
  venueFeeHint,
  venueKey,
  venueLabel,
} from '../../src/shared/venues';
import { stripComments } from '../compliance/windowWrapperScan';

const ALIASES: Record<string, readonly string[]> = {
  'scrap.tf': ['scrap.tf', 'scraptf', 'scrap tf', 'scrap'],
  'backpack.tf': ['backpack.tf', 'backpacktf', 'backpack tf', 'backpack', 'bp.tf', 'bptf', 'bp', 'next.backpack.tf'],
  'marketplace.tf': ['marketplace.tf', 'marketplacetf', 'marketplace tf', 'marketplace', 'mp.tf', 'mptf'],
  'Steam Community Market': ['steam community market', 'steam market', 'community market', 'scm', 'steam', 'steamcommunity.com'],
  'Direct trade': ['direct trade', 'direct', 'steam trade', 'trade offer', 'private trade'],
  other: ['other'],
  'Written off': ['written off', 'written-off', 'write off', 'write-off', 'writeoff'],
};

describe('the venue list', () => {
  it('starts with the two holding exits, then the other venues', () => {
    expect(JOURNAL_VENUES.slice(0, 2)).toEqual([HOLDING_EXIT_VENUES.scraptf, HOLDING_EXIT_VENUES.backpack]);
    expect(JOURNAL_VENUES).toEqual(['scrap.tf', 'backpack.tf', 'marketplace.tf', 'Steam Community Market', 'Direct trade', 'other']);
    expect(WRITE_OFF_VENUE).toBe('Written off');
    expect(UNKNOWN_VENUE_LABEL).toBe('Unknown');
    // Every listed venue is its own canonical name.
    for (const v of [...JOURNAL_VENUES, WRITE_OFF_VENUE]) expect(venueLabel(v)).toBe(v);
  });
});

describe('venueKey and venueLabel', () => {
  it('keys: trimmed, lower case, single spaces, a trailing dot or slash dropped', () => {
    expect(venueKey('  Steam   Community\tMarket ')).toBe('steam community market');
    expect(venueKey('Scrap.TF/')).toBe('scrap.tf');
    expect(venueKey('backpack.tf.')).toBe('backpack.tf');
    expect(venueKey(null)).toBe('');
    expect(venueKey(42)).toBe('');
  });

  it('folds every alias, in any case and spacing', () => {
    for (const [canonical, aliases] of Object.entries(ALIASES)) {
      for (const a of aliases) {
        expect(venueLabel(a), a).toBe(canonical);
        expect(venueLabel(` ${a.toUpperCase()} `), a).toBe(canonical);
      }
    }
    expect(venueLabel(' BP.TF ')).toBe('backpack.tf');
    expect(venueLabel('Steam')).toBe('Steam Community Market');
    expect(venueLabel('scrap.tf/')).toBe('scrap.tf');
  });

  it('keeps unknown text trimmed with its case, and names an empty venue Unknown', () => {
    expect(venueLabel('  My   Friend Bob ')).toBe('My Friend Bob');
    expect(venueLabel('')).toBe('Unknown');
    expect(venueLabel('   ')).toBe('Unknown');
    expect(venueLabel(undefined)).toBe('Unknown');
  });

  it('isScraptfVenue: scrap.tf by venueLabel, any case or alias', () => {
    expect(isScraptfVenue('Scrap.TF')).toBe(true);
    expect(isScraptfVenue(' scraptf ')).toBe(true);
    expect(isScraptfVenue('scrap')).toBe(true);
    expect(isScraptfVenue('backpack.tf')).toBe(false);
    expect(isScraptfVenue('scrap.tf bank')).toBe(false);
    expect(isScraptfVenue(null)).toBe(false);
  });
});

describe('venueFeeHint (brief §5.4, text only)', () => {
  it('hints on either side for scrap.tf, backpack.tf and a direct trade', () => {
    for (const side of ['buy', 'sell'] as const) {
      expect(venueFeeHint('scrap.tf', side)).toBe('scrap.tf charges no documented fee: enter 0 to record none.');
      expect(venueFeeHint('bp', side)).toBe('A backpack.tf trade has no platform fee: enter 0 to record none.');
      expect(venueFeeHint('Direct trade', side)).toBe('A direct trade has no platform fee: enter 0 to record none.');
    }
  });

  it("names marketplace.tf's and the Steam Market's cut on a sale only", () => {
    expect(venueFeeHint('marketplace.tf', 'sell')).toBe(
      'marketplace.tf keeps about 10% of the sale price (you get about 90%). Enter that cut in keys or metal, at the value you log the sale at.',
    );
    expect(venueFeeHint('SCM', 'sell')).toBe(
      'The Steam Market keeps about 13% (the buyer pays about 1.15× what you get: 5% Steam and 10% TF2, each at least $0.01), in Steam Wallet funds. Enter that cut in keys or metal, at the value you log the sale at.',
    );
    expect(venueFeeHint('marketplace.tf', 'buy')).toBeNull();
    expect(venueFeeHint('Steam Community Market', 'buy')).toBeNull();
  });

  it('gives nothing for a write-off or any other venue', () => {
    for (const v of [...JOURNAL_VENUES, WRITE_OFF_VENUE]) expect(venueFeeHint(v, 'writeoff')).toBeNull();
    expect(venueFeeHint('other', 'sell')).toBeNull();
    expect(venueFeeHint('Written off', 'sell')).toBeNull();
    expect(venueFeeHint('My Friend Bob', 'buy')).toBeNull();
    expect(venueFeeHint('', 'sell')).toBeNull();
  });
});

describe('the module names no web address (R1)', () => {
  it('has no URL or scrap.tf path in its code', () => {
    const code = stripComments(readFileSync(fileURLToPath(new URL('../../src/shared/venues.ts', import.meta.url)), 'utf8'));
    expect(code).not.toContain('://');
    expect(code).not.toMatch(/scrap\.tf\//i);
  });
});
