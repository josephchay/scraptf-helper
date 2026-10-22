import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isValidContactUrl } from '../../src/renderer/format';
import {
  BUY_TIMING_NOTIFY_LABEL,
  buyTimingNotifyHint,
  CHECK_HOTKEY_CONFLICT_ERROR,
  checkHotkeyStatus,
  checkNotifyHint,
  checkWatchHint,
  CONTACT_ERROR,
  daysTextToMs,
  EXIT_RESERVE_PCT,
  exitReserveHint,
  HOLDINGS_NOTIFY_LABEL,
  holdingsNotifyHint,
  HOTKEY_HINT_ERROR,
  inputKindsHint,
  MIN_MARGIN_PCT,
  MIN_PROFIT_PCT_OF_COST,
  msToDaysText,
  NEW_ON_SCRAPTF_NOTIFY_LABEL,
  newOnScraptfNotifyHint,
  NOTIFY_INPUT_KINDS,
  numberValidator,
  pctTextToRatio,
  QUICK_HOTKEY_CONFLICT_ERROR,
  quickHotkeyProblem,
  ratioToPctText,
  REFERENCE_MAX_AGE_DAYS,
  referenceAgeHint,
  scraptfKeyHealthRows,
  scraptfKeyTipText,
  scraptfListKeyInUse,
  scraptfListKeySources,
  scraptfListKeyView,
  setInputKind,
  SUSPECT_MARGIN_PCT,
  suspectMarginHint,
  userAgentPreview,
  validateCheckHotkey,
  validateContactUrl,
  validateHotkey,
  validateQuickEntryHotkey,
  WATCHES_NOTIFY_LABEL,
  watchesNotifyHint,
} from '../../src/renderer/settingsFields';
import { CHECK_PRIVACY_SENTENCE, CHECK_SAMPLE_TEXT } from '../../src/shared/check';
import { BANK_STOCK_MAX_NOTIFICATIONS, BANK_STOCK_NOTIFY_DEDUP_MS } from '../../src/shared/bankStock';
import { AppProvider } from '../../src/renderer/hooks/appContext';
import { createMockBridge } from '../../src/renderer/mock';
import { KeyPriceTable } from '../../src/renderer/pages/HealthPage';
import { NotifySection } from '../../src/renderer/pages/SettingsPage';
import { effectiveScraptfKey, selectKeyPrice } from '../../src/service/domain/keyprice';
import { usableReferences } from '../../src/service/domain/pricing';
import { buildUserAgent } from '../../src/service/net/http';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { applySettingsPatch, isValidAccelerator } from '../../src/shared/settingsSchema';
import type { InputKind, ScraptfListKey, Settings } from '../../src/shared/types';

/** True when main would accept the patch (the settings store applies exactly this). */
function mainAccepts(patch: Parameters<typeof applySettingsPatch>[1]): boolean {
  try {
    applySettingsPatch(DEFAULT_SETTINGS, patch);
    return true;
  } catch {
    return false;
  }
}

describe('profit percentage fields agree with the settings schema', () => {
  it('rejects a minimum margin above 100 % locally instead of letting main reject it', () => {
    const v = numberValidator(MIN_MARGIN_PCT.min, MIN_MARGIN_PCT.max);
    expect(v('150')).toBe('Between 0 and 100.');
    expect(v('1000')).not.toBeNull();
    expect(v('-1')).not.toBeNull();
    expect(v('abc')).toBe('Enter a number.');
    expect(v('8')).toBeNull();
    expect(v('100')).toBeNull();
    // Every value the field accepts is one main accepts.
    expect(mainAccepts({ profit: { minMargin: MIN_MARGIN_PCT.max / 100 } })).toBe(true);
    expect(mainAccepts({ profit: { minMargin: MIN_MARGIN_PCT.min / 100 } })).toBe(true);
    expect(mainAccepts({ profit: { minMargin: 1.5 } })).toBe(false);
  });

  it('rejects a cleared field instead of saving 0 (Number("") is 0)', () => {
    for (const v of [numberValidator(0, 100), numberValidator(MIN_MARGIN_PCT.min, MIN_MARGIN_PCT.max), numberValidator(0, 100000)]) {
      expect(v('')).toBe('Enter a number.');
      expect(v('   ')).toBe('Enter a number.');
    }
    // Same answer whatever the minimum is.
    expect(numberValidator(0.1, 100)('')).toBe('Enter a number.');
    expect(numberValidator(0, 100, true)('')).toBeNull();
    expect(numberValidator(0, 100, true)('  ')).toBeNull();
  });

  it('accepts plain decimals only, not the other forms Number() reads', () => {
    const v = numberValidator(0, 100000);
    for (const ok of ['0', '8', '8.5', '.5', '5.', ' 12 ', '+3']) expect(v(ok), ok).toBeNull();
    for (const bad of ['0x10', '1e3', 'Infinity', '1,5', '1 2', '-']) expect(v(bad), bad).toBe('Enter a number.');
  });

  it('keeps the "% of cost" field inside the schema range', () => {
    expect(mainAccepts({ profit: { minProfitPctOfCost: MIN_PROFIT_PCT_OF_COST.max / 100 } })).toBe(true);
    expect(mainAccepts({ profit: { minProfitPctOfCost: MIN_PROFIT_PCT_OF_COST.min / 100 } })).toBe(true);
  });
});

