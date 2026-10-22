// 0.7.4 (audit F82): a saved page's time. A copy, sync or editor resets a file's modified time, so an old page
// with a fresh mtime became the bank's newest whole save: on-sale cards read as gone (and lost their prices),
// sold ones as restocked. Now a file dated ahead of the clock stores its prices at now but no bank stock save
// (FUTURE_MTIME), and the folder watch's catch-up scan leaves it to a watch event (else it came back at every
// start); an .mhtml file is dated by its own Date header (Chromium's save time) when that is clearly older than
// its mtime (PAGE_DATE_SLACK_MS). Real repo, parser and scrap.tf history over the real saved-page fixture with
// the real item schema (schema-subset.json); offline.

import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Engine, Logger, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { createFolderWatcher, type WatchFactory } from '../../src/service/import';
import { MHTML_DATE_MIN, readMhtml } from '../../src/service/import/mhtml';
import { PAGE_DATE_SLACK_MS, importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { FUTURE_MTIME, FUTURE_MTIME_SLACK_MS, SKIP_NOT_ON_SALE_NEWER, importWarningCode } from '../../src/shared/importCodes';
import type { ImportResult, KeyPriceState, ScrapPrice } from '../../src/shared/types';
import { makeDeps, schemaRoute } from '../pricedb/helpers';
import { mhtmlOf } from './mhtmlFixture';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
const HATS = readFileSync(path.join(fileURLToPath(new URL('../fixtures/', import.meta.url)), 'import/buy_hats.html'), 'utf8');
const BASE_JUMPER = '1101;6;uncraftable';
const CAPTAIN = '378;6';
const dateOf = (ms: number) => new Date(ms).toUTCString();

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(makeDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (repos.length) repos.pop()!.close();
  for (const c of cleanups.splice(0)) await c();
});

/** The fixture without card C13 (the B.A.S.E. Jumper): the bank after it sold. */
function withoutC13(): string {
  const start = HATS.indexOf('<!-- C13');
  const end = HATS.indexOf('<!-- C14');
  expect(start).toBeGreaterThan(0);
  return HATS.slice(0, start) + HATS.slice(end);
}

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, { import: { enabled: true, acknowledgedAt: NOW - 48 * HOUR } });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const history = createScraptfHistory({ clock: { now: () => NOW }, log, repo, market: { entryFor: () => null }, keyPrice: () => KEY });
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema,
    engine: { keyPrice: () => KEY, markDirty: quiet } as unknown as Engine,
    settings: () => settings,
    push: quiet,
    pricesChanged: quiet,
    scraptfListChanged: quiet,
    scraptfHistory: history,
    bankStockChanged: () => history.refresh(),
  } as unknown as HandlerContext;
  const file = (html: string, mtimeMs: number, fileName = 'Hat Trading - TF2 - Scrap.TF.html'): ImportResult => importSavedPage(ctx, { html, fileName, mtimeMs });
  const imported = (sku: string): ScrapPrice[] => repo.scrapPricesForSku(sku).filter((p) => p.source === 'import');
  const events = () => repo.scraptfEvents({ kinds: ['gone', 'restocked', 'new'], limit: 5000 });
  return { repo, file, imported, events };
}

describe('a file dated ahead of the clock (F82)', () => {
  it('stores its prices at now but no bank stock save, with a fixed warning, again and again', () => {
    const h = setup();
    expect(h.file(withoutC13(), NOW - HOUR).stockSave).toBe('written');
    const ahead = h.file(HATS, NOW + 24 * HOUR, 'copied.html');
    expect(ahead.stockSave).toBe('partial');
    expect(ahead.warnings.map(importWarningCode)[0]).toBe(FUTURE_MTIME);
    expect(ahead.warnings[0]).toBe(`${FUTURE_MTIME}: the file's modified time is ahead of this computer's clock, so this look stores no bank stock save`);
    expect(h.imported(BASE_JUMPER).map((p) => p.observedAt)).toEqual([NOW]);
    expect(h.repo.listImportBatches(1)[0]).toMatchObject({ id: ahead.batchId, fileMtime: NOW });
    expect(h.repo.bankStockSaves('hats').map((s) => s.savedAt)).toEqual([NOW - HOUR]);
    expect(h.events()).toEqual([]);
    // The same file again (a catch-up at the next start, by hand): still no save, no change events.
    expect(h.file(HATS, NOW + 24 * HOUR, 'copied.html').stockSave).toBe('partial');
    expect(h.repo.bankStockSaves('hats')).toHaveLength(1);
    expect(h.events()).toEqual([]);
  });

  it('within the slack it is an ordinary save, dated now', () => {
    const h = setup();
    const r = h.file(HATS, NOW + FUTURE_MTIME_SLACK_MS - 1_000);
    expect(r.stockSave).toBe('written');
    expect(r.warnings.map(importWarningCode)).not.toContain(FUTURE_MTIME);
    expect(h.repo.bankStockSaves('hats').map((s) => s.savedAt)).toEqual([NOW]);
  });
});

