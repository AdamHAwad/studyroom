import test from 'node:test';
import assert from 'node:assert/strict';
import { allocatePlan, planSet, planningBriefs } from '../server/generation-planner';
import { noRequirements } from '../server/generation-requirements';
import type { Batch } from '../server/generation-contract';

const requirements = {
  ...noRequirements,
  cardCount: { min: 200, max: 300, quotes: ['200-300 cards'] },
};
const batches: Batch[] = Array.from({ length: 13 }, (_, i) => ({
  key: `batch-${i}`,
  images: [],
  units: Array.from({ length: 12 }, (_, j) => ({
    ref: `E${i}-${j}`,
    sourceId: `source-${i}`,
    name: 'Exam material',
    locator: `Page ${j + 1}`,
    text: 'Supported course knowledge. '.repeat(200),
  })),
}));
const priorities = (items: any[]) =>
  items.map((b) => ({ batchKey: b.batchKey, weight: 3, focus: 'Core knowledge.' }));
function fixture() {
  const cache = new Map<string, unknown>();
  return {
    cache,
    options: {
      job: {
        id: 'planner-test',
        payload: { title: 'Unit exam', instructions: '200-300 cards' },
      } as any,
      requirements,
      batches,
      harness: 'codex',
      load: (key: string) => cache.get(key),
      save: (key: string, result: unknown) => {
        cache.set(key, result);
      },
      stage: (_stage: string) => {},
      assertActive: () => {},
    },
  };
}

test('integer budgets sum exactly and preserve zero priorities for every allowed size', () => {
  const weights = [
    { batchKey: 'a', weight: 5, focus: 'High priority' },
    { batchKey: 'b', weight: 2, focus: 'Secondary' },
    { batchKey: 'c', weight: 0, focus: 'Administrative' },
  ];
  for (let target = 200; target <= 300; target++) {
    const plan = allocatePlan(target, weights, requirements, 'Prioritized content.');
    assert.equal(
      plan.allocations.reduce((sum, a) => sum + a.count, 0),
      target,
    );
    assert.equal(plan.allocations[2].count, 0);
    assert.ok(plan.allocations[0].count > plan.allocations[1].count);
  }
  assert.throws(() => allocatePlan(301, weights, requirements, 'Invalid'), /maximum/);
  assert.throws(
    () =>
      allocatePlan(
        250,
        weights.map((w) => ({ ...w, weight: 0 })),
        requirements,
        'Empty',
      ),
    /no supported/,
  );
});

test('planning summaries are bounded independently of document length', () => {
  const brief = planningBriefs(batches);
  assert.equal(brief.length, 13);
  assert.ok(JSON.stringify(brief).length < 11000);
  assert.ok(brief.every((b) => b.topics.length <= 4 && b.topics.every((s) => s.length <= 85)));
});

test('a planning timeout falls back to checkpointed groups without repeating the failed overview', async () => {
  const { options } = fixture();
  let overviewCalls = 0,
    groupCalls = 0;
  const first = async (call: any) => {
    assert.equal(call.reasoningEffort, 'low');
    assert.equal(call.maxAttempts, 1);
    assert.equal(call.timeoutMs, 120000);
    assert.equal(call.skill, '.agents/skills/plan-set/SKILL.md');
    if (call.part === 'set-plan') {
      overviewCalls++;
      throw Error('The set-plan step exceeded 120 seconds.');
    }
    assert.ok(call.request.batches.length <= 6);
    groupCalls++;
    if (groupCalls === 2) throw Error('Interrupted group');
    return { allocations: priorities(call.request.batches) };
  };
  await assert.rejects(planSet({ ...options, call: first }), /Interrupted group/);
  assert.equal(overviewCalls, 1);
  const resumedGroups: string[] = [];
  const plan = await planSet({
    ...options,
    call: async (call: any) => {
      assert.notEqual(call.part, 'set-plan');
      resumedGroups.push(call.part);
      return { allocations: priorities(call.request.batches) };
    },
  });
  assert.deepEqual(resumedGroups, ['set-plan-group-2', 'set-plan-group-3']);
  assert.equal(plan.targetCount, 250);
  assert.equal(
    plan.allocations.reduce((sum, a) => sum + a.count, 0),
    250,
  );
});

test('invalid priority membership uses the small-group path instead of trusting incomplete output', async () => {
  const { options } = fixture();
  const plan = await planSet({
    ...options,
    call: async (call: any) => {
      if (call.part === 'set-plan')
        return {
          targetCount: 250,
          allocations: priorities(call.request.batches.slice(1)),
          explanation: 'Missing one batch.',
        };
      return { allocations: priorities(call.request.batches) };
    },
  });
  assert.equal(plan.allocations.length, batches.length);
});

test('cancellation or unavailable service prevents fallback calls', async () => {
  const { options } = fixture();
  let calls = 0;
  await assert.rejects(
    planSet({
      ...options,
      assertActive: () => {
        if (calls) throw Error('Job cancelled');
      },
      call: async () => {
        calls++;
        throw Error('Interrupted');
      },
    }),
    /cancelled/,
  );
  assert.equal(calls, 1);
});

test('missing text does not discard image-only evidence before the generator inspects it', async () => {
  const { options } = fixture();
  const visual: Batch = {
    key: 'visual',
    images: [{ id: 'figure' } as any],
    units: [
      {
        ref: 'Vfigure',
        sourceId: 'source',
        name: 'Diagram',
        locator: 'Page 1',
        text: 'Inspect the attached visual.',
        assetId: 'figure',
      },
    ],
  };
  const plan = await planSet({
    ...options,
    batches: [batches[0], visual],
    call: async () => ({
      targetCount: 250,
      explanation: 'A bounded selection.',
      allocations: [
        { batchKey: batches[0].key, weight: 5, focus: 'Core concepts' },
        { batchKey: 'visual', weight: 0, focus: 'No textual topics supplied.' },
      ],
    }),
  });
  assert.ok(plan.allocations.find((a) => a.batchKey === 'visual')!.count > 0);
  assert.equal(
    plan.allocations.reduce((sum, a) => sum + a.count, 0),
    250,
  );
});
