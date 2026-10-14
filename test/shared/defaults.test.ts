import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTES_KEYWORDS, DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { DeepPartial, Settings } from '../../src/shared/types';

const base = (): Settings => structuredClone(DEFAULT_SETTINGS);

describe('DEFAULT_SETTINGS', () => {
  it('keeps the safe defaults the architecture relies on', () => {
    expect(DEFAULT_SETTINGS.import.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.import.acknowledgedAt).toBeNull();
    expect(DEFAULT_SETTINGS.connectors.scm).toBe(false);
    expect(DEFAULT_SETTINGS.networkPaused).toBe(false);
    expect(DEFAULT_SETTINGS.profit.useOrder).toBe('conservative');
    expect(DEFAULT_SETTINGS.contactUrl).toBe('');
  });

  it('uses the documented live-feed daily cap (ARCHITECTURE.md deviation: 25 GB of decompressed payload)', () => {
    expect(DEFAULT_SETTINGS.liveFeed.dailyCapBytes).toBe(25_000_000_000);
  });

  it('does not share the notes keyword array with the exported constant', () => {
    expect(DEFAULT_SETTINGS.profit.notesKeywords).toEqual([...DEFAULT_NOTES_KEYWORDS]);
    expect(DEFAULT_SETTINGS.profit.notesKeywords).not.toBe(DEFAULT_NOTES_KEYWORDS);
  });

  it('uses integer scrap for money fields', () => {
    for (const v of [
      DEFAULT_SETTINGS.profit.minProfitScrap,
      DEFAULT_SETTINGS.profit.frictionScrap,
      DEFAULT_SETTINGS.notifications.minProfitScrap,
    ]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe('mergeSettings', () => {
  it('returns an equal deep copy for an empty, null or undefined patch', () => {
    for (const patch of [undefined, null, {}]) {
      const b = base();
      const out = mergeSettings(b, patch);
      expect(out).toEqual(b);
      expect(out).not.toBe(b);
      expect(out.profit).not.toBe(b.profit);
      expect(out.profit.notesKeywords).not.toBe(b.profit.notesKeywords);
    }
  });

  it('merges nested objects field by field', () => {
    const out = mergeSettings(base(), { profit: { minProfitScrap: 18 }, keyPrice: { mode: 'manual', manualScrap: 600 } });
    expect(out.profit.minProfitScrap).toBe(18);
    expect(out.profit.minMargin).toBe(DEFAULT_SETTINGS.profit.minMargin);
    expect(out.profit.notesKeywords).toEqual(DEFAULT_SETTINGS.profit.notesKeywords);
    expect(out.keyPrice).toEqual({ ...DEFAULT_SETTINGS.keyPrice, mode: 'manual', manualScrap: 600 });
    expect(out.ui).toEqual(DEFAULT_SETTINGS.ui);
  });

  it('replaces scalar top-level fields', () => {
    const out = mergeSettings(base(), { contactUrl: 'https://example.org/me', networkPaused: true });
    expect(out.contactUrl).toBe('https://example.org/me');
    expect(out.networkPaused).toBe(true);
  });

  it('replaces arrays instead of merging them', () => {
    const b = mergeSettings(base(), { blocklist: ['76561198000000001', '76561198000000002'] });
    const out = mergeSettings(b, { blocklist: ['76561198000000003'], profit: { notesKeywords: ['dupe'] } });
    expect(out.blocklist).toEqual(['76561198000000003']);
    expect(out.profit.notesKeywords).toEqual(['dupe']);
    expect(mergeSettings(b, { blocklist: [] }).blocklist).toEqual([]);
  });

  it('lets null replace a value and a later object replace the null', () => {
    const withManual = mergeSettings(base(), { keyPrice: { manualScrap: 600 } });
    const cleared = mergeSettings(withManual, { keyPrice: { manualScrap: null } });
    expect(cleared.keyPrice.manualScrap).toBeNull();

    const permission = { grantor: 'Admin', contact: 'admin@example.org', grantedAt: '2026-10-14', scope: 'saved pages' };
    const granted = mergeSettings(base(), { import: { permission } });
    expect(granted.import.permission).toEqual(permission);
    expect(mergeSettings(granted, { import: { permission: null } }).import.permission).toBeNull();
  });

  it('treats an explicit undefined as "no change"', () => {
    const out = mergeSettings(base(), { profit: undefined, contactUrl: undefined });
    expect(out.profit).toEqual(DEFAULT_SETTINGS.profit);
    expect(out.contactUrl).toBe('');
  });

  it('ignores unknown keys at every level', () => {
    const patch = { bogus: 1, profit: { minProfitScrap: 10, extra: 'x' }, ui: { theme: 'dark', layout: 'grid' } } as unknown as DeepPartial<Settings>;
    const out = mergeSettings(base(), patch) as unknown as Record<string, unknown>;
    expect('bogus' in out).toBe(false);
    const profit = out['profit'] as Record<string, unknown>;
    expect(profit['minProfitScrap']).toBe(10);
    expect('extra' in profit).toBe(false);
    expect('layout' in (out['ui'] as Record<string, unknown>)).toBe(false);
  });

  it('is not open to prototype pollution through JSON input', () => {
    const patch = JSON.parse('{"__proto__":{"polluted":true},"profit":{"__proto__":{"polluted":true},"minMargin":0.2}}') as DeepPartial<Settings>;
    const out = mergeSettings(base(), patch);
    expect(out.profit.minMargin).toBe(0.2);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect((out as unknown as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it('does not mutate the base or the patch', () => {
    const b = base();
    const snapshot = structuredClone(b);
    const patch: DeepPartial<Settings> = { profit: { notesKeywords: ['x'] }, blocklist: ['1'] };
    const patchSnapshot = structuredClone(patch);
    const out = mergeSettings(b, patch);
    expect(b).toEqual(snapshot);
    expect(patch).toEqual(patchSnapshot);
    out.profit.notesKeywords.push('y');
    expect(b.profit.notesKeywords).toEqual(snapshot.profit.notesKeywords);
  });

  it('documents that type checking is left to the settings schema (a null object field is accepted)', () => {
    const out = mergeSettings(base(), { ui: null } as unknown as DeepPartial<Settings>);
    expect(out.ui).toBeNull();
  });

  // BUG (reported): when the base value is null (import.permission), the patch
  // object is taken wholesale, so unknown keys inside it survive. That breaks
  // the "unknown keys are ignored" contract for that subtree.
  it('unknown keys inside an object that replaces a null are dropped', () => {
    const patch = {
      import: {
        permission: { grantor: 'a', contact: 'b', grantedAt: 'c', scope: 'd', injected: 'x' },
      },
    } as unknown as DeepPartial<Settings>;
    const out = mergeSettings(base(), patch);
    expect('injected' in (out.import.permission as unknown as Record<string, unknown>)).toBe(false);
  });
});

describe('v0.2 defaults', () => {
  it('ignores references older than 30 days and flags margins over 200% by default', () => {
    expect(DEFAULT_SETTINGS.profit.referenceMaxAgeMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(DEFAULT_SETTINGS.profit.suspectMargin).toBe(2);
  });

  it('notifies every input kind with sound, as before v0.2', () => {
    expect(DEFAULT_SETTINGS.notifications.inputKinds).toEqual(['user', 'import', 'rule']);
    expect(DEFAULT_SETTINGS.notifications.silent).toBe(false);
  });

  it('replaces the notification input kinds instead of merging them', () => {
    const out = mergeSettings(base(), { notifications: { inputKinds: ['user'] } });
    expect(out.notifications.inputKinds).toEqual(['user']);
    expect(out.notifications.inputKinds).not.toBe(DEFAULT_SETTINGS.notifications.inputKinds);
  });
});
