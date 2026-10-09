# pandora-cms -- AI Brief

**Stack:** Node 24 / Payload 3.90.2 on Next 16.4 (App Router, standalone output) / TypeScript 6
**Database:** Postgres 18 through Payload's Postgres adapter (Drizzle), schema from committed
migrations. Media in MinIO through Payload's S3 storage adapter.
**Last explored:** 2026-10-09

## Purpose

The content backend of the Pandora website. It stores the content and serves Payload's admin
panel (`/admin`) and REST API (`/api/*`), and nothing else: it renders no public page. The Astro
static site owns every pixel and reads the content over REST. GraphQL is off
(`graphQL.disable: true`, and its route files are deleted); `/` redirects (307) to `/admin`.

Phase 0 is groundwork: the local stack, isolated Local API tests, localization, one `products`
collection, media through MinIO, a seeded admin, a boot smoke, the production image and CI. There
is no server and no deploy yet (Phase 5).

## Structure

```
.github/workflows/    ci.yml (the quality job), pr-title.yml
.husky/pre-commit     Node 24 guard, then lint-staged
docs/                 this brief, gotchas.md
scripts/              create-bucket.ts, seed.ts, smoke.ts
src/
  app/(payload)/      Payload's admin and REST routes (generated; the GraphQL routes are removed)
  collections/        Users.ts (auth), Media.ts (uploads, stored in MinIO), Products.ts
  migrations/         committed migrations: .ts (up/down) + .json (Drizzle snapshot), index.ts
  env.ts              the six server variables: validation and S3 client settings
  env-file.ts         .env loader for plain scripts and the test setup (never imported by the config)
  payload.config.ts   the Payload config
  payload-types.ts    generated types (committed)
tests/
  int/                Local API tests (*.int.spec.ts), setup.ts (globalSetup), throwaway.ts
  fixtures/pixel.png  1x1 PNG for the media test
docker-compose.yml    local Postgres + MinIO (no app service)
Dockerfile            the production app image and the `migrate` target
vitest.setup.ts       applies the run's throwaway env in every test worker
```

## Stack and pins

Every version is exact in `package.json` (the source of truth); `engines.node` is `>=24`,
`.nvmrc` is `24`, npm only, `package-lock.json` committed. The key pins:

- **CMS:** payload, @payloadcms/next, @payloadcms/db-postgres, @payloadcms/storage-s3,
  @payloadcms/richtext-lexical, @payloadcms/ui 3.90.2; next 16.4.0; react / react-dom 19.3.0;
  sharp 0.35.5; graphql 16.14.2 (a Payload peer, even with GraphQL off)
- **Clients used directly by scripts and tests:** pg 8.20.0, @aws-sdk/client-s3 3.1148.0 (the
  versions the Payload adapters resolve)
- **Types and tests:** typescript 6.0.3, @types/node 24.19.1, vitest 5.0.3, vite 8.3.4
- **Lint, format, hooks:** eslint 9.39.5, eslint-config-next 16.4.0, typescript-eslint 8.71.1,
  prettier 3.9.9, husky 9.1.7, lint-staged 17.6.0
- **Script runners:** tsx 4.23.15, cross-env 10.1.0
- **Docker images:** `node:24-alpine` (Dockerfile), `postgres:18-alpine` and
  `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` (compose and CI)

Held back on purpose: ESLint stays on 9 (`eslint-config-next` depends on `eslint-plugin-react`,
which crashes on ESLint 10); TypeScript stays on 6 (7 is the native compiler without a JS API);
Payload stays on 3.x (4.0 is a pre-release).

## Local stack and ports

`docker compose up -d` starts two services with healthchecks and named volumes, bound to
127.0.0.1 only. The CMS itself runs on the host (`npm run dev`).

| Service    | Image                                      | Host port                     |
| ---------- | ------------------------------------------ | ----------------------------- |
| `postgres` | `postgres:18-alpine`                       | 5442                          |
| `minio`    | `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` | 9100 (S3 API), 9101 (console) |

- Not the default ports (5432, 9000, 9001): other local stacks on a development machine often
  hold those.
- Dev database `pandora_cms` (created by the container), dev bucket `pandora-cms-media`
  (`npm run create-bucket`). The credentials are local-only defaults that match `.env.example`.
