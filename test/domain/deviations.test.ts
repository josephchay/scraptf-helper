// Documented deviations from the design brief that the domain code relies on.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';

const ARCH = readFileSync(fileURLToPath(new URL('../../docs/ARCHITECTURE.md', import.meta.url)), 'utf8');
const deviations = ARCH.slice(ARCH.indexOf('## Deviations from the design brief'));

describe('profit thresholds', () => {
  it('are global (no per-category override), and the architecture doc lists that as a deviation from brief §5.6', () => {
    expect(Object.keys(DEFAULT_SETTINGS.profit).some((k) => /categor/i.test(k))).toBe(false);
    expect(Object.keys(DEFAULT_SETTINGS.notifications).some((k) => /categor/i.test(k))).toBe(false);
    expect(deviations).toMatch(/thresholds are global in v1/i);
    expect(deviations).toMatch(/per category/i);
  });
});
