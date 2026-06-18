# Plan — zmrng as a self-contained Tauri desktop app

**Status:** ready for implementation
**Complexity:** Medium-High (native packaging + path/env plumbing; little UI work)
**Author:** workshop + plan session, 2026-06-17
**Branch to cut:** `feat/zc/tauri-desktop-app` from `origin/main`

---

## 1. Feature description

Wrap the existing zmrng web app (Fastify server + Vite/React UI, talking HTTP+WS over
`localhost`) in a **native macOS desktop app** using **Tauri** (Rust shell + WKWebView).
The Node server runs **unchanged** as a bundled **sidecar** process; Tauri owns its
lifecycle (spawn on launch, kill on quit) and shows a native window pointed at the
sidecar's local URL.

The deliverable is a **self-contained, double-click `.app`** that bundles the Node
runtime, the server bundle, the prebuilt `better-sqlite3` native module, and the built
web assets — so it runs without the repo present on disk.

### User story
```
As the solo operator of zmrng
I want a native double-click macOS app instead of a browser tab on localhost
So that zmrng feels like a real desktop tool I launch, not a dev server I babysit
```

### Decisions locked in workshop (do NOT re-litigate)
- **Scope:** just the operator, this Mac (arm64). No code-signing, notarization,
  installer, or multi-arch. Dev/ad-hoc `.app` is fine.
- **Shell:** Tauri (Rust toolchain approved). Not Electron.
- **App feel:** native double-click window; native feel prioritized.
- **Standalone:** fully self-contained `.app` (bundle Node + server + sqlite + web/dist).
- **Server stays Node, unchanged.** We wrap, we do not rewrite the engine in Rust.
- **Node serves everything** (UI + `/api` + `/ws`) exactly as today; the Tauri window
  just navigates to `http://localhost:<port>`. → zero frontend changes, no CORS, no new
  WS wiring.

---

## 2. Architecture

```
┌─ Tauri shell (Rust) ─ packages/desktop ──────────────────┐
│  • pick a free port                                       │
│  • resolve login-shell PATH  (the PATH fix — see §5.1)    │
│  • spawn sidecar:  node server.cjs                        │
│      env: ZMRNG_PORT, ZMRNG_DATA_DIR, ZMRNG_WEB_DIST, PATH│
│  • health-poll 127.0.0.1:<port> until listening           │
│  • WKWebView window → http://localhost:<port>             │
│  • on window close / app exit → terminate sidecar (SIGTERM)│
└───────────────────────────────────────────────────────────┘
              │ spawns (Tauri sidecar)
┌─ Node sidecar = packages/server, BUNDLED ─────────────────┐
│  Fastify serves web/dist + /api + /ws  (unchanged)        │
│  spawns `claude` · runs `git`/`gh` · better-sqlite3 (WAL) │
│  SIGTERM → existing manager.shutdown() kills claude kids   │
└───────────────────────────────────────────────────────────┘
```

Data (SQLite db, git worktrees, repo registry) moves out of the (read-only, relocatable)
bundle into a **writable per-user data dir**: `~/Library/Application Support/zmrng/`.

---

## 3. Context — files to read before implementing

| File | Why it matters |
|------|----------------|
| `packages/server/src/config.ts` | `REPO_ROOT`-relative paths (`dbPath`, `worktreesDir`, `webDist`, `config/repos.json`, `.env`) all break in a bundle — **the main refactor target.** |
| `packages/server/src/index.ts` | Serves `web/dist` via `@fastify/static`; reads `config.webDist`; already has SIGINT/SIGTERM → `manager.shutdown()`. Listens on `config.port`. |
| `packages/server/src/runner.ts` | Spawns `claude` (bare command → needs PATH). Strips `ANTHROPIC_API_KEY` — **must stay.** |
| `packages/server/src/worktree.ts` | Spawns `git` (bare command → needs PATH). |
| `packages/server/src/phases.ts` | `buildKickoff` runs `gh pr create` (bare command → needs PATH). |
| `packages/server/src/db.ts` | `better-sqlite3` native module — the packaging fiddle. Path comes from `config.dbPath`. |
| `packages/web/vite.config.ts` | Dev proxy → `localhost:4500`. Prod build is static `web/dist`, served by node. |
| `package.json` (root) | npm workspaces; add `packages/desktop` + bundle scripts here. |

### Conventions to honor (from CLAUDE.md / .claude/rules)
- **Type mirror:** any change to `packages/server/src/types.ts` mirrors into
  `packages/web/src/types.ts`. *(This feature likely adds NO new shared types — keep it
  that way. New config is env-driven, not a wire type.)*
