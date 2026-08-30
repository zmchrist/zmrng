# Instance Update Distribution — Grill Decision Record

**Session:** 2026-08-30 · grill-with-docs · zc
**Question that opened it:** how do teammates' zmrng instances stay on the latest code
when zc ships — a sitewide refresh or an in-app Update button — and should everyone run
off one shared VPS instance while coding agents still burn LOCAL resources? "Make it as
friendly for the layman as possible."

> No `docs/adr/` exists in this repo; per the `layman-onboarding-grill.md` precedent the
> decision blocks live in this plan file, not a separate ADR.

## Context that reframed the whole grill

- **Recon overturned the opening premise.** zc's "one shared instance, agents run local"
  is already half-built — as its *opposite*. The built model IS "shared collab bus + N
  local executors":
  - `runner.ts` spawns `claude` as a child on the SAME host, in a git worktree on THAT
    host's disk, with THAT host's Max/Pro OAuth (`ANTHROPIC_API_KEY` stripped). Execution
    is intrinsically local — not network-delegable without a new broker.
  - The VPS already runs the SAME binary as collaboration-ONLY. `docs/team-workspace-deploy.md:98`
    is explicit: "never set `ANTHROPIC_API_KEY` … never spawns task workers."
  - So the current split already achieves zc's stated goal (shared workspace + agents burn
    LOCAL resource/OAuth + VPS stays light). Model B (shared VPS UI dispatching to remote
    per-laptop worker daemons) re-earns the exact resource/OAuth problem the split avoids,
    to buy ONE small thing: shared task visibility. That's a broadcast feature, not a
    re-platform.
- **The three questions were three separate problems, conflated:** (A) keep the VPS collab
  instance current; (B) keep teammates' LOCAL apps current — the real ask; (C) the
  re-architecture (rejected).
- **The update MECHANISM already exists.** Settings→Reboot → `POST /api/restart` →
  `selfUpdate()` (ff-pull origin/main) + `npm run build` + tsx respawn (`index.ts:189`,
  `worktree.ts:403`). It fully works in dev-server mode — exactly how both Windows partners
  run today (`layman-onboarding-grill.md`). Only the *notify/trigger UX* is missing.

## Decisions

### D1 — Keep Model A (N local apps + one shared VPS collab bus); reject the remote-worker broker
**Decision:** Do NOT re-architect to a shared VPS UI that dispatches coding jobs to
per-laptop worker daemons (Model B/C). Keep the shipped model: each teammate runs a local
app that executes `claude` locally; the VPS runs the same binary as collaboration-only
(channels + presence + `@agent`). The "shared task visibility" that Model B would buy is a
future broadcast-task-status feature layered on the existing `/ws/workspace` socket, not a
platform change.
**Why:** Execution is intrinsically local (`runner.ts` child process + local worktree +
local OAuth). The current split already delivers zc's goal (shared workspace, local
resource/OAuth burn, light VPS). Model B rebuilds a whole remote-dispatch subsystem (per-box
daemon, job routing, result streaming, per-user OAuth on each box) to buy one small feature.
**Cost accepted:** No single URL everyone opens; each teammate installs/runs a local app.
Shared task visibility is deferred (not free, but cheap later — a status broadcast).
**Rejected:** Model B/C (shared UI + remote workers) — re-earns the resource/OAuth problem
the split was designed to avoid, for marginal gain. YAGNI.

### D2 — VPS collab instance auto-updates via a conditional cron poll on the VPS
**Decision:** A cron job on the VPS periodically (every N min) `git fetch`es and compares
the local `origin/main` SHA to `HEAD`; it re-runs `scripts/deploy-workspace.sh` ONLY when
behind. No blind periodic restarts.
**Why:** The VPS already has the checkout + Tailscale; a self-poll is simpler than wiring
CI→VPS SSH credentials. Conditional-on-behind keeps the ~1s reconnect blip rare (only on a
real new commit).
**Cost accepted:** Up to N-min lag between merge and VPS refresh. Fine for a collab bus.
**Rejected:** GitHub Action SSHing into the VPS (needs deploy creds on GitHub, more moving
parts); blind periodic redeploy (needless reconnect blips + rebuild churn).

