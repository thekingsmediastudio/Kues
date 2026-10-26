import { createDatabaseClient } from '../apps/web/lib/db/client.mjs';
import { applyMigrations } from '../apps/web/lib/db/migrate.mjs';

const db = createDatabaseClient();
try {
  const result = await applyMigrations(db);
  if (result.applied.length) {
    console.log(`Applied migrations: ${result.applied.join(', ')}`);
  } else {
    console.log(`Database is up to date (${result.checked.length} migration(s) checked).`);
  }
} finally {
  await db.close();
}
