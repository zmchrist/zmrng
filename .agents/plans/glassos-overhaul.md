# Plan — GlassOS Frontend Overhaul

## Goal
Reskin the zmrng web UI to a "Liquid Glass" / GlassOS aesthetic: sleek, deep-dark
glass panels at ~75% opacity, soft (large) radii, smooth spring transitions, luminous
cyan/azure accent, refined system (SF Pro) typography, and a living aurora background
behind the glass.

## Locked direction (operator-approved)
- **Theme:** deep dark glass (luminous Liquid Glass over dark aurora).
- **Accent:** cool cyan → azure (`#5ec8ff`), with glow on active/primary/focus.
- **Type:** system SF Pro stack, refined weights / tracking / scale (offline-safe, no web fonts).
- **Glass opacity:** ~0.72–0.78 panel surfaces.

## Constraints
- **Pure CSS overhaul.** No `.tsx`/types changes → no server↔web type-mirror risk.
- **Tokens only.** All color/blur/radius/motion via `var(--*)` in `theme.css`; replace the
  few hard-coded rgba/hex in component modules with new tokens.
- Keep every existing token name (components reference them) — extend, don't break.
- Respect `prefers-reduced-motion` (pause aurora + entrance animations).
- Validation: `npm run typecheck && npm run lint && npm run build`.

## Files
1. `theme.css` — new token system (surfaces, glass filter, glow, hairline, accent ramp,
   refreshed status hues, refined text, larger radii, spring transitions), animated
   aurora background layer + subtle grain, reduced-motion guard.
2. `App.module.css` — glass rail, brand treatment, glowing connection dot, page-load stagger.
3. `TaskList.module.css` — glass rows, accent-edge active state, refined pill.
4. `NewTaskForm.module.css` — glass-inset fields, focus glow ring, gradient primary button.
5. `TaskDetail.module.css` — glass header w/ top hairline highlight, badges, usage card, buttons.
6. `ClarifyChat.module.css` — glass composer, focus glow, gradient send.
7. `WorkerLog.module.css` — glass chat bubbles, message fade-in-up, glowing stream caret.

## Out of scope
Desktop/server work (left uncommitted on this branch's tree; only `packages/web/**` is committed).
