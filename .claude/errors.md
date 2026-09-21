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

### Whole machine bogs down / freezes after ~30 min of an active worker run
- **Error:** No crash — during a long autonomous worker run (dev server AND the packaged
  desktop app alike) the whole Mac progressively bogs down and eventually stalls. Idle is
  fine; it degrades only while a worker (or chat) is actively streaming.
- **Cause:** A per-token React render storm on two axes. (1) FREQUENCY — every stream-json
  `partial` token calls `setLive` in `App.onWs`, and since `live` is App-level state each
  token forced a full-app re-render; a fast turn emits many tokens/sec. (2) COST — that
  re-render cascaded through every always-mounted subtree (`WorkspaceView`, plus hidden
  `Board`/`TeamView`/`KbView` behind `display:none`), and `WorkerLog` rebuilt its entire
  `events.map(renderEvent)` list (capped at MAX_EVENTS=2000) on every one of those renders.
  So a long run reconciled ~2000 elements × dozens of times/sec for many minutes, pinning
  the CPU + GPU (worse in the desktop WKWebView with the frosted-glass `backdrop-filter`
  compositing), which heats the laptop, thermally throttles, and reads as a freeze.
- **Solution:** Attack both axes. (a) Coalesce partial tokens into at most one `setLive`
  per animation frame — buffer tokens in a ref and flush on `requestAnimationFrame`
  (`App.tsx`: `liveBufRef`/`rafRef`/`flushLive`/`resetLiveBuffer`; reset on task
  select/removal/finalize + unmount so a stale flush never appends to the wrong task).
  (b) Memoize the cost: `useMemo(() => events.map(renderEvent), [events])` in `WorkerLog`
  so the 2000-element list is skipped on live-token renders (events ref is stable per
  token), and wrap the always-mounted hidden panels `Board`/`TeamView`/`KbView` in
  `React.memo` with stable callback props (`onTeamHandleChange` via `useCallback`) so a
  per-frame App re-render no longer cascades into subtrees that don't consume `live`.
- **Files:** `packages/web/src/App.tsx`, `packages/web/src/components/WorkerLog.tsx`,
  `packages/web/src/components/Board.tsx`, `.../TeamView.tsx`, `.../KbView.tsx`
- **Date Found:** 2026-09-12

### Security-scan gate: `semgrep`/`osv-scanner` absent on dev → the default runner is untested
- **Error:** No runtime error in tests — but `defaultScanRunnerFactory` in `scanRunner.ts`
  (execFile semgrep + osv-scanner) is exercised by **zero** automated tests. Every
  state-machine test injects a `FakeScanRunner` returning fixture JSON, because `semgrep`
  and `osv-scanner` are not installed on the dev Mac.
- **Cause:** By design (D4/D5): the real scanners are heavy, vendored/offline, and
  auto-provisioned on first use in the target worktree — not something to install on the
  dev box or hit the network for during CI. So the code path that shells out to the real
  binaries and parses their real JSON has never run against real output.
- **Solution:** Treat "the real tools emit exactly these JSON shapes" as a **deferred,
  orchestrator/user-owned hand-verification**, run post-merge against a repo with a planted
  vuln (a known-CVE dep for osv, an injectable pattern for semgrep). Until then, trust the
  gate's *state machine* (fully tested via FakeScanRunner) but not the *parser fidelity*.
  Two known live-run watch-outs: (1) `semgrep --baseline-commit <merge-base>` needs real
  git history in the worktree — a **shallow** clone can make the baseline diff empty or
  error; ensure the worktree has the merge-base commit. (2) fail-closed is intentional —
  any scanner crash / unparseable output is a red-block, never a pass, so a mis-provisioned
  scanner parks the task `blocked`, it does not silently green-light a merge.
- **Files:** `packages/server/src/scanRunner.ts`, `packages/server/src/phases.ts`
  (`onScanReady`), `packages/server/test/taskManager.test.ts` (`FakeScanRunner`)
- **Date Found:** 2026-09-10

### `seedHarness()` crashes when `harness/hooks/__pycache__` exists on disk
- **Error:** `EISDIR: illegal operation on a directory, copyfile` (or similar) thrown from
  `seedHarness()` while seeding a fresh worktree's hooks.
- **Cause:** `seedHarness()` iterates every entry in `harness/hooks/` and `copyFileSync`s it
  into the worktree's `.claude/zmrng-hooks/`, assuming every entry is a flat `.py` file. If a
  hook script was ever run directly with `python3` (e.g. while debugging a hook by hand),
  Python leaves a `__pycache__/` directory behind in that same folder — `copyFileSync` on a
  directory throws instead of copying it.
- **Solution:** Before copying, `statSync` each entry and skip anything that is not a plain
  file (`!statSync(src).isFile()`). Covered by a regression test that plants a
  `__pycache__/*.pyc` file and asserts `seedHarness()` still succeeds and the real hooks land.
