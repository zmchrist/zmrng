---
description: Run comprehensive validation — type check, lint, build, and manual checks
---

Run comprehensive validation of the zmrng project.

Execute the following commands in sequence and report results:

## 1. TypeScript Type Check

```bash
npm run typecheck
```

**Expected:** No type errors across all workspaces

## 2. Lint Check

```bash
npm run lint
```

**Expected:** No lint errors

## 3. Build All Packages

```bash
npm run build
```

**Expected:** Both workspaces build successfully (server, web)

## 4. Config Check (if server running)

```bash
curl -s http://localhost:4500/api/config 2>/dev/null | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d)))" || echo "Server not running — skipped"
```

**Expected:** JSON with model, maxLanes, defaultRepoId, authMode

## 5. Summary Report

After all validations complete, provide:

| Check | Status | Notes |
|-------|--------|-------|
| TypeScript | PASS/FAIL | Errors if any |
| Lint | PASS/FAIL | Issues if any |
| Build (shared) | PASS/FAIL | |
| Build (ingest) | PASS/FAIL | |
| Build (server) | PASS/FAIL | |
| Build (web) | PASS/FAIL | |
| Health Check | PASS/FAIL/SKIPPED | |

**Overall Health:** PASS/FAIL
