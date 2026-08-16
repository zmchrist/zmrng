# Plan: Workspace Terminal Window (global Zed-style bottom-dock PTY)

## Feature description

Add a **global, interactive terminal** to the Workspace page, rendered as a
Zed-style **bottom dock** that spans the full width of the Workspace beneath the
Files / tab-area / task-rail columns. The dock:

- spawns a **real PTY** (login shell) via `node-pty`, rooted at the configured
  Projects directory (`config.projectsDir`, i.e. `ZMRNG_PROJECTS_DIR`), free to
  `cd` beneath it — arrow keys, `ctrl-C`, and full-screen TUIs (so the operator
  can run `claude` / `hermes` themselves) all work;
- streams input/output over a **new, dedicated WebSocket channel**
  (`GET /ws/terminal`), separate from the existing task-event broadcast hub;
- supports **N terminal tabs in one dock** (Zed-style tab strip + `+` new
  terminal), each backed by its own PTY;
- is **global** — available regardless of task selection (it never touches a
  task worktree);
- is **ephemeral** — a fresh shell each load; the PTY is killed on WebSocket
  disconnect / reload / tab close. No persistence or reattach;
- matches Zed's **layout and behavior** (bottom dock, toggle affordance + tab
  strip + `+`) but is styled entirely with our existing frosted-glass theme
  tokens — no Zed colors.
- **Web-only.** No Tauri / sidecar / `.app` work (per the active CLAUDE.md
  web-only override). Desktop bundling of the new native dep is an explicit
  out-of-scope follow-up.

### User story

```
As the zmrng operator
I want a real terminal docked at the bottom of the Workspace, rooted at my Projects dir
So that I can run commands and start claude / hermes sessions without leaving the app
```

- **Feature type:** New Capability
- **Complexity:** High (new native backend dep, new bidirectional WS channel,
  xterm.js frontend integration, CSS layout change, type mirror both sides).
- **Affected workspaces:** `packages/server`, `packages/web`.

---

## Architecture decision & alternatives

**Chosen approach:** one PTY per WebSocket connection, one WebSocket per terminal
tab, over a new `/ws/terminal` route.

- Socket close ⇒ PTY killed ⇒ ephemeral behavior falls out for free (reload
  closes all sockets → all shells die → fresh shells next load). Exactly matches
  the agreed "no persist" scope.
- No session multiplexing / id routing needed — each tab owns exactly one socket
  and one shell.

**Rejected alternatives:**

1. **Reuse the existing `/ws` broadcast hub (`WsHub`).** Rejected: the hub is a
   one-way fan-out with no per-client identity and no inbound-message handling.
   Terminal I/O is bidirectional and per-socket; routing one shell's bytes to
   every connected browser would be wrong and would pollute the task-event
   stream. A separate route keeps both channels clean.
2. **`child_process.spawn('zsh')` without a PTY.** Rejected: no controlling TTY
   means no line editing, arrow keys, `ctrl-C`, or full-screen TUIs; `claude` /
   `hermes` would not run interactively. The operator explicitly asked for a
   real shell, so `node-pty` is required.
3. **Terminal as a new `WorkspaceTabs` tab-kind** (sits in the existing max-2
   pane grid). Rejected: the operator picked option (b), a Zed bottom dock,
   separate from the tab area. A dedicated `TerminalDock` keeps the pane-layout
   reducer (`workspaceLayout.ts`) and its invariants untouched.
4. **Multiplex all terminals over one socket with a session id per frame.**
   Rejected as premature: adds routing/lifecycle complexity for no benefit given
   ephemeral shells and a modest tab count. One-socket-per-tab is simpler and
   makes "close tab kills that shell" trivial.

---

## Context: files to read / patterns to follow

