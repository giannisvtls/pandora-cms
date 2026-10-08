// Names of a test run's throwaway database and bucket, and the guard that keeps every test off the
// dev database (pandora_cms) and bucket (pandora-cms-media).
import type { ServerEnv } from '../../src/env'

const TEST_DATABASE = /^pandora_cms_test_[0-9a-f]{12}$/
const TEST_BUCKET = /^pandora-cms-test-[0-9a-f]{12}$/

declare module 'vitest' {
  export interface ProvidedContext {
    /** The run's full server environment, created by tests/int/setup.ts. */
    testEnv: ServerEnv
  }
}

export const testDatabaseName = (suffix: string): string => `pandora_cms_test_${suffix}`
export const testBucketName = (suffix: string): string => `pandora-cms-test-${suffix}`

/**
 * Parses a Postgres connection string. On a malformed one, `new URL()` throws ERR_INVALID_URL with
 * the whole string (password included) in its `input` property, which Vitest prints; the error
 * thrown here carries neither the string nor that error.
 */
export function parseDatabaseUrl(connectionString: string): URL {
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error('DATABASE_URL is not a valid postgres URL')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL is not a valid postgres URL')
  }
  return url
}

/** The database name in a Postgres connection string (never logs the string itself). */
export const databaseNameOf = (connectionString: string): string =>
  decodeURIComponent(parseDatabaseUrl(connectionString).pathname.replace(/^\//, ''))

/** Throws unless the env points at a throwaway database and bucket. */
export function assertThrowawayTarget(env: Pick<ServerEnv, 'DATABASE_URL' | 'S3_BUCKET'>): void {
  const database = databaseNameOf(env.DATABASE_URL)
  if (!TEST_DATABASE.test(database) || !TEST_BUCKET.test(env.S3_BUCKET)) {
    throw new Error(
      `Refusing to run integration tests against database "${database}" and bucket ` +
        `"${env.S3_BUCKET}": both must be a run's throwaway ones (created by tests/int/setup.ts).`,
    )
  }
}
