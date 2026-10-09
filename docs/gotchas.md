# Gotchas

Traps this repo has already hit, each stated as the trap and the rule that avoids it. Read the
section for the area you are about to touch. When you hit a new one, add it here in the same
shape.

## Runtime, install and Windows

- **Node 24 must run npm, not only be on PATH.** npm runs every script with the Node that npm
  itself runs on. On Windows, an `npm` that belongs to an older Node install (for example nvm's)
  runs the scripts on that Node even when Node 24 is first on PATH, and most gates still pass, so
  the wrong runtime goes unnoticed. Rule: use Node 24's npm (or start npm through Node 24:
  `node <path to npm-cli.js> run <script>`) and keep Node 24 first on PATH for the git hook. The
  pre-commit hook stops on Node < 24 because lint-staged 17 crashes there and then reverts the
  staged files.
- **npm runs scripts through `cmd.exe` on Windows.** `$VAR` in an npm script is not expanded and
  `rm -rf` does not exist there. Rule: `cross-env` for variables, a Node script for anything more
  (the template's `devsafe` script, an `rm -rf`, was dropped for this).
- **No `.npmrc`.** Payload's `with-postgres` template (v3.90.2) ships no `.npmrc`, and none was
  added: `npm ci` is clean with peer checks on. Rule: never add `legacy-peer-deps=true` (other
  Payload templates ship it); it turns off peer checks for every package. Fix a peer conflict with
  one exact `overrides` entry in `package.json` and record it here.
- **Pins that cannot move yet.** ESLint 10 crashes in `eslint-plugin-react` (a dependency of
  `eslint-config-next`), so ESLint stays on 9 and `npm ci` prints a deprecation warning for
  `eslint@9.39.5` (expected). TypeScript 6 rejects `baseUrl` (TS5101): `tsconfig.json` has
  `paths` without it. Vitest 5 needs `vite` installed as a peer: keep `vite` in
  `devDependencies`.
- **`next dev` writes `AGENTS.md`.** Next 16.4 re-adds its block to `AGENTS.md` on every run.
  Rule: keep the committed file; a diff there after `next dev` is Next re-adding the block.
- **`npm ls` lists `@img/sharp-wasm32` entries as extraneous.** An npm quirk with optional
  platform packages, not drift. Rule: ignore it; never "sync" the lockfile with
  `npm install --package-lock-only`.

## Local stack (Docker)

- **Default ports.** Other local stacks often hold 5432, 9000 and 9001. Rule: this repo's stack
  uses 5442 (Postgres) and 9100 / 9101 (MinIO), on 127.0.0.1; on "connection refused", check
  `docker compose ps` and the listening ports before suspecting the code.
- **The stack stays down after a Docker restart.** `restart: unless-stopped` treats stopping
  Docker Desktop (`docker desktop stop`) as an explicit stop of the containers.
  Rule: run `docker compose up -d` after Docker comes back (same volumes, no data lost).
- **Docker memory.** The app image build needs about 3 GB (see Production image). Rule: give
  Docker Desktop at least 4 GB (Settings → Resources).

## Environment and `.env`

- **Env is validated at config load.** Every `payload` CLI command, `next dev` and `next build`
  load the config, which refuses to start without the six server variables. Rule: set all six,
  with any values for a build. The `.env` loaders trim unquoted values, but a quoted value
  (`X="foo "`) or one set in the process environment keeps its spaces, and `src/env.ts` passes it
  on as is (it refuses only an all-blank value).
- **`$` in `.env` values.** Next, the Payload CLI (so `npm run seed`) and the smoke expand `$NAME`
  in `.env` values (`\$` gives a literal `$`); `create-bucket` and the test setup read `.env`
  literally (`$NAME` stays as written and `\$` keeps its backslash). Rule: write a literal `$` as
  `\$` in `PAYLOAD_SECRET` and the `SEED_ADMIN_*` values, which only Next and the Payload CLI
  read; keep `$` out of `DATABASE_URL` and the `S3_*` values, which both kinds read. A value set
  in the process environment wins over the file, but Next, the Payload CLI and the smoke still
  expand it (and turn `\$` into `$`) when a loaded `.env` file also defines that name; with no
  `.env` (CI, the images) nothing is expanded. `docker run --env-file` reads values literally (no
  `\$` unescape, no quote stripping): write a literal `$` there as is.
- **`payload run` (the seed) has quirks.** It always exits 0, whatever the script did; it drops
  `--flags` given after the script; it loads `.env` from its working directory (searching
  upward), not from the script's folder; a blank variable counts as unset. Rule: run
  `npm run seed` from the repo root and pass inputs as environment variables. The seed sets its
  own exit code (`process.exit`) and catches its own errors for this reason.
- **The Postgres adapter creates a missing database.** When the database in `DATABASE_URL` does
  not exist, `@payloadcms/db-postgres` creates it (unless `disableCreateDatabase` is set), so a
  misspelled name gives a new, empty database instead of an error. Rule: check the name when the
  admin looks empty; consider `disableCreateDatabase: true` on a server.

## Dev server (`next dev`)

- **`next dev` pushes the schema into whatever `DATABASE_URL` names.** Dev mode writes the schema
  without migrations and records a `dev` row in `payload_migrations`; a later `payload migrate`
  on that database prompts (see Migrations). Rule: point `next dev` (and the smoke without
  `--url`) only at the dev database, never at a server database, a database the image migrated,
  or a test database.
- **One `next dev` per directory.** Next 16.4 holds a lock in `.next/dev`; a second `next dev` in
  the same checkout fails. Rule: with a dev server running, use
  `npm run smoke -- --url <its address>`.
- **Stopping `next dev` on Windows.** Killing the shell that started it can leave the process tree
  running, still holding the port with its old environment. Rule: stop the whole tree
  (`taskkill /F /T /PID <pid>`) and check the port is free (`netstat -ano`) before the next start.
- **Types regenerate only under `next dev`** (`typescript.autoGenerate`). Rule: after a schema
  change without `next dev`, run `npm run generate:types`. The smoke without `--url` runs
  `next dev`, so check `git status` after it.
- **A stale `.next/types` fails `typecheck`.** `tsconfig.json` includes `.next/types` and
  `.next/dev/types`; after a route is removed or renamed, the old generated files point at
  missing modules. Rule: run `npm run build` (which regenerates them) or delete `.next`.

## Migrations

- **drizzle-kit's generated `down()` fails for every new collection.** It drops the new table
  `CASCADE` first, which already removes the `payload_locked_documents_rels_<slug>_fk`
  constraint, then drops that constraint again: "constraint … does not exist", and every rollback
  exits 1. Rule: after `migrate:create`, hand-edit `down()` only (keep `up()` and the `.json` as
  generated): run the `payload_locked_documents_rels` statements first, inside a `DO` block guarded
  by `to_regclass('payload_locked_documents_rels') IS NOT NULL`, as in
  `src/migrations/20261009_001903_products.ts`. The test setup fails at step 2 or 4 while a
  `down()` is wrong.
- **`migrate:reset` runs the `down()`s oldest first** in Payload 3.90.2 (`migrate:down` runs
  newest first). A `down()` that touches a table an older migration created finds it already
  dropped during a reset. Rule: guard such statements (as above). The products `down()` drops the
  `_locales` enum: once a later localized collection uses that enum, the drop fails during a reset
  (the setup's step 4 reports it) and needs the same kind of fix.
- **Never `payload migrate:refresh`.** In 3.90.2 it calls each `up()` without `db`, so every
  generated migration throws. Rule: `migrate:down` (or `migrate:reset`), then `migrate`.
- **Never `payload migrate` on a database `next dev` touched.** It asks "data loss will occur…
  (y/N)". Without a TTY the `migrate` image waits until it is killed (the test setup gives its
  steps no stdin and a timeout); with a TTY, answering N exits 0 without migrating. Rule: migrate only databases that only ever saw
  migrations, give a one-shot a timeout, and afterwards check `payload_migrations`
  (`npm run payload -- migrate:status`) instead of trusting the exit code.
- **Plugins add columns: storage-s3's hidden `_objectKey`.** `@payloadcms/storage-s3` adds a
  hidden `_objectKey` field to the upload collections it handles. A migration written without it
  leaves every `media` read failing with `column "_objectkey" does not exist`, and `next dev`'s
  push hides the gap by adding the column silently. Rule: create migrations with
  `payload migrate:create` from the full config, plugins included; never copy one from elsewhere.
- **What the drift test cannot see.** `tests/int/migrations.int.spec.ts` compares the config with
  the newest `.json` snapshot and with the migrated database's columns, but it trusts each `.json`
  to match its `.ts` `up()` (a hand edit to `up()` passes), and an enum rename through `enumName`
  could still open drizzle-kit's interactive rename prompt. Column renames fail fast. Rule: never
  hand-edit `up()`; regenerate instead.
- **Rolling back `products` leaves lock rows.** `payload_locked_documents_rels` rows that pointed
  at a product stay, with every relation null.

## Tests

- **Never a fixed-name test database.** A setup that drops a shared test database kills every
  other run's connections to it. Rule: each run creates its own `pandora_cms_test_<hex>` and
  `pandora-cms-test-<hex>`; never point tests at `pandora_cms` or `pandora-cms-media` (the guard in
  `tests/int/throwaway.ts` refuses).
- **Payload reads its env when the config is first imported.** Rule: put a test run's env in
  place in the globalSetup (`provide`, applied by `vitest.setup.ts`) or the process environment,
  never in `beforeAll`.
- **Payload in the test process blocks the teardown.** The Postgres adapter's `destroy()` leaves a
  pool connection checked out, so `DROP DATABASE … WITH (FORCE)` in the teardown kills it and
  crashes Vitest. Rule: run migrations and the seed as child processes (as the setup and the seed
  test do).
- **A hard-killed run leaves its database and bucket behind.** There is no sweep. Rule: when no
  test run is in progress, list them with
  `docker compose exec -T postgres psql -U postgres -At -c "select datname from pg_database where datname like 'pandora\_cms\_test\_%'"`,
  drop each with `DROP DATABASE "<name>" WITH (FORCE)`, and delete the `pandora-cms-test-*`
  buckets in the MinIO console (http://127.0.0.1:9101).
- **Slow on a loaded host.** The five migrate steps take about 8 s each on an idle machine and
  minutes under load. Rule: raise `INT_MIGRATE_TIMEOUT_MS` (default 480000, at most 2147483647)
  rather than editing the setup.
- **The media test reads the object with a raw S3 `GetObject`,** not through Payload's
  `/api/media/file/<filename>` route. Rule: a change to how files are served needs its own check
  through that route.

## Admin, seed and smoke

- **Five failed logins lock the user for 10 minutes** (Payload's defaults). Smoke runs with a
  wrong password count. Rule: fix `SEED_ADMIN_PASSWORD` before retrying; locally, unlock early
  with `UPDATE users SET login_attempts = 0, lock_until = NULL WHERE email = '<email>'`.
- **The seed never changes an existing user.** After the first seed, changing
  `SEED_ADMIN_PASSWORD` does not change the stored password, so the smoke gets 401. Rule: change
  the password in the admin, or delete the local user and seed again.
- **`smoke --url` makes one attempt per check.** Against a server that is still starting, it
  fails. Rule: wait for `GET /admin` to answer 200 first.
- **Open first-user registration.** On an empty `users` table, whoever reaches `/admin` first
  creates the first admin. Rule: seed before a fresh database is reachable.
- **`process.exit()` right after `fetch`** aborts Node 24 on Windows with
  `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (exit code 127) when the server keeps
  the connection alive (`next start`, the image). Rule: set `process.exitCode` and let the process
  end on its own, as the smoke does.

## Production image (`Dockerfile`)

- **Sizes** (`docker image inspect`, 2026-10-09): the app image (`docker build .`) is about
  243 MB (`node:24-alpine` is 171 MB of it; the standalone server and its traced files about
  72 MB). The migrate image (`--target migrate`: full `node_modules` + source) is about 1.1 GB.
- **The app build needs about 3 GB of memory.** `next build` (Turbopack) compiling the Payload
  admin peaked near 3 GB on a dev machine. In a Docker VM with 2 GB it dies during "Creating an
  optimized production build" with `ResourceExhausted … cannot allocate memory`. Give Docker at
  least 4 GB (Docker Desktop: Settings → Resources), or build the image in CI. The migrate target
  does not run `next build`, so it builds on a small VM too.
- **`migrate` comes from the `source` stage, not the builder.** The builder carries about 146 MB
  of build cache and 37 MB of source maps, and needs the 3 GB build. Rule: keep `migrate` on
  `source` (full dependencies + source), which is all `payload migrate` needs.
- **Build-time env.** `next build` loads the Payload config, and `src/env.ts` refuses to load it
  without the six server variables. The Dockerfile sets obviously fake values for that one `RUN`
  only (`build-only…`, nothing connects at build time); no image carries them in its
  environment. Pass all six with `-e` (or an env file kept off the image; `--env-file` values are
  literal, see Environment) when running either image.
- **Keep file reads out of the config's imports.** Turbopack cannot resolve `readFileSync(file)`
  with a variable path, so it traced the whole project directory, `.env` included, into every
  route that imports the config, and from there into `.next/standalone`. That is why
  `loadDotEnvFile` lives in `src/env-file.ts`, which only scripts and the test setup import.
  Nothing enforces this; check `.next/standalone` after touching the config's imports.
- **Next copies `.env*` files into `.next/standalone`** (every env file the build loaded), so a
  host build on a machine with a `.env` has the dev `.env` in `.next/standalone/.env`. Never ship
  a standalone folder built on a machine that has a `.env`. The image is safe because
  `.dockerignore` keeps every `.env*` file out of the build context.
- **`next start` is not the production entry.** With `output: 'standalone'`, `next start` warns.
  Rule: run `node server.js` inside `.next/standalone`, with `.next/static` copied to
  `.next/standalone/.next/static` (as the Dockerfile does), or run the image.
- **The migrate container hangs on a database that `next dev` touched** (Migrations: the y/N
  prompt; the container has no TTY). Rule: run it only against databases that only ever saw
  migrations, give the one-shot a timeout, then check `payload_migrations`. It exits 1 on a
  failed migration, a missing variable or an unreachable database.
- **A hung migrate container takes the full `docker stop` grace** (10 s): PID 1 is `node`, which
  has no SIGTERM handler. Rule: `docker rm -f` a hung one-shot.
- **Liveness is `GET /admin`.** `HEAD` requests to `/api/*` answer 404, and a port check passes a
  container whose app is broken. There is no `HEALTHCHECK` in the image yet. Rule: health checks
  send `GET /admin` and expect 200.
- **Next's per-build keys ship in the image.** The Server Actions encryption key and the preview
  keys are generated by each `next build` and baked into `.next`. Rule: every instance runs the
  same image, or set `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`.
- **`node:24-alpine` floats.** A rebuild can pick up a newer Node 24 or Alpine. Rule: pin the
  digest before deploying (Phase 5).
- **npm 11.19 in the base image warns about install scripts** not covered by `allowScripts`
  (esbuild and unrs-resolver postinstalls). Harmless today; npm 12 may block them. Rule: review
  them with `npm install-scripts ls` when the base image moves to npm 12.
- **sharp on Alpine.** The lockfile lists sharp's binary packages for every platform, `linuxmusl`
  included, and the standalone trace includes `@img/sharp-linuxmusl-x64` and
  `@img/sharp-libvips-linuxmusl-x64`, so image processing works in the app image without
  `libc6-compat`. The glibc binaries (about 18 MB) ride along unused.
- **Headers and telemetry.** `poweredByHeader: false` in `next.config.ts` also stops `withPayload`
  from adding its own `X-Powered-By: Next.js, Payload` header. Payload telemetry is off in the
  config, and Next telemetry is off in the images (`NEXT_TELEMETRY_DISABLED=1`).
- **The app image writes nothing to disk.** Its files are owned by root; the `node` user can write
  only `.next/cache`. Uploads go to S3 (MinIO) from memory.
