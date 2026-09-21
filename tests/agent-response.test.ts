import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  AgentResponseError,
  OpenCodeResponses,
  parseAgentResponse,
} from '../server/agent-response';

const schema = z.object({ terms: z.array(z.object({ term: z.string(), definition: z.string() })) });
const result = {
  terms: [{ term: 'Sensation', definition: 'Detecting sensory input, including "{light}".' }],
};
const event = (text: string, messageID = 'final', id = messageID) => ({
  type: 'text',
  part: { type: 'text', text, messageID, id },
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyroom-responses-'));
process.env.STUDYROOM_DATA = dir;
const fake = path.join(dir, 'fake-opencode');
process.env.OPENCODE_BIN = fake;
fs.writeFileSync(
  fake,
  `#!${process.execPath}
if (process.argv[2] !== 'run') process.exit(0);
let input='';
process.stdin.on('data', c => input+=c);
process.stdin.on('end', () => {
 const request=JSON.parse(input.split('\\nREQUEST\\n')[1].split('\\n\\nKeep any internal')[0]);
 const event=(text,messageID)=>({type:'text',part:{type:'text',text,messageID,id:messageID}});
 const value=request.mode==='empty' ? '{}' : JSON.stringify({terms:[{term:'Sensación',definition:'Detecting input'}]});
 const events=[event('{"terms":[{"term":"Interrupted','draft'),event(value,'final')];
 const data=Buffer.from(events.map(e=>JSON.stringify(e)).join('\\n'));
 // Exercise a UTF-8 character split across transport chunks and no final newline.
 const split=data.indexOf(Buffer.from('ó'))+1;
 process.stdout.write(data.subarray(0,split));
 setTimeout(()=>{process.stdout.write(data.subarray(split));process.exitCode=request.mode==='exit' ? 7 : 0;},10);
});
`,
  { mode: 0o700 },
);
const { runAgent, recoverSavedAgentResponse, activeAgentCount } =
  await import('../server/agent-runner');
const { put, get, db } = await import('../server/db');
put('settings', { id: 'agentHarness', value: 'opencode' });
after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a complete response after a truncated assistant message is preserved', () => {
  const responses = new OpenCodeResponses();
  responses.add(event('{"terms":[{"term":"Interrupted', 'draft'));
  responses.add({ type: 'tool_use', part: { text: 'ignored' } });
  responses.add(event(JSON.stringify(result)));
  assert.deepEqual(parseAgentResponse(responses.texts(), schema), result);
});

test('part snapshots replace earlier snapshots and latest valid response wins', () => {
  const responses = new OpenCodeResponses();
  responses.add(event('{"terms":', 'first'));
  responses.add(event(JSON.stringify({ terms: [] }), 'first'));
  responses.add(event(JSON.stringify(result), 'second'));
  responses.add(event('{"terms":[', 'third'));
  assert.equal(responses.texts().length, 3);
  assert.deepEqual(parseAgentResponse(responses.texts(), schema), result);
});

test('multipart output joins within a message without crossing message boundaries', () => {
  const responses = new OpenCodeResponses();
  const text = JSON.stringify(result);
  responses.add(event(text.slice(0, 20), 'same', 'a'));
  responses.add(event(text.slice(20), 'same', 'b'));
  assert.deepEqual(parseAgentResponse(responses.texts(), schema), result);
  const unrelated = new OpenCodeResponses();
  unrelated.add(event(text.slice(0, 20), 'first'));
  unrelated.add(event(text.slice(20), 'second'));
  assert.throws(() => parseAgentResponse(unrelated.texts(), schema), AgentResponseError);
});

test('fences, surrounding prose, braces inside strings and unrelated JSON are handled', () => {
  assert.deepEqual(
    parseAgentResponse(
      ['Some output: {"progress":100}\n```json\n' + JSON.stringify(result) + '\n```\nDone.'],
      schema,
    ),
    result,
  );
  assert.throws(() => parseAgentResponse(['{}', 'null', '{"terms":['], schema), AgentResponseError);
});

test('OpenCode transport preserves multi-message results, final unterminated events and nonzero exits', async () => {
  for (const mode of ['normal', 'exit']) {
    const job: any = {
      id: crypto.randomUUID(),
      kind: 'retrieval-packet',
      status: 'running',
      payload: {},
    };
    put('jobs', job);
    const value = await runAgent({
      job,
      part: 'inventory',
      request: { mode },
      schema,
      model: 'test/model',
      skill: '.agents/skills/create-retrieval-packet/SKILL.md',
      maxAttempts: 1,
    });
    assert.equal(value.terms[0].term, 'Sensación');
    assert.equal(get('jobs', job.id).metrics.calls, 1);
    assert.equal(activeAgentCount(), 0);
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, 'jobs', job.id, 'inventory-attempt-1-result.json'), 'utf8'),
    );
    assert.deepEqual(value, saved);
  }
});

test('empty or malformed output remains an explicit error without creating invented content', async () => {
  const job: any = {
    id: crypto.randomUUID(),
    kind: 'retrieval-packet',
    status: 'running',
    payload: {},
  };
  put('jobs', job);
  await assert.rejects(
    () =>
      runAgent({
        job,
        part: 'inventory',
        request: { mode: 'empty' },
        schema,
        model: 'test/model',
        skill: '.agents/skills/create-retrieval-packet/SKILL.md',
        maxAttempts: 1,
      }),
    AgentResponseError,
  );
  assert.equal(activeAgentCount(), 0);
});

test('saved events recover only matching requests, schemas and context fingerprints', () => {
  const folder = path.join(dir, 'saved');
  fs.mkdirSync(folder);
  const prefix = path.join(folder, 'inventory-attempt-1');
  const request = { source: 'original', focus: '' };
  fs.writeFileSync(prefix + '-request.json', JSON.stringify(request));
  fs.writeFileSync(prefix + '-schema.json', JSON.stringify(z.toJSONSchema(schema)));
  fs.writeFileSync(
    prefix + '-events.jsonl',
    [event('{"terms":[', 'draft'), event(JSON.stringify(result))]
      .map((e) => JSON.stringify(e))
      .join('\n'),
  );
  const options = { part: 'inventory', request, schema, cacheKey: 'current' };
  assert.deepEqual(recoverSavedAgentResponse(folder, options)?.result, result);
  assert.equal(
    recoverSavedAgentResponse(folder, { ...options, request: { source: 'changed' } }),
    null,
  );
  assert.equal(
    recoverSavedAgentResponse(folder, { ...options, schema: z.object({ other: z.string() }) }),
    null,
  );
  fs.writeFileSync(prefix + '-context.json', JSON.stringify({ cacheKey: 'old-skill' }));
  assert.equal(recoverSavedAgentResponse(folder, options), null);
  fs.writeFileSync(prefix + '-context.json', JSON.stringify({ cacheKey: 'current' }));
  assert.deepEqual(recoverSavedAgentResponse(folder, options)?.result, result);
});
