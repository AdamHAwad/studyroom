import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.resolve(process.env.STUDYROOM_DATA || path.join(root, 'data'));
const statePath = path.join(dataDir, 'update.json');
const logsDir = path.join(dataDir, 'logs');
const logPath = path.join(logsDir, 'update.log');
const serverPid = Number(process.env.STUDYROOM_SERVER_PID || 0);
const port = String(process.env.PORT || '3210');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

fs.mkdirSync(logsDir, { recursive: true });

function log(line) {
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
}
function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}
function writeState(patch) {
  const next = { ...readState(), ...patch };
  const tmp = statePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, statePath);
}
function command(bin, args, timeout = 15 * 60 * 1000) {
  log(`$ ${bin} ${args.join(' ')}`);
  const result = spawnSync(bin, args, {
    cwd: root,
    timeout,
    encoding: 'utf8',
    shell: process.platform === 'win32' && /^npm/.test(path.basename(bin)),
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (output) log(output.slice(-4000));
  return result;
}
function git(args, timeout = 60000) {
  const result = command('git', args, timeout);
  if (result.error) throw Error(result.error.message);
  if (result.status !== 0)
    throw Error(
      (result.stderr || result.stdout || 'Git could not complete that step.')
        .trim()
        .split('\n')
        .pop(),
    );
  return (result.stdout || '').trim();
}
function fail(message) {
  writeState({ phase: 'error', step: null, message, finishedAt: new Date().toISOString() });
  log(`FAILED: ${message}`);
  process.exit(1);
}

async function healthy() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}
async function waitForHealth(seconds) {
  for (let i = 0; i < seconds; i++) {
    if (await healthy()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function waitForExit(pid, seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return !alive(pid);
}

async function restart() {
  writeState({ step: 'Restarting Studyroom' });
  const label = 'local.studyroom.app';
  const domain = `gui/${process.getuid()}`;
  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', label + '.plist');
    const info = fs.existsSync(plist)
      ? spawnSync('/bin/launchctl', ['print', `${domain}/${label}`], {
          encoding: 'utf8',
          timeout: 15000,
        })
      : null;
    const pid = info && /pid = (\d+)/.exec(info.stdout || '');
    if (info?.status === 0 && (!serverPid || (pid && Number(pid[1]) === serverPid))) {
      log('Restarting through the studyroom LaunchAgent');
      spawnSync('/bin/launchctl', ['kickstart', '-k', `${domain}/${label}`], {
        encoding: 'utf8',
        timeout: 15000,
      });
      if (await waitForHealth(60)) return;
      throw Error('Studyroom did not come back after restarting. Start it again with npm start.');
    }
  }
  if (serverPid) {
    log(`Stopping Studyroom (pid ${serverPid})`);
    try {
      process.kill(serverPid, 'SIGTERM');
    } catch {}
    if (!(await waitForExit(serverPid, 20))) {
      try {
        process.kill(serverPid, 'SIGKILL');
      } catch {}
      await waitForExit(serverPid, 5);
    }
  } else if (await healthy()) {
    log('A Studyroom server is already running; restart it to finish applying the update.');
    return;
  }
  if (await healthy())
    throw Error(
      'Another Studyroom process is already using this port. Start this copy on a free port.',
    );
  const out = fs.openSync(path.join(logsDir, 'server.log'), 'a');
  const err = fs.openSync(path.join(logsDir, 'server-error.log'), 'a');
  const env = { ...process.env, PORT: port };
  delete env.STUDYROOM_SERVER_PID;
  const child = spawn(
    process.execPath,
    [
      '--import',
      path.join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
      path.join(root, 'server', 'index.ts'),
    ],
    { cwd: root, detached: true, stdio: ['ignore', out, err], env },
  );
  child.unref();
  log(`Started Studyroom (pid ${child.pid})`);
  if (await waitForHealth(60)) return;
  throw Error('Studyroom did not come back after the update. Start it again with npm start.');
}

async function main() {
  writeState({ phase: 'running', step: 'Downloading update', message: null, finishedAt: null });
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true')
    fail('This copy is not a Git checkout. Update manually instead.');
  if (git(['status', '--porcelain', '--untracked-files=no']))
    fail('You have local changes to tracked files. Commit or discard them, then update again.');
  git(['fetch', '--quiet', 'origin', 'main', '--prune']);
  const before = git(['rev-parse', 'HEAD']);
  const target = git(['rev-parse', 'origin/main']);
  if (target === before) {
    writeState({ phase: 'done', step: null, message: null, finishedAt: new Date().toISOString() });
    log('Already up to date');
    return;
  }
  git(['merge', '--ff-only', 'origin/main']);
  const after = git(['rev-parse', 'HEAD']);
  const changed = git(['diff', '--name-only', before, after]).split('\n').filter(Boolean);
  try {
    if (changed.includes('package.json') || changed.includes('package-lock.json')) {
      writeState({ step: 'Installing dependencies' });
      const install = command(npm, [
        'install',
        '--no-audit',
        '--no-fund',
        '--no-progress',
        '--loglevel=error',
      ]);
      if (install.error || install.status !== 0)
        throw Error(
          `Installing dependencies failed${install.error ? `: ${install.error.message}` : ''}.`,
        );
    }
    writeState({ step: 'Building update' });
    const dist = path.join(root, 'dist');
    const next = path.join(root, 'dist.next');
    const previous = path.join(root, 'dist.old');
    const tsc = command(process.execPath, [
      path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit',
    ]);
    if (tsc.error || tsc.status !== 0)
      throw Error(
        `The new code did not pass type checks${tsc.error ? `: ${tsc.error.message}` : ''}.`,
      );
    fs.rmSync(next, { recursive: true, force: true });
    const vite = command(process.execPath, [
      path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
      'build',
      '--outDir',
      'dist.next',
      '--emptyOutDir',
    ]);
    if (vite.error || vite.status !== 0)
      throw Error(
        `Building the browser bundle failed${vite.error ? `: ${vite.error.message}` : ''}.`,
      );
    if (!fs.existsSync(path.join(next, 'index.html')))
      throw Error('The build did not produce dist/index.html.');
    fs.rmSync(previous, { recursive: true, force: true });
    if (fs.existsSync(dist)) fs.renameSync(dist, previous);
    fs.renameSync(next, dist);
    fs.rmSync(previous, { recursive: true, force: true });
  } catch (e) {
    git(['reset', '--hard', before]);
    fail(`${e.message} Your copy was restored to the previous version. See data/logs/update.log.`);
  }
  writeState({ phase: 'done', step: null, message: null, finishedAt: new Date().toISOString() });
  log(`Updated ${before.slice(0, 7)} -> ${after.slice(0, 7)}`);
  try {
    await restart();
    writeState({ step: null });
    log('Studyroom restarted');
  } catch (e) {
    fail(e.message);
  }
}

main().catch((e) => fail(e?.message || 'The update failed.'));
