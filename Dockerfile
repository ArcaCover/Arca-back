# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/scoring/package.json packages/scoring/package.json
COPY apps/api/package.json apps/api/package.json
RUN --mount=type=cache,target=/root/.npm npm ci

COPY packages/contracts/src packages/contracts/src
COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.json
COPY packages/scoring/src packages/scoring/src
COPY packages/scoring/tsconfig.json packages/scoring/tsconfig.json
COPY apps/api/src apps/api/src
COPY apps/api/tsconfig.json apps/api/tsconfig.json
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime

LABEL org.opencontainers.image.source="https://github.com/ArcaCover/Arca-back"
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.revision=$VCS_REF org.opencontainers.image.created=$BUILD_DATE

ENV NODE_ENV=production \
    PORT=8080 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOME=/tmp
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/scoring/package.json ./packages/scoring/package.json
COPY --from=build /app/packages/scoring/dist ./packages/scoring/dist
# The deployment payload travels with the image it deploys: the host extracts it at deploy time,
# so a rollback also restores that commit's compose file, Caddyfile and configuration.
COPY compose.yaml deploy/Caddyfile deploy/production.env deploy/activate.sh deploy/render-env.py ./deploy-payload/

RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init \
  && npx --no-install playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* /root/.cache \
  && chown -R node:node /ms-playwright /app

USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/server.js"]
