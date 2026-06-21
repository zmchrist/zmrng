# Plan — Agent interaction (live interactive chat across all autonomous phases · hard-Stop interrupt · surfaced tool/subagent activity, color-coded)

## Context

The operator wants the zmrng worker chat to behave like the Claude Code CLI: an
**interactive session for the whole build**. The worker keeps driving the plan
autonomously by default, but the operator can (a) type to redirect it mid-build at any
phase, (b) hit a hard **Stop** (ESC-style interrupt) to cut the current action, and (c)
**see what the worker is doing** — its decisions, the tool calls it makes, and the
subagents it spawns — color-coded by actor.

This work targets the desktop **app** (`packages/desktop` Tauri shell) per the CLAUDE.md
app-only directive, so the task is **not "done" until the `.app` is rebuilt** with
`npm run desktop:build` (a plain `npm run build` only refreshes the website).

### Agreed scope (from the clarify conversation — locked)

| Q  | Decision |
|----|----------|
| Q1 | **c** — typing queues a redirect to the worker; a separate **Stop** button does a hard ESC-style interrupt. |
| Q2 | **a** — live chat in **all** autonomous phases (planning + executing + validating); clarify is already live. |
| Q3 | **a** — show decisions + subagents + tool calls (Bash/Edit/Read as compact lines). Not full CLI fidelity (no tool args dumps / file diffs / todos). |
| Q4 | **a** — color-code **by actor**: the main worker and each subagent (`subagent_type`) get their own color. |
| Q5 | **a** — show subagent spawn (colored by type) + its result summary. The headless parent stream cannot live-stream a subagent's *internal* steps (they are nested, not on the parent's stdout), so subagents are surfaced at spawn/result granularity only. Main-worker tool calls stream live. |
| Q6 | **a** — after a hard Stop the worker **idles awaiting the operator's next message**, then resumes autonomously (CLI model). No separate explicit "Resume" button for this. |
| Q7 | **a** — phase auto-progression stays fully automatic (plan→execute→validate→PR); operator chat is **optional steering**, the worker never waits on the operator unless interrupted. |

## User story

```
As the solo operator of zmrng
I want the worker chat to stay a live, interruptible session through every autonomous
  phase — with the tool calls and subagents it runs shown and color-coded —
So that I get the same full autonomy I have in the Claude Code CLI: watch the decisions,
  redirect mid-build by typing, and hard-stop it the instant I see it go wrong.
```

## Feature type & complexity

- **Type:** Enhancement (backend runner/state-machine + frontend chat/log).
- **Complexity:** High — touches the stream-json parser, the phase state machine's
  message gate and failure detection, the WS event schema (both type mirrors), and three
  frontend components plus new design tokens. Multi-file, architectural (new interrupt
  control path), and has a real race-condition surface (interrupt vs. turn-result).

## Key findings from codebase analysis

### Runner (`packages/server/src/runner.ts`)
- One long-lived `claude` child per task, launched with
  `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --dangerously-skip-permissions`.
- `send(text)` writes a `{type:'user', message:{role:'user', content:[{type:'text',text}]}}`
  line to the child's stdin — **already supports mid-session input** (clarify uses it for
  multiple operator turns; the child stays alive reading stdin until it is closed).
- `handleLine()` switches on line `type`: `stream_event` (partial text deltas), `assistant`
  (text blocks only — `assistantText()` keeps `type==='text'` blocks and **drops everything
  else**, including `tool_use`), `result`, and a `default` that ignores all other line
  types (including `user` lines that carry `tool_result` blocks, and `control_response`).
  → **Tool calls and subagent (Task) spawns are dropped today** and never surface.
- No interrupt path exists.

### Verified: `claude` binary supports a stream-json interrupt control request
`claude` **2.1.177** (the installed binary). Confirmed by inspecting the binary that the
control protocol and the interrupt subtype are present. The exact envelope the SDK writes
to stdin is:

```json
{"type":"control_request","request_id":"<uuid>","request":{"subtype":"interrupt"}}
```

The child replies with a `{"type":"control_response", ...}` line (currently hits the
runner's tolerant `default` no-op — safe). Sending this interrupts the in-flight turn.
**No fallback to queue-only is needed** — the hard interrupt is real for this binary. (The
plan still degrades gracefully: if a future binary lacks it, the worst case is the
interrupt line is ignored and only the queued redirect lands.)

### Phases / state machine (`packages/server/src/phases.ts`)
- `message(taskId, text)` **hard-gates on `task.status === 'clarify'`** — planning,
  executing and validating all `throw 'operator messages are only accepted during the
  clarify phase'`. This is the gate to lift (Q2=a).
- `detect()` runs control-token detection on **worker output only** (assistant text +
  result text), never on operator text → injecting operator messages cannot trip a control
  token. Good.
- **Risk:** `detect()` lines 338–344 — for `executing`/`validating`, a `result` with
  `isError && !prUrl` calls `this.fail(...)`. A hard interrupt ends the current turn with a
  `result` that may carry `is_error` (or simply no PR), so without a guard **Stop would
  fail the task.** The interrupt path must suppress this.
- `replaceChild()` / `replacing` set already distinguish intentional child kills from
  crashes — the interrupt does **not** kill the child (the same child keeps the session),
  so `onExit` is not involved.

### WS event schema (`types.ts` + the manual web mirror)
- `EventKind = 'claude' | 'status' | 'operator' | 'error'`.
- `EventSub = 'init' | 'assistant' | 'partial' | 'result' | 'status' | 'operator' | 'error'`.
- `EventPayload` is a freeform-ish struct persisted as JSON text in the `events` table
  (`db.ts` stores `JSON.stringify(payload)`), so **adding new `EventSub` values and payload
  fields needs NO SQLite migration** — only the two TS type files must stay in sync.

### Frontend
- `TaskDetail.tsx` renders `<ClarifyChat>` **only when `status === 'clarify'`**, and shows
  a static "Running autonomously to PR — no input needed." autobar for the
  `AUTONOMOUS = {planning, executing, validating, building}` set.
- `WorkerLog.tsx` `renderEvent()` handles operator / error / status / claude-init /
  claude-result / claude-assistant. New subs need new branches.
- `status.ts` has `statusColor(s) => var(--status-${s})` and `STATUS_LABEL` — the precedent
  for a token-backed color helper. There is **no** actor color helper yet.
- `theme.css` has `--status-*` tokens but **no actor palette**. Per the frosted-glass rule
  (NEVER hard-code colors), actor colors must be added as new `--actor-*` tokens.
- `api.ts` already has `message(id, text)`; needs an `interrupt(id)`.

## Design decisions

1. **Lift the message gate to all live phases.** `message()` accepts an operator turn when
   a live runner exists and `status ∈ {clarify, planning, executing, validating}`. It keeps
   emitting an `operator` event and `runner.send(text)`. `building` (legacy) is excluded;
   `blocked` keeps its dedicated `resume()` path; `backlog/review/done/failed` still reject.
2. **Hard Stop = a stream-json interrupt control request, not a kill.** New
   `Runner.interrupt()` writes the `control_request`/`interrupt` envelope to the child's
   stdin (child stays alive). New `TaskManager.interrupt(taskId)` calls it, marks the task
   `interrupting`, and emits a status note. Per Q6=a the worker then idles; the operator's
   next `message()` steers it and it resumes autonomously — no new status, no explicit
   resume button.
3. **Guard the interrupt against the failure detector.** `TaskManager` holds a
   `private interrupting = new Set<string>()`. At the top of `detect()`, if
   `interrupting.has(taskId)` and the chunk is a `result`, **consume the flag, emit a
   "turn interrupted — awaiting your direction" status, and return early** (skip all token
   detection and the `isError`-fail branch). This is the critical race fix.
4. **Surface activity by parsing currently-dropped blocks in the runner.** Extend the
   `assistant` parse to also walk `tool_use` blocks, and start handling `user` lines to read
   `tool_result` blocks:
   - `tool_use` with `name !== 'Task'` → a **main-worker tool call** (`sub:'tool'`,
     `actor:'main'`), compact-summarized (Bash→command, Edit/Write/Read→file_path, else a
     short JSON-ish snippet).
   - `tool_use` with `name === 'Task'` → a **subagent spawn** (`sub:'subagent'`,
     `actor: input.subagent_type`, summary = `input.description`).
   - `tool_result` whose `tool_use_id` matches a tracked Task spawn → a **subagent result
     summary** (`sub:'subagent_result'`, `actor:` that subagent's type, summary = first
     ~200 chars of the result). Main-worker tool *results* are intentionally **not**
     surfaced (Q3=a is tool *calls* + subagent results; emitting every tool result is noise).
   The runner keeps a small bounded `Map<tool_use_id, {name, subagentType}>` to classify the
   matching `tool_result`, and prunes entries as results arrive.
5. **Color-code by actor (Q4=a).** Every new activity event carries an `actor` string
   (`'main'` or the `subagent_type`). The web maps an actor → a `--actor-*` theme token via
   a new `actorColor()` helper (mirrors `statusColor()`). A small fixed palette covers the
   known agents (`main`, `frontend-specialist`, `backend-specialist`, `qa`,
   `code-reviewer`, `doc-updater`, `general-purpose`) with a deterministic fallback for any
   other type.
6. **Frontend composer is always available in live phases.** `ClarifyChat` is generalized
   into the always-on composer (kept name to minimize churn, given a `placeholder` prop) and
   rendered for `clarify | planning | executing | validating`. A **Stop** button
   (wired to `interrupt`) shows during the autonomous live phases. The autobar copy changes
   from "no input needed" to steer/stop guidance.

## Changes

### Backend

#### 1. `packages/server/src/types.ts` (SOURCE OF TRUTH)
- Extend `EventSub` with `'tool' | 'subagent' | 'subagent_result'`.
- Extend `EventPayload` with optional fields used by the new events:
  - `tool?: string` — tool name (e.g. `Bash`, `Edit`, `Task`).
  - `actor?: string` — `'main'` or a `subagent_type` (drives color).
  - `subagentType?: string` — for `subagent`/`subagent_result` (redundant with `actor` but
    explicit for the log label).
  - `summary?: string` — compact one-line summary (tool target / subagent description /
    result head). (Reuse `text` only where it already means free text; use `summary` for the
    compact activity line to keep `text` semantics unchanged.)
- No change to `EventKind` (new subs all ride under `kind:'claude'`).

#### 2. `packages/web/src/types.ts` (MANUAL MIRROR)
- Apply the **identical** `EventSub` + `EventPayload` additions. `npm run typecheck` over
  both workspaces is what guarantees the mirror.

#### 3. `packages/server/src/runner.ts`
- **Interrupt:** add `interrupt(): void` that writes
  `{type:'control_request', request_id:<randomUUID>, request:{subtype:'interrupt'}}` + `\n`
  to `this.child.stdin`. Import `randomUUID` from `node:crypto`. Tolerate a closed stdin
  (try/catch like `kill()`).
- **New callbacks** on `RunnerCallbacks`:
  - `onToolUse(name: string, summary: string, isSubagent: boolean, subagentType?: string)`.
  - `onSubagentResult(subagentType: string, summary: string, isError: boolean)`.
- **Parse tool_use** in the `assistant` case: keep emitting `onAssistantText` for the joined
  text (unchanged), and additionally iterate the content array; for each `type==='tool_use'`
  block read `name`/`input`/`id`. If `name === 'Task'`: record the id in a bounded
  `pendingTasks` map (`id → subagent_type`) and call `onToolUse(name, description, true,
  subagent_type)`. Else call `onToolUse(name, summarizeTool(name,input), false)`.
- **Handle `user` lines** (replace the blanket ignore): walk the message content for
  `type==='tool_result'` blocks; if `tool_use_id` is in `pendingTasks`, call
  `onSubagentResult(subagentType, summarizeResult(content), is_error===true)` and delete the
  entry. (Ignore tool_results for non-Task ids — main-worker results are not surfaced.)
  Guard against treating our own injected operator `user` writes as input — these are read
  from the **child's stdout**, which only carries the assistant's own echoed tool_results,
  so this is safe; still narrow strictly to lines that actually contain `tool_result`
  blocks.
- Add small tolerant helpers `summarizeTool(name, input)` and `summarizeResult(content)`
  using the existing `asRecord`/`asString` pattern (no `any`). `summarizeTool`: Bash→
  `input.command`; Edit/Write/Read/NotebookEdit→`input.file_path`; Grep/Glob→`input.pattern`;
  Task→`input.description`; fallback→short stringify of the first scalar input value.
  `summarizeResult`: string content as-is else join text blocks, trimmed to ~200 chars.
- Leave `control_response` on the tolerant `default` no-op (no crash). Add a brief comment
  noting the child may emit `control_request`s of its own; under
  `--dangerously-skip-permissions` the permission request is bypassed, so no responder is
  required (watch-item, not in scope).

#### 4. `packages/server/src/phases.ts`
- **`message()`** — replace the clarify-only gate with: allow when
  `status ∈ {clarify, planning, executing, validating}` and a runner exists; otherwise throw
  a clear message (`operator messages are only accepted while the worker is live`).
  Body unchanged (emit `operator` event + `runner.send(text)`).
- **`interrupt(taskId)`** (new public method) — look up the runner (throw if none); add the
  task to `this.interrupting`; call `runner.interrupt()`; emit a `status` event
  (`note: 'Stop — interrupting the worker; it will wait for your next message'`). Do **not**
  change status (the task stays in its live phase; Q6=a CLI model).
- **`interrupting` set** (new private field) + guard at the **top of `detect()`**: if
  `this.interrupting.has(taskId)`, then on a `result` chunk (i.e. `isError` param path —
  detect is called with the result text) consume the flag, emit a `status` note
  (`'turn interrupted — awaiting your direction'`), and `return` before any token/PR/fail
  logic. (Assistant chunks while interrupting just fall through normally.)
- **Wire the new runner callbacks** in `spawn()`:
  - `onToolUse: (name, summary, isSubagent, subagentType) =>` emit `claude` event with
    `sub: isSubagent ? 'subagent' : 'tool'`, `tool: name`, `summary`, `subagentType`,
    `actor: isSubagent ? (subagentType ?? 'subagent') : 'main'`.
  - `onSubagentResult: (subagentType, summary, isError) =>` emit `claude` event with
    `sub:'subagent_result'`, `subagentType`, `actor: subagentType`, `summary`, `isError`.
  - Add `interrupting.delete(taskId)` to `fail()`, `done()`, `cancel()`, `onPr()` cleanup so
    the flag never leaks across a task's lifecycle (mirror the existing `blockedFrom.delete`
    cleanup sites).
