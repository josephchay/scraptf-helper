import { describe, expect, it } from 'vitest';
import {
  accelLabel,
  confidenceLevelOf,
  connTone,
  describeRuleFilter,
  errorMessage,
  flagInfo,
  fmtAge,
  fmtAgo,
  fmtBytes,
  fmtCountdown,
  fmtDuration,
  fmtInt,
  fmtKeysDecimal,
  fmtKeysMetal,
  fmtMoney,
  fmtPct,
  fmtRefOnly,
  fmtSignedMoney,
  fromDateTimeLocal,
  isValidContactUrl,
  itemTags,
  keyPriceSummary,
  paintHex,
  parseSteamIdList,
  qualityClass,
  qualityOf,
  toDateTimeLocal,
  truncate,
} from '../../src/renderer/format';

const KEY = 568; // 63.11 ref

describe('money', () => {
  it('formats scrap as ref and keys', () => {
    expect(fmtMoney(12, null)).toBe('1.33 ref');
    expect(fmtMoney(KEY + 46, KEY)).toBe('1 key 5.11 ref');
    expect(fmtMoney(2 * KEY, KEY)).toBe('2 keys');
    expect(fmtMoney(100, KEY)).toBe('11.11 ref');
    expect(fmtMoney(null, KEY)).toBe('—');
    expect(fmtMoney(undefined, KEY)).toBe('—');
    expect(fmtMoney(12, 0)).toBe('1.33 ref');
  });

  it('signs gains but not losses twice', () => {
    expect(fmtSignedMoney(12, KEY)).toBe('+1.33 ref');
    expect(fmtSignedMoney(-12, KEY)).toBe('-1.33 ref');
    expect(fmtSignedMoney(0, KEY)).toBe('0.00 ref');
    expect(fmtSignedMoney(-(KEY + 9), KEY)).toBe('-1 key 1.00 ref');
    expect(fmtSignedMoney(null, KEY)).toBe('—');
  });

  it('shows refined only and decimal keys', () => {
    expect(fmtRefOnly(KEY)).toBe('63.11 ref');
    expect(fmtRefOnly(null)).toBe('—');
    expect(fmtRefOnly(175918)).toBe('19,546.44 ref');
    expect(fmtRefOnly(-12)).toBe('-1.33 ref');
    expect(fmtKeysDecimal(KEY, KEY)).toBe('1.00 key');
    expect(fmtKeysDecimal(KEY * 2.5, KEY)).toBe('2.50 keys');
    expect(fmtKeysDecimal(100, null)).toBe('—');
  });

  it('formats explicit keys + metal without converting', () => {
    expect(fmtKeysMetal(2, 46)).toBe('2 keys 5.11 ref');
    expect(fmtKeysMetal(0, 0)).toBe('0.00 ref');
    expect(fmtKeysMetal(1, 0)).toBe('1 key');
  });

  it('formats percentages and integers', () => {
    expect(fmtPct(0.125)).toBe('12.5%');
    expect(fmtPct(-0.04, 0)).toBe('-4%');
    expect(fmtPct(51.6438)).toBe('5164%');
    expect(fmtPct(null)).toBe('—');
    expect(fmtPct(Number.NaN)).toBe('—');
    expect(fmtInt(1234567)).toBe('1,234,567');
  });
});

