# Plan — Team chat `@`-mention autocomplete + highlight

## Goal

Add `@`-mention UX to the **Team chat only** (`packages/web/src/components/TeamView.tsx`):

1. Typing `@` in the channel composer opens a live-filtered autocomplete dropdown
   listing **all roster teammates + the agent bot** in one list. Arrow-key
   navigation, Enter/click to select, Esc to dismiss. Selecting inserts `@<name>`
   into the message.
2. Posted message bodies (existing scrollback + new live messages) render their
   `@<name>` tokens as colored pills, matched **greedily** against the known
   roster + agent names so multi-word display names (`@John Smith`) highlight
   fully. People and the agent are styled **identically**.
3. Person mentions are **purely visual** — no notification, badge, or action. The
   agent `@agent` keeps its existing server-side reply trigger completely
   unchanged.
4. One small backend passthrough surfaces the bot handle (`@agent`) to the web
   client via `GET /api/config`, so the dropdown/highlighter know the agent's name.

**Out of scope:** notifications/unread/badges, mentions in any other composer
(agent chat, clarify, new-task), multiple agents, per-channel ACL, and any change
to how the agent decides to respond (`agentResponder.ts` / `detectMention` untouched).

## Current state (verified by reading the code)

- `TeamView.tsx` — the composer is a single-line `<input>` (line ~436); the thread
  renders each body as plain text `<span className={styles.messageBody}>{m.body}</span>`
  (line ~431). Roster lives in component state as `WorkspaceMember[]`
  (`{ id, displayName, online }`, types.ts:466).
- The bot handle is server config `config.workspaceBotHandle` (default `@agent`,
  config.ts:137/546). It is **not** currently surfaced by `GET /api/config` — the
  inline route literal (`index.ts:157`) has no `botHandle` field. (The `botHandle`
  on index.ts:124 is a constructor arg to `AgentResponder`, unrelated to the route.)
- Web `ServerConfig` interface (types.ts:564) has no `botHandle`. There is **no**
  `ServerConfig` type on the server side — the route returns an inline object
  literal — so the "manual type mirror" obligation here is just: add the field to
  the index.ts literal *and* to the web `ServerConfig` interface.
- Server `detectMention` (agentResponder.ts:37) is word-boundary anchored
  (`(?<!\w)…(?!\w)`). The client highlighter must use the same boundary rule so its
  visual match agrees with the server's actual trigger for `@agent`.
- No test currently pins the `/api/config` response shape, so adding a field is safe.
- No existing web mention/`@` handling exists.

## Approach

All non-trivial logic goes into one **pure, DOM-free** module
`packages/web/src/mentions.ts` (same style as `dashboardData.ts` / `teamHandoff.ts`
/ `attachments.ts`), unit-tested in isolation. `TeamView.tsx` is thin React glue
over it (its own docstring already declares it "connection glue … unit-tested in
isolation" — the composer/dropdown wiring follows that policy and is covered by
manual smoke + typecheck, while every branch of the matching/parsing logic is
proven by `mentions.test.ts`).

### `mentions.ts` pure API

```ts
export interface MentionCandidate { name: string; kind: 'member' | 'agent' }
export type MentionSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; text: string }   // text includes the leading '@'

// Roster displayNames + the agent (bot handle minus a single leading '@'),
// de-duplicated case-insensitively; blank/empty entries dropped.
export function mentionCandidates(
  members: { displayName: string }[], botHandle: string,
): MentionCandidate[]

// The in-progress `@query` ending at the caret, or null. Returns null when the
// '@' is preceded by a word char (email local-part like `foo@bar`) — matching
// detectMention's boundary rule.
export function activeMention(
  text: string, caret: number,
): { start: number; query: string } | null

// Case-insensitive prefix filter; an empty query returns all candidates.
export function filterCandidates(
  candidates: MentionCandidate[], query: string,
): MentionCandidate[]

// Replace the active `@query` (start..caretEnd) with `@name ` (trailing space);
// returns the new text + caret index just past the inserted space.
export function applyMention(
  text: string, start: number, caretEnd: number, name: string,
): { text: string; caret: number }

// Split a body into text + mention segments, greedily (longest name first)
// matching known names with the same word-boundary rule as detectMention.
export function parseMentions(body: string, names: string[]): MentionSegment[]
```

