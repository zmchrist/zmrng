# Plan — Standalone Chat Window (bottom-dock agent chat)

## Goal

Add a standalone **Chat** feature to zmrng: a bottom-nav toggle (alongside
Terminal/Tasks/Workspace/Settings) that opens chat tabs living in the **same
bottom dock** as the terminal tabs. Each chat tab holds a live conversation with
a real `claude` agent (Max OAuth), spawned per socket over a new `/ws/chat`
WebSocket endpoint. Chat tabs are **ephemeral** (session-only, gone on close —
mirroring the terminal-tab lifecycle; no DB persistence). The agent defaults to
**sonnet / medium effort / caveman-full**, all three independently user-configurable
per chat tab. It gets filesystem access scoped to the configured **Projects
directory**. The UI is a classic messaging-thread bubble layout (user vs. agent
bubbles) themed with the frosted-glass tokens, with lightweight tool-use
visibility and an interrupt (stop-generating) control.

This feature is independent of the task lifecycle. It is **not** the existing U4
"agent chat" (`/api/tasks/:id/chat`, `ChatMessage`, `config.agents`, `chat.ts`),
which is an external-HTTP-agent proxy tied to a task. To avoid collision we use
distinct names: server module `chatAgent.ts`, wire types `ChatClientMsg` /
`ChatServerMsg`, and web modules `chatProtocol.ts` / `chatThread.ts`.

## Approach

The whole feature is a near-clone of the existing bottom-dock terminal stack,
swapping the PTY for the `claude` `Runner`:

| Terminal stack (existing)              | Chat stack (new)                         |
|----------------------------------------|------------------------------------------|
| `terminal.ts` `TerminalManager` (PTY)  | `chatAgent.ts` `ChatManager` (Runner)    |
| `GET /ws/terminal`                     | `GET /ws/chat`                           |
| `TermClientMsg` / `TermServerMsg`      | `ChatClientMsg` / `ChatServerMsg`        |
| `terminalProtocol.ts` (pure wire)      | `chatProtocol.ts` (pure wire)            |
| `terminalDock.ts` reducer (tab list)   | same reducer, tabs gain a `kind`         |
| `Terminal.tsx` (xterm glue)            | `ChatPane.tsx` (bubble thread + WS glue) |

Key reuse: the server already has a battle-tested `Runner` (`runner.ts`) that
spawns `claude` with stream-json, strips `ANTHROPIC_API_KEY` under OAuth, and
exposes `send()` / `interrupt()` / `kill()` plus callbacks for
session/partial/assistant/tool/result/exit. `ChatManager` wraps that `Runner`
through the same `RunnerFactory` seam `TaskManager` uses, so tests inject a fake
and never spawn a real `claude`.

### Backend

**`packages/server/src/chatAgent.ts` (new)**
- `chatSystemPrompt(style: CaveStyle, projectsDir: string): string` — a
  **conversational** system prompt (NOT the zmrng-worker prompt). It frames the
  agent as an assistant embedded in the zmrng chat panel with read/explore
  filesystem access to `projectsDir`, explicitly states there is **no** task /
  branch / PR / control-token protocol, asks it to keep tool use purposeful
  (surface meaningful actions, not every internal step), and appends the shared
  caveman `styleDirective(style)`.
- `parseChatClientMsg(raw: string): ChatClientMsg | undefined` — tolerant JSON
  guard (mirrors `parseClientMsg`): malformed JSON / unknown `type` / ill-typed
  fields → `undefined`, never throws. Accepts `start` (with `model`/`effort`/
  `style`), `input` (with `text`), `interrupt`.
- `class ChatManager` — owns the set of live chat `Runner`s. Constructor takes an
  optional `RunnerFactory` (defaults to `defaultRunnerFactory`) — the test seam.
  `create(cfg, cb)` builds `SpawnOptions` `{ cwd: config.projectsDir, model,
  effort, systemPrompt: chatSystemPrompt(style, config.projectsDir) }`, spawns via
  the factory, tracks it in a `Set`, self-removes on exit, and returns the
  `RunnerLike`. `killAll()` tears every session down on shutdown. (The env-strip
  for OAuth already lives inside `Runner`'s constructor, so `ChatManager` does not
  repeat it — unlike `TerminalManager`, whose factory receives a pre-built env.)

**`packages/server/src/phases.ts` (edit)** — export the existing `styleDirective`
helper (currently module-private) so `chatAgent.ts` reuses the exact caveman
directive rather than duplicating it. No behavior change; `prompts.test.ts` still
pins its content.

