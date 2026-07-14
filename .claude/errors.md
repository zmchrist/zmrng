# Known Errors & Solutions

Check here before debugging. Add a new entry whenever a fix took >2 min, had a
non-obvious root cause, or is likely to recur. Template in
`.claude/rules/error-handling.md`.

---

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

### Worktree creation fails for target repos under ~/Documents (bundled .app only)
- **Error:** `worktree creation failed: Command failed: git -C /Users/<user>/Documents/Projects/<repo> worktree add -b <branch> … HEAD` → `fatal: Unable to read current working directory: Operation not permitted`. Happens **only** in the bundled `.app`, never in `npm run dev`. No tccd/sandbox denial is logged.
- **Cause:** macOS hard-protects `~/Documents` (also `~/Desktop`, `~/Downloads`) via TCC. The Finder-launched sidecar runs with cwd `/`; when `git -C <repo-under-Documents>` chdirs in and calls `getcwd()`, the path-walk reads back up through `~/Documents` and is denied → silent `EPERM`. It's silent (no tccd log) because the I/O is performed by `/usr/bin/git` (a shared Apple binary) under the hardened-runtime, different-team bundled `node` helper — that chain breaks TCC responsibility inheritance, so granting Full Disk Access to the `.app` **or** to the bundled `node` does **not** attach to the access. Confirmed by experiment: an identical task against a repo in `/Users/Shared` (non-protected) succeeds instantly with the same app/node/git.
- **Solution:** Keep drivable target repos **out of** the TCC-protected folders. Move them to `~/Developer` (Apple-blessed, never protected), `~/Projects`, `~/Code`, etc., and repath the registry (`<dataDir>/config/repos.json`, e.g. `~/Library/Application Support/zmrng/config/repos.json`). `npm run dev` is unaffected (the server inherits the Terminal's own Documents grant), so dev mode is a valid interim. FDA on the app is *not* a reliable fix while the app is ad-hoc-signed.
- **Files:** none (environment/packaging constraint, not a code bug). Touches `<dataDir>/config/repos.json` and `ZMRNG_PROJECTS_DIR` for auto-scan.
- **Date Found:** 2026-06-20
