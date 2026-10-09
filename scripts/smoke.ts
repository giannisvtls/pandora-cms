// Boot smoke for the admin, with Node's fetch (no browser):
//   1. GET  <base>/admin            answers 200;
//   2. POST <base>/api/users/login  with SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD answers 200 with a
//      token. Run `npm run seed` first. Both scripts load the environment with the Payload CLI's
//      loader (process env first, then .env, .env.local, .env.development…, with `$NAME`
//      expansion), so they always agree on the password.
// It never prints the password or the token.
//
//   npm run smoke                    starts `next dev` on a free port chosen by the OS, waits for
//                                    /admin, runs the checks, then stops the server's whole process
//                                    tree and confirms that the port is free again
//   npm run smoke -- --url <base>    runs the checks once against a server that is already up,
//                                    e.g. http://127.0.0.1:3000 (`next dev`, `next start`, the image)
//
// Without --url, `next dev` uses this checkout and the environment as `npm run dev` would (so
// DATABASE_URL picks the database, and dev mode pushes the schema into it). Next allows one
// `next dev` per directory: with a dev server already running here, use --url with its address.
//
// Exit codes: 0 every check passed, 1 a check failed, 2 bad arguments or missing variables.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { loadEnv } from 'payload/node';

import { requireEnv } from '../src/env';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NEXT_BIN = path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');

// The first request to `next dev` compiles the admin, which takes minutes on a slow host.
const READY_TIMEOUT_MS = 240_000;
// One request (a first request in dev mode compiles its route).
const REQUEST_TIMEOUT_MS = 120_000;
// How long a stopped server may take to release its port.
const PORT_RELEASE_TIMEOUT_MS = 15_000;
// POSIX: how long `next dev` gets to exit on SIGTERM before its process group is killed.
const SIGTERM_GRACE_MS = 5_000;
// Never start the dev server on a port another local service is known to use.
const AVOID_PORTS = new Set([3000, 5432, 5442, 9000, 9001, 9100, 9101]);
// Lines of `next dev` output kept to print when the smoke fails.
const LOG_TAIL_LINES = 60;
// Signals that stop the dev server before the smoke exits.
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
// Windows: taskkill by full path, so a taskkill.exe in the working directory is never run.
const TASKKILL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');

const USAGE = `Usage:
  npm run smoke                    start next dev on a free port, check it, stop it
  npm run smoke -- --url <base>    check a running server, e.g. --url http://127.0.0.1:3000`;

/** A check that failed; its message is printed as is. */
class SmokeFailure extends Error {}

type Credentials = { email: string; password: string };

let redact: (text: string) => string = (text) => text;

