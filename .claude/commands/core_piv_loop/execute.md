---
description: Execute an implementation plan
argument-hint: [path-to-plan]
---

# Execute: Implement from Plan

## Plan to Execute

Read plan file: `$ARGUMENTS`

## Execution Instructions

### 0. Create Feature Branch (FIRST — before any file changes)

Check current branch:
```bash
git rev-parse --abbrev-ref HEAD
```

If on `main` or `master`, create a branch immediately:
```bash
git fetch origin
git checkout -b feat/<initials>/<short-description> origin/main
```

Branch name must follow project convention: `<type>/<initials>/<short-description>`  
Derive the short-description from the plan filename or its title.  
**Never make any file changes on `main`.**

### 1. Pre-Flight Verification

```bash
npm install
npm run typecheck
npm run lint
npm run build
```

**If any fail:** Fix first or document as known issue before proceeding.

### 2. Read and Understand

- Read the ENTIRE plan carefully
- Understand all tasks and their dependencies
- Note the validation commands to run
- Review the testing strategy

### 3. Execute Tasks in Order

For EACH task in "Step by Step Tasks":

#### a. Navigate to the task
- Identify the file and action required
- Read existing related files if modifying

#### b. Implement the task
- Follow the detailed specifications exactly
- Maintain consistency with existing code patterns
- Keep server↔web types in sync (manual mirror — `packages/server/src/types.ts` ↔ `packages/web/src/types.ts`)
- Use frosted-glass design tokens from `packages/web/src/theme.css` for frontend work

#### c. Verify as you go
- After each file change, check syntax
- Ensure imports are correct

### 4. Run Validation Commands

Execute in this order:

**Step 1: Lint**
```bash
npm run lint
```

**Step 2: Type Check**
```bash
npm run typecheck
```

**Step 3: Build**
```bash
npm run build
```

If any command fails:
- Fix the issue
- Re-run the command
- Continue only when it passes

### 5. Final Verification

- All tasks from plan completed
- All validation commands pass
- Code follows project conventions
- Design tokens used (no hard-coded hex)

## Output Report

### Completed Tasks
- List of all tasks completed
- Files created/modified (with paths)

### Validation Results
```bash
# Output from each validation command
```

### Ready for Commit
- Confirm all changes are complete
- Confirm all validations pass

## Divergence Documentation

When you must deviate from the plan:

```markdown
### Divergence: [Brief description]
- **Planned:** [What the plan specified]
- **Actual:** [What you implemented instead]
- **Reason:** [Why the change was necessary]
```
