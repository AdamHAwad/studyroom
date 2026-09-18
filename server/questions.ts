import type { Card } from '../src/types';
import { mcqChoices, normalize } from './learning';
export type QuestionKind = 'mcq' | 'written' | 'tf' | 'match';
export type AnswerSide = 'term' | 'definition';
export type MatchItem = { cardId: string; text: string; answer: string };
export type MatchChoice = { label: string; text: string };
export type MatchBlock = {
  stem: string;
  items: MatchItem[];
  choices: MatchChoice[];
  coveredIds: string[];
};
export type SessionQuestion = Card & {
  answerKind: QuestionKind;
  prompt: string;
  answer: string;
  answerSide: AnswerSide;
  options: string[];
  pair?: string;
  match?: MatchBlock;
};
const kindOrder: QuestionKind[] = ['mcq', 'written', 'tf', 'match'];
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
function sides(card: Card, showSide: AnswerSide) {
  const answerSide: AnswerSide = showSide === 'definition' ? 'term' : 'definition';
  const prompt = showSide === 'definition' ? card.definition : card.question || card.term;
  const answer = answerSide === 'term' ? card.term : card.definition;
  return { prompt, answer, answerSide };
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
// Learn matching is a worksheet built from related cards, not the timed Match mode.
// Only cards that share a topic, a distinct answer, and a distinct prompt can form a block.
const MATCH_MIN_CARDS = 3;
const MATCH_MAX_CARDS = 5;
const matchLabels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function matchable(cards: Card[], showSide: AnswerSide): Card[] {
  const answers = new Set<string>(),
    prompts = new Set<string>(),
    kept: Card[] = [];
  for (const card of cards) {
    const { prompt, answer } = sides(card, showSide);
    const answerKey = normalize(answer),
      promptKey = normalize(prompt);
    if (!answerKey || !promptKey || answers.has(answerKey) || prompts.has(promptKey)) continue;
    answers.add(answerKey);
    prompts.add(promptKey);
    kept.push(card);
  }
  return kept;
}
function sharedQuestionImage(group: Card[]) {
  const counts = new Map<string, { count: number; image: NonNullable<Card['image']> }>();
  for (const card of group) {
    if (!card.image || card.image.side !== 'question') continue;
    const key = card.image.assetId + ':' + (card.image.cropId || '');
    const entry = counts.get(key) || { count: 0, image: card.image };
    entry.count++;
    counts.set(key, entry);
  }
  return (
    [...counts.values()].sort((a, b) => b.count - a.count).find((entry) => entry.count >= 2)
      ?.image || null
  );
}
function buildMatchQuestion(group: Card[], showSide: AnswerSide): SessionQuestion {
  const selected = group.slice(0, MATCH_MAX_CARDS);
  const choices = selected.map((card) => sides(card, showSide).answer);
  const extra = group[MATCH_MAX_CARDS];
  if (extra) choices.push(sides(extra, showSide).answer);
  const labeled = shuffle(choices).map((text, index) => ({ label: matchLabels[index], text }));
  const { answerSide } = sides(selected[0], showSide);
  const items = selected.map((card) => {
    const { prompt, answer } = sides(card, showSide);
    const choice = labeled.find((entry) => entry.text === answer)!;
    return { cardId: card.id, text: prompt, answer: choice.label };
  });
  const topic = (selected[0].topic || '').trim();
  const stem = topic
    ? `Match each item from “${topic}” to its answer.`
    : 'Match each item to its answer.';
  return {
    ...selected[0],
    id: `match-${selected[0].id}`,
    answerKind: 'match',
    prompt: stem,
    answer: '',
    answerSide,
    options: [],
    image: sharedQuestionImage(selected),
    match: {
      stem,
      items,
      choices: labeled,
      coveredIds: selected.map((card) => card.id),
    },
  };
}
function insertMatches(singles: SessionQuestion[], blocks: SessionQuestion[]) {
  const step = Math.max(1, Math.floor(singles.length / (blocks.length + 1)));
  blocks.forEach((block, index) => {
    const at = Math.min(singles.length, step * (index + 1) + index);
    singles.splice(at, 0, block);
  });
  return singles;
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
  const requested =
    options.mode === 'learn'
      ? options.questionTypes
      : options.questionTypes.filter((k) => k !== 'match');
  const types = normalizeQuestionTypes(requested);
  const showSide = options.direction;
  const singleTypes = normalizeQuestionTypes(types.filter((kind) => kind !== 'match'));
  const blocks: SessionQuestion[] = [];
  const covered = new Set<string>();
  if (options.mode === 'learn' && types.includes('match')) {
    const groups = new Map<string, Card[]>();
    for (const card of cards) {
      const key = (card.topic || '').trim().toLowerCase() || 'general';
      groups.set(key, [...(groups.get(key) || []), card]);
    }
    const maxBlocks = Math.max(1, Math.floor(cards.length / 10));
    const candidates = [...groups.values()]
      .map((group) => matchable(group, showSide))
      .filter((group) => group.length >= MATCH_MIN_CARDS)
      .sort((a, b) => b.length - a.length);
    for (const group of candidates) {
      if (blocks.length >= maxBlocks) break;
      group.slice(0, MATCH_MAX_CARDS).forEach((card) => covered.add(card.id));
      blocks.push(buildMatchQuestion(group, showSide));
    }
  }
  const singles = cards
    .filter((card) => !covered.has(card.id))
    .map((card, index): SessionQuestion => {
      const { prompt, answer, answerSide } = sides(card, showSide);
      const kind = pickKind(card, index, options.mode, singleTypes, options.familiar);
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
  return insertMatches(singles, blocks);
}
