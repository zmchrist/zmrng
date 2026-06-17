# Plan: zmrng — autonomous task orchestrator GUI

> **Status:** Planned · **Type:** New standalone tool · **Complexity:** High
> **Target repo built at:** `~/Documents/Projects/zmrng` (standalone; NOT inside Pheme)
> **This tool drives:** the Pheme repo at `~/Documents/Projects/pheme` (v1 hardcoded)
> **Plan home:** stored in Pheme `.agents/plans/` for paper-trail continuity.

## Problem

Operator runs ~5 Claude Code terminals in parallel, manually clicking "yes" on
permission prompts and switching focus between them. High babysitting cost, no
shared view of what each agent is doing, no task backlog.

## User story

```
As the sole operator of Pheme
I want a single GUI where I drop in a task, answer a few clarifying questions,
  then watch the agent plan → implement → validate → open a PR fully autonomously
So that I stop babysitting 5 terminals and only review the final PR.
```

## Decisions (locked in workshop 2026-06-17)

| Decision | Choice |
|---|---|
| Target | **Pheme-only first** (hardcode repo path + its `.agents/` harness; generalize later) |
| Location | **Standalone repo** `~/Documents/Projects/zmrng` |
| Autonomy | **Full auto to PR** — after the operator answers clarifying questions, no further stops until the PR is open |
| UI | **List + detail pane** (not kanban) |
| Aesthetic | Deep gray, ~50% translucent brushed/frosted glass (`backdrop-filter` blur), simple/modern/clean, slightly rounded corners (nothing sharp), smooth transitions |
| Name | **zmrng** |

## Engine: the `claude` headless CLI contract (verified via `claude --help`)

zmrng's backend orchestrates the `claude` binary (uses the operator's **Max OAuth** —
no `ANTHROPIC_API_KEY` in env, or it silently bills API). Verified flags:

- `-p, --print` — non-interactive run.
- `--output-format stream-json` — emits JSONL events (system `init` w/ `session_id`,
  assistant messages, final `result`). Requires `--verbose`.
- `--input-format stream-json` — **realtime streaming stdin**. Lets one long-lived
  process accept follow-up user messages as JSON lines. This is how the clarify
  Q&A loop stays in a single session with native context (no resume juggling).
- `--include-partial-messages` — token-delta streaming for live log UX.
- `--dangerously-skip-permissions` (or `--permission-mode bypassPermissions`) — no
  prompts. Safe here: target repo (Pheme) keeps its own `security_guard.py` hook that
  still blocks `.env`, force-push, `rm -rf`.
- `-r, --resume [sessionId]` / `--fork-session` — resume a session by id.
- `--model opus|sonnet` — model selection per task.
- `--append-system-prompt <text>` — inject zmrng's phase instructions.
- `--add-dir <dir>` — grant access to the worktree path.

**Architecture consequence:** one persistent
`claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --dangerously-skip-permissions`
child process per active task. zmrng writes user turns to its stdin, parses events
from stdout, forwards them to the browser over WebSocket.

## Tech stack (mirror Pheme's versions for familiarity)

- **Backend:** Fastify `^5.3`, `@fastify/websocket` `^11`, `better-sqlite3` `^12`,
  `pino` `^9`, Node `child_process` for the claude subprocess. TypeScript `~6.0`, tsx for dev.
- **Frontend:** React `^19`, Vite `^8`, CSS Modules + design tokens (frosted-glass theme).
- **Persistence:** single SQLite file `zmrng.db` (WAL). No cloud.
- **Validation:** `npm run typecheck && npm run lint && npm run build` (Pheme convention; no test framework).

## Repo structure

