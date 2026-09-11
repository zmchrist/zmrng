# Handoff: worker-harness parity — port today's harness work into the seed harness

## Goal (operator intent)

Any agent operating on zmrng must have immediate access to the full set of
rules, hooks, and workflow we implemented today — **regardless of how it is
launched**:

- A developer (or the operator) running a Claude instance **from the zmrng repo
  root** (the direct-session case — this is how the current session runs).
- A zmrng **headless worker** spawned per task, **whatever target repo it
  drives**.

No harness work intended for zmrng may be silently missing on either side. A
fresh clone on any machine must carry everything with zero external setup.

## Why this handoff exists (the gap)

zmrng has **two independent harnesses**. Today's PRs only updated the first:

1. **`zmrng/.claude/`** — consumed when Claude Code is launched from the zmrng
   repo root (direct sessions). Fully updated today: `branch_guard.py`,
   `pr_shape_guard.py`, `security_guard.py`, `post_tool_use_lint.py`,
   `stop_validate.py`, committed `settings.json`, plus `verify.sh` / `validate.sh`.
2. **`zmrng/harness/`** — a separate, git-tracked, **stack-agnostic** source
   tree that `seedHarness()` copies into **every worker worktree** before spawn,
   for any target repo. **Today's PRs never touched this tree.** Workers read
   only this one.

Result today: workers follow the PIV **workflow** (baked into `phases.ts`
prompts + seeded `harness/CLAUDE.md` + `harness/rules/`), but do **not** get the
new enforcement hooks or the single-source verify gate. This handoff closes that
gap and eliminates the drift between the two harnesses.

## What was shipped today (must all be reflected on the worker side)

- **zmrng PR #138** (branch `chore/zc/harness-hooks`, commits `7c3eda5`,
  `eeac28f`): self-contained `zmrng/.claude/` harness — 5 hooks, committed
  `settings.json`, `verify.sh` + `validate.sh` single-source gate, prose
  consolidated to pointers (`coding-lifecycle.md` is the source of truth).
- **New enforcement hooks** created today:
  - `branch_guard.py` — PreToolUse `Edit|Write|MultiEdit`; denies edits while the
    file's repo is on `main`/`master`. Protected-branch-only (never a
    name-convention check — would brick workers on `feat/zmrng/*`).
    Worktree-aware (`git -C`). Override `HERMES_ALLOW_PROTECTED_EDIT=1`.
  - `pr_shape_guard.py` — PreToolUse `Bash`; rejects `gh pr create` with `--fill`
    or without `--body-file`. Override `HERMES_ALLOW_PR_FILL=1`.
- **Correctness fixes** made in the `.claude/` copies that the `harness/` copies
  still lack:
  - Every hook carries `from __future__ import annotations` so it runs on stock
    macOS `python3` 3.9 (PEP-604 `X | None` crashes on 3.9, failing open
    silently).
  - `stop_validate.py` anchored to `CLAUDE_PROJECT_DIR` running the repo's own
    `.claude/validate.sh`, instead of the parent's first-level-subdir
    auto-detect (which returns None and skips validation from a single repo root).

## Confirmed facts (verified this session — do not re-derive)

- Worker spawn: `runner.ts:240-242` → `spawn('claude', args, { cwd: opts.cwd })`;
  `opts.cwd` = the task worktree, which is a checkout of the **target** repo.
- Seeding: `phases.ts:1035` calls `seedHarness(worktreePath, repo.path,
  path.join(config.repoRoot, 'harness'))` before spawn.
- `seedHarness()` (`worktree.ts:172`) copies `harness/{rules,skills,agents,hooks}`
  + `harness/CLAUDE.md` into the worktree under a `zmrng-` namespace
  (`.claude/rules/zmrng-*`, `.claude/zmrng-hooks/*`, `.claude/agents/zmrng-*`),
  and merges hook registrations into the worktree's `.claude/settings.local.json`.
- **Hook registration is hardcoded** in `zmrngHooksConfig()` (`worktree.ts:100`),
  NOT read from `harness/settings.json`. It currently registers only three hooks:
  `security_guard` (PreToolUse), `post_tool_use_lint` (PostToolUse),
  `stop_validate` (Stop). Hook command paths use
  `${CLAUDE_PROJECT_DIR}/.claude/zmrng-hooks/<name>`.