- `packages/server/src/runner.ts` — **the factory-seam pattern to mirror.**
  `RunnerFactory` / `RunnerLike` let tests inject a fake instead of spawning a
  real `claude`. The terminal will follow this exactly with a `PtyFactory` /
  `PtySession` seam so **no test spawns a real shell**. Also the
  `ANTHROPIC_API_KEY` strip (`config.authMode === 'oauth'`) — replicate it for
  the terminal env so a `claude` launched in the terminal uses Max OAuth, never
  the metered API (consistent with the runner and CLAUDE.md's "never export
  `ANTHROPIC_API_KEY` in this shell").
- `packages/server/src/ws.ts` — the existing hub; **left untouched.** New route
  is separate.
- `packages/server/src/index.ts` — REST + `GET /ws` registration + `shutdown()`.
  Terminal route registration and `killAll()` wiring on shutdown go here.
- `packages/server/src/config.ts` — `PROJECTS_DIR` already resolved (line ~46);
  add `projectsDir` and `shell` to the `Config` interface + `buildConfig()`.
- `packages/server/src/types.ts` → **SOURCE OF TRUTH**; every type added here is
  mirrored into `packages/web/src/types.ts` in the same change.
- `packages/web/src/useWs.ts` — the reconnect pattern (terminal uses its own
  short-lived sockets, NOT this hook, but follow the same `ws://`/`wss://`
  origin-derivation).
- `packages/web/src/workspaceLayout.ts` — the **pure-reducer pattern** to mirror
  for the dock state (`terminalDock.ts`).
- `packages/web/src/components/WorkspaceView.tsx` + `.module.css` — where the
  dock mounts; the grid becomes a vertical shell (grid columns on top, dock
  below).
- `packages/web/src/App.tsx` — owns `ui` (`useUiState`) + `patchGlobal`; the
  dock's persisted `open`/`height` live in `GlobalUiState.terminalDock`.
- `packages/server/test/taskManager.test.ts` + `packages/server/test/*` —
  Vitest conventions, the fake-factory injection style, temp-dir hygiene.
- `.claude/rules/frontend-react.md`, `backend-typescript.md`, `testing.md` — the
  design-token / no-`any` / type-mirror / hermetic-test rules this plan obeys.

---

## Dependencies to add

- **`packages/server`**: `node-pty` (runtime dep). Native module; ships prebuilt
  binaries for supported Node ABIs. Engine range is `>=20.11.0 <23` — within
  node-pty's supported matrix. It is spawned under plain Node (`tsx`/`node`), so
  the Node ABI prebuild applies (no Electron rebuild concern).
- **`packages/web`**: `@xterm/xterm` + `@xterm/addon-fit` (runtime deps).

> **Risk (documented):** `node-pty` is native. If the local install can't fetch
> a prebuild it will compile from source (needs a C++ toolchain). If that fails
> in this environment it is a genuine toolchain gap → emit `ZMRNG_BLOCKED:
> toolchain` per the harness rather than working around it. The desktop sidecar
> (`bundle-sidecar.mjs`) would later need to vendor node-pty's native binding
> the way it vendors better-sqlite3 — **explicitly out of scope here** (web-only
> override); note it as a follow-up so the `.app` isn't silently broken.

---

## Type additions (server `types.ts` → mirror into web `types.ts`)

```ts
// ---- terminal (bottom-dock PTY) --------------------------------------------

/** client -> server terminal frames (over GET /ws/terminal). */
export type TermClientMsg =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }

/** server -> client terminal frames. */
export type TermServerMsg =
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null }
```

Extend `GlobalUiState` (both files) with the persisted dock chrome (open +
height only; the ephemeral tab list is NOT persisted, since PTYs are recreated
fresh each load):

```ts
export interface GlobalUiState {
  mode?: WorkspaceMode
  railCollapsed?: boolean
  railCards?: Record<string, boolean>
  splitSizes?: Record<string, number>
  /** Bottom-dock terminal chrome. Only open/height persist — shells are ephemeral. */
  terminalDock?: { open?: boolean; height?: number }
}
```

`config.ts` `Config` interface gains:

```ts
  /** Root dir for the workspace terminal's PTY (== PROJECTS_DIR). */
  projectsDir: string
  /** Login shell for the workspace terminal (SHELL env, else a sane default). */
  shell: string
```

---

## Implementation steps

### 1. Server: config (`config.ts`)
- Add `projectsDir` and `shell` to the `Config` interface and to the object
  returned by `buildConfig()`:
  - `projectsDir: PROJECTS_DIR` — this is an **export of the existing resolved
    module constant** (config.ts line ~46), not a new env resolution.
  - `shell: process.env.SHELL?.trim() || '/bin/sh'` — POSIX-safe default so it
    doesn't break on Linux; `SHELL` is set on any real mac/Linux login so the
    fallback rarely fires. Never hard-coded elsewhere (backend rule).

### 2. Server: types (`types.ts`) + mirror (`web/src/types.ts`)
- Add `TermClientMsg`, `TermServerMsg`, and the `GlobalUiState.terminalDock`
  field to **both** files, identically.

### 3. Server: terminal module (`packages/server/src/terminal.ts`) — NEW
- Define the test seam mirroring `runner.ts`:
  ```ts
  export interface PtySession {
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(): void
  }
  export interface PtyCallbacks {
    onData(data: string): void
    onExit(code: number | null): void
  }
  export interface PtySpawnOptions { cwd: string; shell: string; env: NodeJS.ProcessEnv }
  export type PtyFactory = (opts: PtySpawnOptions, cb: PtyCallbacks) => PtySession
  ```
- `defaultPtyFactory`: wraps `node-pty`'s `spawn(shell, [], { cwd, env, name:
  'xterm-color', cols, rows })`, forwarding `onData` and `onExit`; `write` →
  `pty.write`, `resize` → `pty.resize`, `kill` → `pty.kill`.
- Pure, exported `parseClientMsg(raw: string): TermClientMsg | undefined` —
  tolerant JSON parse + shape guard (unknown/missing-field frames → `undefined`,
  never throw). This is the unit-tested control-parsing surface.
- `TerminalManager` class (constructor takes an optional `PtyFactory`, default
  `defaultPtyFactory` — same seam shape as `TaskManager`'s `runnerFactory`):
  - `create(cb: PtyCallbacks): PtySession` — build env by copying `process.env`
    (so the shell inherits `PATH`/`HOME`/`USER`/`TERM`, and sources the user's
    `.zshrc`/`.bashrc` as a normal interactive shell would) and deleting
    `ANTHROPIC_API_KEY` when `config.authMode === 'oauth'`; spawn at
    `config.projectsDir` with `config.shell` (`name: 'xterm-color'`, initial
    cols/rows); track the session in a `Set`; remove it from the set on exit.
  - `killAll(): void` — kill and clear every tracked session (for shutdown).

### 4. Server: WS route + shutdown wiring (`index.ts`)
- Construct `const terminals = new TerminalManager()` next to the other
  singletons.
- Register `app.get('/ws/terminal', { websocket: true }, (socket) => { ... })`:
  - `const session = terminals.create({ onData, onExit })` where
    `onData(data)` → `socket.send(JSON.stringify({ type: 'data', data }))` and
    `onExit(code)` → send `{ type: 'exit', code }` then `socket.close()`.
  - `socket.on('message', ...)` — wrap the body in try/catch:
    `try { const msg = parseClientMsg(String(raw)); if (msg?.type === 'input')
    session.write(msg.data); else if (msg?.type === 'resize')
    session.resize(msg.cols, msg.rows) } catch (err) { app.log.error({ err },
    'terminal message handler failed'); socket.close() }`. No `console.log` —
    Pino only.
  - `socket.on('close', () => session.kill())` and same on `'error'`.
  - Wrap the whole `terminals.create(...)` spawn in try/catch → on failure
    `app.log.error({ err }, 'terminal spawn failed')` + close the socket
    (graceful degradation: a failed PTY never crashes the server).
- In `shutdown()`, call `terminals.killAll()` alongside `manager.shutdown()`.

### 5. Web: terminal protocol helper (`packages/web/src/terminalProtocol.ts`) — NEW
- Pure functions used by the component (kept out of the component so they're
  unit-testable without a DOM):
  - `encodeInput(data: string): string` → `JSON.stringify({ type:'input', data })`
  - `encodeResize(cols: number, rows: number): string`
  - `parseServerMsg(raw: string): TermServerMsg | undefined` (tolerant guard).

### 6. Web: dock-state reducer (`packages/web/src/terminalDock.ts`) — NEW
- Pure reducer mirroring `workspaceLayout.ts` (no React), managing the dock's
  **ephemeral** in-memory state: `{ tabs: { id: string }[]; activeId: string |
  null }` plus a monotonic id source passed in (avoid `Math.random`/`Date.now`
  in a pure module — accept a `nextId` seed, same idea as an index):
  - `emptyDock()`, `addTerminal(state, id)`, `closeTerminal(state, id)` (focus
    falls to neighbor; empty ⇒ `activeId = null`), `setActive(state, id)`.
- The persisted `open`/`height` are NOT in this reducer — they live in
  `GlobalUiState.terminalDock` and are threaded from `App.tsx`.

### 7. Web: xterm terminal pane (`packages/web/src/components/Terminal.tsx`) — NEW
- Props: `{ id: string }` (one PTY/socket per mounted instance).
- On mount (in an effect): create `new Terminal(...)` + `FitAddon`, `open()`
  into a ref div, open a `WebSocket` to
  `${wsProto}://${location.host}/ws/terminal`; wire:
  - `term.onData(d => ws.send(encodeInput(d)))`
  - `ws.onmessage` → `parseServerMsg` → `term.write(data)` / on `exit` show a
    dim "process exited" line and stop.
  - a `ResizeObserver` on the container → `fit()` then
    `ws.send(encodeResize(cols, rows))` (also once on open).
