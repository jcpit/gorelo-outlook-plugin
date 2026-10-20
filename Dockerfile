FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html manifest.xml tsconfig.json vite.config.ts ./
COPY public ./public
COPY scripts ./scripts
COPY src ./src
COPY server ./server

RUN npm run build \
    && npx esbuild server/index.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=esm \
      --packages=external \
      --outfile=server-dist/index.js

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=5173 \
    STATIC_DIR=/app/dist

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.md ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server-dist ./server-dist
COPY --chown=node:node server/container-entry.mjs ./server-dist/container-entry.mjs

USER node

EXPOSE 5173

CMD ["node", "server-dist/container-entry.mjs"]
