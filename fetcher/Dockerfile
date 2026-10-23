# Build a partir da raiz do repositório: docker build -f fetcher/Dockerfile .
# TODO antes do lançamento: fixar a imagem base pelo digest.
# Implantação: ver docs/fetcher.md. NUNCA com invocação não autenticada.

FROM node:24-slim AS check
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY api/package.json api/
COPY web/package.json web/
COPY fetcher/package.json fetcher/
RUN npm ci --ignore-scripts
COPY tsconfig.base.json eslint.config.js ./
COPY fetcher/ fetcher/
# Só tipos: o .dockerignore remove *.test.ts e testing.ts, então os testes rodam no job "check" do CI.
RUN npm run typecheck --workspace fetcher

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY api/package.json api/
COPY web/package.json web/
COPY fetcher/package.json fetcher/
RUN npm ci --omit=dev --workspace fetcher --ignore-scripts

FROM node:24-slim AS runtime
ENV NODE_ENV=production
# O DNS usa c-ares (fora do threadpool), mas zlib e crypto ainda usam o threadpool do libuv
# (padrão: 4 threads). Mitigação adicional para o achado 4 da revisão; ver docs/fetcher.md.
ENV UV_THREADPOOL_SIZE=16
WORKDIR /app/fetcher
COPY --from=deps --chown=node:node /app/node_modules /app/node_modules
COPY --chown=node:node fetcher/package.json ./
COPY --chown=node:node fetcher/src ./src
# Força a etapa "check" a rodar (BuildKit pula etapas que ninguém consome).
COPY --from=check /app/package.json /tmp/.check-passed
USER node
# O Cloud Run define PORT; FETCHER_AUDIENCE e API_SERVICE_ACCOUNT_EMAIL são obrigatórias.
CMD ["node", "src/main.ts"]
