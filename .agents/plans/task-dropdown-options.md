# Plan — Task dropdown options (repo scan · model prune · real caveman skill · settings visibility)

## Context
The "New task" form exposes four dropdowns (Repo · Model · Effort · Style) plus a
TaskDetail header. Operator wants:
1. Repo dropdown should list **every project in `~/Documents/Projects`** (not just the
   two static `config/repos.json` entries). Default repo target = **zmrng itself**, so
   default-repo workers operate in `~/Documents/Projects/zmrng`.
2. Model dropdown must **drop `fable`** (it doesn't work).
3. Selecting `caveman-*` must make the worker **actually invoke the `/caveman <level>`
   skill** — today zmrng only bakes equivalent wording into the system prompt.
4. Effort must be genuinely applied (it already is — passed as `--effort`).
5. Surface the active settings (model · effort · style · repo) in the task/chat window
   so the operator can see they are on.

## Changes

### Repo auto-scan + zmrng default — `packages/server/src/config.ts`
- Add `scanProjectsDir()`: read `~/Documents/Projects` (override via `ZMRNG_PROJECTS_DIR`),
  keep subdirectories that are git repos, build `RepoTarget` entries (id/label = folder
  name, defaultBranch = `main`).
- Add a guaranteed self entry for zmrng (`REPO_ROOT`) so it is always targetable.
- Merge precedence in `buildConfig`: explicit registry (`repos.json`/env/legacy) → zmrng
  self → scanned. Dedup by id and by resolved path so explicit labels/branches win.
- `defaultRepoId`: `ZMRNG_DEFAULT_REPO` (if valid) → the repo whose path === `REPO_ROOT`
  (zmrng) → `repos[0]`. This makes default workers sit in `~/Documents/Projects/zmrng`.

### Drop `fable`
- `packages/server/src/types.ts` — `ModelAlias = 'opus' | 'sonnet'`.
- `packages/web/src/types.ts` — same.
- `packages/web/src/components/NewTaskForm.tsx` — `MODEL_OPTIONS = ['opus', 'sonnet']`.

### Real caveman skill — `packages/server/src/phases.ts`
- Map `CaveStyle` → caveman skill arg (`caveman-lite→lite`, `caveman-full→full`,
  `caveman-ultra→ultra`, `wenyan-full→wenyan-full`).
- Rewrite `styleDirective()` so the worker's first action is to invoke the `caveman`
  skill at the mapped level (Skill tool, equivalent to `/caveman <level>`). Keep the
  existing register text as an explicit fallback if the skill is unavailable.
- Emit a `status` event at session start summarising the applied settings
  (`model · effort · style → /caveman <level>`) so it appears in the worker log.

### Settings visibility — `packages/web/src/components/TaskDetail.tsx`
- Label the existing badges (`model: …`, `effort: …`, `style: …`) so they read as live
  settings rather than bare tokens.

### Docs
- `.env.example` — document `ZMRNG_PROJECTS_DIR` and the zmrng-default behaviour;
  note model choices are `opus | sonnet`.

## Validation
`npm run typecheck && npm run lint && npm run build` from the zmrng repo root.