- Postgres 18 keeps its data under `/var/lib/postgresql/18/docker`, so the volume mounts the
  parent, `/var/lib/postgresql`.
- After Docker restarts, run `docker compose up -d` again (`docs/gotchas.md`, Local stack).

## Environment

`.env.example` lists every variable; copy it to `.env` for local work.

- The Payload config (`src/env.ts`) needs six: `DATABASE_URL`, `PAYLOAD_SECRET`, `S3_ENDPOINT`,
  `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. A missing or blank one fails at config
  load with its name, never its value. `next build` needs them set too (any values; the build
  connects to nothing).
- `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` are for the seed and the smoke;
  `INT_MIGRATE_TIMEOUT_MS` (optional) for the tests.
- A variable set in the process environment wins over a file, so no `.env` is needed when the
  environment carries everything (CI has none). While a `.env` that also defines it is present,
  Next, the Payload CLI and the smoke still expand `$NAME` in it (see `docs/gotchas.md`). Next, the Payload CLI (so the seed) and the
  smoke read `.env`, `.env.local`, `.env.development`… with `$NAME` expansion; `create-bucket` and
  the test setup read `.env` only, literally (the `$` rule is in `docs/gotchas.md`).

## Commands

npm and every script must run on Node 24 (`docs/gotchas.md`, Runtime). `dev`, `test`, `seed`,
`smoke`, `create-bucket` and the database commands of `payload` need the local stack up.

| Command                         | What it does                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm ci`                        | Install the locked dependencies (also installs the husky hook)                               |
| `npm run dev`                   | `next dev` on port 3000 (`npm run dev -- -p <port>` for another); pushes the schema          |
| `npm run build`                 | `next build`, standalone output in `.next/standalone`                                        |
| `npm run start`                 | `next start` (warns with standalone output; production runs `node server.js`, see the image) |
| `npm run typecheck`             | `tsc --noEmit`                                                                               |
| `npm run lint`                  | ESLint over the repo (type-aware rules on `src/`, `scripts/`, `tests/`)                      |
| `npm run format`                | Prettier, write                                                                              |
| `npm run format:check`          | Prettier, check only                                                                         |
| `npm run test`                  | Runs `test:int`                                                                              |
| `npm run test:int`              | Vitest Local API suite on a throwaway database + bucket (about 1-1.5 min)                    |
| `npm run test:int -- <file>`    | One test file (the setup still runs every migration step)                                    |
| `npm run create-bucket`         | Create `S3_BUCKET` when it does not exist (idempotent)                                       |
| `npm run seed`                  | Create the admin user from `SEED_ADMIN_*` when no user has that email                        |
| `npm run smoke`                 | Start `next dev` on a free port, check `/admin` 200 and the admin login 200, stop it         |
| `npm run smoke -- --url <base>` | The same checks against a server that is already up                                          |
| `npm run generate:types`        | Regenerate `src/payload-types.ts`                                                            |
| `npm run generate:importmap`    | Regenerate the admin import map, `src/app/(payload)/admin/importMap.js`                      |
| `npm run payload -- <command>`  | The Payload CLI: `migrate`, `migrate:status`, `migrate:create <name>`, `migrate:down`, ...   |
| `npm run prepare`               | `husky \|\| true` (runs on `npm ci`; installs the pre-commit hook, never fails the install)  |

- The CI order, reproducible locally: `npm ci`, `npm run lint`, `npm run format:check`,
  `npm run typecheck`, `npm run test`, `npm run build`, then `docker build --target migrate .`
  and `docker build .`.
- The pre-commit hook refuses Node < 24, then runs lint-staged (ESLint `--fix` and Prettier on
  the staged files). Typecheck and tests are not in the hook; CI runs them.

## Localization

- Locales: `en` (English, the source language and `defaultLocale`), `el` (Ελληνικά), `it`
  (Italiano), `sq` (Shqip). `fallback: false`: a value missing in a locale reads as missing,
  never as the English one.
- REST reads must always pass `?locale=<code>` (or `locale=all`). Without it a read returns no
  localized field at all. Never send `fallback-locale`: a caller that asks for
  `fallback-locale=en` still gets English filler.
- `locale=all` returns each localized field as a language map with the written locales only,
  e.g. `{ en, el }`, the shape of the site's content contract.
