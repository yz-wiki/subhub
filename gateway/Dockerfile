# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────
# SubHub — 多客户端订阅转换网关
# 构建上下文：仓库根目录
# ─────────────────────────────────────────────────────────────

# 前端构建阶段
FROM --platform=$BUILDPLATFORM node:22-alpine AS web

ENV NODE_OPTIONS=--max-old-space-size=1024

ARG NPM_REGISTRY=https://registry.npmjs.org

WORKDIR /app

COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm config set registry "$NPM_REGISTRY" \
 && npm config set fetch-retries 5 fetch-retry-mintimeout 10000 fetch-retry-maxtimeout 120000 \
 && npm ci --no-audit --no-fund

COPY web/ ./
RUN npm run build

# 运行时阶段：Node 零依赖网关 + 已构建前端
FROM node:22-alpine

LABEL org.opencontainers.image.title="SubHub" \
      org.opencontainers.image.description="Multi-client subscription converter gateway" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    CONFIG_DIR=/config

COPY gateway/server.js ./
COPY gateway/lib ./lib
COPY gateway/public ./public
COPY gateway/seed ./seed
COPY --from=web /app/dist ./web
COPY gateway/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN apk add --no-cache su-exec \
 && chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /config/rules /config/icons /config/templates /config/cache /config/state \
 && chown -R node:node /config /app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.js"]

