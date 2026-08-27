# Plan: Local Voice Chat for zmrng

**Slug:** `local-voice-chat`
**Branch:** `feat/zc/local-voice-chat` (from `origin/main`)
**Type:** New capability
**Complexity:** Medium (frontend-heavy, near-zero backend)
**Status:** Ready for review

---

## 1. Feature description & user story

Add a **Voice** surface to zmrng that lets the operator hold a spoken, hands-free
conversation with a standalone chat agent (the same Max-OAuth `claude` session that
powers the existing text Chat card) — speak a question, hear the answer read back,
interrupt by voice, all fully local (no cloud).

```
As the zmrng operator
I want to talk to a chat agent by voice and hear its replies spoken back
So that I can ask questions and steer work hands-free without typing, while keeping
   everything local (no cloud STT/TTS, claude stays Max-OAuth)
```

### The core insight that shapes this plan

zmrng **already has the entire model leg**: `GET /ws/chat` + `ChatManager`
(`chatAgent.ts`) spawn a conversational Max-OAuth `claude` session and stream
`partial`/`assistant`/`tool`/`result` frames over a socket, exactly like the browser
`ChatPane` consumes today. **Voice is a pure I/O shell layered on top of that existing
socket** — transcribe mic → send as a `/ws/chat` `input` frame → speak the streamed
reply. This mirrors `duck_talk`'s "wrap the agent as a black box" architecture, but we
reuse our own `/ws/chat` instead of duck_talk's Claude-Agent-SDK server leg.

**Consequence: the backend change is ~zero.** No `voiceAgent.ts`, no `/ws/voice`, no
`VoiceManager`. All new code is frontend.

---

## 2. Architecture

### Chosen approach — browser-side ML pipeline (Route A: fully local)

All voice ML runs **in the browser/webview** via WebAssembly + WebGPU, feeding the
existing `/ws/chat` socket for the model turn:

```
VoiceView (React, owns one /ws/chat WebSocket like ChatPane/Terminal)
  │
  ├─ mic ──► @ricky0123/vad-web (Silero VAD, AudioWorklet capture + endpointing)
  │            onSpeechStart → barge-in (stop playback, interrupt turn)
  │            onSpeechEnd(Float32Array) ──► STT
  │
  ├─ STT: @huggingface/transformers Whisper (ONNX, WebGPU→WASM fallback, Web Worker)
  │            audio → transcript text
  │            ──► encodeInput(transcript) over the /ws/chat socket   [REUSED]
  │
  ├─ model: existing ChatManager/claude  ──► partial/assistant/tool/result frames
  │            (parseChatServerMsg → chatThread reducer for a visible transcript)
  │
  └─ TTS: kokoro-js (Kokoro-82M ONNX, WebGPU→WASM fallback, Web Worker)
             sentence-buffered reply text → PCM audio → Web Audio playback
             while speaking: VAD paused (or barge-in armed)
```

**Why browser-ML, not a server sidecar** (the pivotal decision — see §8 Rejected
alternatives): a Python/native sidecar (faster-whisper + Kokoro + Silero on the server)
is faster on Apple Silicon Metal but is a **packaging nightmare** for the Tauri `.app`
— bundling a Python runtime or native Metal binaries is the same class of work as the
node-pty native-vendoring follow-up CLAUDE.md already defers, ×3. Browser-ML ships as
plain JS + WASM + static model files inside `web/dist`, which `bundle-sidecar.mjs`
already copies wholesale. **Phase 2 packaging becomes nearly free.** The tradeoff is
raw speed (WASM in WKWebView is slower than native Metal), addressed by the WebGPU path
+ the backend seam below.

### The STT/TTS backend seam (satisfies "swap in a cloud backend later")

Define a small `VoiceBackend` interface so the ML engine is swappable without touching
`VoiceView`:

```ts
interface VoiceBackend {
  transcribe(audio: Float32Array, sampleRate: number): Promise<string>
  synthesize(text: string, voice?: string): Promise<Float32Array>  // 24kHz PCM
  warmup(): Promise<void>
  readonly ready: boolean
}
```

Phase-1 impl = `LocalVoiceBackend` (transformers.js + kokoro-js). Future impls
(`GeminiLiveBackend`, or a `NativeSidecarBackend` talking to a `/ws/voice` route) slot
in behind the same interface. VAD stays client-side regardless.