describe('reference age and suspect margin fields (F4, F5)', () => {
  const DAY = 86_400_000;

  it('shows referenceMaxAgeMs in days and saves integer milliseconds main accepts', () => {
    const v = numberValidator(REFERENCE_MAX_AGE_DAYS.min, REFERENCE_MAX_AGE_DAYS.max);
    expect(msToDaysText(DEFAULT_SETTINGS.profit.referenceMaxAgeMs)).toBe('30');
    expect(msToDaysText(36 * 3_600_000)).toBe('1.5');
    for (const ok of ['0', '1', '30', '0.5', '365']) {
      expect(v(ok), ok).toBeNull();
      const ms = daysTextToMs(ok);
      expect(Number.isInteger(ms), ok).toBe(true);
      expect(mainAccepts({ profit: { referenceMaxAgeMs: ms } }), ok).toBe(true);
    }
    expect(daysTextToMs('30')).toBe(30 * DAY);
    expect(daysTextToMs('1.333333')).toBe(Math.round(1.333333 * DAY));
    for (const bad of ['366', '-1', '1e2', 'abc']) expect(v(bad), bad).not.toBeNull();
    expect(mainAccepts({ profit: { referenceMaxAgeMs: daysTextToMs('366') } })).toBe(false);
  });

  it('shows suspectMargin as a percentage, with 0 turning the guard off', () => {
    const v = numberValidator(SUSPECT_MARGIN_PCT.min, SUSPECT_MARGIN_PCT.max);
    expect(ratioToPctText(DEFAULT_SETTINGS.profit.suspectMargin)).toBe('200');
    expect(pctTextToRatio('200')).toBe(2);
    expect(pctTextToRatio('0')).toBe(0);
    for (const ok of ['0', '150', '200', '33.33', '100000']) {
      expect(v(ok), ok).toBeNull();
      expect(mainAccepts({ profit: { suspectMargin: pctTextToRatio(ok) } }), ok).toBe(true);
    }
    expect(v('100001')).toBe('Between 0 and 100000.');
    expect(mainAccepts({ profit: { suspectMargin: pctTextToRatio('100001') } })).toBe(false);
    expect(ratioToPctText(pctTextToRatio('33.33'))).toBe('33.33');
    expect(suspectMarginHint(0)).toMatch(/^Off\./);
    expect(suspectMarginHint(2)).toMatch(/0 turns the check off/);
  });

  it('never commits 0 from a cleared field (0 would ignore every reference or turn the guard off)', () => {
    for (const v of [numberValidator(REFERENCE_MAX_AGE_DAYS.min, REFERENCE_MAX_AGE_DAYS.max), numberValidator(SUSPECT_MARGIN_PCT.min, SUSPECT_MARGIN_PCT.max)]) {
      expect(v('')).toBe('Enter a number.');
      expect(v('  ')).toBe('Enter a number.');
    }
    expect(referenceAgeHint(0)).toMatch(/every PriceDB price with a known age is ignored/);
    expect(referenceAgeHint(30 * DAY)).toMatch(/at least a year/);
    expect(referenceAgeHint(30 * DAY)).not.toMatch(/ignored\.$/);
  });

  it('the 0-days hint matches what the engine does with references', () => {
    const now = Date.UTC(2026, 9, 15);
    const dated = { pricedb: { buyScrap: 100, sellScrap: 120, time: null, ageMs: 60_000 }, community: { valueScrap: 110, valueHighScrap: null, lastUpdate: now / 1000 - 60 } };
    // At 0 PriceDB is dropped; a minute-old community price keeps its one-year floor.
    expect(usableReferences(dated, daysTextToMs('0'), now).references).toEqual({ pricedb: null, community: dated.community });
    // A price of unknown age is kept, hence "with a known age".
    const undated = { pricedb: { buyScrap: 100, sellScrap: 120, time: null, ageMs: null }, community: null };
    expect(usableReferences(undated, daysTextToMs('0'), now).references.pricedb).not.toBeNull();
    expect(usableReferences(dated, daysTextToMs('30'), now).stale).toEqual([]);
  });
});

describe('notification controls (F6)', () => {
  it('ticks and unticks input kinds in a stable order without duplicates', () => {
    expect(NOTIFY_INPUT_KINDS.map((o) => o.value)).toEqual(DEFAULT_SETTINGS.notifications.inputKinds);
    expect(setInputKind(['user', 'import', 'rule'], 'rule', false)).toEqual(['user', 'import']);
    expect(setInputKind(['import'], 'user', true)).toEqual(['user', 'import']);
    expect(setInputKind(['rule', 'user'], 'import', true)).toEqual(['user', 'import', 'rule']);
    expect(setInputKind(['user', 'user'] as InputKind[], 'user', true)).toEqual(['user']);
    expect(setInputKind(['user'], 'user', false)).toEqual([]);
  });

  it('every combination is one main accepts, including none', () => {
    const kinds: InputKind[] = ['user', 'import', 'rule'];
    for (let mask = 0; mask < 8; mask++) {
      let cur: InputKind[] = [];
      kinds.forEach((k, i) => {
        cur = setInputKind(cur, k, (mask & (1 << i)) !== 0);
      });
      expect(mainAccepts({ notifications: { inputKinds: cur } }), cur.join(',')).toBe(true);
    }
    expect(inputKindsHint([])).toMatch(/no desktop notifications/);
    expect(inputKindsHint(['user'])).not.toMatch(/no desktop notifications/);
  });

  it('saves the silent switch', () => {
    expect(mainAccepts({ notifications: { silent: true } })).toBe(true);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { notifications: { silent: true } }).notifications.silent).toBe(true);
  });

  it('saves the holdings sell alert switch (F11), on by default', () => {
    expect(DEFAULT_SETTINGS.notifications.holdings).toBe(true);
    expect(HOLDINGS_NOTIFY_LABEL).toBe('Notify when something you hold can be sold at a profit');
    for (const holdings of [false, true]) {
      expect(mainAccepts({ notifications: { holdings } })).toBe(true);
      expect(applySettingsPatch(DEFAULT_SETTINGS, { notifications: { holdings } }).notifications.holdings).toBe(holdings);
    }
    // Only that switch changes; the rest of the section stays.
    const off = applySettingsPatch(DEFAULT_SETTINGS, { notifications: { holdings: false } }).notifications;
    expect({ ...off, holdings: true }).toEqual(DEFAULT_SETTINGS.notifications);
  });

  it('explains the holdings alert, and that it needs desktop notifications on', () => {
    expect(holdingsNotifyHint(true)).toMatch(/clear your profit thresholds/);
    expect(holdingsNotifyHint(true)).not.toMatch(/off/);
    expect(holdingsNotifyHint(false)).toMatch(/^Desktop notifications are off/);
  });

  it('puts the switch in the Notifications section', () => {
    const page = readFileSync(new URL('../../src/renderer/pages/SettingsPage.tsx', import.meta.url), 'utf8');
    const section = page.slice(page.indexOf('function NotifySection'), page.indexOf('function FeedSection'));
    expect(section).toContain('<Toggle checked={n.holdings} onChange={(holdings) => void set({ holdings })} label={HOLDINGS_NOTIFY_LABEL} description={holdingsNotifyHint(n.enabled)} />');
  });
});

