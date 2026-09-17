# Run and maintain Studyroom

Open http://localhost:3210. The app binds only to the loopback interface.

## Startup

`npm run install-startup` sets the app to start when you sign in and restart after a crash. On macOS it installs `~/Library/LaunchAgents/local.studyroom.app.plist`, a per-user LaunchAgent; if the app does not appear after installing, approve it under System Settings, General, Login Items. On Windows it writes a hidden launcher into your Startup folder. Elsewhere, run `npm start` in this folder, or wire it into your login services. The app is available after you sign in, including after a reboot. It cannot run while the computer is asleep or powered off.

Do not move this project without rerunning the install command; both launchers contain absolute paths. Logs are in `data/logs`. To stop autostart on macOS, run `launchctl bootout gui/$(id -u)/local.studyroom.app`; on Windows, delete `studyroom.vbs` from your Startup folder. Reinstall with the command above.

Development: `npm run build`, `npm test`. Build creates the production browser bundle. Restart the service after server changes (on macOS: `launchctl kickstart -k gui/$(id -u)/local.studyroom.app`), after active jobs finish. Do not run a second server on port 3210 while the LaunchAgent is running. For isolated testing, use a separate `STUDYROOM_DATA` folder and `PORT`.

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

The app runs every AI task through the harness selected in Settings, Advanced (AI). Codex is the default; OpenCode is the alternative. Both are launched from this project with a read-only sandbox, strict JSON output schemas, and the current user's authentication. The app makes no purchase or subscription. Set creation sends selected material contents in small concurrent batches, followed by a targeted review. Insight requests send selected course progress and recent conversation. Normal studying needs no network.

Install and sign-in happen in the app. Codex installs with npm when available and signs in through ChatGPT. OpenCode installs from the official installer and connects with an OpenCode Go API key, stored in `data/agent` with owner-only permissions. Live model and reasoning-effort options come from the installed CLI (`codex debug models` or `opencode models --verbose`), and the selection is stored per harness.

If authentication expires, reconnect in Settings. If usage is exhausted, the job shows the exact service error and retains any completed checkpoints. The UI displays errors; it does not fabricate an AI response. Each bounded generation or repair call gets four minutes, and chat and deferred quality review get three; OpenCode runs get a longer window because reasoning models can take more time. OpenCode runs also use the selected model's full output budget instead of the CLI's small default, and a call that runs out of output is retried with a smaller reasoning budget, then in smaller pieces. Calls retry for transient failures, while authentication, schema, and quota errors surface immediately. Cancel terminates active child processes. An interrupted job does not import partial cards. Re-running generation uses a new job receipt and resumes matching validated checkpoints. A previous source-validated draft can be imported without another model call when a later pipeline step failed. A recovered set keeps a visible "Run quality review" action so quota outages never leave a hidden quality state.