**`packages/server/src/index.ts` (edit)**
- Instantiate `const chats = new ChatManager()` next to `terminals`.
- Add `GET /ws/chat` (`websocket: true`), modeled on `/ws/terminal`: one socket
  owns at most one chat `Runner`. On a `start` frame it kills any prior session
  and spawns a fresh one; `input` → `session.send(text)`; `interrupt` →
  `session.interrupt()`. Runner callbacks map to server→client frames:
  `onSession→ready`, `onPartial→partial`, `onAssistantText→assistant`,
  `onToolUse→tool` (carrying `name`/`summary`/`actor`, where `actor` = `'main'`
  or the `subagentType`), `onResult→result` (`isError` only — usage ignored),
  `onExit→exit` + `socket.close()`, `onSpawnError→error` + close. Socket
  `close`/`error` → `session.kill()`. `onSubagentResult` is intentionally **not**
  forwarded (keeps the thread quiet, per "only big decisions and tools").
- `shutdown()` also calls `chats.killAll()`.

**`packages/server/src/types.ts` (edit, source of truth)** — add:
```ts
export type ChatClientMsg =
  | { type: 'start'; model: string; effort: EffortLevel; style: CaveStyle }
  | { type: 'input'; text: string }
  | { type: 'interrupt' }

export type ChatServerMsg =
  | { type: 'ready'; sessionId: string }
  | { type: 'partial'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool'; name: string; summary: string; actor: string; isSubagent: boolean }
  | { type: 'result'; isError: boolean }
  | { type: 'exit'; code: number | null }
  | { type: 'error'; text: string }
```

### Frontend

**`packages/web/src/types.ts` (edit)** — mirror `ChatClientMsg` / `ChatServerMsg`
verbatim (manual type mirror; `npm run typecheck` over both workspaces catches
drift).

**`packages/web/src/chatProtocol.ts` (new)** — pure wire helpers (no DOM):
`encodeStart(model, effort, style)`, `encodeInput(text)`, `encodeInterrupt()`
(each producing a frame `parseChatClientMsg` accepts), and
`parseChatServerMsg(raw): ChatServerMsg | undefined` (tolerant guard over all
seven server frames).

**`packages/web/src/chatThread.ts` (new)** — pure, React-free reducer for the
bubble-thread state, so the message logic is unit-testable without a DOM (the
`ChatPane` component itself, like `Terminal`, stays untested — jsdom has no WS/
canvas glue worth exercising). State: an ordered list of thread items
(`{ kind: 'user'; text }` | `{ kind: 'agent'; text; streaming: boolean }` |
`{ kind: 'tool'; name; summary; actor }`) plus a `busy` flag. Pure functions:
`emptyThread()`, `pushUser(state, text)`, `pushToolNote(state, {name,summary,actor})`,
`appendPartial(state, delta)` (opens a streaming agent bubble if none is open,
else appends), `finalizeAssistant(state, text)` (replaces/closes the streaming
bubble with final text), `endTurn(state)` (clears `busy`, closes any open
streaming bubble), `resetThread()` (config change → fresh session divider).
Caller supplies ids where needed; module stays deterministic and pure.

**`packages/web/src/terminalDock.ts` (edit)** — generalize the ephemeral tab
reducer to carry a `kind`:
- `DockTab` gains `kind: 'terminal' | 'chat'`.
- Add `addTab(state, id, kind)`; keep `addTerminal(state, id)` as
  `addTab(state, id, 'terminal')` (back-compat for callers/tests) and add
  `addChat(state, id)` = `addTab(state, id, 'chat')`.
- `closeTerminal` / `setActive` are kind-agnostic already; keep as-is (they key on
  `id`). Terminal and chat tabs coexist in one ordered list, one `activeId`.
(Filename kept as `terminalDock.ts` to avoid a rename ripple through CLAUDE.md/
rules; its doc comment is broadened to "bottom-dock tabs".)

