# Build from the repo root: docker build -f packages/server/Dockerfile .
FROM node:22-alpine AS studio
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/studio/package.json packages/studio/
RUN pnpm install --frozen-lockfile --filter @agent-orb/studio...
COPY tsconfig.json ./
COPY packages/studio packages/studio
RUN pnpm --filter @agent-orb/studio build

FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --prod --filter @agent-orb/server...
COPY packages/shared/src packages/shared/src
COPY packages/server/src packages/server/src
COPY --from=studio /app/packages/studio/dist packages/studio/dist
# The server's two SQLite files (history.db and content.db) live on a volume here; the directory is the node user's so a fresh volume is writable.
RUN mkdir -p /var/lib/agent-orb && chown node:node /var/lib/agent-orb
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4040 CONTENT_DB=/var/lib/agent-orb/content.db
EXPOSE 4040
# Node 22 runs the TypeScript sources directly (type stripping); there is no build step.
# cli.ts: `serve` (the default) starts the server; `import <dir>` is the one-off history import (README, "Import your history").
ENTRYPOINT ["node", "packages/server/src/cli.ts"]
CMD ["serve"]
