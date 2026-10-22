// 0.9 (#9): the checkout guard's texts (src/shared/checkoutGuard.ts): five sourced lines, each labelled with how sure
// it is, the titles built from them and the toast suffix rule. Text only: no forecast, no address, and nothing joins,
// leaves or watches a queue (R1, R4).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_GUARD_CHECKED,
  CHECKOUT_GUARD_HEAD,
  CHECKOUT_GUARD_LINES,
  CHECKOUT_GUARD_NEVER,
  CHECKOUT_GUARD_POPUP,
  CHECKOUT_GUARD_SHORT,
  CHECKOUT_GUARD_SOURCE_LABELS,
  CHECKOUT_GUARD_TAG,
  CHECKOUT_GUARD_TOAST,
  CHECKOUT_GUARD_TOAST_BODY_MAX,
  checkoutGuardItems,
  checkoutGuardTitle,
  withCheckoutGuard,
} from '../../src/shared/checkoutGuard';

const SOURCE = readFileSync(fileURLToPath(new URL('../../src/shared/checkoutGuard.ts', import.meta.url)), 'utf8');

describe('0.9 (#9): the checkout guard texts', () => {
  it('has the five lines in order, each with a known source and its label', () => {
    expect(CHECKOUT_GUARD_LINES.map((l) => l.id)).toEqual(['queue-reserves', 'accept-promptly', 'lapse-lock', 'one-request', 'no-rejoin']);
    expect(CHECKOUT_GUARD_LINES.map((l) => l.source)).toEqual(['help', 'help', 'community', 'inferred', 'rule']);
    for (const l of CHECKOUT_GUARD_LINES) {
      expect(Object.keys(CHECKOUT_GUARD_SOURCE_LABELS)).toContain(l.source);
      expect(l.text.trim()).not.toBe('');
    }
    const items = checkoutGuardItems();
    expect(items.map((i) => i.id)).toEqual(CHECKOUT_GUARD_LINES.map((l) => l.id));
    for (const [i, it] of items.entries()) {
      expect(it.text).toBe(CHECKOUT_GUARD_LINES[i]!.text);
      expect(it.source).toBe(CHECKOUT_GUARD_SOURCE_LABELS[CHECKOUT_GUARD_LINES[i]!.source]);
    }
  });

  it('the title holds every line with its label, the date the sources were read and the boundary line', () => {
    const title = checkoutGuardTitle();
    expect(title.startsWith(`${CHECKOUT_GUARD_HEAD} (sources read 2026-10-22): `)).toBe(true);
    expect(CHECKOUT_GUARD_CHECKED).toBe('2026-10-22');
    for (const i of checkoutGuardItems()) expect(title).toContain(`${i.text} (${i.source})`);
    expect(title.endsWith(CHECKOUT_GUARD_NEVER)).toBe(true);
  });

  it('the short line and the tag say the 2 h lockout is community-reported', () => {
    for (const t of [CHECKOUT_GUARD_SHORT, CHECKOUT_GUARD_TAG]) {
      expect(t).toContain('about 2 h');
      expect(t).toContain('community-reported');
      expect(t.indexOf('community-reported')).toBeGreaterThan(t.indexOf('about 2 h'));
    }
  });

  it('no text forecasts: no "will", no percentage, no "forecast"', () => {
    const texts = [
      ...CHECKOUT_GUARD_LINES.map((l) => l.text),
      ...Object.values(CHECKOUT_GUARD_SOURCE_LABELS),
      CHECKOUT_GUARD_HEAD,
      CHECKOUT_GUARD_NEVER,
      CHECKOUT_GUARD_SHORT,
      CHECKOUT_GUARD_TAG,
      CHECKOUT_GUARD_POPUP,
      CHECKOUT_GUARD_TOAST,
      checkoutGuardTitle(),
    ];
    for (const t of texts) expect(t, t).not.toMatch(/\bwill\b|%|forecast/i);
  });

  it('withCheckoutGuard appends the toast sentence when the body stays at or under 200 characters', () => {
    expect(CHECKOUT_GUARD_TOAST_BODY_MAX).toBe(200);
    expect(withCheckoutGuard('a, +2.22 ref')).toBe("a, +2.22 ref. Accept the bot's offer promptly.");
    // A body ending in a sentence mark joins with one space; trailing spaces go.
    expect(withCheckoutGuard('Sells for 2 ref.')).toBe("Sells for 2 ref. Accept the bot's offer promptly.");
    expect(withCheckoutGuard('Buy now!  ')).toBe("Buy now! Accept the bot's offer promptly.");
    // Too long once joined: the body as it was.
    const long = 'x'.repeat(180);
    expect(withCheckoutGuard(long)).toBe(long);
    const fits = 'y'.repeat(200 - 2 - CHECKOUT_GUARD_TOAST.length);
    expect(withCheckoutGuard(fits)).toHaveLength(200);
    expect(withCheckoutGuard(`${fits}z`)).toBe(`${fits}z`);
    // A custom bar.
    expect(withCheckoutGuard('a', 10)).toBe('a');
    // Empty or not a string: unchanged.
    expect(withCheckoutGuard('')).toBe('');
    expect(withCheckoutGuard('   ')).toBe('   ');
    expect(withCheckoutGuard(null as unknown as string)).toBeNull();
  });

  it('the module holds no address: no "http" and no string starting scrap.tf/ (an F20 file)', () => {
    expect(SOURCE).not.toMatch(/http/i);
    expect(SOURCE).not.toMatch(/['"`]scrap\.tf\//);
  });
});
