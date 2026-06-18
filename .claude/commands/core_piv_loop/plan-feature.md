---
description: "Create comprehensive feature plan with deep codebase analysis and research"
---

# Plan a new task

## Feature: $ARGUMENTS

## Mission

Transform a feature request into a **comprehensive implementation plan** through systematic codebase analysis, external research, and strategic planning.

**Core Principle**: We do NOT write code in this phase. Our goal is to create a context-rich implementation plan that enables one-pass implementation success for AI agents.

**Key Philosophy**: Context is King. The plan must contain ALL information needed for implementation.

## Planning Process

### Phase 1: Feature Understanding

**Deep Feature Analysis:**

- Extract the core problem being solved
- Identify user value and business impact
- Determine feature type: New Capability/Enhancement/Refactor/Bug Fix
- Assess complexity: Low/Medium/High
- Map affected workspaces (shared, ingest, server, web)

**Create User Story:**

```
As a <type of user>
I want to <action/goal>
So that <benefit/value>
```

### Phase 2: Codebase Intelligence Gathering

**1. Project Structure Analysis**

- Map the monorepo workspace structure
- Identify which packages are affected
- Locate configuration (package.json, tsconfig.json)

**2. Pattern Recognition**

- Search for similar implementations
- Identify coding conventions from existing code
- Check CLAUDE.md and `.claude/rules/` for project rules
- Document anti-patterns to avoid

**3. Dependency Analysis**

- Catalog relevant packages and versions
- Understand how shared types flow between packages

**4. Integration Points**

- Identify existing files that need updates
- Determine new files and their locations
- Map WebSocket message types if real-time features are involved
- Understand SQLite schema if data persistence is involved

**5. Pre-Implementation Verification**

```bash
npm install
npm run typecheck
npm run lint
npm run build
```

### Phase 3: External Research & Documentation

- Research latest library best practices
- Find official documentation
- Identify common gotchas
- Check for breaking changes

### Phase 4: Deep Strategic Thinking

- How does this fit the existing architecture?
- What could go wrong? (edge cases, race conditions)
- Performance implications?
- How will this be tested?

### Phase 5: Plan Structure Generation

Create plan at `.agents/plans/{kebab-case-name}.md` with:

- Feature description and user story
- Context references (files to read, patterns to follow)
- Step-by-step implementation tasks
- Testing strategy
- Validation commands
- Acceptance criteria

## Validation Commands (zmrng-specific)

```bash
# Level 1: Syntax & Style
npm run lint

# Level 2: Type Safety
npm run typecheck

# Level 3: Build
npm run build

# Level 4: Manual Validation
npm run dev:server  # Test backend
npm run dev:web     # Test frontend
```

## Output

**Filename**: `.agents/plans/{kebab-case-name}.md`

After creating the plan, provide:
- Summary of feature and approach
- Full path to created plan file
- Complexity assessment
- Key implementation risks
- Estimated confidence score for one-pass success