**`packages/web/src/components/ChatPane.tsx` (new)** — the bubble UI + WS glue,
one `WebSocket` to `/ws/chat` per instance (mirroring `Terminal.tsx`, NOT via the
`useWs` hub). Owns: a `chatThread` state, a config row (`model` / `effort` /
`style` selects, defaulting sonnet / medium / caveman-full), a scrollable thread
of bubbles, a composer (textarea + send), and a Stop button shown while `busy`.
On mount it opens the socket and sends `encodeStart(config)`. On submit it
`pushUser` + sends `encodeInput`, sets `busy`. Incoming frames drive the reducer:
`partial→appendPartial`, `assistant→finalizeAssistant`, `tool→pushToolNote`,
`result→endTurn`, `ready`/`exit`/`error` handled for status. Stop → `encodeInterrupt`.
Changing a config select while **not** busy closes and reopens the socket with a
fresh `start` (respawns the `claude` session; inserts a "new session" divider via
`resetThread`) — this is how "user-configurable per chat" is honored without a
persisted transcript. Tool rows are colored with `actorColor(actor)` (the one
sanctioned dynamic inline-style precedent). Bubbles use `*.module.css` tokens.

**`packages/web/src/components/ChatPane.module.css` (new)** — bubble styling from
existing frosted-glass tokens only (no new theme tokens, no hard-coded values):
user bubble accent-tinted + right-aligned, agent bubble `--surface-strong` +
left-aligned, tool note a slim centered row, composer + config row from
`--surface`/`--border`.

**`packages/web/src/components/TerminalDock.tsx` (edit)** — the dock body already
maps `dock.tabs`; branch on `t.kind` to render `<Terminal>` or `<ChatPane>`.
Tab labels become per-kind ("Terminal N" / "Chat N", counting prior tabs of the
same kind). Add a **Chat** nav button between Terminal and Tasks: it opens the
dock (if closed) and appends a chat tab via `addChat`, focusing it; `aria-pressed`
reflects "dock open and the active tab is a chat". Keep the existing `+` in the
tab strip as "new terminal"; add a small `+chat` affordance (or a second add
button) for a new chat tab. The Terminal nav button keeps its meaning (toggle the
whole dock body). No new props flow through `App`/`WorkspaceView` — chat tab state
is entirely local/ephemeral inside `TerminalDock`, exactly like terminal tabs.

## Files changed (expected)

New:
- `packages/server/src/chatAgent.ts`
- `packages/server/test/chatAgent.test.ts`
- `packages/web/src/chatProtocol.ts`
- `packages/web/src/chatThread.ts`
- `packages/web/src/components/ChatPane.tsx`
- `packages/web/src/components/ChatPane.module.css`
- `packages/web/test/chatProtocol.test.ts`
- `packages/web/test/chatThread.test.ts`

Edited:
- `packages/server/src/index.ts` (ChatManager + `/ws/chat` + shutdown)
- `packages/server/src/phases.ts` (export `styleDirective`)
- `packages/server/src/types.ts` (add `ChatClientMsg`/`ChatServerMsg`)
- `packages/web/src/types.ts` (mirror the two chat wire types)
- `packages/web/src/terminalDock.ts` (add `kind` + `addTab`/`addChat`)
- `packages/web/src/components/TerminalDock.tsx` (Chat nav button + render + labels)
- `packages/web/test/terminalDock.test.ts` (kind/addChat coverage)
- Docs: `CLAUDE.md`, `.claude/rules/frontend-react.md`,
  `.claude/rules/backend-typescript.md`, `.claude/docs/services-reference.md`
  (via the `sync-docs` skill at the end).

## Implementation steps

1. **Types first** — add `ChatClientMsg`/`ChatServerMsg` to server `types.ts` and
   mirror into web `types.ts`.
2. **Backend (RED→GREEN)** — write `chatAgent.test.ts` (parse guard + `ChatManager`
   via fake `RunnerFactory` + `chatSystemPrompt` content), confirm it fails, then
   implement `chatAgent.ts` and export `styleDirective` from `phases.ts`.
3. **Wire the route** — add `chats`/`/ws/chat`/`killAll()` in `index.ts`.
4. **Web pure modules (RED→GREEN)** — write `chatProtocol.test.ts` +
   `chatThread.test.ts`, confirm failing, then implement `chatProtocol.ts` +
   `chatThread.ts`.
5. **Dock reducer (RED→GREEN)** — extend `terminalDock.test.ts` for `kind`/
   `addChat`, then edit `terminalDock.ts`.
6. **UI** — build `ChatPane.tsx` + `.module.css`, wire the Chat nav button +
   chat-tab rendering into `TerminalDock.tsx`.
7. **Validate + sync docs** — `npm run typecheck && npm run lint && npm test &&
   npm run build`; run `sync-docs`; manual smoke (`npm run dev`, open Chat, send a
   message, see streamed reply + a tool row, Stop mid-generation, change model →
   fresh session, close tab → process gone).