### D2a — VPS chats/tasks are SAFE across redeploy; enforce additive-only migrations as policy
**Decision:** Ban destructive/rewriting SQLite migrations at policy level (additive-only:
`ALTER … ADD COLUMN IF NOT EXISTS`, `CREATE … IF NOT EXISTS`, as `ensureColumns()` already
does). The conditional cron redeploy (D2) is safe as-is.
**Why (receipts — zc's redeploy-data-loss worry, verified against the code):**
- `zmrng.db` lives in `ZMRNG_DATA_DIR` (`/var/lib/zmrng-workspace`), a SEPARATE dir from the
  git checkout (`/opt/zmrng-workspace`). `deploy-workspace.sh:78` `reset --hard origin/main`
  touches the CHECKOUT only — it physically cannot reach `/var/lib`. Script says so
  (`:96` "zmrng.db persists here across redeploys").
- Migrations are additive + idempotent (`ensureColumns()` = `ALTER … IF NOT EXISTS`,
  `db.ts:344`); reopening a populated db is a no-op.
- `systemctl restart` (`deploy-workspace.sh:190`) drops live `/ws/workspace` sockets for
  ~1s, but every message is persisted BEFORE fan-out and scrollback reloads over REST on
  reconnect (`GET /api/channels/:id/messages`); the auto-reconnect socket recovers with zero
  message loss. Presence rebuilds from the reconnect.
- Net: channels/messages/members untouched by a redeploy. Only cost = sub-second reconnect
  blip. A destructive migration is the ONLY thing that could lose VPS chats → ban it.
**Cost accepted:** Additive-only forbids column drops/renames without an explicit,
reviewed migration path. Acceptable — matches the existing `ensureColumns()` discipline.
**Rejected:** Trusting redeploy safety by convention only (no stated policy) — the one
failure mode that loses chats deserves an explicit rule.

### D3 — Local-app update UX: boot version-check banner + live "sitewide refresh" push
**Decision:** Two complementary signals to get teammates' local apps onto latest:
(a) **On boot**, the app compares its version to the advertised latest (D3b) and shows an
"Update available" banner → one-click reuses the existing `POST /api/restart` Reboot flow.
(b) **Live sitewide refresh** — when the VPS detects a new `origin/main` SHA, it broadcasts
a `new-version` frame over the `/ws/workspace` socket every connected app already holds;
each teammate sees "zc shipped an update — click to update" live, no reload.
**Why:** (a) is the safety net for an app that connects late; (b) is the "sitewide refresh"
feel zc asked for, and it's cheap — the multiplexed `/ws/workspace` socket already exists
(`broadcastRoom('workspace', …)`, `index.ts:98`).
**Cost accepted:** A new `new-version` variant on the `WsWorkspaceServerMsg` union
(`types.ts:559`) — must be mirrored into `packages/web/src/types.ts` (manual-mirror rule).
**Rejected:** Silent auto-update on push (kills in-flight local work — see D3a); banner-only
without the live push (loses the sitewide-refresh feel).

### D3a — Local update is BLOCKED-with-confirm while any local task is in a live phase
**Decision:** When the teammate clicks Update (banner or live push) while ANY local task is
in a live phase (`planning|executing|validating`), block it with a warning
("N tasks running — updating will interrupt them") and proceed only on an explicit
"Update anyway" second confirm.
**Why (THE fix for zc's worry — it lives on the LOCAL side, not the VPS):** Tasks/worktrees/
live `claude` runners exist ONLY on teammates' local machines (the VPS has zero tasks). The
Update flow (`selfUpdate` + `npm run build` + tsx respawn) KILLS the server process → kills
every live `claude` child mid-turn. A teammate mid-plan/execute loses that in-flight session
(uncommitted worktree files remain on disk, but the runner turn dies). Block-with-confirm
puts the human judgment call exactly where the data-loss risk is.
**Cost accepted:** A teammate who wants to force an update through live work needs one extra
click.
**Rejected:** Silent-proceed (that IS the data loss); silent-refuse (teammate may legitimately
want to force it, e.g. a stuck task).

### D3b — Version compare is a git SHA over the workspace socket + `GET /api/config`
**Decision:** The VPS advertises the current `origin/main` SHA in `GET /api/config` (a new
field) and pushes it inside the D3 `new-version` frame. The local app compares it to its own
`git rev-parse HEAD` and shows the banner/toast when they differ.
**Why:** Reuses the multiplexed `/ws/workspace` socket (no polling) + the existing config
endpoint. SHA compare needs no version-string bookkeeping. `git rev-parse` is already shelled
in-repo (`worktree.ts:47`).
**Cost accepted:** The local app must run `git rev-parse HEAD` on its own checkout — fine in
dev-server mode (a git checkout); the shipped `.app` update path is deferred with the rest of
Mac packaging (`layman-onboarding-grill.md`).
**Rejected:** A hand-maintained semver/version string (bookkeeping + drift); HTTP polling for
the version (the socket already exists).

## Build sequence (implementation, pending a separate go-ahead)

### VPS side (D2/D2a)
1. Branch from `origin/main`: `feat/zc/vps-autoupdate-cron`.
2. Add a small poll script (e.g. `scripts/autoupdate-workspace.sh`): `git -C $INSTALL_DIR
   fetch --quiet origin $BRANCH`; if `rev-parse HEAD` != `rev-parse origin/$BRANCH` →
   run `deploy-workspace.sh`; else exit 0 silently.
3. Document a systemd timer (or crontab) example in `docs/team-workspace-deploy.md` (§5
   Update) — every N min, print-only failures to the journal.
4. Add an explicit "Migrations are additive-only" policy note beside `ensureColumns()`
   (`db.ts`) and in `CLAUDE.md` conventions (D2a).

### Local app side (D3/D3a/D3b)
5. Server: add `latestSha` (or `headSha` + advertised `origin/main` SHA) to `GET /api/config`
   payload (`index.ts` config route) and a `new-version` variant to `WsWorkspaceServerMsg`
   (`types.ts:559`) — **mirror into `packages/web/src/types.ts`** (manual-mirror rule).
6. Server: on the VPS's own new-SHA detection, `broadcastRoom('workspace', {type:'new-version',
   sha})`. (The VPS is the SHA authority; local apps consume.)
7. Web: on boot fetch `/api/config`, compare advertised SHA to local `git rev-parse HEAD`
   (needs a tiny local endpoint or a startup read — decide at build time) → banner.
8. Web: subscribe the existing `/ws/workspace` handler to `new-version` → live toast.
9. Web: the Update action checks local task phases; if any ∈ {planning,executing,validating}
   → block-with-confirm dialog before calling `POST /api/restart` (D3a).
10. Tests: cover the SHA-compare helper + the block-with-confirm phase gate (pure logic);
    pin the new `WsWorkspaceServerMsg` variant.
11. Validate: `npm run typecheck && npm run lint && npm test && npm run build`.
12. PR (never merge self — dogfooding the harness).

## Out of scope (zc, 2026-08-30)
- **Model B/C remote-worker broker** (D1) — rejected, not deferred-with-intent.
- **Shipped `.app` update path** — deferred with all Mac packaging; the update flow targets
  the dev-server run mode both Windows partners use today.
- **Shared task visibility across teammates** — a future `/ws/workspace` broadcast, noted in
  D1, not built here.
