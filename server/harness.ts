import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { DATA, ROOT, get } from './db';
import { agentSpawn, isWindows } from './platform';

export type Harness = 'codex' | 'opencode';
export type ModelOption = {
  id: string;
  label: string;
  provider: string;
  efforts: string[];
  defaultEffort: string;
  image: boolean;
  outputLimit: number;
};
export type InstallState = {
  harness: Harness;
  status: 'running' | 'done' | 'failed';
  lines: string[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};
export type LoginState = {
  harness: Harness;
  status: 'running' | 'done' | 'failed';
  lines: string[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};
export type HarnessState = {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  detail: string | null;
  providers: string[];
  install: InstallState | null;
  login: LoginState | null;
};

const HOME = os.homedir();
const PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(HOME, '.opencode/bin'),
  path.join(HOME, '.local/bin'),
  path.join(HOME, '.npm-global/bin'),
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];
const extraPathDirs = new Set<string>();
export const agentPath = () =>
  [...extraPathDirs, ...PATH_DIRS, process.env.PATH || ''].filter(Boolean).join(':');

function findOnPath(command: string): string | null {
  for (const dir of agentPath().split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}
function candidates(harness: Harness): string[] {
  return (
    harness === 'codex'
      ? [
          process.env.CODEX_BIN,
          path.join(HOME, '.local', 'bin', 'codex'),
          '/opt/homebrew/bin/codex',
          '/usr/local/bin/codex',
          path.join(HOME, '.npm-global', 'bin', 'codex'),
          path.join(HOME, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
          path.join(HOME, '.codex', 'bin', 'codex'),
        ]
      : [
          process.env.OPENCODE_BIN,
          path.join(HOME, '.opencode', 'bin', 'opencode'),
          '/opt/homebrew/bin/opencode',
          '/usr/local/bin/opencode',
          path.join(HOME, '.local', 'bin', 'opencode'),
          path.join(HOME, 'AppData', 'Local', 'opencode', 'bin', 'opencode.exe'),
          path.join(HOME, 'AppData', 'Local', 'opencode', 'bin', 'opencode.cmd'),
        ]
  ).filter(Boolean) as string[];
}
const binCache = new Map<Harness, string | null>();
export function clearBinCache() {
  binCache.clear();
}
export function resolveBin(harness: Harness): string | null {
  if (binCache.has(harness)) return binCache.get(harness)!;
  let found: string | null = null;
  for (const candidate of candidates(harness)) {
    try {
      if (fs.statSync(candidate).isFile()) {
        found = candidate;
        break;
      }
    } catch {}
  }
  found ||= findOnPath(harness);
  binCache.set(harness, found);
  return found;
}
export const harnessLabel = (harness: Harness) => (harness === 'codex' ? 'Codex CLI' : 'OpenCode');

export function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: agentPath(), HOME, ...extra };
}
const opencodeConfigFile = () => path.join(agentDir(), 'opencode.json');
const opencodeKeyFile = () => path.join(agentDir(), 'opencode.key');
function agentDir() {
  const dir = path.join(DATA, 'agent');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
let opencodeConfigWritten = false;
export function writeOpencodeConfig() {
  const file = opencodeConfigFile();
  if (opencodeConfigWritten) return file;
  const config = {
    $schema: 'https://opencode.ai/config.json',
    tools: {
      write: false,
      edit: false,
      patch: false,
      bash: false,
      read: false,
      glob: false,
      grep: false,
      list: false,
      webfetch: false,
      websearch: false,
      task: false,
      todowrite: false,
      todoread: false,
      skill: false,
      question: false,
      lsp: false,
    },
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, file);
  opencodeConfigWritten = true;
  return file;
}
export function opencodeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = baseEnv({
    OPENCODE_CONFIG: writeOpencodeConfig(),
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
    OPENCODE_DISABLE_PRUNE: 'true',
    ...extra,
  });
  const key = readOpencodeKey();
  if (key) env.OPENCODE_API_KEY = key;
  return env;
}
function readOpencodeKey(): string {
  try {
    return fs.readFileSync(opencodeKeyFile(), 'utf8').trim();
  } catch {
    return '';
  }
}
export function hasOpencodeKey() {
  return Boolean(readOpencodeKey());
}
export function saveOpencodeKey(apiKey: string) {
  const key = apiKey.trim();
  if (key.length < 8) throw Error('Paste the API key from your OpenCode account.');
  const file = opencodeKeyFile();
  fs.writeFileSync(file, key, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  statusCache.delete('opencode');
}
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');
export function runCapture(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = agentSpawn(command, args, {
      cwd: options.cwd || ROOT,
      env: options.env || baseEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      timedOut = false,
      done = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, options.timeoutMs || 8000);
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.stdout!.on('data', (chunk) => {
      stdout = (stdout + String(chunk)).slice(-4_000_000);
    });
    child.stderr!.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-40000);
    });
    child.on('error', (error) => {
      stderr = (stderr + error.message).slice(-40000);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
export function setting(key: string): string {
  return get<{ id: string; value: string }>('settings', key)?.value || '';
}
export function currentHarness(): Harness {
  return setting('agentHarness') === 'opencode' ? 'opencode' : 'codex';
}
export function settingKey(harness: Harness, field: 'Model' | 'Effort') {
  return (harness === 'codex' ? 'agentCodex' : 'agentOpencode') + field;
}
export function agentSelections() {
  return {
    codex: { model: setting('agentCodexModel'), effort: setting('agentCodexEffort') },
    opencode: { model: setting('agentOpencodeModel'), effort: setting('agentOpencodeEffort') },
  };
}
async function versionOf(bin: string) {
  const result = await runCapture(bin, ['--version'], { timeoutMs: 5000 });
  const text = stripAnsi(result.stdout || result.stderr)
    .trim()
    .split('\n')
    .filter(Boolean)
    .pop();
  return text || null;
}
function credentialProviders(text: string): string[] {
  const providers = new Set<string>();
  for (const line of stripAnsi(text).split('\n')) {
    const match = line.match(/^\s*[●•]\s+(.+?)\s+(api|oauth|[A-Z][A-Z0-9_]*)\s*$/);
    if (match) providers.add(match[1].trim());
  }
  return [...providers];
}
const statusCache = new Map<
  Harness,
  { at: number; value: Omit<HarnessState, 'install' | 'login'> }
>();
async function baseState(harness: Harness): Promise<Omit<HarnessState, 'install' | 'login'>> {
  const cached = statusCache.get(harness);
  if (cached && Date.now() - cached.at < 3000) return cached.value;
  const bin = resolveBin(harness);
  let state: Omit<HarnessState, 'install' | 'login'> = {
    installed: false,
    version: null,
    loggedIn: false,
    detail: null,
    providers: [],
  };
  if (bin) {
    const version = await versionOf(bin);
    if (harness === 'codex') {
      const status = await runCapture(bin, ['login', 'status'], { timeoutMs: 8000 });
      const detail = stripAnsi(status.stdout || status.stderr)
        .trim()
        .split('\n')
        .filter(Boolean)
        .pop();
      state = {
        installed: true,
        version,
        loggedIn: Boolean(detail && /logged in/i.test(detail) && !/not logged in/i.test(detail)),
        detail: detail || null,
        providers: [],
      };
    } else {
      const auth = await runCapture(bin, ['auth', 'list'], {
        timeoutMs: 10000,
        env: opencodeEnv(),
      });
      const providers = credentialProviders(auth.stdout + auth.stderr);
      state = {
        installed: true,
        version,
        loggedIn: providers.length > 0,
        detail: providers.length ? providers.join(' · ') : 'No provider is connected yet',
        providers,
      };
    }
  }
  statusCache.set(harness, { at: Date.now(), value: state });
  return state;
}
export async function harnessState(harness: Harness): Promise<HarnessState> {
  return {
    ...(await baseState(harness)),
    install: installs.get(harness) || null,
    login: logins.get(harness) || null,
  };
}
export async function agentStatus() {
  const [codex, opencode] = await Promise.all([harnessState('codex'), harnessState('opencode')]);
  return { harness: currentHarness(), codex, opencode, selected: agentSelections() };
}
const modelsCache = new Map<Harness, { at: number; value: ModelOption[] }>();
const modelsPending = new Map<Harness, Promise<ModelOption[]>>();
const MODEL_TTL = 5 * 60 * 1000;
export function modelsFor(harness: Harness): Promise<ModelOption[]> {
  const cached = modelsCache.get(harness);
  if (cached && Date.now() - cached.at < MODEL_TTL) return Promise.resolve(cached.value);
  const pending = modelsPending.get(harness);
  if (pending) return pending;
  const promise = loadModels(harness)
    .then((value) => {
      modelsCache.set(harness, { at: Date.now(), value });
      return value;
    })
    .finally(() => modelsPending.delete(harness));
  modelsPending.set(harness, promise);
  return promise;
}
async function loadModels(harness: Harness): Promise<ModelOption[]> {
  const bin = resolveBin(harness);
  if (!bin) return [];
  let models: ModelOption[] = [];
  if (harness === 'codex') {
    const result = await runCapture(bin, ['debug', 'models'], { timeoutMs: 30000 });
    try {
      const parsed = JSON.parse(result.stdout);
      models = (parsed.models || [])
        .filter((model: any) => model.visibility === 'list')
        .map((model: any) => ({
          id: model.slug,
          label: model.display_name || model.slug,
          provider: 'codex',
          efforts: (model.supported_reasoning_levels || []).map((level: any) => level.effort),
          defaultEffort: model.default_reasoning_level || 'medium',
          image: true,
          outputLimit: 0,
        }));
    } catch {}
  } else {
    const [result, auth] = await Promise.all([
      runCapture(bin, ['models', '--verbose'], { timeoutMs: 30000, env: opencodeEnv() }),
      runCapture(bin, ['auth', 'list'], { timeoutMs: 10000, env: opencodeEnv() }),
    ]);
    const connected = new Set(
      credentialProviders(auth.stdout + auth.stderr).map((name) =>
        name.toLowerCase() === 'opencode zen'
          ? 'opencode'
          : name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      ),
    );
    models = parseOpencodeModels(result.stdout)
      .filter((model: any) => model.status !== 'deprecated' && model.enabled !== false)
      .filter((model: any) =>
        connected.size
          ? connected.has(model.providerID)
          : ['opencode-go', 'opencode'].includes(model.providerID),
      )
      .map((model: any) => ({
        id: `${model.providerID}/${model.id}`,
        label: model.name || model.id,
        provider: model.providerID,
        efforts: Object.keys(model.variants || {}),
        defaultEffort: '',
        image: Boolean(model.capabilities?.input?.image) || Boolean(model.attachment),
        outputLimit: Number(model.limit?.output) || 0,
      }));
  }
  models.sort((a, b) => {
    const rank = (model: ModelOption) =>
      model.provider === 'opencode-go' ? 0 : model.provider === 'codex' ? 0 : 1;
    return rank(a) - rank(b) || a.label.localeCompare(b.label);
  });
  return models;
}
function parseOpencodeModels(text: string): any[] {
  const lines = stripAnsi(text).split('\n');
  const models: any[] = [];
  for (let index = 0; index < lines.length; index++) {
    const header = lines[index].trim();
    if (!header || header.startsWith('{') || header.startsWith('}') || header.startsWith('"'))
      continue;
    if (!header.includes('/')) continue;
    let cursor = index + 1;
    while (cursor < lines.length && !lines[cursor].trim()) cursor++;
    if (!lines[cursor]?.trim().startsWith('{')) continue;
    let depth = 0,
      buffer = '';
    for (; cursor < lines.length; cursor++) {
      buffer += lines[cursor] + '\n';
      for (const char of lines[cursor]) {
        if (char === '{') depth++;
        else if (char === '}') depth--;
      }
      if (depth === 0) break;
    }
    try {
      models.push({ id: header.slice(header.indexOf('/') + 1), ...JSON.parse(buffer) });
    } catch {}
    index = cursor;
  }
  return models;
}
export async function defaultOpencodeModel(): Promise<string> {
  const models = (await modelsFor('opencode')).filter(
    (model) => model.provider === 'opencode-go' || model.provider === 'opencode',
  );
  const preferred =
    models.find((model) => model.id === 'opencode-go/gpt-5.6-luna') ||
    models.find((model) => model.provider === 'opencode-go' && model.image) ||
    models.find((model) => model.provider === 'opencode-go') ||
    models[0];
  return preferred?.id || '';
}
const installs = new Map<Harness, InstallState>();
const logins = new Map<Harness, LoginState>();
export const getInstall = (harness: Harness) => installs.get(harness) || null;
export const getLogin = (harness: Harness) => logins.get(harness) || null;
const harnessChildren = new Set<ChildProcess>();
export function stopHarnessProcesses() {
  for (const child of harnessChildren) child.kill('SIGTERM');
}
function track(child: ChildProcess, state: InstallState | LoginState) {
  harnessChildren.add(child);
  state.status = 'running';
  const push = (chunk: Buffer) => {
    for (const line of stripAnsi(String(chunk)).split(/\r?\n/)) {
      if (line.trim()) state.lines.push(line.trim());
    }
    if (state.lines.length > 200) state.lines.splice(0, state.lines.length - 200);
  };
  child.stdout?.on('data', push);
  child.stderr?.on('data', push);
  child.on('error', (error) => {
    state.status = 'failed';
    state.error = error.message;
    state.finishedAt = new Date().toISOString();
  });
  child.on('close', (code) => {
    harnessChildren.delete(child);
    if (state.status === 'failed') return;
    state.status = code === 0 ? 'done' : 'failed';
    state.error = code === 0 ? null : `Exited with code ${code}.`;
    state.finishedAt = new Date().toISOString();
  });
}
export function startInstall(harness: Harness): InstallState {
  const existing = installs.get(harness);
  if (existing?.status === 'running') return existing;
  const state: InstallState = {
    harness,
    status: 'running',
    lines: [],
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  installs.set(harness, state);
  statusCache.delete(harness);
  const npm =
    findOnPath('npm') ||
    (fs.existsSync(path.join(path.dirname(process.execPath), 'npm'))
      ? path.join(path.dirname(process.execPath), 'npm')
      : null);
  const command =
    harness === 'codex'
      ? npm
        ? { bin: npm, args: ['install', '-g', '@openai/codex'], env: baseEnv() }
        : {
            bin: isWindows ? findOnPath('powershell') || 'powershell' : '/bin/sh',
            args: isWindows
              ? [
                  '-NoProfile',
                  '-Command',
                  'winget install OpenAI.Codex --accept-package-agreements',
                ]
              : ['-c', 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'],
            env: baseEnv({ CODEX_NON_INTERACTIVE: '1' }),
          }
      : {
          bin: isWindows ? findOnPath('powershell') || 'powershell' : '/bin/sh',
          args: isWindows
            ? ['-NoProfile', '-Command', 'irm https://opencode.ai/install.ps1 | iex']
            : ['-c', 'curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path'],
          env: baseEnv(),
        };
  const child = agentSpawn(command.bin, command.args, {
    cwd: ROOT,
    env: command.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  track(child, state);
  child.on('close', async () => {
    if (installs.get(harness)?.status === 'done' && npm) {
      const prefix = await runCapture(npm, ['prefix', '-g'], { timeoutMs: 8000 });
      const dir = prefix.stdout.trim();
      if (dir) extraPathDirs.add(isWindows ? dir : path.join(dir, 'bin'));
    }
    if (installs.get(harness)?.status === 'done') clearBinCache();
    statusCache.delete(harness);
    modelsCache.delete(harness);
  });
  return state;
}
export function startCodexLogin(): LoginState {
  const existing = logins.get('codex');
  if (existing?.status === 'running') return existing;
  const bin = resolveBin('codex');
  if (!bin) throw Error('Codex CLI is not installed yet.');
  const state: LoginState = {
    harness: 'codex',
    status: 'running',
    lines: [],
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  logins.set('codex', state);
  statusCache.delete('codex');
  const child = agentSpawn(bin, ['login'], {
    cwd: ROOT,
    env: baseEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  track(child, state);
  child.on('close', () => statusCache.delete('codex'));
  return state;
}
export function connectOpencode(apiKey: string) {
  saveOpencodeKey(apiKey);
  const state: LoginState = {
    harness: 'opencode',
    status: 'done',
    lines: ['API key saved with owner-only permissions.'],
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
  logins.set('opencode', state);
  modelsCache.delete('opencode');
  return state;
}
