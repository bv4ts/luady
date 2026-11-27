import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from '../core/contracts.js';
import { ValidationError } from '../core/errors.js';
import { migrate } from './migrate.js';

const BUSY_TIMEOUT_MS = 5000;
const MEMORY = ':memory:';

/** Opens (creating parent directories) a WAL-mode database file and migrates it to the latest schema. */
export function openDb(file: string): Db {
  if (file.trim() === '' || file === MEMORY) {
    throw new ValidationError('openDb needs a database file path; use openMemoryDb() for an in-memory database');
  }
  mkdirSync(dirname(file), { recursive: true });
  return initialise(new Database(file), true);
}

/** In-memory database with the same pragmas (minus WAL) and schema; for tests. */
export function openMemoryDb(): Db {
  return initialise(new Database(MEMORY), false);
}

function initialise(db: Db, wal: boolean): Db {
  try {
    if (wal) {
      enableWal(db);
    }
    db.pragma('foreign_keys = ON');
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // Deleted content is overwritten, so a dropped permission preview cannot be read back from the file.
    db.pragma('secure_delete = ON');
    migrate(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

function enableWal(db: Db): void {
  const mode = db.pragma('journal_mode = WAL', { simple: true });
  if (mode !== 'wal') {
    throw new Error(`Could not enable WAL journal mode (SQLite kept "${String(mode)}")`);
  }
}
