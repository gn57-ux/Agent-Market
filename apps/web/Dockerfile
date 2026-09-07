# T-2302 (Feature 23): apps/web container image — a static build served by
# nginx (not a Node runtime; Vite's output is pure static assets). Build
# context is the repo root (pnpm workspace).
#
# N4 real finding (round 1, T-2302, P1): Vite embeds `import.meta.env.VITE_*`
# values INTO the built JS at build time (not read at container start) — a
# static image with no build-time config mechanism would ship with every
# VITE_* value undefined (chain addresses, Privy app ID), breaking
# wallet/auth in production. Vite's own env resolution gives already-set
# `process.env` values priority over `.env` files for `VITE_`-prefixed
# names, so declaring them as build ARGs (which we then export into the
# build stage's env) is the real, working injection point — not a config
# file baked into the image, and not something a container-start env var
# could ever retroactively fix once the JS bundle already exists. Build
# with the real production values, e.g.:
#   docker build -f apps/web/Dockerfile \
#     --build-arg VITE_API_BASE_URL=https://api.example.com \
#     --build-arg VITE_CHAIN_ID=1 \
#     --build-arg VITE_TASK_ESCROW_ADDRESS=0x... \
#     --build-arg VITE_YD_TOKEN_ADDRESS=0x... \
#     --build-arg VITE_YD_FAUCET_ADDRESS=0x... \
#     --build-arg VITE_WALLET_RPC_URL=https://... \
#     --build-arg VITE_AUTH_DOMAIN=example.com \
#     --build-arg VITE_PRIVY_APP_ID=... \
#     -t agent-market-web .
FROM node:22-alpine AS build
ARG VITE_API_BASE_URL
ARG VITE_CHAIN_ID
ARG VITE_TASK_ESCROW_ADDRESS
ARG VITE_YD_TOKEN_ADDRESS
ARG VITE_YD_FAUCET_ADDRESS
ARG VITE_WALLET_RPC_URL
ARG VITE_AUTH_DOMAIN
ARG VITE_PRIVY_APP_ID
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_CHAIN_ID=${VITE_CHAIN_ID} \
    VITE_TASK_ESCROW_ADDRESS=${VITE_TASK_ESCROW_ADDRESS} \
    VITE_YD_TOKEN_ADDRESS=${VITE_YD_TOKEN_ADDRESS} \
    VITE_YD_FAUCET_ADDRESS=${VITE_YD_FAUCET_ADDRESS} \
    VITE_WALLET_RPC_URL=${VITE_WALLET_RPC_URL} \
    VITE_AUTH_DOMAIN=${VITE_AUTH_DOMAIN} \
    VITE_PRIVY_APP_ID=${VITE_PRIVY_APP_ID}
WORKDIR /repo
# See apps/api/Dockerfile's identical comment.
RUN apk add --no-cache python3 make g++
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
# packages/domain is a real build-time dependency of apps/web too (shared
# domain types/components) — `...` builds it first, same convention as the
# Node-runtime services' Dockerfiles.
RUN pnpm --filter @agent-market/web... build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8080/healthz || exit 1
