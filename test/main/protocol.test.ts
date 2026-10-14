import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RENDERER_CSP } from '../../src/main/paths';
import { APP_SCHEME_PRIVILEGES, createAppRequestHandler, registerAppProtocol } from '../../src/main/protocol';

let base: string;
let root: string;

beforeAll(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-proto-'));
  root = path.join(base, 'dist', 'renderer');
  mkdirSync(path.join(root, 'assets'), { recursive: true });
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>x</title>');
  writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(path.join(root, 'assets', 'logo.svg'), '<svg/>');
  // Things the handler must never serve.
  writeFileSync(path.join(base, 'secrets.json'), '{"secret":"top"}');
  writeFileSync(path.join(base, 'dist', 'main.cjs'), 'main');
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const get = (url: string, method = 'GET') => createAppRequestHandler({ rootDir: root })(new Request(url, { method }));

describe('createAppRequestHandler', () => {
  it('serves index.html with the security headers', async () => {
    const res = await get('app://app/index.html');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<!doctype html><title>x</title>');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(RENDERER_CSP);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-length')).toBe('31');
  });

  it('serves the root as index.html and assets with their MIME types', async () => {
    expect((await get('app://app/')).status).toBe(200);
    const js = await get('app://app/assets/app.js');
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await js.text()).toBe('console.log(1)');
    expect((await get('app://app/assets/logo.svg')).headers.get('content-type')).toBe('image/svg+xml');
  });

  it('returns 404 for missing files and directories, still with nosniff and CSP', async () => {
    for (const url of ['app://app/missing.js', 'app://app/assets', 'app://app/assets/']) {
      const res = await get(url);
      expect(res.status).toBe(404);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toBe(RENDERER_CSP);
    }
  });

  it('refuses anything but GET with 405 and an Allow header', async () => {
    const res = await get('app://app/index.html', 'POST');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it.each([
    'app://app/%2e%2e%2f%2e%2e%2fsecrets.json',
    'app://app/..%2f..%2fsecrets.json',
    'app://app/..%5c..%5csecrets.json',
    'app://app/assets/..%2f..%2fmain.cjs',
    'app://app/%2e%2e%2fmain.cjs',
    'app://app/index.html%00',
    'app://evil/index.html',
  ])('never serves files outside the root: %s', async (url) => {
    const res = await get(url);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.text();
    expect(body).not.toContain('secret');
    expect(body).not.toBe('main');
  });

  it('keeps plain ../ inside the root (Request/URL collapse it first)', async () => {
    const res = await get('app://app/../../secrets.json');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('secret');
  });

  it('logs refused requests', async () => {
    const warn = vi.fn();
    const handler = createAppRequestHandler({ rootDir: root, log: { warn } });
    await handler(new Request('app://app/%2e%2e%2fsecrets.json'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused'), expect.anything());
  });

  it('uses the injected reader and CSP', async () => {
    const readFile = vi.fn(async () => new TextEncoder().encode('hi'));
    const handler = createAppRequestHandler({ rootDir: root, readFile, csp: "default-src 'none'" });
    const res = await handler(new Request('app://app/x.txt'));
    expect(readFile).toHaveBeenCalledWith(path.join(root, 'x.txt'));
    expect(await res.text()).toBe('hi');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
  });
});

describe('registration', () => {
  it('declares a standard, secure, fetch-capable scheme', () => {
    expect(APP_SCHEME_PRIVILEGES).toEqual({
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    });
  });

  it('installs the handler for the app scheme', async () => {
    const handle = vi.fn();
    registerAppProtocol({ handle }, root, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    expect(handle).toHaveBeenCalledWith('app', expect.any(Function));
    const handler = handle.mock.calls[0]![1] as (r: Request) => Promise<Response>;
    expect((await handler(new Request('app://app/index.html'))).status).toBe(200);
  });
});
