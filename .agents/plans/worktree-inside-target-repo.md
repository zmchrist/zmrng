# Plan: Worktrees live inside the selected target repo

## Feature description

Today every task's git worktree is created under a **global** data directory —
`~/Library/Application Support/zmrng/worktrees/<shortId>` in the bundled app
(or `<REPO_ROOT>/worktrees/<shortId>` in dev). The operator wants each task's
worktree to be created **directly inside the target repo that was selected for
the task**, under that repo's own `worktrees/` folder.

Examples (operator's words):
- task targeting **zmrng** → `/Users/tiofeliz/Documents/Projects/zmrng/worktrees/<shortId>`
- task targeting **Pheme** → `/Users/tiofeliz/Documents/Projects/Pheme/worktrees/<shortId>`

In addition, this convention must be captured as a **rule** under
`.claude/rules/` so future workers and contributors know worktrees always live
inside the selected target repo.

## User story

```
As the zmrng operator
I want each task's worktree created inside the target repo I selected (under its worktrees/ folder)
So that the working tree lives with the repo it belongs to, not in a separate global Application Support folder
```

- **Feature type:** Enhancement (behavioral change to worktree location) + documentation (new rule).
- **Complexity:** Low–Medium. Small, mostly mechanical surface, but it changes a core path that the bundled app depends on, so the edge cases matter.
- **Affected workspace:** `packages/server` only. No frontend, no web type-mirror impact (the changed `Config` field is server-only; the web `types.ts` mirror covers only `Task`/`Phase`/`WsEvent`/usage/`RepoTarget`, not `Config`).

## Context: how it works today

Read these before editing:

- `packages/server/src/config.ts`
  - `DATA_DIR` (line 28) — writable per-user dir: `REPO_ROOT` in dev, `~/Library/Application Support/zmrng` in the bundled app (via `ZMRNG_DATA_DIR`).
  - `buildConfig()` (lines 236–282) computes `const worktreesDir = path.join(DATA_DIR, 'worktrees')` (line 261), `mkdirSync(worktreesDir, …)` (line 265), and returns it as `Config.worktreesDir` (line 278).
  - `Config.worktreesDir: string` declared at line 89.
- `packages/server/src/phases.ts`
  - `start()` calls `createWorktree(repo.path, repo.defaultBranch, config.worktreesDir, taskId, task.title)` at lines 499–505. `repo` is the resolved `RepoTarget` (line 488) and `repo.path` is the absolute path of the selected target repo.
  - No `path` import yet — currently imports start at line 1 (`node:crypto`).
- `packages/server/src/worktree.ts`
  - `createWorktree(repoPath, defaultBranch, worktreesDir, taskId, title)` already takes `worktreesDir` as a **parameter**, `mkdirSync(worktreesDir, { recursive: true })` on demand (line 63), and builds `worktreePath = path.join(worktreesDir, shortId)` (line 66). **No change needed here** — it already creates whatever dir it's handed.
  - `removeWorktree(targetRepo, worktreePath)` and `syncLocalAfterMerge(repoPath, …)` already operate against `repo.path`, so worktree teardown and local sync keep working unchanged.

`worktreesDir` references found (grep): `config.ts` (define + mkdir + field), `phases.ts:502` (the only call site), `worktree.ts` (the function parameter — stays). Nowhere else.

## Patterns / conventions to follow

- `backend-typescript.md`: no `any`; structured Pino logging; read config from `config.ts`, don't inline paths. We resolve the worktrees dir from the already-resolved `repo.path` at the call site (no new hard-coded path).
- The repo's own `.gitignore` already has `worktrees/*` + `!worktrees/.gitkeep` (lines 7–8), so worktrees created inside the **zmrng** repo are ignored. See "Risks" for other target repos.
- New rule files live in `.claude/rules/` (peers: `backend-typescript.md`, `frontend-react.md`, `error-handling.md`, `testing.md`, `planning-workflow.md`). Match their tone/format (short, imperative, code-fenced examples).

## Implementation tasks

### Task 1 — `packages/server/src/config.ts`: stop computing a global worktrees dir

1. Remove the `worktreesDir: string` field from the `Config` interface (line 89).
2. In `buildConfig()`:
   - Delete `const worktreesDir = path.join(DATA_DIR, 'worktrees')` (line 261).
   - Delete `mkdirSync(worktreesDir, { recursive: true })` (line 265). **Keep** `mkdirSync(DATA_DIR, { recursive: true })` (line 264) — the SQLite db (`dbPath`) still lives in `DATA_DIR`.
   - Remove `worktreesDir,` from the returned object (line 278).
3. Leave everything else (`dataDir`, `dbPath`, `webDist`, registry logic) untouched.

Rationale: there is no longer a single global worktrees location; each task derives it from its target repo at spawn time.

### Task 2 — `packages/server/src/phases.ts`: derive the worktrees dir from the target repo

1. Add a `path` import at the top of the file:
   ```typescript
   import path from 'node:path'
   ```
   (Place it with the other `node:` imports near line 1, e.g. directly under the `node:crypto` import.)
2. In `start()`, change the `createWorktree` call (lines 499–505) to pass `path.join(repo.path, 'worktrees')` instead of `config.worktreesDir`:
   ```typescript
   wt = await createWorktree(
     repo.path,
     repo.defaultBranch,
     path.join(repo.path, 'worktrees'),
     taskId,
     task.title,
   )
   ```
   `repo` is already resolved above (line 488: `repoById(task.repoId) ?? repoById(config.defaultRepoId)`), and `createWorktree` will `mkdirSync` the `<repo>/worktrees` dir on demand.
3. No other call site uses `config.worktreesDir`, so no further edits in this file.

### Task 3 — `.claude/rules/worktree-location.md`: document the convention

Create a new rule file capturing the convention and its rationale. Suggested content:

```markdown
# Worktree Location

## Rule
Every task's git worktree is created **inside the selected target repo**, under
that repo's own `worktrees/` folder:

```
<repo.path>/worktrees/<shortId>
```

Examples:
- task targeting **zmrng** → `~/Documents/Projects/zmrng/worktrees/<shortId>`
- task targeting **Pheme** → `~/Documents/Projects/Pheme/worktrees/<shortId>`

Worktrees are **never** placed in a separate global data dir (e.g.
`~/Library/Application Support/zmrng/worktrees/`). The working tree lives with
the repo it belongs to.

## How it's wired
- `phases.ts` → `start()` resolves the selected `RepoTarget` and passes
  `path.join(repo.path, 'worktrees')` to `createWorktree(...)`.
- `worktree.ts` → `createWorktree()` `mkdirSync`s that dir on demand and checks
  out `<dir>/<shortId>` on a fresh `feat/zmrng/<slug>-<shortId>` branch.
- Teardown (`removeWorktree`) and post-merge `syncLocalAfterMerge` already run
  against `repo.path`, so the worktree's lifecycle stays anchored to its repo.

## Gitignore the worktrees dir in target repos
Because the worktree now lives inside the target repo's working tree, add
`worktrees/` to that repo's `.gitignore` so the nested checkout never shows up
as untracked content (zmrng's own `.gitignore` already ignores `worktrees/*`).
```

(Keep the wording tight and consistent with the other rule files.)

## Risks & edge cases (must be considered, not silently dropped)

1. **Nested worktree pollutes a target repo's `git status`.** A linked worktree
   created at `<repo>/worktrees/<shortId>` sits inside the target repo's main
   working tree. Git does **not** auto-ignore registered worktree paths, so the
   *main* checkout of a repo that does not ignore `worktrees/` (e.g. Pheme) will
   show `worktrees/` as untracked. Mitigation: the new rule tells contributors to
   add `worktrees/` to the target repo's `.gitignore`. We do **not** edit other
   repos' `.gitignore` from here (out of scope, and not always desired). zmrng
   itself already ignores `worktrees/*`. Note: the worker operates *inside* the
   worktree (cwd = `<repo>/worktrees/<shortId>`), which is itself a clean
   checkout root with no nested `worktrees/` entry, so the worker's own
   `git status`/diff and PR are unaffected — this only concerns the main checkout.
2. **zmrng self-entry in the bundled app.** For the auto-registered `zmrng`
   self-entry, `repo.path === REPO_ROOT`, which in the bundled `.app` resolves
   *inside the read-only app bundle*. Creating a worktree there will fail. This
   is acceptable/pre-existing: the bundled app is meant to drive **other** repos
   at their real `~/Documents/Projects/...` paths; driving the in-bundle self
   copy was never a real workflow. The failure is already handled gracefully —
   `createWorktree` throwing is caught in `start()` and fails just that task via
   `this.fail(...)`, never the server. We do not add a writability fallback (that
   would re-introduce the global dir this task removes). If self-driving from the
   bundle is ever wanted, that's a separate task.
3. **Existing in-flight worktrees** under the old global dir are unaffected by
   this change (they're tracked by absolute path in the DB); only *new* tasks use
   the new location. No migration needed.

## Testing strategy

No test framework — validation is typecheck + lint + build, plus a manual smoke.

```bash
npm run typecheck   # both workspaces — catches the removed Config field / any drift
npm run lint
npm run build
```

Manual smoke (per CLAUDE.md — touching the engine):
```bash
npm run dev         # server + web
# create a task targeting a non-zmrng repo (e.g. Pheme), Start → clarify
# confirm the worktree appears at <repo.path>/worktrees/<shortId>
#   (the "worktree <path> on <branch>" operator-log line shows the path)
# confirm clarify → ZMRNG_READY → building proceeds normally
```

App rebuild (per CLAUDE.md "App-only focus" — a change is not done until the
`.app` ships it):
```bash
npm run desktop:build   # build → bundle:sidecar → tauri build → fresh .app
```

## Validation commands

```bash
npm run typecheck
npm run lint
npm run build
```

## Acceptance criteria

- [ ] `Config` no longer has a `worktreesDir` field; `buildConfig()` no longer computes or mkdirs a global worktrees dir; `mkdirSync(DATA_DIR)` (for the db) is preserved.
- [ ] `phases.ts` `start()` passes `path.join(repo.path, 'worktrees')` to `createWorktree(...)`; `path` is imported.
- [ ] A new task creates its worktree at `<selected repo path>/worktrees/<shortId>` (verified via the operator-log "worktree … on …" line).
- [ ] `.claude/rules/worktree-location.md` exists, documents the convention + the gitignore guidance.
- [ ] `npm run typecheck && npm run lint && npm run build` all pass.
- [ ] The desktop app is rebuilt (`npm run desktop:build`) so the shipped `.app` carries the new behavior.

## Files touched

| File | Change |
|------|--------|
| `packages/server/src/config.ts` | Remove `worktreesDir` from `Config` + `buildConfig()` (keep `DATA_DIR` mkdir) |
| `packages/server/src/phases.ts` | Add `path` import; pass `path.join(repo.path, 'worktrees')` to `createWorktree` |
| `.claude/rules/worktree-location.md` | New rule documenting the convention + gitignore guidance |

`packages/server/src/worktree.ts` — **no change** (already takes the dir as a parameter and mkdirs it).

## Confidence

**High (≈9/10)** for one-pass success — the code surface is tiny and fully
specified; the only judgment calls (the two risks above) are resolved in this
plan.
