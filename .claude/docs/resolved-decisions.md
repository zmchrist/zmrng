# Resolved decisions (don't re-ask)

Settled architecture calls, newest work last. Read before proposing a change
that revisits one of these.

- Engine is the real `claude` binary via `child_process` (ToS-compliant; never proxy the token).
- Team workspace (T1): workspace data lives in the SAME server's SQLite (no new package). The
  `members` table + `/ws/workspace` route + presence live in `packages/server`; the Team tab +
  VPS-URL config + roster in `packages/web`. Local task execution (tasks/worktrees/runner/phases,
  `/ws`, `/ws/terminal`, `/ws/chat`) is UNTOUCHED. ONE multiplexed socket per user carries
  channel-tagged frames (`hello`/`ping` client, `roster`/`pong` server); `WsHub` gained a room
  routing dimension (`join`/`leaveAll`/`broadcastRoom`) rather than a rewrite. Presence is
  connection-based + heartbeat (online while holding a live socket; ping/pong evicts a dead one).
- Team workspace (T2): channels + live messaging. `channels`/`messages` tables (`kind ∈
  human|agent`) in the same SQLite; the multiplexed socket gained `subscribe`/`unsubscribe`/
  `message` frames + a `message`/`channels` server frame; a dedicated `ChannelManager`
  `Map<channel_id, Set<socket>>` (NOT `WsHub` rooms) does per-channel fan-out. REST scrollback
  (`GET /api/channels`, `GET /api/channels/:id/messages` paginated) + WS-live split, no history
  replay. Open membership (no per-channel ACL). A client `message` frame carries no `kind` —
  socket posts are always `human`; the `agent` kind is server-controlled (T4). Deferred to #86:
  reconnect scrollback gap >1 page + backward-pagination UI.
