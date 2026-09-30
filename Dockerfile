# node:24-alpine, pinned by digest (resolved 2026-09-29)
ARG NODE_IMAGE=node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

FROM ${NODE_IMAGE} AS deps
ENV CHECKPOINT_DISABLE=1
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-fund --no-audit

FROM deps AS build
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# One-shot job: applies committed migrations, then exits. The API process never runs DDL.
FROM deps AS migrate
COPY prisma ./prisma
COPY prisma.config.ts ./
USER node
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

# The Prisma CLI and TypeScript are optional peers of @prisma/client (dev-optional in the lockfile); omitting
# optional packages keeps them out of the runtime image.
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --omit=optional --no-fund --no-audit

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Files stay root-owned: the unprivileged runtime user can read but not modify the application.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health/ready >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]
