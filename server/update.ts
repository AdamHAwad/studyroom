import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA, ROOT, now } from './db';

const exec = promisify(execFile);
const statePath = path.join(DATA, 'update.json');
const checkIntervalMs = 5 * 60 * 1000;

export type CommitInfo = { sha: string; short: string; date: string; subject: string };
type Phase = 'idle' | 'running' | 'done' | 'error';
type PersistedState = {
  phase: Phase;
  step: string | null;
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastCheckedAt: string | null;
  latest: CommitInfo | null;
  behind: number;
  supported: boolean;
  reason: string | null;
};
export type UpdateStatus = PersistedState & {
  current: CommitInfo | null;
  available: boolean;
};
const defaults: PersistedState = {
  phase: 'idle',
  step: null,
  message: null,
  startedAt: null,
  finishedAt: null,
  lastCheckedAt: null,
  latest: null,
  behind: 0,
  supported: true,
  reason: null,
};

function readState(): PersistedState {
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) };
  } catch {
    return { ...defaults };
  }
}
function writeState(patch: Partial<PersistedState>) {
  const next = { ...readState(), ...patch };
  const tmp = statePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, statePath);
}
async function git(args: string[], timeout = 45000): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd: ROOT, timeout, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (e: any) {
    if (e?.code === 'ENOENT')
      throw Error('Git is required for automatic updates but was not found on this machine.');
    const detail =
      String(e?.stderr || e?.stdout || e?.message || '')
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(-1)[0] || 'Git could not complete that step.';
    throw Error(detail.slice(0, 240));
  }
}
async function isRepo() {
  try {
    return (await git(['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}
async function commitOf(ref: string): Promise<CommitInfo> {
  const out = await git(['log', '-1', '--format=%H%n%h%n%cs%n%s', ref]);
  const [sha, short, date, ...subject] = out.split('\n');
  return { sha, short, date, subject: subject.join(' ') };
}
async function behindCount(fallback: number) {
  try {
    return Number(await git(['rev-list', '--count', 'HEAD..origin/main']));
  } catch {
    return fallback;
  }
}

export async function updateStatus(): Promise<UpdateStatus> {
  const state = readState();
  let current: CommitInfo | null = null;
  let supported = state.supported;
  let reason = state.reason;
  if (supported) {
    try {
      current = await commitOf('HEAD');
    } catch (e) {
      supported = false;
      reason = reason || (e as Error).message;
    }
  }
  const behind = supported ? await behindCount(state.behind) : state.behind;
  return {
    ...state,
    behind,
    supported,
    reason,
    current,
    available: Boolean(
      supported && state.latest && current && state.latest.sha !== current.sha && behind > 0,
    ),
  };
}

let checking: Promise<UpdateStatus> | null = null;
export function checkForUpdate(force = false): Promise<UpdateStatus> {
  if (checking) return checking;
  checking = runCheck(force).finally(() => {
    checking = null;
  });
  return checking;
}
async function runCheck(force: boolean): Promise<UpdateStatus> {
  const state = readState();
  if (
    !force &&
    state.latest &&
    state.lastCheckedAt &&
    Date.now() - Date.parse(state.lastCheckedAt) < checkIntervalMs
  )
    return updateStatus();
  if (!(await isRepo())) {
    writeState({
      supported: false,
      latest: null,
      behind: 0,
      lastCheckedAt: now(),
      reason: 'This copy is not a Git checkout, so automatic updates are unavailable.',
    });
    return updateStatus();
  }
  try {
    await git(['fetch', '--quiet', 'origin', 'main', '--prune'], 60000);
    const latest = await commitOf('origin/main');
    const behind = Number(await git(['rev-list', '--count', 'HEAD..origin/main']));
    writeState({ latest, behind, supported: true, reason: null, lastCheckedAt: now() });
  } catch (e) {
    writeState({ supported: true, reason: (e as Error).message, lastCheckedAt: now() });
  }
  return updateStatus();
}

let starting = false;
export async function applyUpdate(): Promise<{ started: boolean }> {
  if (starting) return { started: true };
  starting = true;
  try {
    const state = await updateStatus();
    if (state.phase === 'running') return { started: true };
    if (!state.supported)
      throw Error(state.reason || 'Automatic updates are unavailable for this copy.');
    if (!state.available) throw Error('Studyroom is already up to date.');
    const logs = path.join(DATA, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const out = fs.openSync(path.join(logs, 'update.log'), 'a');
    writeState({
      phase: 'running',
      step: 'Preparing update',
      message: null,
      startedAt: now(),
      finishedAt: null,
    });
    try {
      const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'apply-update.mjs')], {
        cwd: ROOT,
        detached: true,
        stdio: ['ignore', out, out],
        env: {
          ...process.env,
          STUDYROOM_SERVER_PID: String(process.pid),
          PORT: process.env.PORT || '3210',
        },
      });
      child.unref();
    } catch (e) {
      writeState({
        phase: 'error',
        step: null,
        message: (e as Error).message,
        finishedAt: now(),
      });
      throw e;
    }
    return { started: true };
  } finally {
    starting = false;
  }
}

export function recoverUpdate() {
  const state = readState();
  if (state.phase === 'running')
    writeState({
      phase: 'error',
      step: null,
      message: 'The last update did not finish. Try again, or update from the terminal.',
      finishedAt: now(),
    });
  else if (state.phase === 'done' && state.step) writeState({ step: null });
}
