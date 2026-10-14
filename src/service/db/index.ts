import type { Repo } from '../contracts';
import { openDatabase } from './db';
import { migrate } from './migrations';
import { createRepo } from './repo';

/**
 * Opens (creating if needed) the SQLite database at `path`, applies pending
 * migrations and returns the Repo. ':memory:' gives a private in-memory database.
 * Throws SchemaVersionError when the file was written by a newer app version.
 */
export function openRepo(path: string): Repo {
  const db = openDatabase(path);
  try {
    migrate(db.raw);
  } catch (err) {
    db.close();
    throw err;
  }
  return createRepo(db);
}

export { createRepo } from './repo';
export { openDatabase, isMemoryPath } from './db';
export type { SqliteDb } from './db';
export { migrate, MIGRATIONS, SCHEMA_VERSION, SchemaVersionError } from './migrations';
