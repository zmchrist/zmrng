# Plan — Resolve merge conflicts for the three open gauntlet PRs (#26 DB, #27 U1, #28 S1)

## Task
"Solve the merge conflicts in our GitHub." Three open PRs all target `main` and all
report `CONFLICTING` / `DIRTY`:

| PR | Branch | Title |
|----|--------|-------|
| #26 | `gauntlet/DB` | additive kanban data-model migration |
| #27 | `gauntlet/U1` | mode-tabbed workspace shell — Tasks · Board · Workspace |
| #28 | `gauntlet/S1` | stranger onboarding + auth-mode bootstrap |

Agreed delivery shape (from clarify): **integration branch** (option 2a). Build one branch
off `main`, merge all three in dependency order (DB → U1 → S1), resolve every conflict
hunk-by-hunk with a reasoning note per decision, open **one** integration PR into `main`.
Never push to the gauntlet branches (branch-only rule). Conflict-intent: reason per hunk.

## The decisive finding (read this first)

**All three PRs are already fully superseded by `main`.** They were each cut from
merge-base `cdacd50`. Since then `main` advanced to `baa5080` ("zmrng Stage-1: ship the
operating harness as a self-hostable app (integ)", #29), which **already integrated
evolved versions of all three features** — it merged the `gauntlet/integ` line that
carried DB, U1, U2–U6, S1, S2, H2–H4.

Three independent read-only investigations (one per branch, diffing each branch's true
additions vs its base `cdacd50` against `main`'s current content) each concluded
**"NONE — main fully supersedes"**:

- **DB (#26):** every field/table/token it adds — `TaskStatus 'archived'`,
  `blockedKind`/`blockedReason`, `task_comments` table + `addComment`/`listComments`,
  `STATUS_LABEL.archived`, `--status-archived` theme token — is already present in `main`,
  byte-identical. `main` additionally has `chat_messages` (U4) that DB lacks.
- **U1 (#27):** `GET /api/tasks/:id/files`, `listWorktreeFiles`/`walk`/`PRUNE_DIRS`,
  `WorkspaceMode`/`WorktreeFileNode`/`WorktreeFileTree` types, `api.getFiles`,
  `WorkspaceView.tsx`, `FileTree.tsx`, the mode tabs — all present in `main`, and
  **more evolved** (main's `WorkspaceView.tsx` is 239 lines vs U1's 139; real `<Board>`
  and clickable `FileTree` vs U1's stubs).
- **S1 (#28):** `AuthMode='oauth'|'apikey'` + `resolveAuthMode`, the auth-mode-aware
  `runner.ts` key-strip, `preflight.ts`, `/api/preflight`, `AuthBanner.tsx`,
  `.env.example` block — all present in `main`, a **strict superset** (main's preflight
  adds a `path` probe block the S1 version lacks).

**Consequence:** the correct resolution for **every** conflict is **keep-main**, and the
correct final integration tree is **byte-identical to `main`** — i.e. the net file diff of
the integration PR is **empty**. This was verified end-to-end (see "Validation of the
finding" below).

## Approach (chosen)

Produce the integration branch exactly as the operator asked (option 2a), resolving every
conflict to `main`'s side, and open one PR whose **body documents the supersession and
every per-file decision**. The PR's file diff will be empty because the branches are
obsolete; that is the honest, correct outcome, not a mistake. The PR gives the operator a
single artifact to merge (or simply close) and then close #26/#27/#28 as superseded.

### Why keep-main for every hunk (per-file decision table)

Merge order DB → U1 → S1 onto `feat/zmrng/merge-conflicts-b2f69e8b` (already cut from
`origin/main`). Every listed conflict resolves **keep-main**; reasons:

| File | Conflict kind | Decision | Reason |
|------|---------------|----------|--------|
| `packages/server/src/db.ts` | content | keep-main | main has DB's kanban/comment additions **plus** `chat_messages`; branch adds nothing new |
| `packages/server/src/types.ts` | content | keep-main | superset; `archived`/`blockedKind`/`TaskComment`/preflight/auth types all already present |
| `packages/web/src/types.ts` | content | keep-main | manual mirror of server types — stays consistent by taking main |
| `packages/web/src/theme.css` | content | keep-main | main's orange-brutalist reskin already carries `--status-archived`; taking branch would revert the theme |
| `packages/server/test/db.test.ts` | content | keep-main | main already has the comment + blocked test blocks (plus chat tests) |
| `packages/server/src/index.ts` | content | keep-main | main has `/files` + `/preflight` routes plus more; branches add nothing |
| `packages/server/src/worktree.ts` | content | keep-main | main has `listWorktreeFiles`/`walk`/`PRUNE_DIRS` plus a broader prune set |
| `packages/server/test/worktree.test.ts` | add/add | keep-main | superset of U1's cases (adds `.zmrng` prune assertion) |
| `packages/web/src/App.tsx` | content | keep-main | main = persisted mode + real `<Board>`; branch = local mode + Board stub. **Trap: a naive merge leaks a duplicate `const MODES` → `tsc` "Cannot redeclare block-scoped variable 'MODES'". Reject that hunk.** |
| `packages/web/src/App.module.css` | content | keep-main | main's richer shell; U1's `.modePanel/.boardStub/.stubTitle/.stubSub` are dead stub styles (main renders a real Board — nothing references them). Reject them |
| `packages/web/src/api.ts` | content | keep-main | main has `getFiles`/`getPreflight` plus more client methods |
| `packages/server/src/config.ts` | content | keep-main | identical auth-mode logic; no S1-unique content |
| `packages/server/src/preflight.ts` | add/add | keep-main | main is a strict superset (`path`/`checkOnPath`) |
| `packages/server/test/config.test.ts` | content | keep-main | contains the identical `resolveAuthMode` block |
| `packages/server/test/preflight.test.ts` | add/add | keep-main | superset — asserts S1's cases plus the `path` block |
| `packages/web/src/components/FileTree.*` | add/add | keep-main | main is a strict superset (interactive rows) |
| `packages/web/src/components/WorkspaceView.*` | add/add | keep-main | main is the evolved 239-line version (real Viewer/Notes/Chat) |

Non-conflicting harness/scaffolding files (`.claude/*`, `README.md`, `.nvmrc`, `ci.yml`,
`package.json`, `prompts.test.ts`, `testing.md`, `errors.md`) auto-merge cleanly because
the branch and main carry identical copies (they land no-ops). No action needed on them.

### Rejected alternatives

1. **`git merge -X ours` (blunt auto-resolution).** Rejected: it favors main only on
   *overlapping* hunks but auto-applies *non-overlapping* branch additions. Verified this
   leaks two artifacts — a **duplicate `const MODES`** into `App.tsx` (breaks `tsc`) and
   ~36 lines of **dead stub CSS** into `App.module.css`. A blunt strategy silently
   produces a broken/dirty tree; per-file keep-main + an empty-diff guard is required.
2. **Fix each gauntlet PR branch in place (option 2b).** Rejected/forbidden: the
   branch-only hard rule prohibits pushing to `gauntlet/*`. The operator already chose 2a.
3. **Blend / keep-branch where features look "newer" on the branch.** Rejected: the
   investigations proved the branches are *older* drafts; every branch capability exists in
   `main` in equal-or-more-evolved form. Blending would either duplicate code or regress
   `main` to a stub.
4. **Skip the PR entirely and just close #26/#27/#28 as superseded.** This is the most
   literally efficient path and is called out for the operator (see "Decision surfaced"),
   but it does **not** match the agreed 2a shape, so the default execution still produces
   the integration PR. The operator may elect this instead after reading the PR body.

## Execution steps

1. Confirm the branch is at `origin/main` (`baa5080`) and clean.
2. **Merge DB → U1 → S1** in order, one merge commit each, `--no-ff`:
   - `git merge --no-commit --no-ff origin/gauntlet/<b>`
   - For every conflicted path (content and add/add), take **main's** version:
     `git checkout HEAD -- <path>` then `git add <path>` (HEAD = the integration tip,
     which holds main's content).
   - **Before committing each merge, guard against auto-merge residue:** run
     `git diff --stat origin/main`; if any file differs from `main`, reconcile it —
     for a file `main` **has**, restore `main`'s version (`git checkout origin/main --
     <path>`); for a file `main` **lacks** that a branch re-added, delete it
     (`git rm <path>`). This is where the duplicate `MODES` / stub CSS would appear.
     The per-merge tree must equal `main`.
   - Commit the merge with a message naming the superseded PR and the keep-main rationale.
3. **Final integration guard:** `git diff origin/main` **must be empty**. If it is not,
   the integration is wrong — investigate the residual hunk and reason per the table above.
4. Type-mirror check is automatically satisfied (tree == main, whose mirror is already
   consistent).
5. Validate (see Test strategy), run the `sync-docs` skill (expected: no doc change, since
   no code changed — record that in the PR), stage the plan file.
6. Push the branch and open **one** PR into `main` with `gh pr create --body-file` (never
   `--fill`), following `.github/PULL_REQUEST_TEMPLATE.md`. The body documents the
   supersession finding, the per-file keep-main table, the two rejected residual traps, the
   empty net diff, and the recommendation to close #26/#27/#28 on merge.
   - **Fallback if `gh pr create` rejects the zero-file-diff PR:** the branch is still
     ahead by three merge commits, so GitHub normally accepts it; if it does not, do not
     force anything — surface to the operator that the cleanest path is to close
     #26/#27/#28 directly on GitHub as "superseded by #29", exactly as the PR body would
     have recommended. Either outcome loses no feature work.

## Test strategy

- **Test runner:** Vitest, both workspaces, via the repo's npm scripts. Full validation
  gate: `npm run typecheck && npm run lint && npm test && npm run build`.
- **No new unit tests are added, and that is correct here.** This is a merge/reconciliation
  change whose final tree is **byte-identical to `main`** — there is no new source behavior
  to cover. Adding a test would test `main`'s already-tested code. Per the coding-lifecycle
  tolerance for genuinely untestable changes, this will be stated explicitly in the PR's
  **Testing** section.
- **What actually proves the change is correct** (the real "tests" for this task):
  1. **Empty-diff guard:** `git diff origin/main` produces **no output**. This proves every
     conflict resolved to `main` and no auto-merge residue (e.g. the duplicate `const MODES`
     that would break `tsc`, or the dead stub CSS) leaked into the tree. This is the single
     most important check and gates the PR.
  2. **Existing suite stays green:** `npm run typecheck && npm run lint && npm test &&
     npm run build` all pass — proving the reconciled tree compiles, lints, and passes the
     full existing Vitest suite (including `prompts.test.ts`, `taskManager.test.ts`,
     `db.test.ts`, `config.test.ts`, `preflight.test.ts`, `worktree.test.ts`). Because the
     tree equals `main` (which is already green), this must pass; a failure would signal an
     incorrect resolution.
  3. **Merge topology check:** `git log --oneline origin/main..HEAD` shows the three
     `gauntlet/*` tips plus three merge commits, confirming all three PRs are recorded as
     integrated (so the operator can close them as superseded).

## Validation of the finding (already performed during planning)

A dry-run integration (three merges, keep-main, immediately aborted/reset — no lasting
change) confirmed:
- With correct per-file keep-main, the final tree is identical to `main` (`git diff
  origin/main` empty).
- A blunt `-X ours` run instead left `App.tsx` (+6, duplicate `const MODES`) and
  `App.module.css` (+36, dead `.modePanel/.boardStub` stub styles) differing from `main` —
  the exact residue the execution guard in step 2/3 must catch and revert.
The branch was reset back to `origin/main` (`baa5080`), clean, before writing this plan.

## Decision surfaced to the operator (in the PR body)

**The three gauntlet PRs (#26/#27/#28) are already fully integrated into `main` via the
Stage-1 integ (#29); this integration branch therefore carries an empty net diff.** The
default deliverable (agreed shape 2a) is the integration PR that records this and lets you
close all three. If you would rather skip the PR and simply **close #26/#27/#28 directly as
"superseded by #29"**, that is equally valid and slightly cleaner — the PR body will say
so. No feature work is lost either way.

## Files touched
- `.agents/plans/merge-conflicts-gauntlet-integration.md` (this plan — staged with the PR).
- Three merge commits on `feat/zmrng/merge-conflicts-b2f69e8b`; **no source file content
  changes** (final tree == `main`).