```
zmrng/
├── package.json                 # npm workspaces: server, web
├── tsconfig.base.json
├── .gitignore                   # node_modules, dist, *.db, worktrees/
├── README.md                    # run instructions + safety notes
├── .env.example                 # ZMRNG_TARGET_REPO, ZMRNG_PORT, ZMRNG_MODEL
├── plans/zmrng-v1-plan.md       # copy of this plan (standalone paper trail)
├── worktrees/                   # git worktrees per task (gitignored)
└── packages/
    ├── server/
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts         # Fastify bootstrap, REST + WS, static serve
    │       ├── config.ts        # env: target repo path, port, model
    │       ├── db.ts            # SQLite schema + prepared statements
    │       ├── types.ts        # Task, Phase, WsEvent, ClaudeEvent
    │       ├── runner.ts       # spawn/manage claude child process per task
    │       ├── phases.ts       # phase state machine + system prompts
    │       ├── worktree.ts     # git worktree create/remove helpers
    │       └── ws.ts           # WS hub: broadcast task + claude events
    └── web/
        ├── package.json
        ├── index.html
        ├── vite.config.ts       # proxy /api + /ws → server
        ├── tsconfig.json
        └── src/
            ├── main.tsx
            ├── App.tsx          # layout: TaskList | TaskDetail
            ├── theme.css        # frosted-glass design tokens
            ├── api.ts           # REST client
            ├── useWs.ts         # auto-reconnect WS hook (port Pheme's pattern)
            ├── types.ts
            └── components/
                ├── TaskList.tsx / .module.css      # left rail, status pills
                ├── NewTaskForm.tsx / .module.css   # title + body input
                ├── TaskDetail.tsx / .module.css    # right pane container
                ├── ClarifyChat.tsx / .module.css   # Q&A during clarify phase
                └── WorkerLog.tsx / .module.css     # streamed claude output
```

## Phase state machine (per task)

```
backlog ─(operator clicks Start)─▶ clarify
clarify: persistent claude process asks questions; operator answers in ClarifyChat;
         loop until the model emits the sentinel "ZMRNG_READY".
clarify ─(READY)─▶ building   [no operator stop — full auto]
building: same session told to: branch from origin/main (feat/zmrng/<slug>),
          write plan to target .agents/plans/, implement, run validation
          (typecheck+lint+build), fix failures, commit, push, open PR via gh.
building ─(PR url detected)─▶ review
review:  PR link shown; operator reviews on GitHub. Manual.
review ─(operator marks done)─▶ done
any phase ─(error / process exit non-zero)─▶ failed (log retained, restartable)
```

### Phase prompts (in `phases.ts`)

- **System prompt (all phases, via `--append-system-prompt`):** identify as a zmrng
  worker on the Pheme repo; obey Pheme's CLAUDE.md + `.claude/rules/`; never touch `main`
  directly; branch from `origin/main`; end the clarify phase with the exact token
  `ZMRNG_READY` on its own line when scoped.
- **Clarify kickoff:** "Task: <body>. Before any code, ask the operator clarifying
  questions needed to scope this. Ask in small batches. When you have enough to plan
  and implement autonomously, reply with `ZMRNG_READY` and a one-paragraph summary."
- **Build kickoff (auto-sent on READY):** "Proceed fully autonomously: create branch
  `feat/zmrng/<slug>` from `origin/main`, write a plan to `.agents/plans/`, implement,
  run `npm run typecheck && npm run lint && npm run build`, fix all failures, commit
  with a descriptive message, push, and open a PR with `gh pr create`. Report the PR URL."

