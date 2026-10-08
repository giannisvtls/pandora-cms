// Tripwire for drift between the committed migrations and the config. The run's throwaway database
// is built only from src/migrations (tests/int/setup.ts runs `payload migrate`; schema push is off
// outside `next dev`), so anything the config defines that no migration creates (a new field or
// collection, or a field a plugin adds, like storage-s3's hidden `_objectKey` on `media`) fails
// here, naming the collection or the column. After a config change: `payload migrate:create`.
import type { PostgresAdapter } from '@payloadcms/db-postgres';
import { sql } from '@payloadcms/db-postgres';
import { getTableConfig, type PgTable } from '@payloadcms/db-postgres/drizzle/pg-core';
import { getPayload, type Payload } from 'payload';
import { beforeAll, describe, expect, it } from 'vitest';

import config from '@/payload.config';

// Every collection of the resolved config, Payload's own and plugin-extended ones included, so a
// collection added later is covered without touching this file.
const collections = (await config).collections;

let payload: Payload;

beforeAll(async () => {
  payload = await getPayload({ config: await config });
});

describe('committed migrations match the config', () => {
  it.each(collections.map(({ slug, versions }) => ({ slug, versions: Boolean(versions) })))(
    'reads collection $slug',
    async ({ slug, versions }) => {
      // Selects every column of the collection's tables (locales, arrays and relations joined).
      await payload.find({ collection: slug, limit: 1, depth: 0 });
      if (versions) await payload.findVersions({ collection: slug, limit: 1, depth: 0 });
    },
  );

  it('has exactly the columns the config defines, table by table', async () => {
    const db = payload.db as unknown as PostgresAdapter;
    const expected = new Set<string>();
    for (const table of Object.values(db.tables) as PgTable[]) {
      const { name, columns } = getTableConfig(table);
      for (const column of columns) expected.add(`${name}.${column.name}`);
    }
    const { rows } = await db.drizzle.execute<{ qualified_name: string }>(sql`
      select table_name || '.' || column_name as qualified_name
      from information_schema.columns
      where table_schema = current_schema()
    `);
    const actual = new Set(rows.map((row) => row.qualified_name));

    expect({
      missingFromDatabase: [...expected].filter((column) => !actual.has(column)).sort(),
      notInConfig: [...actual].filter((column) => !expected.has(column)).sort(),
    }).toEqual({ missingFromDatabase: [], notInConfig: [] });
  });
});
