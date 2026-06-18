---
description: Analyze implementation against plan for process improvements
context: fork
agent: general-purpose
---

# System Review

Perform a meta-level analysis of how well the implementation followed the plan.

## Purpose

**System review is NOT code review.** You're looking for bugs in the process, not bugs in the code.

## Context & Inputs

- **Plan file:** $1
- **Execution report:** $2

## Analysis Workflow

### Step 1: Understand the Planned Approach
Read the plan ($1) and extract planned features, architecture, and validation steps.

### Step 2: Understand the Actual Implementation
Read the execution report ($2) and extract what was implemented, what diverged, and why.

### Step 3: Classify Each Divergence

**Good Divergence:** Plan assumed something wrong, better pattern found, performance/security need.
**Bad Divergence:** Ignored constraints, took shortcuts, misunderstood requirements.

### Step 4: Trace Root Causes
For each problematic divergence: Was the plan unclear? Context missing? Validation missing?

### Step 5: Generate Process Improvements
Suggest updates to CLAUDE.md, plan commands, new commands, or validation additions.

## Output Format

Save to: `.agents/system-reviews/[feature-name]-review.md`

- **Overall Alignment Score:** __/10
- **Divergence Analysis** for each divergence
- **Pattern Compliance** checklist
- **System Improvement Actions** (CLAUDE.md updates, command updates, new commands)
- **Key Learnings** (what worked, what needs improvement)
