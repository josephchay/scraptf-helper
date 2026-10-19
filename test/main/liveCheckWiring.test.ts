// F16 live check, the glue in src/main/main.ts (it imports Electron, so it is read, not run). The
// pieces it connects are tested on their own: the controller (liveCheckMain.test.ts), the watcher and
// filter (clipboardWatch.test.ts), the popup window (checkWindow.test.ts), the tray (tray.test.ts), the
// settings store's hotkey slots (settingsStore.test.ts) and the IPC router (ipc.test.ts, checkBridge.test.ts).
// This pins the wires between them:
//   hotkey -> clipboard read -> check.text -> popup (focused)
//   watcher -> filter -> check.text -> popup (showInactive) / notification
//   service push check.done -> every window (the Recent checks panel)
//   page check.arm -> router armCheck -> controller arm -> hint on the hotkey's and watcher's check.text (F19)

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAIN_ONLY_PUSH_EVENTS } from '../../src/main/serviceHost';
import { PUSH_EVENTS } from '../../src/shared/rpc';

/** main.ts without comments, whitespace runs folded to one space. */
const MAIN = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
  .replace(/\s+/g, ' ');

/**
 * From `marker` to the bracket closing the first `bracket` at or after the marker's end (a marker ending
 * in "(" means that call's arguments), brackets balanced.
 */
function section(marker: string, bracket: '{' | '(' = '{'): string {
  const at = MAIN.indexOf(marker);
  expect(at, marker).toBeGreaterThanOrEqual(0);
  const from = marker.endsWith(bracket) ? at + marker.length - 1 : at + marker.length;
  const open = MAIN.indexOf(bracket, from);
  let depth = 0;
  for (let i = open; i < MAIN.length; i++) {
    const c = MAIN[i];
    if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') {
      depth--;
      if (depth === 0) return MAIN.slice(at, i + 1);
    }
  }
  throw new Error(`unbalanced after ${marker}`);
}

