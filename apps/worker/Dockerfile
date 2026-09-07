# T-2302 (Feature 23): apps/worker container image. Build context is the
# repo root (pnpm workspace) — build with:
#   docker build -f apps/worker/Dockerfile -t agent-market-worker .
FROM node:22-alpine AS build
WORKDIR /repo
# See apps/api/Dockerfile's identical comment — `pnpm install` installs the
# whole workspace regardless of --filter, so the same optional
# node-gyp-rebuild dependency (ws's bufferutil/utf-8-validate) is hit here
# too.
RUN apk add --no-cache python3 make g++
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agent-market/worker... build
RUN pnpm --filter @agent-market/worker --prod deploy /out

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out .
EXPOSE 9090
# apps/worker is a pure queue consumer with no other HTTP surface — T-2302
# adds health-server.ts's minimal GET /health, started only once
# `queue.subscribe` succeeds (see main.ts), so this genuinely distinguishes
# "consuming" from "crashed on startup".
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||9090)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
