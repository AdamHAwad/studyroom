import { all, now } from './db';
import { emptyProgress } from './learning';
import type { Course, StudySet, Card, Attempt, CardProgress } from '../src/types';
const localDay = (date: string) => new Date(date).toLocaleDateString('en-CA');
export function snapshot(courseId?: string | null) {
  const courses = all<Course>('courses').filter(
    (c) => !c.archived && (!courseId || c.id === courseId),
  );
  const courseIds = new Set(courses.map((c) => c.id));
  const sets = all<StudySet>('sets').filter((s) => !s.archived && courseIds.has(s.courseId));
  const setIds = new Set(sets.map((s) => s.id));
  const cards = all<Card>('cards').filter((c) => setIds.has(c.setId) && !(c as any).archived);
  const cardIds = new Set(cards.map((c) => c.id));
  const attempts = all<Attempt>('attempts').filter((a) => cardIds.has(a.cardId));
  const pm = new Map(all<CardProgress>('progress').map((p) => [p.cardId, p]));
  const progress = cards.map((c) => pm.get(c.id) || emptyProgress(c.id));
  const objective = attempts.filter((a) => a.correct !== null && a.kind !== 'self');
  const days = new Set(attempts.map((a) => localDay(a.createdAt)));
  let streak = 0;
  const cursor = new Date();
  if (!days.has(localDay(cursor.toISOString()))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(localDay(cursor.toISOString()))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  const activity = Array.from({ length: 28 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - 27 + i);
    const date = localDay(d.toISOString());
    const aa = attempts.filter((a) => localDay(a.createdAt) === date && a.kind !== 'view');
    return { date, count: aa.length, correct: aa.filter((a) => a.correct).length };
  });
  const stats = {
    attempts: objective.length,
    accuracy: objective.length
      ? Math.round((100 * objective.filter((a) => a.correct).length) / objective.length)
      : null,
    studyDays: days.size,
    streak,
    due: progress.filter((p) => p.dueAt && p.dueAt <= now()).length,
    retained: progress.filter((p) => p.status === 'retained').length,
    totalCards: cards.length,
    minutes: Math.round(attempts.reduce((s, a) => s + Math.min(a.durationMs, 300000), 0) / 60000),
  };
  return {
    courses,
    sets: sets.map((s) => ({ ...s, cardCount: cards.filter((c) => c.setId === s.id).length })),
    cards,
    attempts,
    progress,
    stats,
    activity,
  };
}
export function agentSnapshot(courseId?: string | null) {
  const s = snapshot(courseId);
  const objective = s.attempts.filter((a) => a.correct !== null && a.kind !== 'self');
  const aggregate = (attempts: Attempt[]) => {
    const seen = new Set<string>();
    const first = attempts.filter((a) => {
      const k = a.sessionId + ':' + a.cardId;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return {
      attempts: attempts.length,
      correct: attempts.filter((a) => a.correct).length,
      firstAttempts: first.length,
      firstCorrect: first.filter((a) => a.correct).length,
      accuracy: attempts.length
        ? Math.round((attempts.filter((a) => a.correct).length / attempts.length) * 100)
        : null,
    };
  };
  const byMode = ['mcq', 'written', 'match'].map((kind) => ({
    kind,
    ...aggregate(objective.filter((a) => a.kind === kind)),
  }));
  const byCourse = s.courses.map((c) => ({
    id: c.id,
    name: c.name,
    ...aggregate(objective.filter((a) => a.courseId === c.id)),
  }));
  const byTopic = [...new Set(s.cards.map((c) => c.topic))].map((topic) => {
    const ids = new Set(s.cards.filter((c) => c.topic === topic).map((c) => c.id));
    return { topic, cards: ids.size, ...aggregate(objective.filter((a) => ids.has(a.cardId))) };
  });
  const recentSessions = all('sessions')
    .filter((x) => s.sets.some((set) => set.id === x.setId))
    .slice(-30)
    .map((x) => ({
      id: x.id,
      setId: x.setId,
      mode: x.mode,
      startedAt: x.createdAt,
      completedAt: x.completedAt,
      score: x.result ? { correct: x.result.correct, total: x.result.total } : null,
    }));
  return {
    schemaVersion: 1,
    generatedAt: now(),
    scope: courseId || 'all active courses',
    metricDefinitions: {
      accuracy:
        'Objective correct / objective attempts, including retries. Self-ratings and card views excluded. Not an exam prediction.',
      retained:
        'At least 3 correct attempts spaced >=20h from preceding card activity; heuristic, not proven mastery.',
      due: 'Review heuristic: errors 10 minutes, spaced successes 1,2,4,8,16,30 days. Match and MCQ measure recognition.',
      studyMinutes:
        'Sum of response durations capped at 5 minutes per attempt; not total time with app open.',
    },
    stats: s.stats,
    byMode,
    byCourse,
    byTopic,
    recentSessions,
    courses: s.courses,
    sets: s.sets,
    activity: s.activity,
    cards: s.cards.map((c) => ({
      id: c.id,
      setId: c.setId,
      term: c.term,
      definition: c.definition,
      topic: c.topic,
      version: c.version,
      sources: c.sources,
      progress: s.progress.find((p) => p.cardId === c.id)!,
      actions: {
        learn: `/sets/${c.setId}/learn?focus=${c.id}`,
        flashcards: `/sets/${c.setId}/flashcards?focus=${c.id}`,
        set: `/sets/${c.setId}`,
      },
    })),
    recentAttempts: s.attempts.slice(-150),
    availableActions: s.sets.map((set) => ({
      label: `Practice ${set.title}`,
      path: `/sets/${set.id}/learn`,
    })),
  };
}
