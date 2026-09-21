import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Job, StudyDocument, RetrievalTerm } from '../src/types';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyroom-materials-'));
process.env.STUDYROOM_DATA = dir;
const {
  generateStudySet,
  generateDocument,
  normalizeCards,
  selectPacketTerms,
  fillResponseDefaults,
  fastCardsSchema,
} = await import('../server/material-generation');
const { renderDocument, packetPages } = await import('../server/document-print');
const { put, get, all, db } = await import('../server/db');
const { evidenceUnits } = await import('../server/generation-contract');
const { z } = await import('zod');
after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const courseId = 'course';
put('courses', { id: courseId, name: 'Psychology' });
fs.writeFileSync(
  path.join(dir, 'notes.txt'),
  'Sensation detects stimuli. Perception interprets sensory input. Transduction converts stimulus energy to neural signals.',
);
const source: any = {
  id: 'source',
  courseId,
  name: 'Notes',
  status: 'ready',
  textPath: path.join(dir, 'notes.txt'),
};
put('sources', source);
const evidence = evidenceUnits(source, fs.readFileSync(source.textPath, 'utf8'), []);
const term = (i = 0): RetrievalTerm => ({
  term: `Concept ${i}`,
  topic: 'Sensation',
  definition: `Hidden definition ${i}`,
  example: `Hidden personal example ${i}`,
  cue: 'Explain and apply this concept.',
  memoryAid: '',
  compareWith: '',
  importance: i < 5 ? 5 : 3,
  refs: [evidence[0].ref],
});
const draft = {
  term: 'Sensation',
  answer: 'Detection of stimuli',
  question: 'What is sensation?',
  wrong: ['Interpretation', 'Memory', 'Reasoning'],
  why: 'Receptors detect stimuli.',
  topic: 'Sensation',
  aliases: [],
  refs: [evidence[0].ref],
  image: null,
};
function job(kind: Job['kind'], payload: any = {}): Job {
  const j = {
    id: crypto.randomUUID(),
    kind,
    courseId,
    status: 'running',
    stage: '',
    progress: 0,
    error: null,
    resultId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    payload: {
      sourceIds: [source.id],
      title: 'Practice',
      instructions: '',
      variant: 'test-variant',
      ...payload,
    },
  };
  put('jobs', j);
  return j;
}
test('focus and requested counts cannot block a usable first-draft study set', async () => {
  const j = job('set', { instructions: 'Exactly 100 cards, focus on exam success, get 100%.' });
  const calls: string[] = [];
  await generateStudySet(j, async (options) => {
    calls.push(options.part);
    return { cards: [draft], skipped: [] };
  });
  assert.equal(calls.length, 1);
  const saved = get<Job>('jobs', j.id)!;
  assert.equal(saved.status, 'completed');
  assert.equal(all('cards').filter((c) => c.setId === saved.resultId).length, 1);
  assert.equal(get('sets', saved.resultId!)?.coverage.qualityReview, 'optional');
});
test('local normalization fixes choices, revealing images and crops without agent repair', () => {
  const visual = { ...evidence[0], ref: 'V1', assetId: 'asset', text: '' };
  const result = normalizeCards(
    [
      {
        ...draft,
        refs: [evidence[0].ref, 'unknown'],
        wrong: [draft.answer, 'Memory', 'Memory', 'Reasoning'],
        image: {
          ref: 'V1',
          side: 'question',
          revealsAnswer: true,
          matchUsable: true,
          crop: [0.9, 0, 1, 1],
        },
      },
      draft,
    ],
    [...evidence, visual],
  );
  assert.equal(result.cards.length, 1);
  assert.deepEqual(result.cards[0].distractors, ['Memory', 'Reasoning']);
  assert.equal(result.cards[0].image.side, 'answer');
  assert.equal(result.cards[0].image.crop, null);
  assert.equal(result.cards[0].image.matchUsable, false);
  assert.ok(result.warnings.length);
  assert.ok(result.cards[0].sources.every((s: any) => s.sourceId === source.id));
});
test('missing optional editorial fields are filled instead of rejecting a complete answer', () => {
  const value = fillResponseDefaults(
    { cards: [{ term: 'Cue', answer: 'Answer' }] },
    z.toJSONSchema(fastCardsSchema),
  );
  assert.ok(fastCardsSchema.safeParse(value).success);
  assert.equal(value.cards[0].answer, 'Answer');
  assert.deepEqual(value.cards[0].wrong, []);
});
test('retrieval packets prioritize terms, preserve grouping, and fit the twenty-side target', () => {
  const list = Array.from({ length: 100 }, (_, i) => term(i));
  list[99].importance = 5;
  const packet = selectPacketTerms(list);
  assert.equal(packet.terms.length, 76);
  assert.equal(packet.omittedTerms.length, 24);
  assert.ok(packet.terms.some((t) => t.term === 'Concept 99'));
  assert.equal(packetPages(packet.terms).length + 1, 20);
  const paired = [term(1), { ...term(2), compareWith: 'Concept 1' }];
  assert.equal(packetPages(paired)[0][0].terms.length, 2);
});
test('packet prints brief definitions beside terms and keeps worked examples in the separate key', async () => {
  const j = job('retrieval-packet');
  await generateDocument(j, async () => ({
    terms: [term()],
    overview: ['Sensory systems encode information.'],
    essentialQuestions: ['How do stimuli become experience?'],
    warnings: [],
  }));
  const doc = get<StudyDocument>('documents', get<Job>('jobs', j.id)!.resultId!)!;
  const student = renderDocument(doc, '<script>bad()</script>');
  const answers = renderDocument(doc, 'Psychology', true);
  assert.match(student, /Explain it in your own words/);
  assert.match(student, /<strong>Concept 0:<\/strong> Hidden definition 0/);
  assert.doesNotMatch(student, /Hidden personal example/);
  assert.match(answers, /Hidden definition 0/);
  assert.match(student, /&lt;script&gt;/);
  assert.doesNotMatch(student, /<script>bad/);
  assert.equal(doc.content.terms.length, 1);
});
test('exam preserves section structure, uses wider course evidence, and excludes previous questions', async () => {
  const j = job('practice-exam', { referenceSourceIds: [source.id] });
  let questionRequest: any;
  let calls = 0;
  const fake = async (options: any) => {
    calls++;
    const request = options.request;
    if (request.task === 'inventory')
      return { terms: [term()], overview: [], essentialQuestions: [], warnings: [] };
    if (request.task === 'exam-plan')
      return {
        instructions: 'Answer all questions',
        durationMinutes: 20,
        style: { font: 'serif', columns: 1, optionLayout: 'stacked', headingCase: 'uppercase' },
        sections: [
          {
            title: 'Short response',
            kind: 'short-answer',
            instructions: 'Explain your reasoning.',
            count: 1,
            pointsEach: 6,
          },
        ],
        warnings: [],
      };
    questionRequest = request;
    return {
      questions: [
        {
          prompt: 'Explain a new scenario.',
          stimulus: '',
          options: [],
          answer: 'Hidden answer',
          explanation: 'Hidden explanation',
          points: 6,
          lines: 5,
          parts: [],
          refs: [evidence[0].ref],
          visualRef: '',
        },
      ],
      warnings: [],
    };
  };
  await generateDocument(j, fake);
  assert.equal(calls, 3);
  const first = get<StudyDocument>('documents', get<Job>('jobs', j.id)!.resultId!)!;
  assert.equal(first.content.sections[0].questions.length, 1);
  assert.equal(first.content.durationMinutes, 20);
  assert.doesNotMatch(renderDocument(first, 'Psychology'), /Hidden answer|Hidden explanation/);
  assert.match(renderDocument(first, 'Psychology', true), /Hidden answer/);
  assert.equal(questionRequest.sampleExams[0].ref, evidence[0].ref);
  assert.ok(questionRequest.courseInventory.length);
  const next = job('practice-exam', { referenceSourceIds: [source.id], variant: 'new-variant' });
  await generateDocument(next, fake);
  assert.ok(questionRequest.previousQuestions.includes('Explain a new scenario.'));
});
test('cancelled document jobs never publish their generated output', async () => {
  const j = job('retrieval-packet');
  const count = all('documents').length;
  await assert.rejects(
    () =>
      generateDocument(j, async () => {
        put('jobs', { ...j, status: 'cancelled' });
        return { terms: [term()], overview: [], essentialQuestions: [], warnings: [] };
      }),
    /cancelled/,
  );
  assert.equal(all('documents').length, count);
});
test('a restart reuses matching checkpoints without another agent call', async () => {
  const j = job('retrieval-packet');
  let calls = 0;
  const fake = async () => {
    calls++;
    return { terms: [term()], overview: [], essentialQuestions: [], warnings: [] };
  };
  await generateDocument(j, fake);
  put('jobs', { ...j, status: 'running', resultId: null });
  await generateDocument(j, fake);
  assert.equal(calls, 1);
});

