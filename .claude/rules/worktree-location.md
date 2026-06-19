# Worktree Location

## Rule
Every task's git worktree is created **inside the selected target repo**, under
that repo's own `worktrees/` folder:

```
<repo.path>/worktrees/<shortId>
```

Examples:
- task targeting **zmrng** → `~/Documents/Projects/zmrng/worktrees/<shortId>`
- task targeting **Pheme** → `~/Documents/Projects/Pheme/worktrees/<shortId>`

Worktrees are **never** placed in a separate global data dir (e.g.
`~/Library/Application Support/zmrng/worktrees/`). The working tree lives with
the repo it belongs to.

## How it's wired
- `phases.ts` → `start()` resolves the selected `RepoTarget` and passes
  `path.join(repo.path, 'worktrees')` to `createWorktree(...)`.
- `worktree.ts` → `createWorktree()` `mkdirSync`s that dir on demand and checks
  out `<dir>/<shortId>` on a fresh `feat/zmrng/<slug>-<shortId>` branch.
- Teardown (`removeWorktree`) and post-merge `syncLocalAfterMerge` already run
  against `repo.path`, so the worktree's lifecycle stays anchored to its repo.

## Gitignore the worktrees dir in target repos
Because the worktree now lives inside the target repo's working tree, add
`worktrees/` to that repo's `.gitignore` so the nested checkout never shows up
as untracked content (zmrng's own `.gitignore` already ignores `worktrees/*`).
