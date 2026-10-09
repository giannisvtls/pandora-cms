// Reads a dotenv file into the environment, for plain scripts and the test setup (`next` and the
// Payload CLI load `.env` themselves).
//
// Keep this out of the Payload config's imports (src/payload.config.ts, src/env.ts and everything
// they import). Turbopack cannot resolve `readFileSync(file)` with a variable path, so it traces
// the whole project directory, `.env` included, into every route that imports the config and
// copies it into `.next/standalone`.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * Fills unset variables from a dotenv file, the way Next and the Payload CLI do: a variable that
 * is already set (even to an empty string) wins over the file. A missing file is not an error.
 */
export function loadDotEnvFile(file = '.env', target: NodeJS.ProcessEnv = process.env): void {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (target[name] === undefined) target[name] = value;
  }
}