## SQLite schema (`db.ts`)

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,            -- uuid
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,          -- backlog|clarify|building|review|done|failed
  session_id TEXT,               -- claude session id
  branch TEXT,
  worktree TEXT,
  pr_url TEXT,
  model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE events (            -- append-only log per task (for replay)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,            -- claude|status|operator|error
  payload TEXT NOT NULL          -- JSON
);
```

## REST + WS surface (`index.ts` / `ws.ts`)

- `GET  /api/tasks` — list tasks.
- `POST /api/tasks` — create `{title, body}` → backlog.
- `POST /api/tasks/:id/start` — backlog → spawn clarify process.
- `POST /api/tasks/:id/message` — operator answer → write to claude stdin.
- `POST /api/tasks/:id/done` — review → done.
- `POST /api/tasks/:id/cancel` — kill process, mark failed.
- `GET  /api/tasks/:id/events` — replay log.
- `WS /ws` — server→client: `{type:'task', task}`, `{type:'event', taskId, event}`.

## Implementation steps (execution order)

1. **Scaffold repo** — dirs, root `package.json` (workspaces), `tsconfig.base.json`,
   `.gitignore`, `.env.example`, `README.md`. `git init`.
2. **Shared types** (`server/src/types.ts`, mirror into `web/src/types.ts`).
3. **db.ts** — SQLite open (WAL), schema, prepared statements (insert/update/list/log).
4. **config.ts** — env parsing with defaults (`ZMRNG_TARGET_REPO=~/Documents/Projects/pheme`).
5. **worktree.ts** — `git worktree add worktrees/<id> origin/main`; remove on cleanup.
6. **runner.ts** — spawn claude child, parse stream-json stdout (line buffer), detect
   `session_id`, assistant text, `ZMRNG_READY`, PR URL regex; expose `send(msg)` / `kill()`.
7. **phases.ts** — state machine wiring runner events → db status transitions → auto-send
   build kickoff on READY.
8. **ws.ts + index.ts** — Fastify bootstrap, REST routes, WS hub, serve built web in prod.
9. **Frontend theme.css** — frosted-glass tokens (deep gray, translucency, blur, radii, transitions).
10. **useWs.ts + api.ts** — data layer (port Pheme's auto-reconnect WS hook).
11. **Components** — TaskList, NewTaskForm, TaskDetail, ClarifyChat, WorkerLog.
12. **App.tsx + main.tsx** — layout + routing of selected task.
13. **vite.config.ts** — dev proxy `/api` + `/ws` → `localhost:<port>`.
14. **Validate** — `npm run typecheck && npm run lint && npm run build` green.
15. **Smoke test** — `npm run dev`; create a trivial task ("add a code comment to
    README"), answer clarify, confirm it branches + opens a PR on Pheme.

## Design tokens (frosted glass — `theme.css`)

```css
--bg: #16181c;                /* deep gray page */
--surface: rgba(38,41,47,0.5);    /* 50% translucent panel */
--surface-strong: rgba(46,50,57,0.66);
--blur: 14px;                 /* backdrop-filter blur */
--border: rgba(255,255,255,0.08);
--text: #e6e8ea;  --text-dim: #9aa0a6;
--accent: #7aa2c4;            /* muted steel-blue, not sharp */
--radius: 14px;  --radius-sm: 10px;
--transition: 180ms cubic-bezier(.4,0,.2,1);
/* status pills: backlog gray · clarify amber · building blue · review violet · done green · failed red */
```

## Validation

```bash
npm run typecheck   # tsc --noEmit both workspaces
npm run lint        # eslint
npm run build       # tsc (server) + vite build (web)
npm run dev         # manual smoke: server + web
```

## Acceptance criteria

- [ ] `npm run dev` serves the GUI; tasks persist across restarts (SQLite).
- [ ] Creating a task → Start → a real `claude` process spawns against the Pheme repo.
- [ ] Clarify Q&A works: operator answers stream into the live session; `ZMRNG_READY`
      transitions the task to building with **no further operator interaction**.
- [ ] Building phase branches from `origin/main`, implements, validates, and opens a PR;
      PR URL surfaces in the UI and the task moves to review.
- [ ] Multiple tasks run concurrently (replaces the 5-terminal workflow).
- [ ] No permission prompts during autonomous phases; Pheme's security hook still active.
- [ ] UI matches the frosted-glass spec; smooth transitions; nothing sharp-cornered.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| **API billing leak** — `ANTHROPIC_API_KEY` in env makes claude bill API not Max | Runner strips `ANTHROPIC_API_KEY` from child env; README warns; surface auth mode in UI |
| **Max weekly cap** under many concurrent workers | Cap concurrent building tasks (config `ZMRNG_MAX_LANES`, default 2); queue the rest |
| stream-json parsing brittle across claude versions | Tolerant line parser; ignore unknown event types; log raw on parse fail |
| `ZMRNG_READY` sentinel missed / model chatty | Also accept a structured marker; allow manual "force build" button as fallback |
| Worktrees accumulate | Cleanup on task done/cancel; `worktrees/` gitignored |
| Runaway agent on `main` | System prompt forbids it; Pheme security hook blocks force-push; worktree isolation |
| ToS — OAuth only for Claude Code | zmrng runs the real `claude` binary (compliant); never extracts/proxies the token |

## Out of scope (v1)

Generic multi-repo targeting · kanban board · phase-boundary approval gates · auth ·
cost dashboard · mobile. All deferred; v1 proves the loop.

## Confidence

**One-pass success: ~7/10.** Scaffold, DB, REST/WS, and UI are routine and mirror Pheme
patterns. The integration risk concentrates in `runner.ts` (stream-json parsing + the
persistent stdin session) and the READY→build handoff — these will likely need one
iteration of live tweaking against the real `claude` binary during the smoke test.
```