async function main(): Promise<number> {
  let base: string | undefined;
  try {
    const { values } = parseArgs({
      options: { url: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      console.log(USAGE);
      return 0;
    }
    if (values.url !== undefined) base = parseBaseUrl(values.url);
  } catch (error) {
    console.error(`smoke: ${(error as Error).message}\n${USAGE}`);
    return 2;
  }

  let credentials: Credentials;
  try {
    // The loader `payload run` (the seed) uses, in dev mode like `next dev`.
    loadEnv(ROOT);
    const env = requireEnv(['SEED_ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD']);
    credentials = { email: env.SEED_ADMIN_EMAIL.trim(), password: env.SEED_ADMIN_PASSWORD };
  } catch (error) {
    // requireEnv names the variables, never their values.
    console.error(`smoke: ${(error as Error).message}`);
    return 2;
  }
  redact = redactor([credentials.password]);

  try {
    if (base) {
      console.log(`smoke: checking ${base}`);
      await runChecks(base, credentials);
    } else {
      await withDevServer((devBase) => runChecks(devBase, credentials));
    }
    console.log('smoke: PASS');
    return 0;
  } catch (error) {
    const message = error instanceof SmokeFailure ? error.message : describe(error);
    console.error(redact(`smoke: FAIL: ${message}`));
    return 1;
  }
}

/** The two checks against a server that is up. */
async function runChecks(base: string, { email, password }: Credentials): Promise<void> {
  const admin = await request(`${base}/admin`, { redirect: 'manual' });
  await admin.body?.cancel();
  if (admin.status !== 200) {
    throw new SmokeFailure(`GET /admin answered ${admin.status} (expected 200)`);
  }
  console.log('smoke: ok   GET /admin -> 200');

  const login = await request(`${base}/api/users/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ email, password }),
    redirect: 'manual',
  });
  const body = await readJson(login);
  const token = (body as { token?: unknown } | undefined)?.token;
  if (typeof token === 'string' && token) {
    // From here on, never print the token either.
    const previous = redact;
    redact = (text) => previous(text).split(token).join('[redacted]');
  }
  if (login.status !== 200) {
    throw new SmokeFailure(
      `POST /api/users/login answered ${login.status} (expected 200)${payloadErrors(body)}\n` +
        '  Is the admin seeded (npm run seed) with the same SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD? ' +
        'Payload locks a user for 10 minutes after 5 failed logins.',
    );
  }
  if (typeof token !== 'string' || !token) {
    throw new SmokeFailure('POST /api/users/login answered 200 without a token');
  }
  console.log('smoke: ok   POST /api/users/login -> 200 with a token');
}

/**
 * Starts `next dev` on a free port, waits until /admin answers 200, runs `checks` against it and
 * stops the server's whole process tree, also when the checks fail or the smoke is interrupted.
 */
async function withDevServer(checks: (base: string) => Promise<void>): Promise<void> {
  const port = await freePort();
  // Loopback only: the smoke's server is not reachable from the network.
  const base = `http://127.0.0.1:${port}`;
  console.log(`smoke: starting next dev on port ${port} (chosen by the OS)`);

  const server = startDevServer(port);
  // One stop, shared by the normal path and an interrupt that arrives at any point.
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => (stopping ??= stopServer(server, port));
  const onSignal = (signal: NodeJS.Signals): void => {
    console.error(`smoke: ${signal}: stopping next dev`);
    void stop()
      .catch((error: unknown) => console.error(redact(`smoke: FAIL: ${describe(error)}`)))
      .finally(() => process.exit(130));
  };
  // SIGHUP: a closed terminal; on POSIX the detached server would not get the hangup itself.
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal);
  // Last resort if the process exits some other way: kill the tree synchronously.
  const onExit = (): void => killTreeSync(server);
  process.on('exit', onExit);
  let stopped = false;

  let failure: Error | undefined;
  try {
    const waited = await waitForAdmin(base, server);
    console.log(`smoke: next dev is up (GET /admin answered 200 after ${seconds(waited)})`);
    await checks(base);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    if (server.log.length > 0) {
      console.error(`smoke: last ${server.log.length} lines of next dev output:`);
      for (const line of server.log) console.error(redact(`  next dev | ${line}`));
    }
  }

  try {
    await stop();
    stopped = true;
  } catch (error) {
    // Report a failed stop too, without hiding the check that failed first.
    if (!failure) throw error;
    console.error(redact(`smoke: FAIL: ${describe(error)}`));
  } finally {
    for (const signal of STOP_SIGNALS) process.removeListener(signal, onSignal);
    // After a failed stop, keep the last-resort kill for when the smoke exits.
    if (stopped) process.removeListener('exit', onExit);
  }
  if (failure) throw failure;
}

type DevServer = {
  child: ChildProcess;
  /** The last LOG_TAIL_LINES lines of its output. */
  log: string[];
  /** Set when the process has exited or could not be started. */
  exited: boolean;
  /** Resolves when `exited` becomes true. */
  whenExited: Promise<void>;
};

function startDevServer(port: number): DevServer {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_OPTIONS: '--no-deprecation',
  };
  // next dev sets NODE_ENV itself (and warns about any other value). Next's types declare NODE_ENV
  // as always set, hence the plain record and the cast below.
  delete env.NODE_ENV;
  // The running Node binary (the version this smoke runs on), not whatever `node` is on PATH.
  const child = spawn(
    process.execPath,
    [NEXT_BIN, 'dev', '--port', String(port), '--hostname', '127.0.0.1'],
    {
      cwd: ROOT,
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX: its own process group, so the whole tree can be signalled at once.
      detached: process.platform !== 'win32',
      windowsHide: true,
    },
  );
  const server: DevServer = { child, log: [], exited: false, whenExited: Promise.resolve() };
  const keep = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      server.log.push(line);
      if (server.log.length > LOG_TAIL_LINES) server.log.shift();
    }
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  server.whenExited = new Promise<void>((resolve) => {
    const done = (): void => {
      server.exited = true;
      resolve();
    };
    child.once('exit', done);
    child.once('error', (error) => {
      server.log.push(`could not start next dev: ${error.message}`);
      if (child.pid === undefined) done(); // never started, so no 'exit' follows
    });
  });
  return server;
}

/** Polls GET /admin until it answers 200; returns how long that took. */
async function waitForAdmin(base: string, server: DevServer): Promise<number> {
  const started = Date.now();
  const deadline = started + READY_TIMEOUT_MS;
  let last = 'no answer yet';
  while (Date.now() < deadline) {
    if (server.exited) {
      throw new SmokeFailure(
        `next dev exited (${exitDescription(server.child)}) before GET /admin answered 200. ` +
          'If another `next dev` runs in this directory, stop it or use --url with its address.',
      );
    }
    try {
      const response = await fetch(`${base}/admin`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(deadline - Date.now(), REQUEST_TIMEOUT_MS)),
        ),
      });
      await response.body?.cancel();
      if (response.status === 200) return Date.now() - started;
      // The server answered, so it is up and compiled: another status will not turn into 200.
      throw new SmokeFailure(`GET /admin answered ${response.status} (expected 200)`);
    } catch (error) {
      if (error instanceof SmokeFailure) throw error;
      last = describe(error); // not listening yet, or still compiling
    }
    await sleep(1_000);
  }
  throw new SmokeFailure(
    `GET /admin did not answer within ${seconds(READY_TIMEOUT_MS)} (last attempt: ${last})`,
  );
}

