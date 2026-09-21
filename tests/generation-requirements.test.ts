import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateRequirements,
  validateSetPlan,
  validateCountPlan,
  countProblem,
  noRequirements,
  requirementFailures,
} from '../server/generation-requirements';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyroom-requirements-'));
process.env.STUDYROOM_DATA = dir;
const { generateSet } = await import('../server/generation');
const { db, put, all } = await import('../server/db');
after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('count bounds enforce exact, minimum, maximum and range independently', () => {
  for (const [min, max, inside, outside] of [
    [4, 6, 5, 7],
    [4, null, 9, 3],
    [null, 6, 2, 7],
    [4, 4, 4, 5],
  ]) {
    const requirements = { ...noRequirements, cardCount: { min, max, quotes: ['four cards'] } };
    assert.equal(countProblem(inside!, requirements), null);
    assert.ok(countProblem(outside!, requirements));
  }
  assert.equal(countProblem(1000, noRequirements), null);
  assert.throws(
    () =>
      validateRequirements(
        { ...noRequirements, cardCount: { min: 8, max: 4, quotes: ['text'] } },
        'text',
      ),
    /conflict/,
  );
  assert.throws(
    () =>
      validateRequirements(
        { ...noRequirements, cardCount: { min: 4, max: 6, quotes: ['invented'] } },
        'text',
      ),
    /quote/,
  );
  assert.throws(
    () =>
      validateRequirements(
        { ...noRequirements, conflicts: ['Exactly five and exactly seven.'] },
        'text',
      ),
    /clarification/,
  );
});

test('whole-set plans cannot repeat a per-batch limit or omit a batch', () => {
  const requirements = { ...noRequirements, cardCount: { min: 4, max: 6, quotes: [] } };
  const plan = {
    targetCount: 6,
    allocations: [
      { batchKey: 'a', count: 3, focus: 'A' },
      { batchKey: 'b', count: 3, focus: 'B' },
    ],
    explanation: 'Balanced priorities.',
  };
  assert.equal(validateSetPlan(plan, ['a', 'b'], requirements).targetCount, 6);
  assert.throws(
    () =>
      validateSetPlan(
        { ...plan, allocations: plan.allocations.map((a) => ({ ...a, count: 6 })) },
        ['a', 'b'],
        requirements,
      ),
    /add up/,
  );
  assert.throws(
    () =>
      validateSetPlan(
        { ...plan, allocations: [plan.allocations[0], plan.allocations[0]] },
        ['a', 'b'],
        requirements,
      ),
    /exactly once/,
  );
  assert.throws(
    () => validateSetPlan({ ...plan, targetCount: 7 }, ['a', 'b'], requirements),
    /maximum/,
  );
  assert.throws(
    () =>
      validateCountPlan({ keepIndices: [0, 0], additions: [], explanation: 'Bad' }, 3, 2, ['a']),
    /indices/,
  );
  assert.throws(
    () =>
      validateCountPlan(
        {
          keepIndices: [0],
          additions: [{ batchKey: 'a', count: 3, focus: 'More' }],
          explanation: 'Bad',
        },
        3,
        4,
        ['a'],
      ),
    /preserve/,
  );
  assert.throws(
    () =>
      requirementFailures([], {
        ...noRequirements,
        requirements: [{ instruction: 'English', quote: 'English' }],
      }),
    /every/,
  );
});

