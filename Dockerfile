# Pinned by digest so a build is reproducible and a scanned image is the image that ships; Dependabot proposes updates.
FROM node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# The public page's canonical address, sitemap and social card name the live site. Render passes a service's
# settings to the build as arguments; without either, the build names https://www.vantageusmc.com.
ARG VANTAGE_SITE_URL
ARG VANTAGE_PUBLIC_URL
RUN npm run build && npm prune --omit=dev

FROM node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2
ENV NODE_ENV=production PORT=8787 VANTAGE_DB=/data/vantage.db
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data && chown -R node:node /data /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node NOTICE PROVENANCE.json ./
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server/index.ts"]
