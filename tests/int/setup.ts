// Vitest globalSetup for the Local API tests. Runs once per `vitest run`, in the main process,
// before any worker starts.
//
// Each run gets its own Postgres database (pandora_cms_test_<hex>) and MinIO bucket
// (pandora-cms-test-<hex>) on the servers named by DATABASE_URL and S3_ENDPOINT (process env
// first, then .env). The dev database and bucket are never opened, so concurrent runs and a
// running `next dev` cannot collide.
//   1. create the database and the bucket;
//   2. put the run's env in process.env (inherited by the workers) and provide it to the workers
//      (applied by vitest.setup.ts before a test file imports the config);
//   3. apply the committed migrations to the new database, undo them and apply them again
//      (MIGRATION_STEPS), so every run also proves each migration's down(). Each step is a
//      `payload` CLI child process: the Postgres adapter keeps a pool client checked out until the
//      process exits (`payload.destroy()` does not end the pool), so an in-process Payload here
//      would hold a connection that the teardown's DROP DATABASE then kills, crashing the run.
// Teardown drops the database and empties and deletes the bucket.
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

import { loadDotEnvFile, requireEnv, s3ClientConfig, type ServerEnv } from '../../src/env';
import {
  assertThrowawayTarget,
  parseDatabaseUrl,
  testBucketName,
  testDatabaseName,
} from './throwaway';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const base: NodeJS.ProcessEnv = { ...process.env };
  loadDotEnvFile(path.join(project.config.root, '.env'), base);
  const server = requireEnv(
    ['DATABASE_URL', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'],
    base,
  );
  const migrateTimeoutMs = readMigrateTimeoutMs(base);

  const suffix = randomBytes(6).toString('hex');
  const database = testDatabaseName(suffix);
  const bucket = testBucketName(suffix);
  const adminUrl = withDatabase(server.DATABASE_URL, 'postgres');
  const testEnv: ServerEnv = {
    DATABASE_URL: withDatabase(server.DATABASE_URL, database),
    PAYLOAD_SECRET: randomBytes(32).toString('hex'),
    S3_ENDPOINT: server.S3_ENDPOINT,
    S3_BUCKET: bucket,
    S3_ACCESS_KEY_ID: server.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: server.S3_SECRET_ACCESS_KEY,
  };
  // The names are generated above, so this cannot fail; it also makes the identifiers safe to
  // interpolate into CREATE/DROP DATABASE below.
  assertThrowawayTarget(testEnv);
  const s3 = new S3Client(s3ClientConfig(testEnv));

  const teardown = async (): Promise<void> => {
    const errors: unknown[] = [];
    try {
      // The workers have exited; FORCE also ends any connection a crashed worker left behind.
      await adminQuery(adminUrl, `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    } catch (error) {
      errors.push(error);
    }
    try {
      await deleteBucket(s3, bucket);
    } catch (error) {
      errors.push(error);
    }
    s3.destroy();
    if (errors.length > 0) {
      throw new AggregateError(errors, `[int setup] teardown failed for ${database} / ${bucket}`);
    }
  };

  console.log(`[int setup] throwaway database ${database}, bucket ${bucket}`);
  try {
    await adminQuery(adminUrl, `CREATE DATABASE "${database}"`);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    Object.assign(process.env, testEnv);
    project.provide('testEnv', testEnv);
    // Each child gets the run's env explicitly; the CLI's own .env loading never overrides a set
    // variable, so it cannot fall back to the dev database.
    const childEnv = { ...process.env, ...testEnv };
    const started = Date.now();
    const deadline = started + migrateTimeoutMs;
    const timings: string[] = [];
    for (const [step, command] of MIGRATION_STEPS.entries()) {
      const stepStarted = Date.now();
      await payloadMigrate(project.config.root, step, childEnv, deadline, migrateTimeoutMs);
      timings.push(`${command} ${seconds(Date.now() - stepStarted)}`);
    }
    console.log(`[int setup] ${timings.join(', ')} (total ${seconds(Date.now() - started)})`);
  } catch (error) {
    await teardown().catch((teardownError: unknown) => console.error(teardownError));
    throw error;
  }
  return teardown;
}

// The throwaway database is new, so the first `migrate` puts every migration in batch 1 and:
//   - `migrate:down` rolls back that batch, i.e. every migration, newest first (the reverse of
//     up(), as a production rollback runs them);
//   - `migrate:reset` runs every down() again in Payload 3.90.2's own order, oldest first, so a
//     down() that needs a table an older migration created must cope with it being gone;
//   - the last `migrate` leaves the database fully migrated for the tests.
// A failed down() stops the run here, before any test. Not `migrate:refresh`: in 3.90.2 it calls
// each up() without `db`, so every generated migration throws.
const MIGRATION_STEPS = ['migrate', 'migrate:down', 'migrate', 'migrate:reset', 'migrate'] as const;

// One `payload` CLI step takes about 8 s on an idle host (mostly loading the config); a loaded host
// (parallel builds, Docker) has taken minutes for one. The limit covers all the steps together and
// stays under 10 minutes, a common limit for a single foreground command, so a hung step is stopped
// here, and the teardown still drops the database and bucket, before the caller kills the whole run.
const DEFAULT_MIGRATE_TIMEOUT_MS = 480_000;
// setTimeout's limit (2^31 - 1 ms, about 24.8 days); a larger delay fires after 1 ms instead.
const MAX_MIGRATE_TIMEOUT_MS = 2_147_483_647;

/** INT_MIGRATE_TIMEOUT_MS (milliseconds, process env or .env) overrides the default. */
function readMigrateTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.INT_MIGRATE_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_MIGRATE_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_MIGRATE_TIMEOUT_MS) {
    throw new Error(
      '[int setup] INT_MIGRATE_TIMEOUT_MS must be a whole number of milliseconds from 1 to ' +
        `${MAX_MIGRATE_TIMEOUT_MS}, got "${raw}"`,
    );
  }
  return value;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/**
 * Runs `payload <MIGRATION_STEPS[step]>` (on the committed migrations) against env.DATABASE_URL,
 * stopping it at `deadline` (the shared limit of all the steps, `limitMs` long).
 */
async function payloadMigrate(
  root: string,
  step: number,
  env: NodeJS.ProcessEnv,
  deadline: number,
  limitMs: number,
): Promise<void> {
  const command = MIGRATION_STEPS[step];
  const bin = path.join(root, 'node_modules', 'payload', 'bin.js');
  const started = Date.now();
  const elapsed = (): string => seconds(Date.now() - started);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [bin, command], {
      cwd: root,
      env,
      // No stdin: a confirmation prompt (only shown for a dev-pushed database) cannot wait for
      // input, and the timeout stops anything else that hangs.
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill();
      },
      Math.max(deadline - started, 0),
    );
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else if (timedOut) {
        reject(
          new Error(
            `[int setup] payload ${command} was stopped after ${elapsed()}: the steps ` +
              `${MIGRATION_STEPS.join(', ')} share a limit of ${limitMs} ms. A loaded host can ` +
              'need longer: raise INT_MIGRATE_TIMEOUT_MS. A migrate that waits on a "data loss" ' +
              "confirmation means the database was pushed by next dev; the run's throwaway " +
              'database never should be.',
          ),
        );
      } else {
        // Past the first step, a failure means a down() that fails or leaves part of its up()
        // behind (then the next migrate finds it).
        const hint =
          step === 0
            ? ''
            : " A migration's down() does not undo its up(): drizzle-kit's generated down() " +
              'can need fixing by hand (see src/migrations/20261009_001903_products.ts).';
        reject(
          new Error(
            `[int setup] payload ${command} (step ${step + 1} of ${MIGRATION_STEPS.length}) ` +
              `failed (${signal ?? `exit ${code}`}) after ${elapsed()}; its output is above.${hint}`,
          ),
        );
      }
    });
  });
}

function withDatabase(connectionString: string, database: string): string {
  const url = parseDatabaseUrl(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

async function adminQuery(connectionString: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function deleteBucket(s3: S3Client, bucket: string): Promise<void> {
  let continuationToken: string | undefined;
  do {
    let page;
    try {
      page = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }),
      );
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchBucket') return;
      throw error;
    }
    const objects = (page.Contents ?? []).flatMap(({ Key }) => (Key ? [{ Key }] : []));
    if (objects.length > 0) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
}