- **Pino only**, no `console.log` in server code. Structured logging with context.
- **No `any`** — narrow with the existing `asRecord`/`asString` helpers if touching the runner.
- **No hard-coded config** — ports/paths come from `config.ts` (env-driven).
- **Frosted-glass tokens** if any UI is touched (a loading splash) — `var(--*)` only.
- **Validate before PR:** `npm run typecheck && npm run lint && npm run build`.

---

## 4. Pre-implementation verification (baseline)
```bash
npm install
npm run typecheck   # both workspaces
npm run lint
npm run build       # tsc (server) + vite build (web)
```
All must pass before starting. Also confirm Tauri prerequisites:
```bash
rustc --version && cargo --version    # install via https://rustup.rs if missing
xcode-select -p                       # Xcode CLT required for the macOS build
node -v                               # the runtime we will vendor (pin this version)
```

---

## 5. The four real risks (resolve these deliberately)

### 5.1 🔴 PATH — Finder-launched `.app` has a minimal PATH (the #1 sleeper bug)
A `.app` launched from Finder/Dock inherits a **minimal** PATH (`/usr/bin:/bin:/usr/sbin:/sbin`),
**not** your interactive shell PATH. The sidecar then spawns `claude`, `git`, and `gh`
as **bare commands** (`runner.ts`, `worktree.ts`, `phases.ts`) → `ENOENT`, every task
fails instantly.

**Fix (in Tauri Rust, before spawning the sidecar):** resolve the user's real login-shell
PATH and inject it into the sidecar's env.
```rust
// pseudocode
let shell = std::env::var("SHELL").unwrap_or("/bin/zsh".into());
let out = Command::new(&shell).args(["-lic", "printf %s \"$PATH\""]).output();
let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
// fallback if empty:
let path = if path.is_empty() {
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin".into()
} else { path };
// sidecar env: PATH = path
```
**Acceptance check:** from the built `.app` (launched via Finder, not terminal), a task
must successfully spawn `claude`, create a worktree (`git`), and reach `gh pr create`.
This is the single most important thing to verify end-to-end.

### 5.2 🟠 Writable paths — bundle is read-only & relocatable (`config.ts` refactor)
`config.ts` derives everything from `REPO_ROOT = resolve(import.meta.dirname,'../../..')`.
Inside a `.app` that resolves into the read-only app bundle → SQLite can't open WAL,
worktrees can't be created, `web/dist` isn't where it expects.