describe("an .mhtml file's own save time (F82)", () => {
  it('dates the page by its Date header when that is clearly older than the mtime: a newer save wins', () => {
    const h = setup();
    expect(h.file(withoutC13(), NOW - 2 * HOUR).stockSave).toBe('written');
    // Saved 14 h ago (the card was on sale then), its mtime reset a minute ago by a copy.
    const old = h.file(mhtmlOf(HATS, { date: dateOf(NOW - 14 * HOUR) }), NOW - MIN, 'Hat Trading - TF2 - Scrap.TF.mhtml');
    expect(h.repo.listImportBatches(1)[0]).toMatchObject({ id: old.batchId, fileMtime: NOW - 14 * HOUR });
    expect(old.stored).toBe(0);
    expect(old.skipped).toContainEqual({ reason: SKIP_NOT_ON_SALE_NEWER, title: expect.stringContaining('B.A.S.E. Jumper') });
    expect(h.imported(BASE_JUMPER)).toEqual([]);
    expect(h.imported(CAPTAIN).map((p) => p.observedAt)).toEqual([NOW - 2 * HOUR]);
    // The newer save is still the bank's newest, and nothing read as gone or restocked.
    expect(h.repo.bankStockSaves('hats', 1)[0]!.savedAt).toBe(NOW - 2 * HOUR);
    expect(h.events()).toEqual([]);
  });

  it("keeps the file's mtime when the Date is within the slack, or missing", () => {
    for (const date of [dateOf(NOW - MIN - PAGE_DATE_SLACK_MS + 30_000), null]) {
      const h = setup();
      const r = h.file(mhtmlOf(HATS, { date }), NOW - MIN, 'hats.mhtml');
      expect(h.repo.listImportBatches(1)[0]).toMatchObject({ id: r.batchId, fileMtime: NOW - MIN });
      expect(h.imported(CAPTAIN).map((p) => p.observedAt)).toEqual([NOW - MIN]);
    }
  });

  it('a Date header ahead of the file is not used either (only an older one dates a page)', () => {
    const h = setup();
    const r = h.file(mhtmlOf(HATS, { date: dateOf(NOW + HOUR) }), NOW - HOUR, 'hats.mhtml');
    expect(h.repo.listImportBatches(1)[0]).toMatchObject({ id: r.batchId, fileMtime: NOW - HOUR });
  });

  it('readMhtml reads the Date header, and nothing that is not one', () => {
    const at = Date.UTC(2026, 9, 16, 12, 0, 0);
    expect(readMhtml(mhtmlOf('<p/>'))).toMatchObject({ ok: true, date: at });
    expect(readMhtml(mhtmlOf('<p/>', { date: 'Fri, 16 Oct 2026 14:00:00 +0200' }))).toMatchObject({ ok: true, date: at });
    expect(readMhtml(mhtmlOf('<p/>', { date: null }))).toMatchObject({ ok: true, date: null });
    expect(readMhtml(mhtmlOf('<p/>', { date: 'yesterday, probably' }))).toMatchObject({ ok: true, date: null });
    expect(readMhtml(mhtmlOf('<p/>', { date: dateOf(MHTML_DATE_MIN - 1) }))).toMatchObject({ ok: true, date: null });
  });
});

describe('the folder watch and a file dated ahead of the clock (F82)', () => {
  it('leaves it out of the catch-up scan, so a start does not import it again; a watch event still delivers it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flipdesk-future-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const now = Date.now();
    await writeFile(join(dir, 'ahead.html'), '<html><body>ahead</body></html>');
    await utimes(join(dir, 'ahead.html'), new Date(now + 24 * HOUR), new Date(now + 24 * HOUR));
    await writeFile(join(dir, 'today.html'), '<html><body>today</body></html>');
    let listener: ((event: string, name: string | null) => void) | null = null;
    const factory: WatchFactory = (_folder, l) => {
      listener = l;
      return { close: () => undefined, on: () => undefined };
    };
    const delivered: string[] = [];
    const warned: string[] = [];
    const quiet = () => undefined;
    const w = createFolderWatcher({
      folder: dir,
      log: { debug: quiet, info: quiet, warn: (m: string) => warned.push(m), error: quiet },
      onFile: (p) => delivered.push(path.basename(p)),
      since: now - HOUR,
      debounceMs: 5,
      watchFactory: factory,
    });
    cleanups.push(() => w.stop());
    await vi.waitFor(() => expect(delivered).toEqual(['today.html']), { timeout: 3000, interval: 20 });
    expect(warned.some((m) => m.includes('ahead.html') && m.includes('ahead of this computer'))).toBe(true);
    listener!('change', 'ahead.html');
    await vi.waitFor(() => expect(delivered).toEqual(['today.html', 'ahead.html']), { timeout: 3000, interval: 20 });
  });
});
