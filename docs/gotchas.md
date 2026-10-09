# Gotchas

Traps hit while building this repo, and how to avoid them.

## Production image (`Dockerfile`)

- **Sizes** (`docker image inspect`, 2026-10-09): the app image (`docker build .`) is about
  243 MB (`node:24-alpine` is 171 MB of it; the standalone server and its traced files about
  72 MB). The migrate image (`--target migrate`: full `node_modules` + source) is about 1.1 GB.
- **The app build needs about 3 GB of memory.** `next build` (Turbopack) compiling the Payload
  admin peaked near 3 GB on a dev machine. In a Docker VM with 2 GB it dies during "Creating an
  optimized production build" with `ResourceExhausted … cannot allocate memory`. Give Docker at
  least 4 GB (Docker Desktop: Settings → Resources), or build the image in CI. The migrate target
  does not run `next build`, so it builds on a small VM too.
- **Build-time env.** `next build` loads the Payload config, and `src/env.ts` refuses to load it
  without the six server variables. The Dockerfile sets obviously fake values for that one `RUN`
  only (`build-only…`, nothing connects at build time); no image carries them in its
  environment. Pass all six with `-e` (or an env file kept off the image) when running either image.
- **Keep file reads out of the config's imports.** Turbopack cannot resolve `readFileSync(file)`
  with a variable path, so it traced the whole project directory, `.env` included, into every
  route that imports the config, and from there into `.next/standalone`. That is why
  `loadDotEnvFile` lives in `src/env-file.ts`, which only scripts and the test setup import.
- **Next copies `.env*` files into `.next/standalone`** (every env file the build loaded). Never ship
  a standalone folder built on a machine that has a `.env`. The image is safe because
  `.dockerignore` keeps every `.env*` file out of the build context.
- **The migrate container hangs on a database that `next dev` touched.** Dev mode pushes the schema
  and records a `dev` migration; `payload migrate` then asks "data loss will occur… (y/N)" and,
  without a TTY, waits forever. Run it only against databases that only ever saw migrations, and
  give the one-shot a timeout. It exits 1 on a failed migration, a missing variable or an
  unreachable database.
- **sharp on Alpine.** The lockfile lists sharp's binary packages for every platform, `linuxmusl`
  included, and the standalone trace includes `@img/sharp-linuxmusl-x64` and `@img/sharp-libvips-linuxmusl-x64`, so
  image processing works in the app image without `libc6-compat`.
- **Headers and telemetry.** `poweredByHeader: false` in `next.config.ts` also stops `withPayload`
  from adding its own `X-Powered-By: Next.js, Payload` header. Payload telemetry is off in the
  config, and Next telemetry is off in the images (`NEXT_TELEMETRY_DISABLED=1`).
- **The app image writes nothing to disk.** Its files are owned by root; the `node` user can write
  only `.next/cache`. Uploads go to S3 (MinIO) from memory.

## Scripts on Windows

- **`process.exit()` right after `fetch`** aborts Node 24 on Windows with
  `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (exit code 127) when the server keeps
  the connection alive (`next start`, the image). The smoke sets `process.exitCode` and lets the
  process end on its own instead.