**Fix:** introduce a data-dir + explicit web-dist override, env-driven, dev-safe defaults.
```ts
// config.ts
const dataDir = process.env.ZMRNG_DATA_DIR ?? REPO_ROOT          // dev → REPO_ROOT
const configDir = path.join(dataDir, 'config')                   // registry lives here
// ...
dbPath:        path.join(dataDir, 'zmrng.db'),
worktreesDir:  path.join(dataDir, 'worktrees'),
webDist:       process.env.ZMRNG_WEB_DIST ?? path.join(REPO_ROOT, 'packages', 'web', 'dist'),
```
- `loadRepoCandidates()` reads `repos.json` from `configDir` (in dev that's
  `REPO_ROOT/config` — unchanged behavior ✓; in prod it's `~/Library/Application Support/zmrng/config`).
- `mkdirSync(dataDir, { recursive: true })` + `mkdirSync(worktreesDir, …)` at startup.
- `loadDotEnv()` may additionally try `path.join(dataDir, '.env')` (optional; env is
  passed by Tauri anyway).
- Tauri sets `ZMRNG_DATA_DIR=~/Library/Application Support/zmrng` and
  `ZMRNG_WEB_DIST=<resource>/web-dist` on the sidecar.

**Dev parity:** with no env set, `dataDir === REPO_ROOT` → today's behavior is byte-for-byte
preserved. No regression to `npm run dev`.

### 5.3 🟠 Sidecar packaging — Node + `better-sqlite3` native module
Bundling a Node service with a native addon is the real packaging work.

**Recommended approach (most reliable for native addons — real node + real node_modules,
no SEA blob magic):**
1. **Bundle server JS** with esbuild → `packages/desktop/sidecar/server.cjs`
   (`--platform=node --format=cjs --target=node20 --bundle --external:better-sqlite3`).
   Fastify, pino, ws, etc. bundle fine; **`better-sqlite3` stays external** (native).
2. **Vendor better-sqlite3** next to the bundle:
   `packages/desktop/sidecar/node_modules/better-sqlite3/` including its JS **and** the
   prebuilt `build/Release/better_sqlite3.node` (arm64). `require('better-sqlite3')` from
   `server.cjs` resolves here. (npm install already fetches the darwin-arm64 prebuilt via
   `prebuild-install`; copy that tree.)
3. **Vendor the Node binary** — copy a pinned Node release binary into the sidecar dir,
   named for Tauri's externalBin convention with the target triple
   (`node-aarch64-apple-darwin`).
4. **tauri.conf.json:**
   ```jsonc
   "bundle": {
     "externalBin": ["sidecar/node"],            // → node-aarch64-apple-darwin
     "resources": ["sidecar/server.cjs", "sidecar/node_modules/**/*", "web-dist/**/*"]
   }
   ```
5. **Spawn (Rust):** `app.shell().sidecar("node")?.args([resource("sidecar/server.cjs")])`
   with the env block. Resolve resources via `app.path().resource_dir()`.

**Spike first (de-risk early):** before wiring Tauri, prove the bundle runs standalone:
```bash
cd packages/desktop/sidecar
ZMRNG_DATA_DIR=/tmp/zmrng-test ZMRNG_WEB_DIST=../web-dist ./node server.cjs
# → curl localhost:4500/api/config returns JSON, sqlite db created in /tmp/zmrng-test
```
If that works outside Tauri, the rest is lifecycle glue.

*Fallback if vendoring node_modules is fiddly:* Node SEA (single-executable) is an option
but native-addon embedding is awkward — prefer the real-node approach above.

### 5.4 🟡 Port + health poll + lifecycle
- **Free port:** Rust binds `TcpListener` to `127.0.0.1:0`, reads the assigned port,
  drops the listener, passes it as `ZMRNG_PORT`. (Tiny TOCTOU race; acceptable solo.)
  Fallback to 4500 if needed.
- **Health poll:** after spawn, loop `TcpStream::connect("127.0.0.1:<port>")` (or HTTP
  GET `/api/config`) every ~200ms up to ~15s; only then navigate the window. Show a
  minimal frosted-glass loading splash until ready (tokens from `theme.css`).
- **Lifecycle:** hold the sidecar `CommandChild`; on `WindowEvent::CloseRequested` / app
  exit, `child.kill()` (SIGTERM). Node's existing SIGTERM handler →
  `manager.shutdown()` → each `Runner.kill()` SIGTERMs its `claude` child. Already wired
  in `index.ts` — **verify no orphaned `claude`/`git` processes after quit.**

---

## 6. Implementation steps

> **Branch first:** `git fetch origin && git checkout -b feat/zc/tauri-desktop-app origin/main`

### Step 1 — `config.ts`: writable data dir + web-dist override (§5.2)
- Add `dataDir` (env `ZMRNG_DATA_DIR`, default `REPO_ROOT`) and derive `dbPath`,
  `worktreesDir` from it; add `ZMRNG_WEB_DIST` override for `webDist`.
- Point the repo-registry loader at `path.join(dataDir,'config','repos.json')`.
- `mkdirSync` the data + worktrees dirs at startup.
- **Verify dev parity:** `npm run dev` behaves identically with no env set.
- Validate: `npm run typecheck && npm run lint`.

### Step 2 — Sidecar bundle pipeline (§5.3)
- Add esbuild as a desktop devDependency. Script `bundle:sidecar`:
  build server → esbuild → `packages/desktop/sidecar/server.cjs`; copy
  `better-sqlite3` tree (incl. prebuilt `.node`) into `sidecar/node_modules/`; copy the
  built `packages/web/dist` → `packages/desktop/web-dist`; vendor the pinned `node`
  binary with the triple name.
- **Spike:** run the bundle standalone (see §5.3) — must serve `/api/config` and create
  the db in a temp `ZMRNG_DATA_DIR` **before** touching Tauri.

### Step 3 — Scaffold Tauri (`packages/desktop/`)
- `npm create tauri-app` (or `tauri init`) — vanilla/no-framework frontend (we navigate
  to the sidecar URL, so the Tauri "frontend" is just the loading splash).
- `tauri.conf.json`: app name **zmrng**, window title, icon, `externalBin` + `resources`
  (§5.3 step 4), macOS min version.
- Add `@tauri-apps/cli` + the shell plugin (for sidecar) to the desktop package.

### Step 4 — Rust `main.rs`: lifecycle (§5.1, §5.4)
- Resolve login-shell PATH (§5.1).
- Pick free port; compute `ZMRNG_DATA_DIR` (`~/Library/Application Support/zmrng`) and
  `ZMRNG_WEB_DIST` (resource dir); `create_dir_all` the data dir.
- Spawn sidecar with env `{ ZMRNG_PORT, ZMRNG_DATA_DIR, ZMRNG_WEB_DIST, PATH }`.
- Health-poll; navigate the window to `http://localhost:<port>` when ready.
- On close/exit: kill the sidecar child.

### Step 5 — Loading splash (minimal UI)
- Tiny `index.html` in the Tauri frontend: centered "zmrng — starting engine…" on the
  frosted-glass surface. Use `theme.css` tokens (copy the few needed `--*` vars or import).
- Replaced by the real UI once Rust navigates to the sidecar URL.

### Step 6 — Wire workspace + scripts
- Root `package.json`: add `packages/desktop` to `workspaces`; scripts:
  - `desktop:dev` → `tauri dev` (sidecar = local `node dist/index.js` or the bundle).
  - `desktop:build` → `npm run build && npm run bundle:sidecar && tauri build`.
- Ensure root `npm run typecheck`/`lint`/`build` still pass (Rust is outside ESLint/tsc;
  the desktop JS — splash + config — stays lint-clean).
- `.gitignore`: add `packages/desktop/sidecar/`, `packages/desktop/web-dist/`,
  `packages/desktop/src-tauri/target/`, and Tauri build output.

### Step 7 — End-to-end verification on the built `.app` (§7)

### Step 8 — Docs
- Update `README.md` + `CLAUDE.md` (commands) with the desktop build/run flow.
- `.claude/files/PROJECT_CONTEXT.md`: note the desktop shell + data-dir location.
- If any non-obvious gotcha bit us (PATH, sqlite path), add it to `.claude/errors.md`.
- Run the `sync-docs` skill before the final commit.

---

## 7. Testing & validation strategy

**Levels 1–3 (must pass, unchanged gate):**
```bash
npm run lint
npm run typecheck
npm run build
```

**Level 4 — dev parity (no regression):**
```bash
npm run dev        # server + web still work on localhost exactly as before
```

**Level 5 — sidecar spike (standalone, pre-Tauri):**
```bash
ZMRNG_DATA_DIR=/tmp/zmrng-test ZMRNG_WEB_DIST=packages/desktop/web-dist \
  node packages/desktop/sidecar/server.cjs
# curl localhost:<port>/api/config → JSON; db appears under /tmp/zmrng-test
```

**Level 6 — built app, launched from Finder (the real test):**
1. `npm run desktop:build` → open the produced `.app` **from Finder** (not terminal — PATH!).
2. Window loads the zmrng UI (after splash).
3. Create a task against a registered repo → Start → **clarify** (proves `claude` spawns → PATH ✓).
4. Answer questions → `ZMRNG_READY` → **building** (proves `git` worktree ✓).
5. Reaches `gh pr create` / prints a PR URL → **review** (proves `gh` ✓).
6. Quit the app → confirm **no orphaned** `claude`/`node`/`git` processes
   (`pgrep -fl claude`), and the db/worktrees live under `~/Library/Application Support/zmrng`.

---

## 8. Acceptance criteria
- [ ] Double-click `.app` opens a native window showing the zmrng UI; no terminal, no browser.
- [ ] Launched from Finder, a task runs the full `clarify → building → review` arc against
      a real target repo (claude + git + gh all resolve — PATH fix verified).
- [ ] SQLite db and git worktrees are created under `~/Library/Application Support/zmrng/`,
      not inside the app bundle.
- [ ] `ANTHROPIC_API_KEY` is still stripped from the worker env (Max OAuth preserved).
- [ ] Quitting the app kills the sidecar and all `claude` children — no orphans.
- [ ] `npm run dev` is byte-for-byte unchanged (dev parity; no env → `REPO_ROOT` defaults).
- [ ] `npm run lint && npm run typecheck && npm run build` all pass.
- [ ] No new shared wire types (so the manual type mirror is untouched), or if added,
      mirrored into `packages/web/src/types.ts`.

---

## 9. Out of scope (explicitly deferred)
- Code-signing, notarization, `.dmg`/installer, Gatekeeper — personal-Mac, skip.
- Multi-arch (x64) / cross-platform (Windows/Linux) builds.
- Auto-update.
- Menubar/tray presence (chose native window).
- In-app repo-registry editor (still hand-edited `repos.json`, now in the data dir).
- Rewriting the engine in Rust (keep the Node sidecar).

---

## 10. Risks & confidence

| Risk | Severity | Mitigation |
|------|----------|------------|
| Finder-launch PATH → `claude/git/gh` not found | **High** | §5.1 login-shell PATH injection; verified in Level-6 test |
| `better-sqlite3` native module won't load in bundle | **High** | §5.3 real-node + vendored prebuilt `.node`; de-risk via standalone spike (Level 5) |
| Bundle read-only paths break sqlite/worktrees | Medium | §5.2 data-dir refactor; dev-parity default |
| Orphaned child processes on quit | Medium | reuse existing SIGTERM→`shutdown()`; verify in Level 6 |
| Tauri/Rust toolchain learning curve | Low | small Rust surface (~spawn + poll + kill); approved install |
| Port collision | Low | free-port pick in Rust |

**Confidence for one-pass implementation success: ~70%.**
The TypeScript/config changes (§5.2) and lifecycle Rust are straightforward. The two
High risks (PATH §5.1, sqlite bundling §5.3) are well-understood but each has a real
chance of a second iteration — the §5.3 standalone spike and the Finder-launch Level-6
test are the gates that catch them early. Budget one extra debugging pass for packaging.
```
```
