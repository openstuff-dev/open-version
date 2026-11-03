# One image with the API, the worker, the web app and the browser package (served at /sdk/).
FROM node:24-alpine AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/version/package.json packages/version/
COPY packages/contracts/package.json packages/contracts/

# @openstuff-dev/version (decide, semver, the client and <ov-update>) and the contracts that
# re-export it, built once for both apps.
FROM manifests AS packages
RUN npm ci -w packages/version -w packages/contracts
COPY packages/ packages/
RUN npm run build -w packages/version && npm run build -w packages/contracts

FROM packages AS web
RUN npm ci -w apps/web -w packages/version -w packages/contracts
COPY apps/web/ apps/web/
RUN npm run tokens -w apps/web && npm run build -w apps/web

FROM packages AS server
RUN npm ci -w apps/server -w packages/version -w packages/contracts
COPY apps/server/ apps/server/
RUN npm run build -w apps/server

FROM manifests AS server-deps
RUN npm ci -w apps/server --omit=dev && mkdir -p apps/server/node_modules

FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_DIR=/app/web
WORKDIR /app/apps/server
COPY --from=server-deps /app/node_modules /app/node_modules
# Anything npm had to nest under the server instead of hoisting (usually empty).
COPY --from=server-deps /app/apps/server/node_modules ./node_modules
# node_modules/@openstuff-dev/version and @open-version/contracts link here: the server decides
# with them, and serves the browser package at /sdk/.
COPY --from=packages /app/packages/version/package.json /app/packages/version/
COPY --from=packages /app/packages/version/dist /app/packages/version/dist
COPY --from=packages /app/packages/contracts/package.json /app/packages/contracts/
COPY --from=packages /app/packages/contracts/dist /app/packages/contracts/dist
COPY --from=server /app/apps/server/dist ./dist
COPY --from=server /app/apps/server/migrations ./migrations
COPY --from=server /app/apps/server/package.json ./
COPY --from=web /app/apps/web/dist/web/browser /app/web
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "dist/index.js"]