### Where it lives in the UI

`WorkspaceView.tsx` is the live Cosmos-IDE view (the draggable `WorkspaceGrid` is
currently **orphaned** — no importer). Voice is a **5th pane tab** alongside
`worker · files · terminal · chat`, not a grid card. This keeps us out of the 8
exhaustive `GridCardId` enumeration sites.

---

## 3. Context references (read before implementing)

**Reuse verbatim (do not modify):**
- `packages/web/src/chatProtocol.ts` — `encodeStart`/`encodeInput`/`encodeInterrupt`/
  `parseChatServerMsg`. VoiceView drives `/ws/chat` with these, unchanged.
- `packages/web/src/chatThread.ts` — `emptyThread`/`pushUser`/`appendPartial`/
  `finalizeAssistant`/`pushToolNote`/`endTurn`. Reused for the visible transcript.
- `packages/server/src/chatAgent.ts`, `/ws/chat` route in `index.ts` (L626–697) — the
  model leg. **No changes.**

**Pattern to mirror (own-socket + own-lifecycle component):**
- `packages/web/src/components/ChatPane.tsx` — one `WebSocket` to `/ws/chat` per
  instance, `encodeStart` on open, `parseChatServerMsg` → reducer, `encodeInput` to
  send, `encodeInterrupt` to Stop, config selects (model/effort/style/repo). VoiceView
  ≈ ChatPane + a voice I/O layer.
- `packages/web/src/components/Terminal.tsx` — own-socket + `ResizeObserver` +
  strict `useEffect` cleanup (`ws.close()`, dispose). Same disciplined teardown for the
  VAD/mic/AudioContext/workers.

**Pattern to mirror (adding a pane tab):**
- `packages/web/src/components/WorkspaceView.tsx` — `PaneTab` union (L28), `PANE_TABS`
  (L29–34), and the `display:none`-stay-mounted panel bodies where `<TerminalCard>`
  (L297) / `<ChatCard>` (L307) render. Add `'voice'` + a `<VoiceView>` panel here.

**Rules that bind this work:**
- `.claude/rules/frontend-react.md` — CSS Modules + `theme.css` tokens only (no
  hard-coded colors/blur/radius); own-socket pattern for non-hub sockets; no `any`;
  derive state during render, never `setState` in an effect.
- `CLAUDE.md` — Max-OAuth only (voice never touches the claude auth path — it only
  produces text for the existing `/ws/chat`); ephemeral-by-design (no DB, no disk for
  audio); app-not-website (phase 2 must rebuild the `.app`).

---

## 4. Dependencies

Add to **`packages/web`** only (all browser-side):

| Package | Purpose | Notes |
|---|---|---|
| `@huggingface/transformers` (v3.x) | Whisper STT (ONNX, WebGPU/WASM) | v3 renamed from `@xenova/transformers`; `device: 'webgpu'` with WASM fallback |
| `kokoro-js` (latest) | Kokoro-82M TTS in JS (via transformers.js) | Apache-2.0 model, ~80–300MB weights |
| `@ricky0123/vad-web` (latest) | Silero VAD + mic capture (AudioWorklet) | gives `onSpeechStart`/`onSpeechEnd(Float32Array)`; removes the need to hand-roll a recorder |

No new server dependencies. Confirm each installs cleanly and check its peer/asset
requirements (both `vad-web` and transformers.js fetch `.onnx`/`.wasm` assets — see
§7 gotchas for the static-asset + COOP/COEP notes).

---

## 5. Implementation tasks

### Phase 1 — voice working in the dev browser (`npm run dev`, Chrome, :5174)

**Task 1.1 — Pure sentence buffer (`packages/web/src/voiceSentences.ts`)** *(RED first)*
Streamed `partial` deltas arrive token-by-token; TTS wants whole sentences for natural
prosody + first-audio latency. Pure, DOM-free reducer:
```ts
interface SentenceBuffer { pending: string; flushed: string[] }
emptyBuffer(): SentenceBuffer
push(buf, delta): { buf, ready: string[] }   // returns any newly-completed sentences
flush(buf): { buf, ready: string[] }          // force-flush the tail on endTurn
```
Split on sentence terminators (`.!?…` + newline), keep a trailing fragment pending,
never split mid-decimal/abbreviation naively (keep it simple: terminator followed by
whitespace/end). **Unit-tested** — this is the highest-value pure logic.

