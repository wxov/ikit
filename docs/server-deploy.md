# 服务器一键部署

使用 Docker 将 i-kit 部署到服务器（VPS / 云服务器），一键构建 + 启动 + 守护。

## 方案

- **Docker 多阶段构建**：构建前端 dist + 打包运行时依赖
- **docker-compose**：服务编排、数据卷持久化、`restart: unless-stopped` 崩溃自动重启、健康检查
- **数据**：SQLite / JSON 数据 + **上传文件（`data/uploads`，封面图等）** 持久化到 Docker 数据卷（`ikit-data`）

## 前提条件

服务器已安装 Docker 与 Docker Compose 插件：

```bash
# 官方一键安装
curl -fsSL https://get.docker.com | sh
```

## 部署步骤

### 1. 上传项目到服务器

```bash
# 方式一：git 克隆
git clone <你的仓库地址> i-kit && cd i-kit

# 方式二：直接上传（rsync / scp）
```

### 2. 配置环境变量

在项目根创建 `.env`（复制 `.env.example`）：

```bash
cp .env.example .env
vim .env   # 填入 LLM_API_KEY 等
```

### 3. 一键部署

```bash
./scripts/deploy-server.sh
# 或手动：
docker compose up -d --build
```

部署完成后访问 `http://<服务器IP>`（默认 80 端口，`docker-compose.yml` 映射 `80:3000`）。

## 常用命令

```bash
docker compose ps                 # 查看状态
docker compose logs -f ikit      # 实时日志
docker compose restart ikit      # 重启
docker compose down              # 停止（数据卷保留）
docker compose down -v           # 停止并删除数据卷（慎用）
```

## 更新部署

```bash
git pull
docker compose up -d --build
```

## 反向代理 + HTTPS（推荐）

生产环境建议用 Caddy（自动 HTTPS）或 Nginx 反代。

### Caddy（推荐，自动 HTTPS）

`/etc/caddy/Caddyfile`：

```
你的域名.com {
    reverse_proxy localhost:80
}
```

```bash
systemctl reload caddy
```

### Nginx

`/etc/nginx/sites-available/ikit`：

```nginx
server {
    listen 80;
    server_name 你的域名.com;

    location / {
        proxy_pass http://127.0.0.1:80;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 600s;
    }
}
```

> WebSocket（`/ws`）与 SSE 流式（`/api/agent/chat-stream`）依赖上述 `Upgrade` 头与较长的 `proxy_read_timeout`，已包含在配置中。

## 常见问题

**端口被占用？** 修改 `docker-compose.yml` 的 `ports` 映射（如 `8080:3000`）。

**数据备份？** 数据卷在 `/app/packages/server/data`，可执行：

```bash
docker run --rm -v ikit-data:/data -v $PWD:/backup alpine tar czf /backup/ikit-data.tar.gz -C /data .
```
