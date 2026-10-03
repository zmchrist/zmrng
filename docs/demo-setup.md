# Recording a clean demo

Your everyday zmrng instance holds real data — task history, Knowledge Base
pages, Team chat, and a file tree of your actual projects. A screen recording of
it would put all of that on camera. You do **not** need a second install or a
separate build to avoid that: zmrng is entirely data-dir-driven, so a throwaway
**demo profile** gives you a pristine instance from the same binary.

## One command

```bash
scripts/demo.sh
```

It launches `npm run dev` against:

- an empty **`~/zmrng-demo-data`** (`ZMRNG_DATA_DIR`) — a fresh SQLite db, so the
  task list, KB, and Team history are all empty, and
- **`~/zmrng-demo-projects`** (`ZMRNG_PROJECTS_DIR`) — the only folder scanned for
  the repo dropdown and shown in the Files tree/Viewer.

Record `http://localhost:5174`. Override either location:

```bash
ZMRNG_DEMO_DATA_DIR=/tmp/zmrng-demo ZMRNG_DEMO_PROJECTS_DIR=~/demos scripts/demo.sh
# optionally pin the default target:
ZMRNG_DEFAULT_REPO=demo-app scripts/demo.sh
```

## Before you hit record

1. **Put one small, pushable repo** under the demo projects dir — the autonomous
   run ends by opening a real PR, so the target needs push rights and `gh` auth:
   ```bash
   git clone <your-demo-repo> ~/zmrng-demo-projects/demo-app
   ```
   Something small and legible reads far better on screen than a big monorepo.
2. **Target the demo repo, not the `zmrng` self-entry** — driving `zmrng` itself
   would put this codebase on camera.
3. **Record in dev, not the installed `.app`.** The bundled app reads your real
   `~/Library/Application Support/zmrng` data; `scripts/demo.sh` (dev mode) does
   not.
4. **Skip the Terminal card on camera** (or `cd` somewhere neutral first) — a PTY
   would reveal your home-dir paths. The [shot list](demo-script.md) centers on
   the task pipeline, so you can leave it closed.
5. **Team tab** is already empty in a fresh build (the workspace URL is unset);
   the script warns you if a `VITE_WORKSPACE_URL` in `.env` would override that.

## After recording

Fill the README's `DEMO EMBED` block — see [`media/README.md`](media/README.md)
for the asset specs and `ffmpeg` commands.

## Tear down

The demo profile is disposable. To reset it to a blank slate, just remove the
data dir (the demo repos and your real data are untouched):

```bash
rm -rf ~/zmrng-demo-data
```