describe('time', () => {
  it('formats compact ages', () => {
    expect(fmtAge(0)).toBe('now');
    expect(fmtAge(-50)).toBe('now');
    expect(fmtAge(42_000)).toBe('42 s');
    expect(fmtAge(12 * 60_000 + 5_000)).toBe('12 min');
    expect(fmtAge(3 * 3_600_000)).toBe('3 h');
    expect(fmtAge(2 * 86_400_000)).toBe('2 d');
    expect(fmtAge(90 * 86_400_000)).toBe('3 mo');
    expect(fmtAge(null)).toBe('—');
  });

  it('formats relative times in both directions', () => {
    const now = 1_800_000_000_000;
    expect(fmtAgo(now - 120_000, now)).toBe('2 min ago');
    expect(fmtAgo(now + 40_000, now)).toBe('in 40 s');
    expect(fmtAgo(now - 1_000, now)).toBe('just now');
    expect(fmtAgo(null, now)).toBe('—');
  });

  it('formats countdowns and durations', () => {
    const now = 1_000_000;
    expect(fmtCountdown(now + 9_200, now)).toBe('10 s');
    expect(fmtCountdown(now + 65_000, now)).toBe('1 min 05 s');
    expect(fmtCountdown(now + 2 * 3_600_000 + 600_000, now)).toBe('2 h 10 min');
    expect(fmtCountdown(now - 5_000, now)).toBe('0 s');
    expect(fmtDuration(140)).toBe('140 ms');
    expect(fmtDuration(1400)).toBe('1.4 s');
  });

  it('round-trips datetime-local values', () => {
    const t = new Date(2026, 9, 14, 14, 3).getTime();
    expect(toDateTimeLocal(t)).toBe('2026-10-14T14:03');
    expect(fromDateTimeLocal('2026-10-14T14:03')).toBe(t);
    expect(fromDateTimeLocal('')).toBeNull();
    expect(fromDateTimeLocal('nope')).toBeNull();
  });
});

describe('bytes', () => {
  it('uses decimal units like the data cap setting', () => {
    expect(fmtBytes(999)).toBe('999 B');
    expect(fmtBytes(1500)).toBe('1.50 KB');
    expect(fmtBytes(12_000_000_000)).toBe('12.0 GB');
    expect(fmtBytes(3_180_000_000)).toBe('3.18 GB');
    expect(fmtBytes(250_000_000)).toBe('250 MB');
    expect(fmtBytes(-1)).toBe('—');
  });
});

describe('items', () => {
  it('reads quality from the SKU', () => {
    expect(qualityOf('378;5;u13')).toBe(5);
    expect(qualityOf('200;11;australium;kt-3')).toBe(11);
    expect(qualityClass(5)).toBe('q-5');
    expect(qualityClass(99)).toBe('q-6');
  });

  it('builds tags for effects, killstreaks, australium, festive, paint and wear', () => {
    const unusual = itemTags('378;5;u13');
    expect(unusual).toHaveLength(1);
    expect(unusual[0]).toMatchObject({ kind: 'effect', label: '★ Burning Flames' });
    expect(itemTags('378;5;u13', 'Burning Flames Team Captain')[0]).toMatchObject({ label: '★', title: 'Unusual effect Burning Flames (#13)' });

    const aussie = itemTags('200;11;australium;kt-3').map((t) => t.kind);
    expect(aussie).toEqual(['killstreak', 'australium']);
    expect(itemTags('200;11;australium;kt-3')[0]!.label).toBe('Pro KS');

    const festive = itemTags('205;11;festive');
    expect(festive.map((t) => t.kind)).toEqual(['festive']);

    const painted = itemTags('378;6;p15185211');
    expect(painted[0]).toMatchObject({ kind: 'paint', label: 'Australium Gold', color: '#E7B53B' });
    expect(itemTags('378;6;p15185211', 'Team Captain (Paint: Australium Gold)')[0]).toMatchObject({ label: '', title: 'Paint: Australium Gold' });

    const skin = itemTags('15141;15;u701;w1;pk300;strange').map((t) => t.label);
    expect(skin).toContain('★ Hot');
    expect(skin).toContain('Strange');
    expect(skin).toContain('FN');

    expect(itemTags('357;6;uncraftable').map((t) => t.kind)).toEqual(['uncraftable']);
    expect(itemTags('5021;6')).toEqual([]);
    expect(itemTags('1;5;u99999')[0]!.label).toBe('★ #99999');
  });

  it('converts paint decimals to hex', () => {
    expect(paintHex(15185211)).toBe('#E7B53B');
    expect(paintHex(1315860)).toBe('#141414');
    expect(paintHex(0)).toBe('#000000');
  });
});

