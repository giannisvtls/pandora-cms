# pandora-cms

Payload CMS 3 with Postgres, and media in MinIO through the S3 API. It holds the website's content
and serves the admin panel and the REST API; the static site renders every page.

## Requirements

- Node 24 (see `.nvmrc`) and its npm. Node 24 must run npm and be first on PATH: the pre-commit
  hook refuses older versions.
- Docker, for the local Postgres + MinIO stack in `docker-compose.yml` (host ports 5442, 9100 and
  9101 on 127.0.0.1).

## Quick start

```sh
cp .env.example .env         # then set PAYLOAD_SECRET and the SEED_ADMIN_* values
docker compose up -d         # Postgres on 5442, MinIO on 9100 (console on 9101)
npm ci
npm run create-bucket        # the media bucket named by S3_BUCKET
npm run dev                  # http://localhost:3000/admin
```

Open http://localhost:3000/admin once: in dev mode, Payload pushes the schema into the dev
database (`pandora_cms`) when it first loads. Then, in a second terminal, with the dev server
still up:

```sh
npm run seed                 # the admin user from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
npm run smoke -- --url http://localhost:3000   # /admin 200 and the admin login 200
```

With no dev server running, `npm run smoke` starts its own `next dev` on a free port, runs the
same checks and stops it. Like `npm run dev`, it pushes the schema into `DATABASE_URL`'s database,
so point it only at the dev database.

For a database that only ever gets migrations (a fresh one, a server), apply the committed
migrations instead of the dev push, before `npm run seed`:

```sh
npm run payload -- migrate   # never on a database `next dev` has touched: it prompts (docs/gotchas.md)
```

## Checks

`npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run test` (Local API tests on a
throwaway database and bucket; needs the local stack) and `npm run build`. CI runs the same, in
that order, then builds both Docker images.

## More

- `docs/AI_BRIEF.md`: stack and pins, local stack, commands, localization rules, tests, seed,
  smoke, the production image, CI and the Phase 5 server.
- `docs/gotchas.md`: traps already hit in this repo, each with its rule.
