#!/usr/bin/env bash
# i-kit 一键部署脚本（Linux / macOS）
# 用法：./scripts/deploy.sh            # 安装依赖 + 构建 + 启动
#       ./scripts/deploy.sh --skip-install
set -e
cd "$(dirname "$0")/.."

echo ""
echo "=== i-kit 一键部署 ==="
echo ""

if [[ "$1" != "--skip-install" ]]; then
    echo "[1/3] 安装依赖..."
    pnpm install
fi

echo "[2/3] 构建前端..."
pnpm --filter @ikit/web build

echo "[3/3] 启动服务（生产模式）..."
echo ""
echo "  ✅ 部署完成，访问: http://localhost:3000"
echo ""

pnpm --filter @ikit/server start
