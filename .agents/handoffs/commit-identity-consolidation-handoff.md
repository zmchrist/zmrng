# Handoff — commit-identity consolidation + public-readiness scrub

**For:** the next agent (or a future session) picking up the zmrng
public-readiness work.
**Status:** mechanical fixes DONE + committed. History rewrite PLANNED, DRY-RUN
PROVEN, **NOT executed** — it is the irreversible step and is blocked on two
operator decisions (below).

---

## What this task is

zc asked for an adversarial public-readiness review of zmrng (showcasing his AI
engineering to potential hirers). The review surfaced four big own-goals; this
handoff covers the commit-identity fix specifically, plus the mechanical cleanups.

The four review findings (full context in session history):
1. **Commit identity is a mess** — 53 commits authored as the literal git
   default `Your Name <your.email@example.com>`, an alias split
   (`TioVida` vs `TiosVida` — same mailbox), 2 `Pheme-Bot` bleed commits, 3
   `Zebucity <charles@coviin.com>` (a REAL other person). None of the `Your Name`
   commits link to zc's GitHub graph.
2. **Repo advertises Claude built it** — 171/188 commit bodies carry Claude
   co-author trailers; 30+ internal `.agents/plans/*-grill.md`, `.gauntlet/`
   transcripts tracked in the public tree. (NOT addressed yet — see Remaining.)
3. **README demo is a TODO** — `[Loom link — TODO]`, `demo.gif — TODO`. Highest
   ROI missing asset for a visual orchestrator GUI. (NOT addressed.)
4. **Stale docs / clutter** — `INSTRUCTIONS.md` (Windows-zip handoff, stale
   commit `aa1de24`), overlapping root docs. (NOT addressed.)

---

## DONE this session (committed on `chore/zc/public-readiness-scrub-ci`)

- **git identity corrected** in this repo's config: `zmchrist <TiosVida@pm.me>`
  (was `Your Name <your.email@example.com>` — the root cause of the bleed).
  `git config user.name` / `user.email` now correct.
- **`buildinfo.json` gitignored** — a stray 52KB `tsc` incremental artifact that
  was untracked but not ignored. Confirmed ignored via `git check-ignore`.
- **lint gate verified clean** — an earlier transient `onTeamHandleChange`
  unused-var error was stale working-tree noise; the symbol is properly wired at
  `App.tsx:429/443`. Full `npm run lint` + `npm run typecheck` pass.
- **`.mailmap.consolidate`** authored (the identity map, see below).
- **`.agents/plans/commit-identity-consolidation.md`** authored (full rewrite
  procedure with backup + rollback).

## PROVEN but NOT executed — the history rewrite

Decisions locked with zc:
- 53 `Your Name` → `zmchrist <TiosVida@pm.me>`
- 2 `Pheme-Bot` → `zmchrist <TiosVida@pm.me>` (zc's automation bleed)
- `TioVida` alias → normalized to `TiosVida`
- 3 `Zebucity <charles@coviin.com>` → **LEFT UNTOUCHED** (real other person;
  rewriting would misattribute their work)

**Dry-run result (verified, throwaway clone `/tmp/zmrng-rewrite`):**
`git filter-repo --mailmap` produced exactly **186 `zmchrist <TiosVida@pm.me>`
+ 3 `Zebucity`**, and `npm ci && typecheck && lint && test` all GREEN on the
rewritten tree. The mailmap logic is correct. Only the execution strategy on the
real repo is unresolved.

---

## ⚠️ WHY THE LIVE REWRITE IS HALTED (read before touching git)

Re-checking state right before the destructive step surfaced that this is NOT
the clean solo repo the naive plan assumed:

1. **Concurrent-session signal.** The working tree changed on its own mid-task
   (different modified-file set than session start — `Board.tsx`, `KbView.tsx`,
   `TeamView.tsx`, `.claude/errors.md` appeared; README/db.ts/types.ts dropped —
   none touched by this session). zc's standing rule: concurrent Claude sessions
   share this ONE checkout — **STOP and surface** if the tree moves, never run
   git ops on top of another session's live edits. A rewrite + force-push here
   would nuke the other session's work.
2. **~90 local branches**, 60+ marked `[origin/…: gone]` (already merged +
   remote-deleted). `git push --force-with-lease --all` would **resurrect all
   60+ dead branches on origin** with rewritten SHAs — the opposite of a clean
   showcase. NEVER use `--all`.
3. **5 active worktrees** (kb-141, kb-142, pr167, local-app-update-ux, cc833793)
   checked out to branches. `git filter-repo` in the main repo with live
   worktrees will refuse or leave them inconsistent.
4. **37 branches + 3 tags on origin**, a stash mid-rebase. filter-repo rewrites
   EVERY ref, not just main.

---

## BLOCKING QUESTIONS for zc (do not proceed without answers)

- **Q1 — Is another session/agent active in this checkout right now?** The tree
  moved on its own. Confirm it's idle before any git rewrite.
- **Q2 — Rewrite scope?**
  - **A (RECOMMENDED for a showcase):** rewrite in a fresh `git clone --mirror`,
    then force-push **only `main`** back to origin. Leaves the 37 remote
    feature/gauntlet branches + all local cruft untouched. Zero risk to the
    concurrent session's working tree. A recruiter only browses `main`.
  - **B (higher risk):** full in-place rewrite of all refs — only after the
    concurrent session is done, tree is clean, worktrees pruned, and the push is
    scoped to a hand-picked branch list (NEVER `--all`).

---

## RECOMMENDED EXECUTION — Path A (mirror + main-only)

Run only after Q1 (session idle) + Q2 (zc picks A) are answered. `git-filter-repo`
v2.47.0 is installed (via brew this session).

```bash
cd ~/Developer/Projects
# 1. Backup (non-negotiable)
git clone --mirror https://github.com/zmchrist/zmrng.git zmrng-backup.git

# 2. Fresh mirror to rewrite
git clone --mirror https://github.com/zmchrist/zmrng.git zmrng-rewrite.git
cd zmrng-rewrite.git
cp ~/Developer/Projects/zmrng/.mailmap.consolidate /tmp/mailmap
git filter-repo --mailmap /tmp/mailmap --force

# 3. Verify identity + that main builds (clone main out to a temp worktree)
git log main --format='%an <%ae>' | sort | uniq -c | sort -rn   # expect 186 you + N Zebucity on main's slice

# 4. Force-push ONLY main (re-add origin — filter-repo strips it)
git remote add origin https://github.com/zmchrist/zmrng.git
git push --force-with-lease origin main
```

**Rollback:** `cd zmrng-backup.git && git push --force --mirror https://github.com/zmchrist/zmrng.git`

Post-rewrite: delete `.mailmap.consolidate` from the working tree (plan says it
shouldn't ship public). zc's local clone will need a re-sync (`git fetch` +
reset main) since SHAs changed — do that only with zc present and the concurrent
session confirmed done.

---

## Remaining public-readiness work (not started)

- Move `.agents/plans/*-grill.md`, `.gauntlet/`, internal handoffs OUT of the
  public tree (or into an owned `docs/process/`). Reframes finding #2.
- Record the 90-second demo gif/Loom; wire it into README (finding #3).
- Remove/relocate `INSTRUCTIONS.md`, trim overlapping root docs (finding #4).
- Optional: strip Claude co-author trailers via `filter-repo --message-callback`
  (separate pass; deliberately NOT in the identity mailmap).

## Key files
- `.mailmap.consolidate` — the proven identity map (committed on this branch).
- `.agents/plans/commit-identity-consolidation.md` — full procedure + rollback.
- This handoff.