**Task 1.2 — Voice turn state machine (`packages/web/src/voiceTurn.ts`)** *(RED first)*
Pure reducer over states `idle → listening → transcribing → thinking → speaking →
(listening|idle)`, with events `speechStart`, `speechEnd`, `transcript`, `partial`,
`turnEnd`, `bargeIn`, `stop`. Encodes the freeze rule (ignore `speechEnd` while
`speaking` unless barge-in) and interrupt semantics. **Unit-tested.**

**Task 1.3 — `VoiceBackend` interface + `LocalVoiceBackend`
(`packages/web/src/voice/backend.ts`, `voice/localBackend.ts`)**
Interface per §2. `LocalVoiceBackend` lazy-loads a Whisper pipeline
(`@huggingface/transformers`, `automatic-speech-recognition`, `device: 'webgpu'` →
catch → `'wasm'`) and a `kokoro-js` `KokoroTTS` instance, each in a **Web Worker** so
inference never blocks the UI thread. `warmup()` primes both. Model glue is **not
unit-tested** (mirrors the `WorkspaceGrid`/`Terminal` glue policy) — but it must be
isolated behind the interface so `VoiceView` stays testable-by-inspection.

**Task 1.4 — Audio playback helper (`packages/web/src/voice/player.ts`)**
Queue of PCM `Float32Array` chunks → single `AudioContext` playback with a `stop()`
that cancels the queue (for barge-in/Stop). Small, DOM-adjacent; smoke-tested manually.

**Task 1.5 — `VoiceView` component (`packages/web/src/components/VoiceView.tsx` +
`.module.css`)**
The shell. Mirrors `ChatPane` for the socket half:
- Own `WebSocket` to `/ws/chat`; `encodeStart(model, effort, style, repoId)` on open.
- `parseChatServerMsg` → drive both the `chatThread` reducer (visible transcript) **and**
  the `voiceSentences` buffer → `backend.synthesize` → `player` queue.
- Wire `@ricky0123/vad-web` `MicVAD`: `onSpeechStart` → `voiceTurn` `speechStart`
  (+ barge-in: `player.stop()` + `encodeInterrupt()` if currently speaking);
  `onSpeechEnd(audio)` → `backend.transcribe` → `pushUser` + `encodeInput(transcript)`.
- Controls (CSS-module + tokens): a big push-to-talk/auto-VAD toggle, a **Stop**
  (interrupt) button, mic-permission + model-loading status, and the config selects
  (model/effort/style/repo) reused from the ChatPane pattern. A live transcript pane
  underneath (reuse the ChatPane bubble rendering).
- **Strict teardown** in the `useEffect` cleanup (mirror `Terminal.tsx`): destroy the
  `MicVAD`, close the socket, terminate workers, close the `AudioContext`. Not
  unit-tested (glue), documented under Testing.

**Task 1.6 — Wire the pane tab (`WorkspaceView.tsx`)**
Add `'voice'` to `PaneTab` (L28) + `PANE_TABS` (L29–34), and a `display:none`-toggled
panel rendering `<VoiceView repos={repos} config={config} />` beside the Terminal/Chat
panels. VoiceView is self-contained (no persisted tabs) → **no `types.ts` change, no
type-mirror edit** (it consumes only the pre-existing `ChatServerMsg`/`Attachment`
types via `chatProtocol`). Keep it single-instance for phase 1 (no tab strip).

**Task 1.7 — Static ML assets in dev**
In dev, let transformers.js/kokoro-js/vad-web fetch models from the HF/CDN default
(cached in browser storage). Confirm the WASM/ONNX assets for `vad-web` resolve (it
ships an `ort-wasm` + `silero_vad` worklet — may need `onnxWASMBasePath`/`baseAssetPath`
pointing at a copied asset dir under `packages/web/public/`). Document the exact asset
paths discovered.

### Phase 2 — vendor into the Tauri `.app` (offline-first)

