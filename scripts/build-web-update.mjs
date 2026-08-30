// 热更新打包脚本（在 apps/web 构建之后运行）
// 1) 在 dist 下生成 web-manifest.json（供 /api/update/manifest 读取）
// 2) 将 dist 复制为根部 update/<version>/<files>（供 /update/<version>/** 静态托管）
// 3) 打包 update/<version>/web-update-<version>.zip（供客户端下载替换 web 资源）
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const distDir = path.resolve(root, 'apps/web/dist')
const webPkg = JSON.parse(readFileSync(path.resolve(root, 'apps/web/package.json'), 'utf-8'))
const version = webPkg.version ?? '0.0.0'

if (!existsSync(path.join(distDir, 'index.html'))) {
  console.error('[update] dist not found, run `pnpm --filter @ikit/web build` first')
  process.exit(1)
}

// 1) manifest
const manifest = {
  version,
  buildTime: new Date().toISOString(),
  bundle: `web-update-${version}.zip`,
}
writeFileSync(path.join(distDir, 'web-manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`[update] wrote dist/web-manifest.json (version=${version})`)

// 2) 复制 dist 到 update/<version>/（静态托管目录，文件直接可访问）
const updateDir = path.resolve(root, 'update', version)
rmSync(updateDir, { recursive: true, force: true })
mkdirSync(path.join(updateDir, 'files'), { recursive: true })
cpSync(distDir, path.join(updateDir, 'files'), { recursive: true })
console.log(`[update] copied dist -> update/${version}/files`)

// 3) zip（含根级 index.html 与 assets/** ）
const zip = new AdmZip()
cpSync(distDir, path.join(updateDir, 'files'), { recursive: true })
zip.addLocalFolder(distDir, '')
const zipPath = path.join(updateDir, manifest.bundle)
zip.writeZip(zipPath)
console.log(`[update] wrote ${path.relative(root, zipPath)}`)
