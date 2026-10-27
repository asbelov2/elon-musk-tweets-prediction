FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --include=dev --no-audit --no-fund
COPY . .
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    NODE_ENV=production npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production TWEETSCOPE_HOST=0.0.0.0 PORT=8000 TWEET_DB=/app/data/tweets.sqlite3
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/src ./dist/src
COPY --from=build --chown=node:node /app/dist/public ./dist/public
COPY --from=build --chown=node:node /app/dist/scripts/backup.js ./dist/scripts/backup.js
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/src/server/index.js"]