function fixture(name: string, instructions = 'Create between 4 and 6 cards. Write in English.') {
  const stamp = new Date().toISOString();
  const courseId = `course-${name}`;
  put('courses', { id: courseId, name, createdAt: stamp, archived: false });
  const textPath = path.join(dir, `${name}.txt`);
  fs.writeFileSync(
    textPath,
    '[Page 1]\n' +
      'A supported concept. '.repeat(220) +
      '\n[Page 2]\n' +
      'Another supported concept. '.repeat(180),
  );
  const sourceId = `source-${name}`;
  put('sources', {
    id: sourceId,
    courseId,
    name: `${name}.txt`,
    textPath,
    path: textPath,
    status: 'ready',
    createdAt: stamp,
  });
  const job: any = {
    id: `job-${name}`,
    kind: 'set',
    courseId,
    payload: { title: name, instructions, sourceIds: [sourceId] },
    status: 'running',
    createdAt: stamp,
    updatedAt: stamp,
  };
  put('jobs', job);
  return job;
}
function card(key: string, refs: string[]) {
  return {
    term: `Target ${key}`,
    answer: `Answer ${key}`,
    question: `Which answer describes ${key}?`,
    wrong: ['Wrong A', 'Wrong B', 'Wrong C'],
    why: 'The material supports this fact.',
    topic: 'Concepts',
    aliases: [],
    refs,
    image: null,
  };
}
function agent(overrides: Record<string, (options: any) => any> = {}) {
  return async (options: any) => {
    const request = options.request;
    if (overrides[request.task]) return overrides[request.task](options);
    if (options.part === 'requirements') {
      assert.equal(
        request.evidence,
        undefined,
        'Uploaded text must not be interpreted as user instructions',
      );
      return {
        cardCount: { min: 4, max: 6, quotes: ['between 4 and 6 cards'] },
        requirements: [{ instruction: 'Write in English.', quote: 'Write in English.' }],
        conflicts: [],
      };
    }
    if (options.part === 'set-plan') {
      assert.equal(request.batches.length, 2);
      return {
        targetCount: 6,
        allocations: request.batches.map((b: any) => ({
          batchKey: b.batchKey,
          weight: 3,
          focus: 'Cover distinct important targets.',
        })),
        explanation: 'Six targets across both sections.',
      };
    }
    if (options.part.startsWith('review-')) {
      assert.equal(request.instructions, 'Create between 4 and 6 cards. Write in English.');
      return {
        issues: [],
        missing: [],
        summary: 'Covered priorities within the limit.',
        requirementChecks: [
          { requirementIndex: 0, satisfied: true, reason: 'Cards are in English.' },
        ],
      };
    }
    if (request.task === 'create' || request.task === 'budget-repair') {
      return {
        cards: Array.from({ length: request.cardBudget.exact }, (_, i) =>
          card(
            `${options.part}-${i}`,
            request.evidence.map((u: any) => u.ref),
          ),
        ),
        skipped: [],
      };
    }
    throw Error(`Unexpected call ${options.part}`);
  };
}
function savedCards(job: any) {
  const set = all<any>('sets').find((s) => s.generationJobId === job.id);
  return set ? all<any>('cards').filter((c) => c.setId === set.id) : [];
}

test('constrained split batches share one budget and retries reuse the saved contract and plan', async () => {
  const job = fixture('split-budgets');
  const budgets: number[] = [];
  await generateSet(
    job,
    agent({
      create: (options) => {
        const request = options.request;
        if (request.evidence.length > 2) throw Error('Simulated timeout: split this batch');
        budgets.push(request.cardBudget.exact);
        return {
          cards: Array.from({ length: request.cardBudget.exact }, (_, i) =>
            card(
              `${options.part}-${i}`,
              request.evidence.map((u: any) => u.ref),
            ),
          ),
          skipped: [],
        };
      },
    }),
  );
  assert.equal(
    budgets.reduce((a, b) => a + b, 0),
    6,
  );
  assert.equal(savedCards(job).length, 6);
  const retry = {
    ...job,
    id: `${job.id}-retry`,
    payload: { ...job.payload, resumeFromJobId: job.id },
  };
  put('jobs', retry);
  await generateSet(retry, async () => {
    throw Error('No repeated model calls on checkpoint recovery');
  });
  assert.equal(savedCards(retry).length, 6);
  const changed = {
    ...job,
    id: `${job.id}-changed`,
    payload: { ...job.payload, instructions: 'Exactly two cards.', resumeFromJobId: job.id },
  };
  put('jobs', changed);
  await assert.rejects(
    generateSet(changed, async (options: any) => {
      assert.equal(options.part, 'requirements');
      throw Error('New instructions require a new contract');
    }),
    /new contract/,
  );
  assert.equal(savedCards(changed).length, 0);
});

