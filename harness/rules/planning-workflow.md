# Planning & Development Workflow

## Workshop Period (Before Planning)
**Do NOT start a plan until planning is explicitly requested.**

When discussing features, bugs, or improvements:
- Ask clarifying questions to understand the full scope
- Discuss trade-offs and potential approaches
- Take notes on requirements, constraints, and context
- Identify unknowns and research gaps
- Gather as much information as possible before planning

This "workshop period" ensures complete context before committing to an
implementation strategy.

## Plan Creation
Once planning begins, create a comprehensive plan using:
- Full codebase analysis and existing patterns
- Architectural decisions and trade-offs
- Step-by-step implementation approach
- File list and estimated scope

All implementation plans are stored in `.agents/plans/` within the project directory.

The plan then goes to you for review and approval before implementation begins.

## Branch & Commit Discipline (solo operator)
- **Plans before code.** No plan = no implementation.
- **Branch before code.** Planning/brainstorming can happen on `main`; the moment a
  session edits a file, create a feature branch first.
- **Always branch from `origin/main`:** `git fetch origin && git checkout -b feat/<short-description> origin/main`.
- **Branch convention:** `<type>/<short-description>` (`feat/`, `fix/`, `chore/`, `wip/`).
