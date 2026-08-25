# Builder task — zmrng ticket H2: `seedHarness()` copies the harness into a worktree

You are a senior TypeScript engineer working inside the git worktree at
`~/Developer/Projects/wt-H2` (a checkout of branch `gauntlet/H2`, cut off
the integration branch which already carries ticket H1 = the `harness/` payload tree).
**Write ONLY files inside this worktree.** Do not touch `~/Developer/Projects/zmrng`.

## Repo rules (from CLAUDE.md — obey strictly)
- Monorepo, npm workspaces: `packages/server` + `packages/web`. NO shared package.
- `packages/server/src/types.ts` is source of truth; `packages/web/src/types.ts` is a MANUAL mirror — if you touch one type you touch BOTH. (H2 likely needs no type changes; only add them if truly required, and mirror.)
- TypeScript strict, no `any`. ESM, `NodeNext`. Pino structured logging in server (no `console.log`).
- Do NOT touch `packages/desktop`, Rust, or run `desktop:build`. Web-only override in force.
- Validate with: `npm run typecheck && npm run lint && npm test && npm run build` — all must be green before you finish.

## The ticket (verbatim intent)
Build `seedHarness(worktreePath, targetRepoPath)` in `packages/server/src/worktree.ts`, called
from `start()` in `packages/server/src/phases.ts` **right after `createWorktree` returns and
before `spawn`** (i.e. between line ~645 and the `this.spawn(...)` call at ~659).

It COPIES the `harness/` tree (never symlink, never `--append-system-prompt`) into the worktree
under a `zmrng-` namespace:
- The harness SOURCE tree lives at zmrng's own repo root: `harness/`. Resolve it robustly — the
  server exports `config.repoRoot` (`packages/server/src/config.ts`, `REPO_ROOT = path.resolve(import.meta.dirname, '../../..')`).
  Prefer taking the harness source dir as an explicit parameter with a default of
  `path.join(config.repoRoot, 'harness')` OR resolve from `import.meta.dirname` in worktree.ts —
  your call, but it must resolve correctly both in dev (tsx) and after `npm run build` (dist/).
  Simplest robust approach: add a 3rd optional param `harnessDir` defaulting to the config-derived path, and have `start()` pass `config.repoRoot`-based path explicitly.
- Copy: `harness/rules/*` → `<worktree>/.claude/rules/zmrng-<name>.md`; `harness/skills/*` →
  `<worktree>/.claude/skills/zmrng-<name>/...`; `harness/agents/*` → `<worktree>/.claude/agents/zmrng-<name>.md`.
- Hooks: register into `<worktree>/.claude/settings.local.json` (H3 adapts the hook scripts &
  copies them into `.claude/zmrng-hooks/` later — for H2, copy the 3 hook scripts from `harness/hooks/`
  into `.claude/zmrng-hooks/` and reference them in settings.local.json so `security_guard.py` fires;
  keep it minimal, H3 will refine adaptation). At minimum `security_guard.py` MUST register and fire.
- Root `CLAUDE.md`: if the target worktree has NO root `CLAUDE.md`, write the harness `CLAUDE.md`
  there; else write it as `.claude/rules/zmrng-lifecycle.md` (non-destructive — never clobber the
  target's own `CLAUDE.md`).
- Append EVERY seeded path + `settings.local.json` to `$GIT_COMMON_DIR/info/exclude` so a worker's
  `git add -A` can never sweep them into a PR. Get `$GIT_COMMON_DIR` via
  `git -C <worktree> rev-parse --git-common-dir` (resolve to absolute). Append idempotently (don't
  duplicate lines if seedHarness somehow runs twice).
- In `phases.ts`, after seeding, append a line to the worker's `systemPrompt` (or emit as part of
  the kickoff/system) marking the `zmrng-*` seeded files as orchestrator-owned and NOT to be
  committed. Keep the systemPrompt change small and additive; if you extend `systemPrompt()`
  signature, update all callers.

## Acceptance criteria (the critic will verify these)
1. Seeding is NON-DESTRUCTIVE: never fails/branches on "target already has `.claude/`"; nothing
   zmrng writes clobbers a target's own harness file (existing `.claude/rules/*`, root `CLAUDE.md`).
2. A worker `git add -A` cannot sweep any `zmrng-*` seed or `settings.local.json` into its PR —
   verified against a dummy git repo: seed it, `git add -A`, `git status --porcelain` shows NONE of
   the seeded paths.
3. `security_guard.py` still registers (present in settings.local.json + on disk in `.claude/zmrng-hooks/`).
4. `npm run typecheck && npm run lint && npm test && npm run build` all green.

## Tests you MUST add (in `packages/server/test/`, Vitest)
Add a `seedHarness` describe block (extend `worktree.test.ts` or a new `seedHarness.test.ts`). Use a
real temp git repo (`git init` in a `mkdtempSync` dir) as the dummy target worktree, seed a small
fake harness dir (or point at the real `harness/` via config.repoRoot), then assert:
- seeded files exist on disk under `.claude/…/zmrng-*` and `.claude/zmrng-hooks/security_guard.py`;
- `git -C <dir> status --porcelain` after `git add -A` lists NONE of the seeded paths (they're in
  `info/exclude`);
- running seedHarness twice does not duplicate exclude lines and does not throw;
- a pre-existing target `CLAUDE.md` is left byte-for-byte untouched (harness CLAUDE goes to
  `.claude/rules/zmrng-lifecycle.md` instead).

## Reference: current `start()` wiring (phases.ts ~633-668)
```
wt = await createWorktree(repo.path, repo.defaultBranch, path.join(repo.path, 'worktrees'), taskId, task.title)
...
this.spawn({ ...task, branch: wt.branch }, model, effort, style, wt.worktreePath, wt.branch, repo.path, repo.defaultBranch)
```
Insert the `await seedHarness(wt.worktreePath, repo.path)` (or with the harnessDir arg) after
`createWorktree` and BEFORE `this.spawn(...)`. Wrap in try/catch and emit a Pino-logged operator
note on failure but do NOT fail the task if seeding partially fails (best-effort, but log clearly).

## Deliverable
Working code + passing tests. Run the full gate yourself and iterate until green. Report:
- exact files changed, the seedHarness signature, how info/exclude is written, and the gate result
  (paste the final `npm test`/`build` summary lines). Be terse.
