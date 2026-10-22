import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import {
  applySettingsPatch,
  isValidAccelerator,
  parseSettings,
  parseSettingsWithReport,
  settingsSchema,
  SettingsValidationError,
  validateSettingsPatch,
} from '../../src/shared/settingsSchema';
import { isReservedAccelerator } from '../../src/shared/accelerator';
import type { Settings } from '../../src/shared/types';

const clone = (): Settings => structuredClone(DEFAULT_SETTINGS);

describe('settingsSchema', () => {
  it('accepts the defaults unchanged', () => {
    expect(settingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips the defaults through parseSettings with no invalid fields', () => {
    const { settings, invalid } = parseSettingsWithReport(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(invalid).toEqual([]);
  });
});

describe('parseSettings fallbacks', () => {
  it.each([undefined, null, 42, 'settings', [1, 2], true])('returns defaults for %p', (raw) => {
    expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it('reports a non-object root', () => {
    expect(parseSettingsWithReport('x').invalid).toEqual(['(root)']);
    expect(parseSettingsWithReport(undefined).invalid).toEqual([]);
  });

  it('falls back per field, keeping valid siblings', () => {
    const raw = clone() as unknown as Record<string, any>;
    raw.profit.minProfitScrap = -5;
    raw.profit.minMargin = 0.2;
    raw.profit.useOrder = 'yolo';
    raw.notifications.minConfidence = 101;
    raw.app.closeToTray = 'yes';
    raw.ui.theme = 'neon';
    raw.contactUrl = 'https://example.com/me';
    const { settings, invalid } = parseSettingsWithReport(raw);
    expect(settings.profit.minProfitScrap).toBe(DEFAULT_SETTINGS.profit.minProfitScrap);
    expect(settings.profit.minMargin).toBe(0.2);
    expect(settings.profit.useOrder).toBe('conservative');
    expect(settings.notifications.minConfidence).toBe(DEFAULT_SETTINGS.notifications.minConfidence);
    expect(settings.app.closeToTray).toBe(true);
    expect(settings.ui.theme).toBe('system');
    expect(settings.contactUrl).toBe('https://example.com/me');
    expect(invalid.sort()).toEqual(
      ['app.closeToTray', 'notifications.minConfidence', 'profit.minProfitScrap', 'profit.useOrder', 'ui.theme'].sort(),
    );
  });

  it('replaces a whole group that is not an object', () => {
    const raw = { ...clone(), keyPrice: 'manual', liveFeed: [1] } as unknown;
    const { settings, invalid } = parseSettingsWithReport(raw);
    expect(settings.keyPrice).toEqual(DEFAULT_SETTINGS.keyPrice);
    expect(settings.liveFeed).toEqual(DEFAULT_SETTINGS.liveFeed);
    expect(invalid).toEqual(expect.arrayContaining(['keyPrice', 'liveFeed']));
  });

  it('fills missing fields silently (older settings files)', () => {
    const { settings, invalid } = parseSettingsWithReport({ contactUrl: 'mailto:me@example.com', profit: { minProfitScrap: 27 } });
    expect(settings.profit.minProfitScrap).toBe(27);
    expect(settings.profit.minMargin).toBe(DEFAULT_SETTINGS.profit.minMargin);
    expect(settings.connectors).toEqual(DEFAULT_SETTINGS.connectors);
    expect(invalid).toEqual([]);
  });

  it('drops unknown keys at every level', () => {
    const raw = { ...clone(), evil: 1, profit: { ...clone().profit, __proto__x: 1 } };
    const s = parseSettings(raw) as unknown as Record<string, unknown>;
    expect('evil' in s).toBe(false);
    expect('__proto__x' in (s.profit as object)).toBe(false);
  });

  it('keeps the valid entries of arrays instead of dropping the field', () => {
    const raw = clone() as unknown as Record<string, any>;
    raw.blocklist = ['76561198000000001', 'not-a-steamid', 42, '76561198000000001', ' 76561198000000002 '];
    raw.profit.notesKeywords = ['Painted', '', 7, 'spells', 'x'.repeat(65), 'painted'];
    const s = parseSettings(raw);
    expect(s.blocklist).toEqual(['76561198000000001', '76561198000000002']);
    expect(s.profit.notesKeywords).toEqual(['painted', 'spells']);
  });

  it('falls back when an array field is not an array', () => {
    const raw = clone() as unknown as Record<string, any>;
    raw.blocklist = 'all';
    expect(parseSettings(raw).blocklist).toEqual([]);
  });

  it('rejects non-integer and non-finite scrap amounts', () => {
    const raw = clone() as unknown as Record<string, any>;
    raw.profit.frictionScrap = 1.5;
    raw.keyPrice.manualScrap = Number.POSITIVE_INFINITY;
    raw.liveFeed.dailyCapBytes = -1;
    const s = parseSettings(raw);
    expect(s.profit.frictionScrap).toBe(0);
    expect(s.keyPrice.manualScrap).toBeNull();
    expect(s.liveFeed.dailyCapBytes).toBe(DEFAULT_SETTINGS.liveFeed.dailyCapBytes);
  });

  it('validates the permission record and watch folder', () => {
    const raw = clone() as unknown as Record<string, any>;
    raw.import.permission = { grantor: 'admin', contact: 'x' };
    raw.import.watchFolder = 'C:\\pages\0evil';
    const s = parseSettings(raw);
    expect(s.import.permission).toBeNull();
    expect(s.import.watchFolder).toBeNull();
  });

  // Touching a UNC path makes Windows authenticate to that host over SMB.
  it.each(['\\\\203.0.113.5\\x', '//host/share', '\\\\?\\C:\\pages', '\\\\host@80\\x', 'pages', '.\\pages', 'C:pages', '/tmp/pages'])(
    'rejects a watch folder that is not an absolute local-drive path: %s',
    (folder) => {
      const raw = clone() as unknown as Record<string, any>;
      raw.import.watchFolder = folder;
      expect(parseSettings(raw).import.watchFolder).toBeNull();
      const enabled = { import: { enabled: true, acknowledgedAt: 1, watchFolder: folder } };
      expect(() => applySettingsPatch(clone(), enabled)).toThrow(SettingsValidationError);
    },
  );

  it.each(['C:\\Users\\me\\Saved pages', 'd:/saved', 'Z:\\mapped'])('accepts a local-drive watch folder: %s', (folder) => {
    const next = applySettingsPatch(clone(), { import: { enabled: true, acknowledgedAt: 1, watchFolder: folder } });
    expect(next.import.watchFolder).toBe(folder);
    expect(applySettingsPatch(next, { import: { watchFolder: null } }).import.watchFolder).toBeNull();
  });

  it('turns import off when it was enabled without the acknowledgement', () => {
    const raw = clone() as unknown as Record<string, any>;
    raw.import.enabled = true;
    raw.import.acknowledgedAt = null;
    const { settings, invalid } = parseSettingsWithReport(raw);
    expect(settings.import.enabled).toBe(false);
    expect(invalid).toContain('import.enabled');

    raw.import.acknowledgedAt = 1_700_000_000_000;
    expect(parseSettings(raw).import.enabled).toBe(true);
  });

  it('rejects contact strings that would break the User-Agent', () => {
    for (const bad of ['me (bot)', 'a b', 'line\nbreak', 'naïve', 'x'.repeat(201)]) {
      const raw = { ...clone(), contactUrl: bad };
      expect(parseSettings(raw).contactUrl).toBe('');
    }
    expect(parseSettings({ contactUrl: '  https://steamcommunity.com/id/me  ' }).contactUrl).toBe(
      'https://steamcommunity.com/id/me',
    );
  });

  it('falls back to the default hotkey when the stored one is unusable', () => {
    const raw = clone() as unknown as Record<string, any>;
    raw.app.quickEntryHotkey = 'A';
    expect(parseSettings(raw).app.quickEntryHotkey).toBe(DEFAULT_SETTINGS.app.quickEntryHotkey);
    raw.app.quickEntryHotkey = '';
    expect(parseSettings(raw).app.quickEntryHotkey).toBe('');
  });

  it('returns fresh objects that do not alias DEFAULT_SETTINGS', () => {
    const s = parseSettings(undefined);
    s.profit.notesKeywords.push('mutated');
    s.blocklist.push('76561198000000001');
    expect(DEFAULT_SETTINGS.profit.notesKeywords).not.toContain('mutated');
    expect(DEFAULT_SETTINGS.blocklist).toEqual([]);
  });
});

describe('isValidAccelerator', () => {
  it.each([
    '',
    'CommandOrControl+Alt+F',
    'Ctrl+Shift+Space',
    'Alt+F5',
    'Ctrl+Alt+C',
    'F9',
    'Shift+F12',
    'Super+Q',
    'CmdOrCtrl+Plus',
    'Ctrl+num5',
    'Ctrl+/',
    'AltGr+Enter',
  ])('accepts %s', (a) => expect(isValidAccelerator(a)).toBe(true));

  it.each([
    'A',
    'Shift+A',
    'Ctrl+',
    '+A',
    'Ctrl++',
    'Ctrl+Ctrl+A',
    'Hyper+A',
    'Ctrl+Alt+FooBar',
    'Ctrl + A',
    'F25',
    'Ctrl+AB',
    'x'.repeat(70),
    // System and everyday app shortcuts: a global hotkey would take them from every app.
    'Alt+F4',
    'Ctrl+C',
    'CmdOrCtrl+V',
    'Control+x',
    'CommandOrControl+Z',
    'Alt+Tab',
    'Option+Space',
    'Ctrl+Esc',
    'Ctrl+Shift+Escape',
    'F5',
    'f11',
  ])('rejects %s', (a) => expect(isValidAccelerator(a)).toBe(false));

  it('reports system shortcuts as reserved, whatever the modifier alias', () => {
    expect(isReservedAccelerator('CmdOrCtrl+C')).toBe(true);
    expect(isReservedAccelerator('Alt+F4')).toBe(true);
    expect(isReservedAccelerator('CommandOrControl+Alt+F')).toBe(false);
    expect(isReservedAccelerator('')).toBe(false);
  });

  it('falls back to the default when settings.json holds a reserved shortcut', () => {
    const raw = structuredClone(DEFAULT_SETTINGS) as unknown as { app: { quickEntryHotkey: string } };
    raw.app.quickEntryHotkey = 'Ctrl+V';
    expect(parseSettings(raw).app.quickEntryHotkey).toBe(DEFAULT_SETTINGS.app.quickEntryHotkey);
    expect(() => applySettingsPatch(DEFAULT_SETTINGS, { app: { quickEntryHotkey: 'Ctrl+C' } })).toThrow();
  });
});

describe('validateSettingsPatch / applySettingsPatch', () => {
  it('treats null and undefined as an empty patch', () => {
    expect(validateSettingsPatch(undefined)).toEqual({});
    expect(validateSettingsPatch(null)).toEqual({});
  });

  it('merges a deep partial and leaves the base untouched', () => {
    const base = clone();
    const next = applySettingsPatch(base, { profit: { minProfitScrap: 18 }, networkPaused: true });
    expect(next.profit.minProfitScrap).toBe(18);
    expect(next.profit.minMargin).toBe(base.profit.minMargin);
    expect(next.networkPaused).toBe(true);
    expect(base.profit.minProfitScrap).toBe(9);
    expect(base.networkPaused).toBe(false);
  });

  it('replaces arrays instead of merging them', () => {
    const base = clone();
    base.blocklist = ['76561198000000001'];
    const next = applySettingsPatch(base, { blocklist: ['76561198000000002'] });
    expect(next.blocklist).toEqual(['76561198000000002']);
  });

  it('strips unknown keys from the patch', () => {
    const next = applySettingsPatch(clone(), { ui: { theme: 'dark', extra: 1 }, nope: true });
    expect(next.ui).toEqual({ theme: 'dark', density: 'comfortable' });
    expect('nope' in next).toBe(false);
  });

  it('throws SettingsValidationError with the field path', () => {
    expect(() => applySettingsPatch(clone(), { profit: { minMargin: 3 } })).toThrow(SettingsValidationError);
    expect(() => applySettingsPatch(clone(), { profit: { minMargin: 3 } })).toThrow(/profit\.minMargin/);
    expect(() => applySettingsPatch(clone(), { blocklist: ['nope'] })).toThrow(/blocklist\.0/);
    expect(() => applySettingsPatch(clone(), 'nonsense')).toThrow(SettingsValidationError);
    expect(() => applySettingsPatch(clone(), { app: { quickEntryHotkey: 'Q' } })).toThrow(/quickEntryHotkey/);
  });

  it('requires a complete permission record or null', () => {
    expect(() => applySettingsPatch(clone(), { import: { permission: { grantor: 'x' } } })).toThrow(SettingsValidationError);
    const rec = { grantor: 'admin', contact: 'admin@example.com', grantedAt: '2026-10-01', scope: 'personal import' };
    expect(applySettingsPatch(clone(), { import: { permission: rec } }).import.permission).toEqual(rec);
  });

  it('refuses enabling import without the acknowledgement, accepts both together', () => {
    expect(() => applySettingsPatch(clone(), { import: { enabled: true } })).toThrow(/acknowledgement/);
    const next = applySettingsPatch(clone(), { import: { enabled: true, acknowledgedAt: 1_700_000_000_000 } });
    expect(next.import.enabled).toBe(true);
  });

  it('allows clearing nullable values', () => {
    const base = applySettingsPatch(clone(), { keyPrice: { mode: 'manual', manualScrap: 600 } });
    const next = applySettingsPatch(base, { keyPrice: { manualScrap: null } });
    expect(next.keyPrice.manualScrap).toBeNull();
    expect(next.keyPrice.mode).toBe('manual');
  });
});

describe('v0.2 settings (reference age, suspect margin, notification controls)', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('has the documented defaults', () => {
    expect(DEFAULT_SETTINGS.profit.referenceMaxAgeMs).toBe(30 * DAY);
    expect(DEFAULT_SETTINGS.profit.suspectMargin).toBe(2);
    expect(DEFAULT_SETTINGS.notifications.inputKinds).toEqual(['user', 'import', 'rule']);
    expect(DEFAULT_SETTINGS.notifications.silent).toBe(false);
  });

  it('fills them in for a settings file written before v0.2, without reporting them', () => {
    const raw = clone() as unknown as Record<string, any>;
    delete raw.profit.referenceMaxAgeMs;
    delete raw.profit.suspectMargin;
    delete raw.notifications.inputKinds;
    delete raw.notifications.silent;
    const { settings, invalid } = parseSettingsWithReport(raw);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(invalid).toEqual([]);
  });

  it('falls back per field when a stored value is out of range', () => {
    const raw = clone() as unknown as Record<string, any>;
    raw.profit.referenceMaxAgeMs = 366 * DAY;
    raw.profit.suspectMargin = -1;
    raw.notifications.silent = 'yes';
    const { settings, invalid } = parseSettingsWithReport(raw);
    expect(settings.profit.referenceMaxAgeMs).toBe(30 * DAY);
    expect(settings.profit.suspectMargin).toBe(2);
    expect(settings.notifications.silent).toBe(false);
    expect(invalid.sort()).toEqual(['notifications.silent', 'profit.referenceMaxAgeMs', 'profit.suspectMargin']);
  });

  it('keeps the valid, de-duplicated input kinds', () => {
    const raw = clone() as unknown as Record<string, any>;
    raw.notifications.inputKinds = ['user', 'bogus', 'user', 'rule', 7];
    expect(parseSettings(raw).notifications.inputKinds).toEqual(['user', 'rule']);
    raw.notifications.inputKinds = [];
    expect(parseSettings(raw).notifications.inputKinds).toEqual([]);
  });

  it('adds notifications.holdings (v0.3): on by default, on for older files, off only when stored off', () => {
    expect(DEFAULT_SETTINGS.notifications.holdings).toBe(true);
    const old = clone() as unknown as Record<string, any>;
    delete old.notifications.holdings;
    const loaded = parseSettingsWithReport(old);
    expect(loaded.settings.notifications.holdings).toBe(true);
    expect(loaded.invalid).toEqual([]);
    const junk = clone() as unknown as Record<string, any>;
    junk.notifications.holdings = 'no';
    const parsed = parseSettingsWithReport(junk);
    expect(parsed.settings.notifications.holdings).toBe(true);
    expect(parsed.invalid).toEqual(['notifications.holdings']);
    const off = clone() as unknown as Record<string, any>;
    off.notifications.holdings = false;
    expect(parseSettings(off).notifications.holdings).toBe(false);
    expect(applySettingsPatch(clone(), { notifications: { holdings: false } }).notifications.holdings).toBe(false);
    expect(() => applySettingsPatch(clone(), { notifications: { holdings: 'off' } })).toThrow(/notifications.holdings/);
  });

  it('validates patches: ranges, 0 turning the margin guard off, and arrays replacing whole', () => {
    expect(applySettingsPatch(clone(), { profit: { suspectMargin: 0, referenceMaxAgeMs: 0 } }).profit).toMatchObject({ suspectMargin: 0, referenceMaxAgeMs: 0 });
    expect(applySettingsPatch(clone(), { profit: { suspectMargin: 1000, referenceMaxAgeMs: 365 * DAY } }).profit.suspectMargin).toBe(1000);
    expect(() => applySettingsPatch(clone(), { profit: { suspectMargin: 1001 } })).toThrow(/profit\.suspectMargin/);
    expect(() => applySettingsPatch(clone(), { profit: { referenceMaxAgeMs: 1.5 } })).toThrow(/profit\.referenceMaxAgeMs/);
    expect(applySettingsPatch(clone(), { notifications: { inputKinds: ['user'], silent: true } }).notifications).toMatchObject({ inputKinds: ['user'], silent: true });
    expect(() => applySettingsPatch(clone(), { notifications: { inputKinds: ['everything'] } })).toThrow(/notifications\.inputKinds/);
  });
});

describe('0.8 settings keys (exitReservePct, watches, buyTiming, ownSteamIds)', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `765611980000000${String(i).padStart(2, '0')}`);

  it('profit.exitReservePct: 0 to 0.5 accepted, outside refused; a file from before 0.8 reads 0, unreported', () => {
    for (const pct of [0, 0.25, 0.5]) expect(applySettingsPatch(clone(), { profit: { exitReservePct: pct } }).profit.exitReservePct).toBe(pct);
    expect(() => applySettingsPatch(clone(), { profit: { exitReservePct: 0.6 } })).toThrow(/profit\.exitReservePct/);
    expect(() => applySettingsPatch(clone(), { profit: { exitReservePct: -0.1 } })).toThrow(/profit\.exitReservePct/);
    const old = clone() as unknown as Record<string, any>;
    delete old.profit.exitReservePct;
    const loaded = parseSettingsWithReport(old);
    expect(loaded.settings.profit.exitReservePct).toBe(0);
    expect(loaded.invalid).toEqual([]);
  });

  it('notifications.watches: on by default, on for older files, off only when stored off', () => {
    expect(DEFAULT_SETTINGS.notifications.watches).toBe(true);
    const old = clone() as unknown as Record<string, any>;
    delete old.notifications.watches;
    const loaded = parseSettingsWithReport(old);
    expect(loaded.settings.notifications.watches).toBe(true);
    expect(loaded.invalid).toEqual([]);
    const junk = clone() as unknown as Record<string, any>;
    junk.notifications.watches = 'no';
    const parsed = parseSettingsWithReport(junk);
    expect(parsed.settings.notifications.watches).toBe(true);
    expect(parsed.invalid).toEqual(['notifications.watches']);
    const off = clone() as unknown as Record<string, any>;
    off.notifications.watches = false;
    expect(parseSettings(off).notifications.watches).toBe(false);
    expect(applySettingsPatch(clone(), { notifications: { watches: false } }).notifications.watches).toBe(false);
    expect(() => applySettingsPatch(clone(), { notifications: { watches: 'off' } })).toThrow(/notifications\.watches/);
  });

  it('notifications.buyTiming (D25): off by default, off for older files, on only when stored on', () => {
    expect(DEFAULT_SETTINGS.notifications.buyTiming).toBe(false);
    const old = clone() as unknown as Record<string, any>;
    delete old.notifications.buyTiming;
    const loaded = parseSettingsWithReport(old);
    expect(loaded.settings.notifications.buyTiming).toBe(false);
    expect(loaded.invalid).toEqual([]);
    const junk = clone() as unknown as Record<string, any>;
    junk.notifications.buyTiming = 'yes';
    const parsed = parseSettingsWithReport(junk);
    expect(parsed.settings.notifications.buyTiming).toBe(false);
    expect(parsed.invalid).toEqual(['notifications.buyTiming']);
    const on = clone() as unknown as Record<string, any>;
    on.notifications.buyTiming = true;
    expect(parseSettings(on).notifications.buyTiming).toBe(true);
    expect(applySettingsPatch(clone(), { notifications: { buyTiming: true } }).notifications.buyTiming).toBe(true);
    expect(() => applySettingsPatch(clone(), { notifications: { buyTiming: 1 } })).toThrow(/notifications\.buyTiming/);
  });

  it('ownSteamIds: up to 10 SteamID64s; an 11th or a non-id is refused; a 0.7.4 file reads [] and junk is dropped', () => {
    expect(applySettingsPatch(clone(), { ownSteamIds: ids(10) }).ownSteamIds).toEqual(ids(10));
    expect(applySettingsPatch(clone(), { ownSteamIds: [] }).ownSteamIds).toEqual([]);
    expect(() => applySettingsPatch(clone(), { ownSteamIds: ids(11) })).toThrow(/ownSteamIds/);
    expect(() => applySettingsPatch(clone(), { ownSteamIds: ['me'] })).toThrow(/ownSteamIds\.0/);
    const old = clone() as unknown as Record<string, any>;
    delete old.ownSteamIds;
    const loaded = parseSettingsWithReport(old);
    expect(loaded.settings.ownSteamIds).toEqual([]);
    expect(loaded.invalid).toEqual([]);
    const junk = clone() as unknown as Record<string, any>;
    junk.ownSteamIds = ['76561198000000001', 'not-a-steamid', 42, '76561198000000001', ' 76561198000000002 '];
    expect(parseSettings(junk).ownSteamIds).toEqual(['76561198000000001', '76561198000000002']);
  });
});
