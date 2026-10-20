// 0.7.3: the Import page's permission record inputs stop at the lengths the settings schema accepts, so a
// Date of 101-200 characters is no longer typed in and then refused by main on Save record.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { applySettingsPatch, SettingsValidationError } from '../../src/shared/settingsSchema';
import { PERMISSION_FIELD_MAX, type PermissionRecord } from '../../src/shared/types';

const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');
const KEYS: readonly (keyof PermissionRecord)[] = ['grantor', 'contact', 'grantedAt', 'scope'];
const VALID: PermissionRecord ={ grantor: 'a', contact: 'b', grantedAt: '2026-10-20', scope: 'c' };
const save = (rec: PermissionRecord) => applySettingsPatch(structuredClone(DEFAULT_SETTINGS), { import: { permission: rec } });

describe('permission record field limits', () => {
  it('are the schema limits, shared with the page', () => {
    expect(PERMISSION_FIELD_MAX).toEqual({ grantor: 200, contact: 200, grantedAt: 100, scope: 1000 });
  });

  it.each(KEYS)('%s: the schema takes exactly its limit and refuses one more', (k) => {
    const max = PERMISSION_FIELD_MAX[k];
    const atMax = { ...VALID, [k]: 'x'.repeat(max) };
    expect(save(atMax).import.permission).toEqual(atMax);
    const over = { ...VALID, [k]: 'x'.repeat(max + 1) };
    expect(() => save(over)).toThrow(SettingsValidationError);
    expect(() => save(over)).toThrow(new RegExp(`import\\.permission\\.${k}`));
  });

  it('names every field the settings merge keeps', () => {
    const stored = save(VALID).import.permission!;
    expect(Object.keys(stored).sort()).toEqual([...KEYS].sort());
    expect(Object.keys(PERMISSION_FIELD_MAX).sort()).toEqual([...KEYS].sort());
  });

  it("the Import page's inputs stop at each field's limit, not one fixed length", () => {
    const page = read('pages/ImportPage.tsx');
    const start = page.indexOf('function PermissionRecordCard');
    expect(start).toBeGreaterThan(-1);
    const next = page.indexOf('\nfunction ', start + 1);
    const card = page.slice(start, next === -1 ? undefined : next);
    expect(card).toContain('maxLength={PERMISSION_FIELD_MAX[k]}');
    expect(card).not.toContain('maxLength={200}');
  });
});
