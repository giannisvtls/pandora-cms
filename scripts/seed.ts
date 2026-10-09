// Creates the admin user from SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD through Payload's Local API,
// in the database named by DATABASE_URL (which must already be migrated).
//
//   npm run seed        (= payload run scripts/seed.ts)
//
// Idempotent: when a user with that email already exists it reports that and changes nothing. It
// never overwrites a user and never resets a password. Roles come with the content model (Phase 4).
//
// It prints the email, never the password: every message it prints, including Payload's own
// errors (a password that is too short, a database error), has the password replaced by
// "[redacted]".
//
// `payload run` loads .env the way Next does (a variable already set in the environment wins; a
// blank one counts as unset), imports this file through tsx, then calls process.exit(0) whatever
// happened here and prints any error that escapes in full. So this script catches everything,
// prints its own messages and exits with its own code.
import { getPayload, type Payload } from 'payload';

import { requireEnv } from '../src/env';

const SEED_ENV_NAMES = ['SEED_ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD'] as const;

// Postgres' "undefined_table": the database was never migrated.
const UNDEFINED_TABLE = '42P01';

async function seed(): Promise<number> {
  let input: Record<(typeof SEED_ENV_NAMES)[number], string>;
  try {
    input = requireEnv(SEED_ENV_NAMES);
  } catch (error) {
    // requireEnv names the variables, never their values.
    console.error(`seed: ${(error as Error).message}`);
    return 1;
  }
  // Payload stores emails trimmed and lowercased (and logs in that way), so look them up that way.
  const email = input.SEED_ADMIN_EMAIL.trim().toLowerCase();
  const password = input.SEED_ADMIN_PASSWORD;
  const redact = redactor([password, process.env.PAYLOAD_SECRET, process.env.S3_SECRET_ACCESS_KEY]);

  let payload: Payload | undefined;
  try {
    // Imported here, not at the top, so that a missing seed variable fails before the config loads
    // and so that a config error (it names missing server variables) lands in this catch.
    const { default: config } = await import('../src/payload.config');
    payload = await getPayload({ config });

    const existing = await payload.find({
      collection: 'users',
      where: { email: { equals: email } },
      limit: 1,
      depth: 0,
    });
    const found = existing.docs[0];
    if (found) {
      console.log(
        redact(`seed: admin user ${email} already exists (id ${found.id}); nothing changed.`),
      );
      return 0;
    }

    const created = await payload.create({ collection: 'users', data: { email, password } });
    console.log(redact(`seed: created admin user ${email} (id ${created.id}).`));
    return 0;
  } catch (error) {
    console.error(redact(`seed: failed to seed the admin user ${email}.\n${describeError(error)}`));
    if (hasCode(error, UNDEFINED_TABLE)) {
      console.error(
        'seed: the database has no Payload tables; run `npm run payload migrate` first.',
      );
    }
    return 1;
  } finally {
    // Best effort: process.exit below ends the pool regardless.
    await payload?.destroy().catch(() => undefined);
  }
}

/** Returns a function that replaces every occurrence of each non-empty secret with [redacted]. */
function redactor(secrets: readonly (string | undefined)[]): (text: string) => string {
  const values = secrets.filter((secret): secret is string => Boolean(secret));
  return (text) => values.reduce((out, secret) => out.split(secret).join('[redacted]'), text);
}

/**
 * Name and message of an error and of its Error causes, plus the field errors of a Payload
 * ValidationError (`data.errors`: path + message). Never the stack or other properties. (Payload's
 * APIError also puts `data` in `cause`; a cause that is not an Error is not followed.)
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return `  ${String(error)}`;
  const lines: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth++) {
    // A failed query's message ends with "\nparams: …", which can hold the new user's salt and
    // hash: keep only the query line (the cause carries the Postgres error).
    const message = current.message.split('\nparams:')[0];
    lines.push(`  ${depth > 0 ? 'caused by ' : ''}${current.name}: ${message}`);
    const fieldErrors = (current as { data?: { errors?: unknown } }).data?.errors;
    if (Array.isArray(fieldErrors)) {
      for (const item of fieldErrors as { path?: unknown; message?: unknown }[]) {
        lines.push(`    ${String(item.path)}: ${String(item.message)}`);
      }
    }
    current = current.cause;
  }
  return lines.join('\n');
}

/** True when the error or one of its causes carries this (Postgres) error code. */
function hasCode(error: unknown, code: string): boolean {
  for (let current = error, depth = 0; current && depth < 4; depth++) {
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Waits until stdout and stderr have written everything (they can be async pipes on Windows). */
async function flushed(code: number): Promise<number> {
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) => new Promise<void>((resolve) => stream.write('', () => resolve())),
    ),
  );
  return code;
}

process.exit(await flushed(await seed()));
