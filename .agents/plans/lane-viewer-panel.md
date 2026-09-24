# Lane viewer panel

## Goal

Add a read-only, live-updating **Lanes** tab to the Workspace pane (after Chat) that
shows everything zmrng is currently running on this machine:

- **Execute-lane occupancy** — used/cap, which tasks hold a slot, and the queued
  tasks in promotion order.
- **Task-worker rows** — title, status, model, effort, style, repo, token usage +
  cost, elapsed time, with **subagents as child rows** (type, running/done,
  description only).
- **Chat-session rows** — repo, model, effort, style, live token usage, labeled
  `chat` instead of a task.
- **Terminal rows** — shell, cwd, uptime. No `claude`-inside-the-PTY detection.

Updates are pushed over the existing `/ws` hub. Styling uses theme tokens only.
The tab is reachable from the phone drawer.

## Grill — what survived

### The lane model in the scope does not match the code

The agreed scope says "plan/clarify and execute lanes". The code has **one** lane
pool, not two. `phases.ts:524-527` declares `executeLanes: Set<string>` +
`executeQueue: string[]`, capped by `config.maxLanes` (`config.ts:686`, default 4).
That single pool is acquired at `phases.ts:804` (plan flow → `planning`, direct flow
→ `executing`), held through `validating`, re-acquired for a security fix round
(`phases.ts:1081`), and released by `freeLane` (`phases.ts:621`). **`clarify` holds
no lane and is uncapped** — `restartAgent` says so explicitly at `phases.ts:1235`
("clarify holds no lane → spawn the fresh session directly").

Inventing a second capped "clarify lane" to match the scope wording would put a
fake cap on the UI. The panel will instead render the truth:

- `Execute lanes — n/cap` with holder rows and the ordered queue.
- `Clarify — n running` as a separate, explicitly **uncapped** group.

This is the one place the implementation deviates from the literal agreed wording,
and it deviates toward what the engine actually does.

### Client-side derivation cannot work (rejected alternative)

The obvious cheap approach is to derive everything in the browser from state the
client already has: `Task[]` (already broadcast), `tasks[].usage`, and the local
`windowTabs.ts` chat/terminal tab state. **Rejected**, for three concrete reasons:

1. **Subagents.** `App.tsx:238` drops every `event` frame whose `taskId` is not the
   selected task. The client only ever has subagent events for one task, so child
   rows for every *other* running worker are simply not derivable.
2. **Chat sessions.** `ChatManager` (`chatAgent.ts`) holds a bare `Set<RunnerLike>`
   with no ids, no metadata and no usage. `ChatServerMsg.result` carries only
   `isError` — token usage from `RunnerCallbacks.onResult` is discarded. Nothing
   reaches the client to derive from.
3. **Terminals.** A PTY survives socket close for a grace window
   (`TerminalManager.detach`), and sessions are server-owned and keyed by id. One
   browser's tab list is not the machine's session list — a reload or a second
   client would show the wrong set.

So the snapshot must be assembled **server-side** from the three managers that
already own this state. That also answers "what model / what effort is it actually
running at" honestly: `Task.model`/`Task.effort` persist as `null` until resolved
(`taskLabels.ts` renders that as `auto`), whereas `TaskManager.spawn` receives the
*resolved* values — so the panel reports what the child was actually spawned with.

### Rejected: process-tree scanning

Explicitly out of scope per the clarify conversation (answer "4a"): terminals are
listed as plain rows, with no attempt to detect a `claude` running inside them.

### Rejected: REST polling

Scope requires push over the existing WebSocket. A `GET /api/lanes` endpoint is
still added, but only for the initial load and as a hermetic test surface —
mirroring how `App.tsx` fetches `/api/tasks` on boot *and* receives the `snapshot`
frame.

### What this breaks / what must be updated

- `packages/web/test/mobileNav.test.ts:16` asserts the exact `MOBILE_VIEWS` id list
  — adding `lanes` breaks it, so that expectation is updated in the same commit.
- `packages/web/test/WorkspaceView.mobile.test.tsx:105` asserts exactly one visible
  tab panel; the new panel must follow the existing `display: none` convention so
  the assertion still holds unchanged.
- `NavIconName` (`components/NavIcon.tsx:11`) is a closed union backed by a
  `Record<NavIconName, ReactNode>` — a new `lanes` icon must be added to both, or
  the web typecheck fails.
- `types.ts` is mirrored by hand. Every new type and the new `WsEvent` variant lands
  in **both** `packages/server/src/types.ts` and `packages/web/src/types.ts`.
