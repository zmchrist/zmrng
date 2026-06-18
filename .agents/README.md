# AI Team Framework (lean core)

Lightweight agent + PIV workflow for building **zmrng** solo. This is the trimmed
core — no missions framework, no GitHub-automation pipelines, no patrol loops.

## PIV Loop (Plan → Implement → Validate → Review)

| Step | Command | Output |
|------|---------|--------|
| 1. Plan | `/plan-feature <desc>` | `.agents/plans/<slug>.md` |
| 2. Implement | `/execute .agents/plans/<slug>.md` | working changes on a feature branch |
| 3. Validate | `/validate` (or `npm run typecheck && npm run lint && npm run build`) | PASS/FAIL |
| 4. Review | `/code-review` | `.agents/code-reviews/<slug>.md` |

Plans before code. Branch before code (`feat/zc/<desc>` from `origin/main`).

## Agents

| Agent | Role | Modifies code? |
|-------|------|----------------|
| qa | Run typecheck/lint/build, report PASS/FAIL | No |
| fixer | Diagnose errors, minimal targeted fix, document in errors.md | Yes |
| code-reviewer | Review changes against plan + standards | No |
| backend-specialist | Fastify/WS/SQLite/runner/phases investigation + implementation | Yes |
| frontend-specialist | React/CSS Modules/frosted-glass investigation + implementation | Yes |
| doc-updater | Sync CLAUDE.md, services-reference, errors.md | Yes (docs only) |

Design principles:
- Commands orchestrate; agents don't call other agents.
- QA never fixes — it only reports. The fixer handles fixes.
- All code changes pass validation before commit/PR.

## Mode 3: Autonomous loop (`loop.sh` + `/work-item`)

Run a task file's work items autonomously, fresh Claude per item:
```bash
.agents/scripts/loop.sh .agents/tasks/my-feature.md
.agents/scripts/loop.sh .agents/tasks/my-feature.md --max-iterations 10
```
Pipeline per item: read task → implement → validate → mark done → next item.

Features:
- Fresh Claude instance per work item (no context pollution).
- Circuit breaker: 3 consecutive failures halts the loop.
- Progress tracked in task-file checkboxes (survives terminal closure).
- Per-iteration logs in `.agents/loop-state/` (gitignored).

Create task files with the `create-task` skill (`/create-task <desc>`).

## Task file format

```markdown
# Task: {Feature Name}

## Context
{Why this work is needed. Architectural notes, files to reuse.}

## Completion Criteria
{All items checked; npm run typecheck && npm run lint && npm run build passes.}

## Work Items
- [ ] 1. {Description} — `{target file(s)}`
- [ ] 2. {Description} — `{target file(s)}`
```
Conventions: `- [ ]` pending, `- [x]` done, `- [BLOCKED]` failed after retries.
Items numbered, dependency-ordered (types → services → routes → UI), each
independently committable.

## Directory structure

```
.agents/
├── README.md           # this file
├── scripts/loop.sh     # autonomous loop driver (Mode 3)
├── plans/              # implementation plans
├── tasks/              # task files for autonomous execution
├── code-reviews/       # code review reports
├── system-reviews/     # system review documents
└── handoffs/           # session handoff documents
```

## Prerequisites

- `claude` CLI available (for `loop.sh`).
- `gh auth login` completed if a task opens PRs.