test('count repair fixes overproduction before a batch is checkpointed', async () => {
  const job = fixture('batch-overflow');
  let repairs = 0;
  const baseline = agent();
  await generateSet(
    job,
    agent({
      create: (options) => ({
        cards: Array.from({ length: 8 }, (_, i) =>
          card(
            `${options.part}-${i}`,
            options.request.evidence.map((u: any) => u.ref),
          ),
        ),
        skipped: [],
      }),
      'budget-repair': (options) => {
        repairs++;
        return baseline(options);
      },
    }),
  );
  assert.equal(repairs, 2);
  assert.equal(savedCards(job).length, 6);
});

test('an unsupported minimum blocks publication instead of padding or silently lowering it', async () => {
  const job = fixture('shortfall');
  const tooFew = (options: any) => ({
    cards: [],
    skipped: options.request.evidence.map((u: any) => ({
      ref: u.ref,
      reason: 'No additional distinct supported targets.',
    })),
  });
  await assert.rejects(
    generateSet(job, agent({ create: tooFew, 'budget-repair': tooFew })),
    /budget|requirements|anything that can become cards/,
  );
  assert.equal(savedCards(job).length, 0);
});

test('deduplication shortfalls get targeted additions before the final count check', async () => {
  const job = fixture('deduplicated');
  let additions = 0;
  await generateSet(
    job,
    agent({
      create: (options) => {
        const request = options.request;
        if (options.part.startsWith('count-add-')) additions++;
        return {
          cards: Array.from({ length: request.cardBudget.exact }, (_, i) =>
            card(
              options.part.startsWith('count-add-') ? `new-${i}` : `shared-${i}`,
              request.evidence.map((u: any) => u.ref),
            ),
          ),
          skipped: [],
        };
      },
      'reconcile-count': (options) => ({
        keepIndices: options.request.cards.map((c: any) => c.index),
        additions: [
          {
            batchKey: options.request.batches[0].batchKey,
            count: 1,
            focus: 'A distinct missed concept.',
          },
        ],
        explanation: 'Restore the minimum after overlap removal.',
      }),
    }),
  );
  assert.equal(additions, 1);
  assert.equal(savedCards(job).length, 4);
});

test('review additions cannot escape the maximum and final selection is reviewed again', async () => {
  const job = fixture('review-overflow');
  const baseline = agent();
  let reviews = 0,
    selections = 0;
  await generateSet(job, async (options: any) => {
    if (options.part.startsWith('review-')) {
      reviews++;
      const report = await baseline(options);
      if (reviews === 1)
        report.missing = [
          { refs: [options.request.evidence[0].ref], reason: 'A higher-priority concept.' },
        ];
      return report;
    }
    if (options.part.startsWith('correction-'))
      return {
        replacements: [],
        additions: [card('important-new', [options.request.evidence[0].ref])],
        skipped: [],
      };
    if (options.request.task === 'reconcile-count') {
      selections++;
      assert.equal(options.request.cards.length, 7);
      return {
        keepIndices: [1, 2, 3, 4, 5, 6],
        additions: [],
        explanation: 'Keep the new priority and remove a weaker target.',
      };
    }
    return baseline(options);
  });
  assert.equal(selections, 1);
  assert.equal(reviews, 2);
  assert.equal(savedCards(job).length, 6);
  assert.ok(savedCards(job).some((c) => c.term === 'Target important-new'));
});

test('unresolved supplementary requirements block publication even when numeric bounds pass', async () => {
  const job = fixture('language-failure');
  const baseline = agent();
  await assert.rejects(
    generateSet(job, async (options: any) => {
      const result = await baseline(options);
      if (options.part.startsWith('review-'))
        result.requirementChecks = [
          { requirementIndex: 0, satisfied: false, reason: 'Some cards are not in English.' },
        ];
      return result;
    }),
    /still violates/,
  );
  assert.equal(savedCards(job).length, 0);
});