Design details:
- **Greedy multi-word match** — sort names by length desc; at each `@` with a valid
  left boundary (`start` or preceding char is non-word), compare the following
  substring case-insensitively against each candidate and require the char after
  the match to be end-of-string or a non-word char (`(?!\w)` equivalent). First
  (longest) match wins; otherwise the `@` is literal text. This makes `@John Smith`
  highlight fully while `@Johns` (no `John` boundary) stays plain.
- **Dropdown lifecycle** — `activeMention` returns the query even when it spans a
  space (so multi-word names keep filtering); `filterCandidates` returning `[]`
  is what the component uses to hide the dropdown, so typing past any candidate
  name closes it naturally.
- The agent candidate is derived by stripping one leading `@` from `botHandle`
  (`@agent` → `agent`), reusing the same convention as the server's
  `authorFromHandle`.

### `TeamView.tsx` wiring

- New prop `botHandle: string` (default handled by the caller). Compute
  `candidates = mentionCandidates(roster, botHandle)` and
  `names = candidates.map(c => c.name)` from existing state.
- Composer stays an `<input>`, wrapped in a `position: relative` container. On
  `onChange`/`onKeyUp`/`onSelect`, read `e.currentTarget.value` +
  `selectionStart`, compute `activeMention` → `filterCandidates`; store the open
  dropdown state + a highlighted index.
- `onKeyDown`: when the dropdown is open, ArrowUp/ArrowDown move the highlight
  (preventDefault), Enter/Tab select the highlighted candidate via `applyMention`
  (preventDefault so the form does not submit), Esc closes it. When closed, Enter
  submits as today.
- Selecting a candidate calls `applyMention`, sets the composer value, closes the
  dropdown, and restores focus + caret (`setSelectionRange`).
- Render the dropdown as an absolutely-positioned list under the input; each row is
  a `<button type="button">` (keyboard-accessible, no nested interactives) showing
  the name and a small tag for the `agent` row.
- Thread rendering: replace `{m.body}` with
  `parseMentions(m.body, names).map(seg => seg.type === 'mention'
    ? <span className={styles.mention}>{seg.text}</span> : seg.text)`.
  Same pill styling for member and agent mentions.

### Backend passthrough

- `packages/server/src/index.ts` — add `botHandle: config.workspaceBotHandle` to the
  `/api/config` response literal.
- `packages/web/src/types.ts` — add `botHandle: string` to `ServerConfig`.
- `packages/web/src/App.tsx` — pass `botHandle={cfg?.botHandle ?? '@agent'}` to
  `<TeamView>` (the `'@agent'` fallback keeps the dropdown/highlighter working
  before `/api/config` resolves or against an older server).

### CSS (`TeamView.module.css`)

Add, using only `theme.css` design tokens (no raw hex/blur/radius):
- `.composerWrap` — `position: relative` container around the input.
- `.mentionMenu` / `.mentionItem` / `.mentionItemActive` — frosted dropdown
  (`var(--surface-strong)`, `var(--blur)`, `var(--radius-sm)`, `var(--border)`),
  absolute above the input, with the active row using `var(--accent-soft)`.
- `.mentionTag` — small muted label for the agent row (`var(--text-dim)`).
- `.mention` — the in-thread pill (`var(--accent-soft)` bg, `var(--accent)` text,
  `var(--radius-sm)`), identical for people and agent.

## Files changed

| File | Change |
|------|--------|
| `packages/web/src/mentions.ts` | **new** — pure mention helpers |
| `packages/web/test/mentions.test.ts` | **new** — unit tests for the above |
| `packages/web/src/components/TeamView.tsx` | composer dropdown + keyboard + thread pill rendering + `botHandle` prop |
| `packages/web/src/components/TeamView.module.css` | dropdown + pill styles (tokens only) |
| `packages/web/src/types.ts` | add `botHandle: string` to `ServerConfig` |
| `packages/web/src/App.tsx` | pass `botHandle` to `TeamView` |
| `packages/server/src/index.ts` | add `botHandle` to the `/api/config` literal |

