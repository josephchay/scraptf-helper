// --smoke-window's gate (paths.ts): the window test turns the scrap.tf window on in the profile it runs in,
// so it may start only with diagnostics (a development build, or FLIPDESK_DIAGNOSTICS=1), a report path, a
// profile that is not the app's own and no --smoke-test beside it. Pure; nothing is launched.

import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLaunchArgs, SMOKE_WINDOW_HOST_RULES, SMOKE_WINDOW_NO_PROXY, SMOKE_WINDOW_REFUSALS, smokeWindowRefusal, type SmokeWindowGate } from '../../src/main/paths';

const cwd = path.resolve(os.tmpdir(), 'cwd');
const WIN_DEFAULT = 'C:\\Users\\me\\AppData\\Roaming\\TF2 Flip Desk';
const WIN_TEMP = 'C:\\Users\\me\\AppData\\Local\\Temp\\flipdesk-window-test';
const winGate = (allowDiagnostics = true): SmokeWindowGate => ({ allowDiagnostics, defaultUserData: [WIN_DEFAULT], platform: 'win32' });

/** The launch args of `argv` as main reads them, with the user-data dir given as an absolute Windows path. */
function winArgs(flags: { window?: string | null; smokeTest?: string; profile?: string | null; asked?: boolean }) {
  const report = flags.window === undefined ? 'C:\\tmp\\window.json' : flags.window;
  return {
    smokeWindow: report,
    smokeWindowAsked: flags.asked ?? true,
    smokeTest: flags.smokeTest ?? null,
    userDataDir: flags.profile === undefined ? WIN_TEMP : flags.profile,
  };
}

describe('parseLaunchArgs --smoke-window', () => {
  it('reads the report path only when diagnostics are allowed, and notes the flag either way', () => {
    const argv = ['electron.exe', '.', '--smoke-window=out/window.json', '--user-data-dir=ud'];
    expect(parseLaunchArgs(argv, cwd)).toMatchObject({ smokeWindow: path.join(cwd, 'out', 'window.json'), smokeWindowAsked: true, userDataDir: path.join(cwd, 'ud') });
    // A packaged build without FLIPDESK_DIAGNOSTICS=1: no report path (nothing is written), but the flag is seen.
    expect(parseLaunchArgs(argv, cwd, { allowDiagnostics: false })).toMatchObject({ smokeWindow: null, smokeWindowAsked: true });
  });

  it('notes the bare flag and an empty value as asked, with no report path', () => {
    expect(parseLaunchArgs(['--smoke-window'], cwd)).toMatchObject({ smokeWindow: null, smokeWindowAsked: true });
    expect(parseLaunchArgs(['--smoke-window='], cwd)).toMatchObject({ smokeWindow: null, smokeWindowAsked: true });
    expect(parseLaunchArgs(['--smoke-windows=x.json', '--smoke-test=a.json'], cwd)).toMatchObject({ smokeWindow: null, smokeWindowAsked: false });
  });
});

