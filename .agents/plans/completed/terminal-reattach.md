# Plan — Persistent, reattachable terminal sessions

## Problem

The Workspace Terminal card's PTY is tied 1:1 to its WebSocket. When the machine
locks (or the network otherwise suspends), the browser's `/ws/terminal` socket
drops, the server's `socket.on('close', () => session.kill())` handler fires, and
the shell process is killed. The `Terminal.tsx` effect never reconnects, so any
in-flight work — a running build, a half-typed command, an interactive TUI — is
lost, and a page reload spawns a brand-new shell at `config.projectsDir`.

Root cause (verified):
- `packages/server/src/index.ts:637` — `socket.on('close', () => session.kill())`.
- `packages/server/src/terminal.ts:97` — `TerminalManager` tracks PTYs in a bare
  `Set<PtySession>` with no id, no output history, and no lifecycle beyond
  create/killAll.
- `packages/web/src/components/Terminal.tsx` — the effect opens one socket on
  mount and never reconnects on close; it only tears down on unmount.

## Goal

Make a terminal session outlive a transient socket drop. A lock → unlock, a Wi-Fi
blip, or a page reload should **reattach** to the same live shell and redraw its
recent output, within a bounded grace window. This is a POC-grade, tmux-lite
server-side session model — not full scrollback persistence across server
restarts.

## Non-goals

- Persisting PTY sessions across a **server** restart (sessions stay in memory).
- Persisting full unbounded scrollback — replay is a bounded ring buffer.
- Perfect TUI reconstruction — raw byte replay is "good enough"; a full-screen app
  (vim) redraws on its next paint. Documented as a known limitation.
- Any change to the ephemeral `/ws/chat` sessions — this is terminal-only.

## Chosen approach — server-owned session keyed by id, socket is a detachable view

The PTY becomes a long-lived server object identified by a `sessionId`. A socket
*attaches* to a session rather than *owning* it:

1. **`TerminalManager` keeps `Map<sessionId, TermSession>`** instead of a `Set`.
   Each `TermSession` holds the `PtySession`, a bounded output **ring buffer**,
   the currently-attached socket callbacks (or `null` when detached), and a grace
   timer handle.
2. **Attach frame.** The client's first frame is `{ type: 'attach', sessionId? }`.
   - Known + detached session → reattach: cancel the grace timer, swap in the new
     socket callbacks, and **replay the ring buffer** so xterm redraws.
   - Known + still-attached session → takeover: detach the old socket (close it),
     attach the new one, replay.
   - Unknown / expired / omitted → spawn a fresh PTY with a new `sessionId`.
   - The server always answers with `{ type: 'session', sessionId }` so the client
     can persist the id.
3. **Socket close no longer kills.** It calls `terminals.detach(sessionId)`, which
   starts a **grace timer** (`ZMRNG_TERMINAL_GRACE_MS`, default 10 min). If the
   timer fires with no reattach, the PTY is killed and the map entry removed. A
   reattach before then cancels it.
4. **Client reconnects.** `Terminal.tsx` gains a reconnect loop (backoff, mirroring
   `useWs`): on `ws.onclose` while still mounted, it reopens `/ws/terminal` and
   re-sends the `attach` frame with the stored `sessionId`.
5. **Persist the id.** The `sessionId` is stored per-tab so it survives both a
   transient drop and a full page reload (within the grace window): in
   `localStorage` keyed by tab id for the reconnect path, and round-tripped through
   `TerminalTabMeta.sessionId` in `GlobalUiState.terminalTabs` for the reload path.

### Alternative rejected — tmux/screen wrapper per shell

Spawn every terminal inside a real `tmux` session and reattach with
`tmux attach`. Rejected: adds a hard `tmux` runtime dependency on every operator
machine (and the Tauri sidecar), pushes session naming/GC into shell scripting,
and leaks tmux keybindings into the xterm surface. The in-process model keeps the
dependency surface at zero and the lifecycle in TypeScript where it is testable.

### Alternative rejected — persist PTY output to SQLite

Write shell output to the DB for durable replay across server restarts. Rejected
as far out of scope: high write volume, unbounded growth, and the PTY process
itself still dies on server restart, so durable *output* without a durable
*process* buys little for the lock/unlock case that motivates this.

## Changes by file

### Types (both mirrors — `packages/server/src/types.ts` + `packages/web/src/types.ts`)
- `TermClientMsg` gains `{ type: 'attach'; sessionId?: string; cols: number; rows: number }`
  (cols/rows fold the initial resize into the attach so a fresh PTY spawns at the
  right geometry).
- `TermServerMsg` gains `{ type: 'session'; sessionId: string }`.
- `TerminalTabMeta` gains an optional `sessionId?: string`.
- **Mirror parity is enforced by `npm run typecheck` over both workspaces.**

### `packages/server/src/terminal.ts`
- Introduce `interface TermSession { pty: PtySession; buffer: RingBuffer; cb: PtyCallbacks | null; graceTimer: Timer | null }`.
- Replace the `Set` with `Map<string, TermSession>`.
- New `attach(sessionId: string | undefined, cb: PtyCallbacks): { sessionId: string; replay: string }`:
  resolve-or-create, cancel grace timer, swap `cb`, return the id + the buffered
  bytes to replay. New sessions generate an id via an injectable id factory
  (default `crypto.randomUUID()`) to keep the module deterministic under test.
