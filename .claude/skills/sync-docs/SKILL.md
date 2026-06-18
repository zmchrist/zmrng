---
name: sync-docs
description: Sync project documentation with current codebase state at end of a session before commit. Covers .claude/ rules + docs, .agents/plans/ + reports, and root README. Use after meaningful changes (new features, refactors, new services/routes/types, removed modules, new errors). Skip for typos, formatting, single-line fixes.
---

# sync-docs

Keeps zmrng docs in lockstep with the codebase. Runs at session end, before commit.

## When to run

**Run if any of:**
- New service, REST route, WebSocket message type, or server/web type
- New component, hook, or per-task control with cross-cutting impact
- New env var or external integration
- New phase/state-machine behavior or runner change
- New error solved that took >2 min to debug
- Plan in `.agents/plans/` is complete (move to `completed/`)

**Skip if:**
- Typos, formatting, single-line bug fix
- WIP / exploratory work not yet shipped
- Only fixtures or build artifacts changed

When unsure: run it. Cheap to verify nothing drifted.

## Scope

Three buckets. Update only what reality changed.

### 1. `.claude/` rules + reference

| File | Update when |
|------|-------------|
| `/CLAUDE.md` (root) | Workspace structure, commands, services, tech stack, "Resolved" facts |
| `.claude/docs/services-reference.md` | Service APIs, method signatures, behavior |
| `.claude/docs/implementation-history.md` | Append completed features (one-line per feature, dated) |
| `.claude/errors.md` | New error → solution entry (use template in `.claude/rules/error-handling.md`) |
| `.claude/rules/*.md` | New conventions, anti-patterns, design tokens |
| `.claude/files/PROJECT_CONTEXT.md` | Resolved open decisions, new subsystems |

Delegate this slice to the **doc-updater** agent via `Agent` tool — that's its specialty.

> **Type mirror reminder:** if `packages/server/src/types.ts` changed, confirm
> `packages/web/src/types.ts` was updated in the same change (there is no shared package).

### 2. Plans + reports

- Completed plan in `.agents/plans/` → move to `.agents/plans/completed/`
- If a code review was done → ensure report exists in `.agents/code-reviews/`
- If a system review was done → ensure report exists in `.agents/system-reviews/`

Don't invent reports. Only move/file what genuinely happened this session.

### 3. Root README

| File | Update when |
|------|-------------|
| `README.md` | Top-level feature list, install/run steps, env vars, repo-registry setup changed |

Touch sparingly — it's stable.

## Protocol

1. **Survey the session.** Run `git status` + `git diff --stat origin/main..HEAD` (or working tree). Identify what changed.

2. **Decide scope.** For each of the three buckets, decide: update / skip. Skip aggressively. Document scope at top of work.

3. **Run doc-updater for `.claude/` slice.** Tell it what changed in 1–2 sentences. Wait for its report.

4. **File plans + reports** as plain `git mv` / `Write` operations.

5. **Verify.** Run `npm run typecheck && npm run lint && npm run build`.

6. **Report.** One block per bucket: files touched + reason. List skipped buckets explicitly.

## Output format

```
## Doc sync report

### .claude/
- file:section — what changed
- (or "no updates needed")

### Plans + reports
- moved/created — path

### Root README
- (usually "no updates needed")

### Verification
- typecheck/lint/build: PASS/FAIL
```

## Rules

- Only document what currently exists. No speculation, no roadmap items unless they're in `.claude/files/FUTURE_IDEAS.md`.
- Preserve existing formatting, frontmatter, heading levels.
- Don't touch code files except to move plan files.
- If a doc and the code disagree, **code wins** — update the doc, not the code.
- Dates use `YYYY-MM-DD` from today's date in conversation context.
