// F19 contract, shared side: MarketRow.scraptfLink comes from scraptfLinkFor (the saved page that last
// listed the item, else the category's bank) and preferScraptfSeen (bank pages before the /items list,
// then newest). Every URL is a SCRAPTF_BANKS entry on the static allowlist; none is built from item data.
// The live check's hinted note is fixed text around the resolved item's name.

import { describe, expect, it } from 'vitest';
import { CHECK_ARM_MS, CHECK_ARM_NAME_MAX, CHECK_HINTED_NOTE_TAIL, checkHintedNote, checkMatchedByHint } from '../../src/shared/check';
import { SCRAPTF_BANKS, STATIC_EXTERNAL_URLS, bankForCategory, isAllowedExternalUrl, preferScraptfSeen, scraptfBankInfo, scraptfLinkFor, type ScraptfSeen } from '../../src/shared/links';
import { CATEGORIES, type ScraptfBank } from '../../src/shared/types';

const T = Date.UTC(2026, 9, 16, 12, 0, 0);
const MIN = 60_000;

describe('scraptfLinkFor', () => {
  it("falls back to the category's bank page, never the list", () => {
    for (const c of CATEGORIES) {
      const link = scraptfLinkFor(c, null);
      expect(link).toEqual({ bank: bankForCategory(c), url: scraptfBankInfo(bankForCategory(c))!.url, seenAt: null, source: 'category' });
      expect(link.bank).not.toBe('list');
    }
    expect(scraptfLinkFor('taunts', undefined)).toMatchObject({ bank: 'items', url: 'https://scrap.tf/buy/items' });
    expect(scraptfLinkFor('unusuals', null).url).toBe('https://scrap.tf/unusuals');
  });

  it('names the page the item was seen on, with that save time', () => {
    expect(scraptfLinkFor('hats', { bank: 'weapons', at: T - 12 * MIN })).toEqual({ bank: 'weapons', url: 'https://scrap.tf/buy/weapons', seenAt: T - 12 * MIN, source: 'seen' });
    // Known only from scrap.tf/items: the list is the page to look on.
    expect(scraptfLinkFor('hats', { bank: 'list', at: T })).toEqual({ bank: 'list', url: 'https://scrap.tf/items', seenAt: T, source: 'seen' });
  });

  it('ignores an unknown bank or a bad time, and never takes a URL from its input', () => {
    const bad = [
      { bank: 'https://evil.example/' as ScraptfBank, at: T },
      { bank: '__proto__' as ScraptfBank, at: T },
      { bank: 'hats' as ScraptfBank, at: Number.NaN },
      { bank: 'hats' as ScraptfBank, at: Number.POSITIVE_INFINITY },
    ];
    for (const seen of bad) expect(scraptfLinkFor('weapons', seen)).toMatchObject({ bank: 'weapons', source: 'category', seenAt: null });
    const sneaky = { bank: 'hats', at: T, url: 'https://scrap.tf/buy/hats?x=1' } as ScraptfSeen;
    expect(scraptfLinkFor('weapons', sneaky).url).toBe('https://scrap.tf/buy/hats');
  });

  it('only ever yields static allowlisted scrap.tf pages', () => {
    const urls = new Set<string>();
    for (const c of CATEGORIES) {
      urls.add(scraptfLinkFor(c, null).url);
      for (const b of SCRAPTF_BANKS) urls.add(scraptfLinkFor(c, { bank: b.bank, at: T }).url);
    }
    for (const u of urls) {
      expect(STATIC_EXTERNAL_URLS).toContain(u);
      expect(isAllowedExternalUrl(u)).toBe(true);
    }
  });
});

describe('preferScraptfSeen', () => {
  const hats = (at: number): ScraptfSeen => ({ bank: 'hats', at });
  const list = (at: number): ScraptfSeen => ({ bank: 'list', at });

  it('takes the newer sighting, the first on a tie', () => {
    expect(preferScraptfSeen(hats(T - MIN), { bank: 'weapons', at: T })).toEqual({ bank: 'weapons', at: T });
    expect(preferScraptfSeen(hats(T), { bank: 'weapons', at: T - MIN })).toEqual(hats(T));
    expect(preferScraptfSeen(hats(T), { bank: 'weapons', at: T })).toEqual(hats(T));
  });

  it('prefers any bank page over the /items list', () => {
    expect(preferScraptfSeen(list(T), hats(T - 60 * MIN))).toEqual(hats(T - 60 * MIN));
    expect(preferScraptfSeen(hats(T - 60 * MIN), list(T))).toEqual(hats(T - 60 * MIN));
    expect(preferScraptfSeen(list(T - MIN), list(T))).toEqual(list(T));
  });

  it('drops unusable sightings and folds over a list', () => {
    expect(preferScraptfSeen(null, undefined)).toBeNull();
    expect(preferScraptfSeen({ bank: 'nope' as ScraptfBank, at: T }, null)).toBeNull();
    expect(preferScraptfSeen(hats(Number.NaN), list(T))).toEqual(list(T));
    const all = [list(T), hats(T - 30 * MIN), { bank: 'stranges' as const, at: T - 5 * MIN }, hats(Number.NaN)];
    expect(all.reduce<ScraptfSeen | null>((best, s) => preferScraptfSeen(best, s), null)).toEqual({ bank: 'stranges', at: T - 5 * MIN });
  });
});

describe('live check arm and hint texts', () => {
  it('pins the limits', () => {
    expect(CHECK_ARM_MS).toBe(10 * MIN);
    expect(CHECK_ARM_NAME_MAX).toBe(200);
  });

  it("builds the hinted note around the resolved name and recognises it", () => {
    const note = checkHintedNote('Team Captain');
    expect(note).toBe('Price copied, matched to Team Captain, the item you opened from the Live market.');
    expect(note.endsWith(CHECK_HINTED_NOTE_TAIL)).toBe(true);
    expect(checkMatchedByHint({ reason: note })).toBe(true);
    expect(checkMatchedByHint({ reason: `${note} Something else.` })).toBe(true);
    expect(checkMatchedByHint({ reason: null })).toBe(false);
    expect(checkMatchedByHint({ reason: 'Closest match only: check that this is the item you copied.' })).toBe(false);
    expect(checkMatchedByHint(null)).toBe(false);
  });
});
