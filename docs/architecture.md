# Studyroom system contract

Studyroom is a single-user React application served by one local Express process at 127.0.0.1:3210. SQLite is authoritative. There is no Docker, remote application database, analytics SDK, or API-key setup. The browser uses the local API; only source generation and insight jobs call the selected agent harness (Codex by default, OpenCode optional) using the existing account.

## Data and ownership

`data/studyroom.sqlite` contains course, set, card, source, asset, crop, study session, attempt, progress, job, conversation, message, and settings records. Each table has a stable primary key. Child records have foreign keys for course/set/session relationships. JSON payloads carry versioned domain fields, allowing direct SQL reads and lossless JSONL exports without reconstructing an ORM object graph. WAL mode, a busy timeout, and transactions protect writes.

The HTTP server owns writes. Attempt IDs are idempotency keys, so retrying a recorded attempt does not count twice. Completed Test submissions return the stored result. Attempts retain the exact card version and question/answer snapshot. Editing a card increments the version and resets its current progress without destroying earlier attempts. Courses and sets archive reversibly.

Sessions capture card versions and randomized choice order. The browser saves navigation, queues, matching state, and unfinished test answers. Learn covers the full selected set as one round: missed cards return later in the round, a checkpoint celebrates every 10 answers, and the round ends only when every term has been answered correctly once. Learn can present MCQ, written, true or false, and worksheet-style matching questions. Learn matching is distinct from the timed Match mode: it groups same-topic cards into numbered prompts with a shared lettered option pool (plus one extra option when a block has at least four items), shows one shared question-side figure when several cards in a cluster carry it, records one attempt per matched item against the covered card, and returns the whole block after any miss. Flashcard sorting, audio, and shuffle preferences are stored on the session. In-flight set, review, and insight jobs have explicit states: queued, running, completed, failed, cancelled. Restart marks interrupted jobs as failed with a visible retry action. One job is scheduled at a time, with up to three independent bounded generation calls running concurrently inside a set job.

## Agent contracts

Both roles use the same project root. Skills live only in `.agents/skills`. The child CLI ignores general user configuration, uses the existing auth, uses a read-only sandbox, and receives a strict JSON schema. The server embeds the relevant skill and bounded data request. The prompt asks the agent to use supplied evidence without tools. No job writes the database directly. One harness is active at a time: Codex by default, or OpenCode selected under Settings, Advanced (AI). The live model and reasoning-effort settings, install state, and sign-in state are read from the installed CLI, and each agent receipt records the harness, model, and effort used.

Creation jobs use a versioned pipeline. Extraction is converted into stable evidence units with IDs, then small bounded batches are processed concurrently. Each batch writes an atomic request, schema, result, receipt, and validated checkpoint before the next stage runs. A failed batch is retried in place, first with a smaller reasoning budget and then in smaller pieces, so a long upload still produces a set. A retry of the whole job reuses checkpoints whose fingerprint still matches the sources, model, and project skills. A final review agent checks the merged draft for material errors, diagram answer leakage, and coverage gaps. Repairs target only flagged cards or evidence units. Sets are published after source validation; if reviewer notes remain after the automatic repair pass, they are attached to the set as visible warnings instead of blocking publication. If an older job has a valid result, a later retry revalidates and imports it instead of spending quota again. Full requests, schemas, receipts, checkpoints, review reports, final result, and event logs are in `data/jobs/JOB_ID`. Recovered sets retain a deferred review state and expose a review job that checks the saved cards and supplied visuals when the agent is available.

Cards must have unique cues and answers, three unique distractors, a topic, explanatory feedback, and exact source excerpts or citations to supplied visuals. Text quotes are checked against the extraction; visual citations are checked for ownership and inclusion in the request. These checks establish provenance, not factual correctness of the interpretation. Optional crop coordinates are validated and rendered by the server.

The learning-science skill separates evidence-supported teaching practices from implementation heuristics. Self-audit questions ask the editor to improve the output; the app neither requests nor stores private chains of thought. Agent calls record model, duration, heartbeats, token usage when available, retries, and last output time. The UI shows the active stage, elapsed time, completed batch count, and whether a retry resumes saved work.

Insight jobs receive a bounded version of the snapshot available to an inspecting agent through `npm run data -- snapshot`. It includes metric definitions, all-scope aggregates, ranked card details, recent attempts, and exact action URLs. Chat requests limit detailed card rows to 150 and recent attempts to 150, with explicit sampling metadata. They include server-computed facts, which the reply cites by ID. Returned action URLs and evidence IDs must exist in the supplied request. The raw snapshot and generated reply remain together as a receipt.

## Useful entry points

- `npm run data -- summary`: course/set counts and current progress.
- `npm run data -- snapshot COURSE_ID`: full grounding contract for one course.
- `npm run data -- attempts COURSE_ID`: timestamped attempt JSONL.
- `npm run data -- export`: per-table JSONL and a snapshot under `data/exports`.
- `GET /api/progress?courseId=...`: same snapshot via localhost.
- `GET /api/update` and `POST /api/update/apply`: update status and self-update from GitHub `main`.
- `GET /api/export`: full JSON export, including archived records.
- `GET /api/jobs/JOB_ID/log`: recorded CLI events.

## Learning metrics

Objective accuracy includes MCQ, written, and Match attempts, including retries. Matching attempts come from both the timed Match mode and matching blocks inside Learn; each matched item records against its covered card. It excludes card views and self-ratings. The snapshot retains kind/mode so the coach can separate recognition from recall. No accuracy is displayed before an objective attempt. A status of retained means at least three correct attempts separated by at least 20 hours from preceding activity for that card. This is a heuristic, not a probability or an exam score prediction. Wrong answers schedule 10-minute review; sufficiently spaced successes extend intervals to at most 30 days.

The app caps each attempt's contribution to study minutes at five minutes. It does not count an idle browser tab as studying. All event timestamps are ISO UTC; day charts use the machine's local calendar date.
