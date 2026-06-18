# Task File Examples

## Good Examples

### Example: Add a server-default repo per model
```markdown
# Task: Persist last-used repo as the form default

## Plan
No plan — simple feature.

## Context
The New Task form always defaults to the server `defaultRepoId`. Operators want it
to remember the repo they last created a task against (localStorage), falling back
to the server default on first load.

- Repo registry comes from `GET /api/repos`; default from `GET /api/config`.
- `NewTaskForm` already derives `effectiveRepoId = repoId || defaultRepoId`.
- Server↔web types are a manual mirror — no shared package.

## Completion Criteria
- All work items checked off
- `npm run typecheck && npm run lint && npm run build` passes
- Reopening the form preselects the last-used repo

## Work Items
- [ ] 1. Read/write last-used repo id in localStorage — `packages/web/src/components/NewTaskForm.tsx`
- [ ] 2. Seed initial repo state from localStorage, fall back to `defaultRepoId` — `packages/web/src/components/NewTaskForm.tsx`
```

### Example: Add a task search/filter to the rail
```markdown
# Task: Filter tasks in the TaskList rail

## Plan
Full plan: `.agents/plans/task-filter.md`

## Context
With many tasks the rail gets long. Add a text filter (title substring) and a
status filter above the list. Pure client-side over the already-loaded tasks.

- `App.tsx` holds the task map and passes a sorted array to `TaskList`.
- Frosted-glass tokens in `theme.css`; reuse `.select`/`.input` patterns.
- WsEvents keep the task map live — filter must operate on current state.

## Completion Criteria
- All work items checked off
- `npm run typecheck && npm run lint && npm run build` passes
- Typing in the filter narrows the rail live; status filter works alongside it

## Work Items
- [ ] 1. Add a TaskFilter component (text + status select) — `packages/web/src/components/TaskFilter.tsx`, `packages/web/src/components/TaskFilter.module.css`
- [ ] 2. Lift filter state into App and apply it to the sorted task list — `packages/web/src/App.tsx`
- [ ] 3. Render TaskFilter above TaskList in the rail — `packages/web/src/App.tsx`
```

## Bad Examples (and why)

```markdown
# Too vague — fresh Claude won't know what to do
- [ ] 1. Improve the task UI

# Too broad — multiple concerns in one item
- [ ] 2. Add filter component, lift state, and restyle the rail

# No target files — fresh Claude has to guess
- [ ] 3. Create the new filter component

# Not independently committable
- [ ] 4. Add all the frontend changes
- [ ] 5. Add all the backend changes
```
