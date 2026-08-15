---
name: sync-docs
description: Sync project documentation with current codebase state at end of a session before commit. Covers .claude/ rules + docs, .agents/plans/ + reports, and root README. Use after meaningful changes (new features, refactors, new services/routes/types, removed modules, new errors). Skip for typos, formatting, single-line fixes.
---

# sync-docs

Keeps project docs in lockstep with the codebase. Runs at session end, before commit.

## When to run

**Run if any of:**
- New service, API route, message/event type, or cross-module shared type
- New component, hook, or config option with cross-cutting impact
- New env var or external integration
- New state-machine behavior or core-engine change
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

| Doc | Update when |
|------|-------------|
| The project's root guide (`CLAUDE.md`), if present | Workspace structure, commands, services, tech stack, "Resolved" facts |
| The project's architecture / services reference doc (if it keeps one) | Service APIs, method signatures, behavior |
| The project's implementation-history / changelog doc (if it keeps one) | Append completed features (one-line per feature, dated) |
| The project's known-errors / troubleshooting doc (if it keeps one) | New error → solution entry (use template in `harness/rules/error-handling.md`) |
| The project's other rule/convention docs | New conventions, anti-patterns, design tokens |
| The project's context / design-decisions doc (if it keeps one) | Resolved open decisions, new subsystems |

Delegate this slice to the **doc-updater** agent via `Agent` tool — that's its specialty.

> **Type mirror reminder:** if this project manually mirrors a type definition
> across modules/workspaces (no shared package), confirm every mirror was
> updated in the same change.

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

5. **Verify.** Run the project's typecheck, lint, and build commands.

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

- Only document what currently exists. No speculation, no roadmap items unless they're in the project's own future-ideas/roadmap doc (if it keeps one).
- Preserve existing formatting, frontmatter, heading levels.
- Don't touch code files except to move plan files.
- If a doc and the code disagree, **code wins** — update the doc, not the code.
- Dates use `YYYY-MM-DD` from today's date in conversation context.
