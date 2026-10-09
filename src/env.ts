// Server environment for the CMS, the scripts and the test setup.
//
// Validation fails with the names of the missing variables only. It never prints a value, because
// several of them (PAYLOAD_SECRET, S3_SECRET_ACCESS_KEY, the password in DATABASE_URL) are secrets.
// The Payload config imports this module: no file reads here (see src/env-file.ts).

export const SERVER_ENV_NAMES = [
  'DATABASE_URL',
  'PAYLOAD_SECRET',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const;

export type ServerEnvName = (typeof SERVER_ENV_NAMES)[number];
export type ServerEnv = Record<ServerEnvName, string>;

/** Returns the named variables, or throws naming every one that is unset or blank. */
export function requireEnv<K extends string>(
  names: readonly K[],
  source: NodeJS.ProcessEnv = process.env,
): Record<K, string> {
  const missing = names.filter((name) => !source[name]?.trim());
  if (missing.length > 0) {
    const plural = missing.length > 1;
    throw new Error(
      `Missing required environment variable${plural ? 's' : ''}: ${missing.join(', ')}. ` +
        `Set ${plural ? 'them' : 'it'} in .env (see .env.example) or in the process environment.`,
    );
  }
  return Object.fromEntries(names.map((name) => [name, source[name] as string])) as Record<
    K,
    string
  >;
}

/** Every variable the Payload config needs. */
export function readServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  return requireEnv(SERVER_ENV_NAMES, source);
}

/** S3 client settings for MinIO (path-style URLs); shared by the storage adapter and scripts. */
export function s3ClientConfig(
  env: Pick<ServerEnv, 'S3_ENDPOINT' | 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY'>,
) {
  return {
    endpoint: env.S3_ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  };
}
