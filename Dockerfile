# syntax=docker/dockerfile:1

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Reuse the installed tree instead of installing twice.
FROM deps AS prod-deps
RUN npm prune --omit=dev

FROM deps AS build
COPY . .
RUN npm run build

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist/web ./dist/web
# A new named volume copies this ownership, so the node user can write the database.
# margin-user manages accounts: docker compose exec margin margin-user --help
RUN mkdir -p /data && chown node:node /data \
  && printf '#!/bin/sh\nexec node /app/server/cli.ts "$@"\n' > /usr/local/bin/margin-user \
  && chmod 755 /usr/local/bin/margin-user
USER node
EXPOSE 5555
CMD ["node", "server/index.ts"]
