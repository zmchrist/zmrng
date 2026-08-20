// Bundle the zmrng Node server into a self-contained sidecar for the Tauri app.
//
// Produces, under packages/desktop/src-tauri/ :
//   sidecar/server.mjs                      — esbuild bundle of packages/server (ESM)
//   sidecar/node_modules/{better-sqlite3,…} — the native addon + its runtime deps
//   sidecar/node-<triple>                   — a copy of the running Node binary
//   web-dist/                               — a copy of packages/web/dist
//
// `better-sqlite3` is kept external (it is a native addon and cannot be inlined);
// everything else (fastify, pino, ws, …) is bundled. The output is ESM so the
// server's top-level await and `import.meta.dirname` survive untouched.
import * as esbuild from 'esbuild'
import { cpSync, mkdirSync, rmSync, copyFileSync, chmodSync, existsSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const here = import.meta.dirname
const repoRoot = path.resolve(here, '..', '..', '..')
const srcTauri = path.resolve(here, '..', 'src-tauri')
const sidecarDir = path.join(srcTauri, 'sidecar')
const webDistDst = path.join(srcTauri, 'web-dist')

const serverEntry = path.join(repoRoot, 'packages', 'server', 'dist', 'index.js')
const webDistSrc = path.join(repoRoot, 'packages', 'web', 'dist')

// Native addons must stay external — esbuild can't inline a `.node` binary, and
// node-pty resolves its prebuilt binary relative to its own package dir, so it
// must live under sidecar/node_modules, not be flattened into server.mjs.
//   better-sqlite3 → bindings → file-uri-to-path  is better-sqlite3's runtime closure.
//   node-pty ships an N-API prebuild (prebuilds/<triple>/pty.node + spawn-helper);
//   its only dep, node-addon-api, is header-only and not needed at runtime.
const VENDORED = ['better-sqlite3', 'bindings', 'file-uri-to-path', 'node-pty']

/** Tauri externalBin target triple for the host (solo/arm64 mac, but derived). */
function hostTriple() {
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch
  if (process.platform !== 'darwin') {
    throw new Error(`sidecar bundle currently targets macOS only (got ${process.platform})`)
  }
  return `${arch}-apple-darwin`
}

/** nodejs.org dist arch slug for the host. */
function nodeDistArch() {
  if (process.arch === 'arm64') return 'arm64'
  if (process.arch === 'x64') return 'x64'
  throw new Error(`unsupported arch for node dist: ${process.arch}`)
}

/**
 * Vendor a self-contained Node runtime. The system `node` (e.g. Homebrew) is
 * NOT portable — it dynamically links `@rpath/libnode.*.dylib`, so copying
 * `process.execPath` produces a binary that can't run from the bundle. Instead
 * download the official nodejs.org release for the RUNNING version: its `node`
 * is a single self-contained executable, and pinning to `process.versions.node`
 * keeps its ABI matched to the better-sqlite3 prebuilt npm already fetched.
 */
async function vendorNode(destPath) {
  const ver = process.versions.node
  const arch = nodeDistArch()
  const base = `node-v${ver}-darwin-${arch}`
  const url = `https://nodejs.org/dist/v${ver}/${base}.tar.gz`
  const cacheDir = path.join(os.tmpdir(), 'zmrng-node-vendor')
  mkdirSync(cacheDir, { recursive: true })
  const tarball = path.join(cacheDir, `${base}.tar.gz`)
  const extracted = path.join(cacheDir, base, 'bin', 'node')

  if (!existsSync(extracted)) {
    if (!existsSync(tarball)) {
      log(`downloading official Node ${ver} → ${url}`)
      const res = await fetch(url)
      if (!res.ok) throw new Error(`failed to download Node ${ver}: HTTP ${res.status} ${url}`)
      await writeFile(tarball, Buffer.from(await res.arrayBuffer()))
    }
    // Extract just the binary; tar is available on macOS.
    execFileSync('tar', ['-xzf', tarball, '-C', cacheDir, `${base}/bin/node`])
  }
  if (!existsSync(extracted)) throw new Error(`Node binary not found after extract: ${extracted}`)
  copyFileSync(extracted, destPath)
  chmodSync(destPath, 0o755)
  return ver
}

function log(msg) {
  process.stdout.write(`[bundle-sidecar] ${msg}\n`)
}

/** Newest file mtime (ms) anywhere under `dir`; 0 if the dir is absent/empty. */
function newestMtimeMs(dir) {
  let newest = 0
  let entries
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    if (!e.isFile()) continue
    try {
      const m = statSync(path.join(e.parentPath ?? dir, e.name)).mtimeMs
      if (m > newest) newest = m
    } catch {
      /* unreadable entry — ignore */
    }
  }
  return newest
}