- On unmount: `ws.close()` (server kills the PTY) + `term.dispose()` + store the
  `ResizeObserver` in a ref and call `observer.disconnect()` in the effect
  cleanup. Style the xterm theme object from our tokens
  (background `transparent`/`--well`, foreground `--text`, cursor `--accent`) —
  no hard-coded hex; read via `getComputedStyle` on `:root` or pass token-driven
  values (via `getComputedStyle(document.documentElement).getPropertyValue('--text').trim()`
  with a safe fallback if a token reads empty). Mono font `--font-mono`.
- Kept intentionally thin: all testable logic is in `terminalProtocol.ts` /
  `terminalDock.ts`; this component is the DOM/canvas glue (covered by manual
  smoke — jsdom has no canvas).

### 8. Web: the dock (`packages/web/src/components/TerminalDock.tsx` + `.module.css`) — NEW
- Props: `{ open: boolean; height: number; onOpenChange; onHeightChange }`
  (persisted chrome threaded from `App.tsx`); owns the ephemeral tab reducer
  state internally with `useState`/`useReducer` over `terminalDock.ts`.
- Renders:
  - a slim always-visible **dock handle / status bar** at the very bottom
    (terminal glyph + "Terminal" label) that toggles `open`; keyboard shortcut
    `ctrl+\`` toggles too (Zed parity). **Intercept it in the browser** — a
    `keydown` listener that matches `ctrl+\`` calls `e.preventDefault()` and
    toggles the dock. When a terminal is focused, use xterm's
    `attachCustomKeyEventHandler` to swallow the same chord so it never reaches
    the PTY (avoids sending `ctrl-\` / SIGQUIT to the foreground process). The
    toggle button is the primary affordance; the shortcut is a convenience — if
    the swallow proves unreliable in manual smoke, drop the shortcut rather than
    ship a chord that kills the foreground process.
  - when open: a **tab strip** (one button per terminal, active highlighted, ×
    to close), a `+` **new-terminal** button, and the body showing the mounted
    `<Terminal>` instances with only the active one visible (inactive kept
    mounted via `hidden`/`display:none` so their shells stay alive while
    switching tabs). **Terminals mount only while the dock is `open`** — when
    `open === false` no `<Terminal>` is rendered, so no WebSocket/PTY exists
    (closing the dock kills every shell; a load with the dock closed spawns
    nothing).
  - Opening the dock with zero tabs auto-creates the first terminal.
- All colors/blur/radius via `var(--*)`; drag-to-resize the dock height updates
  `height` (persisted). Height clamped to a sane min/max.

### 9. Web: mount in Workspace (`WorkspaceView.tsx` + `.module.css`)
- Wrap the existing three-column grid and the new dock in a vertical flex shell
  so the dock spans the full Workspace width **below** the columns. The dock
  renders **regardless of `task`** (global) — it must not be gated by the
  "Select a task" empty states.
- Thread `terminalDock` open/height from props (WorkspaceView already receives
  `config`/rail props; add `dockOpen`, `dockHeight`, `onDockOpenChange`,
  `onDockHeightChange`) — or read/patch via a new `terminalDock`-focused pair of
  props from `App.tsx`. Keep it consistent with how `railCollapsed` is threaded.

### 10. Web: wire persistence (`App.tsx`)
- Derive `dockOpen = ui.state.global.terminalDock?.open ?? false` and
  `dockHeight = ui.state.global.terminalDock?.height ?? 300`. **Defaults live
  here (nullish-coalescing), not in the type** — the type keeps both the field
  and its properties optional (`terminalDock?: { open?: boolean; height?:
  number }`) so older persisted docs stay compatible. Dock defaults closed.
- `setDockOpen` / `setDockHeight` → `ui.patchGlobal({ terminalDock: { ...prev,
  open|height } })` (merge, mirroring `setRailCollapsed`). Pass down to
  `WorkspaceView`.

### 11. Docs sync (execute phase, before commit)
- Run the `sync-docs` skill; update `CLAUDE.md` (project structure: new
  `terminal.ts`, `TerminalDock`/`Terminal`, `/ws/terminal`, `terminalDock.ts`,
  `terminalProtocol.ts`), `.claude/rules/frontend-react.md` +
  `backend-typescript.md` component/service lists, and
  `.claude/docs/services-reference.md` (new TerminalManager surface + WS route).
  Stage this plan file too (PR checklist links it).

---

## Test strategy

**Runner / command:** Vitest in both workspaces — `npm test` (runs
`vitest run` in `@zmrng/server` and `@zmrng/web`). Full validation gate:
`npm run typecheck && npm run lint && npm test && npm run build`.

**Hard rule honored:** no test spawns a real shell / PTY, touches the network,
or depends on secrets. The `PtyFactory` seam (server) and mocked
`WebSocket`/`@xterm/xterm` (web) keep everything hermetic — exactly the
runner-factory pattern already proven in `taskManager.test.ts`.

Tests added (land in the same commit as the code):

1. **`packages/server/test/terminal.test.ts`** (NEW) — drives `TerminalManager`
   with an **injected fake `PtyFactory`** (no real shell). `create()` reads
   `config.projectsDir` / `config.shell` / `config.authMode` from the module
   singleton, so the test **overrides those fields in `beforeEach` and restores
   them in `afterEach`** — the exact save/restore-the-singleton pattern
   `taskManager.test.ts` uses for `config.repos` (lines ~93–97). Proves:
   - `create()` spawns at `config.projectsDir` with `config.shell` and an env
     that has `ANTHROPIC_API_KEY` **stripped** when `authMode === 'oauth'`
     (and preserved under `apikey`).
   - an `input` frame → `session.write` with the exact data; a `resize` frame →
     `session.resize(cols, rows)`.
   - PTY `onData` is forwarded verbatim to the `onData` callback; PTY `onExit`
     fires the `onExit` callback.
   - `killAll()` kills every tracked session and a session removes itself from
     the tracked set on exit.
   - **`parseClientMsg` near-miss cases**: malformed JSON, unknown `type`,
     missing/ill-typed fields (e.g. `resize` without numeric `cols`) all return
     `undefined` and never throw (control-parsing rule).

2. **`packages/web/test/terminalProtocol.test.ts`** (NEW) — pure protocol:
   `encodeInput`/`encodeResize` produce the exact frames the server parses;
   `parseServerMsg` accepts `data`/`exit` frames and rejects malformed /
   unknown-type / wrong-field input (returns `undefined`).

3. **`packages/web/test/terminalDock.test.ts`** (NEW) — pure dock reducer:
   `addTerminal` appends + focuses; `closeTerminal` removes and moves focus to a
   neighbor (and to `null` when empty); `setActive` switches; ids are stable /
   never collide via the seeded id source. No DOM.

4. **`packages/server/test/config.test.ts`** (UPDATE, if a resolver test exists
   there) — assert `projectsDir` and `shell` are populated on the resolved
   config (shell falls back to the default when `SHELL` is unset). If the
   existing config test only exercises `resolveRegistry` in isolation, add a
   minimal focused case rather than forcing the singleton; otherwise this is
   covered by typecheck + the terminal test reading `config`.

**Not unit-tested (documented):** `Terminal.tsx`'s xterm/canvas rendering and
the live `/ws/terminal` socket round-trip — jsdom has no canvas and we spawn no
real PTY. These are covered by the **manual smoke** below. (The type-mirror
check — server↔web `types.ts` — is enforced by `npm run typecheck` across both
workspaces.)

**Manual smoke (execute phase):**
```
npm run dev
# open Workspace → toggle the bottom dock (button + ctrl-`)
# type `ls`, `pwd` (cwd == Projects dir), arrow-key history, ctrl-C a `sleep 5`
# run `claude` / a TUI to confirm full-screen redraw + resize on drag
# open a 2nd terminal tab, switch between them (both shells stay alive)
# close a tab → its shell dies; reload the page → all shells fresh (no reattach)
```

---

## Validation commands

```bash
npm run typecheck   # both workspaces — also catches server↔web type-mirror drift
npm run lint        # ESLint both workspaces (no-any, react-hooks rules)
npm test            # Vitest both workspaces (the 3–4 test files above)
npm run build       # tsc (server) + vite build (web)
```

---

## Acceptance criteria

- [ ] A bottom dock appears in the Workspace, full-width beneath the columns,
      toggled by a visible affordance and `ctrl+\``; visible regardless of task
      selection.
- [ ] Opening the dock spawns a real interactive shell rooted at the Projects
      dir; commands, arrow keys, `ctrl-C`, and TUIs (incl. `claude`/`hermes`)
      work; the terminal resizes with the dock.
- [ ] Multiple terminal tabs coexist in one dock (`+` to add, × to close, tab to
      switch); closing a tab kills only that shell.
- [ ] Shells are ephemeral: reload / disconnect kills every PTY and the next
      load starts fresh (no reattach, no scrollback restore).
- [ ] Dock `open`/`height` persist across reload via `GlobalUiState.terminalDock`.
- [ ] All styling uses theme tokens (no raw hex/blur/radius); no Zed colors.
- [ ] `ANTHROPIC_API_KEY` is stripped from the terminal env under `oauth` mode.
- [ ] Server↔web types mirrored; `npm run typecheck && npm run lint && npm test
      && npm run build` all green.
- [ ] No Tauri/sidecar/`.app` changes; node-pty desktop vendoring noted as a
      follow-up.
```
