# ---- 构建阶段：安装依赖 + 构建前端 ----
FROM node:24-alpine AS build
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @ikit/web build
# 热更新：生成 dist/web-manifest.json + update/<version>/web-update-<version>.zip
RUN node scripts/build-web-update.mjs

# ---- 运行阶段：自安装（完整安装，保证 workspace 链接）----
FROM node:24-alpine AS runner
WORKDIR /app

COPY . .
RUN corepack enable && pnpm install --frozen-lockfile

# 复制构建好的前端产物
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/update ./update

ENV NODE_ENV=production
ENV WEB_DIST=/app/apps/web/dist
ENV KB_STORAGE=sqlite

EXPOSE 3000
CMD ["pnpm", "--filter", "@ikit/server", "start"]
