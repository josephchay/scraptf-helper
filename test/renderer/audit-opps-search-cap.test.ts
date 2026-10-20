// 0.7.3 audit (rmodelsA-1): the Opportunities search is capped at the service's 200 characters
// ('opps.list' and 'opps.exportCsv' refuse longer), like the Live market, Holdings, Shopping and bank
// stock searches. A longer paste is cut in the box, in the query and in a restored (saved) search, so
// the list never keeps stale rows behind a refused query. Pure model checks and the page source.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS, OPP_MAX_SEARCH_CHARS, exportQuery, filtersToQuery, sanitizeFilters } from '../../src/renderer/oppModel';

const EXTRA = { sort: 'profit', dir: 'desc', groupBy: 'tier', limit: 100 } as const;
const LONG = 'team captain '.repeat(20);

describe('the Opportunities search cap', () => {
  it('is the service bound of 200 characters', () => {
    expect(OPP_MAX_SEARCH_CHARS).toBe(200);
  });

  it('cuts a saved overlong search on restore', () => {
    const f = sanitizeFilters({ ...DEFAULT_FILTERS, search: LONG });
    expect(LONG.length).toBeGreaterThan(200);
    expect(f.search).toHaveLength(200);
    expect(f.search).toBe(LONG.slice(0, 200));
  });

  it('never sends more than 200 characters to opps.list or opps.exportCsv', () => {
    const q = filtersToQuery({ ...DEFAULT_FILTERS, search: 'x'.repeat(500) }, EXTRA);
    expect(q.search).toHaveLength(200);
    expect(exportQuery(q).search!.length).toBeLessThanOrEqual(200);
    // The restored long search goes through the same path.
    expect(filtersToQuery(sanitizeFilters({ ...DEFAULT_FILTERS, search: LONG }), EXTRA).search!.length).toBeLessThanOrEqual(200);
  });

  it('still trims, and leaves a short search alone', () => {
    expect(filtersToQuery({ ...DEFAULT_FILTERS, search: '  cap ' }, EXTRA).search).toBe('cap');
    expect(filtersToQuery({ ...DEFAULT_FILTERS, search: `   ${'y'.repeat(200)}   ` }, EXTRA).search).toBe('y'.repeat(200));
    expect(filtersToQuery({ ...DEFAULT_FILTERS, search: '   ' }, EXTRA).search).toBeUndefined();
  });

  it('caps the search box itself', () => {
    const page = readFileSync(new URL('../../src/renderer/pages/OpportunitiesPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('maxLength={OPP_MAX_SEARCH_CHARS}');
  });
});
