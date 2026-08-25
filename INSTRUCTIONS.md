# zmrng — New Developer Setup (Windows)

This zip contains the `zmrng` repo at commit `aa1de24` (branch `main`), tracked
files only. No `node_modules/`, no `.env`, no `config/repos.json` /
`config/agents.json`, no `zmrng.db`, no `worktrees/` — you'll generate/fill
those locally. See `README.md` for what the app does; this file is just the
"get it running" checklist.

## 1. Prerequisites (install these first)

| Tool | Why | Notes |
|------|-----|-------|
| **Node.js 22** | pinned by `.nvmrc` | Use [nvm-windows](https://github.com/coreybutler/nvm-windows) — `nvm install 22 && nvm use 22`. Do not use a newer Node major; `better-sqlite3` ships a native binding compiled per Node major and will fail at startup on a mismatch. |
| **Git** | clone/branch/PR workflow | Get it from git-scm.com if not already installed. |
| **Git Bash** | running the dev scripts | Comes bundled with Git for Windows. `npm run dev` at the repo root uses POSIX shell syntax (`&`, `wait`) that **does not work in PowerShell or cmd.exe** — run it from Git Bash, or see the two-terminal alternative in step 4. |
| **Python 3** + **Visual Studio Build Tools (C++ workload)** | native module compilation | `better-sqlite3` and `node-pty` are native Node addons. `npm install` will try to compile them from source on Windows unless prebuilt binaries are available for your Node/arch. Install "Desktop development with C++" via the [Visual Studio Build Tools installer](https://visualstudio.microsoft.com/visual-cpp-build-tools/), plus Python 3, *before* running `npm install`. If `npm install` fails on `node-pty` or `better-sqlite3`, this is almost always why. |
| **GitHub CLI (`gh`)** | zmrng opens PRs by shelling out to `gh pr create` | Install from cli.github.com, then run `gh auth login` and make sure the account has **push + PR creation rights** on whatever repos you'll point zmrng at. Without this, the app still runs but PR creation will fail. |
| **Claude Code CLI (`claude`)** | zmrng spawns `claude` as a subprocess to actually do the work | Install per Anthropic's docs, then log in with your **Claude Max subscription** (`claude` first-run login flow — do NOT set `ANTHROPIC_API_KEY` anywhere in your shell/profile; zmrng strips it from worker processes on purpose so it uses your Max login instead of the metered API). Confirm you're logged in before starting zmrng. |

## 2. Install

```bash
# from Git Bash, inside the unzipped repo folder
nvm use
npm install
```

If `npm install` fails compiling `better-sqlite3` or `node-pty`, it's the
Build Tools/Python prerequisite above — install those and re-run.

## 3. Configure

Nothing below is required to boot the app — every setting has a default —
but you'll want at least the repo registry filled in.

```bash
cp .env.example .env                       # optional, defaults are sane
cp config/repos.example.json config/repos.json
```

Edit `config/repos.json` — one entry per repo you want zmrng to be able to
operate on:

```json
[
  { "id": "my-repo", "label": "My Repo", "path": "C:/Projects/my-repo", "defaultBranch": "main" }
]
```

If you skip this file, zmrng still works — it auto-discovers any git repo
directly under `ZMRNG_PROJECTS_DIR` (defaults to a few common paths, see
`.env.example`) plus a "self" entry for zmrng itself.

`config/agents.json` (copy from `config/agents.example.json`) is **optional**
— only needed if you're wiring in a custom OpenAI-compatible agent endpoint.
Skip it for normal use.

## 4. Run

Preferred (Git Bash):

```bash
npm run dev
```

This starts the Fastify server on port 4500 and the Vite dev server on port
5174 together.

If you're not using Git Bash (e.g. plain PowerShell), the combined script
will fail — run the two halves in separate terminals instead:

```powershell
npm run dev:server   # terminal 1
npm run dev:web      # terminal 2
```

Open **http://localhost:5174**.

## 5. Verify the setup

With the server running, check:

```
http://localhost:4500/api/preflight
```

This reports whether `claude` and `gh` are detected/authenticated on your
machine. It's advisory (the app boots either way), but if either shows as
missing, PR creation or task execution won't work until you fix that tool's
setup from step 1.

## 6. Common errors

- **`NODE_MODULE_VERSION … ERR_DLOPEN_FAILED`** — you're running the server
  on a different Node major than the one `npm install` ran under. Fix:
  `nvm use && npm rebuild better-sqlite3`.
- **`npm run dev` does nothing / errors immediately in PowerShell** — see
  step 4, use Git Bash or the two-terminal split.
- **PR creation fails** — `gh auth status` (run it directly) to confirm
  you're logged in with an account that has push/PR rights on the target repo.
- **Tasks silently bill money you didn't expect / worker acts weird about
  auth** — make sure `ANTHROPIC_API_KEY` is not set in your environment.
  zmrng strips it for OAuth mode, but if worker behavior looks wrong, check
  `echo $ANTHROPIC_API_KEY` is empty.

## Not included in this handoff

The desktop (Tauri) build under `packages/desktop` is out of scope for this
handoff — only the web app + server. Ignore that package for now.
