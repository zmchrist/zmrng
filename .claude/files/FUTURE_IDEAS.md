# Future Ideas

Deferred features and exploration notes. Not commitments — promote to a plan in
`.agents/plans/` when one is picked up.

## Usage / cost dashboard
Aggregate the per-task token/cost usage already persisted in SQLite into a dashboard:
spend over time, per-repo and per-model breakdowns, turns per task. Usage data exists;
this is presentation only.

## Kanban board view
A column-per-status board (backlog / clarify / building / review / done) as an
alternative to the rail, with drag-free status driven by the existing state machine.

## In-app repo management
Add/edit/remove registry entries from the UI instead of hand-editing
`config/repos.json`. Would need a write path + validation (git-repo check) server-side.

## Per-repo defaults
Let each registry entry carry default model/effort/style so a task inherits sensible
defaults for the repo it targets.

## Multi-repo task batching
Fan a single task description across several target repos at once (e.g. a dependency
bump applied to every repo), tracking each as its own worktree/PR.

## Auto-discovery of repos
Scan `~/Documents/Projects` for git repos and offer them as registry candidates rather
than requiring explicit config entries.

## Richer worktree lifecycle
Surface stale/abandoned worktrees in the UI with a one-click cleanup, and reap
worktrees for tasks that failed before reaching review.
