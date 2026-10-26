const writeQueues = new WeakMap();

function isTransientWriteConflict(error) {
  const detail = `${error?.code || ''} ${error?.message || error || ''}`;
  return /SQLITE_BUSY|SQLITE_LOCKED|TRANSACTION_BUSY|database is locked/i.test(detail);
}

/** Serialize writes per client and retry bounded transient SQLite/libSQL write conflicts. */
export async function withWriteTransaction(db, callback, { maxRetries = 5 } = {}) {
  const previous = writeQueues.get(db) || Promise.resolve();
  let unlock;
  const gate = new Promise((resolve) => { unlock = resolve; });
  writeQueues.set(db, previous.then(() => gate));
  await previous;

  try {
    for (let attempt = 0; ; attempt += 1) {
      let tx;
      try {
        tx = await db.transaction('write');
        const result = await callback(tx);
        await tx.commit();
        return result;
      } catch (error) {
        if (tx) {
          try { await tx.rollback(); } catch {}
        }
        if (!isTransientWriteConflict(error) || attempt >= maxRetries) throw error;
        const delayMs = Math.min(80, 8 * (2 ** attempt)) + Math.floor(Math.random() * 8);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  } finally {
    unlock();
  }
}
