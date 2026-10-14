// Sync the *required* subset of Vditor runtime assets into apps/web/public/vditor.
//
// Vditor loads its Lute engine, icons, i18n, KaTeX, highlight.js and content themes
// at runtime via <script>/<link> from `options.cdn`. Default cdn is unpkg.com, which is
// unavailable offline (Docker/intranet/Tauri/Capacitor) -> we self-host a minimal subset.
//
// Whitelist only: the full dist is ~23.6 MB (653 files); the subset below is what the
// editor actually requests (verified against vditor@4.0.0 dist/index.js `mergedOptions.cdn`
// usages). Optional heavy renderers (mermaid / echarts / mathjax / graphviz / abcjs /
// flowchart / plantuml / smiles-drawer / wavedrom / markmap) are intentionally NOT copied.
//
// Idempotent: existing files with an identical size are skipped. A version marker file is
// written so a vditor version bump forces a re-sync.
//
// Usage: node scripts/sync-vditor-assets.mjs [--check]
//   --check  report what would change, copy nothing, exit 1 when out of sync (CI friendly)
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, copyFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const webDir = path.join(repoRoot, 'apps', 'web')
const vditorDir = path.join(webDir, 'node_modules', 'vditor')
const distDir = path.join(vditorDir, 'dist')
// Vditor requests `${options.cdn}/dist/js/...` (with cdn = '/vditor'), so assets must land
// under public/vditor/dist/** to be served from /vditor/dist/**.
const outRoot = path.join(webDir, 'public', 'vditor')
const outDir = path.join(outRoot, 'dist')
const markerFile = path.join(outRoot, '.vditor-version')

const checkOnly = process.argv.includes('--check')

// Exact files (relative to vditor/dist)
const FILES = [
  // Markdown engine (3.7 MB) - REQUIRED, Vditor aborts init without it
  'js/lute/lute.min.js',
  // Toolbar icon set + zh_CN language pack
  'js/icons/ant.js',
  'js/i18n/zh_CN.js',
  // Code highlighting: engine + extra languages + the two themes we reference
  'js/highlight.js/highlight.min.js',
  'js/highlight.js/third-languages.js',
  'js/highlight.js/styles/github.min.css',
  'js/highlight.js/styles/github-dark.min.css',
  // Math (KaTeX engine + chemistry extension + stylesheet)
  'js/katex/katex.min.js',
  'js/katex/katex.min.css',
  'js/katex/mhchem.min.js',
  // Content themes (preview/IR `.vditor-reset`)
  'css/content-theme/light.css',
  'css/content-theme/dark.css',
]

// Directory globs (relative to vditor/dist)
const GLOBS = [
  // KaTeX fonts: @font-face prefers woff2, so woff/ttf are never requested
  { dir: 'js/katex/fonts', filter: (n) => n.endsWith('.woff2') },
  // `:emoji:` shortcodes
  { dir: 'images/emoji', filter: () => true },
]

function fail(msg) {
  console.error(`[sync-vditor] ${msg}`)
  process.exit(1)
}

if (!existsSync(distDir)) {
  fail(
    `vditor/dist not found at ${distDir}\n` +
      'Run "pnpm install" (or "pnpm --filter @ikit/web install") before syncing assets.',
  )
}

const pkg = JSON.parse(readFileSync(path.join(vditorDir, 'package.json'), 'utf-8'))
const version = String(pkg.version ?? 'unknown')
const prevVersion = existsSync(markerFile) ? readFileSync(markerFile, 'utf-8').trim() : ''
const force = prevVersion !== version

const planned = []
for (const rel of FILES) {
  const src = path.join(distDir, rel)
  if (!existsSync(src)) fail(`whitelisted asset missing in vditor dist: ${rel}`)
  planned.push({ rel, src })
}
for (const { dir, filter } of GLOBS) {
  const abs = path.join(distDir, dir)
  if (!existsSync(abs)) fail(`whitelisted asset directory missing in vditor dist: ${dir}`)
  for (const name of readdirSync(abs)) {
    const src = path.join(abs, name)
    if (!statSync(src).isFile() || !filter(name)) continue
    planned.push({ rel: `${dir}/${name}`, src })
  }
}

let copied = 0
let skipped = 0
let bytes = 0
for (const { rel, src } of planned) {
  const dest = path.join(outDir, rel)
  const size = statSync(src).size
  bytes += size
  const upToDate = !force && existsSync(dest) && statSync(dest).size === size
  if (upToDate) {
    skipped++
    continue
  }
  if (checkOnly) {
    copied++
    continue
  }
  mkdirSync(path.dirname(dest), { recursive: true })
  copyFileSync(src, dest)
  copied++
}

if (!checkOnly) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(markerFile, `${version}\n`, 'utf-8')
}

const mb = (n) => (n / 1024 / 1024).toFixed(2)
console.log(
  `[sync-vditor] vditor@${version}${force && prevVersion ? ` (was ${prevVersion}, forced re-sync)` : ''} -> apps/web/public/vditor`,
)
console.log(
  `[sync-vditor] copied=${copied} skipped=${skipped} total=${planned.length} bytes=${bytes} (${mb(bytes)} MB)`,
)
if (checkOnly && copied > 0) {
  console.error(`[sync-vditor] out of sync: ${copied} file(s) need syncing`)
  process.exit(1)
}