describe('labels', () => {
  it('maps confidence scores with the engine thresholds', () => {
    expect(confidenceLevelOf(70)).toBe('high');
    expect(confidenceLevelOf(69)).toBe('medium');
    expect(confidenceLevelOf(45)).toBe('medium');
    expect(confidenceLevelOf(44)).toBe('low');
  });

  it('gives connection states a tone', () => {
    expect(connTone('live')).toBe('good');
    expect(connTone('backoff')).toBe('warn');
    expect(connTone('blocked')).toBe('bad');
    expect(connTone('off')).toBe('muted');
  });

  it('explains known flags and humanises unknown ones', () => {
    expect(flagInfo('attribute-specific').tone).toBe('bad');
    expect(flagInfo('notes-flag').label).toBe('Note flag');
    expect(flagInfo('brand-new_flag')).toMatchObject({ label: 'Brand new flag', tone: 'muted' });
    // Every flag the domain emits has a written label.
    for (const f of ['all-outliers', 'background-check', 'duplicate', 'not-buy-order', 'any-effect', 'unusual-risk', 'unverified-orders']) {
      expect(flagInfo(f).help).not.toBe(flagInfo(f).label);
    }
  });

  it('describes rule filters in plain language', () => {
    expect(describeRuleFilter({})).toBe('Every item');
    expect(describeRuleFilter({ categories: ['hats'], qualities: [6], craftable: true, hasEffect: false })).toBe(
      'Hats & cosmetics · Unique · craftable · no unusual effect',
    );
    expect(describeRuleFilter({ killstreak: [0, 2], nameContains: ' cap ' })).toBe('no killstreak or specialized killstreak · name contains "cap"');
  });

  it('summarises the key price for the top bar', () => {
    const now = 10_000_000;
    expect(keyPriceSummary(null, now)).toMatchObject({ value: '—', stale: true });
    expect(keyPriceSummary({ valueScrap: KEY, source: 'pricedb', observedAt: now - 20 * 60_000, stale: false, quotes: [], scraptfFromList: null }, now)).toEqual({
      value: '63.11 ref',
      source: 'PriceDB',
      age: '20 min',
      stale: false,
    });
  });
});

describe('misc', () => {
  it('strips the Electron IPC wrapper from error messages', () => {
    expect(errorMessage(new Error("Error invoking remote method 'rpc': Error: Import is turned off."))).toBe('Import is turned off.');
    expect(errorMessage(new Error('RateLimitedError: slow down'))).toBe('slow down');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage({ a: 1 })).toBe('{"a":1}');
    expect(errorMessage(new Error(''))).toBe('Unknown error');
  });

  it('parses blocklists into SteamID64s', () => {
    const r = parseSteamIdList('76561198000000001\n76561198000000002, 76561198000000001 nope 123');
    expect(r.ids).toEqual(['76561198000000001', '76561198000000002']);
    expect(r.invalid).toEqual(['nope', '123']);
    expect(parseSteamIdList('  ')).toEqual({ ids: [], invalid: [] });
  });

  it('accepts https and mailto contacts only', () => {
    expect(isValidContactUrl('https://steamcommunity.com/id/me')).toBe(true);
    expect(isValidContactUrl('mailto:me@example.com')).toBe(true);
    expect(isValidContactUrl('http://example.com')).toBe(false);
    expect(isValidContactUrl('https://user:pw@example.com')).toBe(false);
    expect(isValidContactUrl('https://localhost')).toBe(false);
    expect(isValidContactUrl('')).toBe(false);
  });

  it('labels accelerators the Windows way', () => {
    expect(accelLabel('CommandOrControl+Alt+F')).toBe('Ctrl+Alt+F');
    expect(accelLabel('Super+Shift+Q')).toBe('Win+Shift+Q');
  });

  it('truncates long notes', () => {
    expect(truncate('a   b', 10)).toBe('a b');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });
});