describe('main.ts live check wiring', () => {
  it('the check hotkey runs the controller, registered through the settings store like quick entry', () => {
    expect(MAIN).toContain('const checkClipboard = () => void liveCheck?.hotkey();');
    expect(MAIN).toContain('applyCheckHotkey: (next, prev) => applyHotkey(next, prev, checkClipboard),');
    expect(MAIN).toContain('applyHotkey: (next, prev) => applyHotkey(next, prev, toggleQuick),');
    // A smoke test (or the window test) registers no hotkey at all (so it never reads the clipboard).
    expect(MAIN).toMatch(/effects: diagnosticRun \? undefined : \{/);
    expect(MAIN).toContain('const diagnosticRun = args.smokeTest !== null || args.smokeWindow !== null;');
  });

  it('the controller reads plain text, checks through the service with a short timeout, and shows the popup', () => {
    const deps = section('liveCheck = createLiveCheckMain(', '(');
    expect(deps).toContain('readText: () => clipboard.readText(),');
    // F19: the hint key only when the controller passes one (an arm lasts), so a plain check is unchanged.
    expect(deps).toContain(
      "check: (text, source, hint) => host.call('check.text', hint ? { text, source, hint } : { text, source }, { timeoutMs: CHECK_CALL_TIMEOUT_MS }),",
    );
    expect(deps).toContain("serviceReady: () => host.status().state === 'ready',");
    // focus (hotkey) or showInactive (watcher) is decided by the controller and honoured by showCheck.
    expect(deps).toContain('showPopup: (result, opts) => rt.windows.showCheck(result, opts),');
    // Flip notifications go through the same path as every other: notifications.enabled and silent apply.
    expect(deps).toContain('notify: (payload) => showNotification(rt, payload),');
    expect(deps).toContain('settings: () => settings.get(),');
    expect(deps).toContain('systemPaused: () => systemPause.paused(),');
    expect(deps).toMatch(/\blog,?\s*\}/);
  });

  it('builds the controller and the lock/suspend watch only outside a smoke test or the window test, after ready', () => {
    const block = section('if (!diagnosticRun) {');
    expect(block).toContain('createSystemPause(powerMonitor)');
    expect(block).toContain('liveCheck = createLiveCheckMain(');
    expect(block).toContain('rt.liveCheck = liveCheck;');
    expect(MAIN.match(/createLiveCheckMain\(/g)).toHaveLength(1);
  });

  it('starts and stops the watcher with the setting: on every change and after the start-up effects', () => {
    const onChange = section('settings.onChange((next) =>');
    expect(onChange).toContain('rt.liveCheck?.syncWatch();');
    expect(onChange).toContain("rt.windows.broadcast('settings.changed', next);");
    const startup = MAIN.slice(MAIN.indexOf('const hotkey: HotkeyStatus = settings.applyStartupEffects();'));
    expect(startup.indexOf('rt.liveCheck?.syncWatch();')).toBeGreaterThan(0);
    expect(startup).toContain('startupHotkeyNotice(hotkey, settings.checkHotkeyStatus())');
  });

  it('shutdown stops the watcher and drops the powerMonitor listeners', () => {
    const shutdown = section('function shutdown()');
    expect(shutdown).toContain('runtime?.liveCheck?.stop();');
    expect(shutdown).toContain('runtime?.systemPause?.dispose();');
    expect(shutdown.indexOf('globalShortcut.unregisterAll()')).toBeLessThan(shutdown.indexOf('runtime?.liveCheck?.stop();'));
  });

  it('the tray toggles the watcher through settings and says the privacy sentence when it turns on', () => {
    const tray = section('setClipboardWatch: (on) =>');
    expect(tray).toContain('trySet({ check: { watchClipboard: on } })');
    expect(tray).toContain("showNotice(rt, { title: 'Clipboard check is on', body: CHECK_PRIVACY_SENTENCE })");
    const state = section('function trayState(rt: Runtime)');
    expect(state).toContain('checkWatch: s.check.watchClipboard,');
    expect(state).toContain('checkHotkey: rt.settings.checkHotkeyStatus(),');
  });

  it('popup buttons arriving in main: Details and Quick entry… hide the popup; Quick entry gets the price', () => {
    const quick = section('showQuickEntry: (sku, price) =>');
    expect(quick).toContain('rt.windows.hideCheck();');
    expect(quick).toContain('rt.windows.showQuickEntry(sku, price);');
    const open = section('openItemInDashboard: (sku) =>');
    expect(open).toContain('rt.windows.hideCheck();');
    expect(open).toContain('openItemInDashboard(rt, sku);');
    // Esc and the auto-hide call app.hideWindow, which hides the calling window (the popup).
    expect(MAIN).toContain('hideWindow: () => rt.windows.hideWindowFor(event.sender),');
  });

  it("Settings reads both hotkeys' registration from main", () => {
    expect(MAIN).toContain('hotkeys: () => ({ quickEntry: settings.hotkeyStatus(), check: settings.checkHotkeyStatus() }),');
  });

  it("F19 'check.arm' reaches the controller, and reads as lapsed without one (a smoke test)", () => {
    const router = section('createRpcRouter(', '(');
    expect(router).toContain('armCheck: (arm) => rt.liveCheck?.arm(arm) ?? { armedUntil: null },');
    // The stub is gone: no other armCheck.
    expect(MAIN.match(/\barmCheck:/g)).toHaveLength(1);
    // Nothing in main.ts logs the arm (the name is never logged).
    expect(MAIN).not.toMatch(/\blog\s*\.\s*(?:debug|info|warn|error)\s*\([^)]*\barm\b/);
  });

  it("check.done reaches every window (the Recent checks panel); ui.checkShow is main's own", () => {
    const push = section('function handlePush(');
    const owned = push.slice(push.indexOf("case 'settings.changed':"), push.indexOf('default:'));
    expect(owned).toContain("case 'ui.checkShow':");
    expect(owned).not.toContain("'check.done'");
    expect(push).toContain('rt.windows.broadcast(event, payload as never);');
    expect(PUSH_EVENTS).toContain('check.done');
    expect(MAIN_ONLY_PUSH_EVENTS).toContain('ui.checkShow');
    expect(MAIN_ONLY_PUSH_EVENTS).not.toContain('check.done');
  });
});
