#!/usr/bin/env bash
# i-kit 服务器一键部署（Docker）
# 用法：./scripts/deploy-server.sh
set -e
cd "$(dirname "$0")/.."

echo ""
echo "=== i-kit 服务器部署（Docker）==="
echo ""

if ! command -v docker &> /dev/null; then
    echo "[错误] 未安装 Docker，请先安装：https://docs.docker.com/engine/install/"
    exit 1
fi

# 从 .env 读取配置（如果存在），传递给 docker compose
if [ -f .env ]; then
    echo "[提示] 检测到 .env，将读取其中的配置"
fi

echo "[1/2] 构建镜像..."
docker compose build

echo "[2/2] 启动服务..."
docker compose up -d

echo ""
echo "  [OK] 部署完成"
echo ""
echo "  访问：http://<服务器IP>:3000"
echo "  状态：docker compose ps"
echo "  日志：docker compose logs -f ikit"
echo "  停止：docker compose down"
echo "  更新：git pull && ./scripts/deploy-server.sh"
