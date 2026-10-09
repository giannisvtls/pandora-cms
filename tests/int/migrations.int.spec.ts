// Tripwire for drift between the committed migrations and the config. The run's throwaway database
// is built only from src/migrations (tests/int/setup.ts runs `payload migrate`; schema push is off
// outside `next dev`), so a config change without a migration fails here. Three checks, from
// coarse to exact:
//   1. every collection can be read (a missing table or column fails the query);
//   2. the database has exactly the columns the config defines, naming each extra or missing one;
//   3. the newest migration snapshot (src/migrations/*.json) equals the config: drizzle-kit, the
//      way `payload migrate:create` diffs them, generates no statement. This also catches type,
//      nullability, default, index, unique, foreign-key and enum drift. (drizzle-kit's push diff
//      against the live database is not used: it always plans `users.login_attempts SET DEFAULT
//      0`, a numeric default its introspection never matches.)
// After a config change: `payload migrate:create <name>` (with NODE_ENV not `development`).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { PostgresAdapter } from '@payloadcms/db-postgres';
import { sql } from '@payloadcms/db-postgres';
import { getTableConfig, type PgTable } from '@payloadcms/db-postgres/drizzle/pg-core';
import { getPayload, type Payload } from 'payload';
import { beforeAll, describe, expect, it } from 'vitest';

import config from '@/payload.config';

// The drizzle-kit calls used below, typed here: the adapter types them with drizzle-kit's own
// snapshot type, whose declarations import zod 3 while this tree resolves zod 4, so that type does
// not resolve (it reads as an error type to type-aware lint).
type Snapshot = Record<string, unknown> & { version: string };
type DrizzleKit = {
  generateDrizzleJson: (schema: Record<string, unknown>) => Snapshot | Promise<Snapshot>;
  generateMigration: (previous: Snapshot, current: Snapshot) => Promise<string[]>;
  upSnapshot?: (snapshot: Snapshot) => Snapshot;
};

// Every collection of the resolved config, Payload's own and plugin-extended ones included, so a
// collection added later is covered without touching this file.
const collections = (await config).collections;

let payload: Payload;
let db: PostgresAdapter;
let kit: DrizzleKit;

beforeAll(async () => {
  payload = await getPayload({ config: await config });
  db = payload.db as unknown as PostgresAdapter;
  // The same drizzle-kit module the adapter itself loads for `migrate:create`, read through the
  // local `DrizzleKit` type above.
  kit = db.requireDrizzleKit();
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

  it('has a newest migration snapshot equal to the config', async () => {
    // The same steps as `payload migrate:create` (@payloadcms/drizzle's buildCreateMigration):
    // the newest .json by name, upgraded first if drizzle-kit's snapshot format moved on.
    const fromConfig = await kit.generateDrizzleJson(db.schema);
    const newest = readdirSync(db.migrationDir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .at(-1);
    if (!newest) throw new Error(`no migration snapshot (.json) in ${db.migrationDir}`);
    let snapshot = JSON.parse(readFileSync(path.join(db.migrationDir, newest), 'utf8')) as Snapshot;
    if (kit.upSnapshot && snapshot.version < fromConfig.version) {
      snapshot = kit.upSnapshot(snapshot);
    }

    // Each statement is the SQL a new migration would need, so a failure names the drift.
    expect(await kit.generateMigration(snapshot, fromConfig), `config vs ${newest}`).toEqual([]);
  });
});
