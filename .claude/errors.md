# Known Errors & Solutions

Check here before debugging. Add a new entry whenever a fix took >2 min, had a
non-obvious root cause, or is likely to recur. Template in
`.claude/rules/error-handling.md`.

---

### `npm start` dies with `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION`
- **Error:** `npm start` aborts immediately: *"The module
  `node_modules/better-sqlite3/build/Release/better_sqlite3.node` was compiled
  against a different Node.js version using NODE_MODULE_VERSION 127"*,
  `code: 'ERR_DLOPEN_FAILED'`. `npm test`/`npm run build` are unaffected —
  only the paths that actually open the DB.
- **Cause:** `better-sqlite3` is a native addon; its binding is compiled for the
  Node major that ran `npm install`. This machine has several nodes on `PATH`
  (nvm 22.14, homebrew `node@25`), and a shell that resolves the newer one loads
  a binding built for the older ABI.
- **Solution:** `nvm use` (`.nvmrc` pins 22) then `npm start`. If the binding is
  genuinely built for the wrong major, `npm rebuild better-sqlite3`. `engines`
  is pinned to `>=20.11.0 <23` so npm warns instead of failing at runtime.
  Verify with `node -v` before blaming the server.
- **Files:** `.nvmrc`, root `package.json` (`engines`)
- **Date Found:** 2026-07-27

### Rebuilt `.app` still ships the old UI (stale bundled `dist`)
- **Error:** No error surfaced — after `npm run desktop:build`, the `.app` still renders
  an old UI (e.g. missing the collapsible task pane) even though the feature is present in
  `packages/web/src`. The dev server (`npm run dev`, vite :5174) shows the feature fine.
- **Cause:** `bundle-sidecar.mjs` bundles whatever sits in `packages/web/dist` +
  `packages/server/dist`. If those `dist` dirs lag the current source (a build ran against
  earlier source, a partial/failed build left an old `dist`, or `bundle:sidecar` was run
  standalone), the bundle silently bakes outdated assets into the `.app`. The dir mtime can
  look "today" while the contents predate the feature, so it's easy to miss. Symlink note:
  `~/Documents/Projects` → `~/Developer/Projects` (one checkout, not two).
- **Solution:** A freshness guard in `bundle-sidecar.mjs` (`assertFresh`) compares the
  newest mtime under each `src` tree to its `dist`; if any source file is newer it throws
  `STALE BUILD: …` and aborts before bundling. Because `bundle:sidecar` sits in the
  `desktop:build` `&&` chain, a stale `dist` now halts the build loudly instead of shipping
  old bytes. Fix when it fires: run `npm run build` (or `npm run build:web`/`:server`),
  then re-bundle. To confirm a built `.app` is current, grep the baked assets, e.g.
  `grep -roh 'collapseBtn' …/zmrng.app/Contents/Resources/web-dist/assets/*.css`.
- **Files:** `packages/desktop/scripts/bundle-sidecar.mjs` (`newestMtimeMs`, `assertFresh`)
- **Date Found:** 2026-06-21

### Bundled app's `zmrng` self-repo points inside the `.app`
- **Error:** No error surfaced — in the packaged desktop app `GET /api/config` reports
  `targetRepo` as `…/release/bundle/macos/zmrng.app` and the `zmrng` registry entry's
  path is inside the bundle; a task targeting the default `zmrng` repo would create a
  worktree inside the read-only `.app`.
- **Cause:** `config.ts` derives `REPO_ROOT = resolve(import.meta.dirname, '../../..')`.
  In dev that's the repo root, but the bundled sidecar lives at
  `<bundle>/Contents/Resources/sidecar/server.mjs`, so `../../..` resolves to the `.app`
  bundle. The self-entry was built from `REPO_ROOT` and validated with `isGitRepo()`
  (not `isGitRepoRoot()`), so when the `.app` sits *inside* the dev checkout the bogus
  path passes validation instead of being skipped.
- **Solution:** `resolveSelfRepo()` — use `REPO_ROOT` only when it `isGitRepoRoot`;
  otherwise walk to the git toplevel (the real checkout when the bundle is nested in a
  dev tree) and reject any path containing `.app/`; return `undefined` for a truly
  installed app so the operator drives repos from the seeded registry. Default-repo
  detection now matches the `zmrng` id rather than a `path === REPO_ROOT` lookup.
