import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'studyroom-material-api-'));
const port = 43223;
let server: ChildProcess;
const fake = path.join(data, 'fake-codex');
fs.writeFileSync(
  fake,
  `#!${process.execPath}
const fs=require('node:fs');
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
const request=JSON.parse(input.split('\\nREQUEST\\n').at(-1));
const ref=request.evidence?.[0]?.ref || request.courseInventory?.[0]?.refs?.[0] || '';
let result;
if(request.task==='create')result={cards:[{term:'Sensation',answer:'Detection of stimuli',refs:[ref]}],skipped:[]};
else if(request.task==='inventory')result={terms:[{term:'Sensation',topic:'Psychology',definition:'Detection of stimuli',example:'Detecting light',importance:5,refs:[ref]}],overview:['Senses detect stimuli.'],essentialQuestions:['What is sensation?'],warnings:[]};
else if(request.task==='exam-plan')result={instructions:'Answer all questions',durationMinutes:10,style:{font:'serif',columns:1,optionLayout:'stacked',headingCase:'normal'},sections:[{title:'Short response',instructions:'Explain.',kind:'short-answer',count:1,pointsEach:3,topics:['Psychology']}],warnings:[]};
else result={questions:[{prompt:'1. Explain sensation in a new setting.',answer:'Sensation detects stimuli.',explanation:'Receptors detect the physical input.',points:3,lines:4,refs:[ref]}],warnings:[]};
fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],JSON.stringify(result));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:10}}));
// Simulate a CLI that writes a complete response then fails during shutdown.
process.exitCode=7;
});
`,
  { mode: 0o700 },
);
async function api(route: string, body?: unknown, method = body ? 'POST' : 'GET') {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error);
  return result;
}
async function completed(id: string) {
  for (let i = 0; i < 100; i++) {
    const job = await api('/jobs/' + id);
    if (job.status === 'completed') return job;
    if (job.status === 'failed') throw Error(job.error);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error('Job did not finish');
}
before(async () => {
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, PORT: String(port), STUDYROOM_DATA: data, CODEX_BIN: fake },
    stdio: 'pipe',
  });
  for (let i = 0; i < 100; i++) {
    try {
      await api('/health');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw Error('Server did not start');
});
after(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(data, { recursive: true, force: true });
});
test('all creation modes, printable keys, variants, archive/restore and export work through the HTTP server', async () => {
  const course = await api('/courses', { name: 'Material API check' });
  const other = await api('/courses', { name: 'Other course' });
  const form = new FormData();
  form.append('file', new Blob(['Sensation detects physical stimuli.']), 'Sample exam.txt');
  const source = await (
    await fetch(`http://127.0.0.1:${port}/api/courses/${course.id}/upload`, {
      method: 'POST',
      body: form,
    })
  ).json();
  assert.equal(source.status, 'ready');
  await assert.rejects(
    () =>
      api('/jobs/set', {
        courseId: other.id,
        title: 'Bad ownership',
        sourceIds: [source.id],
        kind: 'practice-exam',
      }),
    /belong/,
  );
  await assert.rejects(
    () =>
      api('/jobs/set', {
        courseId: course.id,
        title: 'Bad sample',
        sourceIds: [source.id],
        referenceSourceIds: ['foreign'],
        kind: 'practice-exam',
      }),
    /selected uploads/,
  );
  for (const kind of ['set', 'retrieval-packet', 'practice-exam']) {
    const queued = await api('/jobs/set', {
      courseId: course.id,
      title: kind,
      kind,
      sourceIds: [source.id],
      referenceSourceIds: kind === 'practice-exam' ? [source.id] : [],
      instructions: 'Aim for 100 cards and exam success.',
    });
    const job = await completed(queued.id);
    assert.equal(job.error, null, 'CLI shutdown errors must not discard a complete result');
    if (kind === 'set') {
      assert.equal(job.metrics.calls, 1);
      assert.equal((await api('/sets/' + job.resultId)).cards.length, 1);
      continue;
    }
    const doc = await api('/documents/' + job.resultId);
    assert.equal(doc.kind, kind);
    const printable = await fetch(`http://127.0.0.1:${port}/api/documents/${doc.id}/print`);
    assert.equal(printable.headers.get('x-frame-options'), 'SAMEORIGIN');
    const student = await printable.text();
    assert.doesNotMatch(student, /Sensation detects stimuli\./);
    if (kind === 'practice-exam') {
      const key = await (
        await fetch(`http://127.0.0.1:${port}/api/documents/${doc.id}/print?answers=1`)
      ).text();
      assert.match(key, /Sensation detects stimuli\./);
      assert.doesNotMatch(student, /1\. Explain/);
      const variant = await api('/documents/' + doc.id + '/generate', {});
      const again = await api('/documents/' + doc.id + '/generate', {});
      assert.equal(again.id, variant.id);
      const finished = await completed(variant.id);
      assert.notEqual(finished.resultId, doc.id);
    }
    await api('/documents/' + doc.id, { archived: true }, 'PATCH');
    assert.ok(!(await api('/bootstrap')).documents.some((d: any) => d.id === doc.id));
    assert.ok((await api('/archive')).documents.some((d: any) => d.id === doc.id));
    await api('/documents/' + doc.id, { archived: false }, 'PATCH');
    assert.ok((await api('/bootstrap')).documents.some((d: any) => d.id === doc.id));
  }
  const exported = await api('/export');
  assert.equal(exported.documents.length, 3);
  assert.equal(exported.attempts.length, 0, 'Documents must not change study progress');
});
