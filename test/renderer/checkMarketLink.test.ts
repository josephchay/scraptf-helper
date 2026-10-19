// F19, the Live check side of the Live market's link to scrap.tf (renderer): what the popup says about
// a price copied on its own and matched to the item the user opened there, what "Open on scrap.tf"
// arms main with, and how its toast words the way back. Pure; nothing here reads a clipboard or
// contacts scrap.tf, and the copied text never reaches any of it.

import { describe, expect, it } from 'vitest';
import {
  CHECK_MATCHED_NOTE,
  checkArmFor,
  checkPopupNote,
  checkPriceLine,
  checkReturnPath,
  checkSummaryText,
  scraptfBackHint,
  type CheckReturnPath,
} from '../../src/renderer/checkModel';
import { mockCheckDemo } from '../../src/renderer/mockCheck';
import { CHECK_ARM_NAME_MAX, CHECK_EXTRAS_NOTE, CHECK_FUZZY_NOTE, checkHintedNote, checkMatchedByHint } from '../../src/shared/check';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { CheckResult } from '../../src/shared/types';

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const K = 540;
const flip = (over: Partial<CheckResult> = {}): CheckResult => ({ ...mockCheckDemo('flip', NOW, K, DEFAULT_SETTINGS), ...over });
const hinted = (name = 'Team Captain', extra = '') => flip({ reason: `${checkHintedNote(name)}${extra}` });

describe('the popup note for a price matched to the item opened on scrap.tf', () => {
  it('replaces the service sentence with the short line, the header already naming the item', () => {
    const r = hinted();
    expect(checkMatchedByHint(r)).toBe(true);
    expect(checkPopupNote(r)).toBe(CHECK_MATCHED_NOTE);
    expect(CHECK_MATCHED_NOTE).toBe('Price copied, matched to the item you opened.');
  });

  it('keeps the other notes after it, in order, whatever the name holds', () => {
    expect(checkPopupNote(hinted('Team Captain', ` ${CHECK_EXTRAS_NOTE}`))).toBe(`${CHECK_MATCHED_NOTE} ${CHECK_EXTRAS_NOTE}`);
    expect(checkPopupNote(flip({ reason: `${CHECK_FUZZY_NOTE} ${checkHintedNote('A, B. (C) the item you opened')}` }))).toBe(`${CHECK_MATCHED_NOTE} ${CHECK_FUZZY_NOTE}`);
  });

  it('leaves every other note as it came, and none as null', () => {
    expect(checkPopupNote(flip({ reason: CHECK_FUZZY_NOTE }))).toBe(CHECK_FUZZY_NOTE);
    expect(checkPopupNote(flip({ reason: null }))).toBeNull();
    expect(checkPopupNote(flip({ reason: '   ' }))).toBeNull();
    // The tail alone without the shared opening is not the hint's sentence: untouched.
    const odd = 'Something about the item you opened from the Live market.';
    expect(checkPopupNote(flip({ reason: odd }))).toBe(odd);
  });

  it('marks the price line as matched only for a copied price, with the match in its tooltip', () => {
    const line = checkPriceLine(hinted(), NOW);
    expect(line).toMatchObject({ source: 'copied', matched: true });
    expect(line.title).toContain('the price you copied, matched to the item you opened from the Live market.');
    expect(checkPriceLine(flip(), NOW).matched).toBe(false);
    const listed = flip({ reason: checkHintedNote('Team Captain'), price: { ...flip().price!, source: 'list', observedAt: NOW - 60_000 } });
    expect(checkPriceLine(listed, NOW).matched).toBe(false);
    // The screen reader summary keeps the service's full sentence.
    expect(checkSummaryText(hinted(), NOW)).toContain(checkHintedNote('Team Captain'));
  });
});