- `clarifyTranscript()` is unaffected (it filters on `kind==='operator'` / assistant text);
  the new activity events are ignored by it.

#### 5. `packages/server/src/index.ts`
- Add `POST /api/tasks/:id/interrupt` → `manager.interrupt(id)` (bodyless; mirror the
  `resume` route's try/catch + 400 on error shape).

`db.ts` needs **no change** (events payload is freeform JSON; no new column). State this
explicitly so the implementer doesn't add a needless migration.

### Frontend

#### 6. `packages/web/src/api.ts`
- Add `interrupt: (id) => req<{ ok: true }>(`/api/tasks/${id}/interrupt`, { method: 'POST' })`
  (bodyless, like `start`/`resume`).

#### 7. `packages/web/src/theme.css`
- Add an **actor palette** block under the status hues, all muted to fit the smoke theme,
  e.g. `--actor-main`, `--actor-frontend-specialist`, `--actor-backend-specialist`,
  `--actor-qa`, `--actor-code-reviewer`, `--actor-doc-updater`, `--actor-general-purpose`,
  and a neutral `--actor-default` fallback. (Distinct, legible-on-glass hues; reuse/extend
  the existing status hue language so it stays cohesive.)

#### 8. `packages/web/src/status.ts` (or a new `actors.ts`)
- Add `actorColor(actor: string): string` returning `var(--actor-<slug>)` for a known actor,
  else `var(--actor-default)`. Slugify the `subagent_type` to match the token names. Keep it
  beside `statusColor` for discoverability (precedent: the single sanctioned dynamic inline
  `color` style is the status pill).

#### 9. `packages/web/src/components/WorkerLog.tsx` (+ `WorkerLog.module.css`)
- Add `renderEvent` branches for `payload.sub`:
  - `'tool'` → compact mono line, e.g. `⚙ {tool}: {summary}`, left-accented with
    `actorColor('main')`.
  - `'subagent'` → `▸ {subagentType} — {summary}` (spawn), accented with
    `actorColor(subagentType)`.
  - `'subagent_result'` → `◂ {subagentType}: {summary}` (result), same actor color, dimmer /
    `resultError` styling when `isError`.
- Color is applied as the one sanctioned dynamic inline style (`style={{ color }}` / a
  `border/box-shadow` accent driven by `actorColor(...)`), following the status-pill
  precedent; everything else stays in the CSS module using theme tokens.
- New `.module.css` classes: `.tool`, `.subagent`, `.subagentResult` (compact rows, mono
  font via `--font-mono`, tokenized spacing/radius). No raw hex/blur/radius.

#### 10. `packages/web/src/components/ClarifyChat.tsx` (generalize to the live composer)
- Add an optional `placeholder?: string` prop (default keeps the clarify copy). No behavior
  change otherwise (⌘↵ to send, trim, clear).

#### 11. `packages/web/src/components/TaskDetail.tsx`
- Add `onInterrupt: () => Promise<unknown>` to `Props`.
- Define `LIVE = {clarify, planning, executing, validating}` and render the composer for any
  of those (not just clarify), with a phase-appropriate placeholder
  ("Steer the worker… (⌘↵ to send)" for the autonomous phases).
- Add a **Stop** button in `.actions` shown for `planning | executing | validating`
  (autonomous live phases), wired to `run(onInterrupt)`, styled like the existing `.danger`
  but distinct copy ("Stop"). (Cancel stays as the terminate action; Stop only interrupts.)
- Update the autobar copy for autonomous phases from "Running autonomously to PR — no input
  needed." to e.g. "Running autonomously — type to steer, Stop to interrupt." (Keep the
  queued-lane message.)

