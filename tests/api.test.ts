import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'studyroom-test-'));
const port = 43219,
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
test('local API persists courses, grading, card versions, sessions and archives', async () => {
  const c = await call('/courses', { name: 'Test course', code: 'T1', color: 'blue' });
  const s = await call('/sets', {
    courseId: c.id,
    title: 'Test set',
    cards: [
      { term: '1+1', definition: '2', distractors: ['1', '3', '4'], aliases: ['two'] },
      { term: '2+2', definition: '4', distractors: ['1', '2', '3'] },
    ],
  });
  const set = await call('/sets/' + s.id);
  assert.equal(set.cards.length, 2);
  const session = await call('/sessions', { setId: s.id, mode: 'learn', questionType: 'written' });
  const id = crypto.randomUUID();
  const e = {
    id,
    sessionId: session.id,
    cardId: set.cards[0].id,
    kind: 'written',
    response: 'Two',
    durationMs: 1250,
  };
  const a = await call('/attempts', e);
  assert.equal(a.correct, true);
  assert.equal((await call('/attempts', e)).id, a.id);
  let stats = (await call('/bootstrap')).stats;
  assert.equal(stats.attempts, 1);
  assert.equal(stats.accuracy, 100);
  const match = await call('/sessions', { setId: s.id, mode: 'match' });
  const miss = await call('/attempts', {
    id: crypto.randomUUID(),
    sessionId: match.id,
    cardId: set.cards[0].id,
    kind: 'match',
    matchedCardId: set.cards[1].id,
    response: '4',
    durationMs: 100,
  });
  assert.equal(miss.correct, false);
  const testSession = await call('/sessions', { setId: s.id, mode: 'test', count: 2 });
  await assert.rejects(
    () => call('/sessions/' + testSession.id + '/submit', { answers: {}, durationMs: 1000 }),
    /Answer every question/,
  );
  const answers = Object.fromEntries(testSession.cards.map((c: any) => [c.id, c.definition]));
  await call('/sessions/' + testSession.id, { state: { answers } }, 'PATCH');
  assert.deepEqual((await call('/sessions/' + testSession.id)).state.answers, answers);
  const result = await call('/sessions/' + testSession.id + '/submit', {
    answers,
    durationMs: 1000,
  });
  assert.equal(result.correct, 2);
  await call('/sessions/' + testSession.id + '/submit', { answers, durationMs: 1000 });
  stats = (await call('/bootstrap')).stats;
  assert.equal(stats.attempts, 4);
  set.cards[0].definition = 'two';
  await call('/sets/' + s.id, { title: set.title, description: '', cards: set.cards }, 'PUT');
  assert.equal((await call('/sets/' + s.id)).cards[0].version, 2);
  assert.equal(
    (await call('/bootstrap')).progress.find((p: any) => p.cardId === set.cards[0].id)
      .objectiveAttempts,
    0,
  );
  const exported = await call('/export');
  assert.equal(exported.attempts[0].cardSnapshot.definition, '2');
  assert.equal(exported.attempts.length, 4);
  await call('/sets/' + s.id, { archived: true }, 'PATCH');
  assert.equal((await call('/bootstrap')).sets.length, 0);
  assert.equal((await call('/archive')).sets.length, 1);
  await call('/sets/' + s.id, { archived: false }, 'PATCH');
  assert.equal((await call('/bootstrap')).sets.length, 1);
  const bad = await fetch(base + '/api/courses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
    body: JSON.stringify({ name: 'Should not be created' }),
  });
  assert.equal(bad.status, 403);
});
test('agent settings select a harness and reject unknown values', async () => {
  const status = await call('/agent/status');
  assert.equal(status.harness, 'codex');
  assert.equal(typeof status.codex.installed, 'boolean');
  assert.equal(typeof status.opencode.installed, 'boolean');
  if (status.codex.installed) {
    const codexModels = await call('/agent/models?harness=codex');
    assert.ok(Array.isArray(codexModels.models));
    assert.ok(codexModels.models.every((model: any) => model.id && Array.isArray(model.efforts)));
  }
  await call('/settings', { agentHarness: 'opencode', agentOpencodeEffort: 'high' }, 'PATCH');
  const settings = await call('/settings');
  assert.equal(settings.harness, 'opencode');
  assert.equal(settings.agent, 'OpenCode · connected account');
  assert.equal((await call('/bootstrap')).settings.agentOpencodeEffort, 'high');
  await assert.rejects(
    () => call('/settings', { agentHarness: 'gemini' }, 'PATCH'),
    /agentHarness/,
  );
  await assert.rejects(
    () => call('/settings', { agentCodexModel: 'gpt; rm -rf /' }, 'PATCH'),
    /agentCodexModel/,
  );
  await call('/settings', { agentHarness: 'codex' }, 'PATCH');
});
test('unsupported upload is rejected and text upload preserves source content', async () => {
  const c = await call('/courses', { name: 'Upload test' });
  const form = new FormData();
  form.append(
    'file',
    new Blob(['A retrieval cue prompts a memory. A clear cue identifies one target.']),
    'lecture.txt',
  );
  const r = await fetch(base + '/api/courses/' + c.id + '/upload', { method: 'POST', body: form });
  const source = await r.json();
  assert.equal(source.status, 'ready');
  assert.match(
    await (await fetch(base + '/api/sources/' + source.id + '/text')).text(),
    /retrieval cue/,
  );
  const bad = new FormData();
  bad.append('file', new Blob(['bad']), 'bad.exe');
  assert.equal(
    (await fetch(base + '/api/courses/' + c.id + '/upload', { method: 'POST', body: bad })).status,
    400,
  );
});
test('learn sessions cover the whole set, respect answer side, and test grades every kind', async () => {
  const c = await call('/courses', { name: 'Study mode test' });
  const s = await call('/sets', {
    courseId: c.id,
    title: 'Twelve terms',
    cards: Array.from({ length: 12 }, (_, i) => ({
      term: `Term ${i + 1}`,
      definition: `Definition ${i + 1}`,
      distractors: ['Off one', 'Off two', 'Off three'],
    })),
  });
  const learn = await call('/sessions', {
    setId: s.id,
    mode: 'learn',
    questionTypes: ['mcq'],
  });
  assert.equal(learn.cards.length, 12);
  const reverse = await call('/sessions', {
    setId: s.id,
    mode: 'learn',
    direction: 'definition',
    questionTypes: ['written'],
  });
  assert.equal(reverse.cards[0].prompt, reverse.cards[0].definition);
  assert.equal(reverse.cards[0].answer, reverse.cards[0].term);
  assert.equal(reverse.cards[0].answerSide, 'term');
  const attempt = await call('/attempts', {
    id: crypto.randomUUID(),
    sessionId: reverse.id,
    cardId: reverse.cards[0].id,
    kind: 'written',
    response: reverse.cards[0].term,
    durationMs: 1000,
  });
  assert.equal(attempt.correct, true);
  const test = await call('/sessions', {
    setId: s.id,
    mode: 'test',
    count: 3,
    questionTypes: ['tf'],
  });
  assert.equal(
    test.cards.every((q: any) => q.answerKind === 'tf'),
    true,
  );
  const answers = Object.fromEntries(test.cards.map((q: any) => [q.id, q.answer]));
  const result = await call('/sessions/' + test.id + '/submit', { answers, durationMs: 3000 });
  assert.equal(result.correct, 3);
  assert.equal(
    result.questions.every((q: any) => q.answer === q.response),
    true,
  );
});
