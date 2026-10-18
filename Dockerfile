# Build stage: install everything, compile TypeScript to JavaScript.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm build

# Runtime stage: production dependencies only, compiled output only, no TypeScript loader.
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/migrations apps/api/migrations
COPY apps/web/public apps/web/public
# The AWS RDS certificate authorities, so a managed Postgres connection is verified, not just encrypted:
# DATABASE_URL=...?sslmode=verify-full&sslrootcert=/etc/ssl/certs/rds-global-bundle.pem (O10; RDS for PostgreSQL 15+
# refuses unencrypted connections). Harmless on other hosts.
# Pinned by checksum (taken 18 Oct 2026): when AWS rotates its CAs the build fails here; download the new bundle, check
# it, and update the checksum in the same commit.
ADD --chmod=644 --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
# Without DATABASE_URL the image falls back to embedded PGlite under /app/data, the only directory the node user may write.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 UPLOAD_DIR=/app/data/uploads PGLITE_DIR=/app/data/pglite WEB_DIR=/app/apps/web/public
RUN mkdir -p /app/data/uploads /app/data/pglite && chown -R node:node /app/data
EXPOSE 8787
USER node
WORKDIR /app/apps/api
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--conditions=production", "dist/main.js"]
