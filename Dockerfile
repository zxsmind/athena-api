# Build stage. The local routing package lives inside server/ and is consumed as
# a file: dependency, so it must be built before the server that imports it.
FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY server/smart-routing-core ./server/smart-routing-core
RUN npm ci --prefix server/smart-routing-core && npm run build --prefix server/smart-routing-core

COPY server/package.json server/package-lock.json ./server/
RUN npm ci --prefix server

COPY server ./server
RUN npm run build --prefix server

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    ATHENA_DATA_DIR=/data

WORKDIR /app

# Only manifests and built output cross the stage boundary. A file: dependency
# is symlinked by npm, so the target directory must exist with the same layout.
COPY --from=build /app/server/smart-routing-core/package.json ./server/smart-routing-core/package.json
COPY --from=build /app/server/smart-routing-core/dist ./server/smart-routing-core/dist
COPY --from=build /app/server/package.json /app/server/package-lock.json ./server/
RUN npm ci --omit=dev --prefix server

COPY --from=build /app/server/dist ./server/dist
RUN mkdir -p /data && chown -R node:node /data /app/server

USER node
VOLUME ["/data"]
EXPOSE 39921

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:39921/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