- `products.name` is localized and required per locale: a save in a locale must carry that
  locale's name. `payload-types.ts` types it `string`, but a locale that was never written reads
  `undefined`.
- Access is Payload's default (logged-in users) for `products`: an anonymous
  `GET /api/products` is 403 until the content model adds public read. `media` reads are public.

## Collections and migrations

- `users` (auth, the admin login), `media` (uploads with a required `alt`, stored in the bucket),
  `products` (localized `name`). The S3 adapter adds a hidden `_objectKey` field to `media`.
- Schema push happens only under `next dev`. Tests, scripts, the build and the images use the
  committed migrations, so a missing migration fails the tests instead of being pushed silently.
- To change the schema: edit the config, `npm run payload -- migrate:create <name>`, hand-fix the
  new `down()` (`docs/gotchas.md`, Migrations), `npm run generate:types`, and commit the
  migration, its `.json` and the types together. `tests/int/migrations.int.spec.ts` fails when the
  config and the migrations disagree (a `find` per collection, the column sets, and a Drizzle
  snapshot diff that must be empty).

## Tests and isolation

`npm run test` never opens the dev database or bucket:

1. `tests/int/setup.ts` (Vitest globalSetup) reads `DATABASE_URL`, `S3_ENDPOINT` and the S3
   credentials (process environment, then `.env`) and creates database
   `pandora_cms_test_<12 hex>` and bucket `pandora-cms-test-<12 hex>` on those servers, with a
   random `PAYLOAD_SECRET`.
2. It runs five `payload` CLI steps, each a child process, against that database: `migrate`,
   `migrate:down`, `migrate`, `migrate:reset`, `migrate`. Every `down()` is proven in both of
   Payload's rollback orders (newest first, oldest first), and the database ends fully migrated.
   One limit covers the five: `INT_MIGRATE_TIMEOUT_MS`, default 480 s.
3. The run's env reaches every worker through `process.env` and Vitest `provide`/`inject`;
   `vitest.setup.ts` refuses any database or bucket that is not a throwaway name before a test
   file imports the config (Payload reads its env at import).
4. Teardown drops the database (`WITH (FORCE)`) and empties and deletes the bucket, also when the
   setup fails.

Concurrent runs (two checkouts, CI) never collide. Six files, 22 tests: `api` (Local API find),
`products` (the locale round trip), `media` (an upload read back from the bucket), `migrations`
(the drift tripwire), `seed` (the seed as child processes), `throwaway` (the name guard and URL
parsing).

## Seed

`npm run seed` = `payload run scripts/seed.ts`, through the Local API, into `DATABASE_URL`'s
database (which must be migrated). It creates the admin from `SEED_ADMIN_EMAIL` (trimmed,
lowercased) and `SEED_ADMIN_PASSWORD` only when no user has that email; it never changes an
existing user or password and never prints the password (every message is redacted). It exits
non-zero naming a missing variable, on an unmigrated database (with a hint to run
`npm run payload migrate`), and on any other error. Roles come with the content model.

## Smoke

`npm run smoke` (`scripts/smoke.ts`, Node `fetch`, no browser) checks `GET /admin` → 200, then
`POST /api/users/login` with the seed's credentials → 200 with a token.

- Without `--url` it starts `next dev` on a free port chosen by the OS (never 3000, 5432, 5442,
  9000, 9001, 9100 or 9101), waits up to 240 s for `/admin`, runs the checks, stops the whole
  process tree and proves the port free. It runs in dev mode, so it pushes the schema into
  `DATABASE_URL`'s database and may regenerate `payload-types.ts`.
- `--url <base>` makes one attempt per check against a running server (`next dev`, the image):
  wait for `/admin` to answer before running it.
- Exit 0: every check passed; 1: a check failed; 2: bad arguments or a missing variable. It never
  prints the password or the token.

## Production image

`Dockerfile`: stages `base` → `deps` → `source` → `builder` → `runner`, plus `migrate`, all on
`node:24-alpine`.

| Target            | Build                                                    | Runs                                    | Size    |
| ----------------- | -------------------------------------------------------- | --------------------------------------- | ------- |
| app (the default) | `docker build -t pandora-cms .`                          | `node server.js` on 3000 as user `node` | ~243 MB |
| `migrate`         | `docker build --target migrate -t pandora-cms-migrate .` | `payload migrate`, then exits           | ~1.1 GB |