- New `detach(sessionId: string)`: null the `cb`, start the grace timer.
- `onData` from the PTY appends to the ring buffer **and** forwards to `cb` when
  attached (dropped when detached — the buffer is the record).
- Ring buffer caps total retained bytes at `ZMRNG_TERMINAL_BUFFER_BYTES`
  (default 256 KiB), discarding oldest first.
- Grace timer + `setTimeout`/`clearTimeout` injected via constructor (default the
  real globals), mirroring the existing `PtyFactory` seam, so tests drive
  expiry synchronously.
- `killAll()` still tears down every session and clears timers.

### `packages/server/src/config.ts`
- Parse `ZMRNG_TERMINAL_GRACE_MS` (default 600000) and
  `ZMRNG_TERMINAL_BUFFER_BYTES` (default 262144). Never inline the constants.

### `packages/server/src/index.ts` (`/ws/terminal` route)
- On socket open, wait for the first `attach` frame (parsed by `parseClientMsg`)
  rather than eagerly spawning. Call `terminals.attach(...)`, send back
  `{ type: 'session', sessionId }`, then emit the `replay` string as a `data`
  frame.
- `input`/`resize` unchanged.
- `socket.on('close')` / `on('error')` → `terminals.detach(sessionId)` (**not**
  `kill`).

### `packages/web/src/terminalProtocol.ts`
- `encodeAttach(sessionId: string | undefined, cols, rows)`.
- `parseServerMsg` gains the `session` frame.

### `packages/web/src/windowTabs.ts`
- `setTerminalTabSession(state, id, sessionId)` — record the server-assigned id on
  the tab meta (same shape as `setChatTabConfig`).

### `packages/web/src/components/Terminal.tsx`
- Accept an optional `sessionId` + an `onSession(id)` callback prop.
- Read the persisted id (prop → `localStorage['zmrng-term-' + id]`), send it in the
  `attach` frame on every (re)connect.
- On the `session` frame, store the id (localStorage + `onSession` so the parent
  persists it into `terminalTabs`).
- Add a reconnect loop: on `ws.onclose` while mounted, reopen with backoff and
  re-attach. Clean up on unmount.

### `packages/web/src/components/TerminalCard.tsx`
- Thread `sessionId` down from each `TerminalTabState` and wire `onSession` to
  `setTerminalTabSession(...)` → `onTabsChange`.

## Test strategy

Command: `npm test` (Vitest, both workspaces). No test spawns a real shell — the
`PtyFactory` seam supplies a fake PTY, and timers are injected.

New / updated test files:
- `packages/server/test/terminal.test.ts` (extend existing):
  - **attach-new** — `attach(undefined, cb)` spawns via the fake factory and
    returns a fresh id + empty replay.
  - **reattach replays buffer** — feed fake PTY output, `detach`, then
    `attach(sameId, cb2)` returns the buffered bytes and routes subsequent output
    to `cb2`.
  - **grace expiry kills** — `detach`, advance the injected clock past
    `ZMRNG_TERMINAL_GRACE_MS`, assert the fake PTY was killed and the id is gone.
  - **reattach cancels grace** — `detach`, `attach` before expiry, advance clock,
    assert the PTY is still alive.
  - **ring buffer cap** — push more than the byte cap, assert replay is truncated
    to the newest ≤ cap bytes.
  - **takeover** — `attach` an already-attached id, assert the old `cb` stops
    receiving and the new one replays.
  - `parseClientMsg` accepts a well-formed `attach` frame and rejects a malformed
    one (missing/ill-typed `sessionId`/`cols`/`rows`).
- `packages/web/test/terminalProtocol.test.ts` (extend): `encodeAttach` shape
  (with and without a stored id) and `parseServerMsg` decoding the `session` frame
  / rejecting a malformed one.
- `packages/web/test/windowTabs.test.ts` (extend): `setTerminalTabSession` sets the
  id on the right tab and is a no-op for an absent id.

`Terminal.tsx` and the route wiring stay uncovered by unit tests (DOM/canvas +
live socket glue, same policy as today) — exercised by the manual smoke below.

## Manual smoke

1. `npm run dev`, open a Terminal card, start a long-running command
   (`sleep 300; echo done`).
2. Lock the machine (or kill Wi-Fi ~15 s), unlock. The card reconnects and the
   running command's output resumes; `echo done` still fires.
3. Reload the page within the grace window — the same session reattaches and
   replays recent output.
4. Leave a terminal detached past `ZMRNG_TERMINAL_GRACE_MS` → the shell is reaped;
   a later attach starts fresh.

## Validation

`npm run typecheck && npm run lint && npm test && npm run build`, all green.
This is backend + non-visual frontend plumbing (no new styled surface), so no PR
screenshot is required; note that under Testing in the PR body.

## Risk / rollback

- Purely additive frames + an additive `TerminalTabMeta.sessionId`; older persisted
  docs (no `sessionId`) simply attach fresh. No migration, no destructive change.
- If the reattach path misbehaves, reverting the route + `Terminal.tsx` to the
  kill-on-close behavior restores today's ephemeral model without touching the DB.
