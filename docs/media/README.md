# Demo media

Assets for the README's "▶️ 2-minute demo". Drop the files here with the exact
names below and the README picks them up with no further edits — the embed block
in the top-level `README.md` is already wired for them (see the `DEMO EMBED`
comment there). The shot-by-shot recording script is [`../demo-script.md`](../demo-script.md).

Pick **one** of the three embed options (listed best-first in the README comment):

## Option A — GitHub-native inline video (recommended)

No file committed to the repo. Record a short screen capture (`.mp4` or `.mov`),
open `README.md` on github.com, click the ✏️ edit button, and **drag the video
onto the `DROP VIDEO HERE` line**. GitHub uploads it to its own CDN
(`user-images.githubusercontent.com`) and inserts an inline player. Keep the file
under GitHub's **10 MB** attachment limit (trim/compress if needed).

## Option B — hosted link (Loom, YouTube, …) with a clickable poster

Commit a poster frame as `demo-thumb.png`, then paste the video URL into the
README's Option-B line. Spec for the poster:

- **`demo-thumb.png`** — 1280×720 (16:9), < 300 KB. A clean frame of the app mid-run
  with a ▶ overlay reads best. Grab a frame from the recording:
  ```bash
  ffmpeg -ss 00:00:03 -i demo.mov -frames:v 1 demo-thumb.png
  ```

## Option C — self-contained animated GIF

Commit `demo.gif` (no external host needed; always works offline/in forks):

- **`demo.gif`** — ≤ 1280 px wide, target < 8 MB (GitHub renders GIFs up to 10 MB).
  Convert from the recording with a two-pass palette for clean colors:
  ```bash
  ffmpeg -i demo.mov -vf "fps=12,scale=1200:-1:flags=lanczos,palettegen" palette.png
  ffmpeg -i demo.mov -i palette.png -lavfi "fps=12,scale=1200:-1:flags=lanczos,paletteuse" demo.gif
  ```
  Speed-ramp the long autonomous waits in your editor before converting — the
  `demo-script.md` calls out which beats to cut.

---

Committed demo assets are tracked in git (they are part of the README), so keep
them lean — this is the one place in the repo where binary blobs are expected.