- `harness/settings.json` exists but is **unused** by `seedHarness` — a live
  drift trap. Decide its fate (see step 6).
- **Three bugs currently in `harness/`:**
  1. `harness/hooks/post_tool_use_lint.py` **crashes on python3 3.9.6** (`X | None`).
     The worker's `python3` resolves to `/usr/bin/python3` = 3.9.6 on this
     machine. Worker auto-lint is silently dead right now.
  2. `harness/hooks/` has no `branch_guard.py` / `pr_shape_guard.py`.
  3. `harness/` has no single-source verify gate (`verify.sh`).
- `probeInterpreter()` guards hook seeding: if `python3` (or `ZMRNG_PYTHON_BIN`)
  is not runnable, hooks are skipped entirely with an operator note
  (`HOOKS_SKIPPED_NOTE`). Not a blocker here (3.9.6 runs — it just crashes at
  execution once the annotation bug bites), but keep in mind: the fix is the
  `__future__` import, not the probe.

## Design decisions (settled — do not re-litigate)

- **`verify.sh` is NOT seeded into arbitrary target repos.** It is
  zmrng-specific (`npm run …`); `harness/` is deliberately stack-agnostic. The
  seeded `stop_validate.py` already auto-detects the stack AND honors a target
  repo's own `.claude/validate.sh`, so workers get validation without a
  zmrng-shaped gate. `verify.sh` / `validate.sh` stay in `zmrng/.claude/` only.
- **`branch_guard` IS seeded** even though a worker is already on a feature
  branch (so it rarely fires). It is a cheap safety net and keeps the two
  harnesses at parity. Protected-branch-only, so it never blocks normal worker
  flow.
- **`pr_shape_guard` IS seeded.** Workers open PRs (`phases.ts` execute/validate
  kickoff), so enforcing `--body-file` over `--fill` is directly load-bearing
  for worker-produced PRs.
- **Keep `zmrngHooksConfig()` as the single registration source of truth.** Do
  not switch seeding to read `harness/settings.json` in this pass — that is a
  larger refactor. Either delete `harness/settings.json` or leave a comment that
  it is illustrative only (step 6).

## Build steps

Branch from `origin/main` first: `git fetch origin && git checkout -b
feat/zc/worker-harness-parity origin/main`.

### 1. Add the two new hooks to `harness/hooks/`
- Copy `branch_guard.py` and `pr_shape_guard.py` from `zmrng/.claude/hooks/`
  into `harness/hooks/` **verbatim** (they already carry `from __future__ import
  annotations` and are worktree-aware / protected-branch-only — correct as-is
  for workers).