**Task 2.1 — Bundle model + runtime assets into `web/dist`**
Download the chosen Whisper model (e.g. `whisper-base` ONNX quantized), Kokoro-82M
weights, Silero VAD `.onnx`, and the `ort-*.wasm` runtime into
`packages/web/public/models/…` at build time (a `scripts/fetch-voice-models.mjs` step,
or committed if size allows). Point transformers.js at them:
`env.allowRemoteModels = false; env.localModelPath = '/models/'` and set
`vad-web` + `onnxruntime-web` asset base paths to the local dir. `bundle-sidecar.mjs`
already `cpSync`s `web/dist` → `web-dist`, so **no `bundle-sidecar.mjs` change is
required** — the assets ride along as static files. (Contrast: a native sidecar would
need a new `VENDORED` entry + ABI-matched binary — avoided entirely.)

**Task 2.2 — WebGPU-in-WKWebView investigation (risk item, may land as WASM-only)**
WKWebView does **not** enable WebGPU by default. Investigate enabling the WebGPU
feature flag via Tauri's `macos-private-api` / WKWebView preferences. If achievable →
full speed in the `.app`. If not → accept single-threaded WASM fallback (functional,
~seconds-latency STT) for phase 2 and note the native-sidecar backend as the future
speed path behind the `VoiceBackend` seam. **Do not block phase 2 on WebGPU.**

**Task 2.3 — Rebuild + verify the `.app`**
`npm run desktop:build`; launch the `.app`; confirm the Voice pane loads models
offline and completes one spoken round-trip. (App-not-website rule: phase-2 is not
"done" until the `.app` ships the new code.)

---

## 6. Test strategy

**Runner:** Vitest, `@zmrng/web` (jsdom).

| Test file | Proves |
|---|---|
| `packages/web/test/voiceSentences.test.ts` | `push`/`flush` sentence segmentation: incremental deltas yield sentences only on terminators; trailing fragment stays pending; `flush` emits the tail; multi-sentence delta splits correctly; abbreviation/decimal not over-split (documented tolerance). |
| `packages/web/test/voiceTurn.test.ts` | State machine: `speechEnd` ignored while `speaking` (freeze); `bargeIn` transitions `speaking → listening`; `stop` → `idle`; normal `listening → transcribing → thinking → speaking → listening` cycle. |

**Explicitly not unit-tested (documented under PR "Testing"), mirroring the
`WorkspaceGrid`/`Terminal.tsx` glue policy:** `LocalVoiceBackend` (real ONNX inference),
`player.ts` (Web Audio), and `VoiceView` (mic/VAD/socket/worker glue). These require a
real mic + WebGPU/WASM runtime and are covered by manual smoke, not Vitest — no test
may spawn a real `claude`, hit the network, or require a mic (testing.md hard rule).

**Manual smoke (phase 1):** `npm run dev` → Voice pane → grant mic → speak "what files
are in this repo?" → observe transcript → hear spoken reply → say "stop" mid-reply →
playback halts + turn interrupts. **Manual smoke (phase 2):** same, in the built `.app`,
offline (airplane mode after model cache) to prove local-only.

---

## 7. Gotchas / risks

1. **WKWebView ≠ WebGPU by default** (phase-2 risk). Dev browser (Chrome) has WebGPU →
   fast. Packaged `.app` likely WASM-only until the flag is enabled → slower STT.
   Mitigation: WASM fallback is functional; native-sidecar backend is the future fast
   path behind the seam. Not a phase-1 concern.
2. **COOP/COEP / SharedArrayBuffer.** Multi-threaded WASM needs
   `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
   require-corp`, which can break other cross-origin loads. **Prefer WebGPU + single-
   threaded WASM to avoid adding these headers** to Vite dev + the Fastify static serve.
   Only add them if single-threaded WASM proves too slow — and if so, scope the impact.
3. **Model download size / first-run.** Whisper + Kokoro weights are tens–hundreds of
   MB. Phase 1 fetches from CDN (cached); phase 2 bundles locally. Show a clear loading
   state in `VoiceView` while `warmup()` runs.
4. **`vad-web` asset paths.** It loads an AudioWorklet + `silero_vad.onnx` + ORT WASM;
   these must be reachable (its `baseAssetPath`/`onnxWASMBasePath` options). Copy into
   `public/` and set the paths explicitly rather than relying on CDN in the `.app`.
5. **Echo / self-hearing.** The agent's TTS voice must not be transcribed as user
   input. Handled by the `voiceTurn` freeze (VAD paused/ignored while `speaking`) +
   barge-in being explicit. Verify on real speakers (not just headphones).
