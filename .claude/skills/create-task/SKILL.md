---
name: create-task
description: Create a structured task file for Mode 3 autonomous loop execution
---

# Create Task Skill

Transforms a feature request into a well-structured task file that `loop.sh` and `/work-item` can execute autonomously.

## When to Use
- Breaking a feature into executable work items for autonomous development
- Preparing for Mode 3 loop execution
- After `/plan-feature` has created a plan (reads the plan automatically)

## What It Does
1. Searches `.agents/plans/` for an existing plan
2. If plan exists: extracts architecture decisions, patterns, and file paths
3. Breaks the feature into 5-15 ordered, independent work items
4. Each item names specific target files and is independently committable
5. Writes task file to `.agents/tasks/{name}.md`

## Output
- Task file at `.agents/tasks/{kebab-case-name}.md`
- Run command: `.agents/scripts/loop.sh .agents/tasks/{name}.md`

## Validation
Each work item must:
- Name specific target files
- Be dependency-ordered (types → services → routes → UI)
- Be implementable by a fresh Claude with no prior context
- Leave `npm run typecheck && npm run lint && npm run build` passing
