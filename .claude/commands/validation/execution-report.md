---
description: Generate implementation report for system review
context: fork
agent: general-purpose
---

# Execution Report

Review and analyze the implementation you just completed.

## Generate Report

Save to: `.agents/execution-reports/[feature-name].md`

### Meta Information
- Plan file: [path to plan]
- Files added: [list with paths]
- Files modified: [list with paths]
- Lines changed: +X -Y

### Validation Results
- TypeScript: pass/fail
- Lint: pass/fail
- Build: pass/fail

### What Went Well
- [concrete examples]

### Challenges Encountered
- [what was difficult and why]

### Divergences from Plan
**[Divergence Title]**
- Planned: [what the plan specified]
- Actual: [what was implemented instead]
- Reason: [why]
- Type: [Better approach found | Plan assumption wrong | Other]

### Skipped Items
- [what was skipped and why]

### Recommendations
- Plan command improvements
- Execute command improvements
- CLAUDE.md additions
