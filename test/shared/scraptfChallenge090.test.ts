// 0.9 (#14): the F21 window's challenge-phrase check (src/shared/scraptfWindowPolicy.ts). A page served with an
// unexpected status (a 200) that carries a check page's own words is never imported; main pushes its read with the
// page notice, which the toolbar words as "Could not read …". A local check on a string already read: no request.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readStatusView } from '../../src/renderer/scraptfWindowModel';
import {
  SCRAPTF_CHALLENGE_PHRASES,
  SCRAPTF_CHALLENGE_SCAN_CHARS,
  SCRAPTF_READ_REASONS,
  SCRAPTF_WINDOW_NOTICES,
  scraptfChallengeIn,
} from '../../src/shared/scraptfWindowPolicy';

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const bankFixture = (name: string) => readFileSync(new URL(`../fixtures/import/${name}`, import.meta.url), 'utf8');

describe('scraptfChallengeIn', () => {
  it("finds each of a check page's own phrases, the two Scrap.TF sentences in any case", () => {
    expect(SCRAPTF_CHALLENGE_PHRASES).toHaveLength(4);
    for (const page of [
      '<html><body>Please complete the following captcha to enter Scrap.TF</body></html>',
      '<html><body>PLEASE COMPLETE THE FOLLOWING CAPTCHA TO ENTER SCRAP.TF</body></html>',
      '<p>Checking your browser before continuing to Scrap.TF.</p>',
      '<p>checking your browser before continuing to scrap.tf</p>',
      '<html><head><title>Just a moment...</title></head></html>',
      '<html><head><title> just a moment... </title></head></html>',
      '<script>window._cf_chl_opt={}</script>',
    ]) {
      expect(scraptfChallengeIn(page), page).toBe(true);
    }
  });

  it('leaves ordinary pages alone', () => {
    // The interstitial's words outside a <title> (an error page's body, a 403 the test suite reads on Read page now).
    expect(scraptfChallengeIn('<html>Just a moment...</html>')).toBe(false);
    // Cloudflare's bot-detection script may sit on ordinary scrap.tf pages.
    expect(scraptfChallengeIn('<html><head><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head><body>hats</body></html>')).toBe(false);
    for (const name of ['buy_hats.html', 'buy_weapons.html', 'items_list.html', 'unusuals.html']) expect(scraptfChallengeIn(bankFixture(name)), name).toBe(false);
  });

  it('searches only the start of a read', () => {
    expect(SCRAPTF_CHALLENGE_SCAN_CHARS).toBe(262_144);
    const phrase = '<title>Just a moment...</title>';
    expect(scraptfChallengeIn(`${'x'.repeat(SCRAPTF_CHALLENGE_SCAN_CHARS - phrase.length)}${phrase}`)).toBe(true);
    expect(scraptfChallengeIn(`${'x'.repeat(SCRAPTF_CHALLENGE_SCAN_CHARS)}${phrase}`)).toBe(false);
  });

  it('is false for anything that is not a non-empty string', () => {
    for (const v of [undefined, null, '', 42, { html: '<title>Just a moment...</title>' }, ['_cf_chl_opt']]) expect(scraptfChallengeIn(v)).toBe(false);
  });
});

describe('the read reason and the toolbar', () => {
  it('words the new read reason without an address', () => {
    expect(SCRAPTF_READ_REASONS.challenge).toBe('A Cloudflare or scrap.tf check is on screen: solve it in the page; nothing was imported.');
    expect(SCRAPTF_READ_REASONS.challenge).not.toMatch(/:\/\/|[?#]/);
  });

  it("words main's pushed check-page read (warning: the page notice) as a failed read", () => {
    const v = readStatusView({ at: T0, path: '/buy/hats', items: 0, bank: null, newFlips: 0, warning: SCRAPTF_WINDOW_NOTICES.challenge }, T0);
    expect(v.main.startsWith('Could not read /buy/hats · ')).toBe(true);
    expect(v.tone).toBe('warn');
    expect(v.title).toContain('Nothing was imported');
    for (const text of [v.main, v.title]) {
      expect(text).not.toContain('Read 0 items');
      expect(text).not.toContain('imported like a saved page');
    }
  });
});
