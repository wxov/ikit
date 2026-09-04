# i-kit one-click server update (Windows PowerShell)
# Flow: git push -> server git pull -> docker compose rebuild
# Usage:
#   ./scripts/update-server.ps1 -Server ubuntu@你的服务器IP -Key 私钥路径
# 或先复制私钥到标准位置 ~/.ssh/id_rsa，只传 Server：
#   ./scripts/update-server.ps1 -Server ubuntu@你的服务器IP
param(
    [string]$Key = "",
    [string]$Server = "",
    [string]$RemoteDir = "/home/ubuntu"
)

$ErrorActionPreference = 'Stop'

if (-not $Key) { $Key = Join-Path $env:USERPROFILE ".ssh\id_rsa" }
if (-not $Server) { throw "请指定服务器：-Server ubuntu@你的服务器IP" }
if (-not (Test-Path $Key)) { throw "私钥不存在：$Key" }

Write-Host ""
Write-Host "=== i-kit server update ===" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1/3] Pushing code to git..." -ForegroundColor Yellow
git push
if ($LASTEXITCODE -ne 0) { throw "git push failed" }

Write-Host "[2/3] Pulling code on server..." -ForegroundColor Yellow
ssh -i $Key -o StrictHostKeyChecking=no $Server "cd $RemoteDir && git pull origin master"
if ($LASTEXITCODE -ne 0) { throw "git pull on server failed" }

Write-Host "[3/3] Rebuilding and restarting..." -ForegroundColor Yellow
ssh -i $Key -o StrictHostKeyChecking=no $Server "cd $RemoteDir && sudo docker compose up -d --build"
if ($LASTEXITCODE -ne 0) { throw "docker rebuild failed" }

Write-Host "[4/4] Syncing update artifacts (installers/bundles) into container..." -ForegroundColor Yellow
# update/ 目录被 git 忽略，需在每次重建后把宿主机上的发布产物（安装包等）并入容器静态目录
ssh -i $Key -o StrictHostKeyChecking=no $Server "cd $RemoteDir && sudo docker cp -a ./update/. ikit:/app/update/ 2>/dev/null || echo '  (no update dir on server, skip)'"
if ($LASTEXITCODE -ne 0) { Write-Host "  [WARN] update artifact sync failed, continue" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  [OK] Update done." -ForegroundColor Green
Write-Host ""