- Team workspace (T3): repo-scoped channels + the planning→execution handoff (D6). `POST
  /api/channels` (create + broadcast the list; dup name → existing row, never 500). "Send to my
  zmrng" pre-fills the LOCAL new-task box (title/body + `From team channel #<name> (message
  #<id>)` provenance) and a *suggested* repo resolved ONLY against the teammate's own registry
  (`teamHandoff.ts`/`resolveSuggestedRepoId`) — no VPS repoId auto-bound; task → backlog, human
  Starts. `NewTaskForm` gained a one-shot `prefill` + `onPrefillConsumed` (dropped after seed so
  a card hide/show can't re-seed). No new shared type (`Channel.repoId` pre-existed).
- Team workspace (T4): the ONE shared @mention team agent (D8/D4), server-only. `agentResponder.ts`
  (`detectMention` word-boundary, `buildAgentMessages`, `parseAgentReply`, `resolveBotAgent`, the
  injectable `AgentResponder`) is wired once by `index.ts`; a mention fires `handleMention` async
  from the `/ws/workspace` handler AFTER the human post — `git pull --ff-only`s a read-only
  reference checkout (best-effort), relays last-N scrollback to the bot `AgentTarget` via the U4
  `fetch(agent.url)` adapter (AbortController timeout), posts the reply as server-controlled
  `kind='agent'`. Talks/plans only, never executes code (D1). Config keys `workspaceRepoPath`/
  `workspaceBotAgentId`/`workspaceBotHandle`(`@agent`)/`workspaceScrollback`(20)/
  `workspaceAgentTimeoutMs`(60000); no agents → graceful no-op. Live checkout path + bot id are
  operator-owned. Deferred to #92: bound @mention concurrency.
- Team workspace — `@`-mention autocomplete + highlight (frontend-only, on top of T4): new pure
  module `mentions.ts` (`mentionCandidates`/`activeMention`/`filterCandidates`/`applyMention`/
  `parseMentions`) drives a live dropdown in `TeamView`'s composer and renders `@name` tokens as
  pills in thread bodies. `GET /api/config` gained `botHandle` (mirrors
  `ZMRNG_WORKSPACE_BOT_HANDLE`) so the autocomplete's candidate list includes the bot; no new DB
  column, no change to the server-side `detectMention` reply trigger.
- Max OAuth only — `ANTHROPIC_API_KEY` stripped from worker env.
- No shared package — server↔web types are a manual mirror.
- Frosted-glass theme; Vitest across both workspaces (typecheck+lint+test+build is validation).
- Worktrees live under the **target repo's own** `worktrees/` dir (e.g. `<repo.path>/worktrees/<shortId>`), not a global dir. That dir should be gitignored in each target repo.
- Build-lane cap via `ZMRNG_MAX_LANES` (default 2); extra READY tasks queue.
- Workspace mode is a **customizable 12-column draggable/resizable card grid** (9-card
  roster: pipeline, concurrency, reviewqueue, newtask, tasklist, files,
  viewers, chat, terminal — the Worker Log lives only inside the Viewers card's `log`
  tab, not as its own top-level card, and the active-task controls live inline in the
  selected TaskList row rather than a standalone card). Grid geometry is in 12-col CELL units
  (screen-width-independent), persisted globally in `GlobalUiState.grid` (server
  round-trips, never validates). The pure reducer + geometry live in
  `packages/web/src/gridLayout.ts`; interaction modes are reflow|swap|free. All 9 cards,
  including Terminal + Chat, seed visible so their tab-strip `+` affordance is discoverable
  without opening the Cards show/hide menu first; cards that own a live socket/session
  (terminal/chat/viewers) stay mounted (`display:none`) while hidden so the session
  survives hide→show. The retired
  GlobalUiState pane/dock/rail/split fields are kept in the type for back-compat with
  already-persisted docs; `TerminalDock.tsx`/`terminalDock.ts` and `NotesPanel.tsx` remain
  as orphaned modules (no importer, tests still pass).
- Workspace bottom-dock terminal shells are ephemeral chrome-wise (never persisted) —
  only the dock's `open`/`height` round-trips through `GlobalUiState.terminalDock`. The
  underlying PTY session itself, however, now survives a transient socket drop (machine
  lock, network blip, page reload): `TerminalManager` (`terminal.ts`) owns sessions
  keyed by id and detaches (not kills) on socket close, starting a grace timer
  (`config.terminalGraceMs`, default 10 min); a reconnect within the window reattaches
  and replays a bounded ring buffer of missed output. A PTY is still reaped on
  grace-timer expiry or server restart — it is not durable across a restart. Desktop-sidecar
  vendoring of `node-pty`'s native binding is an explicit out-of-scope follow-up (the
  public-readiness plan's web-only override applies here too).
- Standalone chat-panel sessions (`/ws/chat`, `ChatManager`) are equally ephemeral — no
  DB persistence, no task lifecycle — and independent of the pre-existing per-task
  `/api/tasks/:id/chat` REST chat (`chat.ts`); the two are separate features that happen
  to share the word "chat".
- The Workspace grid's Chat and Terminal cards each have their own per-card tab strip
  (`windowTabs.ts` + `TabStrip`/`ChatCard`/`TerminalCard`), independent of the orphaned
  bottom-dock terminal above. The tab **metadata** (id/label, and for chat the picked
  model/effort/style + `launched` flag) round-trips through
  `GlobalUiState.chatTabs`/`terminalTabs` (server round-trips, never validates, same
  pattern as `grid`) — chat sessions themselves stay ephemeral, so a reload always
  leaves chat tabs unlaunched again. Terminal tabs are the exception: `TerminalTabMeta`
  also carries an optional `sessionId`, so `Terminal.tsx` re-sends the stored id on
  every (re)connect and a reload reattaches to a still-live server-owned PTY session
  (within `terminalGraceMs`) instead of always spawning fresh.
- Image/PDF drop-paste attachments (`Attachment`/`AttachmentKind` in `types.ts`) are
  equally ephemeral — never written to disk or the DB, held only long enough to build one
  outbound stream-json `user` message (`buildUserMessage`), then discarded. The
  allow-list/size/count limits (`ALLOWED_MEDIA_TYPES`/`MAX_ATTACHMENT_BYTES`/
  `MAX_ATTACHMENTS`) live once in `packages/server/src/types.ts` and are mirrored into
  `packages/web/src/types.ts` like every other shared type; `sanitizeAttachments()` is the
  single server-side enforcement point (REST + `/ws/chat`), `validateFile()` in
  `packages/web/src/attachments.ts` is the client-side mirror for fast feedback before a
  file is even uploaded.
- Local Voice Chat (removed): the frontend-only Local Voice Chat feature (browser STT/TTS
  layered on the `/ws/chat` agent) was shipped as Phase 1 and later **removed entirely** —
  the heavy ML dependencies (`@huggingface/transformers`, `kokoro-js`, `@ricky0123/vad-web`)
  made the bundle too large for the lightweight footprint we want. All voice code
  (`VoiceView.tsx`, `voiceSentences.ts`, `voiceTurn.ts`, the `voice/` seam) and the deps are
  gone; the underlying `/ws/chat` route and text Chat pane are untouched. The dormant
  `voice` opt-in flag on the chat `start` frame (`chatProtocol.ts` / `types.ts` /
  `chatAgent.ts`'s `voiceSystemPrompt`) is retained but no longer set by any UI. Do not
  re-add local ML voice without first re-weighing that bundle cost.

- Login (KB + Team, `.agents/plans/zmrng-login-auth.md`): a username/password gate in front of
  the **Knowledge Base** and **Team Chat** surfaces ONLY — the Workspace orchestrator stays
  ungated (gating the operator's own tooling buys nothing; explicitly rejected). Sessions are
  **server-side rows**, not JWTs (revocation/expiry need a server-side list anyway, so a JWT is
  the sessions table with extra steps); only the sha256 of a token is stored. Hashing is
  `node:crypto` **scrypt**, NOT argon2id (D3) — argon2 is a node-gyp addon the Tauri sidecar
  bundler hand-vendors, and the versioned `scrypt$N$r$p$salt$key` prefix keeps a future swap to
  one file. **One session token, two transports** (D2): an `HttpOnly; SameSite=Strict` cookie
  same-origin, an `Authorization: Bearer` header for the desktop app's cross-origin Team
  connection to the VPS, which no cookie can reach without TLS. `Secure` is conditional, never
  unconditional — browsers silently DROP a `Secure` cookie on the VPS's plain-http origin.
  Because the cross-origin path uses a header, `access-control-allow-credentials` is never sent
  and the existing reflected-origin CORS policy stays safe (reflecting arbitrary origins WITH
  credentials was considered and rejected as a real vulnerability). **One login, not one
  account** (D1): the client keeps an origin-keyed session store and submits one credential pair
  to every gated origin in parallel, so the operator types their password once — but the servers
  do not trust each other and `create-user` must be run on each host; federating identity between
  instances was rejected as far beyond this task. Identity LEFT THE WIRE: `hello` carries no
  display name and `message`/`react`/`page.edit` frames asserting an `author`/`handle` are
  rejected, which also closes the old spoofing hole. `settings.teamHandle` survives in the schema
  (migrations are additive-only) but nothing reads it. Accounts are CLI-provisioned only — no
  self-serve signup, no password-reset flow; re-running `create-user` resets a password, and that
  is the documented recovery path. A dedicated additive `kb_changelog` table records page
  create/rename/move/body-save/delete; reusing `page_revisions` was rejected because it only ever
  sees body saves and dies with its page. `authRoutes.ts` / `kbRoutes.ts` are plain functions on
  the app instance rather than `fastify-plugin` plugins — an encapsulated plugin's `onRequest`
  hook would not cover the parent's routes — which is also what makes the gate and the KB
  attribution testable with `app.inject()` against a bare `Fastify()`.
