import { createClient } from '@libsql/client';

export class DatabaseConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DatabaseConfigurationError';
  }
}

function requiresAuthToken(url) {
  return url.startsWith('libsql://') || url.startsWith('https://');
}

/** Create a server-only libSQL client from environment config. No client is created at import time. */
export function createDatabaseClient({
  url = process.env.TURSO_DATABASE_URL,
  authToken = process.env.TURSO_AUTH_TOKEN,
  clientFactory = createClient,
} = {}) {
  const normalizedUrl = String(url || '').trim();
  const normalizedToken = String(authToken || '').trim();
  if (!normalizedUrl) {
    throw new DatabaseConfigurationError('TURSO_DATABASE_URL is required to create a database client');
  }
  if (requiresAuthToken(normalizedUrl) && !normalizedToken) {
    throw new DatabaseConfigurationError('TURSO_AUTH_TOKEN is required for remote libSQL/Turso databases');
  }
  // Local file/localhost clients do not need a secret; irrelevant tokens are not forwarded.

  return clientFactory({
    url: normalizedUrl,
    ...(requiresAuthToken(normalizedUrl) ? { authToken: normalizedToken } : {}),
  });
}
