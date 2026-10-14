import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  DASHBOARD_URL,
  isAllowedRendererRequest,
  isAppNavigationUrl,
  isTrustedSenderUrl,
  mimeTypeFor,
  parseCsp,
  parseLaunchArgs,
  QUICK_ENTRY_URL,
  readFileBounded,
  readFileRetrySync,
  RENDERER_CSP,
  RENDERER_CSP_META,
  RENDERER_IMAGE_HOSTS,
  resolveAppPaths,
  resolveAppRequest,
  restartDelayMs,
  safeErrorMessage,
  sanitizeFileName,
  writeFileAtomicSync,
  type AtomicWriteFs,
} from '../../src/main/paths';

const ROOT = path.resolve(os.tmpdir(), 'flipdesk-root', 'dist', 'renderer');

describe('resolveAppRequest', () => {
  it('serves index.html for the root and for /index.html', () => {
    for (const url of ['app://app/', 'app://app', 'app://app/index.html', 'app://app/index.html#/quick', 'app://app/?x=1']) {
      const r = resolveAppRequest(ROOT, url);
      expect(r).toEqual({ ok: true, filePath: path.join(ROOT, 'index.html'), mimeType: 'text/html; charset=utf-8' });
    }
  });

  it('maps nested assets with decoded names', () => {
    const r = resolveAppRequest(ROOT, 'app://app/assets/index-AbC12.js');
    expect(r).toEqual({ ok: true, filePath: path.join(ROOT, 'assets', 'index-AbC12.js'), mimeType: 'text/javascript; charset=utf-8' });
    const spaced = resolveAppRequest(ROOT, 'app://app/assets/my%20font.woff2');
    expect(spaced.ok && spaced.filePath).toBe(path.join(ROOT, 'assets', 'my font.woff2'));
  });

  it('only allows GET', () => {
    for (const m of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect(resolveAppRequest(ROOT, DASHBOARD_URL, m)).toMatchObject({ ok: false, status: 405 });
    }
    expect(resolveAppRequest(ROOT, DASHBOARD_URL, 'get').ok).toBe(true);
  });

  it.each([
    ['plain dot-dot (URL parser collapses it, stays inside root)', 'app://app/../../secrets.json', 'inside'],
    ['encoded dots, collapsed by the URL parser', 'app://app/%2e%2e/%2e%2e/secrets.json', 'inside'],
    ['encoded dots and slash', 'app://app/%2e%2e%2f%2e%2e%2fsecrets.json', 403],
    ['upper-case encoding', 'app://app/%2E%2E%2F%2E%2E%2Fsecrets.json', 403],
    ['mixed', 'app://app/assets/..%2f..%2f..%2fsecrets.json', 403],
    ['backslash', 'app://app/..\\..\\secrets.json', 403],
    ['encoded backslash', 'app://app/..%5c..%5csecrets.json', 403],
    ['encoded backslash, upper', 'app://app/assets%5C..%5C..%5Csecrets.json', 403],
    ['null byte', 'app://app/index.html%00.png', 403],
    ['control char', 'app://app/a%0ab.js', 403],
    ['drive letter', 'app://app/C:/Windows/win.ini', 403],
    ['encoded drive letter', 'app://app/C%3A%5CWindows%5Cwin.ini', 403],
    ['alternate data stream', 'app://app/index.html::$DATA', 403],
    ['UNC-ish', 'app://app/%5c%5cserver%5cshare%5cx', 403],
    ['single dot segment', 'app://app/%2e/index.html', 'inside'],
    ['encoded single dot with slash', 'app://app/%2e%2findex.html', 403],
    ['wildcards', 'app://app/*.js', 403],
    ['bad percent encoding', 'app://app/%E0%A4%A', 400],
    ['trailing dot', 'app://app/index.html.', 404],
    ['trailing space', 'app://app/index.html%20', 404],
  ])('%s', (_label, url, expected) => {
    const r = resolveAppRequest(ROOT, url);
    if (expected === 'inside') {
      expect(r.ok).toBe(true);
      if (r.ok) expect(path.relative(ROOT, r.filePath).startsWith('..')).toBe(false);
    } else {
      expect(r).toMatchObject({ ok: false, status: expected });
    }
  });

  it('never resolves outside the root for a battery of hostile paths', () => {
    const hostile = [
      '..',
      '../',
      '%2e%2e',
      '%2e%2e%2f',
      '..%2f',
      '.%2e/',
      '%2e./',
      '..%5c',
      '..%c0%af',
      '%252e%252e%252f',
      '....//',
      '..;/',
      '/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
    ];
    for (const h of hostile) {
      for (const prefix of ['', 'assets/', 'a/b/']) {
        const r = resolveAppRequest(ROOT, `app://app/${prefix}${h}secrets.json`);
        if (r.ok) expect(path.relative(ROOT, r.filePath).startsWith('..')).toBe(false);
      }
    }
  });

  it('refuses other origins and schemes', () => {
    for (const url of [
      'app://evil/index.html',
      'app://app.evil/index.html',
      'app://user:pw@app/index.html',
      'file:///C:/Windows/win.ini',
      'https://app/index.html',
      'APP://evil/',
    ]) {
      expect(resolveAppRequest(ROOT, url)).toMatchObject({ ok: false, status: 403 });
    }
    expect(resolveAppRequest(ROOT, 'not a url')).toMatchObject({ ok: false, status: 400 });
  });
});

