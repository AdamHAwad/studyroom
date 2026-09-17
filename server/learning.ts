import type { Attempt, CardProgress, Card } from '../src/types';
export const emptyProgress = (cardId: string): CardProgress => ({
  cardId,
  seen: 0,
  objectiveAttempts: 0,
  correct: 0,
  recallAttempts: 0,
  recognitionAttempts: 0,
  selfRatings: 0,
  lastCorrect: null,
  lastStudied: null,
  dueAt: null,
  intervalDays: 0,
  streak: 0,
  status: 'new',
});
// This is an explicit scheduling heuristic, not a calibrated probability of remembering.
export function advance(previous: CardProgress | undefined, a: Attempt): CardProgress {
  const p = { ...(previous || emptyProgress(a.cardId)) };
  p.seen++;
  p.lastStudied = a.createdAt;
  if (a.kind === 'view') return p;
  if (a.kind === 'self') {
    p.selfRatings++;
    if (a.correct === false) {
      p.dueAt = a.createdAt;
      p.status = 'learning';
    }
    return p;
  }
  if (a.correct === null) return p;
  p.objectiveAttempts++;
  p.correct += Number(a.correct);
  p.recognitionAttempts += Number(a.kind === 'mcq' || a.kind === 'match');
  p.recallAttempts += Number(a.kind === 'written');
  p.lastCorrect = a.correct;
  // Repeated correct clicks in a single session do not accumulate spaced-success credit.
  const spaced =
    !previous?.lastStudied ||
    Date.parse(a.createdAt) - Date.parse(previous.lastStudied) >= 20 * 60 * 60 * 1000;
  if (!a.correct) {
    p.streak = 0;
    p.intervalDays = 0;
    p.status = 'learning';
    p.dueAt = new Date(Date.parse(a.createdAt) + 10 * 60 * 1000).toISOString();
  } else {
    if (spaced) p.streak++;
    p.intervalDays = spaced
      ? Math.min(30, Math.max(1, previous?.intervalDays ? previous.intervalDays * 2 : 1))
      : Math.max(1, p.intervalDays);
    p.dueAt = new Date(Date.parse(a.createdAt) + p.intervalDays * 86400000).toISOString();
    p.status = p.streak >= 3 ? 'retained' : 'familiar';
  }
  return p;
}
export const normalize = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/[.,!?;:]+$/g, '')
    .replace(/\s+/g, ' ');
export function writtenCorrect(
  card: Card,
  response: string,
  answerSide: 'term' | 'definition' = 'definition',
) {
  const accepted = answerSide === 'term' ? [card.term] : [card.definition, ...card.aliases];
  return accepted.some((v) => normalize(v) === normalize(response));
}
export function mcqChoices(
  card: Card,
  cards: Card[],
  side: 'term' | 'definition' = 'definition',
): string[] {
  const answer = side === 'term' ? card.term : card.definition;
  const wrong =
    side === 'term'
      ? cards.filter((c) => c.id !== card.id).map((c) => c.term)
      : card.distractors.length
        ? card.distractors
        : cards.filter((c) => c.id !== card.id).map((c) => c.definition);
  return [...new Set([answer, ...wrong])].slice(0, 4);
}