#### 12. `packages/web/src/App.tsx`
- Pass `onInterrupt={() => api.interrupt(selected.id)}` into `<TaskDetail>`. (`onMessage`
  already wired.) No `useWs`/event-handling change — new events arrive as ordinary
  `kind:'claude'` events and append to the log like any other.

## Edge cases & risks

1. **Interrupt vs. turn-result race (highest risk).** Handled by the `interrupting` guard
   at the top of `detect()` — the interrupted turn's `result` is consumed without failing or
   mis-transitioning the task. Verify the worker truly idles after interrupt (no auto-retry)
   and that a subsequent operator `message()` resumes it.
2. **Operator text containing a control token.** Operator text never flows through
   `detect()` (only worker output does), so an operator typing `ZMRNG_VALIDATING` cannot
   trip the state machine. No change needed — but keep `detect()` strictly on worker chunks.
3. **`user`-line parsing scope.** Only parse `user` lines from the child's stdout for
   `tool_result` blocks; never confuse them with our injected operator `send()` writes
   (those go to stdin, not stdout). Narrow strictly to content arrays containing
   `tool_result`.
4. **Map growth.** The `pendingTasks` map could grow if a Task never returns a result; cap
   it / prune on result, and it dies with the runner anyway.
5. **Lane/queue integrity.** Interrupt does not free or acquire a lane, does not change
   status, and does not kill the child — so `executeLanes`/`executeQueue` are untouched.
   `interrupting` is cleaned up in `fail/done/cancel/onPr` to avoid cross-task leakage.