- `prompts.test.ts` and `taskManager.test.ts`'s existing assertions are untouched:
  no prompt text changes, and every new manager constructor parameter is **optional
  and trailing**, so existing constructions keep compiling.

### Assumptions that the code does support

- `WsEvent` is a plain discriminated union consumed by a `switch` with no `default`
  (`App.tsx:223`), so a new variant is purely additive on the client.
- `WsHub.broadcast` serializes once per call; a coalescing emitter keeps the new
  frame from being rebuilt on every subagent tool event.
- Subagent events carry **no id**: `onToolUse(name, summary, isSubagent,
  subagentType)` starts one, `onSubagentResult(subagentType, summary, isError)`
  ends one. Matching is therefore FIFO by `subagentType` — with two concurrent
  subagents of the same type, the first result closes the older row. Documented in
  code; acceptable under the agreed "only what events give" constraint.

### Explicitly out of scope

Actions (interrupt/restart/kill) from the panel, `claude` processes outside zmrng,
claude-in-terminal detection, per-subagent tokens, persisting chat/terminal history,
and any DB schema change. The snapshot is in-memory only.

## Approach

One server-assembled `LaneSnapshot`, pushed over `/ws` and rendered by a new pure
web derivation module plus one presentational panel.

**Server.** Each of the three managers that owns live sessions grows a read-only
snapshot accessor and an optional trailing `onChange` callback:

- `TaskManager` — a `workerMeta: Map<taskId, {model, effort, style, startedAt,
  subagents[]}>` written in `spawn()` (reset per spawn, so a phase handoff via
  `replaceChild` naturally clears the previous phase's subagents) and appended to
  from the existing `onToolUse`/`onSubagentResult` callbacks. Worker rows are keyed
  off the existing `this.runners` map, so a dead runner can never render a stale
  row — including after `reconcileOrphans()` marks a boot-time orphan `stale`
  (the fresh `TaskManager` has an empty `runners` map, so it contributes no rows).
  `laneSnapshot()` returns `{ execute: { cap, holders, queued }, workers }`, reading
  `executeLanes`/`executeQueue`/`config.maxLanes` directly.

  Two bounds keep the map from growing without limit: `workerMeta.delete(taskId)`
  runs alongside every `this.runners.delete(taskId)` (`fail`, `onPr`, `onExit`,
  `replaceChild`) and in `deleteTask`, so an entry never outlives its runner; and
  the per-task `subagents` array retains every *running* row plus only a bounded
  tail of completed ones (`MAX_SUBAGENT_ROWS`, oldest completed dropped first), so
  a long execute phase spawning many subagents cannot grow the frame unboundedly.
- `ChatManager` — replaces the bare `Set<RunnerLike>` with a
  `Map<RunnerLike, ChatSessionMeta>` (id from an injectable
  `idFactory: () => string = () => randomUUID()`, copying `TerminalManager`'s
  existing trailing-param default verbatim, plus model/effort/style/repoId/voice/
  startedAt and a `TaskUsage` accumulator). It already wraps `onExit`; it now also
  wraps `onResult(text, isError, usage)` to fold the `ResultUsage` (= `TaskUsage`)
  in before calling through, so the pass-through contract is unchanged.
  `snapshot()` returns the rows.
- `TerminalManager` — records `shell`/`cwd`/`startedAt` on its existing
  `TermSession` and derives `attached` from `cb !== null` (a detached-but-alive PTY
  must not look like an open terminal). `snapshot()` returns the rows.

Assembly lives in the new `lanes.ts` as a **pure** `buildLaneSnapshot(sources, at)`
over the three managers' snapshot accessors — not as a closure inside `index.ts` —
so the exact payload `GET /api/lanes` and the `lanes` frame carry is unit-testable
without booting Fastify. `lanes.ts` also holds `LaneEmitter`, which coalesces bursts
on a trailing timer. `index.ts` keeps only the wiring: it holds the three managers,
registers `GET /api/lanes`, sends a `lanes` frame on `/ws` connect beside `snapshot`,
and passes the emitter in as each manager's `onChange`.

**Web.** A pure `laneRows.ts` joins the snapshot against the `Task[]` and
`RepoTarget[]` the client already holds (same pattern as `dashboardData.ts` — no
duplicated title/status/usage on the wire) and returns display rows plus
`formatElapsed`/`formatTokens`/`repoLabel` helpers. `LanesPanel.tsx` renders them and
ticks a 1s interval **only while the tab is active**, so a hidden panel costs nothing.

### Wire types (added to both `types.ts` files)

```ts
export interface LaneSubagent { id, type, status: 'running'|'done'|'error', description, startedAt }
// `holdsLane` mirrors membership in `LaneOccupancy.holders`; carried on the row
// purely so the panel can group/filter without a per-row lookup into that list.
export interface LaneWorker   { taskId, model, effort, style, startedAt, holdsLane, subagents }
export interface LaneChat     { id, model, effort, style, repoId: string|null, voice, startedAt, usage: TaskUsage }
export interface LaneTerminal { id, shell, cwd, startedAt, attached }
export interface LaneOccupancy{ cap, holders: string[], queued: string[] }
export interface LaneSnapshot { at, execute: LaneOccupancy, workers, chats, terminals }
// WsEvent gains: | { type: 'lanes'; snapshot: LaneSnapshot }
```

## Files

**Server**
| File | Change |
|---|---|
| `packages/server/src/types.ts` | New `Lane*` types + `WsEvent` `'lanes'` variant (source of truth). |
| `packages/server/src/lanes.ts` | **New.** Pure `buildLaneSnapshot(sources, at)` assembler + `LaneEmitter` (coalescing broadcaster, injected `TimerFns`). |
| `packages/server/src/phases.ts` | `workerMeta` map, subagent tracking in the `spawn()` callbacks, `laneSnapshot()`, optional trailing `onLanesChange` ctor param, `patch()`/`spawn()`/`onExit()` notify. |
| `packages/server/src/chatAgent.ts` | `Set` → `Map` of session meta, usage accumulation via a wrapped `onResult`, `snapshot()`, optional `idFactory` + `onChange` ctor params. |
| `packages/server/src/terminal.ts` | Record `shell`/`cwd`/`startedAt` on `TermSession`, `snapshot()`, optional trailing `onChange` ctor param, notify on attach/detach/exit. |
| `packages/server/src/index.ts` | Wiring only: `LaneEmitter` + per-manager `onChange`, `GET /api/lanes`, `lanes` frame on `/ws` connect. |

**Web**
| File | Change |
|---|---|
| `packages/web/src/types.ts` | Manual mirror of every new type + the `WsEvent` variant. |
| `packages/web/src/laneRows.ts` | **New.** Pure derivation + `formatElapsed`/`formatTokens`/`repoLabel`. |
| `packages/web/src/components/LanesPanel.tsx` + `.module.css` | **New.** Presentational panel, theme tokens only. |
| `packages/web/src/components/WorkspaceView.tsx` | `'lanes'` in `PaneTab`/`PANE_TABS`, new `lanes` prop, new tab panel. |
| `packages/web/src/components/NavIcon.tsx` | New `'lanes'` icon name + outline shape. |
| `packages/web/src/mobileNav.ts` | `'lanes'` in `MobileView`/`MobileWorkspaceView`/`MOBILE_VIEWS`. |
| `packages/web/src/App.tsx` | `lanes` state, `case 'lanes'` in `onWs`, boot fetch, prop through to `WorkspaceView`. |
| `packages/web/src/api.ts` | `getLanes()`. |

**Docs** — `.claude/docs/codemap.md`, `.claude/docs/services-reference.md`,
`.claude/rules/frontend-react.md` (component/module list), via the `sync-docs` skill.

## Implementation steps

1. **Types first.** Add the `Lane*` types and the `WsEvent` variant to
   `packages/server/src/types.ts`, then mirror them verbatim into
   `packages/web/src/types.ts`. `npm run typecheck` over both workspaces is the
   drift check.
2. **`TerminalManager.snapshot()`** (RED: `terminal.test.ts` → GREEN).
3. **`ChatManager.snapshot()`** incl. usage accumulation (RED: `chatAgent.test.ts`).
4. **`TaskManager.laneSnapshot()`** incl. subagent child rows, lane holders and the
   queue (RED: `taskManager.test.ts`).
5. **`lanes.ts`** — pure `buildLaneSnapshot()` + `LaneEmitter` with injected timers
   (RED: `lanes.test.ts`).
6. **Wire `index.ts`**: `GET /api/lanes`, a `lanes` frame on `/ws` connect, and the
   emitter as each manager's `onChange`.
7. **`laneRows.ts`** pure derivation + formatters (RED: `laneRows.test.ts`).
8. **`LanesPanel.tsx`** + CSS module, theme tokens only (RED: `LanesPanel.test.tsx`).
9. **Wire the tab**: `WorkspaceView` `PANE_TABS`, `NavIcon`, `mobileNav`, `App`,
   `api`. Update `mobileNav.test.ts`'s id-list expectation.
10. **Validate**: `npm run typecheck && npm run lint && npm test && npm run build`.
11. **Sync docs**, stage the plan, then rebuild the app (`npm run build` +
    `npm run bundle:sidecar`; `npm run desktop:build` is skipped on this host — no
    Rust toolchain).

## Test strategy

**Runner / command:** Vitest in both workspaces. Full gate:
`npm run typecheck && npm run lint && npm test && npm run build`. Single workspace:
`npm test -w @zmrng/server` / `npm test -w @zmrng/web`. No test spawns a real
`claude`, a real shell, or touches the network — the existing `RunnerFactory` /
`PtyFactory` / `TimerFns` injection seams are used throughout.

| Test file | Add / update | What it proves |
|---|---|---|
| `packages/server/test/terminal.test.ts` | update | `snapshot()` lists each live PTY with its `shell`/`cwd`/`startedAt`; `attached` is `true` after `attach` and `false` after `detach`; a session that exits, or one reaped by the grace timer, leaves the snapshot. Driven by the existing `FakePty` + fake `TimerFns`. |
| `packages/server/test/chatAgent.test.ts` | update | `snapshot()` reports one row per live session with its model/effort/style/repoId (and `null` repoId for the Projects-root fallback); `usage` accumulates across two `onResult` callbacks; an exited session and `killAll()` both clear their rows. Driven by the existing `FakeRunner` + injected `idFactory`. |
| `packages/server/test/taskManager.test.ts` | update | `laneSnapshot()` reports `execute.cap` from `config.maxLanes`, `holders` for lane-holding tasks and `queued` in promotion order once the cap is exceeded; a worker row carries the **resolved** model/effort/style actually spawned; a `Task` subagent tool event adds a `running` child row and the matching `subagent_result` flips it to `done`/`error`; a phase handoff (`replaceChild` → fresh `spawn`) resets the subagent list; a finished/failed task has no worker row. |
| `packages/server/test/lanes.test.ts` | **new** | `LaneEmitter` coalesces a burst of `notify()` calls into a single build+send on the trailing timer, sends again after a later burst, and never sends when never notified. Fully synchronous via injected `TimerFns`. |
| `packages/server/test/ws.test.ts` | update | A `lanes` frame round-trips through `WsHub.broadcast`/`send` (guards the new `WsEvent` variant). |
| `packages/server/test/lanes.test.ts` | **new** (same file) | The `buildLaneSnapshot()` assembler — extracted from `index.ts` into `lanes.ts` as a pure function over the three managers' snapshot accessors precisely so `GET /api/lanes`'s payload is testable — returns a well-formed `LaneSnapshot` merging all three sources, and an all-idle instance yields empty groups with a populated `cap`. |
| `packages/web/test/laneRows.test.ts` | **new** | The join: snapshot rows pick up title/status/repo/usage from the `Task[]`; a worker whose task is missing from the map is dropped; `execute` reports `used`/`cap` and the queue **in order**; clarify workers are grouped separately and carry no lane; chat rows resolve a repo label from `RepoTarget[]` and fall back to "Projects root" for `repoId: null`; `formatElapsed` covers seconds/minutes/hours boundaries; `formatTokens` matches the existing `toLocaleString` convention; a `null` snapshot yields empty groups. |
| `packages/web/test/LanesPanel.test.tsx` | **new** | Renders the lane header (`n/cap`), a worker row with its status/model/effort/repo/tokens, its subagent child rows indented beneath it, a chat row labeled `chat` with no task title, a terminal row with shell + cwd, and an empty state when nothing is running. Uses `@testing-library/react` under `happy-dom`, same shape as `SecurityPanel.test.tsx`. |
| `packages/web/test/mobileNav.test.ts` | update | The `MOBILE_VIEWS` id-list expectation gains `lanes`; `workspaceViewFor('lanes')` returns `'lanes'` and `modeForView('lanes')` returns `'workspace'`. |
| `packages/web/test/WorkspaceView.mobile.test.tsx` | update | Existing "exactly one visible panel" assertion still holds with the extra tab, and `mobileView='lanes'` shows the Lanes panel alone. |

Deliberately **not** unit-tested, per the repo's stated policy for socket/DOM glue:
`index.ts`'s wiring and `App.tsx`'s `onWs` case — the logic they carry is in
`LaneEmitter`, the manager snapshots, and `laneRows.ts`, all of which are covered
above. The end-to-end path is confirmed by the manual smoke in
`.claude/rules/testing.md`: `npm run dev`, start a task, open **Lanes**, and watch
the worker, its subagents, an open chat tab and an open terminal tab appear and
clear live.
