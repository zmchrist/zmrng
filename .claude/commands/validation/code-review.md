---
description: Technical code review for quality and bugs that runs pre-commit
allowed-tools: Bash(git diff *) Bash(git log *) Bash(git status *) Bash(git ls-files *)
---

Perform technical code review on recently changed files.

## What to Review

Start by gathering codebase context:

- Read CLAUDE.md
- Read `.claude/rules/backend-typescript.md` and `.claude/rules/frontend-react.md`

Then examine changes:

```bash
git status
git diff HEAD
git diff --stat HEAD
git ls-files --others --exclude-standard
```

Read each changed/new file in its entirety. For each, analyze for:

1. **Logic Errors** — Off-by-one, incorrect conditionals, missing error handling, race conditions
2. **Security Issues** — Injection vulnerabilities, exposed secrets, insecure data handling
3. **Performance Problems** — Inefficient algorithms, memory leaks, unnecessary computations
4. **Code Quality** — DRY violations, overly complex functions, poor naming, missing types
5. **Pattern Adherence** — Design token usage, shared type imports, CSS Module conventions, Pino logging

## Output Format

Save to `.agents/code-reviews/[appropriate-name].md`

**For each issue found:**

```
severity: critical|high|medium|low
file: path/to/file.ts
line: 42
issue: [one-line description]
detail: [explanation of why this is a problem]
suggestion: [how to fix it]
```

If no issues found: "Code review passed. No technical issues detected."

## Important

- Be specific (line numbers, not vague complaints)
- Focus on real bugs, not style
- Suggest fixes, don't just complain
- Flag security issues as CRITICAL
