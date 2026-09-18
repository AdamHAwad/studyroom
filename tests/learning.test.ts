import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, emptyProgress, writtenCorrect, mcqChoices } from '../server/learning';
import { buildSessionQuestions } from '../server/questions';
import type { Attempt, Card } from '../src/types';
const event = (patch: Partial<Attempt> = {}): Attempt => ({
  id: 'a',
  cardId: 'c',
  sessionId: 's',
  setId: 'set',
  courseId: 'course',
  mode: 'learn',
  kind: 'mcq',
  correct: true,
  response: 'A',
  durationMs: 1000,
  createdAt: '2026-09-10T12:00:00.000Z',
  cardVersion: 1,
  ...patch,
});
test('self-ratings never produce objective accuracy or spaced mastery', () => {
  let p = advance(undefined, event({ kind: 'self' }));
  assert.equal(p.objectiveAttempts, 0);
  assert.equal(p.status, 'new');
  p = advance(p, event({ kind: 'self', correct: false }));
  assert.equal(p.status, 'learning');
  assert.equal(p.dueAt, event().createdAt);
});
test('only separated successes accumulate retained status', () => {
  let p = advance(undefined, event());
  assert.equal(p.streak, 1);
  p = advance(p, event({ createdAt: '2026-09-10T12:00:03.000Z' }));
  assert.equal(p.streak, 1);
  p = advance(p, event({ createdAt: '2026-09-11T12:01:00.000Z' }));
  assert.equal(p.streak, 2);
  p = advance(p, event({ createdAt: '2026-09-13T12:02:00.000Z', kind: 'written' }));
  assert.equal(p.streak, 3);
  assert.equal(p.status, 'retained');
  assert.equal(p.recallAttempts, 1);
  assert.equal(p.recognitionAttempts, 3);
});
test('misses reset scheduling confidence and schedule a short review', () => {
  let p = advance(undefined, event());
  p = advance(p, event({ correct: false, createdAt: '2026-09-11T12:00:00.000Z' }));
  assert.equal(p.streak, 0);
  assert.equal(p.status, 'learning');
  assert.equal(p.dueAt, '2026-09-11T12:10:00.000Z');
  assert.equal(p.correct, 1);
  assert.equal(p.objectiveAttempts, 2);
});
test('written grading accepts normalized aliases but preserves meaningful signs and units', () => {
  const c = { definition: '20 m/s', aliases: ['twenty meters per second'] } as Card;
  assert(writtenCorrect(c, '20 m/s.'));
  assert(writtenCorrect(c, '  Twenty meters per second!'));
  assert(!writtenCorrect(c, '20'));
  assert(!writtenCorrect(c, '-20 m/s'));
});
test('written grading can answer with the term instead of the definition', () => {
  const c = {
    term: 'Photosynthesis',
    definition: 'How plants make food',
    aliases: [],
  } as unknown as Card;
  assert(writtenCorrect(c, 'photosynthesis', 'term'));
  assert(!writtenCorrect(c, 'How plants make food', 'term'));
});
test('MCQ choices keep the correct answer and deduplicate fallback answers', () => {
  const c = { id: 'a', definition: 'A', distractors: [] } as unknown as Card;
  const choices = mcqChoices(c, [
    c,
    { id: 'b', definition: 'B' },
    { id: 'c', definition: 'B' },
    { id: 'd', definition: 'C' },
  ] as Card[]);
  assert.deepEqual(choices, ['A', 'B', 'C']);
});
test('MCQ choices can answer with terms drawn from other cards', () => {
  const c = { id: 'a', term: 'Alpha', definition: 'A', distractors: ['wrong'] } as unknown as Card;
  const choices = mcqChoices(
    c,
    [c, { id: 'b', term: 'Beta' }, { id: 'c', term: 'Gamma' }] as Card[],
    'term',
  );
  assert.deepEqual(choices, ['Alpha', 'Beta', 'Gamma']);
});
test('question generation adapts to familiarity and answer side', () => {
  const card = {
    id: 'a',
    term: 'Alpha',
    definition: 'A',
    question: '',
    distractors: [],
    aliases: [],
  } as unknown as Card;
  const other = {
    id: 'b',
    term: 'Beta',
    definition: 'B',
    question: '',
    distractors: [],
    aliases: [],
  } as unknown as Card;
  const [familiar] = buildSessionQuestions([card], [card, other], {
    mode: 'learn',
    direction: 'term',
    questionTypes: ['mcq', 'written', 'tf'],
    familiar: () => true,
  });
  assert.equal(familiar.answerKind, 'written');
  assert.equal(familiar.prompt, 'Alpha');
  assert.equal(familiar.answer, 'A');
  const [fresh] = buildSessionQuestions([card], [card, other], {
    mode: 'learn',
    direction: 'definition',
    questionTypes: ['mcq'],
    familiar: () => false,
  });
  assert.equal(fresh.answerKind, 'mcq');
  assert.equal(fresh.prompt, 'A');
  assert.equal(fresh.answer, 'Alpha');
  assert(fresh.options.includes('Alpha'));
});
test('test questions cycle through the requested types', () => {
  const cards = [1, 2, 3].map(
    (n) =>
      ({
        id: String(n),
        term: `T${n}`,
        definition: `D${n}`,
        question: '',
        distractors: [],
        aliases: [],
      }) as unknown as Card,
  );
  const questions = buildSessionQuestions(cards, cards, {
    mode: 'test',
    direction: 'term',
    questionTypes: ['mcq', 'written', 'tf'],
    familiar: () => false,
  });
  assert.deepEqual(
    questions.map((q) => q.answerKind),
    ['mcq', 'written', 'tf'],
  );
});
test('true or false questions label the pairing honestly', () => {
  const card = {
    id: 'a',
    term: 'Alpha',
    definition: 'A',
    question: '',
    distractors: [],
    aliases: [],
  } as unknown as Card;
  const other = {
    id: 'b',
    term: 'Beta',
    definition: 'B',
    question: '',
    distractors: [],
    aliases: [],
  } as unknown as Card;
  for (let i = 0; i < 20; i++) {
    const [q] = buildSessionQuestions([card], [card, other], {
      mode: 'test',
      direction: 'term',
      questionTypes: ['tf'],
      familiar: () => false,
    });
    assert.equal(q.answerKind, 'tf');
    assert.deepEqual(q.options, ['True', 'False']);
    assert.equal(q.answer, q.pair === card.definition ? 'True' : 'False');
    assert(['A', 'B'].includes(q.pair!));
  }
});
test('learn matching builds a worksheet block from related cards with an extra option', () => {
  const cards = Array.from({ length: 6 }, (_, n) => ({
    id: `c${n}`,
    term: `Term ${n + 1}`,
    definition: `Definition ${n + 1}`,
    question: '',
    distractors: [],
    aliases: [],
    topic: 'Brain areas',
  })) as unknown as Card[];
  const questions = buildSessionQuestions(cards, cards, {
    mode: 'learn',
    direction: 'term',
    questionTypes: ['match'],
    familiar: () => false,
  });
  assert.equal(questions.length, 2);
  const block = questions.find((q) => q.answerKind === 'match')!;
  const match = block.match!;
  assert.equal(match.items.length, 5);
  assert.equal(match.coveredIds.length, 5);
  assert.equal(new Set(match.coveredIds).size, 5);
  assert.equal(match.choices.length, 6);
  assert.deepEqual(
    match.choices.map((choice) => choice.label),
    ['A', 'B', 'C', 'D', 'E', 'F'],
  );
  for (const item of match.items) {
    const chosen = match.choices.find((choice) => choice.label === item.answer)!;
    const card = cards.find((c) => c.id === item.cardId)!;
    assert.equal(item.text, card.term);
    assert.equal(chosen.text, card.definition);
  }
  const single = questions.find((q) => q.id !== block.id)!;
  assert.equal(single.answerKind, 'mcq');
});
test('learn matching follows the chosen answer side and never appears in tests', () => {
  const cards = Array.from({ length: 4 }, (_, n) => ({
    id: `d${n}`,
    term: `Term ${n + 1}`,
    definition: `Definition ${n + 1}`,
    question: '',
    distractors: [],
    aliases: [],
    topic: 'Divisions',
  })) as unknown as Card[];
  const [block] = buildSessionQuestions(cards, cards, {
    mode: 'learn',
    direction: 'definition',
    questionTypes: ['match'],
    familiar: () => false,
  });
  assert.equal(block.answerKind, 'match');
  const match = block.match!;
  assert.equal(match.items[0].text, 'Definition 1');
  const chosen = match.choices.find((choice) => choice.label === match.items[0].answer)!;
  assert.equal(chosen.text, 'Term 1');
  const testQuestions = buildSessionQuestions(cards, cards, {
    mode: 'test',
    direction: 'term',
    questionTypes: ['match'],
    familiar: () => false,
  });
  assert.equal(
    testQuestions.every((q) => q.answerKind !== 'match'),
    true,
  );
});
