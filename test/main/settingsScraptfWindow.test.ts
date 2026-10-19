// F21: settings.scraptfWindow. Off by default; the lenient load (settings.json) falls back per field and
// never loads the window on without its gates; the strict setter refuses turning it on without saved-page
// import, the import acknowledgement and the window's own acknowledgement, and turns it off when one goes.

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { SCRAPTF_WINDOW_NEEDS_ACK, SCRAPTF_WINDOW_NEEDS_IMPORT } from '../../src/shared/scraptfWindowPolicy';
import { applySettingsPatch, parseSettingsWithReport, SettingsValidationError, validateSettingsPatch } from '../../src/shared/settingsSchema';
import type { Settings } from '../../src/shared/types';

const T = 1_791_958_000_000;
const importOn = { import: { enabled: true, acknowledgedAt: T } };

function on(): Settings {
  return applySettingsPatch(applySettingsPatch(DEFAULT_SETTINGS, importOn), { scraptfWindow: { acknowledgedAt: T + 1, enabled: true } });
}

describe('defaults', () => {
  it('start off, read on load, links to the browser, an in-memory session', () => {
    expect(DEFAULT_SETTINGS.scraptfWindow).toEqual({ enabled: false, acknowledgedAt: null, keepLoggedIn: false, readOnLoad: true, openLinksInWindow: false });
    expect(parseSettingsWithReport(undefined).settings.scraptfWindow).toEqual(DEFAULT_SETTINGS.scraptfWindow);
  });
});

describe('lenient load', () => {
  it('fills a file from before 0.7 with the defaults, silently', () => {
    const raw = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
    delete raw['scraptfWindow'];
    const r = parseSettingsWithReport(raw);
    expect(r.settings.scraptfWindow).toEqual(DEFAULT_SETTINGS.scraptfWindow);
    expect(r.invalid).toEqual([]);
  });

  it('falls back per field and keeps the valid ones', () => {
    const r = parseSettingsWithReport({ scraptfWindow: { enabled: 'yes', acknowledgedAt: -5, keepLoggedIn: true, readOnLoad: false, openLinksInWindow: 1 } });
    expect(r.settings.scraptfWindow).toEqual({ enabled: false, acknowledgedAt: null, keepLoggedIn: true, readOnLoad: false, openLinksInWindow: false });
    expect(r.invalid).toEqual(expect.arrayContaining(['scraptfWindow.enabled', 'scraptfWindow.acknowledgedAt', 'scraptfWindow.openLinksInWindow']));
    expect(parseSettingsWithReport({ scraptfWindow: 'on' }).invalid).toContain('scraptfWindow');
  });

  it('loads the window off when a gate is missing', () => {
    const noImport = parseSettingsWithReport({ scraptfWindow: { enabled: true, acknowledgedAt: T } });
    expect(noImport.settings.scraptfWindow.enabled).toBe(false);
    expect(noImport.invalid).toContain('scraptfWindow.enabled');
    const noAck = parseSettingsWithReport({ ...importOn, scraptfWindow: { enabled: true, acknowledgedAt: null } });
    expect(noAck.settings.scraptfWindow.enabled).toBe(false);
    // Import on without its acknowledgement loads import off, and so the window too.
    const importNoAck = parseSettingsWithReport({ import: { enabled: true, acknowledgedAt: null }, scraptfWindow: { enabled: true, acknowledgedAt: T } });
    expect(importNoAck.settings.import.enabled).toBe(false);
    expect(importNoAck.settings.scraptfWindow.enabled).toBe(false);
    const ok = parseSettingsWithReport({ ...importOn, scraptfWindow: { enabled: true, acknowledgedAt: T } });
    expect(ok.settings.scraptfWindow.enabled).toBe(true);
    expect(ok.invalid).toEqual([]);
  });
});

describe('strict setter', () => {
  it('validates the patch shape', () => {
    expect(() => validateSettingsPatch({ scraptfWindow: { enabled: 'yes' } })).toThrow(SettingsValidationError);
    expect(() => validateSettingsPatch({ scraptfWindow: { acknowledgedAt: -1 } })).toThrow(/scraptfWindow\.acknowledgedAt/);
    expect(validateSettingsPatch({ scraptfWindow: { readOnLoad: false } })).toEqual({ scraptfWindow: { readOnLoad: false } });
    // Unknown keys are dropped, never stored.
    expect(validateSettingsPatch({ scraptfWindow: { userAgent: 'Mozilla/5.0' } })).toEqual({ scraptfWindow: {} });
  });

  it('refuses turning the window on without import, its acknowledgement and the window acknowledgement', () => {
    expect(() => applySettingsPatch(DEFAULT_SETTINGS, { scraptfWindow: { enabled: true, acknowledgedAt: T } })).toThrow(`Invalid settings: ${SCRAPTF_WINDOW_NEEDS_IMPORT}`);
    const imp = applySettingsPatch(DEFAULT_SETTINGS, importOn);
    expect(() => applySettingsPatch(imp, { scraptfWindow: { enabled: true } })).toThrow(`Invalid settings: ${SCRAPTF_WINDOW_NEEDS_ACK}`);
    // All in one patch is fine: the merged result has every gate.
    const all = applySettingsPatch(DEFAULT_SETTINGS, { ...importOn, scraptfWindow: { enabled: true, acknowledgedAt: T } });
    expect(all.scraptfWindow.enabled).toBe(true);
    expect(on().scraptfWindow).toMatchObject({ enabled: true, acknowledgedAt: T + 1 });
  });

  it('turns the window off with a gate instead of refusing the change', () => {
    expect(applySettingsPatch(on(), { import: { enabled: false } }).scraptfWindow.enabled).toBe(false);
    expect(applySettingsPatch(on(), { scraptfWindow: { acknowledgedAt: null } }).scraptfWindow.enabled).toBe(false);
    // Turning it on again in that same patch is refused.
    expect(() => applySettingsPatch(on(), { import: { enabled: false }, scraptfWindow: { enabled: true } })).toThrow(SCRAPTF_WINDOW_NEEDS_IMPORT);
  });

  it('changes the other switches freely, on or off', () => {
    const s = applySettingsPatch(DEFAULT_SETTINGS, { scraptfWindow: { keepLoggedIn: true, readOnLoad: false, openLinksInWindow: true, acknowledgedAt: T } });
    expect(s.scraptfWindow).toEqual({ enabled: false, acknowledgedAt: T, keepLoggedIn: true, readOnLoad: false, openLinksInWindow: true });
    expect(applySettingsPatch(on(), { scraptfWindow: { enabled: false } }).scraptfWindow.enabled).toBe(false);
  });
});