describe('mimeTypeFor', () => {
  it.each([
    ['a.html', 'text/html; charset=utf-8'],
    ['a.JS', 'text/javascript; charset=utf-8'],
    ['a.mjs', 'text/javascript; charset=utf-8'],
    ['a.css', 'text/css; charset=utf-8'],
    ['a.json', 'application/json; charset=utf-8'],
    ['a.svg', 'image/svg+xml'],
    ['a.png', 'image/png'],
    ['a.woff2', 'font/woff2'],
    ['a.wasm', 'application/wasm'],
    ['a.exe', 'application/octet-stream'],
    ['noext', 'application/octet-stream'],
  ])('%s -> %s', (file, mime) => expect(mimeTypeFor(file)).toBe(mime));
});

describe('sender and navigation checks', () => {
  it('trusts only app://app/ URLs', () => {
    expect(isTrustedSenderUrl(DASHBOARD_URL)).toBe(true);
    expect(isTrustedSenderUrl(QUICK_ENTRY_URL)).toBe(true);
    expect(isTrustedSenderUrl('app://app/')).toBe(true);
    for (const bad of [
      'app://app',
      'app://app.evil.com/',
      'app://app@evil.com/',
      'app://evil/',
      'app://APP/index.html',
      'https://app/index.html',
      'file:///C:/app/index.html',
      'devtools://devtools/bundled/inspector.html',
      'about:blank',
      '',
      null,
      undefined,
      42,
      { toString: () => 'app://app/' },
    ]) {
      expect(isTrustedSenderUrl(bad)).toBe(false);
    }
  });

  it('allows navigation only inside the app', () => {
    expect(isAppNavigationUrl('app://app/index.html#/journal')).toBe(true);
    expect(isAppNavigationUrl('https://backpack.tf/stats')).toBe(false);
    expect(isAppNavigationUrl('javascript:alert(1)')).toBe(false);
    expect(isAppNavigationUrl('app://other/index.html')).toBe(false);
  });

  it('lets renderers reach only the CSP image hosts over https', () => {
    expect(isAllowedRendererRequest('https://steamcdn-a.akamaihd.net/apps/440/icons/x.png')).toBe(true);
    expect(isAllowedRendererRequest('https://community.cloudflare.steamstatic.com/economy/image/abc')).toBe(true);
    expect(isAllowedRendererRequest('https://community.akamai.steamstatic.com/economy/image/abc')).toBe(true);
    for (const bad of [
      'http://steamcdn-a.akamaihd.net/x.png',
      'https://steamcdn-a.akamaihd.net:8443/x.png',
      'https://user@steamcdn-a.akamaihd.net/x.png',
      'https://evil.steamcdn-a.akamaihd.net/x.png',
      'https://scrap.tf/',
      'https://backpack.tf/api',
      'wss://ws.backpack.tf/events',
      'not a url',
    ]) {
      expect(isAllowedRendererRequest(bad)).toBe(false);
    }
  });
});

describe('CSP', () => {
  it('header is the meta policy plus frame-ancestors', () => {
    const header = parseCsp(RENDERER_CSP);
    const meta = parseCsp(RENDERER_CSP_META);
    expect(header.get('frame-ancestors')).toBe("'none'");
    expect(meta.has('frame-ancestors')).toBe(false);
    header.delete('frame-ancestors');
    expect(header).toEqual(meta);
    expect(meta.get('connect-src')).toBe("'none'");
    expect(meta.get('script-src')).toBe("'self'");
    expect(meta.get('form-action')).toBe("'none'");
    for (const host of RENDERER_IMAGE_HOSTS) expect(meta.get('img-src')).toContain(`https://${host}`);
  });

  it('equals the meta tag in src/renderer/index.html (frame-ancestors aside) when that file exists', () => {
    const file = fileURLToPath(new URL('../../src/renderer/index.html', import.meta.url));
    let html: string;
    try {
      html = readFileSync(file, 'utf8');
    } catch {
      return; // the renderer is built separately; nothing to compare yet
    }
    const tag = html.match(/<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/i)?.[0];
    expect(tag, 'index.html must carry a CSP meta tag').toBeDefined();
    const content = tag!.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    expect(content).not.toBeNull();
    const meta = parseCsp(content![1] ?? content![2]!);
    meta.delete('frame-ancestors');
    const header = parseCsp(RENDERER_CSP);
    header.delete('frame-ancestors');
    expect(meta).toEqual(header);
  });

  it('parseCsp normalises whitespace and order and keeps the first duplicate', () => {
    const p = parseCsp("  default-src  'self' ;img-src data:  'self' ; default-src *;");
    expect(p.get('default-src')).toBe("'self'");
    expect(p.get('img-src')).toBe("'self' data:");
  });
});

