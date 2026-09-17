# Contributing

Thanks for helping make Studyroom better. The app is a local study tool, so most changes are about the study loop: creation, practice, scheduling, and insights.

## Setup

```sh
npm install
npm run build
npm test
npm start
```

Open http://localhost:3210. For a scratch instance with sample data, use `npm run seed-demo` with a `STUDYROOM_DATA` folder and a separate `PORT` so your real data stays untouched.

## Ground rules

- Study events are append-only. Never edit or delete attempt rows, and preserve card versions. Editing a card bumps its version; it never rewrites history.
- The HTTP server owns all database writes. Scripts under `scripts/` may read (`npm run data --`) and, in the case of `seed-demo.ts`, write only to a scratch `STUDYROOM_DATA` folder.
- Never commit anything under `data/`, and never inspect or commit `data/agent`; it holds the agent sign-in key with owner-only permissions.
- Uploaded source text is user data. Do not paste it into issues, tests, or fixtures.

## How changes are reviewed

- `npm run build` must pass type checks, and `npm test` must pass.
- Background generation and insight agents read `.agents/skills`, use strict JSON output, and never write the database directly.
- Keep the server single-process and local. No Docker, no remote database, no telemetry.

## Reporting bugs

Open an issue with the job ID if one exists; `data/jobs/JOB_ID` receipts make generation failures diagnosable without sharing your materials.