6. **Sentence-buffer vs. code blocks.** Agent replies may contain code/URLs the TTS
   shouldn't read verbatim. Phase-1 tolerance: speak everything; a future filter
   (strip fenced code before synth) is a noted follow-up, not in scope.
7. **Type-mirror drift (pre-existing, not ours).** Scouts found `ChatTabMeta.repoId`
   and `ChatClientMsg.start.repoId` already differ between server/web `types.ts`. We
   touch neither — but do not copy the drift into any new type. (If a `voiceTabs`
   round-trip is ever added, mirror both files — out of scope for phase 1.)

---

## 8. Rejected alternatives

- **Server-side voice sidecar (Python faster-whisper + Kokoro + Silero, or native
  whisper.cpp Metal).** *Rejected for the primary path.* Faster on Apple Silicon, but
  bundling Python or ABI-matched native binaries into the Tauri `.app` is the same
  deferred node-pty-vendoring pain ×3 (new `VENDORED` entries, `hostTriple` ABI
  matching, model shipping). The browser-ML path ships as static `web/dist` assets with
  **zero `bundle-sidecar.mjs` change**. Kept alive only as a future `VoiceBackend` impl
  for `.app` speed if WASM proves inadequate.
- **Gemini Live (duck_talk's exact stack).** *Rejected per operator preference* (wants
  local, no cloud). Cheapest to build and proven end-to-end, but adds a cloud
  dependency, a `GEMINI_API_KEY`, rate/session limits, and violates the no-cloud goal.
  Preserved as a swappable `GeminiLiveBackend` behind the seam.
- **New `voiceAgent.ts` + `/ws/voice` route + `VoiceManager`.** *Rejected as
  unnecessary.* `/ws/chat` + `ChatManager` already deliver the exact streamed-text model
  leg voice needs; a parallel server service would duplicate it. Voice reuses `/ws/chat`
  untouched.
- **Voice as a `WorkspaceGrid` card.** *Rejected* — that grid is orphaned (no importer)
  on this branch; adding a `GridCardId` means touching 8 exhaustive enumeration sites
  for a card that never renders. The live `WorkspaceView` pane-tab path is 2 edits.

---

## 9. Validation

```bash
npm run typecheck   # tsc --noEmit, both workspaces (catches any type-mirror drift)
npm run lint        # ESLint, both workspaces
npm test            # Vitest — voiceSentences + voiceTurn green
npm run build       # tsc(server) + vite build(web)
# Phase 2 only:
npm run desktop:build   # rebuild the .app so it ships the voice pane + local models
```

Then run the `sync-docs` skill (new frontend modules + CLAUDE.md structure notes) and
stage this plan file (the PR checklist links it). UI-touching change → attach a
final-state screenshot of the Voice pane to the PR (Playwright MCP, best-effort).

---

## 10. Acceptance criteria

- [ ] A **Voice** tab appears in the `WorkspaceView` pane strip.
- [ ] Granting mic access and speaking produces a transcript sent to the existing
      `/ws/chat` agent (visible in the transcript pane).
- [ ] The agent's reply is spoken back, sentence-by-sentence, with first audio well
      before the full turn completes.
- [ ] Speaking over the agent (or pressing **Stop**) halts playback and interrupts the
      turn (barge-in).
- [ ] The agent's own voice is never transcribed as user input (freeze works).
- [ ] `claude` still authenticates via Max OAuth — no `ANTHROPIC_API_KEY` path touched;
      no audio written to disk or DB (ephemeral).
- [ ] `voiceSentences` + `voiceTurn` unit tests pass; full validation green.
- [ ] **Phase 2:** the built `.app` runs the Voice pane with locally-bundled models
      (no network), or the WebGPU/WASM fallback status is documented if speed is degraded.

---

## Confidence: one-pass implementation

**~7/10.** The backend-reuse insight and the pane-tab placement are verified against the
real code, and the pure logic (sentence buffer, turn machine) is straightforward TDD.
The risk is entirely in the **browser-ML glue** — exact `@ricky0123/vad-web` /
transformers.js / kokoro-js asset wiring, worker setup, and WKWebView WebGPU behavior
are library-integration unknowns that may need iteration during implementation (which is
why they sit behind the `VoiceBackend` seam and are staged phase-1-dev-first).