describe('smokeWindowRefusal', () => {
  it('lets every other launch through untouched', () => {
    expect(smokeWindowRefusal(winArgs({ asked: false, window: null, profile: null }), winGate(false))).toBeNull();
    expect(smokeWindowRefusal(winArgs({ asked: false, window: null, profile: WIN_DEFAULT }), winGate())).toBeNull();
  });

  it('runs with diagnostics, a report path and a profile of its own', () => {
    expect(smokeWindowRefusal(winArgs({}), winGate())).toBeNull();
    // A sibling whose name starts like the profile's is another folder.
    expect(smokeWindowRefusal(winArgs({ profile: `${WIN_DEFAULT} test` }), winGate())).toBeNull();
    expect(smokeWindowRefusal(winArgs({ profile: 'C:\\Users\\me\\AppData\\Roaming\\TF2 Flip Desk..smoke' }), winGate())).toBeNull();
  });

  it('refuses a packaged build without FLIPDESK_DIAGNOSTICS=1, before looking at anything else', () => {
    expect(smokeWindowRefusal(winArgs({ window: null }), winGate(false))).toBe(SMOKE_WINDOW_REFUSALS.notAllowed);
    expect(smokeWindowRefusal(winArgs({ window: null, profile: WIN_DEFAULT, smokeTest: 'C:\\a.json' }), winGate(false))).toBe(SMOKE_WINDOW_REFUSALS.notAllowed);
    // The real parse of such a launch: no report path, the flag seen, refused.
    const argv = ['TF2 Flip Desk.exe', `--smoke-window=C:\\Users\\me\\Documents\\journal.csv`, `--user-data-dir=${WIN_TEMP}`];
    expect(smokeWindowRefusal(parseLaunchArgs(argv, cwd, { allowDiagnostics: false }), winGate(false))).toBe(SMOKE_WINDOW_REFUSALS.notAllowed);
  });

  it('refuses the app’s default profile, a folder inside it and a folder holding it, whatever the case or trailing slash', () => {
    for (const profile of [
      WIN_DEFAULT,
      `${WIN_DEFAULT}\\`,
      'c:\\users\\ME\\appdata\\roaming\\tf2 flip desk',
      'C:/Users/me/AppData/Roaming/TF2 Flip Desk',
      `${WIN_DEFAULT}\\sub\\dir`,
      `${WIN_DEFAULT}\\..\\TF2 Flip Desk`,
      'C:\\Users\\me\\AppData\\Roaming',
      'C:\\',
    ]) {
      expect(smokeWindowRefusal(winArgs({ profile }), winGate()), profile).toBe(SMOKE_WINDOW_REFUSALS.defaultProfile);
    }
    // No known default folder: refused rather than guessed.
    expect(smokeWindowRefusal(winArgs({}), { ...winGate(), defaultUserData: [] })).toBe(SMOKE_WINDOW_REFUSALS.defaultProfile);
  });

  it('compares case-sensitively on POSIX paths', () => {
    const gate: SmokeWindowGate = { allowDiagnostics: true, defaultUserData: ['/home/me/.config/TF2 Flip Desk'], platform: 'linux' };
    const args = (profile: string) => ({ smokeWindow: '/tmp/w.json', smokeWindowAsked: true, smokeTest: null, userDataDir: profile });
    expect(smokeWindowRefusal(args('/home/me/.config/TF2 Flip Desk'), gate)).toBe(SMOKE_WINDOW_REFUSALS.defaultProfile);
    expect(smokeWindowRefusal(args('/home/me/.config/TF2 Flip Desk/x'), gate)).toBe(SMOKE_WINDOW_REFUSALS.defaultProfile);
    expect(smokeWindowRefusal(args('/home/me/.config/tf2 flip desk'), gate)).toBeNull();
    expect(smokeWindowRefusal(args('/tmp/flipdesk-window'), gate)).toBeNull();
  });

  it('refuses running beside --smoke-test', () => {
    expect(smokeWindowRefusal(winArgs({ smokeTest: 'C:\\tmp\\smoke.json' }), winGate())).toBe(SMOKE_WINDOW_REFUSALS.withSmokeTest);
    const argv = ['--smoke-window=w.json', '--smoke-test=s.json', `--user-data-dir=${path.join(os.tmpdir(), 'ud-window')}`];
    const gate: SmokeWindowGate = { allowDiagnostics: true, defaultUserData: [path.join(os.tmpdir(), 'not-this')], platform: process.platform };
    expect(smokeWindowRefusal(parseLaunchArgs(argv, cwd), gate)).toBe(SMOKE_WINDOW_REFUSALS.withSmokeTest);
  });

  it('refuses a run with no report path or no profile of its own', () => {
    expect(smokeWindowRefusal(winArgs({ window: null }), winGate())).toBe(SMOKE_WINDOW_REFUSALS.noReport);
    expect(smokeWindowRefusal(winArgs({ profile: null }), winGate())).toBe(SMOKE_WINDOW_REFUSALS.noProfile);
  });

  it('words every refusal as fixed text naming the flag', () => {
    for (const text of Object.values(SMOKE_WINDOW_REFUSALS)) expect(text).toMatch(/^--smoke-window /);
    // The run's Chromium maps every host name to "not found", and no proxy resolves one for it.
    expect(SMOKE_WINDOW_HOST_RULES).toBe('MAP * ~NOTFOUND');
    expect(SMOKE_WINDOW_NO_PROXY).toBe('no-proxy-server');
  });
});