describe('quick-entry hotkey field', () => {
  it('allows clearing the field to turn the global shortcut off', () => {
    expect(validateHotkey('')).toBeNull();
    expect(validateHotkey('   ')).toBeNull();
    expect(mainAccepts({ app: { quickEntryHotkey: '' } })).toBe(true);
  });

  it.each(['CommandOrControl+Alt+F', 'Ctrl+Alt+/', 'F9', 'Alt+Shift+Space', 'Ctrl+Alt+Up'])('accepts %s like main does', (a) => {
    expect(validateHotkey(a)).toBeNull();
    expect(mainAccepts({ app: { quickEntryHotkey: a } })).toBe(true);
  });

  it.each(['Shift+A', 'Foo+Bar', 'Ctrl+Alt', 'Ctrl++', 'A'])('rejects %s like main does', (a) => {
    expect(validateHotkey(a)).toBe(HOTKEY_HINT_ERROR);
    expect(mainAccepts({ app: { quickEntryHotkey: a } })).toBe(false);
  });

  it('explains a reserved system shortcut', () => {
    expect(isValidAccelerator('Ctrl+C')).toBe(false);
    expect(validateHotkey('Ctrl+C')).toMatch(/system or everyday shortcut/);
  });

  it('never disagrees with the schema', () => {
    const samples = ['', 'Ctrl+Alt+F', 'CmdOrCtrl+Shift+K', 'Super+F', 'Shift+F5', 'Shift+1', 'Alt+Shift', 'ctrl+alt+f', 'Ctrl+Alt+F25', 'Ctrl+Alt+Num5', 'Ctrl+Ctrl+F', 'Ctrl+C', 'Alt+F4'];
    for (const a of samples) expect(validateHotkey(a) === null, a).toBe(mainAccepts({ app: { quickEntryHotkey: a } }));
  });
});

describe('contact URL field', () => {
  const long = `https://example.com/${'a'.repeat(190)}`;

  it.each([
    'https://steamcommunity.com/id/jöe',
    'https://en.wikipedia.org/wiki/User:Me_(x)',
    'mailto:a(b)@x.com',
    long,
  ])('rejects %s, which main would reject', (u) => {
    expect(isValidContactUrl(u)).toBe(false);
    expect(validateContactUrl(u)).toBe(CONTACT_ERROR);
    expect(mainAccepts({ contactUrl: u })).toBe(false);
  });

  it.each(['https://steamcommunity.com/id/you', 'mailto:you@example.com', 'https://steamcommunity.com/id/j%C3%B6e', ''])('accepts %s, which main accepts', (u) => {
    expect(validateContactUrl(u)).toBeNull();
    expect(mainAccepts({ contactUrl: u })).toBe(true);
  });

  it('previews the User-Agent the service really sends, including the placeholder', () => {
    expect(userAgentPreview('0.1.0', '')).toBe(buildUserAgent('0.1.0', ''));
    expect(userAgentPreview('0.1.0', '')).toBe('TF2FlipDesk/0.1.0 (+no-contact-set)');
    expect(userAgentPreview('0.1.0', 'https://steamcommunity.com/id/you')).toBe(buildUserAgent('0.1.0', 'https://steamcommunity.com/id/you'));
  });
});

