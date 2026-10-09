// The admin seed (`npm run seed` = `payload run scripts/seed.ts`) against the run's throwaway
// database. Every seed run is a child process, as `npm run seed` is: Payload never starts in this
// worker, so no pool connection is left open for the teardown's DROP DATABASE ... WITH (FORCE).
// The children run in an empty temporary directory whose .env sets nothing: `payload run` loads
// .env from its working directory, and a developer's .env must not add a variable a test unsets.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
// Concurrent tests assert with their context's `expect`.
import { afterAll, beforeAll, describe, inject, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PAYLOAD_BIN = path.join(ROOT, 'node_modules', 'payload', 'bin.js');
const SEED_SCRIPT = path.join(ROOT, 'scripts', 'seed.ts');

// One seed run loads the Payload config (about 8 s on an idle host); a loaded host is much slower.
const RUN_TIMEOUT_MS = 180_000;

const testEnv = inject('testEnv');

let workdir: string;

beforeAll(async () => {
  workdir = await mkdtemp(path.join(os.tmpdir(), 'pandora-cms-seed-test-'));
  await writeFile(path.join(workdir, '.env'), '# Empty on purpose: each seed run gets its env.\n');
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

type SeedRun = { code: number | null; stdout: string; stderr: string; output: string };
type SeedVars = { SEED_ADMIN_EMAIL?: string; SEED_ADMIN_PASSWORD?: string };

/** Runs the seed with the run's server env plus exactly these seed variables (absent = unset). */
function runSeed(vars: SeedVars): Promise<SeedRun> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...testEnv,
    NODE_OPTIONS: '--no-deprecation',
  };
  // As from a shell: no NODE_ENV (Vitest sets "test") and no seed variable it does not pass.
  delete env.NODE_ENV;
  delete env.SEED_ADMIN_EMAIL;
  delete env.SEED_ADMIN_PASSWORD;
  Object.assign(env, vars);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PAYLOAD_BIN, 'run', SEED_SCRIPT], {
      cwd: workdir,
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the seed did not finish within ${RUN_TIMEOUT_MS} ms`));
    }, RUN_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // 'close': the process has exited and its output is fully read.
    child.once('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      resolve({ code, stdout: out, stderr: err, output: `${out}\n${err}` });
    });
  });
}

type UserRow = { id: number; email: string; hash: string; salt: string; updated_at: string };

/** The users rows with this email, read straight from the throwaway database. */
async function usersWithEmail(email: string): Promise<UserRow[]> {
  const client = new pg.Client({ connectionString: testEnv.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<UserRow>(
      'SELECT id, email, hash, salt, updated_at::text AS updated_at FROM users WHERE email = $1',
      [email],
    );
    return rows;
  } finally {
    await client.end();
  }
}

const uniqueEmail = (label: string): string =>
  `seed-${label}-${randomBytes(4).toString('hex')}@example.com`;
const sentinelPassword = (): string => `sentinel-${randomBytes(12).toString('hex')}`;

// The tests use different emails and are independent, so their (slow) seed runs overlap.
describe.concurrent('seed: admin user from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD', () => {
  it('is what `npm run seed` runs', async ({ expect }) => {
    const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.seed).toMatch(/(^|\s)payload run scripts\/seed\.ts$/);
  });

  it(
    'creates the user once; later runs report it exists and change nothing',
    async ({ expect }) => {
      const email = uniqueEmail('admin');
      const password = sentinelPassword();

      const first = await runSeed({ SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: password });
      expect(first.code, first.output).toBe(0);
      expect(first.stdout).toContain(`seed: created admin user ${email}`);
      const created = await usersWithEmail(email);
      expect(created).toHaveLength(1);
      expect(created[0].hash).toBeTruthy();
      expect(created[0].salt).toBeTruthy();

      // The same command again: a no-op.
      const second = await runSeed({ SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: password });
      expect(second.code, second.output).toBe(0);
      expect(second.stdout).toContain(`seed: admin user ${email} already exists`);
      expect(second.stdout).not.toContain('created');
      expect(await usersWithEmail(email)).toEqual(created); // same id, hash, salt, updated_at

      // The email as typed differently (Payload stores it trimmed and lowercased) and another
      // password: still the same user, and the password is never reset.
      const third = await runSeed({
        SEED_ADMIN_EMAIL: ` ${email.toUpperCase()} `,
        SEED_ADMIN_PASSWORD: sentinelPassword(),
      });
      expect(third.code, third.output).toBe(0);
      expect(third.stdout).toContain(`seed: admin user ${email} already exists`);
      expect(await usersWithEmail(email)).toEqual(created);

      for (const run of [first, second, third]) expect(run.output).not.toContain(password);
    },
    3 * RUN_TIMEOUT_MS,
  );

  it(
    'exits non-zero naming a missing or blank variable, before touching the database',
    async ({ expect }) => {
      const email = uniqueEmail('missing');
      const password = sentinelPassword();

      const noPassword = await runSeed({ SEED_ADMIN_EMAIL: email });
      expect(noPassword.code).not.toBe(0);
      expect(noPassword.stderr).toContain(
        'Missing required environment variable: SEED_ADMIN_PASSWORD',
      );

      const blankEmail = await runSeed({ SEED_ADMIN_EMAIL: '   ', SEED_ADMIN_PASSWORD: password });
      expect(blankEmail.code).not.toBe(0);
      expect(blankEmail.stderr).toContain(
        'Missing required environment variable: SEED_ADMIN_EMAIL',
      );
      expect(blankEmail.output).not.toContain(password);

      expect(await usersWithEmail(email)).toHaveLength(0);
    },
    2 * RUN_TIMEOUT_MS,
  );

  it(
    "reports Payload's validation error without printing the password",
    async ({ expect }) => {
      const email = uniqueEmail('short');
      // Shorter than Payload's 3-character minimum; characters no log line contains otherwise.
      const password = '§¶';

      const run = await runSeed({ SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: password });
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain(`seed: failed to seed the admin user ${email}`);
      expect(run.stderr).toContain('ValidationError');
      expect(run.stderr).toContain('password: This value must be longer than the minimum length');
      expect(run.output).not.toContain(password);
      expect(await usersWithEmail(email)).toHaveLength(0);
    },
    RUN_TIMEOUT_MS,
  );
});
