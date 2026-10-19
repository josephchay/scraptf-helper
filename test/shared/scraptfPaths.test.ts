// 0.7.1 (F21-4): scraptfImportablePath, the pages the scrap.tf window may read, agrees with the
// parser's pageKindFromUrl on every https scrap.tf address: a page is importable exactly when the
// parser recognises its kind. Pure string checks; nothing is fetched.

import { describe, expect, it } from 'vitest';
import { pageKindFromUrl } from '../../src/service/import/scraptfHtml';
import { scraptfImportablePath } from '../../src/shared/scraptfPaths';

const S = 'https://scrap.tf';

/** [address, importable]: the expectations, which the parity check below also holds the parser to. */
const TABLE: readonly (readonly [string, boolean])[] = [
  // Bank pages, any /buy/<slug>, in any case, with trailing slashes, queries and hashes ignored.
  [`${S}/buy/hats`, true],
  [`${S}/buy/hats/`, true],
  [`${S}/buy/hats//`, true],
  [`${S}/buy/hats?sort=price`, true],
  [`${S}/buy/hats#top`, true],
  [`${S}/BUY/Hats`, true],
  [`${S}/buy/weapons`, true],
  [`${S}/buy/stranges`, true],
  [`${S}/buy/killstreaks`, true],
  [`${S}/buy/skins`, true],
  [`${S}/buy/items`, true],
  [`${S}/buy/somethingnew`, true],
  [`${S}/buy/hats/extra`, true],
  [`${S}/buy/%68ats`, true],
  [`https://scrap.tf:443/buy/hats`, true],
  // Unusuals, both spellings, with and without /buy and an effect's sub-page.
  [`${S}/unusuals`, true],
  [`${S}/unusual`, true],
  [`${S}/unusuals/`, true],
  [`${S}/unusuals/378`, true],
  [`${S}/unusual/378`, true],
  [`${S}/buy/unusuals`, true],
  [`${S}/buy/unusual`, true],
  [`${S}/buy/unusuals/378`, true],
  // The price list and its later pages.
  [`${S}/items`, true],
  [`${S}/items/`, true],
  [`${S}/items/2`, true],
  [`${S}/items/12/`, true],
  [`${S}/items?page=2`, true],
  // Everything else on scrap.tf.
  [`${S}/`, false],
  [S, false],
  [`${S}/buy`, false],
  [`${S}/buy/`, false],
  [`${S}/unusualsfoo`, false],
  [`${S}/itemsx`, false],
  [`${S}/items/abc`, false],
  [`${S}/items/2/3`, false],
  [`${S}/raffles`, false],
  [`${S}/raffles/abc123`, false],
  [`${S}/settings`, false],
  [`${S}/profile/76561198000000001`, false],
  [`${S}/sell/hats`, false],
  [`${S}/auctions`, false],
  // Other hosts and junk.
  ['https://example.com/buy/hats', false],
  ['https://steamcommunity.com/openid/login', false],
  ['https://scrap.tf.example.com/buy/hats', false],
  ['', false],
  ['not a url', false],
  ['javascript:alert(1)', false],
];

describe('scraptfImportablePath', () => {
  it.each(TABLE)('%s -> %s', (url, want) => {
    expect(scraptfImportablePath(url)).toBe(want);
  });

  it('agrees with the parser on every address of the table', () => {
    for (const [url] of TABLE) {
      const parserReads = (pageKindFromUrl(url)?.kind ?? 'unknown') !== 'unknown';
      expect(scraptfImportablePath(url), url).toBe(parserReads);
    }
  });

  it('is stricter than the parser only off https scrap.tf itself (the window never shows those)', () => {
    // The parser also reads saved copies of these addresses (an http save, a subdomain, an archive copy);
    // the window only ever reads https pages on exactly scrap.tf, so none of them is importable here.
    for (const url of [
      'http://scrap.tf/buy/hats',
      'https://www.scrap.tf/buy/hats',
      'https://web.archive.org/web/2024/https://scrap.tf/buy/hats',
      'https://user@scrap.tf/buy/hats',
      'https://scrap.tf:8443/buy/hats',
    ]) {
      expect(pageKindFromUrl(url)?.kind ?? 'unknown', url).not.toBe('unknown');
      expect(scraptfImportablePath(url), url).toBe(false);
    }
  });
});
