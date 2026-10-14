import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  createRpcRouter,
  isKnownMethod,
  registerRpcHandler,
  senderUrlOf,
  withCsvExtension,
  type MainRpcDeps,
  type RpcCallContext,
  type RpcEnvelope,
} from '../../src/main/ipc';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { decodeHtmlBuffer } from '../../src/shared/htmlDecode';
import { MAIN_METHODS, SERVICE_METHODS } from '../../src/shared/rpc';
import { applySettingsPatch } from '../../src/shared/settingsSchema';
import type { Settings } from '../../src/shared/types';

function makeDeps(overrides: Partial<MainRpcDeps> = {}) {
  let settings: Settings = structuredClone(DEFAULT_SETTINGS);
  const deps = {
    settings: {
      get: vi.fn(() => settings),
      set: vi.fn((patch: unknown) => {
        settings = applySettingsPatch(settings, patch);
        return settings;
      }),
    },
    secrets: {
      status: vi.fn(() => ({ bptfApiKey: false, bptfAccessToken: false, steamApiKey: false })),
      set: vi.fn((name: string, value: string | null) => ({
        bptfApiKey: name === 'bptfApiKey' && value !== null,
        bptfAccessToken: false,
        steamApiKey: false,
      })),
    },
    service: { callRaw: vi.fn(async (method: string, params: unknown) => ({ forwarded: method, params })) },
    showQuickEntry: vi.fn(),
    openItemInDashboard: vi.fn(),
    appInfo: vi.fn(() => ({ version: '0.1.0', dataDir: 'd', logDir: 'l', platform: 'win32', electron: '44', node: '24' })),
    isAllowedExternalUrl: vi.fn((url: string) => url.startsWith('https://backpack.tf/')),
    openExternal: vi.fn(async () => undefined),
    dialogs: {
      openHtmlFile: vi.fn(async (): Promise<string | null> => 'C:\\pages\\Buy Hats - scrap.tf.html'),
      openFolder: vi.fn(async (): Promise<string | null> => 'C:\\pages'),
      saveFile: vi.fn(async (_w: unknown, name: string): Promise<string | null> => `C:\\out\\${name}`),
    },
    files: {
      stat: vi.fn(
        async (_f: string): Promise<{ size: number; mtimeMs: number; isFile(): boolean }> => ({
          size: 1234,
          mtimeMs: 1_700_000_000_123.6,
          isFile: () => true,
        }),
      ),
      readBytes: vi.fn(async (_f: string, _max: number): Promise<Uint8Array> => new TextEncoder().encode('<html>saved</html>')),
      writeText: vi.fn(async () => undefined),
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  // Overrides replace whole members; the mocks stay typed for the tests that use them.
  Object.assign(deps, overrides);
  const enableImport = () => {
    settings = applySettingsPatch(settings, { import: { enabled: true, acknowledgedAt: 1 } });
  };
  return { deps, enableImport };
}

const ctx = () => ({ window: { id: 1 } as unknown, hideWindow: vi.fn<() => void>() }) satisfies RpcCallContext;

describe('method membership', () => {
  it('knows every main and service method and nothing else', () => {
    for (const m of [...MAIN_METHODS, ...SERVICE_METHODS]) expect(isKnownMethod(m)).toBe(true);
    for (const m of ['', 'constructor', '__proto__', 'toString', 'app.quit', 'shell.openExternal', 42, null]) {
      expect(isKnownMethod(m)).toBe(false);
    }
  });

  it('rejects unknown and non-string methods', async () => {
    const { deps } = makeDeps();
    const route = createRpcRouter(deps);
    await expect(route(ctx(), 'app.quit', undefined)).rejects.toThrow('Unknown method: app.quit');
    await expect(route(ctx(), { method: 'x' }, undefined)).rejects.toThrow('Invalid method');
    await expect(route(ctx(), 'hasOwnProperty', undefined)).rejects.toThrow(/Unknown method/);
    expect(deps.service.callRaw).not.toHaveBeenCalled();
  });
});

describe('service forwarding', () => {
  it('forwards every service method with its params untouched', async () => {
    const { deps } = makeDeps();
    const route = createRpcRouter(deps);
    for (const m of SERVICE_METHODS) {
      if (m === 'import.html') continue;
      await expect(route(ctx(), m, { a: 1 })).resolves.toEqual({ forwarded: m, params: { a: 1 } });
    }
    expect(deps.service.callRaw).toHaveBeenCalledTimes(SERVICE_METHODS.length - 1);
  });

  it('caps import.html at 20 MB before forwarding', async () => {
    const { deps } = makeDeps();
    const route = createRpcRouter(deps);
    await expect(route(ctx(), 'import.html', { html: 'x'.repeat(20 * 1024 * 1024 + 1), fileName: 'a', mtimeMs: 1 })).rejects.toThrow(
      /Invalid parameters for import\.html/,
    );
    await expect(route(ctx(), 'import.html', { html: '<p/>', fileName: 'a.html', mtimeMs: 1 })).resolves.toMatchObject({
      forwarded: 'import.html',
    });
  });

  it('passes service errors through', async () => {
    const { deps } = makeDeps({
      service: {
        callRaw: vi.fn(async () => {
          throw new Error('Rate limit for bptf-snapshot');
        }),
      },
    });
    await expect(createRpcRouter(deps)(ctx(), 'item.refresh', { sku: '5021;6' })).rejects.toThrow('Rate limit');
  });
});

describe('main methods', () => {
  it('app.info, quick entry and hiding the calling window', async () => {
    const { deps } = makeDeps();
    const route = createRpcRouter(deps);
    await expect(route(ctx(), 'app.info', undefined)).resolves.toMatchObject({ version: '0.1.0' });
    await expect(route(ctx(), 'app.showQuickEntry', undefined)).resolves.toEqual({ ok: true });
    expect(deps.showQuickEntry).toHaveBeenCalledTimes(1);
    const c = ctx();
    await expect(route(c, 'app.hideWindow', { ignored: true })).resolves.toEqual({ ok: true });
    expect(c.hideWindow).toHaveBeenCalledTimes(1);
  });

  it('app.openItem shows the dashboard with a validated SKU', async () => {
    const { deps } = makeDeps();
    const route = createRpcRouter(deps);
    await expect(route(ctx(), 'app.openItem', { sku: ' 378;5;u13 ' })).resolves.toEqual({ ok: true });
    expect(deps.openItemInDashboard).toHaveBeenCalledWith('378;5;u13');
    await expect(route(ctx(), 'app.openItem', { sku: 'javascript:alert(1)' })).rejects.toThrow(/Invalid parameters/);
    await expect(route(ctx(), 'app.openItem', {})).rejects.toThrow(/Invalid parameters/);
    expect(deps.openItemInDashboard).toHaveBeenCalledTimes(1);
  });

  it('settings.get and settings.set with validation', async () => {
    const { deps } = makeDeps();
    const route = createRpcRouter(deps);
    await expect(route(ctx(), 'settings.get', undefined)).resolves.toEqual(DEFAULT_SETTINGS);
    const next = (await route(ctx(), 'settings.set', { networkPaused: true })) as Settings;
    expect(next.networkPaused).toBe(true);
    await expect(route(ctx(), 'settings.set', { profit: { minMargin: 'high' } })).rejects.toThrow(/profit\.minMargin/);
    await expect(route(ctx(), 'settings.set', [1, 2])).rejects.toThrow(/Invalid settings/);
    expect(deps.settings.set).toHaveBeenCalledTimes(1);
  });

  it('secrets.status and secrets.set validate name and length', async () => {
    const { deps } = makeDeps();
    const route = createRpcRouter(deps);
    await expect(route(ctx(), 'secrets.status', undefined)).resolves.toEqual({
      bptfApiKey: false,
      bptfAccessToken: false,
      steamApiKey: false,
    });
    await expect(route(ctx(), 'secrets.set', { name: 'bptfApiKey', value: 'abc123' })).resolves.toMatchObject({ bptfApiKey: true });
    expect(deps.secrets.set).toHaveBeenCalledWith('bptfApiKey', 'abc123');
    await expect(route(ctx(), 'secrets.set', { name: 'bptfApiKey', value: null })).resolves.toBeDefined();
    for (const bad of [
      { name: 'steamPassword', value: 'x' },
      { name: 'bptfApiKey', value: 'x'.repeat(513) },
      { name: 'bptfApiKey', value: 42 },
      { name: 'bptfApiKey' },
      null,
    ]) {
      await expect(route(ctx(), 'secrets.set', bad)).rejects.toThrow(/Invalid parameters for secrets\.set/);
    }
    expect(deps.secrets.set).toHaveBeenCalledTimes(2);
  });

  it('links.open opens only allowlisted https URLs', async () => {
    const { deps } = makeDeps();
    const route = createRpcRouter(deps);
    await expect(route(ctx(), 'links.open', { url: 'https://backpack.tf/stats/Unique/Key' })).resolves.toEqual({
      opened: true,
      reason: null,
    });
    expect(deps.openExternal).toHaveBeenCalledWith('https://backpack.tf/stats/Unique/Key');

    for (const url of ['https://scrap.tf/hats', 'http://backpack.tf/x', 'file:///C:/x', 'javascript:alert(1)']) {
      const r = (await route(ctx(), 'links.open', { url })) as { opened: boolean; reason: string };
      expect(r.opened).toBe(false);
      expect(r.reason).toMatch(/not on the list/);
    }
    expect(deps.openExternal).toHaveBeenCalledTimes(1);
    await expect(route(ctx(), 'links.open', { url: `https://backpack.tf/${'x'.repeat(5000)}` })).rejects.toThrow(/Invalid parameters/);
    await expect(route(ctx(), 'links.open', {})).rejects.toThrow(/Invalid parameters/);
  });

  it('links.open double-checks https even if the allowlist says yes', async () => {
    const { deps } = makeDeps({ isAllowedExternalUrl: vi.fn(() => true) });
    const r = await createRpcRouter(deps)(ctx(), 'links.open', { url: 'http://backpack.tf/' });
    expect(r).toMatchObject({ opened: false });
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('links.open treats an allowlist exception as a refusal', async () => {
    const { deps } = makeDeps({
      isAllowedExternalUrl: vi.fn(() => {
        throw new Error('bug');
      }),
    });
    await expect(createRpcRouter(deps)(ctx(), 'links.open', { url: 'https://backpack.tf/' })).resolves.toMatchObject({ opened: false });
  });
});

describe('import.pickFile', () => {
  it('is refused while import is disabled, before any dialog opens', async () => {
    const { deps } = makeDeps();
    await expect(createRpcRouter(deps)(ctx(), 'import.pickFile', undefined)).rejects.toThrow(/turned off/);
    expect(deps.dialogs.openHtmlFile).not.toHaveBeenCalled();
  });

  it('reads the chosen file and forwards it to import.html', async () => {
    const { deps, enableImport } = makeDeps();
    enableImport();
    const c = ctx();
    const r = await createRpcRouter(deps)(c, 'import.pickFile', undefined);
    expect(deps.dialogs.openHtmlFile).toHaveBeenCalledWith(c.window);
    expect(deps.service.callRaw).toHaveBeenCalledWith('import.html', {
      html: '<html>saved</html>',
      fileName: 'Buy Hats - scrap.tf.html',
      mtimeMs: 1_700_000_000_124,
    });
    expect(r).toMatchObject({ forwarded: 'import.html' });
  });

  it('returns null when the dialog is cancelled', async () => {
    const { deps, enableImport } = makeDeps();
    enableImport();
    deps.dialogs.openHtmlFile.mockResolvedValueOnce(null);
    await expect(createRpcRouter(deps)(ctx(), 'import.pickFile', undefined)).resolves.toBeNull();
    expect(deps.files.readBytes).not.toHaveBeenCalled();
  });

  it('refuses files over 20 MB, directories and non-html files without reading them', async () => {
    const { deps, enableImport } = makeDeps();
    enableImport();
    const route = createRpcRouter(deps);
    deps.files.stat.mockResolvedValueOnce({ size: 20 * 1024 * 1024 + 1, mtimeMs: 1, isFile: () => true });
    await expect(route(ctx(), 'import.pickFile', undefined)).rejects.toThrow(/larger than 20 MB/);
    deps.files.stat.mockResolvedValueOnce({ size: 10, mtimeMs: 1, isFile: () => false });
    await expect(route(ctx(), 'import.pickFile', undefined)).rejects.toThrow(/saved \.html page/);
    deps.dialogs.openHtmlFile.mockResolvedValueOnce('C:\\pages\\notes.txt');
    await expect(route(ctx(), 'import.pickFile', undefined)).rejects.toThrow(/saved \.html page/);
    expect(deps.files.readBytes).not.toHaveBeenCalled();
  });

  it('reads at most 20 MB + 1 byte and refuses a file that grew past the limit after the size check', async () => {
    const { deps, enableImport } = makeDeps();
    enableImport();
    deps.files.readBytes.mockResolvedValueOnce(new Uint8Array(20 * 1024 * 1024 + 1));
    await expect(createRpcRouter(deps)(ctx(), 'import.pickFile', undefined)).rejects.toThrow(/larger than 20 MB/);
    expect(deps.files.readBytes).toHaveBeenCalledWith('C:\\pages\\Buy Hats - scrap.tf.html', 20 * 1024 * 1024 + 1);
    expect(deps.service.callRaw).not.toHaveBeenCalled();
  });

  it('decodes UTF-16 pages (byte order mark) the same way as the folder watcher', async () => {
    const page = '<html><body><p>Bill’s Hat é</p></body></html>';
    const le = new Uint8Array([0xff, 0xfe, ...Buffer.from(page, 'utf16le')]);
    const be = new Uint8Array([0xfe, 0xff, ...Buffer.from(page, 'utf16le').swap16()]);
    const bom8 = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(page, 'utf8')]);
    for (const bytes of [le, be, bom8]) {
      const { deps, enableImport } = makeDeps();
      enableImport();
      deps.files.readBytes.mockResolvedValueOnce(bytes);
      await createRpcRouter(deps)(ctx(), 'import.pickFile', undefined);
      expect(deps.service.callRaw).toHaveBeenCalledWith('import.html', expect.objectContaining({ html: page }));
      expect(decodeHtmlBuffer(bytes)).toBe(page);
    }
  });

  it('forwards a real saved page re-saved as "Unicode" (UTF-16 LE) unchanged', async () => {
    const original = readFileSync(fileURLToPath(new URL('../fixtures/import/buy_hats.html', import.meta.url)), 'utf8');
    const { deps, enableImport } = makeDeps();
    enableImport();
    deps.files.readBytes.mockResolvedValueOnce(new Uint8Array([0xff, 0xfe, ...Buffer.from(original, 'utf16le')]));
    await createRpcRouter(deps)(ctx(), 'import.pickFile', undefined);
    const forwarded = deps.service.callRaw.mock.calls[0]![1] as { html: string };
    expect(forwarded.html).toBe(original.charCodeAt(0) === 0xfeff ? original.slice(1) : original);
  });
});

describe('import.pickWatchFolder and file.saveText', () => {
  it('returns the chosen folder or null', async () => {
    const { deps } = makeDeps();
    const route = createRpcRouter(deps);
    await expect(route(ctx(), 'import.pickWatchFolder', undefined)).resolves.toEqual({ folder: 'C:\\pages' });
    deps.dialogs.openFolder.mockResolvedValueOnce(null);
    await expect(route(ctx(), 'import.pickWatchFolder', undefined)).resolves.toEqual({ folder: null });
  });

  it('saves text under a sanitised suggested name', async () => {
    const { deps } = makeDeps();
    const route = createRpcRouter(deps);
    const r = await route(ctx(), 'file.saveText', { suggestedName: '..\\..\\evil:name.csv', text: 'a,b\n1,2\n' });
    expect(deps.dialogs.saveFile).toHaveBeenCalledWith({ id: 1 }, 'evil_name.csv');
    expect(deps.files.writeText).toHaveBeenCalledWith('C:\\out\\evil_name.csv', 'a,b\n1,2\n');
    expect(r).toEqual({ saved: true, path: 'C:\\out\\evil_name.csv' });
  });

  it('always offers a .csv name, whatever extension the caller suggests', async () => {
    const { deps } = makeDeps();
    const route = createRpcRouter(deps);
    for (const [suggested, offered] of [
      ['opportunities-2026-10-14.bat', 'opportunities-2026-10-14.csv'],
      ['x.HTA', 'x.csv'],
      ['link.url', 'link.csv'],
      ['journal', 'journal.csv'],
      ['report.CSV', 'report.CSV'],
      ['', 'export.csv'],
    ]) {
      deps.dialogs.saveFile.mockClear();
      await route(ctx(), 'file.saveText', { suggestedName: suggested, text: 'a' });
      expect(deps.dialogs.saveFile).toHaveBeenCalledWith({ id: 1 }, offered);
    }
    expect(withCsvExtension('a.b.cmd')).toBe('a.b.csv');
  });

  it('refuses to write anything but .csv or .txt, even when the user picks another type', async () => {
    const { deps } = makeDeps();
    const route = createRpcRouter(deps);
    for (const target of ['C:\\out\\x.bat', 'C:\\out\\x.hta', 'C:\\out\\x', 'C:\\out\\x.csv.lnk']) {
      deps.dialogs.saveFile.mockResolvedValueOnce(target);
      await expect(route(ctx(), 'file.saveText', { suggestedName: 'x.csv', text: '@echo off' })).rejects.toThrow(/\.csv or \.txt/);
    }
    expect(deps.files.writeText).not.toHaveBeenCalled();
    deps.dialogs.saveFile.mockResolvedValueOnce('C:\\out\\notes.TXT');
    await expect(route(ctx(), 'file.saveText', { suggestedName: 'x.csv', text: 'a' })).resolves.toEqual({
      saved: true,
      path: 'C:\\out\\notes.TXT',
    });
  });

  it('reports a cancelled save and validates params', async () => {
    const { deps } = makeDeps();
    const route = createRpcRouter(deps);
    deps.dialogs.saveFile.mockResolvedValueOnce(null);
    await expect(route(ctx(), 'file.saveText', { suggestedName: 'x.csv', text: '' })).resolves.toEqual({ saved: false, path: null });
    await expect(route(ctx(), 'file.saveText', { suggestedName: 'x.csv' })).rejects.toThrow(/Invalid parameters for file\.saveText/);
    expect(deps.files.writeText).not.toHaveBeenCalled();
  });
});

describe('registerRpcHandler', () => {
  type Handler = (event: unknown, method: unknown, params: unknown) => Promise<RpcEnvelope>;

  function register(router = vi.fn(async (_c: RpcCallContext, m: unknown) => ({ echoed: m }))) {
    let handler: Handler | null = null;
    const ipcMain = {
      handle: vi.fn((channel: string, fn: Handler) => {
        expect(channel).toBe('rpc');
        handler = fn;
      }),
    };
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const contextFor = vi.fn(() => ctx());
    registerRpcHandler(ipcMain as never, router, contextFor as never, log);
    return { invoke: (event: unknown, m: unknown, p?: unknown) => handler!(event, m, p), router, log, contextFor };
  }

  const frame = (url: string, parent: unknown = null) => ({ senderFrame: { url, parent } });

  it('accepts the dashboard and quick-entry frames and wraps results', async () => {
    const h = register();
    await expect(h.invoke(frame('app://app/index.html'), 'status.get')).resolves.toEqual({
      ok: true,
      result: { echoed: 'status.get' },
    });
    await expect(h.invoke(frame('app://app/index.html#/quick'), 'app.info')).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ['remote page', frame('https://evil.example.com/')],
    ['file url', frame('file:///C:/x.html')],
    ['lookalike host', frame('app://app.evil/')],
    ['subframe', frame('app://app/index.html', { url: 'app://app/' })],
    ['no frame', { senderFrame: null }],
    [
      'destroyed frame',
      {
        get senderFrame() {
          throw new Error('Render frame was disposed');
        },
      },
    ],
  ])('throws for an untrusted sender: %s', async (_label, event) => {
    const h = register();
    await expect(h.invoke(event, 'settings.get')).rejects.toThrow('Untrusted sender');
    expect(h.router).not.toHaveBeenCalled();
    expect(h.log.warn).toHaveBeenCalled();
  });

  it('returns errors as bounded messages without stacks', async () => {
    const err = new Error('ENOENT: no such file\n    at Object.openSync (node:fs:1:1)');
    const h = register(vi.fn(async () => Promise.reject(err)));
    await expect(h.invoke(frame('app://app/index.html'), 'file.saveText')).resolves.toEqual({
      ok: false,
      error: 'ENOENT: no such file',
    });
  });

  it('builds the call context from the event', async () => {
    const h = register();
    const ev = frame('app://app/index.html');
    await h.invoke(ev, 'app.hideWindow');
    expect(h.contextFor).toHaveBeenCalledWith(ev);
  });
});

describe('senderUrlOf', () => {
  it('returns the main-frame URL or null', () => {
    expect(senderUrlOf({ senderFrame: { url: 'app://app/', parent: null } } as never)).toBe('app://app/');
    expect(senderUrlOf({ senderFrame: { url: 'app://app/', parent: {} } } as never)).toBeNull();
    expect(senderUrlOf({ senderFrame: null } as never)).toBeNull();
  });
});
