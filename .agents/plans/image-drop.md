# Image & PDF drop/paste — multimodal input to agents

## Goal

Let the operator drop or paste images (PNG/JPEG/GIF/WebP) and PDFs into every place
where they talk to an agent, so the agent receives them as **real multimodal content**
and analyzes them (Q2 option **a** — vision, not a saved reference). The three surfaces
(clarify conversation reached from the clarify/steer flow):

1. **NewTaskForm** — the new-task description box.
2. **ClarifyChat** — the shared live composer (used for both the clarify phase and the
   WorkerLogPanel "steer the worker" composer, so both are covered by one change).
3. **ChatPane** — the standalone `/ws/chat` agent-chat composer.

No durable file store — attachments are transient (operator directive: "image doesn't
need disk persistence, I just want the agents to be able to analyze them").

## Background / current state (verified by reading the code)

- `Runner.send(text)` (`packages/server/src/runner.ts:287`) hardcodes a single
  `{type:'text'}` content block in the stream-json `user` message. The parser already
  *reads* multi-block content (`assistantText`), so the protocol tolerates blocks; only
  the outbound builder is text-only.
- The `claude` CLI is launched with `--input-format stream-json` and authenticates via
  Max OAuth (key stripped in `Runner`'s constructor). The Anthropic content-block shape
  for images over stream-json is
  `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"<b64>"}}`
  and for PDFs `{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"<b64>"}}`.
- **Three send paths reach a live worker/agent:**
  - Task box: `createTask` → (later) `start()` → `runner.send(clarifyKickoff(task))`
    (`phases.ts:781`). There is **no live session at create time** — the worktree/clarify
    child spawns only on Start. So task-box attachments must be *held* between create and
    the first clarify send.
  - Steer/clarify: `POST /api/tasks/:id/message` → `manager.message(id, text)` →
    `runner.send(text)` (`phases.ts:797`). Live session already exists.
  - Chat: `/ws/chat` `input` frame → `session.send(text)` (`index.ts:571`). Live session.
- `RunnerLike` (`runner.ts:335`) is the seam TaskManager/ChatManager and all test fakes
  implement. Extending `send` with an **optional** second param stays backward-compatible
  (fewer-param functions remain assignable).
- Fastify default `bodyLimit` is **1 MB** — a base64 image easily exceeds it, so the app
  must raise the limit or large-image POSTs 413.
- Type mirror: `packages/server/src/types.ts` is source of truth,
  `packages/web/src/types.ts` is a manual mirror — every type change touches both.

## Approach

### Shared primitive: an `Attachment` + a pure block-builder

Add one small type, carried end-to-end:

```ts
// types.ts (source of truth) + web/src/types.ts (mirror)
export type AttachmentKind = 'image' | 'document'
export interface Attachment {
  kind: AttachmentKind
  mediaType: string   // 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'application/pdf'
  dataBase64: string  // raw base64 payload, NO 'data:...;base64,' prefix
  name?: string       // original filename, for the operator log / thumbnail alt text
}
```

Extract the stream-json user-message construction into a **pure, exported** function in
`runner.ts` so it is unit-testable without spawning a child:

```ts
export function buildUserMessage(text: string, attachments?: Attachment[]): object {
  const content: unknown[] = []
  for (const a of attachments ?? []) {
    const source = { type: 'base64', media_type: a.mediaType, data: a.dataBase64 }
    content.push(a.kind === 'image' ? { type: 'image', source } : { type: 'document', source })
  }
  content.push({ type: 'text', text })          // images/docs first, then text (API convention)
  return { type: 'user', message: { role: 'user', content } }
}
```

`Runner.send(text, attachments?)` becomes `stdin.write(JSON.stringify(buildUserMessage(...)) + '\n')`.
`RunnerLike.send` signature gains the optional param.

**PDF verification / fallback (GATED RISK — load-bearing):** the primary path sends PDFs as
inline `document` blocks. This is the single highest-risk area; the CLI accepting an inline
`document` block over stream-json stdin is **not** assumed. **Gate:** manual smoke step 2
(send a small PDF through `/ws/chat`, confirm the agent reads it with no API 400) MUST pass
before the PR. If it does **not**, apply the scope-sanctioned fallback for `kind:'document'`
only: write the PDF bytes to a temp file under `os.tmpdir()`, append its absolute path to the
text block ("A PDF was attached at <path> — read it"), and `fs.unlink` it after the turn is
written to stdin (wrap the write+unlink so the temp file is always cleaned even on error).
Images always stay inline. The whole decision is isolated inside `buildUserMessage`/`send`,
with a comment documenting the chosen path + cleanup. Note the Claude CLI version the inline
path requires if it turns out to be version-gated.

### Backend wiring

- **`runner.ts`** — `buildUserMessage`, `Runner.send(text, attachments?)`, `RunnerLike.send`
  signature.
- **`phases.ts`** —
  - `TaskManager.createTask(..., attachments?)`: stash in a new
    `private pendingAttachments = new Map<string, Attachment[]>()` when non-empty.
  - `start()`: read+delete `pendingAttachments.get(taskId)` and pass to the clarify send:
    `runner.send(clarifyKickoff(task), attachments)`. (Injected once, at the first clarify
    turn — the natural home for "here is the task + its images".)
  - `message(taskId, text, attachments?)`: pass through to `runner.send`; append a
    `[n attachment(s)]` suffix to the logged operator-event `text` so the Worker Log shows
    that files were sent (blocks themselves are not persisted).
  - Clean `pendingAttachments.delete(taskId)` in `cancel()`/`deleteTask()` alongside the
    other per-task cleanup (defensive; already deleted on start).
- **`chatAgent.ts`** — `parseChatClientMsg` accepts an optional `attachments` array on the
  `input` frame (tolerant validation: array of objects with string `kind`/`mediaType`/
  `dataBase64`, else drop the field). `ChatClientMsg.input` type gains `attachments?`.
- **`index.ts`** —
  - Raise the app body limit: `Fastify({ logger: true, bodyLimit: 32 * 1024 * 1024 })`
    (covers both attachment-bearing POST routes).
  - **WebSocket payload:** `@fastify/websocket` does **not** inherit `bodyLimit`; it passes
    a `ws` `Server` whose default `maxPayload` is 100 MB (`ws` default), comfortably above
    our 8 MB-per-file × 10 cap. Confirm at impl (log/inspect the effective option); if a
    pinned version defaults lower, set `options: { maxPayload: 32 * 1024 * 1024 }` in the
    `app.register(websocket, …)` call. Documented here so it is not a silent failure.
  - `POST /api/tasks`: read `body.attachments`, validate/sanitize (see limits), pass to
    `manager.createTask(..., attachments)`. Relax the current
    `if (!title || !taskBody)` guard to `if (!title || !(taskBody || attachments?.length))`
    — an image-only description is valid, but a title is still required.
  - `POST /api/tasks/:id/message`: read + validate `body.attachments`, pass to
    `manager.message(id, text, attachments)`. Relax `if (!text)` to
    `if (!(text || attachments?.length))` so an image-only steer/clarify turn works.
  - `/ws/chat` `input`: `session?.send(msg.text ?? '', msg.attachments)` (an image-only
    chat turn sends an empty text block plus the image blocks).
  - Mirror the same "text OR ≥1 attachment" gate on the client (composer Send/Create
    enable logic) so the two ends agree.
- **Server-side validation** (shared const in `types.ts`): `ALLOWED_MEDIA_TYPES` set +
  `MAX_ATTACHMENTS` (10) + `MAX_ATTACHMENT_BYTES` (8 MB, measured on decoded size ≈
  `dataBase64.length * 3/4`). A route drops disallowed/oversized entries and caps count;
  it never 500s on a bad attachment.

### Frontend wiring

- **New `packages/web/src/attachments.ts`** (pure, unit-tested):
  - `ALLOWED_MEDIA_TYPES`, `MAX_ATTACHMENTS`, `MAX_ATTACHMENT_BYTES` (mirror server).
  - `mimeToKind(mime): AttachmentKind` (`application/pdf` → `document`, else `image`).
  - `validateFile(file): string | null` — returns an error string or null (rejects
    disallowed MIME + oversized; the "near-miss must not match" cases live here).
  - `fileToAttachment(file): Promise<Attachment>` — `FileReader` → strip the
    `data:...;base64,` prefix → `{kind,mediaType,dataBase64,name}`.
  - `filesFromPaste(e)` / `filesFromDrop(e)` — pull `File[]` from clipboard/drag events.
- **New `packages/web/src/useAttachments.ts`** — hook returning
  `{ attachments, addFiles, remove, clear, error }` plus `onPaste`/`onDrop` handlers that
  call `addFiles` (enforcing count/size/MIME, surfacing `error`). Keeps the three
  composers DRY.
- **New `packages/web/src/components/AttachmentTray.tsx` (+ `.module.css`)** — a thumbnail
  strip (image previews via `data:` URL; a generic PDF chip) each with a remove button and
  an inline error line. Uses frosted-glass tokens only (`var(--surface)`, `var(--border)`,
  `var(--radius-sm)`, etc.). No hard-coded colors.
- **`api.ts`** — `createTask(title, body, opts, attachments?)` and
  `message(id, text, attachments?)` include `attachments` in the JSON body.
- **`chatProtocol.ts`** — `encodeInput(text, attachments?)` adds the field to the frame.
- **`App.tsx`** — thread `attachments` through `onCreate` and `onMessage`
  (`api.createTask(title, body, opts, attachments)`, `api.message(id, text, attachments)`).
- **Components:**
  - `NewTaskForm.tsx` — wire `useAttachments`, `onPaste`/`onDrop` on the textarea (and the
    form as a drop target), render `<AttachmentTray>`, pass `attachments` to `onCreate`,
    `clear()` on submit. Enable Create when `title` + (`body` OR ≥1 attachment).
  - `ClarifyChat.tsx` — `useAttachments`, paste/drop on the textarea, tray above the
    composer, `onSend(text, attachments)`; enable Send when text OR ≥1 attachment.
    `WorkerLogPanel.tsx` forwards `onMessage(text, attachments)`.
  - `ChatPane.tsx` — `useAttachments`, paste/drop on the composer textarea, tray, include
    attachments in `encodeInput`, `clear()` after send; Send enabled when text OR ≥1
    attachment.

### Alternatives considered & rejected

- **DB `task_attachments` table for the task box** (survives restart). Rejected: the
  operator explicitly wants *no* persistence; base64 blobs on/near the `tasks` row would
  also bloat `listTasks()`/the WS snapshot. An in-memory `Map` consumed at the first
  clarify send is simpler, matches intent, and the realistic flow (drop → create → start)
  keeps them only seconds. Cost: a server restart or a very-delayed Start loses them (the
  operator re-drops) — acceptable.
- **Encode images as text/markdown references in the body.** Rejected: cannot deliver
  actual pixels to the model (fails Q2 = vision).
- **A shared workspace package for the `Attachment` type.** Rejected: the repo
  deliberately has no shared package; follow the manual-mirror convention.
- **Per-route `bodyLimit`.** Rejected in favor of one global raise — simpler, and the only
  large bodies are these two routes anyway.

## Files to change

Server:
- `packages/server/src/types.ts` — `Attachment`, `AttachmentKind`, `ChatClientMsg.input`
  gains `attachments?`, shared limit consts.
- `packages/server/src/runner.ts` — `buildUserMessage`, `Runner.send`, `RunnerLike.send`.
- `packages/server/src/phases.ts` — `pendingAttachments` map, `createTask`, `start`,
  `message`, cleanup.
- `packages/server/src/chatAgent.ts` — `parseChatClientMsg` attachments.
- `packages/server/src/index.ts` — `bodyLimit`, `/api/tasks`, `/api/tasks/:id/message`,
  `/ws/chat` wiring + validation.

Web:
- `packages/web/src/types.ts` — mirror `Attachment`/`AttachmentKind`/`ChatClientMsg`.
- `packages/web/src/attachments.ts` (new), `packages/web/src/useAttachments.ts` (new).
- `packages/web/src/components/AttachmentTray.tsx` + `.module.css` (new).
- `packages/web/src/api.ts`, `packages/web/src/chatProtocol.ts`, `packages/web/src/App.tsx`.
- `packages/web/src/components/NewTaskForm.tsx` (+ css), `ClarifyChat.tsx` (+ css),
  `WorkerLogPanel.tsx`, `ChatPane.tsx` (+ css).

Docs (sync at the end): `CLAUDE.md`, `.claude/rules/backend-typescript.md`,
`.claude/rules/frontend-react.md`, `.claude/docs/services-reference.md` as the runner/
chat/route surfaces change.

## Test strategy

Runner/command: **Vitest**, both workspaces — `npm test` (or `-w @zmrng/server` /
`-w @zmrng/web`). Full validation before PR: `npm run typecheck && npm run lint &&
npm test && npm run build`.

New / updated tests:

- **`packages/server/test/runner.test.ts`** (update) — `buildUserMessage`:
  - text-only → `content` is exactly one `{type:'text'}` block.
  - one image → `[{type:'image',source:{type:'base64',media_type,data}}, {type:'text'}]`
    in that order, with the right media_type/data.
  - one PDF → `document` block shape.
  - mixed + ordering (all media blocks precede the text block).
  *Proves the multimodal wire shape the CLI expects is built correctly.*
- **`packages/server/test/taskManager.test.ts`** (update) — extend `FakeRunner` to record
  `sentAttachments`. New cases:
  - `createTask` with attachments then `start()` → the clarify `send` carries those
    attachments (and they are single-use: a second `start` after a fail does not double
    them — asserts the map was consumed).
  - `message(id, text, attachments)` → the live `send` receives the attachments.
  *Proves task-box holding/injection and the steer path.*
- **`packages/server/test/chatAgent.test.ts`** (update) — `parseChatClientMsg` accepts a
  valid `input` frame with `attachments` (returns them) and drops a malformed
  `attachments` field without throwing (tolerant-parse contract).
- **`packages/web/test/attachments.test.ts`** (new) — `validateFile` accepts each allowed
  type and rejects a disallowed MIME (e.g. `image/svg+xml`, `text/plain`) and an oversized
  file; `mimeToKind` maps pdf→document and images→image; the count guard trips past
  `MAX_ATTACHMENTS`. *Pure-logic, near-miss coverage per the testing rules.*
- **`packages/web/test/chatProtocol.test.ts`** (update) — `encodeInput(text, attachments)`
  round-trips the attachments field in the frame; `encodeInput(text)` (no attachments)
  stays byte-identical to today (no regression for the existing chat path).

Component drop/paste glue in the three composers is thin wiring over the pure hook/helpers
and is verified by the **manual smoke** below rather than jsdom DnD simulation (consistent
with how `ChatPane`/`Terminal` DnD is left untested in this repo). If a quick RTL test for
`AttachmentTray` render+remove is cheap, add it; it is not load-bearing.

Manual smoke (touches the engine): `npm run dev`, then on `:5174`:
1. Paste an image into NewTaskForm → thumbnail appears → Create → Start → confirm in the
   Worker Log that the clarify turn shows the attachment and the agent describes the image.
2. Drop a PDF into the steer composer of a live task → agent reads/summarizes it.
3. Paste an image into a ChatPane tab → agent analyzes it.
Confirm a disallowed type and an oversized file are rejected with an inline error, and that
a large (multi-MB) image no longer 413s (body limit raised).

## Out of scope

Durable attachment storage / gallery, editing/annotating images, drag-reordering the tray,
attachments on the legacy per-task REST chat (`/api/tasks/:id/chat`, `chat.ts` — a separate
optional external-agent feature), and desktop-sidecar concerns (web-only per the active
public-readiness override).
