// F21: schema V9 adds import_batches.origin ('file' | 'window' | NULL before 0.7), written by
// createImportBatch and read into ImportBatch.origin. Local database only; nothing touches the network.

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, openRepo } from '../../src/service/db';
import { MIGRATIONS, migrate } from '../../src/service/db/migrations';
import { IMPORT_ORIGINS, type ImportOrigin } from '../../src/shared/types';
import { tempDir } from './helpers';

const T0 = 1_791_958_000_000;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function repoAt(path: string) {
  const repo = openRepo(path);
  cleanups.push(() => repo.close());
  return repo;
}

describe('migration V9', () => {
  it('is the newest migration and adds a NULL origin to every earlier batch', () => {
    expect(SCHEMA_VERSION).toBe(9);
    expect(MIGRATIONS[8]).toMatchObject({ version: 9, name: 'saved-page batch origin' });
    const t = tempDir();
    cleanups.push(t.cleanup);
    const path = t.file();
    const raw = new DatabaseSync(path);
    migrate(raw, MIGRATIONS.slice(0, 8));
    raw
      .prepare('INSERT INTO import_batches (id, file_name, page_kind, file_mtime, imported_at, item_count, categories, bank) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(3, 'scrap.tf - Buy Hats.html', 'buy', T0 - 60_000, T0, 2, '{"hats":2}', 'hats');
    raw.close();
    const repo = repoAt(path);
    expect(repo.listImportBatches(5)).toEqual([
      { id: 3, fileName: 'scrap.tf - Buy Hats.html', pageKind: 'buy', fileMtime: T0 - 60_000, importedAt: T0, itemCount: 2, categories: { hats: 2 }, bank: 'hats', origin: null },
    ]);
  });
});

describe('createImportBatch origin', () => {
  it('stores each origin, null when absent, and reads an unknown stored value as null', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const path = t.file();
    const repo = repoAt(path);
    const ids = new Map<ImportOrigin | 'none', number>();
    for (const origin of IMPORT_ORIGINS) {
      ids.set(origin, repo.createImportBatch({ fileName: `${origin}.html`, pageKind: 'buy', fileMtime: T0, importedAt: T0, itemCount: 0, bank: 'hats', origin }));
    }
    ids.set('none', repo.createImportBatch({ fileName: 'none.html', pageKind: 'buy', fileMtime: T0, importedAt: T0, itemCount: 0 }));
    const bogus = repo.createImportBatch({ fileName: 'bogus.html', pageKind: 'buy', fileMtime: T0, importedAt: T0, itemCount: 0, origin: 'browser' as unknown as ImportOrigin });
    const byId = new Map(repo.listImportBatches(10).map((b) => [b.id, b.origin]));
    expect(byId.get(ids.get('file')!)).toBe('file');
    expect(byId.get(ids.get('window')!)).toBe('window');
    expect(byId.get(ids.get('none')!)).toBeNull();
    expect(byId.get(bogus)).toBeNull();

    const raw = new DatabaseSync(path);
    cleanups.push(() => raw.close());
    raw.prepare("UPDATE import_batches SET origin = 'scrap.tf' WHERE id = ?").run(ids.get('file')!);
    expect(repo.listImportBatches(10).find((b) => b.id === ids.get('file'))!.origin).toBeNull();
  });
});