- **Files:** `packages/server/src/config.ts` (`resolveSelfRepo`, `buildConfig`)
- **Date Found:** 2026-06-21

### Workers silently bill the metered API
- **Error:** No error surfaced — Anthropic API usage/cost appears even though the
  operator has a Max subscription.
- **Cause:** `ANTHROPIC_API_KEY` present in the parent env is inherited by the spawned
  `claude` child, which then prefers the metered API over Max OAuth.
- **Solution:** In `runner.ts`, copy `process.env` and `delete env.ANTHROPIC_API_KEY`
  before `spawn`. Never export the key in the shell that runs zmrng.
- **Files:** `packages/server/src/runner.ts` (constructor, env setup)
- **Date Found:** 2026-06-17

### Bodyless POST returns 400 (FST_ERR_CTP_EMPTY_JSON_BODY)
- **Error:** `FST_ERR_CTP_EMPTY_JSON_BODY` — Fastify 400 on `start`/`done`/`cancel`.
- **Cause:** The fetch sent `content-type: application/json` with no body; Fastify's JSON
  content-type parser rejects an empty body.
- **Solution:** Only set the JSON content-type header when a body is actually sent.
- **Files:** `packages/web/src/api.ts` (`req` helper — conditional headers)
- **Date Found:** 2026-06-17

### stream-json lines fail to parse / partial lines
- **Error:** `JSON.parse` throws on a `claude` stdout line, or text arrives mangled.
- **Cause:** stdout chunks don't align to line boundaries (a JSON object can be split
  across two `data` events), and claude emits non-JSON diagnostics too.
- **Solution:** Buffer stdout, split on `\n`, `JSON.parse` each complete line inside
  try/catch, and ignore lines that don't parse or whose shape is unknown. Shapes vary
  across claude versions — narrow with tolerant `asRecord`/`asString` helpers, never `any`.
- **Files:** `packages/server/src/runner.ts` (`onStdout`, `handleLine`)
- **Date Found:** 2026-06-17

### Worktree creation fails on a local-only target repo
- **Error:** `git worktree add ... origin/main` fails — `invalid reference: origin/main`.
- **Cause:** The target repo has no `origin` remote (local-only), so `origin/<branch>`
  doesn't resolve.
- **Solution:** Resolve the base ref with a fallback chain: `origin/<defaultBranch>` →
  local `<defaultBranch>` → `HEAD`; `git fetch origin` is best-effort (wrapped in try/catch).
- **Files:** `packages/server/src/worktree.ts` (`resolveBase`, `createWorktree`)
- **Date Found:** 2026-06-17

### Web typecheck fails after a server type change
- **Error:** `tsc` errors in `packages/web` referencing a property that exists on the server.
- **Cause:** `packages/web/src/types.ts` is a MANUAL mirror of the server types and was
  not updated alongside `packages/server/src/types.ts` (there is no shared package).
- **Solution:** Mirror every server type change into the web types file in the same change.
- **Files:** `packages/server/src/types.ts`, `packages/web/src/types.ts`
- **Date Found:** 2026-06-17

### Vendored Homebrew `node` won't run standalone (dyld libnode.*.dylib)
- **Error:** `dyld[…]: Library not loaded: @rpath/libnode.141.dylib … (no such file)` when
  the desktop sidecar runs the vendored Node binary.
- **Cause:** Homebrew's `node` is **not** self-contained — it dynamically links a separate
  `libnode.<abi>.dylib` from the Cellar via `@rpath`. Copying `process.execPath` into the
  bundle copies only the launcher, not the dylib, so it can't start outside Homebrew.
- **Solution:** Vendor the **official nodejs.org release** binary instead (a single
  self-contained executable). Pin it to `process.versions.node` so its ABI matches the
  `better-sqlite3` prebuilt `.node` that `npm install` fetched for the same Node.
- **Files:** `packages/desktop/scripts/bundle-sidecar.mjs` (`vendorNode`)
- **Date Found:** 2026-06-18

### Tauri `transparent: true` window silently fails to composite (macOS)
- **Error:** No error — the window simply renders with a solid background instead of
  being transparent, making the frosted-glass / backdrop-filter effects invisible.
