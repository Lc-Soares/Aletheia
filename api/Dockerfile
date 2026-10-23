# Build a partir da raiz do repositório: docker build -f api/Dockerfile .
# TODO antes do lançamento: fixar a imagem base pelo digest.

FROM node:24-slim AS check
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY api/package.json api/
COPY web/package.json web/
COPY fetcher/package.json fetcher/
RUN npm ci --ignore-scripts
COPY tsconfig.base.json eslint.config.js ./
COPY api/ api/
RUN npm run typecheck --workspace api && npm run test --workspace api

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY api/package.json api/
COPY web/package.json web/
COPY fetcher/package.json fetcher/
RUN npm ci --omit=dev --workspace api --ignore-scripts

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/api
COPY --from=deps --chown=node:node /app/node_modules /app/node_modules
COPY --chown=node:node api/package.json ./
COPY --chown=node:node api/src ./src
# Força a etapa "check" a rodar (BuildKit pula etapas que ninguém consome).
COPY --from=check /app/package.json /tmp/.check-passed
USER node
# O Cloud Run define PORT; sem ele a API recusa subir.
CMD ["node", "src/main.ts"]