test('failed document parts drain workers and recover saved responses alongside checkpoints', async () => {
  const largeSource = {
    ...source,
    id: 'recovery-source',
    textPath: path.join(dir, 'recovery.txt'),
  };
  fs.writeFileSync(
    largeSource.textPath,
    Array.from({ length: 40 }, (_, i) => `Concept ${i}: ` + 'Course material. '.repeat(62)).join(
      '\n\n',
    ),
  );
  put('sources', largeSource);
  const previous = job('retrieval-packet', { sourceIds: [largeSource.id] });
  let started = 0;
  let finished = 0;
  await assert.rejects(
    () =>
      generateDocument(previous, async (options) => {
        const index = started++;
        const value = { terms: [term(index)], overview: [], essentialQuestions: [], warnings: [] };
        if (index === 0) {
          const folder = path.join(dir, 'jobs', previous.id);
          fs.mkdirSync(folder, { recursive: true });
          const prefix = path.join(folder, options.part + '-attempt-1');
          fs.writeFileSync(prefix + '-request.json', JSON.stringify(options.request));
          fs.writeFileSync(prefix + '-schema.json', JSON.stringify(z.toJSONSchema(options.schema)));
          fs.writeFileSync(
            prefix + '-context.json',
            JSON.stringify({ cacheKey: options.cacheKey }),
          );
          fs.writeFileSync(
            prefix + '-events.jsonl',
            [
              { type: 'text', part: { type: 'text', messageID: 'draft', text: '{"terms":[' } },
              {
                type: 'text',
                part: { type: 'text', messageID: 'final', text: JSON.stringify(value) },
              },
            ]
              .map((e) => JSON.stringify(e))
              .join('\n'),
          );
          throw Error('Old parser rejected joined text');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        finished++;
        return value;
      }),
    /Old parser/,
  );
  assert.equal(started, 3);
  assert.equal(finished, 2, 'Failure waits for other calls to save their work');
  assert.equal(
    fs.readdirSync(path.join(dir, 'jobs', previous.id)).filter((n) => n.endsWith('-ready.json'))
      .length,
    2,
  );
  put('jobs', { ...previous, status: 'failed' });
  const resumed = job('retrieval-packet', { ...previous.payload, resumeFromJobId: previous.id });
  await generateDocument(resumed, async () => {
    throw Error('No model call should be needed');
  });
  const saved = get<Job>('jobs', resumed.id)!;
  assert.equal(saved.status, 'completed');
  assert.equal(get<StudyDocument>('documents', saved.resultId!)!.content.terms.length, 3);
  const recovered = fs
    .readdirSync(path.join(dir, 'jobs', resumed.id))
    .find((n) => n.startsWith('inventory-') && n.endsWith('-ready.json'))!;
  assert.ok(
    JSON.parse(fs.readFileSync(path.join(dir, 'jobs', resumed.id, recovered), 'utf8'))
      .recoveredFrom,
  );
});

test('editorial defaults cannot turn unrelated JSON into a completed document', async () => {
  const j = job('retrieval-packet');
  await assert.rejects(
    () => generateDocument(j, async () => ({ warnings: [] })),
    /content is missing/,
  );
  assert.equal(get<Job>('jobs', j.id)?.resultId, null);
});

test('retry imports a legacy saved draft without repeating generation or review', async () => {
  const previous = job('set');
  put('jobs', { ...previous, status: 'failed', error: 'Review timed out' });
  const folder = path.join(dir, 'jobs', previous.id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, 'batch-legacy-checkpoint.json'),
    JSON.stringify({ result: { cards: [draft], skipped: [] } }),
  );
  const resumed = job('set', { resumeFromJobId: previous.id });
  await generateStudySet(resumed, async () => {
    throw Error('Saved source-matched cards should not call the agent.');
  });
  assert.equal(get<Job>('jobs', resumed.id)?.status, 'completed');
  const changed = job('set', { resumeFromJobId: previous.id, instructions: 'Different focus' });
  let calls = 0;
  await generateStudySet(changed, async () => {
    calls++;
    return { cards: [draft], skipped: [] };
  });
  assert.equal(calls, 1);
});