- **Cause:** On macOS, Tauri's transparent compositing requires two things to both be
  set: `"macOSPrivateApi": true` in `tauri.conf.json` **AND** the Cargo feature
  `"macos-private-api"` enabled in `Cargo.toml`. Missing either one silently disables
  compositing. The Cargo feature was missing on main.
- **Solution:** In `tauri.conf.json` set `"macOSPrivateApi": true` (under `app.windows`)
  and in `Cargo.toml` change `tauri = { version = "2", features = [] }` to
  `tauri = { version = "2", features = ["macos-private-api"] }`.
- **Files:** `packages/desktop/src-tauri/tauri.conf.json`,
  `packages/desktop/src-tauri/Cargo.toml`
- **Date Found:** 2026-06-18

### Bundled server throws `Dynamic require of "node:events" is not supported`
- **Error:** The esbuild'd `server.mjs` throws `Dynamic require of "…" is not supported`
  at startup (from inside fastify/avvio/pino).
- **Cause:** esbuild ESM output wraps bundled CJS deps with a `__require` shim that throws
  for any runtime `require()` unless a real `require` exists in module scope — which ESM
  modules don't have by default.
- **Solution:** Inject a `createRequire` banner into the esbuild config so the shim finds
  a working `require`: `import { createRequire } from 'node:module'; const require =
  createRequire(import.meta.url);`.
- **Files:** `packages/desktop/scripts/bundle-sidecar.mjs` (esbuild `banner`)
- **Date Found:** 2026-06-18

### Dev server randomly dies with `ws proxy error: EPIPE` / `npm error code 143`
- **Error:** During a live session (no file edits, just chatting with an agent), the
  Vite dev server logs `[vite] ws proxy error: Error: write EPIPE` /
  `[vite] ws proxy socket error: Error: write EPIPE`, then `npm run dev` exits with
  `npm error code 143` (SIGTERM) for `@zmrng/web`.
- **Cause:** `Runner.send()` (`packages/server/src/runner.ts`) wrote directly to
  `this.child.stdin` with no guard. If the spawned `claude` child had already exited
  (crashed, hit an internal error, or otherwise died) while the operator's socket was
  still open, the next chat/steer message wrote to a dead pipe. That surfaces as an
  async `EPIPE` `'error'` event on the stdin stream; with no listener registered on it,
  Node treats it as an unhandled stream error and crashes the whole Fastify server
  process. The Vite proxy's `EPIPE` logs are a downstream symptom — its own upstream
  `/ws` connection to `:4500` was severed when the backend process died — and the
  `code 143` is `npm run dev`'s sibling `dev:web` script getting torn down once the
  backend half of the `dev` script exited.
- **Solution:** Register a no-op `'error'` listener on `this.child.stdin` in the
  `Runner` constructor (mirrors the existing `this.child.on('error', ...)` handling for
  spawn failures), and wrap the `stdin.write()` in `send()` in try/catch, matching the
  pattern already used by `interrupt()`/`kill()`. A dead child now silently drops the
  write instead of taking the server down with it.
- **Files:** `packages/server/src/runner.ts` (`Runner` constructor, `send()`)
- **Date Found:** 2026-08-17

### Workspace terminal fails to spawn — `Error: posix_spawnp failed.` (node-pty)
- **Error:** Opening the Workspace bottom-dock terminal fails at PTY spawn; the server
  throws `Error: posix_spawnp failed.` from inside `node-pty`.
- **Cause:** `node-pty`'s prebuilt native helper binary
  (`node_modules/node-pty/prebuilds/<platform>/spawn-helper`) can lose its executable bit
  during npm's extraction of the package tarball. The native `.node` binding itself loads
  fine — it's purely the `spawn-helper` child binary that `posix_spawnp` can't exec.
- **Solution:** `chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`
  (adjust the platform dir for your machine — npm workspaces hoist `node-pty` to the repo
  root `node_modules`, not `packages/server/node_modules`). If it recurs after a clean
  `npm install`, re-run the `chmod`; there is no code fix, it's a packaging quirk of the
  native module.
- **Files:** `node_modules/node-pty/prebuilds/*/spawn-helper` (not tracked in git — a
  reinstall can reintroduce this)
- **Date Found:** 2026-08-16