- **App:** Next's standalone server and its traced files only; app files owned by root and
  read-only, only `.next/cache` writable; `NODE_ENV=production`, `PORT=3000`,
  `HOSTNAME=0.0.0.0`; no `X-Powered-By`; Payload and Next telemetry off. Building it needs about
  3 GB of memory.
- **`migrate`:** built from the `source` stage (full dependencies + source, no Next build), so it
  carries no build cache and builds without the 3 GB `next build`.
- **No secret in either image.** The six variables are given at run time (`-e` or an env file,
  whose values Docker reads literally);
  the build's dummy values exist only inside one `RUN`. `.dockerignore` keeps `.env*`, keys,
  dumps, `.git`, `node_modules` and `.next` out of the build context.
- **Release order:** run `migrate` against the database first, with a timeout, and check
  `payload_migrations` (`npm run payload -- migrate:status`); then start the app. The app never
  migrates on start.
- **Liveness:** `GET /admin` → 200. There is no `HEALTHCHECK` yet; `HEAD /api/*` answers 404, and
  an open port proves nothing.
- Proven on a development machine against the compose stack and a fresh database: migrate twice
  (the second a no-op), the app's `/admin` 200, seed from the host, `smoke --url` 200 / 200, and
  an upload served back from the bucket.

## CI

`.github/workflows/ci.yml` runs on pull requests to `main` and pushes to `main`; a newer push to a
pull request cancels its older run, while every commit on `main` keeps its own result.
`permissions: contents: read`, actions pinned to major tags, Node from `.nvmrc`,
`NEXT_TELEMETRY_DISABLED=1`.

- **quality** (ubuntu-latest, 30 min limit): a `postgres:18-alpine` service container on port
  5442 (health-checked); MinIO started by `docker run -d … server /data` on 9100 and awaited on
  `/minio/health/live` (a service container cannot pass a command); dummy values for the six
  variables in the job env (no `.env`, no repository secret). Steps: `npm ci`, `lint`,
  `format:check`, `typecheck`, `test`, `build`, then `docker build --target migrate .` and
  `docker build .` (never pushed).
- `pr-title.yml` checks that pull request titles follow Conventional Commits (types feat, fix,
  chore, docs, refactor, test, ci, build, perf, style, revert) with
  `amannn/action-semantic-pull-request@v6` and `pull-requests: read`.

## Phase 5 target

A dedicated Hetzner Cloud server (EU location) runs one Docker Compose stack: an edge proxy with
automatic TLS, the CMS (the app image, after the `migrate` one-shot), Postgres and MinIO. Backups:
a nightly `pg_dump` and MinIO archive kept 14 days on the server, plus Hetzner's automatic server
backups. The static site stays on Cloudflare Pages and reads this CMS over REST.

Before the CMS is reachable there:

- [ ] Seed the first admin before the app is reachable: on an empty `users` table, Payload's
      admin lets anyone create the first user.
- [ ] Refuse the `.env.example` placeholder password when seeding a server (the seed accepts any
      value).
- [ ] `cookies.secure` on the users' auth config behind TLS (the `payload-token` cookie has no
      `Secure` flag today).
- [ ] An email adapter: without one, password-reset mails only go to the log.
- [ ] Pin `node:24-alpine` by digest (the tag floats).
- [ ] Run the `migrate` one-shot with a timeout, then check `payload_migrations`.
- [ ] Build the images in CI or on a machine with at least 4 GB of memory.
- [ ] More than one app instance: set `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (Next generates a key
      per build).
- [ ] Real secrets for `PAYLOAD_SECRET`, Postgres and MinIO, never the local defaults; consider
      `disableCreateDatabase` (`docs/gotchas.md`, Environment).
- [ ] Optional: drop sharp's glibc binaries from the app image (~18 MB); npm 12 may block the
      esbuild / unrs-resolver install scripts (`docs/gotchas.md`, Production image).

## Notes

Phase 0 limits:

- One content collection, `products`, with a name only. The content model, roles and public read
  access come in Phase 4.
- No server, no deploy, no cloud credentials.
- No `HEALTHCHECK` in the image and no email adapter.

Repo-specific traps and their rules: `docs/gotchas.md`.
