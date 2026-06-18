# Plan: zmrng — self-harness scaffold + multi-target repo selection

> **Status:** Planned · **Type:** Tooling + Enhancement · **Complexity:** Medium-High
> **Target repo:** `~/Documents/Projects/zmrng` (standalone; NOT Pheme)
> **Plan home:** Pheme `.agents/plans/` for paper-trail continuity (zmrng convention).
> **Builds on:** `zmrng.md` (v1 orchestrator) and `zmrng-task-controls.md` (per-task model/effort/style).

## Goal

Two related deliverables:

- **Part A — Self-harness.** Scaffold a Claude Code working harness (`CLAUDE.md`,
  `.claude/`, `.agents/`) *into* the zmrng repo, tailored to zmrng's own stack and
  stripped of all Pheme domain (Modbus, substations, copper theme, power/water/etc.).
  Goal: Claude Code helps you *build zmrng* the same way it builds Pheme.
- **Part B — Multi-target runtime.** Generalize zmrng's hardcoded `ZMRNG_TARGET_REPO`
  so the operator chooses, per task, which repo zmrng drives (pheme,
  bluebeam-pdf-converter, …) from a configured list shown as a dropdown in the New
  Task form.

The two parts are independent: Part A is files-only (no zmrng code), Part B is a code
change to the running tool. Ship in either order.

## Decisions (locked in workshop 2026-06-17)

| Decision | Choice |
|---|---|
| Harness flavor | **zmrng-tailored** — rules/agents/commands reflect zmrng's real stack (Fastify 5 + @fastify/websocket + better-sqlite3 + pino + React 19 + Vite + CSS Modules + frosted-glass tokens + `child_process` claude runner). Pheme domain fully stripped. |
| Module scope | **Lean core** — PIV loop, domain rules, key agents, validation commands, sync-docs + caveman + create-task skills, `.agents/plans`+`tasks`. **Skip** missions framework, ralph, patrol/CI loops, GitHub-automation heavy machinery. |
| Target picker | **Config list + per-task dropdown** — repos defined in a config file (`config/repos.json`) with env fallback; `GET /api/repos` feeds a New Task `<select>`; each task records its target repo. |
| Plan home | This file in Pheme `.agents/plans/`; once zmrng has its own `.agents/plans/`, future zmrng plans may live there. |
| Hooks | zmrng already lives under `~/Documents/Projects/` and **inherits** the universal `Projects/CLAUDE.md` harness (security_guard / post_tool_use_lint / stop_validate). Do **not** duplicate those hooks in zmrng. zmrng's `CLAUDE.md` only overrides/extends. |

---

# Part A — Self-harness scaffold

## Generalization rules (apply to every ported file)

1. **Strip Pheme domain entirely:** no Modbus/float-decode/CT_RATIO, no SS1–SS4 /
   substations, no copper/Cinzel/Rajdhani theme, no power/water/network/audio/hvac/
   weather, no Neon/Drizzle, no `@pheme/shared`.
2. **Keep the shared TS-monorepo stack** that zmrng actually uses: Fastify 5,
   `@fastify/websocket`, better-sqlite3 (WAL), pino, React 19 + Vite, CSS Modules.
3. **zmrng-specific conventions to bake in** (from `zmrng-task-controls.md`):
   - **No shared package.** Server types in `server/src/types.ts` are **manually
     mirrored** into `web/src/types.ts`; every type change touches both.
   - **Frosted-glass design tokens** from zmrng `theme.css` (`--surface`, `--blur`,
     `--accent`, `--radius-sm`, `--transition`, `--border`, `--text-dim`). Never copper.
   - **Runner safety:** strip `ANTHROPIC_API_KEY` from child env (Max OAuth only);
     never extract/proxy the OAuth token.
   - **Caveman narration** is zmrng's default worker register; code/commits/PRs stay
     normal English.
4. **Validation everywhere:** `npm run typecheck && npm run lint && npm run build`
   (no test framework yet).