### Worktree creation fails for target repos under ~/Documents (bundled .app only)
- **Error:** `worktree creation failed: Command failed: git -C ~/Documents/Projects/<repo> worktree add -b <branch> … HEAD` → `fatal: Unable to read current working directory: Operation not permitted`. Happens **only** in the bundled `.app`, never in `npm run dev`. No tccd/sandbox denial is logged.
- **Cause:** macOS hard-protects `~/Documents` (also `~/Desktop`, `~/Downloads`) via TCC. The Finder-launched sidecar runs with cwd `/`; when `git -C <repo-under-Documents>` chdirs in and calls `getcwd()`, the path-walk reads back up through `~/Documents` and is denied → silent `EPERM`. It's silent (no tccd log) because the I/O is performed by `/usr/bin/git` (a shared Apple binary) under the hardened-runtime, different-team bundled `node` helper — that chain breaks TCC responsibility inheritance, so granting Full Disk Access to the `.app` **or** to the bundled `node` does **not** attach to the access. Confirmed by experiment: an identical task against a repo in the shared users folder (`~/../Shared`, non-protected) succeeds instantly with the same app/node/git.
- **Solution:** Keep drivable target repos **out of** the TCC-protected folders. Move them to `~/Developer` (Apple-blessed, never protected), `~/Projects`, `~/Code`, etc., and repath the registry (`<dataDir>/config/repos.json`, e.g. `~/Library/Application Support/zmrng/config/repos.json`). `npm run dev` is unaffected (the server inherits the Terminal's own Documents grant), so dev mode is a valid interim. FDA on the app is *not* a reliable fix while the app is ad-hoc-signed.
- **Files:** none (environment/packaging constraint, not a code bug). Touches `<dataDir>/config/repos.json` and `ZMRNG_PROJECTS_DIR` for auto-scan.
- **Date Found:** 2026-06-20

### Ctrl+C on `npm run dev` prints a raw EPIPE stack + nonzero exit codes
- **Error:** Killing `npm run dev` (Ctrl+C) prints Vite's `[vite] ws proxy socket error: Error:
  write EPIPE` with a raw Node stack trace, then `zsh: terminated npm run dev`, then
  `npm error Lifecycle script 'dev' failed with error: npm error code 15` (server) and
  `npm error code 143` (web) — noisy failure output for what was just a manual shutdown.
- **Cause:** The root `dev` script was `npm run dev:server & npm run dev:web & wait`, a
  plain shell job-control one-liner with no signal trap. Ctrl+C sends SIGINT to the whole
  foreground process group, so both backgrounded `npm run` children die at once with no
  ordering guarantee; when `dev:server` (tsx watch) dies before `dev:web` (Vite), Vite's
  `/ws` proxy loses its upstream mid-flight and logs the raw socket error. Separately, npm
  itself treats a script that exits via signal as a lifecycle failure and prints its own
  `npm error` stack per workspace — that part is cosmetic, not a real crash.
  This is a distinct spot from the child-stdin EPIPE fixed at 6d87b50 (that one was the
  `claude` runner's own stdin write failing after the child had already exited).
- **Solution:** Replace the raw `&`/`wait` composition with `concurrently`, which runs both
  workspace scripts under one foreground process, forwards SIGINT/SIGTERM to both children
  together, and exits cleanly instead of leaving npm to report a lifecycle failure per
  workspace. Applied the same fix to `test:watch` (same `&`/`wait` pattern).
- **Files:** `package.json` (`dev`, `test:watch` scripts; added `concurrently` devDependency)
- **Date Found:** 2026-08-17

### Dev server still randomly dies (`npm error code 143` for web) after the EPIPE stdin fix
- **Error:** Same symptom as the entry above — `npm run dev` cascades into `dev:web`
  exiting with code 143 — but recurs even with the `runner.ts` stdin `'error'` listener
  (6d87b50) in place, with no visible cause in the tail of the log (server logs a normal
  200 response, then web dies).
- **Cause:** That fix only guarded one specific write path. The server had **no**
  process-level `uncaughtException`/`unhandledRejection` handler, so *any* unguarded async
  error anywhere (a future WS handler, a rejected promise, another dead-pipe write) still
  kills the whole Fastify process — which tears down `dev:web`'s Vite proxy the same way.
- **Solution:** Register `process.on('uncaughtException', ...)` and
  `process.on('unhandledRejection', ...)` near the top of `index.ts` to log via
  `app.log.error` and keep the process alive, instead of relying on guarding every write
  site individually.
- **Files:** `packages/server/src/index.ts` (top-level, right after `Fastify(...)`)
- **Date Found:** 2026-08-18

### Voice models load to 100% then "no available backend found" / ORT wasm fetch fails
- **Error:** `Voice unavailable: Error: no available backend found. ERR: [wasm] TypeError: Failed to fetch dynamically imported module: http://localhost:5174/node_modules/.vite/deps/ort-wasm-simd-threaded.mjs?import, [cpu] Error: previous call to 'initWasm()' failed.`
- **Cause:** Two stacked causes. (1) Vite's dep pre-bundler rewrote `onnxruntime-web` (bundled inside `@huggingface/transformers`/`kokoro-js`) into `.vite/deps`, which mangled ORT's dynamic wasm-glue import → 404. (2) ORT's threaded build wants `SharedArrayBuffer`, which needs COOP/COEP cross-origin isolation we deliberately do NOT enable.
- **Solution:** In `packages/web/vite.config.ts` add `optimizeDeps.exclude: ['@huggingface/transformers','onnxruntime-web','kokoro-js']` + `worker.format: 'es'` (the ES worker format also silences the kokoro `import.meta`/iife build warning). In each voice worker, before any model load, pin ORT's `wasmPaths` to a CDN URL matching the EXACT onnxruntime-web version that transformers instance depends on — they differ: whisper's top-level transformers 4.2.0 → `onnxruntime-web@1.26.0-dev.20260416-b7804b056c`; kokoro-js bundles its own nested transformers 3.8.1 → `onnxruntime-web@1.22.0-dev.20250409-89f8206ba4`. Set `env.backends.onnx.wasm.numThreads = 1` where reachable (whisper's `env`); kokoro-js only re-exports a `wasmPaths` setter, so its threads rely on ORT's built-in `!crossOriginIsolated` auto-clamp to 1 (verified in both ORT bundles). Phase 2 swaps the CDN paths for locally-bundled assets.
- **Files:** `packages/web/vite.config.ts`, `packages/web/src/voice/sttWorker.ts`, `packages/web/src/voice/ttsWorker.ts`
- **Date Found:** 2026-08-27

### Voice: `Calling require for "onnxruntime-web/wasm" in an environment that doesn't expose require` (Rolldown)
- **Error:** `Voice unavailable: Error: Calling \`require\` for "onnxruntime-web/wasm" in an environment that doesn't expose the \`require\` function. See https://rolldown.rs/in-depth/bundling-cjs#require-external-modules` — a dev-server *runtime* error at :5174 (NOT caught by `npm run build`/tests, which stayed green through it).
- **Cause:** This project's Vite (v8, Rolldown-powered — `rolldown` 1.0.3) was bundling `@huggingface/transformers`, whose internals do a CJS `require('onnxruntime-web/wasm')`. Under Rolldown, marking ORT external (via `optimizeDeps.exclude`) turned that into a literal runtime `require(...)` call inside the ES Web Worker, which has no `require`. The earlier `.vite/deps` 404 fix (excluding the stack from the dep-optimizer) made this *worse*, not better.
- **Solution:** Do NOT let Vite/Rolldown bundle the heavy voice ML libs at all. Load them from a CDN at runtime inside each worker with a `/* @vite-ignore */` dynamic import off a non-literal URL var, using jsDelivr's `/+esm` endpoint (flattens transitive bare-import deps — transformers→onnxruntime-web, kokoro→its nested transformers→ORT — into browser-ready ESM): `const { pipeline, env } = (await import(/* @vite-ignore */ url)) as typeof import('@huggingface/transformers')`. Type via `as typeof import('pkg')` (type-only, no runtime emit) to stay `any`-free; keep the packages in `package.json` only for those types + Phase-2 local vendoring. Pin ORT `wasmPaths` to the matching onnxruntime-web version per lib (whisper→1.26-dev, kokoro→1.22-dev). Remove the whole `optimizeDeps.exclude` block (unnecessary once nothing is bundled); keep `worker.format: 'es'`. Verified: worker chunks drop from 518 kB/2.2 MB to ~1 kB each and no `ort-wasm-*.wasm` assets are emitted.
- **Files:** `packages/web/vite.config.ts`, `packages/web/src/voice/sttWorker.ts`, `packages/web/src/voice/ttsWorker.ts`
- **Date Found:** 2026-08-27
