# Production images for the CMS, built from one Dockerfile:
#
#   docker build -t pandora-cms .                            the app: `node server.js` on port 3000
#   docker build --target migrate -t pandora-cms-migrate .   one-shot `payload migrate`, then exits
#
# Nothing secret is baked in. Both images take their settings at run time: DATABASE_URL,
# PAYLOAD_SECRET, S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY (see .env.example).
# .dockerignore keeps every .env* file out of the build context.
#
# Release order: run the migrate image against the database first (exit 0 = migrated or nothing to
# do), then start the app. The app never migrates on start.

# The same Node image for every stage.
FROM node:24-alpine AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# Dependencies from the lockfile, dev dependencies included: the build and the Payload CLI need them.
FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# Full dependencies + source: what the Next build and the migrate image start from.
FROM base AS source
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `next build` (standalone output). Needs about 3 GB of memory (see docs/gotchas.md).
FROM source AS builder
# src/env.ts checks the six server variables when the Payload config loads, and `next build` loads
# it, but the build connects to nothing. Obviously fake values are set for this RUN only: no ENV or
# ARG, so they never reach an image's environment. The real values are given at run time.
RUN DATABASE_URL=postgres://build-only:build-only@127.0.0.1:1/build-only \
    PAYLOAD_SECRET=build-only-not-a-secret \
    S3_ENDPOINT=http://127.0.0.1:1 \
    S3_BUCKET=build-only \
    S3_ACCESS_KEY_ID=build-only \
    S3_SECRET_ACCESS_KEY=build-only \
    npm run build

# One-shot migrations. `payload migrate` needs the Payload CLI, the TypeScript config and
# src/migrations, which the standalone output does not carry: full dependencies + source, without
# the Next build output. It applies the pending migrations and exits (non-zero when one fails).
# Only for databases that `next dev` never pushed a schema into: on those `payload migrate` waits
# for a y/N answer that never comes (give the container a timeout).
FROM source AS migrate
ENV NODE_ENV=production
USER node
CMD ["node", "node_modules/payload/bin.js", "migrate"]

# The app: Next's standalone server and the files it traced, nothing else.
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# The app files stay owned by root (read-only for the app user); only Next's cache is writable.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
RUN mkdir -p .next/cache && chown node:node .next/cache
USER node
EXPOSE 3000
CMD ["node", "server.js"]
