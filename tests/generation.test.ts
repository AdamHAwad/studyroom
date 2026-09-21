import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyroom-generation-'));
process.env.STUDYROOM_DATA = dir;
const { batchOutput, evidenceUnits, cardErrors } = await import('../server/generation-contract');
const { generateSet } = await import('../server/generation');
const { db } = await import('../server/db');
after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Codex schema uses object array items, including nullable image crop coordinates', () => {
  const schema = z.toJSONSchema(batchOutput);
  function visit(value: any) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'array') {
      assert.ok(
        value.items && !Array.isArray(value.items),
        'Structured outputs require object items',
      );
    }
    Object.values(value).forEach(visit);
  }
  visit(schema);
});

test('generation rejects ungrounded evidence IDs and invalid visual crops', () => {
  const textPath = path.join(dir, 'source.txt');
  fs.writeFileSync(textPath, 'A triangle has three straight sides.');
  const source: any = { id: 'source', name: 'source.txt' };
  const units: any[] = evidenceUnits(source, fs.readFileSync(textPath, 'utf8'), []);
  const output: any = {
    skipped: [],
    cards: [
      {
        term: 'Name the three-sided shape',
        answer: 'Triangle',
        question: 'Which shape has three straight sides?',
        wrong: ['Circle', 'Square', 'Pentagon'],
        why: 'A triangle has three straight sides.',
        topic: 'Shapes',
        aliases: [],
        image: null,
        refs: [units[0].ref],
      },
    ],
  };
  assert.deepEqual(cardErrors(output.cards[0], units), []);
  output.cards[0].refs = ['unknown'];
  assert.match(cardErrors(output.cards[0], units)[0], /evidence IDs/);
  output.cards[0].refs = [units[0].ref];
  output.cards[0].image = {
    ref: units[0].ref,
    side: 'question',
    alt: 'triangle',
    caption: '',
    reason: 'cue',
    matchUsable: false,
    revealsAnswer: true,
    crop: [0, 0, 1, 1],
  };
  assert.match(cardErrors(output.cards[0], units)[0], /attached visual|reveals/);
});

