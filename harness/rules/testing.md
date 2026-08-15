# Pre-Implementation Checklist

Before starting any new feature implementation, verify the baseline is stable:

```bash
# Install dependencies cleanly
# Run the project's typecheck/build command (if the language is typed/compiled)
# Run the project's lint command
# Run the project's test command
```

**If any fail:** Fix first or document as a known issue before proceeding.

---

# Testing Conventions

## Framework

Use whatever test framework the project already has configured. Do not
introduce a second test framework without a strong reason; prefer the
existing convention over a personal preference.

- Keep tests colocated with (or in the directory convention used by) the
  code they cover, following whatever layout the project already uses.
- Test fixtures and setup files follow the same layout convention as the
  existing test suite.

Run the project's test command (e.g. via its package manager or task
runner) for the whole suite, and its watch/single-target variant when
iterating on one area.

## What to cover

- Any parsing, state-machine, or control-token/regex logic — including
  near-miss cases that must NOT match (values quoted in prose, look-alike
  inputs).
- Any data-summarization or transformation helpers, fed realistic fixture
  data checked into the test directory.
- Persistence layer migrations/idempotency and any atomic accumulation
  logic.
- Configuration precedence (e.g. explicit config → env vars → legacy
  fallback) and empty/invalid-config guards.
- Any pinned "contract" text (prompts, templates, generated docs) that
  other tooling depends on staying in sync — assert it contains the
  required sections/rules so deleting one fails the suite.
- The core state machine or workflow engine, if one exists: drive it
  through a real (but temporary/sandboxed) environment where feasible, with
  external side effects (network calls, third-party CLIs) faked out via an
  injected seam.

## Hard rules

- **No test makes real network calls, spawns a real external service
  process, or calls a third-party CLI.** Use dependency-injection seams
  (factories, interfaces) to keep tests hermetic. Tests that need a real
  filesystem or local repo may operate against a temp directory/repo — that
  part is worth proving for real.
- **Never depend on secrets or credentials** (API keys, tokens) or a global
  environment/config; tests that need identity/config should set local,
  throwaway values scoped to the test.
- **Coverage is not a gate.** Do not add coverage thresholds.

## Type-mirror check (if applicable)

If this project keeps a manually mirrored type definition in more than one
place (e.g. no shared package between two workspaces), any change to the
source-of-truth types must be mirrored in the same change. The project's
typecheck command across all affected workspaces is what catches drift.

## Manual Smoke (when touching the core engine)

```bash
# Start the project locally (dev command)
# - exercise the primary user-facing flow end to end
# - confirm the expected external effect (e.g. artifact produced, request
#   completed) actually happens
```