describe('parseLaunchArgs', () => {
  const cwd = path.resolve(os.tmpdir(), 'cwd');

  it('reads the flags', () => {
    const a = parseLaunchArgs(['electron.exe', '.', '--hidden', '--dev', '--smoke-test=out/report.json', '--user-data-dir=ud', '--smoke-wait=45'], cwd);
    expect(a).toEqual({
      hidden: true,
      dev: true,
      smokeTest: path.join(cwd, 'out', 'report.json'),
      userDataDir: path.join(cwd, 'ud'),
      smokeWaitSec: 45,
    });
    expect(parseLaunchArgs(['--smoke-wait=9999'], cwd).smokeWaitSec).toBe(300);
    expect(parseLaunchArgs(['--smoke-wait=abc'], cwd).smokeWaitSec).toBe(0);
  });

  it('defaults everything off and ignores empty values', () => {
    expect(parseLaunchArgs(['TF2 Flip Desk.exe', '--smoke-test=', '--user-data-dir'], cwd)).toEqual({
      hidden: false,
      dev: false,
      smokeTest: null,
      userDataDir: null,
      smokeWaitSec: 0,
    });
  });

  it('keeps absolute paths', () => {
    const abs = path.resolve(os.tmpdir(), 'abs-ud');
    expect(parseLaunchArgs([`--user-data-dir=${abs}`], cwd).userDataDir).toBe(abs);
  });

  it('ignores the diagnostic switches when they are not allowed (packaged builds), but keeps --hidden', () => {
    const argv = ['TF2 Flip Desk.exe', '--hidden', '--dev', '--smoke-test=C:/Users/u/Documents/journal.csv', '--smoke-wait=120', '--user-data-dir=ud'];
    expect(parseLaunchArgs(argv, cwd, { allowDiagnostics: false })).toEqual({
      hidden: true,
      dev: false,
      smokeTest: null,
      userDataDir: path.join(cwd, 'ud'),
      smokeWaitSec: 0,
    });
    expect(parseLaunchArgs(argv, cwd, { allowDiagnostics: true })).toMatchObject({ dev: true, smokeWaitSec: 120 });
  });
});

describe('readFileRetrySync', () => {
  const busy = (code: string) => Object.assign(new Error(code), { code });

  it('retries while the file is locked, then returns its text', () => {
    let calls = 0;
    const text = readFileRetrySync('settings.json', () => {
      if (++calls < 3) throw busy(calls === 1 ? 'EBUSY' : 'EPERM');
      return '{"a":1}';
    });
    expect(text).toBe('{"a":1}');
    expect(calls).toBe(3);
  });

  it('gives up after a few attempts and rethrows', () => {
    let calls = 0;
    expect(() =>
      readFileRetrySync('settings.json', () => {
        calls++;
        throw busy('EACCES');
      }),
    ).toThrow('EACCES');
    expect(calls).toBe(6);
  });

  it('does not retry a missing file', () => {
    let calls = 0;
    expect(() =>
      readFileRetrySync('settings.json', () => {
        calls++;
        throw busy('ENOENT');
      }),
    ).toThrow('ENOENT');
    expect(calls).toBe(1);
  });
});

describe('readFileBounded', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-bounded-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a whole small file and at most maxBytes of a large one', async () => {
    const file = path.join(dir, 'page.html');
    writeFileSync(file, Buffer.alloc(3 * 1024 * 1024 + 7, 0x61));
    expect((await readFileBounded(file, 10 * 1024 * 1024)).byteLength).toBe(3 * 1024 * 1024 + 7);
    const cut = await readFileBounded(file, 1024 * 1024 + 1);
    expect(cut.byteLength).toBe(1024 * 1024 + 1);
    expect(cut[0]).toBe(0x61);
    writeFileSync(file, '');
    expect((await readFileBounded(file, 100)).byteLength).toBe(0);
  });

  it('closes the file even when a read fails', async () => {
    const close = vi.fn(async () => undefined);
    const openImpl = vi.fn(async () => ({
      read: async () => {
        throw new Error('EIO');
      },
      close,
    }));
    await expect(readFileBounded('x.html', 10, openImpl)).rejects.toThrow('EIO');
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('resolveAppPaths', () => {
  it('lays out bundle and user files', () => {
    const app = path.resolve(os.tmpdir(), 'resources', 'app.asar');
    const ud = path.resolve(os.tmpdir(), 'Roaming', 'TF2 Flip Desk');
    const p = resolveAppPaths(app, ud);
    expect(p.rendererRoot).toBe(path.join(app, 'dist', 'renderer'));
    expect(p.preload).toBe(path.join(app, 'dist', 'preload.cjs'));
    expect(p.serviceEntry).toBe(path.join(app, 'dist', 'service.cjs'));
    expect(p.trayPng).toBe(path.join(app, 'assets', 'tray.png'));
    expect(p.settingsFile).toBe(path.join(ud, 'settings.json'));
    expect(p.secretsFile).toBe(path.join(ud, 'secrets.json'));
    expect(p.dataDir).toBe(path.join(ud, 'data'));
    expect(p.mainLog).toBe(path.join(ud, 'logs', 'main.log'));
  });
});

describe('restartDelayMs', () => {
  it('doubles from 1 s and caps at 60 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 50].map((n) => restartDelayMs(n))).toEqual([
      1000, 1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
    ]);
  });
});