## File manifest (created in `~/Documents/Projects/zmrng/`)

```
zmrng/
├── CLAUDE.md                              # NEW — project identity + conventions (see below)
├── .claude/
│   ├── settings.local.json                # generic permissions (no Pheme paths)
│   ├── rules/
│   │   ├── backend-typescript.md          # Fastify 5 / better-sqlite3 / pino / child_process runner patterns
│   │   ├── frontend-react.md              # React 19 / Vite / CSS Modules / frosted-glass tokens / WS hook
│   │   ├── error-handling.md              # generic diagnose→fix→document protocol + errors.md template
│   │   ├── testing.md                     # pre-impl checklist (typecheck+lint+build); no framework yet
│   │   └── planning-workflow.md           # workshop period; plans live in .agents/plans/
│   ├── commands/
│   │   ├── core_piv_loop/
│   │   │   ├── plan-feature.md
│   │   │   ├── execute.md
│   │   │   ├── prime.md                    # generalized: reads zmrng CLAUDE.md + key files
│   │   │   ├── prime-backend.md            # Fastify/runner/db orientation
│   │   │   └── prime-frontend.md           # React/components/theme orientation
│   │   ├── validation/
│   │   │   ├── validate.md
│   │   │   ├── full-validation.md
│   │   │   ├── pre-flight.md
│   │   │   ├── code-review.md
│   │   │   ├── code-review-fix.md
│   │   │   ├── execution-report.md
│   │   │   └── system-review.md
│   │   └── git/
│   │       ├── commit.md
│   │       └── push.md
│   ├── agents/
│   │   ├── qa.md                           # run typecheck/lint/build → PASS/FAIL (never fixes)
│   │   ├── fixer.md                        # diagnose + minimal fix + document
│   │   ├── code-reviewer.md
│   │   ├── backend-specialist.md           # Fastify/WS/SQLite/runner expert
│   │   ├── frontend-specialist.md          # React/CSS Modules/frosted-glass expert
│   │   └── doc-updater.md                  # syncs CLAUDE.md + docs + errors.md
│   ├── skills/
│   │   ├── sync-docs/SKILL.md              # generalized to zmrng's doc set
│   │   ├── create-task/                    # generic (SKILL.md + template.md + examples.md)
│   │   └── caveman/                        # copy verbatim — already domain-neutral
│   ├── docs/
│   │   ├── services-reference.md           # zmrng services (runner, phases, db, worktree, ws)
│   │   └── implementation-history.md       # seeded from zmrng.md + task-controls.md milestones
│   ├── files/
│   │   ├── PROJECT_CONTEXT.md              # zmrng vision/decisions/roadmap
│   │   └── FUTURE_IDEAS.md                 # deferred features (cost dashboard, kanban, etc.)
│   └── errors.md                           # seeded with known zmrng gotchas (API-billing leak, bodyless-POST, stream-json parsing)
└── .agents/
    ├── README.md                           # trimmed AI-team framework doc (lean core only)
    ├── plans/.gitkeep
    ├── tasks/.gitkeep
    ├── code-reviews/.gitkeep
    ├── system-reviews/.gitkeep
    ├── handoffs/.gitkeep
    └── scripts/loop.sh                      # generic autonomous loop driver (Pheme specifics stripped)
```

> **Not ported (lean-core exclusions):** `.missions/`, `ralph/`, `.claude/commands/patrol/`,
> `auto-issue.md` / `fix-issue.md` / `monitor-ci.md` / `respond-review.md` / `triage-issues.md`,
> mission agents (orchestrator/worker/scrutiny-validator/user-test-validator), `.claude/PRD.md`,
> `.claude/reference/*` (Acuvim xlsx etc.), Pheme deploy `scripts/`, `relay/`, `docker/`.

## zmrng `CLAUDE.md` outline (the authoritative new file)

- **What this is:** autonomous task-orchestrator GUI. Spawns the headless `claude`
  binary (Max OAuth) per task against a *target* repo; drives plan→implement→validate→PR;
  streams events to a React frosted-glass UI over WebSocket.