6. **Type-mirror drift.** The most common break — `types.ts` ↔ web mirror must change in the
   same commit; `npm run typecheck` over both workspaces catches it.
7. **Persisted legacy events.** Old events lack the new subs; `renderEvent` keeps its
   existing fallbacks, so historical logs render unchanged.
8. **Subagent visibility ceiling (accepted, Q5=a).** No live stream inside subagents — only
   spawn + result summary. Make the spawn/result lines clearly read as boundaries so the gap
   is obvious, not a bug.

## Testing strategy

No test framework yet — validation is typecheck + lint + build + manual smoke, then the
**app rebuild**.

```bash
# Level 1–3
npm run lint
npm run typecheck      # both workspaces — catches the type-mirror
npm run build

# Level 4 — manual smoke (npm run dev)
# 1. Create a task → Start → clarify (composer works as before).
# 2. Answer Qs → ZMRNG_READY → planning. Composer STILL present; type a steer message →
#    confirm an `operator` bubble appears and the worker acknowledges.
# 3. During executing, watch the log: confirm `⚙ tool` lines (Bash/Edit/Read) stream and
#    `▸ subagent` spawns + `◂ subagent result` lines appear, color-coded by actor.
# 4. Hit Stop mid-turn → confirm the worker stops, a "turn interrupted — awaiting your
#    direction" status shows, the task does NOT fail, and a follow-up message resumes it.
# 5. Let a task run unsteered → confirm full auto plan→execute→validate→PR still works
#    (Q7=a: no new gating).

# Level 5 — REQUIRED app rebuild (app-only directive)
npm run desktop:build
```

