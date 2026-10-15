# BranchHarbor API (Fastify) for Fly.io, Render or any container host.
# Build from the repository root:  docker build -f deploy/api.Dockerfile -t branchharbor-api .
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps/api/package.json ./apps/api/package.json
RUN pnpm install --frozen-lockfile --filter @bh/api...

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
COPY --from=deps /repo /repo
COPY apps/api ./apps/api
WORKDIR /repo/apps/api
EXPOSE 8080
# Apply pending migrations, then start. Migrations are idempotent and safe to run on every deploy.
CMD ["sh", "-c", "npx tsx src/db/migrate.ts && npx tsx src/server.ts"]
