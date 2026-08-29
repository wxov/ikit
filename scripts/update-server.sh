#!/usr/bin/env bash
# i-kit one-click server update (Linux / macOS)
# Flow: git push -> server git pull -> docker compose rebuild
# Usage:
#   SERVER=ubuntu@你的服务器IP ./scripts/update-server.sh
#   KEY=/path/to/key SERVER=ubuntu@IP ./scripts/update-server.sh
set -e

KEY="${KEY:-$HOME/.ssh/id_rsa}"
SERVER="${SERVER:-}"
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu}"

if [ -z "$SERVER" ]; then
    echo "请指定服务器：SERVER=ubuntu@你的服务器IP ./scripts/update-server.sh"
    exit 1
fi

echo ""
echo "=== i-kit server update ==="
echo ""

echo "[1/3] Pushing code to git..."
git push

echo "[2/3] Pulling code on server..."
ssh -i "$KEY" -o StrictHostKeyChecking=no "$SERVER" "cd $REMOTE_DIR && git pull origin master"

echo "[3/3] Rebuilding and restarting..."
ssh -i "$KEY" -o StrictHostKeyChecking=no "$SERVER" "cd $REMOTE_DIR && sudo docker compose up -d --build"

echo ""
echo "  [OK] Update done."
echo ""
