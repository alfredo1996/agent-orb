# Build from the repo root with BuildKit (the default since Docker 23; the legacy builder has no $BUILDPLATFORM): docker build -f packages/server/Dockerfile .
# The base image is pinned by digest: it updates by bumping this digest (`docker buildx imagetools inspect node:22-alpine`); Dependabot (`.github/dependabot.yml`, docker ecosystem) proposes the bump as a PR into dev.
# The studio and deps stages run on the build machine's platform ($BUILDPLATFORM), so a multi-arch build never runs Node under QEMU:
# the release run's arm64 `pnpm install` crashed there with an illegal instruction and hung (#100). The final stage only copies their output.
FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS studio
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/studio/package.json packages/studio/
RUN pnpm install --frozen-lockfile --filter @agent-orb/studio...
COPY tsconfig.json ./
COPY packages/studio packages/studio
RUN pnpm --filter @agent-orb/studio build

# ponytail: installing on the build platform holds while the server's production dependencies are pure JavaScript.
# A dependency with a native addon would land here built for the wrong architecture: its install then moves back into the final stage.
FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --prod --filter @agent-orb/server...

FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202
WORKDIR /app
COPY --from=deps /app ./
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
