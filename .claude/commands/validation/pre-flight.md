---
description: Verify baseline stability before starting implementation
---

# Pre-Flight Validation

Run this command before starting any new feature implementation to ensure the codebase baseline is stable.

## Validation Steps

### 1. Install Dependencies

```bash
npm install
```

### 2. TypeScript Type Check

```bash
npm run typecheck
```

**Expected result:** No type errors

### 3. Lint Check

```bash
npm run lint
```

**Expected result:** No lint errors

### 4. Build Verification

```bash
npm run build
```

**Expected result:** All workspaces build successfully

### 5. Project Structure Check

Verify no orphaned directories:

```bash
# Should NOT exist
ls packages/server/server/
ls packages/web/web/
```

## Output

### Pre-Flight Status

| Check | Status | Notes |
|-------|--------|-------|
| npm install | pass/fail | |
| TypeScript | pass/fail | errors if any |
| Lint | pass/fail | issues if any |
| Build | pass/fail | errors if any |
| No orphan directories | pass/fail | |

### Blockers Found

If any unexpected failures:
- [ ] List each blocker
- [ ] Determine if it blocks your planned work
- [ ] Fix before proceeding OR document in plan's "Known Issues"

### Ready to Proceed

- [ ] All expected checks pass
- [ ] Known failures documented
- [ ] No unexpected blockers

## When to Run

- **Always:** Before starting any new feature implementation
- **After pulls:** When pulling changes from remote
- **After dependency changes:** When package.json changes
- **Before PRs:** To ensure clean baseline for reviewers