describe('Key price: scrap.tf key prices from the saved list (F14)', () => {
  const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
  const MIN = 60_000;
  const list: ScraptfListKey = { sellsScrap: 583, paysScrap: 574, observedAt: T0 - 3 * MIN };
  const typed = (over: Partial<Settings['keyPrice']> = {}): Settings['keyPrice'] => ({ ...DEFAULT_SETTINGS.keyPrice, ...over });

  it("is in use exactly when the service's rule takes the list (effectiveScraptfKey)", () => {
    const lists: (ScraptfListKey | null)[] = [
      null,
      list,
      { ...list, sellsScrap: null },
      { ...list, paysScrap: null },
      { sellsScrap: 5, paysScrap: 4, observedAt: T0 },
      { ...list, observedAt: T0 - 2 * 60 * MIN },
    ];
    const typedValues: Partial<Settings['keyPrice']>[] = [
      {},
      { scraptfSellScrap: 570 },
      { scraptfSellScrap: 570, scraptfObservedAt: T0 - 60 * MIN },
      { scraptfBuyScrap: 590, scraptfObservedAt: T0 },
      { scraptfSellScrap: 3, scraptfObservedAt: T0 },
    ];
    for (const l of lists) {
      for (const t of typedValues) {
        const s = { ...DEFAULT_SETTINGS, keyPrice: typed(t) };
        expect(scraptfListKeyInUse(l, s.keyPrice), JSON.stringify({ l, t })).toBe(effectiveScraptfKey(s, l).source === 'list');
      }
    }
  });

  it("names the source of each key price exactly as the service's rule picks it", () => {
    const lists: (ScraptfListKey | null)[] = [null, list, { ...list, sellsScrap: null }, { ...list, paysScrap: null }, { sellsScrap: 5, paysScrap: 4, observedAt: T0 }];
    const typedValues: Partial<Settings['keyPrice']>[] = [
      {},
      { scraptfSellScrap: 570, scraptfObservedAt: T0 - 60 * MIN },
      { scraptfBuyScrap: 590, scraptfObservedAt: T0 },
      { scraptfSellScrap: 570, scraptfObservedAt: T0 },
      { scraptfSellScrap: 570, scraptfBuyScrap: 590, scraptfObservedAt: T0 },
      { scraptfSellScrap: 570, scraptfBuyScrap: 590 },
    ];
    for (const l of lists) {
      for (const t of typedValues) {
        const kp = typed(t);
        const eff = effectiveScraptfKey({ ...DEFAULT_SETTINGS, keyPrice: kp }, l);
        const src = scraptfListKeySources(l, kp);
        const valueOf = (from: 'list' | 'settings' | null, listV: number | null | undefined, typedV: number | null | undefined) =>
          from === 'list' ? (listV ?? null) : from === 'settings' ? (typedV ?? null) : null;
        const sane = (v: number | null) => (v !== null && v >= 18 ? v : null);
        const why = JSON.stringify({ l, t });
        expect(sane(valueOf(src.pays, l?.paysScrap, kp.scraptfSellScrap)), why).toBe(eff.paysScrap);
        expect(sane(valueOf(src.sells, l?.sellsScrap, kp.scraptfBuyScrap)), why).toBe(eff.sellsScrap);
      }
    }
  });

  it('reads "From your saved scrap.tf list (3 min ago): scrap.tf sells a key for X, pays Y."', () => {
    const v = scraptfListKeyView(list, typed(), T0)!;
    expect(v.text).toBe('From your saved scrap.tf list (3 min ago): scrap.tf sells a key for 64.77 ref, pays 63.77 ref.');
    expect(v.inUse).toBe(true);
    expect(v.status).toBe('No values are typed below, so these are used. What scrap.tf pays caps the automatic key price.');
    expect(v.title).toContain('Flip Desk never loads scrap.tf on its own.');
  });

  it('says why it is, or is not, in use against the typed values', () => {
    const older = scraptfListKeyView(list, typed({ scraptfSellScrap: 570, scraptfObservedAt: T0 - 60 * MIN }), T0)!;
    expect(older.inUse).toBe(true);
    expect(older.status).toMatch(/^Newer than the values typed below, so it replaces them\./);
    expect(older.pill).toBe('In use');
    const newer = scraptfListKeyView(list, typed({ scraptfSellScrap: 570, scraptfBuyScrap: 590, scraptfObservedAt: T0 }), T0)!;
    expect(newer.inUse).toBe(false);
    expect(newer.pill).toBe('Not in use');
    expect(newer.status).toBe('The values typed below are newer, so they are used instead.');
    // Newer typed values without a "pays" price: the list's still caps the key price (effectiveScraptfKey).
    const partly = scraptfListKeyView(list, typed({ scraptfBuyScrap: 590, scraptfObservedAt: T0 }), T0)!;
    expect(partly.inUse).toBe(true);
    expect(partly.pill).toBe('Partly in use');
    expect(partly.status).toBe(
      'The values typed below are newer, but none says what scrap.tf pays for a key, so that comes from this list. What scrap.tf pays caps the automatic key price.',
    );
    const onlySells = scraptfListKeyView(list, typed({ scraptfSellScrap: 570, scraptfObservedAt: T0 }), T0)!;
    expect(onlySells.pill).toBe('Partly in use');
    expect(onlySells.status).toBe('The values typed below are newer, but none says what scrap.tf charges for a key, so that comes from this list.');
    // A list without a "pays" price leaves the typed one capping the key price.
    const noPays = scraptfListKeyView({ ...list, paysScrap: null }, typed({ scraptfSellScrap: 570, scraptfObservedAt: T0 - 60 * MIN }), T0)!;
    expect(noPays.pill).toBe('In use');
    expect(noPays.status).toBe('Newer than the values typed below, so it replaces them. What scrap.tf pays for a key still comes from the value typed below.');
    expect(scraptfListKeyView(list, typed({ mode: 'manual' }), T0)!.status).toContain('In Manual mode your own key price is used as typed.');
  });

  it('handles a sold-out key row, and shows nothing without a usable one', () => {
    expect(scraptfListKeyView({ ...list, sellsScrap: null }, typed(), T0)!.text).toBe('From your saved scrap.tf list (3 min ago): scrap.tf has no keys to sell (sold out), pays 63.77 ref.');
    expect(scraptfListKeyView(null, typed(), T0)).toBeNull();
    expect(scraptfListKeyView(undefined, typed(), T0)).toBeNull();
    expect(scraptfListKeyView({ sellsScrap: 2, paysScrap: null, observedAt: T0 }, typed(), T0)).toBeNull();
  });

  it("reads the browser mock's key price (the seeded list's key row)", async () => {
    const b = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
    try {
      const status = await b.rpc('status.get', undefined);
      const v = scraptfListKeyView(status.keyPrice?.scraptfFromList, DEFAULT_SETTINGS.keyPrice, T0);
      expect(v?.inUse).toBe(true);
      expect(v?.text).toMatch(/^From your saved scrap\.tf list \(.+\): scrap\.tf sells a key for [\d.]+ ref, pays [\d.]+ ref\.$/);
    } finally {
      b.dispose();
    }
  });

  it('is shown in Settings → Key price and refreshed when a new list is saved', () => {
    const page = readFileSync(new URL('../../src/renderer/pages/SettingsPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('scraptfListKeyView(kp?.scraptfFromList, s.keyPrice, now)');
    expect(page).toContain("usePush('scraptf.listChanged', () => refreshStatus());");
    expect(page).toContain('{listKey.pill}</TonePill>');
  });
});

describe('Data health and the key price tip name the scrap.tf key price in effect (F14-DM-3)', () => {
  const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
  const HOUR = 3_600_000;
  // Typed two days ago; a list saved an hour ago replaces them, so its pays price (55 ref) sets K.
  const typedOld: Settings['keyPrice'] = { ...DEFAULT_SETTINGS.keyPrice, scraptfSellScrap: 540, scraptfBuyScrap: 560, scraptfObservedAt: NOW - 48 * HOUR };
  const listKey: ScraptfListKey = { paysScrap: 495, sellsScrap: 510, observedAt: NOW - HOUR };
  const quotes = [{ source: 'pricedb' as const, buyScrap: 560, sellScrap: null, observedAt: NOW - HOUR }];

  it('labels the saved list as the cap once it is newer, and the typed row as not in use', () => {
    const kp = selectKeyPrice(quotes, { ...DEFAULT_SETTINGS, keyPrice: typedOld }, NOW, listKey);
    expect(kp.valueScrap).toBe(495);
    expect(effectiveScraptfKey({ ...DEFAULT_SETTINGS, keyPrice: typedOld }, listKey).source).toBe('list');
    const rows = scraptfKeyHealthRows(kp.scraptfFromList, typedOld);
    expect(rows).toEqual([
      { source: 'settings', label: 'scrap.tf (yours; not in use: your saved list is newer)', buyScrap: 560, sellScrap: 540, observedAt: NOW - 48 * HOUR, caps: false },
      { source: 'list', label: 'scrap.tf (saved list; sell caps the automatic value)', buyScrap: 510, sellScrap: 495, observedAt: NOW - HOUR, caps: true },
    ]);
    // Exactly one row caps, and it is the price that set K.
    expect(rows.filter((r) => r.caps).map((r) => r.sellScrap)).toEqual([kp.valueScrap]);
  });

  it('keeps the typed row as the cap while it is newer, and leaves the list row out without a list', () => {
    const typedNew = { ...typedOld, scraptfObservedAt: NOW - 10 * 60_000 };
    const rows = scraptfKeyHealthRows(listKey, typedNew);
    expect(rows.map((r) => [r.source, r.label, r.caps])).toEqual([
      ['settings', 'scrap.tf (yours; sell caps the automatic value)', true],
      ['list', 'scrap.tf (saved list; not in use: your typed values are newer)', false],
    ]);
    expect(scraptfKeyHealthRows(null, typedNew).map((r) => r.label)).toEqual(['scrap.tf (yours; sell caps the automatic value)']);
    expect(scraptfKeyHealthRows(null, DEFAULT_SETTINGS.keyPrice)).toEqual([]);
    // A list that only says what scrap.tf charges caps nothing; the typed pays price still does.
    expect(scraptfKeyHealthRows({ ...listKey, paysScrap: null }, typedOld).map((r) => [r.label, r.caps])).toEqual([
      ['scrap.tf (yours; sell caps the automatic value)', true],
      ['scrap.tf (saved list; buy price only)', false],
    ]);
  });

  it("agrees with the service on which row caps, whatever the mix", () => {
    const lists: (ScraptfListKey | null)[] = [null, listKey, { ...listKey, paysScrap: null }, { ...listKey, sellsScrap: null }, { ...listKey, observedAt: NOW - 72 * HOUR }];
    const typedValues: Partial<Settings['keyPrice']>[] = [{}, typedOld, { scraptfBuyScrap: 590, scraptfObservedAt: NOW }, { scraptfSellScrap: 570 }];
    for (const l of lists) {
      for (const t of typedValues) {
        const kp = { ...DEFAULT_SETTINGS.keyPrice, ...t };
        const eff = effectiveScraptfKey({ ...DEFAULT_SETTINGS, keyPrice: kp }, l);
        const capping = scraptfKeyHealthRows(l, kp).filter((r) => r.caps);
        const why = JSON.stringify({ l, t });
        expect(capping.map((r) => r.sellScrap), why).toEqual(eff.paysScrap === null ? [] : [eff.paysScrap]);
      }
    }
  });

  it("gives the tip the pays price in effect, with the list's age", () => {
    expect(scraptfKeyTipText(listKey, typedOld, NOW)).toBe('scrap.tf sell (saved list, 1 h ago): 55.00 ref');
    expect(scraptfKeyTipText(listKey, { ...typedOld, scraptfObservedAt: NOW }, NOW)).toBe('scrap.tf sell (yours): 60.00 ref');
    expect(scraptfKeyTipText(null, typedOld, NOW)).toBe('scrap.tf sell (yours): 60.00 ref');
    expect(scraptfKeyTipText(null, DEFAULT_SETTINGS.keyPrice, NOW)).toBeNull();
  });

  it('renders the Data health table from those rows', () => {
    const kp = selectKeyPrice(quotes, { ...DEFAULT_SETTINGS, keyPrice: typedOld }, NOW, listKey);
    const html = renderToString(createElement(KeyPriceTable, { kp, typed: typedOld, now: NOW })).replace(/<!-- -->/g, '');
    expect(html).toContain('<td>scrap.tf (saved list; sell caps the automatic value)</td><td class="num money">56.66 ref</td><td class="num money">55.00 ref</td>');
    expect(html).toContain('<td>scrap.tf (yours; not in use: your saved list is newer)</td>');
    expect(html).not.toContain('scrap.tf (yours; sell caps the automatic value)');
    // Settings still loading: no scrap.tf row is guessed.
    expect(renderToString(createElement(KeyPriceTable, { kp, typed: null, now: NOW }))).not.toContain('scrap.tf (');
  });

  it('is what Data health and the top bar show', () => {
    const health = readFileSync(new URL('../../src/renderer/pages/HealthPage.tsx', import.meta.url), 'utf8');
    expect(health).toContain('const stf = typed ? scraptfKeyHealthRows(kp.scraptfFromList, typed) : [];');
    expect(health).not.toContain('scrap.tf (yours; sell caps the automatic value)');
    const app = readFileSync(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('scraptfKeyTipText(kp.scraptfFromList, settings.keyPrice, now)');
    expect(app).not.toContain('scrap.tf sell (yours)');
  });
});

describe('Live check (F16): the check hotkey and the watcher switch', () => {
  const QUICK = DEFAULT_SETTINGS.app.quickEntryHotkey;
  const CHECK = DEFAULT_SETTINGS.check.hotkey;

  it('the check hotkey follows the quick-entry rules and agrees with main', () => {
    for (const a of ['', 'CommandOrControl+Alt+C', 'F9', 'Ctrl+Alt+K', 'Shift+A', 'Ctrl+C', 'Foo+Bar']) {
      const ok = validateCheckHotkey(a, QUICK) === null;
      expect(ok, a).toBe(mainAccepts({ check: { hotkey: a } }));
    }
  });

  it('refuses the quick-entry chord in either field, spelled any way, like main', () => {
    expect(validateCheckHotkey(QUICK, QUICK)).toBe(CHECK_HOTKEY_CONFLICT_ERROR);
    expect(mainAccepts({ check: { hotkey: QUICK } })).toBe(false);
    expect(validateCheckHotkey('Ctrl+Alt+C', 'CommandOrControl+Alt+C')).toBe(CHECK_HOTKEY_CONFLICT_ERROR);
    expect(validateQuickEntryHotkey(CHECK, CHECK)).toBe(QUICK_HOTKEY_CONFLICT_ERROR);
    expect(mainAccepts({ app: { quickEntryHotkey: CHECK } })).toBe(false);
    // Both off never conflict.
    expect(validateCheckHotkey('', '')).toBeNull();
    expect(validateQuickEntryHotkey('', '')).toBeNull();
    // The field's own rules still come first.
    expect(validateCheckHotkey('Shift+A', 'Shift+A')).toBe(HOTKEY_HINT_ERROR);
  });

  it('shows the registration status: on, off, or why a change was refused', () => {
    expect(checkHotkeyStatus('CommandOrControl+Alt+C', null)).toMatchObject({ tone: 'good', pill: 'On' });
    expect(checkHotkeyStatus('CommandOrControl+Alt+C', null).text).toContain('Ctrl+Alt+C');
    expect(checkHotkeyStatus('', null)).toMatchObject({ tone: 'muted', pill: 'Off' });
    const refused = checkHotkeyStatus('CommandOrControl+Alt+C', { hotkey: 'Ctrl+Alt+J', error: 'that shortcut is in use by another app' });
    expect(refused.tone).toBe('bad');
    expect(refused.text).toBe('Could not use Ctrl+Alt+J: that shortcut is in use by another app Still using Ctrl+Alt+C.');
    // A later successful save clears it.
    expect(checkHotkeyStatus('Ctrl+Alt+J', { hotkey: 'Ctrl+Alt+J', error: null }).tone).toBe('good');
  });

  it("shows main's registration ('app.hotkeys'): a chord taken at start-up reads Unavailable, never On", () => {
    const taken = { accelerator: 'CommandOrControl+Alt+C', registered: false, error: '"CommandOrControl+Alt+C" is already used by another application or is not a valid shortcut.' };
    const status = checkHotkeyStatus('CommandOrControl+Alt+C', null, taken);
    expect(status).toMatchObject({ tone: 'bad', pill: 'Unavailable' });
    expect(status.text).toContain('is already used by another application');
    // The same chord spelled another way is the same registration.
    expect(checkHotkeyStatus('Ctrl+Alt+C', null, taken).pill).toBe('Unavailable');
    expect(checkHotkeyStatus('CommandOrControl+Alt+C', null, { ...taken, registered: true, error: null })).toMatchObject({ tone: 'good', pill: 'On' });
    expect(checkHotkeyStatus('CommandOrControl+Alt+C', null, { ...taken, error: null })).toMatchObject({ tone: 'muted', pill: 'Not active' });
    // A status for another (older) chord says nothing about the one stored now; off stays off.
    expect(checkHotkeyStatus('Ctrl+Alt+J', null, taken)).toMatchObject({ tone: 'good', pill: 'On' });
    expect(checkHotkeyStatus('', null, taken)).toMatchObject({ tone: 'muted', pill: 'Off' });
    // The refusal of a save still wins: it is what the user just did.
    expect(checkHotkeyStatus('CommandOrControl+Alt+C', { hotkey: 'Ctrl+Alt+J', error: 'in use' }, taken).pill).toBe('Not changed');
  });

  it('the quick-entry field says when its stored chord could not be registered', () => {
    const taken = { accelerator: 'CommandOrControl+Alt+F', registered: false, error: 'already used by another application.' };
    expect(quickHotkeyProblem('CommandOrControl+Alt+F', taken)).toBe('Ctrl+Alt+F is not working: already used by another application. Pick another shortcut.');
    expect(quickHotkeyProblem('CommandOrControl+Alt+F', { ...taken, registered: true, error: null })).toBeNull();
    expect(quickHotkeyProblem('CommandOrControl+Alt+G', taken)).toBeNull();
    expect(quickHotkeyProblem('', taken)).toBeNull();
    expect(quickHotkeyProblem('CommandOrControl+Alt+F', null)).toBeNull();
  });

  it('the watch switch carries the privacy sentence and says it is off by default', () => {
    const hint = checkWatchHint(false, false);
    expect(hint.startsWith(CHECK_PRIVACY_SENTENCE)).toBe(true);
    expect(hint).toContain('Off by default.');
    expect(hint).toContain('tray menu');
    expect(checkWatchHint(true, true)).toContain('Paused now: the network is paused.');
    expect(checkWatchHint(false, true)).not.toContain('Paused now');
    expect(checkNotifyHint(false)).toMatch(/^Desktop notifications are off/);
    expect(checkNotifyHint(true)).not.toMatch(/are off/);
    // ACT-7: one alert per check, so the notification is for when the check popup is off.
    expect(checkNotifyHint(true)).toContain('while the check popup is off');
    expect(checkNotifyHint(true, true)).toContain('The check popup is on, so it shows each flip instead and this sends nothing.');
    expect(checkNotifyHint(true, false)).not.toContain('The check popup is on');
    expect(checkNotifyHint(false, true)).toMatch(/^Desktop notifications are off[^]*The check popup is on/);
    const page = readFileSync(new URL('../../src/renderer/pages/SettingsPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('description={checkNotifyHint(s.notifications.enabled, c.popup)}');
  });

  it('Settings has the section, the fields, the toggles and the Test', () => {
    const page = readFileSync(new URL('../../src/renderer/pages/SettingsPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain("['set-check', 'Live check']");
    expect(page).toContain('{settings.check ? <CheckSection s={settings} /> : null}');
    expect(page).toContain('validate={(v) => validateCheckHotkey(v, s.app.quickEntryHotkey)}');
    expect(page).toContain("validate={(v) => validateQuickEntryHotkey(v, s.check?.hotkey ?? '')}");
    expect(page).toContain("rpc('check.text', { text: CHECK_SAMPLE_TEXT, source: 'manual' })");
    expect(page).toContain('description={checkWatchHint(c.watchClipboard, paused)}');
    expect(page).toContain('set({ notifyFlips })');
    expect(page).toContain('set({ popup })');
    expect(CHECK_SAMPLE_TEXT).toBe('Team Captain, 1.33 ref');
  });
});

describe('New flips on scrap.tf pages you save (F17): notifications.newOnScraptf', () => {
  const page = readFileSync(new URL('../../src/renderer/pages/SettingsPage.tsx', import.meta.url), 'utf8');
  const ALL_ON = { notificationsOn: true, importKind: true, importOn: true };

  it('is on by default and saves either way, changing only that switch', () => {
    expect(DEFAULT_SETTINGS.notifications.newOnScraptf).toBe(true);
    // 0.8 (G2, LC-7): relabelled, as "Cheaper" and "Back on scrap.tf" toasts take the place of ones this switch sent.
    expect(NEW_ON_SCRAPTF_NOTIFY_LABEL).toBe('New, cheaper or back-in-stock flips on scrap.tf pages you save');
    for (const newOnScraptf of [false, true]) {
      expect(mainAccepts({ notifications: { newOnScraptf } })).toBe(true);
      expect(applySettingsPatch(DEFAULT_SETTINGS, { notifications: { newOnScraptf } }).notifications.newOnScraptf).toBe(newOnScraptf);
    }
    const off = applySettingsPatch(DEFAULT_SETTINGS, { notifications: { newOnScraptf: false } }).notifications;
    expect({ ...off, newOnScraptf: true }).toEqual(DEFAULT_SETTINGS.notifications);
    // The strict patch refuses anything but a boolean, so the switch never sends one.
    expect(mainAccepts({ notifications: { newOnScraptf: 'yes' as unknown as boolean } })).toBe(false);
  });

  it('describes the notification with the service\'s own limits, from saved pages only', () => {
    const hint = newOnScraptfNotifyHint(ALL_ON);
    expect(hint).toContain('"New on scrap.tf (Hats): <name>"');
    expect(hint).toContain(`At most ${BANK_STOCK_MAX_NOTIFICATIONS} per save, then one summary`);
    expect(hint).toContain(`every ${BANK_STOCK_NOTIFY_DEDUP_MS / 60_000} minutes`);
    expect(hint).toContain('A first save of a page notifies nothing.');
    expect(hint).toContain('minimum confidence and profit above');
    expect(hint).toMatch(/Flip Desk never loads scrap\.tf on its own\.$/);
    expect(hint).not.toMatch(/shows nothing/);
  });

  it('says first what keeps it silent: notifications off, "Imported pages" unticked, import off', () => {
    const base = newOnScraptfNotifyHint(ALL_ON);
    expect(newOnScraptfNotifyHint({ ...ALL_ON, notificationsOn: false })).toBe(`Desktop notifications are off, so this shows nothing yet. ${base}`);
    expect(newOnScraptfNotifyHint({ ...ALL_ON, importKind: false })).toBe(`"Imported pages" is not ticked under Notify for, so this shows nothing yet. ${base}`);
    expect(newOnScraptfNotifyHint({ ...ALL_ON, importOn: false })).toBe(`Saved-page import is off (Import), so this shows nothing yet. ${base}`);
    expect(newOnScraptfNotifyHint({ notificationsOn: false, importKind: false, importOn: false })).toBe(
      `Desktop notifications are off, "Imported pages" is not ticked under Notify for and saved-page import is off (Import), so this shows nothing yet. ${base}`,
    );
    // The label the hint names is the Notify for option's own.
    expect(NOTIFY_INPUT_KINDS.find((o) => o.value === 'import')!.label).toBe('Imported pages');
  });

  it('puts the switch in the Notifications section, after the holdings alert, wired to its own key', () => {
    const section = page.slice(page.indexOf('function NotifySection'), page.indexOf('function FeedSection'));
    expect(section).toMatch(/<Toggle\s+checked=\{n\.newOnScraptf\}\s+onChange=\{\(newOnScraptf\) => void set\(\{ newOnScraptf \}\)\}\s+label=\{NEW_ON_SCRAPTF_NOTIFY_LABEL\}/);
    expect(section).toContain(
      "description={newOnScraptfNotifyHint({ notificationsOn: n.enabled, importKind: kinds.includes('import'), importOn: s.import.enabled && s.import.acknowledgedAt !== null })}",
    );
    expect(section.indexOf('n.holdings')).toBeLessThan(section.indexOf('n.newOnScraptf'));
    expect(section.indexOf('n.newOnScraptf')).toBeLessThan(section.indexOf('n.silent'));
  });

  it('renders as a switch with its label and description', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, newOnScraptf: false } };
    const html = renderToString(createElement(AppProvider, null, createElement(NotifySection, { s: settings }))).replace(/<!-- -->/g, '');
    const at = html.indexOf(NEW_ON_SCRAPTF_NOTIFY_LABEL);
    expect(at).toBeGreaterThan(0);
    const input = html.slice(html.lastIndexOf('<input', at), at);
    expect(input).toContain('role="switch"');
    expect(input).not.toContain('checked=""');
    // Import is off by default (behind its acknowledgement): the description says so.
    expect(html).toContain('Saved-page import is off (Import), so this shows nothing yet.');
    const on = renderToString(createElement(AppProvider, null, createElement(NotifySection, { s: DEFAULT_SETTINGS }))).replace(/<!-- -->/g, '');
    const onAt = on.indexOf(NEW_ON_SCRAPTF_NOTIFY_LABEL);
    expect(on.slice(on.lastIndexOf('<input', onAt), onAt)).toContain('checked=""');
  });
});

describe('0.8 (G1-G4): the scrap.tf watch and Buy now switches (notifications.watches, notifications.buyTiming)', () => {
  const page = readFileSync(new URL('../../src/renderer/pages/SettingsPage.tsx', import.meta.url), 'utf8');
  const section = page.slice(page.indexOf('function NotifySection'), page.indexOf('function FeedSection'));
  const render = (s: Settings) => renderToString(createElement(AppProvider, null, createElement(NotifySection, { s }))).replace(/<!-- -->/g, '');
  /** The switch's <input> right before `label` in the rendered section. */
  const inputBefore = (html: string, label: string) => {
    const at = html.indexOf(label);
    expect(at).toBeGreaterThan(0);
    return html.slice(html.lastIndexOf('<input', at), at);
  };

  it('names the new toasts in the scrap.tf flips description, keeping its pinned sentences', () => {
    const hint = newOnScraptfNotifyHint({ notificationsOn: true, importKind: true, importOn: true });
    expect(hint).toContain('"Cheaper on scrap.tf (Hats): <name>"');
    expect(hint).toContain('"Back on scrap.tf (Hats): <name>"');
    expect(hint).toContain("then one summary that opens the page's stock");
    // G4 has its own switch: this description never promises a "Buy now".
    expect(hint).not.toMatch(/Buy now/);
  });

  it('describes watch toasts from the user\'s own reads and saves, and says first what keeps them silent', () => {
    expect(WATCHES_NOTIFY_LABEL).toBe('Your scrap.tf watches');
    expect(DEFAULT_SETTINGS.notifications.watches).toBe(true);
    const base = watchesNotifyHint({ notificationsOn: true, importOn: true });
    expect(base).toContain('"Watch (Hats): <name>"');
    expect(base).toContain('"Back on scrap.tf (Hats): <name>"');
    expect(base).toContain('Watch on scrap.tf… in an item\'s menu or its details');
    expect(base).toContain('Told on the read that shows it, not again for the same price.');
    // Review fix: the engine titles that toast "Watch: <name>" (engine.ts notificationTitle), so the hint says so.
    expect(base).toContain('one that reaches it is told as "Watch: <name>" in place of "Profit: <name>"');
    expect(base).not.toContain('bar for its "Profit:" toast');
    expect(base).toContain(`At most ${BANK_STOCK_MAX_NOTIFICATIONS} per save with the other scrap.tf toasts, then one summary.`);
    expect(base).toMatch(/Flip Desk never loads scrap\.tf on its own\.$/);
    expect(watchesNotifyHint({ notificationsOn: false, importOn: true })).toBe(`Desktop notifications are off, so this shows nothing yet. ${base}`);
    expect(watchesNotifyHint({ notificationsOn: true, importOn: false })).toBe(`Saved-page import is off (Import), so this shows nothing yet. ${base}`);
    expect(watchesNotifyHint({ notificationsOn: false, importOn: false })).toBe(`Desktop notifications are off and saved-page import is off (Import), so this shows nothing yet. ${base}`);
  });

  it('keeps "Buy now" off by default, worded as an estimate from the saves, never a forecast', () => {
    expect(BUY_TIMING_NOTIFY_LABEL).toBe('Buy now after Wait (estimate from your saves)');
    expect(DEFAULT_SETTINGS.notifications.buyTiming).toBe(false);
    const on = { notificationsOn: true, newOnScraptfOn: true, importKind: true, importOn: true };
    const base = buyTimingNotifyHint(on);
    expect(base).toContain('"Buy now (Hats): <name>"');
    expect(base).toContain('after a drop showed or the wait\'s time ran out');
    expect(base).toContain('An estimate from your own saves, never a forecast; off by default.');
    expect(base).toContain('Needs the scrap.tf flips toggle above.');
    expect(base).toMatch(/Flip Desk never loads scrap\.tf on its own\.$/);
    expect(buyTimingNotifyHint({ ...on, notificationsOn: false })).toBe(`Desktop notifications are off, so this shows nothing yet. ${base}`);
    expect(buyTimingNotifyHint({ ...on, newOnScraptfOn: false })).toBe(`The scrap.tf flips toggle above is off, so this shows nothing yet. ${base}`);
    // The service's `flips` also needs "Imported pages" under Notify for, and the import itself: each is named.
    expect(buyTimingNotifyHint({ ...on, importKind: false })).toBe(`"Imported pages" is not ticked under Notify for, so this shows nothing yet. ${base}`);
    expect(buyTimingNotifyHint({ ...on, importOn: false })).toBe(`Saved-page import is off (Import), so this shows nothing yet. ${base}`);
    for (const buyTiming of [false, true]) expect(applySettingsPatch(DEFAULT_SETTINGS, { notifications: { buyTiming } }).notifications.buyTiming).toBe(buyTiming);
  });

  it('puts both switches after the scrap.tf flips switch and before Silent, each wired to its own key', () => {
    expect(section).toContain(
      "<Toggle checked={n.watches} onChange={(watches) => void set({ watches })} label={WATCHES_NOTIFY_LABEL} description={watchesNotifyHint({ notificationsOn: n.enabled, importOn: s.import.enabled && s.import.acknowledgedAt !== null })} />",
    );
    expect(section).toContain(
      "<Toggle checked={n.buyTiming} onChange={(buyTiming) => void set({ buyTiming })} label={BUY_TIMING_NOTIFY_LABEL} description={buyTimingNotifyHint({ notificationsOn: n.enabled, newOnScraptfOn: n.newOnScraptf, importKind: kinds.includes('import'), importOn: s.import.enabled && s.import.acknowledgedAt !== null })} />",
    );
    expect(section.indexOf('label={NEW_ON_SCRAPTF_NOTIFY_LABEL}')).toBeLessThan(section.indexOf('n.watches'));
    expect(section.indexOf('n.watches')).toBeLessThan(section.indexOf('n.buyTiming'));
    expect(section.indexOf('n.buyTiming')).toBeLessThan(section.indexOf('n.silent'));
  });

  it('renders both as switches: watches on and Buy now off by default', () => {
    const html = render(DEFAULT_SETTINGS);
    const watches = inputBefore(html, WATCHES_NOTIFY_LABEL);
    expect(watches).toContain('role="switch"');
    expect(watches).toContain('checked=""');
    const timing = inputBefore(html, BUY_TIMING_NOTIFY_LABEL);
    expect(timing).toContain('role="switch"');
    expect(timing).not.toContain('checked=""');
    const on = render({ ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, buyTiming: true, watches: false } });
    expect(inputBefore(on, BUY_TIMING_NOTIFY_LABEL)).toContain('checked=""');
    expect(inputBefore(on, WATCHES_NOTIFY_LABEL)).not.toContain('checked=""');
  });
});

describe('0.8 (PC-1): the price-move reserve field (profit.exitReservePct)', () => {
  it('accepts 0 to 50 % locally, as the schema accepts 0 to 0.5', () => {
    const v = numberValidator(EXIT_RESERVE_PCT.min, EXIT_RESERVE_PCT.max);
    expect(v('50')).toBeNull();
    expect(v('0')).toBeNull();
    expect(v('2.5')).toBeNull();
    expect(v('50.1')).toBe('Between 0 and 50.');
    expect(v('-1')).not.toBeNull();
    expect(v('')).toBe('Enter a number.');
    // Every value the field accepts is one main accepts, and the field reads the stored ratio back.
    expect(mainAccepts({ profit: { exitReservePct: pctTextToRatio(String(EXIT_RESERVE_PCT.max)) } })).toBe(true);
    expect(mainAccepts({ profit: { exitReservePct: pctTextToRatio(String(EXIT_RESERVE_PCT.min)) } })).toBe(true);
    expect(mainAccepts({ profit: { exitReservePct: 0.501 } })).toBe(false);
    expect(ratioToPctText(DEFAULT_SETTINGS.profit.exitReservePct)).toBe('0');
    expect(ratioToPctText(0.05)).toBe('5');
  });

  it('says it is off at 0, and that the allowance is the user\'s own, never measured', () => {
    expect(exitReserveHint(0).startsWith('Off.')).toBe(true);
    expect(exitReserveHint(0.05).startsWith('Off.')).toBe(false);
    for (const hint of [exitReserveHint(0), exitReserveHint(0.05)]) {
      expect(hint).toContain('Your own allowance: Flip Desk does not measure price swings.');
      expect(hint).toContain('A sale into a live buy order');
    }
  });

  it('sits in the Profit thresholds grid right after Friction per trade', () => {
    const page = readFileSync(new URL('../../src/renderer/pages/SettingsPage.tsx', import.meta.url), 'utf8');
    const friction = page.indexOf('htmlFor="p-friction"');
    const reserve = page.indexOf('htmlFor="p-reserve"');
    expect(friction).toBeGreaterThan(0);
    expect(reserve).toBeGreaterThan(friction);
    expect(reserve).toBeLessThan(page.indexOf('htmlFor="p-om"'));
    expect(page).toContain('hint={exitReserveHint(p.exitReservePct)}');
  });
});
