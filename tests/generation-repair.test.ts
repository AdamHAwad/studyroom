import test from 'node:test';
import assert from 'node:assert/strict';
import { completeTargetedRepair, relatedRepairEvidence } from '../server/generation-repair';

const card = (ref: string) => ({
  term: 'Neuropsychology: research method',
  answer: 'Test battery',
  question: 'Which assessment?',
  wrong: ['A', 'B', 'C'],
  why: 'Supported rationale.',
  topic: 'Neuropsychology',
  aliases: [],
  refs: [ref],
  image: null,
});
const units = [
  {
    ref: 'Ekey',
    sourceId: 'exam',
    name: 'Exam',
    locator: 'Page 1',
    text: 'Neuropsychology: test battery.',
  },
  {
    ref: 'Electure',
    sourceId: 'lecture',
    name: 'Instructional material',
    locator: 'Page 4',
    text: 'Neuropsychology studies psychological effects of brain damage using cognitive test batteries to assess affected functions.',
  },
  {
    ref: 'Eother',
    sourceId: 'lecture',
    name: 'Instructional material',
    locator: 'Page 5',
    text: 'Membranes contain lipid bilayers.',
  },
];
function fixture() {
  const cache = new Map<string, any>();
  return {
    cache,
    options: {
      job: { id: 'repair-job' } as any,
      harness: 'codex',
      units,
      assets: [],
      request: {
        badCards: [4, 9].map((index) => ({
          index,
          card: card('Ekey'),
          errors: ['Explain why neuropsychology uses a test battery.'],
        })),
        evidence: [units[0]],
        missing: [],
        images: [],
      },
      initial: { replacements: [{ index: 4, card: card('Ekey') }], additions: [], skipped: [] },
      load: (name: string) => cache.get(name),
      save: (name: string, result: any) => {
        cache.set(name, structuredClone(result));
      },
      assertActive: () => {},
      stage: (_stage: string) => {},
    },
  };
}

test('retrieval adds instructional evidence from another supplied source', () => {
  const extra = relatedRepairEvidence(
    card('Ekey'),
    ['Explain its rationale.'],
    units,
    new Set(['Ekey']),
  );
  assert.equal(extra[0].ref, 'Electure');
  assert.ok(!extra.some((u) => u.ref === 'Ekey'));
});

test('partial repairs preserve completed indices and repair only omissions with supporting evidence', async () => {
  const { options } = fixture();
  let calls = 0;
  const repaired = await completeTargetedRepair({
    ...options,
    call: async (call: any) => {
      calls++;
      assert.deepEqual(
        call.request.badCards.map((b: any) => b.index),
        [9],
      );
      assert.ok(call.request.evidence.some((u: any) => u.ref === 'Electure'));
      assert.equal(call.reasoningEffort, 'low');
      return { replacements: [{ index: 9, card: card('Electure') }], additions: [], skipped: [] };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(
    repaired.replacements.map((r) => r.index),
    [4, 9],
  );
  await completeTargetedRepair({
    ...options,
    call: async () => {
      throw Error('Do not repeat completed repairs');
    },
  });
});

test('a failed missing-card call retains the completed replacements for retry', async () => {
  const { options, cache } = fixture();
  await assert.rejects(
    completeTargetedRepair({
      ...options,
      call: async () => {
        throw Error('Timeout');
      },
    }),
    /Timeout/,
  );
  assert.ok([...cache.values()].some((p) => p.replacements?.some((r: any) => r.index === 4)));
  const result = await completeTargetedRepair({
    ...options,
    call: async () => ({
      replacements: [{ index: 9, card: card('Electure') }],
      additions: [],
      skipped: [],
    }),
  });
  assert.equal(result.replacements.length, 2);
});

test('local renumbering and unsupported evidence cannot be silently applied', async () => {
  for (const replacement of [
    { index: 0, card: card('Electure') },
    { index: 9, card: card('unknown') },
  ]) {
    const { options } = fixture();
    await assert.rejects(
      completeTargetedRepair({
        ...options,
        call: async () => ({ replacements: [replacement], additions: [], skipped: [] }),
      }),
      /still needs a supported correction/,
    );
  }
});
