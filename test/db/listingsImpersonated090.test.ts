// 0.9 (exits, #11, schema V16): backpack.tf's impersonation flag on a listing (listings.user_impersonated). Only a
// flagged listing stores 1 and reads back with userImpersonated: true; every other listing stores NULL ("not flagged
// or not known") and reads back without the key, so every round trip of 0.8 still compares equal.

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openRepo } from '../../src/service/db';
import type { Repo } from '../../src/service/contracts';
import { makeListing, tempDir } from './helpers';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** A repo on a file, so the stored column can be read raw once it is closed. */
function fileRepo(): { repo: Repo; file: string } {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const file = t.file();
  const repo = openRepo(file);
  // Closing is idempotent, so a test may close it first to read the file raw.
  cleanups.push(() => repo.close());
  return { repo, file };
}

function storedFlags(file: string): Record<string, unknown> {
  const db = new DatabaseSync(file);
  try {
    return Object.fromEntries(db.prepare('SELECT id, user_impersonated FROM listings ORDER BY id').all().map((r) => [String(r['id']), r['user_impersonated']]));
  } finally {
    db.close();
  }
}

describe('listings.user_impersonated (0.9, V16)', () => {
  it('round-trips a flagged listing, and stores NULL for one without the key or with false', () => {
    const { repo, file } = fileRepo();
    const flagged = makeListing({ id: 'imp', userImpersonated: true });
    const plain = makeListing({ id: 'plain' });
    const cleared = makeListing({ id: 'cleared', userImpersonated: false });
    repo.upsertListings([flagged, plain, cleared]);
    expect(repo.getListing('imp')).toEqual(flagged);
    expect(repo.getListing('imp')!.userImpersonated).toBe(true);
    expect(repo.getListing('plain')).toEqual(plain);
    expect(repo.getListing('plain')).not.toHaveProperty('userImpersonated');
    // false is "not flagged": stored NULL, read back without the key.
    expect(repo.getListing('cleared')).not.toHaveProperty('userImpersonated');
    repo.close();
    expect(storedFlags(file)).toEqual({ cleared: null, imp: 1, plain: null });
  });

  it('an update that drops the flag clears it (the feed sent the user again, not flagged)', () => {
    const { repo, file } = fileRepo();
    repo.upsertListings([makeListing({ id: 'x', userImpersonated: true })]);
    repo.upsertListings([makeListing({ id: 'x', metalScrap: 30 })]);
    expect(repo.getListing('x')).toEqual(makeListing({ id: 'x', metalScrap: 30 }));
    repo.close();
    expect(storedFlags(file)).toEqual({ x: null });
  });

  it('reads the flag back on every listing read (the base book included)', () => {
    const r = openRepo(':memory:');
    cleanups.push(() => r.close());
    r.upsertListings([makeListing({ id: 'a', userImpersonated: true }), makeListing({ id: 'b', metalScrap: 30 })]);
    const book = r.buyListingsByBaseSkus(['378;6']).get('378;6')!;
    expect(book.map((l) => [l.id, l.userImpersonated ?? null])).toEqual([
      ['b', null],
      ['a', true],
    ]);
  });
});
