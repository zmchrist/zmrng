# Implementation Report — zmrng Tauri desktop app

**Plan:** `.agents/plans/tauri-desktop-app.md`
**Branch:** `feat/zc/tauri-desktop-app` (cut from `origin/main`)
**Date:** 2026-06-18
**Status:** Code complete + sidecar packaging proven standalone (Level 5 ✓). Rust
compile (`tauri build`) and the Finder-launch Level-6 test remain operator steps —
Rust is not installed in this environment and a Finder GUI launch is not automatable.

---

## What was implemented

### Step 1 — `config.ts`: writable data dir + web-dist override (§5.2) ✓
- Added `DATA_DIR` (env `ZMRNG_DATA_DIR`, default `REPO_ROOT`) and `CONFIG_DIR`
  (`<DATA_DIR>/config`). `dbPath` + `worktreesDir` now derive from `DATA_DIR`;
  `webDist` honors `ZMRNG_WEB_DIST`.
- Repo registry loads from `<DATA_DIR>/config/repos.json`.
- `loadDotEnv` now reads `.env` from both `REPO_ROOT` and `DATA_DIR` (dedup'd).
- `mkdirSync(DATA_DIR)` + `mkdirSync(worktreesDir)` at startup (recursive, idempotent).
- Added `dataDir` to the `Config` interface and the startup log line.
- **Dev parity verified:** with no env, `dataDir === REPO_ROOT` and `dbPath` /
  `worktreesDir` / `webDist` resolve byte-for-byte to today's paths.

### Step 2 — Sidecar bundle pipeline (§5.3) ✓ (proven standalone)
- `packages/desktop/scripts/bundle-sidecar.mjs`:
  1. esbuild `packages/server/dist/index.js` → `src-tauri/sidecar/server.mjs`
     (**ESM**, `--platform=node`, `better-sqlite3` external).
  2. Vendors `better-sqlite3` + its runtime closure (`bindings`, `file-uri-to-path`)
     incl. the prebuilt `better_sqlite3.node` into `sidecar/node_modules/`.
  3. Downloads + vendors the **official nodejs.org** Node binary (pinned to the
     running version) as `sidecar/node-aarch64-apple-darwin`.
  4. Copies `packages/web/dist` → `src-tauri/web-dist`.
- **Level-5 spike PASSED** (run from a temp `ZMRNG_DATA_DIR` with the vendored Node):
  `/api/config` + `/api/repos` return JSON, `/` serves the UI (200, `#root` present),
  `zmrng.db` + WAL created in the data dir, SIGTERM → clean
  `shutting down — killing live claude workers`.

### Steps 3–5 — Tauri scaffold + Rust lifecycle + splash ✓ (written; not yet compiled)
- `src-tauri/tauri.conf.json` — productName `zmrng`, window `main`, `externalBin:
  ["sidecar/node"]`, `resources` for `server.mjs` + `node_modules` + `web-dist`,
  `csp: null`, macOS min 11.0.
- `src-tauri/src/main.rs` — free port → login-shell PATH (§5.1) → spawn sidecar with
  `{ZMRNG_PORT, ZMRNG_DATA_DIR, ZMRNG_WEB_DIST, PATH}` → drain stdio → health-poll →
  `window.navigate(localhost:<port>)`; on `CloseRequested`/`ExitRequested` → SIGTERM
  the sidecar (so Node reaps its claude kids), then hard-kill backstop.
- `Cargo.toml` (tauri 2 + tauri-plugin-shell + libc), `build.rs`, `capabilities/default.json`.
- `splash/index.html` — frosted-glass "zmrng — starting engine…" loader (theme tokens).

### Step 6 — Workspace + scripts ✓
- Root `package.json`: added `packages/desktop` to `workspaces`; scripts
  `bundle:sidecar`, `desktop:dev`, `desktop:build`. The desktop package deliberately
  has **no** `build`/`lint`/`typecheck` scripts, so the workspace-wide JS gate stays
  Rust-free.
- `.gitignore`: ignores `src-tauri/target/`, `gen/`, generated `sidecar/`, `web-dist/`,
  and icon binaries. Verified generated artifacts are ignored; only source files stage.

### Step 8 — Docs ✓
- `README.md` (desktop section + `ZMRNG_DATA_DIR`/`ZMRNG_WEB_DIST` config rows + layout),
  `CLAUDE.md` (commands + structure), `.claude/files/PROJECT_CONTEXT.md` (desktop shell
  decision + data-dir note), `.claude/errors.md` (two packaging gotchas, below).

---

## Divergences from the plan

### Divergence: sidecar bundle is ESM `server.mjs`, not CJS `server.cjs`
- **Planned:** esbuild `--format=cjs` → `server.cjs`.
- **Actual:** `--format=esm` → `server.mjs` + a `createRequire` banner.
- **Reason:** `config.ts` uses `import.meta.dirname` and the server uses top-level
  `await` — neither survives a CJS bundle. ESM output keeps both intact with zero
  source changes.

### Divergence: artifacts generated under `src-tauri/`, not `packages/desktop/`
- **Planned:** `packages/desktop/sidecar/` + `packages/desktop/web-dist/`.
- **Actual:** `packages/desktop/src-tauri/sidecar/` + `…/src-tauri/web-dist/`.
- **Reason:** Tauri `resources`/`externalBin` globs resolve relative to the
  `tauri.conf.json` dir (`src-tauri`). Keeping artifacts inside `src-tauri` avoids
  `../` in resource paths and keeps `resource_dir()` resolution clean.

### Divergence: official nodejs.org Node binary, not `process.execPath`
- **Planned:** "vendor a pinned Node release binary" (copy a Node binary).
- **Actual:** download the official nodejs.org release for `process.versions.node`.
- **Reason:** the host's Homebrew `node` dynamically links `@rpath/libnode.*.dylib`
  and is not portable; the official release `node` is a self-contained executable.

---

## Validation

```
npm run typecheck   → clean (server + web)
npm run lint        → clean (server + web)
npm run build       → ✓ (tsc server + vite build web)
dev parity          → dataDir/dbPath/worktreesDir/webDist === REPO_ROOT defaults (no env)
Level-5 spike       → server.mjs serves /api/config, /api/repos, / (200); db+WAL created;
                      better-sqlite3 native module loads; SIGTERM clean shutdown
type mirror         → untouched (no wire-type change; `Config.dataDir` is server-internal)
```

Rust/`tauri` are outside the JS gate; the desktop package contributes no
typecheck/lint/build script, so the gate is unaffected.

---

## Remaining (operator) — Level-6, the real end-to-end test

These cannot be done autonomously (Rust not installed; Finder launch is a GUI action):

1. Install Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`.
2. Generate icons: `npm run tauri -w @zmrng/desktop -- icon path/to/zmrng-logo.png`.
3. `npm run desktop:build` → open the produced `.app` **from Finder** (not terminal — PATH!).
4. Verify the full arc against a registered repo: task → Start → **clarify** (claude
   spawns ⇒ PATH ✓) → answer → `ZMRNG_READY` → **building** (git worktree ✓) →
   `gh pr create` / PR URL → **review** (gh ✓).
5. Quit → `pgrep -fl claude` shows no orphans; db + worktrees live under
   `~/Library/Application Support/zmrng/`.

Expect possible small fixups on first `tauri dev`/`build` — the Rust file (`main.rs`)
and Tauri v2 config were written but not compiler-verified here. Most likely touch
points: the `WebviewWindow::navigate` / `tauri::Url` import, the shell `.envs()`
builder, and the capability schema path.

Then: run the `sync-docs` skill and commit on `feat/zc/tauri-desktop-app`.
