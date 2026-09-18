import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'studyroom-update-test-'));
fs.writeFileSync(
  path.join(data, 'update.json'),
  JSON.stringify({
    phase: 'running',
    step: 'Downloading update',
    latest: null,
    behind: 0,
    supported: true,
    reason: null,
  }),
);
const port = 43220,
  base = `http://127.0.0.1:${port}`;
let server: ChildProcess;
async function call(url: string, body?: any, method = body ? 'POST' : 'GET') {
  const r = await fetch(base + '/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await r.json();
  if (!r.ok) throw Error(result.error);
  return result;
}
before(async () => {
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, PORT: String(port), STUDYROOM_DATA: data },
    stdio: 'pipe',
  });
  for (let i = 0; i < 100; i++) {
    try {
      await call('/health');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw Error('Server failed to start');
});
after(async () => {
  server?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(data, { recursive: true, force: true });
});
test('update status reports the running commit and recovers an interrupted update', async () => {
  const status = await call('/update');
  assert.equal(status.supported, true);
  assert.match(status.current.sha, /^[0-9a-f]{40}$/);
  assert.match(status.current.short, /^[0-9a-f]{7,}$/);
  assert.equal(status.available, false);
  assert.equal(status.phase, 'error');
  assert.match(status.message, /did not finish/i);
});
test('applying is refused when no newer version is known', async () => {
  await assert.rejects(() => call('/update/apply', {}), /already up to date/i);
});