test('zero allocations skip lower-priority batches without spending another whole-set budget', async () => {
  const job = fixture('zero-budget');
  const baseline = agent();
  let generationCalls = 0;
  await generateSet(job, async (options: any) => {
    if (options.part === 'set-plan')
      return {
        targetCount: 4,
        allocations: options.request.batches.map((b: any, i: number) => ({
          batchKey: b.batchKey,
          weight: i ? 0 : 4,
          focus: i ? 'Repeated lower-priority material.' : 'Core targets.',
        })),
        explanation: 'Focus the available cards on core material.',
      };
    if (options.request.task === 'create') {
      generationCalls++;
      assert.equal(options.request.cardBudget.exact, 4);
    }
    return baseline(options);
  });
  assert.equal(generationCalls, 1);
  assert.equal(savedCards(job).length, 4);
});

test('supported batch shortfalls survive retries and older uncheckpointed outputs are recovered', async () => {
  const job = fixture('supported-shortfall');
  const baseline = agent();
  let firstRequest: any;
  let firstPart = '';
  await generateSet(job, async (options: any) => {
    if (options.request.task === 'create' && options.request.batch.index === 1) {
      firstRequest = options.request;
      firstPart = options.part;
      const output = await baseline(options);
      output.cards.pop();
      return output;
    }
    assert.notEqual(
      options.request.task,
      'budget-repair',
      'Do not force a supported batch up to its target',
    );
    return baseline(options);
  });
  assert.equal(savedCards(job).length, 5);
  const jobDir = path.join(dir, 'jobs', job.id);
  const checkpointPath = path.join(jobDir, `${firstPart}-checkpoint.json`);
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  fs.writeFileSync(
    path.join(jobDir, `${firstPart}-count-repair-attempt-1-request.json`),
    JSON.stringify(firstRequest),
  );
  fs.writeFileSync(
    path.join(jobDir, `${firstPart}-count-repair-attempt-1-result.json`),
    JSON.stringify(checkpoint.result),
  );
  fs.unlinkSync(checkpointPath);
  const retry = {
    ...job,
    id: `${job.id}-retry`,
    payload: { ...job.payload, resumeFromJobId: job.id },
  };
  put('jobs', retry);
  await generateSet(retry, async () => {
    throw Error('Recover the saved response instead of generating it again');
  });
  assert.equal(savedCards(retry).length, 5);
});

test('a question-only batch can return zero while another batch fills a whole-set shortfall', async () => {
  const job = fixture('question-only');
  const baseline = agent();
  let additions = 0;
  await generateSet(job, async (options: any) => {
    if (options.request.task === 'create' && options.request.batch?.index === 1)
      return {
        cards: [],
        skipped: options.request.evidence.map((u: any) => ({
          ref: u.ref,
          reason:
            'Study-guide questions without answers; covered using instructional evidence elsewhere.',
        })),
      };
    if (options.request.task === 'reconcile-count')
      return {
        keepIndices: options.request.cards.map((c: any) => c.index),
        additions: [
          {
            batchKey: options.request.batches[1].batchKey,
            count: 1,
            focus: 'One additional supported instructional target.',
          },
        ],
        explanation: 'Meet the whole-set minimum using explanatory evidence.',
      };
    if (options.part.startsWith('count-add-')) additions++;
    return baseline(options);
  });
  assert.equal(additions, 1);
  assert.equal(savedCards(job).length, 4);
});

test('explicit approval publishes with qualitative warnings while preserving count bounds', async () => {
  const job = fixture('approved-warnings');
  job.payload.allowQualityWarnings = true;
  put('jobs', job);
  const baseline = agent();
  await generateSet(job, async (options: any) => {
    const result = await baseline(options);
    if (options.part.startsWith('review-'))
      result.requirementChecks = [
        { requirementIndex: 0, satisfied: false, reason: 'Some feedback wording could improve.' },
      ];
    return result;
  });
  const set = all<any>('sets').find((s) => s.generationJobId === job.id);
  assert.equal(savedCards(job).length, 6);
  assert.equal(set.coverage.qualityReview, 'issues-found');
  assert.ok(set.warnings.some((w: string) => w.includes('Published with your approval')));
});
