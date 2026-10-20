import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { requestLogHostOptions } from '../../src/renderer/pages/HealthPage';

// Audit rpagesB-4: the selected host stays an option after it drops out of the
// latest rows, so the select shows the real filter and "All hosts" clears it.
describe('Recent requests host filter', () => {
  const rows = [{ host: 'pricedb.io' }, { host: 'api.backpack.tf' }, { host: 'pricedb.io' }];

  it('keeps the selected host after it leaves the latest rows', () => {
    expect(requestLogHostOptions(rows, 'sku.pricedb.io')).toEqual(['api.backpack.tf', 'pricedb.io', 'sku.pricedb.io']);
  });

  it('adds nothing when no host is selected', () => {
    expect(requestLogHostOptions(rows, '')).toEqual(['api.backpack.tf', 'pricedb.io']);
  });

  it('lists each host once, sorted', () => {
    expect(requestLogHostOptions(rows, 'pricedb.io')).toEqual(['api.backpack.tf', 'pricedb.io']);
  });

  it('keeps the selected host when the poll is empty', () => {
    expect(requestLogHostOptions([], 'steamcommunity.com')).toEqual(['steamcommunity.com']);
  });

  it('RequestLog builds its options with the helper and explains an empty table', () => {
    const src = readFileSync(new URL('../../src/renderer/pages/HealthPage.tsx', import.meta.url), 'utf8');
    expect(src).toContain('requestLogHostOptions(rows, host)');
    expect(src).not.toContain('const hosts = [...new Set(rows.map((r) => r.host))].sort();');
    expect(src).toMatch(/shown\.length === 0/);
  });
});
