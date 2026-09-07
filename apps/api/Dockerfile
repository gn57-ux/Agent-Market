# T-2302 (Feature 23): apps/api container image. Build context is the repo
# root (pnpm workspace) — build with:
#   docker build -f apps/api/Dockerfile -t agent-market-api .
FROM node:22-alpine AS build
WORKDIR /repo
# python3/make/g++: some transitive deps (e.g. `ws`'s optional
# bufferutil/utf-8-validate native addons) attempt a node-gyp rebuild during
# `pnpm install` even though they're optional at runtime — alpine's base
# image has none of node-gyp's toolchain requirements by default.
RUN apk add --no-cache python3 make g++
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
# `...` pulls in this package's workspace dependencies (@agent-market/domain)
# in topological build order, matching scripts/local-env/start.mjs's own
# `pnpm --filter @agent-market/api build` convention.
RUN pnpm --filter @agent-market/api... build
# `pnpm deploy` (not `cp`/`tar`) produces a self-contained directory with a
# pruned, production-only node_modules — including workspace deps resolved
# to real files, not symlinks a plain COPY out of /repo would leave dangling.
RUN pnpm --filter @agent-market/api --prod deploy /out

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out .
EXPOSE 3001
# GET /health is app.ts's existing, unauthenticated liveness endpoint
# (T-2302 adds no new endpoint — reuses what already exists).
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
