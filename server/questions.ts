import type { Card } from '../src/types';
import { mcqChoices } from './learning';
export type QuestionKind = 'mcq' | 'written' | 'tf';
export type AnswerSide = 'term' | 'definition';
export type SessionQuestion = Card & {
  answerKind: QuestionKind;
  prompt: string;
  answer: string;
  answerSide: AnswerSide;
  options: string[];
  pair?: string;
};
const kindOrder: QuestionKind[] = ['mcq', 'written', 'tf'];
export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export function normalizeQuestionTypes(types: QuestionKind[]): QuestionKind[] {
  const unique = kindOrder.filter((k) => types.includes(k));
  return unique.length ? unique : ['mcq', 'written'];
}
function pickKind(
  card: Card,
  index: number,
  mode: string,
  types: QuestionKind[],
  familiar: (card: Card) => boolean,
): QuestionKind {
  if (mode === 'test') return types[index % types.length];
  const easier: QuestionKind[] = ['mcq', 'tf', 'written'];
  const harder: QuestionKind[] = ['written', 'tf', 'mcq'];
  const preferred = familiar(card) ? harder : easier;
  return preferred.find((k) => types.includes(k)) || types[0];
}
export function buildSessionQuestions(
  cards: Card[],
  allCards: Card[],
  options: {
    mode: string;
    direction: AnswerSide;
    questionTypes: QuestionKind[];
    familiar: (card: Card) => boolean;
  },
): SessionQuestion[] {
  const types = normalizeQuestionTypes(options.questionTypes);
  const showSide = options.direction;
  return cards.map((card, index) => {
    const answerSide: AnswerSide = showSide === 'definition' ? 'term' : 'definition';
    const prompt = showSide === 'definition' ? card.definition : card.question || card.term;
    const answer = answerSide === 'term' ? card.term : card.definition;
    const kind = pickKind(card, index, options.mode, types, options.familiar);
    if (kind === 'written')
      return { ...card, answerKind: kind, prompt, answer, answerSide, options: [] };
    if (kind === 'tf') {
      const truePair = answer;
      const pool = allCards
        .filter((c) => c.id !== card.id)
        .map((c) => (answerSide === 'term' ? c.term : c.definition))
        .filter((v) => v.trim().toLowerCase() !== truePair.trim().toLowerCase());
      if (pool.length) {
        const showsTrue = Math.random() < 0.5;
        const pair = showsTrue ? truePair : pool[Math.floor(Math.random() * pool.length)];
        return {
          ...card,
          answerKind: kind,
          prompt,
          answer: showsTrue ? 'True' : 'False',
          answerSide,
          options: ['True', 'False'],
          pair,
        };
      }
    }
    return {
      ...card,
      answerKind: 'mcq',
      prompt,
      answer,
      answerSide,
      options: shuffle(mcqChoices(card, allCards, answerSide)),
    };
  });
}