/**
 * Refuse to bundle a stale `dist`. If any source file is newer than every build
 * output, `dist` predates the current source and bundling would silently ship
 * outdated code (the exact trap that baked an old UI into the .app). Fail loud so
 * the operator rebuilds instead of shipping stale bytes.
 */
function assertFresh(srcDir, distDir, buildCmd) {
  const distNewest = newestMtimeMs(distDir)
  if (distNewest === 0) return // absent dist is reported by the existsSync checks below
  const srcNewest = newestMtimeMs(srcDir)
  if (srcNewest > distNewest) {
    throw new Error(
      `STALE BUILD: a source file under ${path.relative(repoRoot, srcDir)} is newer than its ` +
        `build output in ${path.relative(repoRoot, distDir)}. Bundling now would ship outdated ` +
        `code. Run \`${buildCmd}\` (or \`npm run build\`) first, then re-bundle.`,
    )
  }
}

// Guard: never bundle a dist that lags its source (prevents the stale-.app trap).
assertFresh(path.join(repoRoot, 'packages', 'server', 'src'), path.dirname(serverEntry), 'npm run build:server')
assertFresh(path.join(repoRoot, 'packages', 'web', 'src'), webDistSrc, 'npm run build:web')

if (!existsSync(serverEntry)) {
  throw new Error(`server build missing at ${serverEntry} — run \`npm run build\` first`)
}

// 1. Clean + recreate output dirs (only our own generated dirs).
rmSync(sidecarDir, { recursive: true, force: true })
rmSync(webDistDst, { recursive: true, force: true })
mkdirSync(sidecarDir, { recursive: true })

// 2. Bundle the server → ESM, native addon left external.
log('esbuild server → sidecar/server.mjs')
await esbuild.build({
  entryPoints: [serverEntry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: path.join(sidecarDir, 'server.mjs'),
  external: VENDORED,
  // Bundled CJS deps (fastify, avvio, pino) call require() at runtime. esbuild's
  // ESM shim throws on those unless a real `require` exists in scope — provide one.
  banner: {
    js: "import { createRequire as __zmrngCreateRequire } from 'node:module';\nconst require = __zmrngCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
})

// 3. Vendor the native addon + its runtime deps (incl. prebuilt .node).
const vendorModules = path.join(sidecarDir, 'node_modules')
mkdirSync(vendorModules, { recursive: true })
for (const mod of VENDORED) {
  const from = path.join(repoRoot, 'node_modules', mod)
  if (!existsSync(from)) throw new Error(`vendored module not found: ${from}`)
  cpSync(from, path.join(vendorModules, mod), { recursive: true, dereference: true })
  log(`vendored node_modules/${mod}`)
}

// 4. Vendor a self-contained Node runtime under Tauri's externalBin triple name.
const nodeName = `node-${hostTriple()}`
const nodeDst = path.join(sidecarDir, nodeName)
const vendoredVer = await vendorNode(nodeDst)
log(`vendored official Node ${vendoredVer} → sidecar/${nodeName}`)

// 5. Copy the built web assets.
if (!existsSync(webDistSrc)) throw new Error(`web build missing at ${webDistSrc} — run \`npm run build\` first`)
cpSync(webDistSrc, webDistDst, { recursive: true })
log('copied packages/web/dist → src-tauri/web-dist')

// 6. Seed the repo registry into the bundle. config/repos.json is gitignored and
// machine-specific, and the app's writable data dir starts empty — so without this
// the bundled app falls back to legacy/auto-scan and never sees the curated labels.
// The server copies sidecar/config/repos.json → <dataDir>/config/repos.json on first
// run when that file is missing (see config.ts seedRegistry).
const repoCfgSrc = path.join(repoRoot, 'config', 'repos.json')
if (existsSync(repoCfgSrc)) {
  const cfgDstDir = path.join(sidecarDir, 'config')
  mkdirSync(cfgDstDir, { recursive: true })
  copyFileSync(repoCfgSrc, path.join(cfgDstDir, 'repos.json'))
  log('seeded sidecar/config/repos.json from config/repos.json')
} else {
  // No curated repos.json — write a stub so the tauri resource glob
  // `sidecar/config/**/*` always has at least one file (tauri-build treats a
  // glob with zero matches as a hard error). config.ts loadRepoCandidates falls
  // through to env/auto-scan when the parsed array is empty.
  const cfgDstDir = path.join(sidecarDir, 'config')
  mkdirSync(cfgDstDir, { recursive: true })
  writeFileSync(path.join(cfgDstDir, 'repos.json'), '[]')
  log('no config/repos.json to seed — bundled app will auto-scan the projects dir')
}

log('done.')