- **Files:** `packages/server/src/worktree.ts` (`seedHarness`), `packages/server/test/seedHarness.test.ts`
- **Date Found:** 2026-09-12

### Host freezes / stays frozen after closing all zmrng browser tabs
- **Error:** The whole machine bogs down or freezes; closing every browser tab (including
  zmrng) does **not** help — it stays frozen. Feels like zmrng is "still running" after quit.
- **Cause:** A browser tab is only a viewer — the node server and every headless `claude`
  worker (~325–350 MB RSS each, plus their tool subprocesses) live in a separate process the
  tab close never touches. Historically, workers were killed by bare PID, so `claude`'s
  grandchildren (subagent claudes, bash, git, semgrep, osv-scanner, vitest, tsc, vite) could
  orphan to launchd (PPID 1) and keep burning CPU/RAM. A few leaked trees freeze the host.
- **Solution:** Fixed by spawning workers `detached: true` and group-signalling the whole
  tree (`runner.ts` `kill()`/`killGroupSync()`), a `process.on('exit')` backstop
  (`manager.hardKillAll()`), and a ~6s liveness-poll in the Tauri quit path (`main.rs`)
  instead of the old blind 800 ms hard-kill. To *diagnose* a suspected leak (or reap
  survivors from an older build): run `scripts/zmrng-doctor.sh` (report) or
  `scripts/zmrng-doctor.sh --kill` (reap ORPHANs, never the live app). Note: to stop zmrng
  you must quit the app / Ctrl-C the server — closing the tab alone leaves it running.
- **Files:** `packages/server/src/runner.ts`, `packages/server/src/index.ts`,
  `packages/server/src/phases.ts`, `packages/desktop/src-tauri/src/main.rs`,
  `scripts/zmrng-doctor.sh`
- **Date Found:** 2026-09-20

### `verify.sh`'s combined test step hid a red server suite behind a green web tail
- **Error:** `.claude/verify.sh` reported `FAIL test` but the printed "first 40 lines"
  of output were actually the **last** 40 lines (`tail -n "$HEAD_LINES"` despite the
  comment/heading saying "first"), and since `npm run test --workspaces` runs the web
  workspace last, a green web suite's output buried a red server suite's failure
  entirely — the operator/agent saw a passing-looking tail and had to go re-run
  `npm run test -w @zmrng/server` by hand to find the actual failure.
  Distinct from vitest fork-count flakes (see below) — this was a **reporting** bug: the
  underlying failure was real, just hidden.
- **Cause:** One `test` step spanning both workspaces, combined with a `tail` that
  contradicted its own "first N lines" framing.
- **Solution:** Split into `test:server` / `test:web` steps (`npm run test -w
  @zmrng/<ws>`, dispatched via a `run_step` helper) so the summary names the failing
  workspace, switched the head-window print to actual `head -n 40`, and added a
  labelled `tail -n 20` block whenever output exceeds the head window so nothing long
  silently loses its tail either.
- **Files:** `.claude/verify.sh`
- **Date Found:** 2026-09-21

### Load-induced vitest flakes when multiple workers validate concurrently
- **Error:** Server/web test suites fail intermittently (timeouts, act()-warnings,
  effects that never resolve) only when several zmrng task workers are validating at
  the same time — the same suite is green in isolation. `KbView.spaces.test.tsx` was
  the most visible case: a passive effect scheduled by resolving `getSpaces` (which
  sets `spaceId` and schedules a *second* effect that calls `api.getSpaceTree`) could
  still be pending when a test's `afterEach` ran under load, and `vi.restoreAllMocks()`
  resets a plain `vi.fn()` to return `undefined` — so the pending effect got `undefined`
  instead of a promise and threw.
- **Cause:** Two compounding issues: (1) vitest's default fork pool claims `cores - 1`
  per run with no cap, so several worker validation gates running at once
  oversubscribed the host; (2) `KbView.spaces.test.tsx` only waited for the switcher's
  first effect (`getSpaces`) to settle, not the second, dependent effect
  (`getSpaceTree`) it triggers — under load that second effect was still in flight at
  teardown, racing `afterEach`'s mock reset.
- **Solution:** (1) Cap the fork pool — `vitest.config.ts` reads
  `ZMRNG_VITEST_MAX_FORKS` (default 3) into `test.poolOptions.forks.maxForks`;
  `runner.ts` sets it to `2` for worker children. (2) Fix the test itself:
  `renderKb()` now also `waitFor(() => expect(getSpaceTree).toHaveBeenCalled())` before
  returning, so the second effect has started before the test proceeds, and
  `afterEach` uses `vi.clearAllMocks()` (clears call history only) instead of
  `vi.restoreAllMocks()` (which would reset the mocks back to returning `undefined`
  and reintroduce the same race for any effect still pending at teardown).
- **Files:** `packages/server/vitest.config.ts`, `packages/web/vitest.config.ts`,
  `packages/server/src/runner.ts`, `packages/web/test/KbView.spaces.test.tsx`
- **Date Found:** 2026-09-21
