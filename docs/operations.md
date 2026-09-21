# Run and maintain Studyroom

Open http://localhost:3210. The app binds only to the loopback interface.

## Startup

`npm run install-startup` sets the app to start when you sign in and restart after a crash. On macOS it installs `~/Library/LaunchAgents/local.studyroom.app.plist`, a per-user LaunchAgent; if the app does not appear after installing, approve it under System Settings, General, Login Items. On Windows it writes a hidden launcher into your Startup folder. Elsewhere, run `npm start` in this folder, or wire it into your login services. The app is available after you sign in, including after a reboot. It cannot run while the computer is asleep or powered off.

Do not move this project without rerunning the install command; both launchers contain absolute paths. Logs are in `data/logs`. To stop autostart on macOS, run `launchctl bootout gui/$(id -u)/local.studyroom.app`; on Windows, delete `studyroom.vbs` from your Startup folder. Reinstall with the command above.

Development: `npm run build`, `npm test`. Build creates the production browser bundle. Restart the service after server changes (on macOS: `launchctl kickstart -k gui/$(id -u)/local.studyroom.app`), after active jobs finish. Do not run a second server on port 3210 while the LaunchAgent is running. For isolated testing, use a separate `STUDYROOM_DATA` folder and `PORT`.

## Updates

Studyroom checks its GitHub `main` branch when the app opens. When a newer commit exists, the home page shows an update notice; choosing Update fetches and fast-forwards this checkout, reinstalls dependencies only if they changed, builds the new bundle, and restarts the server, after which the page reloads. Progress lands in `data/update.json` and `data/logs/update.log`.

The updater refuses to run when tracked files have local changes or local commits, so your copy is never overwritten silently. To update by hand instead:

```sh
git pull --ff-only
npm install
npm run build
```

On macOS the app restarts through the LaunchAgent when one is installed; otherwise it stops the current process and starts a new one on the same port. The `data` folder is never touched. Automatic updates need Git and network access; studying itself still works offline.

## Files and backups

`data` contains everything personal. Original files are in `data/uploads`. Normalized/cropped visuals are in `data/assets`. Job receipts are in `data/jobs`. Daily SQLite snapshots are in `data/backups`. The app never automatically deletes these backups.

The Settings export downloads records as JSON, including source metadata. It does not package original material files. To move or fully back up the app, stop the server and copy the whole project data folder, including the database and any WAL files. Use Time Machine or another external backup for protection against disk loss. Local backups alone do not protect against a failed disk.

For database recovery: stop the service, preserve a copy of the current data folder, replace `studyroom.sqlite` with a chosen backup, and move the old `studyroom.sqlite-wal` and `studyroom.sqlite-shm` aside before restarting. Backups reference original files still in uploads/assets. The app has no destructive reset button.

## Upload tooling

Optional tools, installed with your system's package manager:

- Homebrew (macOS): `brew install poppler`, `brew install --cask libreoffice`, then `python3 -m venv .venv && .venv/bin/pip install PyMuPDF`.
- winget or Chocolatey (Windows): `winget install poppler` or `choco install poppler`, `winget install TheDocumentFoundation.LibreOffice`, then `python -m venv .venv && .venv\Scripts\pip install PyMuPDF`.
- apt (Linux/WSL): `sudo apt install poppler-utils libreoffice python3-venv`, then `python3 -m venv .venv && .venv/bin/pip install PyMuPDF`.

Scanned pages and image-only files need OCR: macOS uses the bundled Apple Vision helper (`scripts/ocr`, compiled on demand from `scripts/ocr.swift`); other systems use the `tesseract` CLI if it is on the PATH.

## Extraction

PDF text uses Poppler. Scanned PDF pages and image uploads use the compiled Apple Vision helper `scripts/ocr`. Recompile with `swiftc scripts/ocr.swift -o scripts/ocr` if needed. DOCX text uses Mammoth; PPTX text and speaker notes use a project Python script. LibreOffice renders DOCX and PPTX pages to preserve charts and drawn shapes, with embedded-image extraction as a fallback. Poppler renders PDF visuals. Project `.venv` contains PyMuPDF to select pages containing images or vector diagrams and skip plain text pages. Image-only sources can be interpreted using visual citations.

Uploads have no per-set file-count limit. Each file is limited to 100 MB. The browser processes files individually and the agent reads bounded batches. Very large bundles take longer and use more Codex quota. Failed files remain visible and block generation until removed or replaced.

## Agent jobs

The app runs AI tasks through the harness selected in Settings, Advanced (AI). Codex is the default; OpenCode is the alternative. Jobs use the existing account, read-only sandboxes and structured JSON responses. The HTTP server imports results. Normal studying needs no network.

Study sets publish the first usable draft. Optional focus and count notes guide the agent; they do not trigger requirement audits, count reconciliation or mandatory review calls. Quality review is available afterward. Exams first inventory the material, plan a matching exam structure, then create original questions with a separate answer key. Retrieval packets inventory and group terms into a printable worksheet. Their skills are `.agents/skills/create-practice-exam/SKILL.md` and `.agents/skills/create-retrieval-packet/SKILL.md`. Print / Save PDF opens a Letter-size print view. For packets, use double-sided printing, flip on the long edge, and disable browser headers and footers.

Install and sign-in happen in the app. Codex installs with npm and signs in through ChatGPT. OpenCode connects with its supported account credentials. Keep authentication files private. Live model and reasoning options come from the selected installed CLI and are saved per harness.

Calls retry transient failures automatically and preserve completed responses even if the CLI exits with a shutdown error. A four-minute inactivity timer resets whenever output arrives; OpenCode has a longer window. Restart resumes queued and interrupted jobs from checkpoints. Cancel terminates child processes and prevents publication. If authentication expires or quota is exhausted, the exact error stays visible. Completed set batches remain usable with explicit coverage notes when other batches stop. Retry uses saved checkpoints and can import older source-matched drafts. Review findings are visible notes on a saved set and do not require a creation retry.

Printable documents archive and restore from Settings just like sets. JSON exports and SQLite backups include their full content, answer keys, source IDs and generation receipts. Their print view is generated from saved content, so printing needs no model call or network.
