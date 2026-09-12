# Plan: Seed the harness in the packaged desktop app

## Problem
Worker sessions launched from the packaged `.app` log:

```
HARNESS SEED — HARNESS SOURCE DIR NOT FOUND AT
.../zmrng.app/HARNESS — SKIPPED SEEDING
```

`seedHarness()` (`packages/server/src/worktree.ts`) copies zmrng's own harness
(`rules/`, `skills/`, `agents/`, `hooks/`, lifecycle `CLAUDE.md`) into each new
worker worktree. Its source dir defaults to `path.join(config.repoRoot, 'harness')`.

- **Dev**: the server module lives under `packages/server/{src,dist}`, so
  `config.repoRoot` (`../../..`) is the real repo root → `zmrng/harness` exists.
- **Packaged app**: the bundled `server.mjs` lives at
  `…/zmrng.app/Contents/Resources/sidecar/`, so `config.repoRoot` resolves *into*
  the read-only bundle (`…/zmrng.app`), where no `harness/` is shipped.

Result: in the `.app`, worker worktrees receive no seeded `.claude/` layer (seeded
hooks, rules, skills, agents). Tasks still run — the worker's real guardrails are
the `phases.ts` prompt strings — but the belt-and-suspenders seeding silently
no-ops with the operator-facing skip note.

Root cause is two-fold: (1) the bundle never ships `harness/`, and (2) nothing
points `seedHarness` at a bundled location.

## Approach
Mirror the existing `ZMRNG_WEB_DIST` precedent exactly. The Tauri shell already
sets `ZMRNG_WEB_DIST` to a bundled resource path that `config.ts` reads; do the
same for the harness via a new `ZMRNG_HARNESS_DIR` env var.

1. **`config.ts`** — add a pure, exported `resolveHarnessDir(env, repoRoot)`
   helper (mirrors `resolveAuthMode`/`resolveRegistry` shape): honour a trimmed,
   home-expanded `ZMRNG_HARNESS_DIR` override, else fall back to
   `path.join(repoRoot, 'harness')` (byte-for-byte today's dev behaviour). Add a
   `harnessDir: string` field to `Config`, set from `resolveHarnessDir(process.env,
   REPO_ROOT)` in `buildConfig()`.
2. **`worktree.ts`** — change `seedHarness`'s `harnessDir` default from
   `path.join(config.repoRoot, 'harness')` to `config.harnessDir`, so there is one
   source of truth.
3. **`phases.ts`** — drop the redundant explicit third arg at the `seedHarness`
   call so it uses the (now correct) default `config.harnessDir`.
4. **`bundle-sidecar.mjs`** — copy `repoRoot/harness` → `sidecar/harness`
   (following the `web-dist`/`config` copy steps already there).
5. **`tauri.conf.json`** — add `"sidecar/harness/**/*"` to `bundle.resources`.
6. **`main.rs`** — set `ZMRNG_HARNESS_DIR` to
   `resource_dir.join("sidecar/harness")` in the sidecar `envs` map, alongside
   `ZMRNG_WEB_DIST`.

### Rejected alternative
Deriving the bundled harness path implicitly from `resource_dir`/`repoRoot` inside
`config.ts` (no env var). Rejected: the codebase's established seam for "bundled
resource path" is a Tauri-set env var (`ZMRNG_WEB_DIST`, `ZMRNG_DATA_DIR`).
Reusing that pattern keeps `config.ts` free of bundle-layout assumptions and keeps
the dev path a literal no-op.

## Files
- `packages/server/src/config.ts` — `resolveHarnessDir` + `Config.harnessDir`
- `packages/server/src/worktree.ts` — `seedHarness` default
- `packages/server/src/phases.ts` — call site
- `packages/desktop/scripts/bundle-sidecar.mjs` — copy harness into sidecar
- `packages/desktop/src-tauri/tauri.conf.json` — resource glob
- `packages/desktop/src-tauri/src/main.rs` — `ZMRNG_HARNESS_DIR` env
- `packages/server/test/config.test.ts` — new tests (below)

Type mirror: `Config` is server-only (declared in `config.ts`, not `types.ts`), so
no `packages/web/src/types.ts` change is required.

## Test strategy
- **Command**: `npm test -w @zmrng/server` (then full `npm run typecheck && npm run
  lint && npm test && npm run build`).
- **New tests** in `packages/server/test/config.test.ts`, describing
  `resolveHarnessDir`:
  1. no env → returns `path.join(repoRoot, 'harness')` (dev behaviour unchanged).
  2. `ZMRNG_HARNESS_DIR` set → returns that path resolved (override wins), proving
     the packaged app can point at the bundled `sidecar/harness`.
  3. `ZMRNG_HARNESS_DIR` with a leading `~` → home-expanded + resolved.
  4. blank/whitespace `ZMRNG_HARNESS_DIR` → treated as unset (falls back).
  Each proves the precedence branch that wires the packaged fix without shipping a
  real `.app`.
- **Existing `seedHarness.test.ts`** already covers the copy behaviour given a
  source dir; unchanged and must stay green.
- **Untestable here**: the Rust `main.rs` env wiring and the `tauri.conf.json`
  resource glob (no Rust/Tauri test harness in this repo). Verified manually by a
  `npm run desktop:build` and confirming the skip note is gone; noted under
  **Testing** in the PR body.
