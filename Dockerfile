FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 UPLOAD_DIR=/app/data/uploads WEB_DIR=/app/apps/web/public
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data
EXPOSE 8787
USER node
WORKDIR /app/apps/api
CMD ["node_modules/.bin/tsx", "src/main.ts"]
