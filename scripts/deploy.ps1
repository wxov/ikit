# i-kit one-click deploy script (Windows PowerShell)
# Usage: ./scripts/deploy.ps1            # install + build + start
#        ./scripts/deploy.ps1 -SkipInstall  # skip dependency install
param([switch]$SkipInstall)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host ""
Write-Host "=== i-kit one-click deploy ===" -ForegroundColor Cyan
Write-Host ""

if (-not $SkipInstall) {
    Write-Host "[1/3] Installing dependencies..." -ForegroundColor Yellow
    pnpm install
    if ($LASTEXITCODE -ne 0) { throw "dependency install failed" }
}

Write-Host "[2/3] Building frontend..." -ForegroundColor Yellow
pnpm --filter @ikit/web build
if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }

Write-Host "[3/3] Starting server (production mode)..." -ForegroundColor Yellow
Write-Host ""
Write-Host "  [OK] Deploy done. Open http://localhost:3000" -ForegroundColor Green
Write-Host "  Press Ctrl+C to stop"
Write-Host ""

pnpm --filter @ikit/server start
