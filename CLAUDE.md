# CLAUDE.md — instructions for Claude Code

This file tells Claude how to set up and run this project on **macOS, Windows or Linux**.
If the user says anything like "set this up", "do a full setup", "make it work", "run it": follow
**Full setup** below from top to bottom, then **Run**, then report what works.

## What this project is

Human-like Google search automation. Two processes work together:

| Process | Language | Port | Start command (from `search-automation/`) | Job |
|---|---|---|---|---|
| Path server | Python (Flask + PyTorch) | 3000 | `npm run path-server` | Loads the trained model in `search-automation/model/*.pt` and returns human-like mouse paths |
| Capture UI + job worker | Node/TypeScript | 4000 | `npm run ui` | Web UI, launches Chrome/Brave via Puppeteer, types queries, saves pages to `search-automation/ui/captures/` |

Both must run at the same time (two terminals, or the path server in the background).
The trained model is committed in git (`search-automation/model/`), so **no training is needed**.

## Full setup

Run every command from the **repo root** unless stated. Detect the OS first (`process.platform` / `uname` / `$env:OS`).

1. **Prerequisites.** Check, and if missing tell the user how to install (do not silently install system software):
   - Node.js **22.13+** (`node -v`). Needed for the built-in `node:sqlite`. LTS 24 is ideal.
   - Python **3.10–3.13** (`python3 --version`; on Windows `py -3 --version`).
   - Google Chrome and/or Brave. At least one is required. A browser that is not installed is simply disabled in the UI.
2. **Python venv at the repo root (`.venv`)**, then install the path-server dependencies:
   - macOS / Linux:
     ```bash
     python3 -m venv .venv
     .venv/bin/pip install -r search-automation/server/requirements.txt
     ```
   - Windows (PowerShell or cmd):
     ```powershell
     py -3 -m venv .venv
     .venv\Scripts\pip install -r search-automation\server\requirements.txt
     ```
   - Linux without an NVIDIA GPU: install CPU torch first to avoid a ~2 GB CUDA download:
     `.venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu`
3. **Node packages:** `cd search-automation && npm install`
   (Puppeteer also downloads its own Chromium; that's only used by `examples/google-search.ts` and `local-demo.ts`.)
4. **Verify:** `cd search-automation && npm run doctor`. Every line must be `OK` (a `WARN` about the path server not running is expected before step Run). Fix each `FAIL` using the printed `fix:` line, then re-run until it passes.

## Run

From `search-automation/`:

```bash
npm run path-server     # terminal 1 (or run in background) -> http://localhost:3000
npm run ui              # terminal 2                          -> http://localhost:4000
```

Check: `curl "http://localhost:3000/generate_path?start_point=0,0&end_point=100,100"` returns JSON, and
`curl http://localhost:4000/api/browsers` lists each browser with `installed: true/false`.
Then tell the user to open http://localhost:4000, paste queries (one per line, optional numeric tag in front,
e.g. `9898  Massage Chair`), pick browser / mode / device, and click Run. Saved pages: http://localhost:4000/source.

Quick smoke test without Google: `npm test local-demo.ts` (opens a local page and shows the mouse + typing).

## Cross-OS behaviour (already handled in code — know it, don't re-implement it)

- `search-automation/browsers.ts` is the single place for OS-specific logic:
  - **Executable detection:** macOS `/Applications/*.app`, Windows `Program Files`, `Program Files (x86)`, `%LOCALAPPDATA%`,
    Linux `/opt/...`, `/usr/bin/...` and `which google-chrome|brave-browser`.
  - **Profile ("User Data") folder:** macOS `~/Library/Application Support/...`, Windows `%LOCALAPPDATA%\...\User Data`, Linux `~/.config/...`.
  - **Profile copy for logged-in mode:** pure Node file copy (no `cp`/`rsync`), skips caches, and skips files locked by a running browser.
- The UI disables a browser option when it isn't found; `/api/run` rejects it too. The server prints what it found at startup.
- Linux: no `DISPLAY`/`WAYLAND_DISPLAY` means runs are forced headless; running as root adds `--no-sandbox`.

### Environment overrides (only when auto-detection fails)

| Variable | Meaning |
|---|---|
| `CHROME_PATH`, `BRAVE_PATH` | Browser executable |
| `CHROME_PROFILE_DIR`, `BRAVE_PROFILE_DIR` | The browser's "User Data" folder (contains `Local State`) |
| `CHROME_PROFILE_COPY`, `BRAVE_PROFILE_COPY` (`PROFILE_COPY` = Brave, legacy) | Where the profile copy is kept (default: OS temp dir) |
| `UI_PORT` | UI port (default 4000) |
| `UI_HOST` | Address the UI listens on: `127.0.0.1` (default, this machine only) or `0.0.0.0` (whole network: the UI has no login, avoid on shared servers) |
| `PATH_SERVER_PORT` | Path server port (default 3000). Set the **same value** for `npm run path-server` and `npm run ui` |
| `PATH_SERVER_HOST` | Address the path server listens on (default `127.0.0.1`) |