No DB, no new route, no `types.ts` server change (no server `ServerConfig` type),
no change to `agentResponder.ts` / phases / runner.

## Step-by-step

1. **RED** — write `packages/web/test/mentions.test.ts` against the `mentions.ts`
   API; run it, confirm it fails to import (module absent).
2. **GREEN** — implement `packages/web/src/mentions.ts`; make the suite pass.
3. Add `botHandle` to the server `/api/config` literal (`index.ts`) and to web
   `ServerConfig` (`types.ts`); thread it through `App.tsx` → `TeamView` prop.
4. Wire `TeamView.tsx`: candidate derivation, composer dropdown + keyboard
   handlers, thread pill rendering. Add the CSS.
5. **REFACTOR** — tidy; keep the suite green.
6. Validate + sync docs + manual smoke (below).

## Test strategy

**Runner/command:** Vitest, `npm test` (both workspaces); web config
`packages/web/vitest.config.ts` (`jsdom`). Iterate with
`npm run test:watch -w @zmrng/web`.

**New — `packages/web/test/mentions.test.ts`** (pure, no jsdom needed) proving:
- `mentionCandidates` — includes all roster `displayName`s + the agent (bot handle
  with one leading `@` stripped, `@agent` → `agent`); de-dups a member named like
  the agent case-insensitively; drops blank names.
- `activeMention` — returns `{start, query}` for `@`, `@Jo`, and a multi-word
  in-progress `@John Sm`; returns `null` for an email local-part `foo@bar` (word
  char before `@`) and for text with no `@` before the caret; picks the `@` nearest
  the caret.
- `filterCandidates` — empty query returns all; case-insensitive prefix filter;
  a query past every candidate returns `[]` (drives dropdown auto-close).
- `applyMention` — replaces the active `@query` with `@name ` and reports the caret
  just past the trailing space; preserves surrounding text on both sides.
- `parseMentions` — greedily highlights a multi-word `@John Smith`; highlights
  `@agent`; leaves a bare `@` and an email `foo@bar` as plain text; a `@John`
  followed by more word chars (`@Johns`, no `John` candidate boundary) is **not**
  matched (near-miss guard, mirroring `detectMention`); interleaves text + mention
  segments in order and round-trips (concatenated segment text === input body).

**Why no component test for the composer/dropdown:** `TeamView.tsx` is declared
connection glue (its docstring) and is intentionally not unit-tested, matching the
repo's stated policy for socket/DOM glue (`WorkspaceGrid`, `Terminal`). All the
decision logic lives in the pure `mentions.ts` and is fully covered there; the thin
React wiring is verified by typecheck + the manual smoke below.

**Existing suites that must stay green:** `agentResponder.test.ts` (untouched —
we do not modify `detectMention`), plus full `npm run typecheck && npm run lint &&
npm test && npm run build`.

**Manual smoke (`npm run dev`, Team tab, a configured workspace URL):**
1. Type `@` in a channel composer → dropdown lists roster members + `agent`.
2. Type a few letters → list filters live; ArrowUp/Down + Enter inserts `@<name>`;
   Esc dismisses; a mouse click also inserts.
3. Send a message containing `@<member>` and `@agent` → both render as identical
   pills in the thread; existing scrollback messages with `@agent` also render pills.
4. Confirm `@agent` still triggers the bot reply exactly as before (server path
   unchanged).

## Alternatives rejected

- **`contenteditable` rich composer** (render pills live as you type, like Slack):
  much more complex (selection/caret management, paste sanitization, IME edge
  cases) for no scope benefit — the ask is a text composer with a dropdown + pills
  only in the posted thread. Rejected as over-engineering.
- **Server-side mention parsing / a `mentions` column on `messages`:** the agreed
  scope is visual-only with no notifications/actions, so persisting structured
  mentions buys nothing and would touch the DB + the shared type mirror. Rejected —
  keep it a pure client render over the existing `body`.
- **Token-split on whitespace to find the mention query** (insert only up to the
  first space, option 5b): breaks multi-word display names, which the operator
  explicitly chose to support (option 5c, greedy). Rejected in favor of greedy
  longest-name matching.
```
