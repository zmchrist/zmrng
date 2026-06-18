---
description: Run all validation commands in the correct sequence
context: fork
agent: general-purpose
---

# Full Validation Workflow

Run all validation checks in the proper sequence.

## Full Validation Sequence

### Step 1: Pre-Flight Check
```
/validation:pre-flight
```
Verify baseline stability (dependencies, build, types)

### Step 2: Comprehensive Validation
```
/validation:validate
```
Run full project validation suite

### Step 3: Code Quality Review
```
/validation:code-review
```
Technical review for bugs, style, and quality

### Step 4: Fix Code Review Issues
```
/validation:code-review-fix
```
Only needed if code review found issues

### Step 5: System Review
```
/validation:system-review
```
Analyze implementation against plan

### Step 6: Execution Report
```
/validation:execution-report
```
Generate final implementation report

## Quick Validation (Fast Path)

```bash
npm run typecheck && npm run lint && npm run build
```

## Single Command Chain

```bash
npm install && npm run typecheck && npm run lint && npm run build
```

Then proceed with individual validation commands as needed.

## Validation Checklist

- [ ] Pre-flight check: All baseline checks pass
- [ ] Comprehensive validation: No critical issues
- [ ] Code review: No blocking issues
- [ ] Code review fix: Issues resolved or documented
- [ ] System review: Implementation matches plan
- [ ] Execution report: Generated and reviewed