describe('safeErrorMessage', () => {
  it('returns the message without the stack', () => {
    const e = new Error('boom');
    e.stack = 'Error: boom\n    at C:\\Users\\me\\app\\main.cjs:1:1';
    expect(safeErrorMessage(e)).toBe('boom');
    expect(safeErrorMessage('plain')).toBe('plain');
    expect(safeErrorMessage({ weird: true })).toBe('Unknown error');
    expect(safeErrorMessage(new Error(''))).toBe('Unknown error');
  });

  it('strips stacks embedded in messages and bounds the length', () => {
    expect(safeErrorMessage(new Error('bad thing\n    at foo (C:\\x\\y.js:1:2)\n    at bar'))).toBe('bad thing');
    expect(safeErrorMessage(new Error('x'.repeat(2000))).length).toBe(500);
  });
});

describe('sanitizeFileName', () => {
  it.each([
    ['flipdesk-opportunities-2026-10-14.csv', 'flipdesk-opportunities-2026-10-14.csv'],
    ['..\\..\\Windows\\evil.csv', 'evil.csv'],
    ['../../etc/passwd', 'passwd'],
    ['a<b>c:d"e|f?g*h.csv', 'a_b_c_d_e_f_g_h.csv'],
    ['report.csv. . ', 'report.csv'],
    ['CON', '_CON'],
    ['nul.csv', '_nul.csv'],
    ['', 'fallback.csv'],
    ['..', 'fallback.csv'],
    ['dir/', 'fallback.csv'],
  ])('%s -> %s', (input, out) => expect(sanitizeFileName(input, 'fallback.csv')).toBe(out));

  it('bounds the length', () => {
    expect(sanitizeFileName(`${'a'.repeat(300)}.csv`, 'x').length).toBe(120);
  });
});

describe('writeFileAtomicSync', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-atomic-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes, overwrites and leaves no temp files', () => {
    const file = path.join(dir, 'nested', 'settings.json');
    writeFileAtomicSync(file, '{"a":1}');
    writeFileAtomicSync(file, '{"a":2}');
    expect(readFileSync(file, 'utf8')).toBe('{"a":2}');
    expect(readdirSync(path.dirname(file))).toEqual(['settings.json']);
  });

  it('retries a busy rename and then succeeds', async () => {
    const real = await import('node:fs');
    const file = path.join(dir, 'busy.json');
    let calls = 0;
    const fsImpl: AtomicWriteFs = {
      mkdirSync: real.mkdirSync,
      openSync: real.openSync,
      writeSync: (fd, data) => real.writeSync(fd, data),
      fsyncSync: real.fsyncSync,
      closeSync: real.closeSync,
      unlinkSync: real.unlinkSync,
      renameSync: (a, b) => {
        if (++calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        real.renameSync(a, b);
      },
    };
    writeFileAtomicSync(file, 'ok', fsImpl);
    expect(calls).toBe(3);
    expect(readFileSync(file, 'utf8')).toBe('ok');
  });

  it('removes the temp file and rethrows on a hard failure', async () => {
    const real = await import('node:fs');
    const file = path.join(dir, 'fail.json');
    writeFileSync(file, 'old');
    const unlink = vi.fn(real.unlinkSync);
    const fsImpl: AtomicWriteFs = {
      mkdirSync: real.mkdirSync,
      openSync: real.openSync,
      writeSync: (fd, data) => real.writeSync(fd, data),
      fsyncSync: real.fsyncSync,
      closeSync: real.closeSync,
      unlinkSync: unlink,
      renameSync: () => {
        throw Object.assign(new Error('nope'), { code: 'EXDEV' });
      },
    };
    expect(() => writeFileAtomicSync(file, 'new', fsImpl)).toThrow('nope');
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(readFileSync(file, 'utf8')).toBe('old');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
