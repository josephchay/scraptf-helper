import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFolderWatcher, decodeHtmlBuffer, isImportCandidate, type WatchFactory } from '../../src/service/import';
import type { Logger } from '../../src/service/contracts';

interface Delivered {
  path: string;
  html: string;
  mtimeMs: number;
}

function makeLog(): Logger & { lines: { level: string; msg: string }[] } {
  const lines: { level: string; msg: string }[] = [];
  const push = (level: string) => (msg: string) => {
    lines.push({ level, msg });
  };
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

/** Fake fs.watch: tests emit events by hand. */
function fakeWatch(): { factory: WatchFactory; emit(name: string | null): void; fail(err: Error): void; closed: () => number; folders: string[] } {
  let listener: ((event: string, fileName: string | null) => void) | null = null;
  let onError: ((err: Error) => void) | null = null;
  let closed = 0;
  const folders: string[] = [];
  return {
    folders,
    factory: (folder, l) => {
      folders.push(folder);
      listener = l;
      return {
        close: () => {
          closed++;
        },
        on: (_event: 'error', fn: (err: Error) => void) => {
          onError = fn;
        },
      };
    },
    emit: (name) => listener?.('change', name),
    fail: (err) => onError?.(err),
    closed: () => closed,
  };
}

const PAGE = '<!DOCTYPE html><html><head><title>t</title></head><body>hello</body></html>';
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

let dir: string;
const stops: (() => void)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flipdesk-import-'));
});

afterEach(async () => {
  for (const s of stops.splice(0)) s();
  await rm(dir, { recursive: true, force: true });
});

function start(opts: Partial<Parameters<typeof createFolderWatcher>[0]> & { factory?: WatchFactory } = {}) {
  const delivered: Delivered[] = [];
  const log = makeLog();
  const { factory, ...rest } = opts;
  const w = createFolderWatcher({
    folder: dir,
    log,
    onFile: (path, html, mtimeMs) => {
      delivered.push({ path, html, mtimeMs });
    },
    debounceMs: 30,
    ...rest,
    ...(factory ? { watchFactory: factory } : {}),
  });
  stops.push(() => w.stop());
  return { w, delivered, log };
}

describe('isImportCandidate', () => {
  it.each([
    ['hats.html', true],
    ['Hats.HTM', true],
    ['scrap.tf hats (2).html', true],
    ['hats.html.crdownload', false],
    ['hats.html.tmp', false],
    ['hats.html.part', false],
    ['hats.html~', false],
    ['~$hats.html', false],
    ['.hats.html', false],
    // F18: "Webpage, Single File" saves, under the same temp-file and _files rules.
    ['hats.mhtml', true],
    ['Hats.MHT', true],
    ['hats.mhtml.crdownload', false],
    ['hats.mht.tmp', false],
    ['~hats.mhtml', false],
    ['hats_files/inner.mhtml', false],
    ['hats.mhtmlx', false],
    ['hats.txt', false],
    ['hats_files', false],
    ['hats_files/inner.html', false],
    ['hats_files\\inner.html', false],
    ['', false],
  ])('%s -> %s', (name, ok) => {
    expect(isImportCandidate(name)).toBe(ok);
  });
});