- **Tech stack:** npm workspaces (`server`, `web`); Fastify 5 + @fastify/websocket +
  better-sqlite3 (WAL) + pino; React 19 + Vite + CSS Modules; `child_process` claude
  runner; no cloud; no test framework — `npm run typecheck && npm run lint && npm run build`.
- **Project structure:** `packages/server/src/{index,config,db,types,runner,phases,worktree,ws}.ts`;
  `packages/web/src/{main,App,theme.css,api,useWs,types}.ts(x)` + `components/`.
- **Key conventions:** manual server↔web type mirror (no shared pkg); frosted-glass
  tokens only; strip `ANTHROPIC_API_KEY` in runner; caveman narration default;
  per-task model/effort/style.
- **Key services:** runner (spawn/parse stream-json), phases (state machine + system
  prompts), db (SQLite schema + prepared stmts + idempotent migrations), worktree (git
  worktree per task), ws (broadcast hub).
- **Collaboration:** solo operator → drop Pheme's ZC/CE two-dev protocol; keep
  branch-before-code + plans-before-code + branch-from-origin/main.
- **PIV loop + context-tier references** pointing at the new `.claude/rules` and `.claude/docs`.
- **Inherits** universal `Projects/CLAUDE.md` (hooks, PIV table) — note this; don't restate hooks.

## Part A implementation steps

1. Create directory tree (manifest above); `.gitkeep` the empty `.agents/*` dirs.
2. Write `CLAUDE.md` (outline above).
3. Port + generalize the 5 `.claude/rules/*` from Pheme (strip domain per rules §1–4).
4. Port + generalize `.claude/commands/core_piv_loop/*`, `validation/*`, `git/*`.
5. Port + generalize the 6 `.claude/agents/*` (rewrite tool/role descriptions for zmrng files).
6. Copy `caveman` skill verbatim; generalize `sync-docs` + `create-task` skills.
7. Write `.claude/docs/services-reference.md` (zmrng services) + seed `implementation-history.md`.
8. Write `.claude/files/PROJECT_CONTEXT.md` + `FUTURE_IDEAS.md`; seed `.claude/errors.md`.
9. Write generic `.agents/README.md` + `.agents/scripts/loop.sh` (strip Pheme task refs).
10. Write `.claude/settings.local.json` (generic allow/deny; no Pheme-specific paths).
11. Copy this plan into `zmrng/.agents/plans/` for the standalone paper trail.
12. Sanity: open Claude Code in `~/Documents/Projects/zmrng`, run `/prime`, confirm it
    orients on zmrng (not Pheme) and `/validate` maps to the right commands.

---

# Part B — Multi-target repo selection

## Current state (single hardcoded target)

- `packages/server/src/config.ts` — `ZMRNG_TARGET_REPO` (default `~/Documents/Projects/pheme`).
- `worktree.ts` — `git worktree add worktrees/<id> origin/main` in the single repo.
- `phases.ts` — `systemPrompt()` identifies the worker as a **Pheme** worker; `spawn()`
  uses the single repo path as cwd.
- `runner.ts` — passes `--add-dir <worktree>`; cwd = target repo.

## Target model

A **repo registry**: `config/repos.json` at the zmrng root (machine-specific paths →
gitignore it; ship `config/repos.example.json`):

```json
[
  { "id": "pheme",     "label": "Pheme",                 "path": "/Users/tiofeliz/Documents/Projects/pheme",                 "defaultBranch": "main" },
  { "id": "bluebeam",  "label": "Bluebeam PDF Converter", "path": "/Users/tiofeliz/Documents/Projects/bluebeam-pdf-converter", "defaultBranch": "main" }
]
```

- **Fallback chain** in `config.ts`: `config/repos.json` → `ZMRNG_REPOS` env
  (comma-separated `id:path` pairs) → legacy single `ZMRNG_TARGET_REPO` (wrapped as one
  entry `{id:'default'}`) so existing setups keep working.