### 2. Fix the py3.9 crash in the existing seed hooks
- Add `from __future__ import annotations` (immediately after the module
  docstring) to:
  - `harness/hooks/post_tool_use_lint.py`  ← currently crashes on 3.9
  - `harness/hooks/stop_validate.py`  ← defensive; parent original uses `X | None`
  - `harness/hooks/security_guard.py`  ← defensive parity (already annotation-free,
    but add for consistency so a future edit can't reintroduce the crash)
- Verify each seed hook runs clean under `/usr/bin/python3` (3.9.6) with an empty
  `{}` event on stdin.

### 3. Register the two new hooks in `zmrngHooksConfig()` (`worktree.ts:100`)
- Add a PreToolUse entry for `branch_guard.py`, matcher `Edit|Write|MultiEdit`,
  timeout 8.
- Add a PreToolUse entry for `pr_shape_guard.py`, matcher `Bash`, timeout 5.
- Keep the `${CLAUDE_PROJECT_DIR}/.claude/zmrng-hooks/<name>` command form and
  the `python3 "<path>"` wrapper already used for the existing three.
- PreToolUse becomes a list of multiple matcher-groups (mirror the structure now
  in `zmrng/.claude/settings.json`).

### 4. Reconcile the worker `stop_validate` gate with the target's own validation
- The seeded `stop_validate.py` already prefers a target repo's
  `.claude/validate.sh` and otherwise auto-detects the stack. Confirm that path
  still holds after the `__future__` edit. No zmrng `verify.sh` is seeded (per
  decision above). This step is verification-only unless step 2 changed behavior.

### 5. Update the pinned test(s)
- `packages/server/test/worktree.test.ts` (and any prompts/seed test) likely
  pins the set/count of seeded hooks or the `zmrngHooksConfig()` shape. Search
  for `zmrng-hooks`, `security_guard`, `zmrngHooksConfig`, `seedHarness`. Update
  expectations to include `branch_guard.py` + `pr_shape_guard.py` and the two
  new registrations. Add an assertion that every seeded hook is importable under
  python3 (guards against a future PEP-604 regression) if a natural spot exists.

### 6. Resolve the `harness/settings.json` drift trap
- It is unused by `seedHarness` (registration is hardcoded in
  `zmrngHooksConfig()`). Either:
  - delete `harness/settings.json`, OR
  - add a top-level comment/README note that it is illustrative only and that
    `zmrngHooksConfig()` in `worktree.ts` is the actual registration source.
- Pick one and make the code/docs unambiguous so the next person does not edit
  the dead file expecting it to take effect.

### 7. Sync the harness docs
- `harness/CLAUDE.md` and `harness/hooks/README.md`: update the hook inventory to
  list all five hooks (add branch_guard + pr_shape_guard, with their override env
  vars). Keep it stack-agnostic — no `npm`-specific language.
- Run the `sync-docs` skill before committing.

## Verification (no Vitest for hooks/shell — ad-hoc + suite)

- Ad-hoc (temp script, `hermes-verify-` prefix under the OS temp dir, cleaned up):
  - all five `harness/hooks/*.py` run on `/usr/bin/python3` 3.9.6 with `{}` on
    stdin — no annotation crash;
  - `branch_guard`: repo-on-main → deny, feature-branch → pass, non-git → pass,
    override env → pass;
  - `pr_shape_guard`: `--fill` → deny, no `--body-file` → deny, `--body-file` →
    pass, `gh pr edit` → pass;
  - `security_guard`: `.env` → deny, `.env.example` → pass, `rm -rf` → deny,
    `git reset --hard` → deny;
  - `post_tool_use_lint`: advisory, always exit 0;
  - `stop_validate`: failing gate → block JSON, passing gate → no block.
- Suite: `./.claude/verify.sh --fast` (typecheck + lint + test) green — this
  covers the `worktree.ts` / `zmrngHooksConfig()` change and the updated tests.
- **Real seed integration (the decisive check):** call `seedHarness()` against a
  throwaway worktree (or a temp git repo standing in as the target) and assert
  the produced `.claude/settings.local.json` contains all five hook
  registrations and that `.claude/zmrng-hooks/` contains all five scripts. Then
  run each seeded hook once under python3 to confirm no crash. This proves the
  worker path end-to-end, not just the source files.

## Definition of done

- A newly seeded worker worktree (any target repo) carries all five hooks in
  `.claude/zmrng-hooks/` and all five registrations in
  `.claude/settings.local.json`, none crashing on python3 3.9.
- The PIV workflow + branch/PR enforcement + secrets/delete guards apply to both
  direct zmrng sessions and headless workers.
- No `harness/` hook crashes on stock macOS python3.
- `harness/settings.json` is either gone or unambiguously marked illustrative.
- Tests updated + green; docs synced.
- Delivered as PR `feat/zc/worker-harness-parity` with the full lifecycle
  checklist via `--body-file`.

## Out of scope (explicitly)

- Do NOT seed `verify.sh` into target repos (decision above).
- Do NOT refactor `seedHarness` to read `harness/settings.json` as the
  registration source in this pass (larger change; keep `zmrngHooksConfig()`).
- Do NOT touch the worker prompt strings in `phases.ts` — the workflow half is
  already correct and pinned by `prompts.test.ts`.
- Parent `Projects/.claude/` hooks (`post_tool_use_lint.py`, `stop_validate.py`)
  still carry the same py3.9 `X | None` crash for other parent-run projects.
  That is a separate, still-open cleanup — note it, but it is not part of this
  handoff.