/** Stops the whole process tree, then waits until nothing listens on the port. */
async function stopServer(server: DevServer, port: number): Promise<void> {
  const { child } = server;
  if (process.platform === 'win32') {
    killTreeSync(server);
  } else if (child.pid !== undefined) {
    signalGroup(child.pid, 'SIGTERM');
    await Promise.race([server.whenExited, sleep(SIGTERM_GRACE_MS)]);
    // Also catches workers that outlive their parent.
    signalGroup(child.pid, 'SIGKILL');
  }
  await Promise.race([server.whenExited, sleep(PORT_RELEASE_TIMEOUT_MS)]);
  if (!server.exited) {
    throw new Error(`next dev (pid ${child.pid}) is still running after being stopped`);
  }
  console.log(`smoke: stopped next dev's process tree (pid ${child.pid})`);
  await waitForPortFree(port);
  console.log(`smoke: port ${port} is free (nothing listening, and it can be bound again)`);
}

/**
 * Kills the process and every descendant. Windows: `taskkill /T /F` walks the tree (next dev forks
 * its server); without /F a windowless process gets no close signal. POSIX: SIGKILL to the group.
 */
function killTreeSync(server: DevServer): void {
  const { pid } = server.child;
  if (pid === undefined || server.exited) return;
  if (process.platform === 'win32') {
    const result = spawnSync(TASKKILL, ['/F', '/T', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 30_000,
    });
    // 128: no such process (it exited meanwhile). Anything else is reported, never ignored.
    if (result.error || (result.status !== 0 && result.status !== 128)) {
      const reason = result.error ? describe(result.error) : `exit code ${String(result.status)}`;
      console.error(`smoke: taskkill of next dev (pid ${pid}) failed: ${reason}`);
    }
  } else {
    signalGroup(pid, 'SIGKILL');
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; // ESRCH: already gone
  }
}

/** An OS-assigned free port on the loopback interface, never one in AVOID_PORTS. */
async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await listenAndClose(0);
    if (!AVOID_PORTS.has(port)) return port;
  }
  throw new Error('could not get a free port from the OS');
}

/** Binds the port on 127.0.0.1 (0 = any free one), releases it and returns its number. */
function listenAndClose(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen({ port, host: '127.0.0.1' }, () => {
      const bound = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(bound));
    });
  });
}

/** True when a TCP connection to 127.0.0.1:port is accepted. */
function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(2_000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(true); // something holds the port but does not answer
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitForPortFree(port: number): Promise<void> {
  const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;
  let reason = '';
  while (Date.now() < deadline) {
    if (await isListening(port)) {
      reason = 'something still listens on it';
    } else {
      try {
        await listenAndClose(port);
        return;
      } catch (error) {
        reason = `binding it failed: ${describe(error)}`;
      }
    }
    await sleep(500);
  }
  throw new Error(
    `port ${port} is not free ${seconds(PORT_RELEASE_TIMEOUT_MS)} after stopping next dev (${reason})`,
  );
}

/** fetch with a bounded time for the whole exchange; network errors become SmokeFailures. */
async function request(url: string, init: RequestInit): Promise<Response> {
  const label = `${init.method ?? 'GET'} ${new URL(url).pathname}`;
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new SmokeFailure(`${label} failed: ${describe(error)}`);
  }
}

/** The JSON body, or undefined when there is none or it is not JSON. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch {
    return undefined;
  }
}

/** Payload's error messages from an error body ({ errors: [{ message }] }), never anything else. */
function payloadErrors(body: unknown): string {
  const errors = (body as { errors?: unknown } | undefined)?.errors;
  if (!Array.isArray(errors)) return '';
  const messages = errors
    .map((item) => (item as { message?: unknown }).message)
    .filter((message): message is string => typeof message === 'string')
    .map((message) => message.slice(0, 200));
  return messages.length > 0 ? `; Payload says: ${messages.join(' / ')}` : '';
}

/** The base URL from --url: http(s), no credentials, no path, query or fragment. */
function parseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`--url "${value}" is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`--url must be http or https, got "${url.protocol}"`);
  }
  if (url.username || url.password) {
    throw new Error('--url must not contain credentials');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`--url takes the server's base URL only (like ${url.origin}), not a path`);
  }
  return url.origin;
}

function exitDescription(child: ChildProcess): string {
  if (child.signalCode) return `signal ${child.signalCode}`;
  return child.exitCode === null ? 'it did not start' : `exit code ${child.exitCode}`;
}

/** Name and message of an error and its causes (fetch puts the network error in `cause`). */
function describe(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth++) {
    parts.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }
  return parts.length > 0 ? parts.join(' <- ') : String(error);
}

function redactor(secrets: readonly string[]): (text: string) => string {
  const values = secrets.filter(Boolean);
  return (text) => values.reduce((out, secret) => out.split(secret).join('[redacted]'), text);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** Waits until stdout and stderr have written everything (they can be async pipes on Windows). */
async function flushed(code: number): Promise<number> {
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) => new Promise<void>((resolve) => stream.write('', () => resolve())),
    ),
  );
  return code;
}

// Explicit exit: fetch's keep-alive sockets would otherwise hold the process open for a while.
process.exit(await flushed(await main()));
