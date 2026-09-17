import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4321 + Math.floor(Math.random() * 300);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyroom-smoke-'));
const loader = pathToFileURL(path.join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const serverEntry = path.join(root, 'server', 'index.ts');

const child = spawn(process.execPath, ['--import', loader, serverEntry], {
  cwd: root,
  env: { ...process.env, STUDYROOM_DATA: dataDir, PORT: String(port), NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (c) => process.stdout.write(`[server] ${c}`));
child.stderr.on('data', (c) => process.stderr.write(`[server:err] ${c}`));

const base = `http://127.0.0.1:${port}`;
async function api(callPath, options = {}) {
  const r = await fetch(base + callPath, options);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${callPath} -> ${r.status}: ${JSON.stringify(body)}`);
  return body;
}
let lastError = null;
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try {
    const r = await fetch(base + '/api/health');
    up = (await r.json()).ok === true;
  } catch (e) {
    lastError = e;
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!up) {
  console.error('server did not come up:', lastError);
  process.exit(1);
}
console.log('health ok');

const bootstrap = await api('/api/bootstrap');
if (!Array.isArray(bootstrap.courses)) throw new Error('bootstrap did not return courses');
console.log('bootstrap ok');

const course = await api('/api/courses', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'Smoke course',
    code: 'S 101',
    color: 'blue',
    description: 'CI smoke test',
  }),
});
if (!course.id) throw new Error('course create failed');

const set = await api('/api/sets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    courseId: course.id,
    title: 'Smoke set',
    description: '',
    cards: [
      {
        term: 'Term',
        definition: 'Definition',
        question: 'What is Term?',
        distractors: ['Wrong one', 'Wrong two', 'Wrong three'],
        explanation: 'Because',
        topic: 'General',
        aliases: [],
        sources: [],
      },
    ],
  }),
});
if (!set.id) throw new Error('set create failed');
const loaded = await api(`/api/sets/${set.id}`);
if (loaded.cards?.length !== 1) throw new Error('set card count wrong');
console.log('course and set ok');

const progress = await api(`/api/progress?courseId=${course.id}`);
if (!progress.stats) throw new Error('progress snapshot missing stats');
console.log('progress snapshot ok');

async function upload(name) {
  const file = path.join(root, 'tests', 'fixtures', name);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)]), name);
  try {
    const source = await api(`/api/courses/${course.id}/upload`, { method: 'POST', body: form });
    if (source.status !== 'ready')
      throw new Error(`${name} status: ${source.status} (${source.error})`);
    console.log(`upload ok: ${name} (${source.kind})`);
  } catch (e) {
    if (/poppler|Python 3|OCR tool/.test(e.message))
      console.log(`skipped (${e.message.slice(0, 60)}...)`);
    else throw e;
  }
}
await upload('lecture.txt');
await upload('geometry.docx');
await upload('geometry.pptx');
await upload('geometry.pdf');

const extracted = await fetch(base + '/api/export');
if (!extracted.ok) throw new Error('export failed');
console.log('export ok');

child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 800));
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('SMOKE PASS');