describe('decodeHtmlBuffer', () => {
  it('strips a UTF-8 BOM', () => {
    expect(decodeHtmlBuffer(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('<p>é</p>')]))).toBe('<p>é</p>');
  });
  it('decodes UTF-16 with a BOM', () => {
    expect(decodeHtmlBuffer(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<p>é</p>', 'utf16le')]))).toBe('<p>é</p>');
    const be = Buffer.from('<p>é</p>', 'utf16le').swap16();
    expect(decodeHtmlBuffer(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe('<p>é</p>');
  });
  it('reads plain UTF-8', () => {
    expect(decodeHtmlBuffer(Buffer.from('Bill’s Hat'))).toBe('Bill’s Hat');
  });
});

describe('createFolderWatcher', () => {
  it('initial scan delivers pages modified since the given time and skips temp files', async () => {
    await writeFile(join(dir, 'hats.html'), `﻿${PAGE}`);
    await writeFile(join(dir, 'old.html'), PAGE);
    await writeFile(join(dir, 'partial.html.crdownload'), PAGE);
    await writeFile(join(dir, 'notes.txt'), PAGE);
    await mkdir(join(dir, 'hats_files'));
    await writeFile(join(dir, 'hats_files', 'inner.html'), PAGE);
    const past = new Date(Date.now() - 3_600_000);
    await utimes(join(dir, 'old.html'), past, past);

    const fw = fakeWatch();
    const { delivered } = start({ factory: fw.factory, since: Date.now() - 60_000 });
    await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 3000, interval: 20 });
    await settle();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.path).toBe(join(dir, 'hats.html'));
    expect(delivered[0]!.html).toBe(PAGE); // BOM stripped
    expect(delivered[0]!.mtimeMs).toBe((await stat(join(dir, 'hats.html'))).mtimeMs);
    expect(fw.folders).toEqual([dir]);
  });

  it('initial scan delivers pages oldest first, one at a time, whatever their names', async () => {
    // Name order is the reverse of save order, and the oldest page is the largest (slowest to read).
    const files = [
      { name: 'Buy Hats - Scrap.TF (2).html', age: 30_000, body: PAGE },
      { name: 'Buy Hats - Scrap.TF (1).html', age: 60_000, body: PAGE.repeat(50) },
      { name: 'Buy Hats - Scrap.TF.html', age: 120_000, body: PAGE.repeat(2000) },
    ];
    for (const f of files) {
      await writeFile(join(dir, f.name), f.body);
      const t = new Date(Date.now() - f.age);
      await utimes(join(dir, f.name), t, t);
    }
    const fw = fakeWatch();
    const { delivered } = start({ factory: fw.factory, debounceMs: 10, since: Date.now() - 600_000 });
    await vi.waitFor(() => expect(delivered).toHaveLength(3), { timeout: 3000, interval: 20 });
    expect(delivered.map((d) => d.path)).toEqual([...files].reverse().map((f) => join(dir, f.name)));
  });

  it('delivers pages saved in one burst in the order their events arrived, even when the first is slower to read', async () => {
    const fw = fakeWatch();
    const { delivered } = start({ factory: fw.factory, debounceMs: 10 });
    await writeFile(join(dir, 'b-older.html'), PAGE.repeat(2000));
    await writeFile(join(dir, 'a-newer.html'), PAGE);
    fw.emit('b-older.html');
    fw.emit('a-newer.html');
    await vi.waitFor(() => expect(delivered).toHaveLength(2), { timeout: 3000, interval: 20 });
    expect(delivered.map((d) => d.path)).toEqual([join(dir, 'b-older.html'), join(dir, 'a-newer.html')]);
  });

  it('a scan (event without a file name) keeps debouncing a page that is still being written', async () => {
    const fw = fakeWatch();
    const { delivered } = start({ factory: fw.factory, debounceMs: 400, since: Date.now() - 600_000 });
    const file = join(dir, 'hats.html');
    for (let i = 1; i <= 6; i++) {
      await writeFile(file, `${PAGE}<!-- part ${i} -->`);
      fw.emit(null); // some platforms omit the name; every such event rescans the folder
      await settle(100);
    }
    await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 3000, interval: 20 });
    await settle(600);
    expect(delivered.map((d) => d.html)).toEqual([`${PAGE}<!-- part 6 -->`]);
  });

  it('by default ignores files that existed before it started', async () => {
    await writeFile(join(dir, 'hats.html'), PAGE);
    const past = new Date(Date.now() - 10_000);
    await utimes(join(dir, 'hats.html'), past, past);
    const fw = fakeWatch();
    const { delivered } = start({ factory: fw.factory });
    await settle(200);
    expect(delivered).toHaveLength(0);
  });

  it('uses the injected clock for the start time', async () => {
    await writeFile(join(dir, 'hats.html'), PAGE);
    const fw = fakeWatch();
    // A minute behind the real clock: the start time (since) is then before the file's mtime. 0.7.4 (F82): not
    // the epoch, as a file modified after the injected clock's now (by more than the slack) is in the future.
    const { delivered } = start({ factory: fw.factory, now: () => Date.now() - 60_000 });
    await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 3000, interval: 20 });
  });

  it('debounces bursts of events for the same file into one delivery', async () => {
    const fw = fakeWatch();
    const { delivered } = start({ factory: fw.factory, debounceMs: 80 });
    await writeFile(join(dir, 'hats.html'), PAGE);
    for (let i = 0; i < 5; i++) {
      fw.emit('hats.html');
      await settle(20);
    }
    await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 3000, interval: 20 });
    await settle(200);
    expect(delivered).toHaveLength(1);
  });

  it('dedupes by path and mtime, and re-imports when the file changes', async () => {
    const fw = fakeWatch();
    const { delivered } = start({ factory: fw.factory });
    const file = join(dir, 'hats.html');
    await writeFile(file, PAGE);
    fw.emit('hats.html');
    await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 3000, interval: 20 });
    fw.emit('hats.html');
    await settle(200);
    expect(delivered).toHaveLength(1);

    await writeFile(file, `${PAGE}<!-- v2 -->`);
    const later = new Date(Date.now() + 5000);
    await utimes(file, later, later);
    fw.emit('hats.html');
    await vi.waitFor(() => expect(delivered).toHaveLength(2), { timeout: 3000, interval: 20 });
    expect(delivered[1]!.html).toContain('v2');
    expect(delivered[1]!.mtimeMs).toBe(later.getTime());
  });

  it('ignores non-page names from events', async () => {
    const fw = fakeWatch();
    const { delivered } = start({ factory: fw.factory });
    await writeFile(join(dir, 'hats.html.crdownload'), PAGE);
    await writeFile(join(dir, 'a.txt'), PAGE);
    fw.emit('hats.html.crdownload');
    fw.emit('a.txt');
    fw.emit('hats_files');
    await settle(200);
    expect(delivered).toHaveLength(0);
  });

  it('skips files over the size limit with a warning', async () => {
    const fw = fakeWatch();
    const { delivered, log } = start({ factory: fw.factory, maxBytes: 50 });
    await writeFile(join(dir, 'big.html'), 'x'.repeat(51));
    fw.emit('big.html');
    await vi.waitFor(() => expect(log.lines.some((l) => l.level === 'warn' && l.msg.includes('big.html'))).toBe(true), { timeout: 3000, interval: 20 });
    expect(delivered).toHaveLength(0);
  });

  it('reports a file over the size limit to onSkip, once per version and unread, so the import can say why (F18)', async () => {
    const fw = fakeWatch();
    const skipped: { path: string; reason: string; detail: string; mtimeMs: number }[] = [];
    const { delivered } = start({ factory: fw.factory, maxBytes: 3 * 1024 * 1024, onSkip: (path, reason, detail, mtimeMs) => skipped.push({ path, reason, detail, mtimeMs }) });
    const file = join(dir, 'Item Trading - TF2 - Scrap.TF.mhtml');
    await writeFile(file, 'x'.repeat(5 * 1024 * 1024));
    fw.emit('Item Trading - TF2 - Scrap.TF.mhtml');
    await vi.waitFor(() => expect(skipped).toHaveLength(1), { timeout: 3000, interval: 20 });
    expect(skipped[0]).toEqual({ path: file, reason: 'too-large', detail: '5 MB is over the 3 MB import limit', mtimeMs: (await stat(file)).mtimeMs });
    expect(delivered).toHaveLength(0);
    // The same version again: already reported.
    fw.emit('Item Trading - TF2 - Scrap.TF.mhtml');
    await settle(200);
    expect(skipped).toHaveLength(1);
    // A page that fits is delivered as before, not skipped.
    await writeFile(join(dir, 'hats.html'), PAGE);
    fw.emit('hats.html');
    await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 3000, interval: 20 });
    expect(skipped).toHaveLength(1);
  });

  it('logs and continues when onSkip throws', async () => {
    const fw = fakeWatch();
    const { delivered, log } = start({
      factory: fw.factory,
      maxBytes: 100,
      onSkip: () => {
        throw new Error('boom');
      },
    });
    expect(PAGE.length).toBeLessThan(100);
    await writeFile(join(dir, 'big.html'), 'x'.repeat(101));
    fw.emit('big.html');
    await vi.waitFor(() => expect(log.lines.some((l) => l.level === 'error' && l.msg.includes('boom'))).toBe(true), { timeout: 3000, interval: 20 });
    await writeFile(join(dir, 'hats.html'), PAGE);
    fw.emit('hats.html');
    await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 3000, interval: 20 });
  });

  it('skips empty files until they are written', async () => {
    const fw = fakeWatch();
    const { delivered } = start({ factory: fw.factory });
    await writeFile(join(dir, 'hats.html'), '');
    fw.emit('hats.html');
    await settle(200);
    expect(delivered).toHaveLength(0);
    await writeFile(join(dir, 'hats.html'), PAGE);
    fw.emit('hats.html');
    await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 3000, interval: 20 });
  });

  it('logs and continues when onFile throws or rejects', async () => {
    const fw = fakeWatch();
    const log = makeLog();
    let n = 0;
    const w = createFolderWatcher({
      folder: dir,
      log,
      debounceMs: 20,
      watchFactory: fw.factory,
      onFile: (path) => {
        n++;
        if (path.endsWith('a.html')) throw new Error('boom');
        return Promise.reject(new Error('async boom')) as unknown as void;
      },
    });
    stops.push(() => w.stop());
    await writeFile(join(dir, 'a.html'), PAGE);
    await writeFile(join(dir, 'b.html'), PAGE);
    fw.emit('a.html');
    fw.emit('b.html');
    await vi.waitFor(() => expect(log.lines.filter((l) => l.level === 'error')).toHaveLength(2), { timeout: 3000, interval: 20 });
    expect(n).toBe(2);
    expect(log.lines.filter((l) => l.level === 'error').map((l) => l.msg).join('\n')).toMatch(/boom[\s\S]*async boom|async boom[\s\S]*boom/);
  });

  it('ignores files that vanish before they are read', async () => {
    const fw = fakeWatch();
    const { delivered, log } = start({ factory: fw.factory });
    fw.emit('gone.html');
    await settle(200);
    expect(delivered).toHaveLength(0);
    expect(log.lines.some((l) => l.level === 'debug' && l.msg.includes('gone.html'))).toBe(true);
    expect(log.lines.some((l) => l.level === 'error')).toBe(false);
  });

  it('rescans when the platform gives no file name', async () => {
    const fw = fakeWatch();
    const { delivered } = start({ factory: fw.factory, since: Date.now() - 60_000 });
    await settle(100);
    await writeFile(join(dir, 'late.html'), PAGE);
    fw.emit(null);
    await vi.waitFor(() => expect(delivered.map((d) => d.path)).toEqual([join(dir, 'late.html')]), { timeout: 3000, interval: 20 });
  });

  it('stop() closes the watcher and cancels pending deliveries', async () => {
    const fw = fakeWatch();
    const { w, delivered } = start({ factory: fw.factory, debounceMs: 100 });
    await writeFile(join(dir, 'hats.html'), PAGE);
    fw.emit('hats.html');
    w.stop();
    w.stop();
    expect(fw.closed()).toBe(1);
    fw.emit('hats.html');
    await settle(300);
    expect(delivered).toHaveLength(0);
  });

  it('logs watcher errors and closes the watcher', async () => {
    const fw = fakeWatch();
    const { w, log } = start({ factory: fw.factory });
    expect(w.alive()).toBe(true);
    expect(w.lastError()).toBeNull();
    fw.fail(new Error('EPERM: folder removed'));
    expect(log.lines.some((l) => l.level === 'error' && l.msg.includes('EPERM'))).toBe(true);
    expect(fw.closed()).toBe(1);
    // The owner can see the watch died (core reports it and starts a new one).
    expect(w.alive()).toBe(false);
    expect(w.lastError()).toMatch(/EPERM/);
  });

  it('logs instead of throwing when the folder cannot be watched', async () => {
    const log = makeLog();
    const w = createFolderWatcher({ folder: join(dir, 'missing'), log, onFile: () => undefined });
    expect(log.lines.some((l) => l.level === 'error' && l.msg.includes('missing'))).toBe(true);
    expect(w.alive()).toBe(false);
    expect(w.lastError()).not.toBeNull();
    expect(() => w.stop()).not.toThrow();
  });

  it('is not alive after stop()', () => {
    const fw = fakeWatch();
    const { w } = start({ factory: fw.factory });
    w.stop();
    expect(w.alive()).toBe(false);
    expect(w.lastError()).toBeNull();
  });

  it('works with the real fs.watch', async () => {
    const { delivered } = start({ debounceMs: 100 });
    await settle(100);
    await writeFile(join(dir, 'scrap.tf hats.html'), PAGE);
    await vi.waitFor(() => expect(delivered.map((d) => d.path)).toContain(join(dir, 'scrap.tf hats.html')), { timeout: 5000, interval: 25 });
    expect(delivered.filter((d) => d.path.endsWith('scrap.tf hats.html'))).toHaveLength(1);
  });
});