## Test strategy

**Runner/command:** Vitest in both workspaces — `npm test` (server:
`environment: node`, tests in `packages/server/test/`; web: `jsdom`, tests in
`packages/web/test/`). Full validation is `npm run typecheck && npm run lint &&
npm test && npm run build`.

Tests added/updated and what each proves:

- **`packages/server/test/chatAgent.test.ts` (new)**
  - `parseChatClientMsg`: accepts well-formed `start`/`input`/`interrupt`;
    returns `undefined` for malformed JSON, unknown `type`, and missing/ill-typed
    fields (e.g. `input` without a string `text`) — proving the tolerant guard
    never throws on a stray frame.
  - `ChatManager` driven with an **injected fake `RunnerFactory`** (no real
    `claude`, following `terminal.test.ts`/`taskManager.test.ts`): `create()`
    spawns exactly one session with `SpawnOptions.cwd === config.projectsDir` and
    the requested `model`/`effort`; the fake's captured callbacks, when fired,
    are the ones the route will forward; `send`/`interrupt`/`kill` reach the
    session; a session self-removes from the tracked set on `onExit`; `killAll()`
    kills every tracked session. Config singleton fields saved/restored per test
    (same pattern as `terminal.test.ts`).
  - `chatSystemPrompt`: contains the Projects-dir path and the caveman
    Skill-invocation directive for a non-`normal` style, and does **NOT** contain
    any `ZMRNG_` control token or branch/PR language — proving the chat agent is
    conversational, not a worker.

- **`packages/web/test/chatProtocol.test.ts` (new)** — round-trip: each
  `encode*` output parses back via the server `parseChatClientMsg` shape (asserted
  structurally); `parseChatServerMsg` decodes all seven server frames and returns
  `undefined` for malformed JSON / unknown `type` / ill-typed fields.

- **`packages/web/test/chatThread.test.ts` (new)** — the reducer: `pushUser`
  appends a user bubble and does not mutate input; `appendPartial` opens then
  extends a single streaming agent bubble; `finalizeAssistant` closes it to final
  text; `pushToolNote` inserts a tool row carrying `actor`; `endTurn` clears
  `busy` and closes any open stream; `resetThread` yields a fresh thread. Proves
  the messaging logic independent of the DOM.

- **`packages/web/test/terminalDock.test.ts` (updated)** — existing terminal
  cases keep passing (back-compat of `addTerminal`); new cases: `addChat` appends
  a `kind: 'chat'` tab and focuses it; a mixed terminal+chat dock closes/focuses
  by id across kinds; `addTab` sets the correct `kind`.

**Not unit-tested (with reason):** `ChatPane.tsx` and the `TerminalDock.tsx`
edits — the same precedent as `Terminal.tsx`: WebSocket/DOM glue whose meaningful
logic is extracted into the pure, tested `chatProtocol.ts` / `chatThread.ts` /
`terminalDock.ts` modules. Verified instead by the manual smoke in step 7.

## Alternatives considered (and rejected)

- **Persist chat history in `zmrng.db`** (reuse `ChatMessage`/`addChatMessage`).
  Rejected: the operator chose ephemeral, session-only chats mirroring terminal
  tabs. DB persistence adds a schema migration and lifecycle we were explicitly
  told to skip.
- **Reuse the existing U4 `/api/tasks/:id/chat` SSE proxy + `config.agents`.**
  Rejected: that path talks to an *external HTTP agent* and is *task-scoped*; this
  feature must spawn a real `claude` `Runner` (Max OAuth) and be standalone. Only
  the naming neighborhood overlaps, so we deliberately keep the new module/types
  distinct to avoid conflating the two.
- **A separate second dock just for chat.** Rejected: the operator explicitly
  wants chat and terminal tabs to coexist in one dock, switchable via the same tab
  strip — so we generalize the existing `terminalDock` reducer with a `kind`
  rather than standing up a parallel dock.
- **Reconfigure model/effort/style in place without respawning.** Rejected:
  `claude` model/effort are fixed at process spawn; honoring a mid-conversation
  change requires a fresh child. We respawn on config change (ephemeral, so no
  transcript is lost from disk) and mark it with a session divider.

## Out of scope

- DB persistence of chat transcripts (ephemeral by directive).
- Usage/cost accounting for chat sessions (no per-chat billing display).
- Desktop-sidecar concerns (web-only per the active public-readiness override).
- Reusing/altering the U4 external-agent chat feature.