## Validation commands

```bash
npm run lint
npm run typecheck
npm run build
npm run desktop:build   # ship the new code in the .app (NOT optional)
```

## Acceptance criteria

- [ ] Operator can send chat messages during planning, executing, and validating (not only
      clarify); each appears as an operator event and reaches the live worker.
- [ ] A **Stop** button performs a hard stream-json interrupt of the current turn; the
      worker then idles awaiting the operator and resumes on the next message — **without
      failing the task**.
- [ ] The worker log shows main-worker tool calls (compact Bash/Edit/Read lines) and
      subagent spawns + result summaries, **color-coded by actor** using theme tokens.
- [ ] Phase auto-progression (plan→execute→validate→PR) is unchanged when the operator does
      not intervene.
- [ ] `types.ts` and its web mirror stay in sync; no SQLite migration is introduced.
- [ ] `npm run lint && npm run typecheck && npm run build` pass, and `npm run desktop:build`
      produces a fresh `.app` carrying the change.

## Files touched

**Backend:** `packages/server/src/types.ts`, `runner.ts`, `phases.ts`, `index.ts`.
**Frontend:** `packages/web/src/types.ts`, `api.ts`, `theme.css`, `status.ts` (or new
`actors.ts`), `components/WorkerLog.tsx` (+ `.module.css`), `components/ClarifyChat.tsx`,
`components/TaskDetail.tsx`, `App.tsx`.
**No change:** `db.ts` (freeform JSON payload — no migration), `ws.ts`, `worktree.ts`,
`config.ts`.

## Confidence (one-pass): 8/10

The interrupt envelope is verified against the installed binary, the event-schema change
needs no migration, and the message-gate lift is a one-line guard change. The main
implementation risk is the interrupt/turn-result race (mitigated by the `interrupting`
guard) and getting the actor color palette to read cohesively on the frosted glass.