test('generation splits a stuck part so the set still arrives', async () => {
  const course = {
    id: 'split-course',
    name: 'Split course',
    code: '',
    description: '',
    color: 'blue',
    createdAt: new Date().toISOString(),
    archived: false,
  };
  const sourcePath = path.join(dir, 'split-source.bin');
  const textPath = path.join(dir, 'split-extracted.txt');
  fs.writeFileSync(textPath, '[Page 1]\nAlpha definition.\n\n[Page 2]\nBeta definition.');
  const source: any = {
    id: 'split-source',
    courseId: course.id,
    name: 'split.pdf',
    size: 1,
    kind: 'PDF',
    path: sourcePath,
    textPath,
    status: 'ready',
    error: null,
    createdAt: new Date().toISOString(),
  };
  const { put, all } = await import('../server/db');
  put('courses', course);
  put('sources', source);
  const job: any = {
    id: 'split-job',
    kind: 'set',
    courseId: course.id,
    payload: { title: 'Split set', instructions: '', sourceIds: [source.id] },
    status: 'running',
    stage: '',
    progress: 0,
    error: null,
    resultId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  put('jobs', job);
  let smallParts = 0;
  const fake = async (options: any) => {
    const evidence = options.request.evidence || [];
    if (options.part.startsWith('review-'))
      return { issues: [], missing: [], summary: 'Covered the supplied evidence.' };
    if (!options.part.startsWith('batch-')) return { replacements: [], additions: [], skipped: [] };
    if (evidence.length > 1)
      throw Error('The model ran out of output space before returning cards.');
    smallParts++;
    const key = options.part.slice(-8);
    return {
      cards: [
        {
          term: `Target ${key}`,
          answer: `Answer ${key}`,
          question: `What is target ${key}?`,
          wrong: ['Wrong A', 'Wrong B', 'Wrong C'],
          why: 'The supplied evidence supports this target.',
          topic: 'General',
          aliases: [],
          refs: evidence.map((u: any) => u.ref),
          image: null,
        },
      ],
      skipped: [],
    };
  };
  await generateSet(job, fake as any);
  const saved = all<any>('sets').find((set) => set.title === 'Split set');
  assert.ok(saved);
  assert.equal(all<any>('cards').filter((card) => card.setId === saved.id).length, 2);
  assert.equal(smallParts, 2);
  const pipeline = JSON.parse(
    fs.readFileSync(path.join(dir, 'jobs', job.id, 'pipeline.json'), 'utf8'),
  );
  const parentPath = path.join(
    dir,
    'jobs',
    job.id,
    `batch-${pipeline.states[0].key}-checkpoint.json`,
  );
  assert.ok(fs.existsSync(parentPath), 'Split completion saves a parent checkpoint');
  fs.unlinkSync(parentPath); // Reproduce checkpoints written by older versions.
  const resumed = {
    ...job,
    id: 'split-resumed',
    payload: { ...job.payload, resumeFromJobId: job.id },
  };
  put('jobs', resumed);
  await generateSet(resumed, async () => {
    throw Error('Saved split children and review must resume without model calls');
  });
  assert.equal(all<any>('jobs').find((item) => item.id === resumed.id).status, 'completed');

  // A partially finished split must call only its missing child, never the parent.
  const childFiles = fs
    .readdirSync(path.join(dir, 'jobs', job.id))
    .filter((name) => name.startsWith('batch-') && name.endsWith('-checkpoint.json'));
  fs.unlinkSync(path.join(dir, 'jobs', job.id, childFiles[0]));
  const partial = {
    ...job,
    id: 'split-partial',
    payload: { ...job.payload, resumeFromJobId: job.id },
  };
  put('jobs', partial);
  let missingCalls = 0;
  await generateSet(partial, async (options: any) => {
    assert.equal(options.request.evidence.length, 1, 'Do not retry the large parent');
    assert.equal(all<any>('jobs').find((item) => item.id === partial.id).details.stagedCards, 1);
    missingCalls++;
    return fake(options);
  });
  assert.equal(missingCalls, 1);

  assert.equal(all<any>('jobs').find((item) => item.id === job.id).status, 'completed');
});

test('generation publishes the set with review notes instead of failing', async () => {
  const course = {
    id: 'notes-course',
    name: 'Notes course',
    code: '',
    description: '',
    color: 'green',
    createdAt: new Date().toISOString(),
    archived: false,
  };
  const textPath = path.join(dir, 'notes-extracted.txt');
  fs.writeFileSync(
    textPath,
    '[Page 1]\nA durable definition lives here.\n\n[Page 2]\nA second idea.',
  );
  const source: any = {
    id: 'notes-source',
    courseId: course.id,
    name: 'notes.pdf',
    size: 1,
    kind: 'PDF',
    path: path.join(dir, 'notes.bin'),
    textPath,
    status: 'ready',
    error: null,
    createdAt: new Date().toISOString(),
  };
  const { put, all } = await import('../server/db');
  put('courses', course);
  put('sources', source);
  const job: any = {
    id: 'notes-job',
    kind: 'set',
    courseId: course.id,
    payload: { title: 'Set with notes', instructions: '', sourceIds: [source.id] },
    status: 'running',
    stage: '',
    progress: 0,
    error: null,
    resultId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  put('jobs', job);
  const card = (key: string, refs: string[]) => ({
    term: `Target ${key}`,
    answer: `Answer ${key}`,
    question: `What is target ${key}?`,
    wrong: ['Wrong A', 'Wrong B', 'Wrong C'],
    why: 'The supplied evidence supports this target.',
    topic: 'General',
    aliases: [],
    refs,
    image: null,
  });
  const fake = async (options: any) => {
    const evidence = options.request.evidence || [];
    if (options.part.startsWith('review-'))
      return {
        issues: [{ index: 0, reason: 'Double-check this card against the source.' }],
        missing: [],
        summary: 'Mostly covered.',
      };
    if (options.part.startsWith('correction-'))
      return {
        replacements: (options.request.badCards || []).map((bad: any) => ({
          index: bad.index,
          card: bad.card,
        })),
        additions: [],
        skipped: [],
      };
    if (!options.part.startsWith('batch-')) return { replacements: [], additions: [], skipped: [] };
    return {
      cards: [
        card(
          options.part.slice(-8),
          evidence.map((u: any) => u.ref),
        ),
      ],
      skipped: [],
    };
  };
  await generateSet(job, fake as any);
  const saved = all<any>('sets').find((set) => set.title === 'Set with notes');
  assert.ok(saved);
  assert.equal(saved.coverage.qualityReview, 'issues-found');
  assert.ok(saved.warnings.some((warning: string) => /quality review/i.test(warning)));
  assert.equal(all<any>('jobs').find((item) => item.id === job.id).status, 'completed');
});

test('generation checkpoints batches and publishes only after a clean review', async () => {
  const course = {
    id: 'course',
    name: 'Test course',
    code: '',
    description: '',
    color: 'blue',
    createdAt: new Date().toISOString(),
    archived: false,
  };
  const sourcePath = path.join(dir, 'pipeline.txt');
  const textPath = path.join(dir, 'pipeline-extracted.txt');
  fs.writeFileSync(textPath, '[Page 1]\nDefinition one.\n\nDefinition two.');
  const source: any = {
    id: 'pipeline-source',
    courseId: course.id,
    name: 'pipeline.txt',
    size: 50,
    kind: 'TXT',
    path: sourcePath,
    textPath,
    status: 'ready',
    error: null,
    createdAt: new Date().toISOString(),
  };
  const { put, all } = await import('../server/db');
  put('courses', course);
  put('sources', source);
  const job: any = {
    id: 'pipeline-job',
    kind: 'set',
    courseId: course.id,
    payload: { title: 'Pipeline set', instructions: '', sourceIds: [source.id] },
    status: 'running',
    stage: '',
    progress: 0,
    error: null,
    resultId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  put('jobs', job);
  const fake = async (options: any) => {
    const evidence = options.request.evidence || [];
    if (options.part.startsWith('review-'))
      return { issues: [], missing: [], summary: 'Covered the supplied evidence.' };
    if (options.part.startsWith('correction-') || options.part.includes('-repair'))
      return {
        replacements: [],
        additions: [],
        skipped: evidence.map((u: any) => ({
          ref: u.ref,
          reason: 'Already covered by an existing card.',
        })),
      };
    const key = options.part.slice(-8);
    return {
      cards: [
        {
          term: `Target ${key}`,
          answer: `Answer ${key}`,
          question: `What is target ${key}?`,
          wrong: ['Wrong A', 'Wrong B', 'Wrong C'],
          why: 'The supplied evidence supports this target.',
          topic: 'General',
          aliases: [],
          refs: evidence.map((u: any) => u.ref),
          image: null,
        },
      ],
      skipped: [],
    };
  };
  await generateSet(job, fake as any);
  const saved = all<any>('sets').find((set) => set.title === 'Pipeline set');
  assert.ok(saved);
  assert.equal(all<any>('cards').filter((card) => card.setId === saved.id).length, 1);
  assert.equal(getJob(job.id).status, 'completed');
  const resumed: any = {
    id: 'pipeline-resumed',
    kind: 'set',
    courseId: course.id,
    payload: {
      title: 'Pipeline set',
      instructions: '',
      sourceIds: [source.id],
      resumeFromJobId: job.id,
    },
    status: 'running',
    stage: '',
    progress: 0,
    error: null,
    resultId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  put('jobs', resumed);
  let resumedCalls = 0;
  await generateSet(resumed, async () => {
    resumedCalls++;
    throw Error('A resumed job should not invoke Codex when its checkpoints match.');
  });
  assert.equal(resumedCalls, 0);
  assert.equal(getJob(resumed.id).status, 'completed');
  function getJob(id: string) {
    return all<any>('jobs').find((item) => item.id === id)!;
  }
});
