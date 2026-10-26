import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultMigrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations'
);

export class MigrationDriftError extends Error {
  constructor(name) {
    super(`Applied migration changed on disk: ${name}`);
    this.name = 'MigrationDriftError';
    this.migrationName = name;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function withWriteTransaction(db, callback) {
  const tx = await db.transaction('write');
  try {
    const result = await callback(tx);
    await tx.commit();
    return result;
  } catch (error) {
    try { await tx.rollback(); } catch {}
    throw error;
  }
}

/** Apply ordered SQL migrations once and fail closed if an applied file is later edited. */
export async function applyMigrations(db, { migrationsDir = defaultMigrationsDir } = {}) {
  await db.execute('PRAGMA foreign_keys = ON');
  await db.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  const names = (await fs.readdir(migrationsDir))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort();
  const applied = [];

  for (const name of names) {
    const sql = await fs.readFile(path.join(migrationsDir, name), 'utf8');
    const checksum = sha256(sql);
    const result = await withWriteTransaction(db, async (tx) => {
      const previous = await tx.execute({
        sql: 'SELECT checksum FROM schema_migrations WHERE name = ?',
        args: [name],
      });
      if (previous.rows.length) {
        if (previous.rows[0].checksum !== checksum) throw new MigrationDriftError(name);
        return false;
      }

      await tx.executeMultiple(sql);
      await tx.execute({
        sql: 'INSERT INTO schema_migrations(name, checksum) VALUES (?, ?)',
        args: [name, checksum],
      });
      return true;
    });
    if (result) applied.push(name);
  }

  return { applied, checked: names };
}
