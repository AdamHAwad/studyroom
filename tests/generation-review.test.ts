import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewInParts, largeReview } from '../server/generation-review';

function fixture() {
  const cards = Array.from({ length: 25 }, (_, index) => ({
    index,
    term: `Target ${index}`,
    answer: `Answer ${index}`,
    topic: 'Concepts',
    refs: [`E${index}`],
    image: null,
  }));
  const request = {
    title: 'Set',
    instructions: 'Use English.',
    requirements: {
      cardCount: { min: 20, max: 30, quotes: [] },
      requirements: [{ instruction: 'Use English.', quote: 'Use English.' }],
      conflicts: [],
    },
    setPlan: null,
    cards,
    evidence: cards.map((c) => ({ ref: c.refs[0], text: `Evidence for ${c.index}` })),
    skipped: [],
    images: [],
  };
  const cache = new Map<string, any>();
  const options = {
    job: { id: 'job', payload: {} } as any,
    request,
    images: [],
    harness: 'codex',
    load: (name: string) => cache.get(name),
    save: (name: string, result: any) => {
      cache.set(name, result);
    },
    stage: (_stage: string) => {},
    assertActive: () => {},
    map: async <T, R>(items: T[], _limit: number, work: (item: T, index: number) => Promise<R>) => {
      const result: R[] = [];
      for (const [i, item] of items.entries()) result.push(await work(item, i));
      return result;
    },
  };
  return { options, cache };
}
function result(call: any) {
  return {
    issues: [],
    missing: [],
    summary: 'No material issues found in the assigned scope.',
    ...(call.part.startsWith('review-requirement-')
      ? {
          requirementChecks: [
            {
              requirementIndex: call.request.requirementIndex,
              satisfied: true,
              reason: 'English in the audited cards.',
            },
          ],
        }
      : {}),
  };
}

test('large reviews cover every card and evidence unit with bounded calls and resume from checkpoints', async () => {
  const { options } = fixture();
  assert.equal(largeReview(options.request), true);
  const cardIndices = new Set<number>(),
    evidenceRefs = new Set<string>();
  let calls = 0;
  const report = await reviewInParts({
    ...options,
    call: async (call: any) => {
      calls++;
      assert.equal(call.reasoningEffort, 'low');
      assert.equal(call.maxAttempts, 1);
      if (call.request.task.startsWith('Review only')) {
        assert.ok(call.request.cards.length <= 8);
        call.request.cards.forEach((c: any) => cardIndices.add(c.index));
      }
      if (call.request.task.startsWith('Check this evidence')) {
        assert.ok(call.request.evidence.length <= 12);
        call.request.evidence.forEach((u: any) => evidenceRefs.add(u.ref));
      }
      return result(call);
    },
  });
  assert.equal(cardIndices.size, 25);
  assert.equal(evidenceRefs.size, 25);
  assert.equal(report.requirementChecks.length, 1);
  assert.ok(calls > 1);
  await reviewInParts({
    ...options,
    call: async () => {
      throw Error('Do not repeat a saved review');
    },
  });
});

test('timeout splits only the failed review scope and saves that decision for retry', async () => {
  const { options } = fixture();
  let failures = 0;
  await reviewInParts({
    ...options,
    call: async (call: any) => {
      if (call.request.task.startsWith('Review only') && call.request.cards.length > 4) {
        failures++;
        throw Error('Timeout');
      }
      return result(call);
    },
  });
  assert.equal(failures, 3);
  await reviewInParts({
    ...options,
    call: async () => {
      throw Error('Saved split reviews should be reused');
    },
  });
});

test('review reference validation refuses unknown findings and never checkpoints them', async () => {
  const { options, cache } = fixture();
  await assert.rejects(
    reviewInParts({
      ...options,
      call: async () => ({
        issues: [{ index: 9999, reason: 'Invalid' }],
        missing: [],
        summary: 'Bad',
      }),
    }),
    /unknown card/,
  );
  assert.ok([...cache.keys()].every((key) => key.startsWith('review-split-')));
});

test('review cancellation stops subdivision instead of launching more calls', async () => {
  const { options } = fixture();
  let calls = 0;
  await assert.rejects(
    reviewInParts({
      ...options,
      assertActive: () => {
        if (calls) throw Error('Job cancelled');
      },
      call: async () => {
        calls++;
        throw Error('Timeout');
      },
    }),
    /cancelled/,
  );
  assert.equal(calls, 1);
});

test('requirement verdicts do not echo findings and reuse saved audits on retry', async () => {
  const { options } = fixture();
  options.request.requirements.requirements.push({
    instruction: 'Stay in scope.',
    quote: 'Stay in scope.',
  });
  let verdictCalls = 0;
  const report = await reviewInParts({
    ...options,
    call: async (call: any) => {
      if (call.part.startsWith('review-requirement-')) {
        verdictCalls++;
        assert.equal(call.request.issues.length, 1);
        const parsed = call.schema.parse(result(call));
        assert.deepEqual(Object.keys(parsed), ['requirementChecks']);
        return parsed;
      }
      return {
        ...result(call),
        issues: [{ index: call.request.cards[0]?.index ?? 0, reason: 'Check wording.' }].filter(
          (x) => x.index === 0,
        ),
      };
    },
  });
  assert.equal(verdictCalls, 2);
  assert.equal(report.issues.length, 1);
  await reviewInParts({
    ...options,
    call: async () => {
      throw Error('Must reuse saved checks');
    },
  });
});