- **Startup validation:** each `path` must exist and be a git repo
  (`git rev-parse --is-inside-work-tree`); skip + `log.warn` invalid entries.
- **Default target:** `ZMRNG_DEFAULT_REPO` id, else first valid entry.

## Implementation tasks (execution order)

### 1. Server types — `packages/server/src/types.ts`
- Add `interface RepoTarget { id: string; label: string; path: string; defaultBranch: string }`.
- Extend `Task`: `repoId: string` (which target this task drives).

### 2. Config — `packages/server/src/config.ts`
- Load + validate the repo registry (fallback chain above); export `repos: RepoTarget[]`
  and `defaultRepoId`. Helper `repoById(id): RepoTarget | undefined`.

### 3. DB — `packages/server/src/db.ts`
- Idempotent migration (same `PRAGMA table_info` + `ALTER` pattern as `zmrng-task-controls.md`):
  add `repo_id TEXT`. Add to `SCHEMA` for fresh DBs.
- `TaskRow` + `rowToTask` map `repo_id` → `repoId`. `createTask` accepts + inserts `repoId`.
  Existing rows: backfill `repo_id` to `defaultRepoId` on read when null.

### 4. Worktree — `packages/server/src/worktree.ts`
- Functions take the **repo path + defaultBranch** (not a global): `git worktree add`
  against `<repoPath>`, base `origin/<defaultBranch>` with fallback to local
  `<defaultBranch>`/`HEAD` for local-only repos (no remote). Worktrees still live under
  zmrng `worktrees/<taskId>` (gitignored).

### 5. Phases — `packages/server/src/phases.ts`
- `createTask(...)` gains `repoId` (default `config.defaultRepoId`); validate against registry.
- `spawn()` resolves `repoById(task.repoId)`; uses its `path` as cwd + worktree base;
  `--add-dir` the worktree.
- `systemPrompt()` **generalized**: drop "Pheme"; identify as "a zmrng worker on the
  target repository at `<path>`; obey that repo's `CLAUDE.md` and `.claude/rules/`;
  never touch its default branch directly; branch from `origin/<defaultBranch>`." The
  target repo's own harness auto-loads in the child `claude` — no per-repo prompt needed.
- Branch slug stays `feat/zmrng/<slug>`; PR via `gh` runs in the target repo.

### 6. REST — `packages/server/src/index.ts`
- `GET /api/repos` → `config.repos` (id/label/defaultBranch; omit absolute path or
  include — operator-only local tool, fine to include).
- `POST /api/tasks` — parse `repoId?` from body (alongside model/effort/style from the
  task-controls plan); fall back to `defaultRepoId` on missing/unknown.

### 7. Web types mirror — `packages/web/src/types.ts`
- Mirror `RepoTarget` + `Task.repoId` verbatim.

### 8. API client — `packages/web/src/api.ts`
- Add `listRepos(): Promise<RepoTarget[]>`.
- `createTask(title, body, opts)` — add `repoId` to `opts`.

### 9. New Task form — `NewTaskForm.tsx` + `.module.css` *(delegate: frontend-specialist)*
- Fetch repos on mount (`api.listRepos`); render a **Repo `<select>`** (required,
  default = server default) in the `.controls` row beside model/effort/style.
- Frosted-glass styling consistent with existing selects.

### 10. App wiring — `App.tsx`
- Thread `repoId` through `onCreate` → `api.createTask`.

### 11. Task detail + list — `TaskDetail.tsx` / `TaskList.tsx` *(delegate: frontend-specialist)*
- Repo badge/pill near the model·effort·style badges. Optional tiny repo glyph per list row.

## Edge cases & risks

