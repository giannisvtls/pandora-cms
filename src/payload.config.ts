import { postgresAdapter } from '@payloadcms/db-postgres';
import { lexicalEditor } from '@payloadcms/richtext-lexical';
import { s3Storage } from '@payloadcms/storage-s3';
import path from 'path';
import { buildConfig } from 'payload';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

import { Users } from './collections/Users';
import { Media } from './collections/Media';
import { readServerEnv, s3ClientConfig } from './env';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

// Fails here, naming the missing variables, before anything connects.
const env = readServerEnv();

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  collections: [Users, Media],
  editor: lexicalEditor(),
  // Admin + REST only: the static site reads content over REST, so the GraphQL endpoint is off.
  graphQL: {
    disable: true,
  },
  secret: env.PAYLOAD_SECRET,
  typescript: {
    // Payload regenerates this file on init outside production. Only `next dev` should: tests,
    // scripts and the CLI would otherwise rewrite the committed file on every run (concurrently,
    // one writer per test worker). Regenerate explicitly with `npm run generate:types`.
    autoGenerate: process.env.NODE_ENV === 'development',
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: postgresAdapter({
    pool: {
      connectionString: env.DATABASE_URL,
    },
    // Schema push only under `next dev`. Everywhere else (tests, scripts, production) the schema
    // comes from the committed migrations, so a missing migration fails loudly instead of being
    // papered over by a push.
    push: process.env.NODE_ENV === 'development',
  }),
  sharp,
  plugins: [
    s3Storage({
      collections: { media: true },
      bucket: env.S3_BUCKET,
      config: s3ClientConfig(env),
    }),
  ],
});
