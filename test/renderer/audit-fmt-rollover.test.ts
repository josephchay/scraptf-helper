import { describe, expect, it } from 'vitest';
import { fmtBytes, fmtDuration } from '../../src/renderer/format';

// Audit rmodelsA-2: rounding must pick the unit, so a value just under a
// boundary never reads "1 min 60 s", "60.0 s" or "1000 KB".
describe('fmtDuration rollover', () => {
  it('carries rounded seconds into the minute', () => {
    expect(fmtDuration(119_600)).toBe('2 min 0 s');
    expect(fmtDuration(119_499)).toBe('1 min 59 s');
    expect(fmtDuration(59_960)).toBe('1 min 0 s');
    expect(fmtDuration(59_949)).toBe('59.9 s');
    expect(fmtDuration(65_000)).toBe('1 min 5 s');
    expect(fmtDuration(999.6)).toBe('1.0 s');
    expect(fmtDuration(1400)).toBe('1.4 s');
    expect(fmtDuration(140)).toBe('140 ms');
  });

  it('never prints 60 seconds or 1000 ms', () => {
    for (let ms = 0; ms <= 7_200_000; ms += 50) {
      const s = fmtDuration(ms);
      expect(s, `${ms} ms`).not.toMatch(/\b60(\.0)? s\b/);
      expect(s, `${ms} ms`).not.toMatch(/^1000 ms$/);
    }
  });
});

describe('fmtBytes rollover', () => {
  it('moves to the next unit when rounding reaches 1000', () => {
    expect(fmtBytes(999_999)).toBe('1.00 MB');
    expect(fmtBytes(999_499)).toBe('999 KB');
    expect(fmtBytes(99_999)).toBe('100 KB');
    expect(fmtBytes(9_999)).toBe('10.0 KB');
    expect(fmtBytes(1_000_000)).toBe('1.00 MB');
  });

  it('never prints 1000 of a unit below TB', () => {
    for (const base of [1e3, 1e6, 1e9, 1e12]) {
      for (const f of [0.9994, 0.9995, 0.9999, 0.99999, 1, 1.0001]) {
        const n = base * 1000 * f;
        expect(fmtBytes(n), `${n} B`).not.toMatch(/^1000 (B|KB|MB|GB)$/);
      }
    }
  });
});