describe("'check.arm' params for Open on scrap.tf", () => {
  it('is the SKU and exactly the name that is copied (main hashes the trimmed copy)', () => {
    expect(checkArmFor('378;6', 'Team Captain')).toEqual({ sku: '378;6', name: 'Team Captain' });
    expect(checkArmFor(' 378;6 ', ' Team Captain ')).toEqual({ sku: '378;6', name: ' Team Captain ' });
    expect(checkArmFor('378;6', 'x'.repeat(CHECK_ARM_NAME_MAX))?.name).toHaveLength(CHECK_ARM_NAME_MAX);
  });

  it('is null where main would refuse it, so no refused call is sent', () => {
    expect(checkArmFor('', 'Team Captain')).toBeNull();
    expect(checkArmFor('378;6', '  ')).toBeNull();
    expect(checkArmFor('378;6', 'x'.repeat(CHECK_ARM_NAME_MAX + 1))).toBeNull();
    expect(checkArmFor('378;6', 'Team\nCaptain')).toBeNull();
    expect(checkArmFor('378;6', 'Team\u007fCaptain')).toBeNull();
    expect(checkArmFor('x'.repeat(301), 'Team Captain')).toBeNull();
    expect(checkArmFor(undefined as unknown as string, 'Team Captain')).toBeNull();
  });
});

describe('the way back, from Settings → Live check', () => {
  const S = (check: Partial<typeof DEFAULT_SETTINGS.check> = {}, networkPaused = false) => ({ check: { ...DEFAULT_SETTINGS.check, ...check }, networkPaused });
  const held = (accelerator: string, registered: boolean) => ({ accelerator, registered });
  const path = (over: Partial<CheckReturnPath> = {}): CheckReturnPath => ({ hotkey: 'CommandOrControl+Alt+C', watching: false, registered: true, armed: true, ...over });

  it('reads the settings, the watcher paused with the network, and main\'s registration for the same chord only', () => {
    expect(checkReturnPath(S(), held('CommandOrControl+Alt+C', true), true)).toEqual(path());
    expect(checkReturnPath(S({ watchClipboard: true }), null, false)).toEqual(path({ watching: true, registered: null, armed: false }));
    expect(checkReturnPath(S({ watchClipboard: true }, true), null, true).watching).toBe(false);
    // Another chord than the setting's: that registration is stale.
    expect(checkReturnPath(S(), held('CommandOrControl+Alt+X', false), true).registered).toBeNull();
    expect(checkReturnPath(S(), held('CommandOrControl+Alt+C', false), true).registered).toBe(false);
    expect(checkReturnPath(S({ hotkey: '' }), held('', false), true)).toMatchObject({ hotkey: '', registered: false });
    // Settings not loaded yet: the chord main holds.
    expect(checkReturnPath(null, held('CommandOrControl+Shift+K', true), true)).toEqual(path({ hotkey: 'CommandOrControl+Shift+K' }));
    expect(checkReturnPath(undefined, null, true)).toEqual(path({ hotkey: '', registered: null }));
    // A malformed answer from main is unknown, not a throw that would lose the toast.
    const odd = { accelerator: null, registered: true } as unknown as { accelerator: string; registered: boolean };
    expect(checkReturnPath(S(), odd, true)).toEqual(path({ registered: null }));
    expect(checkReturnPath(null, odd, true)).toEqual(path({ hotkey: '', registered: null }));
  });

  it("says to copy the price and press the hotkey, as the spec's toast does", () => {
    expect(scraptfBackHint(path())).toBe('Copy the price there and press Ctrl+Alt+C to check it here.');
    expect(scraptfBackHint(path({ registered: null }))).toBe('Copy the price there and press Ctrl+Alt+C to check it here.');
    expect(scraptfBackHint(path({ watching: true }))).toBe('Copy the price there: the clipboard check picks it up, or press Ctrl+Alt+C.');
    expect(scraptfBackHint(path({ hotkey: '', watching: true }))).toBe('Copy the price there: the clipboard check picks it up here.');
  });

  it('asks for the name with the price when main was not armed (a bare price is not an item then)', () => {
    expect(scraptfBackHint(path({ armed: false }))).toBe('Copy the name and price there and press Ctrl+Alt+C to check it here.');
    expect(scraptfBackHint(path({ armed: false, hotkey: '', watching: true }))).toBe('Copy the name and price there: the clipboard check picks it up here.');
  });

  it('never tells the user to press a hotkey that is off or taken', () => {
    expect(scraptfBackHint(path({ hotkey: '' }))).toBe('To check a price you copy there, set a check hotkey in Settings → Live check.');
    const taken = scraptfBackHint(path({ registered: false }));
    expect(taken).toBe('To check a price you copy there, free the check hotkey Ctrl+Alt+C or pick another in Settings → Live check.');
    expect(scraptfBackHint(path({ registered: false, watching: true }))).toBe('Copy the price there: the clipboard check picks it up here.');
  });
});
