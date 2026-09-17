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
