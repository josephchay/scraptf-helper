// F19 contract in main's IPC router: 'check.arm' is a main method whose params (a SKU under the service's
// rule and an item name of at most CHECK_ARM_NAME_MAX characters, or null) are validated with fixed
// messages before deps.armCheck sees them; and a page's 'check.text' may not carry a hint, since only
// main adds one (from its own arm) to the hotkey's and the watcher's checks.

import { describe, expect, it, vi } from 'vitest';
import { CHECK_TEXT_HINT_REFUSAL, CHECK_TEXT_SOURCE_REFUSAL, createRpcRouter, type MainRpcDeps } from '../../src/main/ipc';
import { CHECK_ARM_NAME_MAX } from '../../src/shared/check';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { MAIN_METHODS, SERVICE_METHODS } from '../../src/shared/rpc';

const MARKER = 'Zq7 Name Marker';

function route() {
  const armCheck = vi.fn((arm: Parameters<MainRpcDeps['armCheck']>[0]) => ({ armedUntil: arm ? 1_000 : null }));
  const callRaw = vi.fn(async (method: string, params: unknown) => ({ method, params }));
  const deps = {
    settings: { get: () => DEFAULT_SETTINGS, set: vi.fn() },
    secrets: { status: vi.fn(), set: vi.fn() },
    service: { callRaw },
    showQuickEntry: vi.fn(),
    openItemInDashboard: vi.fn(),
    appInfo: vi.fn(),
    serviceState: () => null,
    hotkeys: vi.fn(),
    armCheck,
    isAllowedExternalUrl: () => false,
    openExternal: vi.fn(),
    dialogs: { openHtmlFile: vi.fn(), openFolder: vi.fn(), saveFile: vi.fn() },
    files: { stat: vi.fn(), readBytes: vi.fn(), writeText: vi.fn() },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as MainRpcDeps;
  const router = createRpcRouter(deps);
  const call = (m: string, p: unknown) => router({ window: null, hideWindow: vi.fn() }, m, p);
  const fail = (m: string, p: unknown) =>
    call(m, p).then(
      () => null,
      (e: unknown) => e as Error,
    );
  return { call, fail, armCheck, callRaw };
}

describe("'check.arm'", () => {
  it('is a main method, never forwarded to the service', async () => {
    expect(MAIN_METHODS).toContain('check.arm');
    expect(SERVICE_METHODS).not.toContain('check.arm');
    const r = route();
    expect(await r.call('check.arm', { sku: '378;6', name: 'Team Captain' })).toEqual({ armedUntil: 1_000 });
    expect(r.callRaw).not.toHaveBeenCalled();
  });

  it('passes a cleaned arm on (SKU lower-cased, both trimmed), and null as a disarm', async () => {
    const r = route();
    await r.call('check.arm', { sku: ' 378;6;U17 ', name: '  Burning Flames Team Captain ', extra: 'dropped' });
    expect(await r.call('check.arm', null)).toEqual({ armedUntil: null });
    expect(r.armCheck.mock.calls).toEqual([[{ sku: '378;6;u17', name: 'Burning Flames Team Captain' }], [null]]);
  });

  it('accepts a name of exactly CHECK_ARM_NAME_MAX characters', async () => {
    const r = route();
    await r.call('check.arm', { sku: '378;6', name: 'x'.repeat(CHECK_ARM_NAME_MAX) });
    expect(r.armCheck).toHaveBeenCalledTimes(1);
  });

  it('refuses bad params with fixed messages that never quote the name', async () => {
    const r = route();
    const bad: unknown[] = [
      undefined,
      MARKER,
      { name: MARKER },
      { sku: MARKER, name: MARKER },
      { sku: '378;6;uncratable', name: MARKER },
      { sku: 378, name: MARKER },
      { sku: '378;6' },
      { sku: '378;6', name: '   ' },
      { sku: '378;6', name: `${MARKER} `.repeat(30) },
      { sku: '378;6', name: `${MARKER}\nline two` },
      { sku: '378;6', name: { value: MARKER } },
    ];
    for (const p of bad) {
      const err = await r.fail('check.arm', p);
      expect(err?.message, JSON.stringify(p ?? null).slice(0, 40)).toMatch(/^Invalid parameters for check\.arm: /);
      expect(err?.message).not.toContain('Zq7');
    }
    expect(r.armCheck).not.toHaveBeenCalled();
  });
});

describe("a page's 'check.text' hint", () => {
  it('is refused: only main adds one', async () => {
    const r = route();
    const err = await r.fail('check.text', { text: '1.33 ref', source: 'manual', hint: { sku: '378;6' } });
    expect(err?.message).toBe(CHECK_TEXT_HINT_REFUSAL);
    expect(err?.message).not.toContain('1.33');
    expect(r.callRaw).not.toHaveBeenCalled();
  });

  it('still refuses a non-manual source first, and passes a manual check without a hint', async () => {
    const r = route();
    expect((await r.fail('check.text', { text: 'x', source: 'hotkey', hint: { sku: '378;6' } }))?.message).toBe(CHECK_TEXT_SOURCE_REFUSAL);
    await r.call('check.text', { text: 'Team Captain', source: 'manual', hint: undefined });
    expect(r.callRaw).toHaveBeenCalledTimes(1);
  });
});