Setting env vars: macOS/Linux `CHROME_PATH="/path" npm run ui`; PowerShell `$env:CHROME_PATH="C:\...\chrome.exe"; npm run ui`; cmd `set CHROME_PATH=C:\...\chrome.exe && npm run ui`.

## Running on a Linux server (stage)

- Install next to other apps in its own folder, e.g. `~/public_html/google-search-automation`. Never inside another app's folder.
- Check free ports first: `ss -ltnp | grep -E ':3000|:4000'`. If 3000 is taken (Next.js apps use it), pick e.g. `PATH_SERVER_PORT=3100` and use it for **both** servers.
- No display on a server: runs are always headless. Only **Incognito** mode makes sense, because there's no logged-in browser profile on the server.
- Install Node packages with `PUPPETEER_SKIP_DOWNLOAD=true npm install`: the UI uses the server's installed Chrome, so Puppeteer's own ~170 MB Chrome (only used by two demo scripts) isn't needed.
- On the IndiaMART stage server, `test-im` uses the same system Chrome (Playwright `channel: "chrome"`); its Playwright Chromium in `~/.cache/ms-playwright/` can serve as a fallback via `CHROME_PATH`. Never download another browser there.
- Browser: system Chrome (`google-chrome`) if installed; otherwise `npx puppeteer browsers install chrome` and set `CHROME_PATH` to the printed path. That Chrome needs system libraries (nss, atk, gtk3, …). If it fails to start, an admin must install them.
- If the server's Node is older than 22.13, don't upgrade it (other apps depend on it). Unpack a private Node 22 into `<repo>/.node/` (git-ignored); `search-automation/ecosystem.config.js` uses it automatically.
- Start / restart with pm2: `cd search-automation && pm2 start ecosystem.config.js` (defaults: path server 3100, UI 4100), then `pm2 save`. On a shared pm2, only touch `gsa-path-server` / `gsa-ui`. Never run `pm2 restart all`, `pm2 kill` or `pm2 update`.
- Keep both servers running with `pm2` (or `nohup`). Both listen on `127.0.0.1` only; open the UI from a laptop through an SSH tunnel: `ssh -L 4000:127.0.0.1:4000 <user>@<server>`, then http://localhost:4000.
- Saved pages (`ui/captures/`) and databases (`ui/data/`) are not in git. Copy them over separately (`rsync`) if the server should show existing data.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Job error `Path server on :3000 is not running` | Start `npm run path-server`; check `npm run doctor`. |
| Browser option greyed out in UI | Not detected. Install it or set `CHROME_PATH` / `BRAVE_PATH`, restart `npm run ui`. |
| Windows: note "is open, so its cookies/logins could not be copied" | Chrome/Brave locks its cookie DB while running. Close the browser fully (also from the system tray) and run again. Incognito mode is unaffected. |
| macOS: "macOS blocked access to … profile folder" | Give the terminal app Full Disk Access (System Settings → Privacy & Security), restart it. |
| Logged-in mode shows only "Default" profile | Profile folder not found or unreadable; open the browser once, or set `*_PROFILE_DIR`. |
| `No model files found` from the path server | `search-automation/model/*.pt` missing: `git pull`, or train (README → Training). |
| `node:sqlite` / `DatabaseSync` errors | Node is older than 22.13; upgrade. |
| Many CAPTCHAs | Expected on some IPs. Prefer logged-in mode, fewer queries per hour. Not a setup bug. |

## Repo map

- `search-automation/index.ts` — Humanizer library (mouse paths via the path server, human typing).
- `search-automation/browsers.ts` — cross-OS browser + profile detection and copying.
- `search-automation/ui/server.ts` — UI + job queue; `ui/db.ts` + `ui/extract.ts` — SQLite ads extraction.
- `search-automation/server/server.py` — path server; `search-automation/model/` — trained model used at runtime.
- `search-automation/scripts/` — `path-server.js` (cross-OS launcher), `doctor.ts` (setup check).
- `model/` — training scripts (only for training a new model). `ui/` (root) — Next.js app for recording training data; not needed to run.

## Rules for Claude working in this repo

- Never modify the user's real browser profile; logged-in mode must always work on a copy.
- Keep OS-specific code in `browsers.ts`; use `path.join` and Node `fs`, never shell commands like `cp`, `rsync`, `rm`.
- Don't commit `ui/captures/`, `ui/data/`, `.venv/`, `node_modules/`, or any `*.env` credentials file.