| Risk | Mitigation |
|---|---|
| Target repo has no `origin` remote (local-only) | Worktree base falls back to local `<defaultBranch>` / `HEAD`; PR step may fail — surface as task `failed` with clear log, don't hang. |
| Target repo lacks `CLAUDE.md` / security hook | `bypassPermissions` is riskier there. UI flag on repos missing a security hook; document in README; operator opts in. |
| Existing `zmrng.db` lacks `repo_id` | Idempotent `PRAGMA`+`ALTER`; null backfills to `defaultRepoId` on read. |
| `config/repos.json` committed with machine paths | Gitignore it; ship `repos.example.json`. |
| Unknown `repoId` from client | Server falls back to `defaultRepoId`; form only emits registry ids. |
| Worktrees across many repos accumulate | Existing cleanup-on-done/cancel; `worktrees/` gitignored; worktree removed from the correct repo (track repoPath with the task). |
| Server/web type drift (manual mirror) | Task 7 explicit; `typecheck` both workspaces catches shape mismatch. |

---

## Validation (both parts)

```bash
# Part A — harness is files-only; verify nothing breaks zmrng build and Claude Code orients correctly
cd ~/Documents/Projects/zmrng
npm run typecheck && npm run lint && npm run build   # unaffected by Part A, must stay green
# open Claude Code here → /prime → confirm zmrng orientation (not Pheme)

# Part B — code change
npm run typecheck && npm run lint && npm run build    # both workspaces, catches mirror drift
npm run dev   # manual smoke (below)
```

**Part B manual smoke:**
1. `config/repos.json` lists pheme + one other repo; `GET /api/repos` returns both.
2. New Task form shows a Repo select (default = configured default).
3. Create a trivial task ("add a code comment to README") targeting the **non-Pheme** repo.
4. Start → worker spawns with cwd/worktree in that repo; branch from its default branch.
5. Clarify → READY → build → PR opens **in the chosen repo** (verify URL host/repo).
6. Repo badge shows correct target; restart server → task + repo persist (SQLite).
7. Legacy path: with only `ZMRNG_TARGET_REPO` set (no repos.json), one repo still works.

## Acceptance criteria

**Part A**
- [ ] zmrng has `CLAUDE.md` + `.claude/{rules,commands,agents,skills,docs,files,errors.md,settings.local.json}` + `.agents/{plans,tasks,...,scripts/loop.sh}`.
- [ ] No Pheme domain remains in any ported file (no Modbus/substation/copper/power/water/Neon/`@pheme/shared`).
- [ ] Ported rules/agents reflect zmrng's real stack (Fastify/SQLite/pino/React/frosted-glass) + zmrng conventions (type-mirror, ANTHROPIC_API_KEY strip, caveman default).
- [ ] `/prime` in zmrng orients on zmrng; `/validate` runs zmrng's typecheck+lint+build.
- [ ] zmrng build stays green (harness is additive, no code touched).

**Part B**
- [ ] Repo registry loads from `config/repos.json` with env + legacy fallback; invalid entries skipped with warning.
- [ ] New Task form has a Repo select; each task records + persists its `repoId`.
- [ ] Worker spawns against the chosen repo (cwd + worktree + `--add-dir`); branches from that repo's default branch; PR opens in that repo.
- [ ] `systemPrompt` is repo-agnostic (no "Pheme" hardcode); relies on target repo's own harness.
- [ ] Existing `zmrng.db` migrates cleanly; legacy single-repo setup still works.
- [ ] `npm run typecheck && npm run lint && npm run build` green in zmrng.

## Out of scope

Auto-scanning `~/Documents/Projects` for repos · per-repo model/effort defaults ·
multi-repo task batching · repo management UI (add/remove repos in-app) · the heavy
Pheme harness modules (missions/ralph/patrol/GitHub-automation). Deferred.

## Confidence

**One-pass success: ~8/10.** Part A is mechanical (port + strip) and low-risk — pure
files, no zmrng code touched. Part B mirrors the already-proven `zmrng-task-controls.md`
mechanics (idempotent migration, body parse, type mirror, frontend-specialist delegation);
the only genuine integration risk is worktree base-branch resolution for local-only repos
(no `origin/main`), which the fallback chain in task 4 addresses.
