# Planning & Development Workflow

## Workshop Period (Before Planning)
**Do NOT start a plan until explicitly requested with the `/plan-feature` command.**

When discussing features, bugs, or improvements:
- Ask clarifying questions to understand the full scope
- Discuss trade-offs and potential approaches
- Take notes on requirements, constraints, and context
- Identify unknowns and research gaps
- Gather as much information as possible before planning

This "workshop period" ensures complete context before committing to an
implementation strategy.

## Plan Creation
Once you say `/plan-feature` (or equivalent), create a comprehensive plan using:
- Full codebase analysis and existing patterns
- Architectural decisions and trade-offs
- Step-by-step implementation approach
- File list and estimated scope

All implementation plans are stored in `.agents/plans/` within the project directory.

The plan then goes to you for review and approval before implementation begins.

## Branch & Commit Discipline (solo operator)
- **Plans before code.** No plan = no implementation.
- **Branch before code**, from `origin/main`, `<type>/zc/<desc>` convention. The full
  rule (and the `branch_guard`/`pr_shape_guard` hooks that enforce it) lives in
  `coding-lifecycle.md` — the single source of truth. Not restated here.
