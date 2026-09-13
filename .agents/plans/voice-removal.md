# Plan: Remove the Local Voice Chat feature

## What & why
The Local Voice Chat surface (hands-free spoken chat layered on the `/ws/chat`
agent) pulls in a heavy client-side ML stack — `@huggingface/transformers`
(WASM/WebGPU ONNX runtime), `kokoro-js` (TTS), and `@ricky0123/vad-web` (voice
activity detection) — loaded at runtime from a CDN. The operator wants zmrng to
be as lightweight as possible, so the feature is removed **entirely** (deleted,
not disabled).

## Scope

### In scope (remove)
- **Frontend voice code:**
  - `packages/web/src/voice/` (`backend.ts`, `localBackend.ts`, `player.ts`,
    `sttWorker.ts`, `ttsWorker.ts`, `workerProtocol.ts`)
  - `packages/web/src/components/VoiceView.tsx` + `VoiceView.module.css`
  - `packages/web/src/voiceSentences.ts`, `packages/web/src/voiceTurn.ts`
  - Their tests: `packages/web/test/voiceSentences.test.ts`,
    `packages/web/test/voiceTurn.test.ts`
- **UI entry point:** the `voice` pane tab in `WorkspaceView.tsx`
  (`PaneTab` union, `PANE_TABS`, and the mounted `<VoiceView>` panel).
- **Dependencies:** `@huggingface/transformers`, `kokoro-js`, `@ricky0123/vad-web`
  removed from `packages/web/package.json`; `npm install` re-run to drop them
  from the lockfile / `node_modules`.
- **Build config:** the voice-worker-only `worker: { format: 'es' }` block in
  `packages/web/vite.config.ts` (its only reason to exist was the STT/TTS ES
  workers).
- **Docs:** remove voice references from `CLAUDE.md`, `.claude/rules/frontend-react.md`,
  `.claude/docs/codemap.md`, `.claude/docs/implementation-history.md`,
  `.claude/docs/resolved-decisions.md`, and the obsolete voice entries in
  `.claude/errors.md`.

### Out of scope (untouched, per operator)
The underlying `/ws/chat` route and the text Chat pane stay exactly as they are.
Voice was a pure frontend I/O layer on top of that same socket, so the server
seam it used — `chatAgent.ts`'s `voiceSystemPrompt` and the `voice?: boolean`
flag on the chat-start frame in both `types.ts` files, `chatProtocol.ts`, and
`index.ts` — is left in place. Nothing in the shipped UI sets `voice: true` any
more, but the operator explicitly kept the chat backend contract frozen; ripping
the flag out would be a gratuitous change to an out-of-scope route. `chatThread.ts`,
`ChatPane.tsx`, and Team workspace chat are likewise untouched.

## Alternatives considered
- **Keep a stub / feature-flag the UI off** — rejected. The operator asked for
  full removal to shed bundle weight; a disabled stub keeps the heavy deps in
  `package.json` and defeats the purpose.
- **Also strip the server `voice` seam** — rejected as out of scope. The operator
  drew the line at the frontend surface + deps + docs and told us to leave
  `/ws/chat` completely untouched. Removing the flag touches shared wire types
  and the server route for no user-visible benefit.

## Test strategy
- **Test command:** `npm test` (Vitest, both workspaces).
- **This is primarily a deletion.** There is no new behaviour to test-drive
  (RED→GREEN). Correctness is proven by the suite staying green *after* the code
  and its two dedicated test files (`voiceSentences.test.ts`, `voiceTurn.test.ts`)
  are removed, and by `npm run typecheck` proving no dangling imports of the
  deleted modules remain anywhere (`WorkspaceView.tsx`, barrels, etc.).
- **Files removed:** `packages/web/test/voiceSentences.test.ts`,
  `packages/web/test/voiceTurn.test.ts`.
- **No test files added** — nothing new is built. Per the coding-lifecycle
  tolerance for genuinely-untestable/deletion changes, this is stated explicitly
  here and in the PR body.
- **Full gate:** `npm run typecheck && npm run lint && npm test && npm run build`
  all green.

## Validation
`npm run typecheck && npm run lint && npm test && npm run build`, then
`npm run desktop:build` so the shipped `.app` drops the stale voice bundle too.
