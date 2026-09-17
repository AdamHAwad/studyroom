import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { all, get, put, id, now, DATA, ROOT, transaction, backup, db } from './db';
import { advance, writtenCorrect, emptyProgress } from './learning';
import {
  buildSessionQuestions,
  normalizeQuestionTypes,
  type QuestionKind,
  type SessionQuestion,
} from './questions';
import { snapshot, agentSnapshot } from './snapshot';
import { extract, extensions } from './extract';
import { extractAssets } from './assets';
import { enqueue, recoverJobs, cancelJob, shutdownAgents } from './agents';
import {
  agentStatus,
  modelsFor,
  startInstall,
  getInstall,
  startCodexLogin,
  connectOpencode,
  currentHarness,
  stopHarnessProcesses,
} from './harness';
import type { Card, Job, Source, StudySet, Course, Attempt, CardProgress } from '../src/types';
const app = express();
const PORT = Number(process.env.PORT || 3210);
app.disable('x-powered-by');
app.use((req, res, next) => {
  const host = req.headers.host?.split(':')[0];
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host || ''))
    return res.status(403).json({ error: 'Local access only' });
  const origin = req.headers.origin;
  if (origin && ![`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].includes(origin))
    return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '20mb' }));
const courseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().max(30).default(''),
  description: z.string().max(2000).default(''),
  color: z.enum(['purple', 'blue', 'green', 'orange', 'pink', 'teal']).default('purple'),
});
const cardSchema = z.object({
  id: z.string().optional(),
  term: z.string().trim().min(1).max(1500),
  definition: z.string().trim().min(1).max(3000),
  question: z.string().max(2500).default(''),
  distractors: z.array(z.string().min(1)).max(3).default([]),
  explanation: z.string().max(5000).default(''),
  topic: z.string().max(200).default('General'),
  aliases: z.array(z.string()).default([]),
  sources: z
    .array(
      z.object({
        sourceId: z.string(),
        locator: z.string(),
        quote: z.string(),
        assetId: z.string().nullable().optional(),
      }),
    )
    .default([]),
  image: z
    .object({
      assetId: z.string(),
      cropId: z.string().optional(),
      sourceId: z.string().optional(),
      locator: z.string().optional(),
      side: z.enum(['question', 'answer']),
      alt: z.string(),
      caption: z.string(),
      reason: z.string(),
      matchUsable: z.boolean(),
      revealsAnswer: z.boolean(),
      crop: z.array(z.number()).nullable(),
    })
    .nullable()
    .optional(),
});
const requireItem = (table: string, itemId: string | string[]) => {
  const item = get(table, String(itemId));
  if (!item) throw Object.assign(Error('This item was not found.'), { status: 404 });
  return item;
};
app.get('/api/health', (_req, res) => res.json({ ok: true, version: 1, port: PORT }));
app.get('/api/bootstrap', (_req, res) => {
  const s = snapshot();
  const { cards, attempts, ...data } = s;
  res.json({
    ...data,
    jobs: all('jobs').slice(-30).reverse(),
    settings: Object.fromEntries(all('settings').map((x) => [x.id, x.value])),
  });
});
app.get('/api/progress', (req, res) => res.json(agentSnapshot(req.query.courseId as string)));
app.get('/api/assets/:id', (req, res) => {
  const asset = requireItem('assets', req.params.id);
  res.type('png').sendFile(asset.path);
});
app.get('/api/assets/:id/crop/:cropId', (req, res) => {
  const asset = requireItem('assets', req.params.id);
  const crop = requireItem('crops', req.params.cropId);
  if (crop.assetId !== asset.id) throw Error('Image crop not found');
  res.type('png').sendFile(crop.path);
});
app.get('/api/sources', (_req, res) =>
  res.json(all('sources').map(({ path: _, textPath: __, ...s }) => s)),
);
app.get('/api/sources/:id/text', (req, res) => {
  const s = requireItem('sources', req.params.id);
  res.type('text/plain').send(fs.readFileSync(s.textPath, 'utf8'));
});
app.get('/api/sources/:id/file', (req, res) => {
  const s = requireItem('sources', req.params.id);
  res.download(s.path, s.name);
});
app.post('/api/courses', (req, res) =>
  res.json(
    put('courses', {
      ...courseSchema.parse(req.body),
      id: id(),
      createdAt: now(),
      archived: false,
    }),
  ),
);
app.patch('/api/courses/:id', (req, res) => {
  const c = requireItem('courses', req.params.id);
  res.json(
    put('courses', {
      ...c,
      ...courseSchema.partial().extend({ archived: z.boolean().optional() }).parse(req.body),
    }),
  );
});
app.get('/api/archive', (_req, res) =>
  res.json({
    courses: all('courses').filter((c) => c.archived),
    sets: all('sets').filter((s) => s.archived),
  }),
);
app.get('/api/sets/:id', (req, res) => {
  const set = requireItem('sets', req.params.id);
  res.json({
    ...set,
    cards: all<Card>('cards')
      .filter((c) => c.setId === set.id && !(c as any).archived)
      .sort((a, b) => a.position - b.position),
  });
});
app.post('/api/sets', (req, res) => {
  const b = z
    .object({
      courseId: z.string(),
      title: z.string().trim().min(1).max(200),
      description: z.string().max(3000).default(''),
      cards: z.array(cardSchema).min(1),
    })
    .parse(req.body);
  requireItem('courses', b.courseId);
  const set = transaction(() => {
    const s = put('sets', {
      id: id(),
      courseId: b.courseId,
      title: b.title,
      description: b.description,
      createdAt: now(),
      updatedAt: now(),
      archived: false,
      origin: 'manual',
      warnings: [],
    });
    b.cards.forEach((c, i) =>
      put('cards', { ...c, id: id(), setId: s.id, starred: false, version: 1, position: i }),
    );
    return s;
  });
  res.json(set);
});
app.put('/api/sets/:id', (req, res) => {
  const set = requireItem('sets', req.params.id);
  const b = z
    .object({
      title: z.string().trim().min(1).max(200),
      description: z.string().max(3000),
      cards: z.array(cardSchema).min(1),
    })
    .parse(req.body);
  const incomingIds = b.cards.flatMap((c) => (c.id ? [c.id] : []));
  if (new Set(incomingIds).size !== incomingIds.length) throw Error('Duplicate card IDs');
  transaction(() => {
    const existing = all<Card>('cards').filter((c) => c.setId === set.id);
    for (const c of b.cards)
      if (c.id && !existing.some((e) => e.id === c.id))
        throw Error('A card does not belong to this set');
    for (const old of existing)
      if (!incomingIds.includes(old.id)) put('cards', { ...old, archived: true });
    b.cards.forEach((c, i) => {
      const old = existing.find((e) => e.id === c.id);
      const changed =
        old &&
        (old.term !== c.term ||
          old.definition !== c.definition ||
          JSON.stringify(old.distractors) !== JSON.stringify(c.distractors) ||
          old.question !== c.question);
      const cardId = old?.id || id();
      put('cards', {
        ...old,
        ...c,
        id: cardId,
        setId: set.id,
        position: i,
        version: old ? old.version + Number(Boolean(changed)) : 1,
        starred: old?.starred || false,
        archived: false,
      });
      if (changed) put('progress', { ...emptyProgress(cardId), id: cardId });
    });
    put('sets', { ...set, title: b.title, description: b.description, updatedAt: now() });
  });
  res.json({ ok: true });
});
app.patch('/api/sets/:id', (req, res) => {
  const s = requireItem('sets', req.params.id);
  res.json(
    put('sets', { ...s, ...z.object({ archived: z.boolean() }).parse(req.body), updatedAt: now() }),
  );
});
app.patch('/api/cards/:id/star', (req, res) => {
  const c = requireItem('cards', req.params.id);
  res.json(put('cards', { ...c, starred: z.boolean().parse(req.body.starred) }));
});
const upload = multer({
  dest: path.join(DATA, 'uploads'),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!extensions.has(path.extname(file.originalname).toLowerCase()))
      cb(Error('Use a PDF, DOCX, PPTX, text file, or image.'));
    else cb(null, true);
  },
});
app.post('/api/courses/:id/upload', upload.single('file'), async (req, res) => {
  const course = requireItem('courses', req.params.id);
  if (!req.file) throw Error('Choose a file to upload');
  const file = req.file;
  const source: Source = {
    id: id(),
    courseId: course.id,
    name: Buffer.from(file.originalname, 'latin1').toString('utf8'),
    size: file.size,
    kind: path.extname(file.originalname).slice(1).toUpperCase(),
    path: file.path + path.extname(file.originalname).toLowerCase(),
    textPath: file.path + '.txt',
    status: 'processing',
    error: null,
    createdAt: now(),
  };
  fs.renameSync(file.path, source.path);
  put('sources', source);
  try {
    const text = await extract(source.path, source.name);
    fs.writeFileSync(source.textPath, text);
    const visuals = await extractAssets(source);
    (source as any).assetIds = visuals.assets.map((a) => a.id);
    (source as any).warnings = visuals.warnings;
    source.status = 'ready';
  } catch (e) {
    source.status = 'failed';
    source.error = (e as Error).message;
  }
  put('sources', source);
  const { path: _, textPath: __, ...safe } = source;
  res.json(safe);
});
app.post('/api/jobs/set', (req, res) => {
  const b = z
    .object({
      courseId: z.string(),
      title: z.string().trim().min(1).max(200),
      instructions: z.string().max(5000).default(''),
      sourceIds: z.array(z.string()).min(1),
    })
    .parse(req.body);
  requireItem('courses', b.courseId);
  if (
    b.sourceIds.some((s) => {
      const source = get<Source>('sources', s);
      return !source || source.courseId !== b.courseId || source.status !== 'ready';
    })
  )
    throw Error('Selected files must be ready and belong to this course');
  res.json(enqueue('set', b.courseId, b));
});
app.post('/api/sets/:id/review', (req, res) => {
  const set = requireItem('sets', req.params.id) as StudySet;
  const existing = all<Job>('jobs').find(
    (job) =>
      job.kind === 'review' &&
      job.payload.setId === set.id &&
      ['queued', 'running'].includes(job.status),
  );
  if (existing) return res.json(existing);
  res.json(enqueue('review', set.courseId, { setId: set.id }));
});
app.get('/api/jobs/:id', (req, res) => res.json(requireItem('jobs', req.params.id)));
app.post('/api/jobs/:id/retry', (req, res) => {
  const j = requireItem('jobs', req.params.id) as Job;
  if (!['failed', 'cancelled'].includes(j.status))
    throw Error('Only failed or cancelled jobs can be retried');
  const retry = enqueue(j.kind, j.courseId, { ...j.payload, resumeFromJobId: j.id });
  put('jobs', {
    ...j,
    status: 'retried',
    stage: 'Retried',
    retryJobId: retry.id,
    updatedAt: now(),
  });
  res.json(retry);
});
app.post('/api/jobs/:id/cancel', (req, res) => {
  const j = requireItem('jobs', req.params.id);
  if (!['queued', 'running'].includes(j.status)) throw Error('This job has already finished');
  cancelJob(j);
  res.json({ ok: true });
});
app.get('/api/conversations', (_req, res) => res.json(all('conversations').reverse()));
app.get('/api/conversations/:id', (req, res) => {
  const c = requireItem('conversations', req.params.id);
  res.json({
    ...c,
    messages: all('messages').filter((m) => m.conversationId === c.id),
    jobs: all('jobs').filter((j) => j.payload.conversationId === c.id),
  });
});
app.post('/api/chat', (req, res) => {
  const b = z
    .object({
      message: z.string().trim().min(1).max(12000),
      conversationId: z.string().nullable().optional(),
      courseId: z.string().nullable().optional(),
    })
    .parse(req.body);
  if (b.courseId) requireItem('courses', b.courseId);
  const conversation = b.conversationId
    ? requireItem('conversations', b.conversationId)
    : put('conversations', {
        id: id(),
        courseId: b.courseId || null,
        title: b.message.slice(0, 60),
        createdAt: now(),
      });
  if (
    all<Job>('jobs').some(
      (j) =>
        j.payload.conversationId === conversation.id && ['queued', 'running'].includes(j.status),
    )
  )
    throw Error('Wait for the current response to finish');
  const messageId = id();
  put('messages', {
    id: messageId,
    conversationId: conversation.id,
    role: 'user',
    content: b.message,
    createdAt: now(),
    actions: [],
    evidence: [],
    jobId: null,
  });
  const job = enqueue('chat', conversation.courseId, { conversationId: conversation.id });
  res.json({ conversationId: conversation.id, job });
});
app.post('/api/sessions', (req, res) => {
  const b = z
    .object({
      setId: z.string(),
      mode: z.enum(['flashcards', 'learn', 'match', 'test']),
      focus: z.string().optional(),
      focusIds: z.array(z.string()).optional(),
      starred: z.boolean().default(false),
      count: z.number().int().min(1).optional(),
      direction: z.enum(['term', 'definition']).default('term'),
      questionType: z.enum(['adaptive', 'mcq', 'written', 'tf']).optional(),
      questionTypes: z
        .array(z.enum(['mcq', 'written', 'tf']))
        .min(1)
        .max(3)
        .optional(),
      shuffle: z.boolean().default(false),
      sorting: z.boolean().default(true),
      audio: z.boolean().default(false),
    })
    .parse(req.body);
  const set = requireItem('sets', b.setId);
  const allCards = all<Card>('cards').filter((c) => c.setId === b.setId && !(c as any).archived);
  let cards = allCards.filter((c) => !b.starred || c.starred);
  if (b.focus) cards = cards.filter((c) => c.id === b.focus);
  if (b.focusIds) cards = cards.filter((c) => b.focusIds!.includes(c.id));
  if (!cards.length) throw Error('No cards match these options.');
  if (b.mode === 'learn') {
    cards.sort((a, b) => {
      const score = (c: Card) => {
        const p = get<CardProgress>('progress', c.id);
        return !p ? 4 : p.lastCorrect === false ? 10 : p.dueAt && p.dueAt <= now() ? 8 : 0;
      };
      return score(b) - score(a);
    });
  }
  if (b.shuffle || b.mode === 'test' || b.mode === 'match') cards = shuffle(cards);
  if (b.mode === 'match') {
    const defs = new Set<string>();
    cards = cards
      .filter((c) => {
        const k = c.definition.trim().toLowerCase();
        if (defs.has(k)) return false;
        defs.add(k);
        return true;
      })
      .slice(0, 6);
    if (cards.length < 2) throw Error('Match needs at least two cards with different answers.');
  }
  if (b.mode === 'test' && b.count) cards = cards.slice(0, b.count);
  const requestedTypes = b.questionTypes?.length
    ? b.questionTypes
    : b.questionType && b.questionType !== 'adaptive'
      ? [b.questionType]
      : b.mode === 'test'
        ? (['mcq', 'written', 'tf'] as const)
        : (['mcq', 'written'] as const);
  const questionTypes: QuestionKind[] = normalizeQuestionTypes([...requestedTypes]);
  const questions = buildSessionQuestions(cards, allCards, {
    mode: b.mode,
    direction: b.direction,
    questionTypes,
    familiar: (c) => {
      const p = get<CardProgress>('progress', c.id);
      return Boolean(p && p.objectiveAttempts >= 2 && p.lastCorrect);
    },
  });
  if (
    (b.mode === 'test' || b.mode === 'learn') &&
    questions.some((q) => q.answerKind === 'mcq' && q.options.length < 2)
  )
    throw Error('Add another card or distractor answers, or choose written practice.');
  const previousBest =
    b.mode === 'match'
      ? all('sessions')
          .filter(
            (s) =>
              s.mode === 'match' &&
              s.setId === set.id &&
              s.completedAt &&
              s.cards.length === cards.length &&
              s.state.totalTime > 0,
          )
          .reduce((best, s) => Math.min(best, s.state.totalTime), Infinity)
      : Infinity;
  const s = put('sessions', {
    id: id(),
    bestTime: Number.isFinite(previousBest) ? previousBest : null,
    setId: set.id,
    courseId: set.courseId,
    mode: b.mode,
    settings: b,
    createdAt: now(),
    updatedAt: now(),
    completedAt: null,
    cards: questions,
    state: { index: 0, answers: {}, queue: questions.map((c) => c.id) },
  });
  res.json(s);
});
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
app.get('/api/sessions', (req, res) =>
  res.json(
    all('sessions')
      .filter((s) => s.setId === req.query.setId && s.mode === req.query.mode && !s.completedAt)
      .slice(-1),
  ),
);
app.get('/api/sessions/:id', (req, res) => res.json(requireItem('sessions', req.params.id)));
app.patch('/api/sessions/:id', (req, res) => {
  const s = requireItem('sessions', req.params.id);
  const b = z
    .object({
      state: z.record(z.string(), z.unknown()).optional(),
      completed: z.boolean().optional(),
    })
    .parse(req.body);
  res.json(
    put('sessions', {
      ...s,
      state: b.state || s.state,
      updatedAt: now(),
      completedAt: b.completed ? now() : s.completedAt,
    }),
  );
});
app.post('/api/attempts', (req, res) => {
  const b = z
    .object({
      id: z.string().uuid(),
      sessionId: z.string(),
      cardId: z.string(),
      kind: z.enum(['view', 'self', 'mcq', 'written', 'match']),
      response: z.string().max(10000),
      durationMs: z.number().min(0).max(86400000),
      selfCorrect: z.boolean().optional(),
      matchedCardId: z.string().optional(),
    })
    .parse(req.body);
  const prior = get('attempts', b.id);
  if (prior) return res.json(prior);
  const s = requireItem('sessions', b.sessionId);
  if (s.mode === 'test') throw Error('Submit the complete test instead');
  const c = s.cards.find((c: SessionQuestion) => c.id === b.cardId);
  if (!c) throw Error('This card is not in the session');
  if (s.completedAt) throw Error('This study session has ended');
  const expected: Record<string, string[]> = {
    flashcards: ['view', 'self'],
    learn: ['mcq', 'written'],
    match: ['match'],
  };
  if (!expected[s.mode]?.includes(b.kind)) throw Error('Answer type does not match the session');
  const answerSide = c.answerSide || 'definition';
  const correct =
    b.kind === 'view'
      ? null
      : b.kind === 'self'
        ? (b.selfCorrect ?? false)
        : b.kind === 'written'
          ? writtenCorrect(c, b.response, answerSide)
          : b.kind === 'match'
            ? b.matchedCardId === c.id
            : b.response === (c.answer ?? c.definition);
  const a: Attempt = {
    id: b.id,
    sessionId: s.id,
    cardId: c.id,
    setId: s.setId,
    courseId: s.courseId,
    mode: s.mode,
    kind: b.kind,
    response: b.response,
    correct,
    durationMs: b.durationMs,
    createdAt: now(),
    cardVersion: c.version,
  };
  transaction(() => {
    put('attempts', {
      ...a,
      cardSnapshot: { term: c.term, definition: c.definition },
      ...(b.kind === 'match' ? { matchedCardId: b.matchedCardId } : {}),
    });
    const current = get<Card>('cards', c.id);
    if (current?.version === c.version)
      put('progress', { ...advance(get('progress', c.id), a), id: c.id });
  });
  res.json({ ...a, answer: c.answer ?? c.definition, explanation: c.explanation });
});
app.post('/api/sessions/:id/submit', (req, res) => {
  const s = requireItem('sessions', req.params.id);
  if (s.mode !== 'test') throw Error('This is not a test');
  if (s.result) return res.json(s.result);
  const b = z
    .object({
      answers: z.record(z.string(), z.string()),
      durationMs: z.number().min(0).max(86400000),
    })
    .parse(req.body);
  if (s.cards.some((c: Card) => !b.answers[c.id]))
    throw Error('Answer every question before submitting');
  const results = s.cards.map((c: SessionQuestion) => {
    const response = b.answers[c.id];
    const answer = c.answer ?? c.definition;
    return {
      cardId: c.id,
      term: c.prompt || c.question || c.term,
      answer,
      response,
      correct:
        c.answerKind === 'written'
          ? writtenCorrect(c, response, c.answerSide || 'definition')
          : response === answer,
      explanation: c.explanation,
      sources: c.sources,
    };
  });
  const result = {
    correct: results.filter((r: any) => r.correct).length,
    total: results.length,
    questions: results,
  };
  transaction(() => {
    for (const c of s.cards as SessionQuestion[]) {
      const graded = results.find((r: any) => r.cardId === c.id)!;
      const a: Attempt = {
        id: id(),
        sessionId: s.id,
        cardId: c.id,
        setId: s.setId,
        courseId: s.courseId,
        mode: 'test',
        kind: c.answerKind === 'written' ? 'written' : 'mcq',
        response: graded.response,
        correct: graded.correct,
        durationMs: b.durationMs / s.cards.length,
        createdAt: now(),
        cardVersion: c.version,
      };
      put('attempts', { ...a, cardSnapshot: { term: c.term, definition: c.definition } });
      if (get<Card>('cards', c.id)?.version === c.version)
        put('progress', { ...advance(get('progress', c.id), a), id: c.id });
    }
    put('sessions', {
      ...s,
      result,
      completedAt: now(),
      updatedAt: now(),
      state: { ...s.state, answers: b.answers },
    });
  });
  res.json(result);
});
app.get('/api/export', (_req, res) => {
  const out = {
    schemaVersion: 1,
    exportedAt: now(),
    ...Object.fromEntries(
      [
        'courses',
        'sets',
        'cards',
        'sources',
        'sessions',
        'attempts',
        'progress',
        'conversations',
        'messages',
        'jobs',
        'settings',
        'assets',
        'crops',
      ].map((t) => [t, all(t)]),
    ),
  };
  res.setHeader('Content-Disposition', 'attachment; filename="studyroom-export.json"');
  res.json(out);
});
app.post('/api/backup', (_req, res) => {
  backup();
  res.json({ ok: true });
});
app.get('/api/settings', (_req, res) =>
  res.json({
    dataPath: DATA,
    port: PORT,
    agent:
      currentHarness() === 'opencode'
        ? 'OpenCode · connected account'
        : 'Codex CLI · existing ChatGPT login',
    harness: currentHarness(),
    backupFiles: fs.readdirSync(path.join(DATA, 'backups')),
    skills: ['.agents/skills/create-set/SKILL.md', '.agents/skills/progress-insights/SKILL.md'],
    sourceTypes: [...extensions],
    maxFileMB: 100,
  }),
);
const modelPattern = /^[A-Za-z0-9._:/~+@-]*$/;
const settingsSchema = z.object({
  name: z.string().max(60).optional(),
  agentHarness: z.enum(['codex', 'opencode']).optional(),
  agentCodexModel: z.string().max(120).regex(modelPattern).optional(),
  agentCodexEffort: z.string().max(40).regex(modelPattern).optional(),
  agentOpencodeModel: z.string().max(180).regex(modelPattern).optional(),
  agentOpencodeEffort: z.string().max(40).regex(modelPattern).optional(),
});
app.patch('/api/settings', (req, res) => {
  const b = settingsSchema.parse(req.body);
  for (const [key, value] of Object.entries(b)) put('settings', { id: key, value });
  res.json({ ok: true });
});
app.get('/api/agent/status', async (_req, res) => res.json(await agentStatus()));
app.get('/api/agent/models', async (req, res) => {
  const harness = z.enum(['codex', 'opencode']).parse(req.query.harness);
  res.json({ harness, models: await modelsFor(harness) });
});
app.post('/api/agent/install', (req, res) => {
  const { harness } = z.object({ harness: z.enum(['codex', 'opencode']) }).parse(req.body);
  res.json(startInstall(harness));
});
app.get('/api/agent/install/:harness', (req, res) => {
  const harness = z.enum(['codex', 'opencode']).parse(req.params.harness);
  res.json(getInstall(harness) || { harness, status: 'idle', lines: [], error: null });
});
app.post('/api/agent/login', (req, res) => {
  const b = z
    .object({
      harness: z.enum(['codex', 'opencode']),
      apiKey: z.string().trim().max(300).optional(),
    })
    .parse(req.body);
  if (b.harness === 'opencode') {
    if (!b.apiKey) throw Error('Paste your OpenCode Go API key.');
    return res.json(connectOpencode(b.apiKey));
  }
  res.json(startCodexLogin());
});
app.get('/api/jobs/:id/log', (req, res) => {
  const j = requireItem('jobs', req.params.id);
  const dir = path.join(DATA, 'jobs', j.id);
  const files = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('-events.jsonl'))
        .sort()
    : [];
  const artifacts = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => /(?:pipeline|receipt|quality|review|recovery|final-validated)/.test(f))
        .sort()
    : [];
  res
    .type('text/plain')
    .send(
      [
        `Studyroom job ${j.id}`,
        `Status: ${j.status}`,
        `Stage: ${j.stage}`,
        `Progress: ${j.progress}%`,
        j.error ? `Error: ${j.error}` : '',
        `Artifacts: ${artifacts.length ? artifacts.join(', ') : 'none'}`,
        '',
        ...files.map((f) => `===== ${f} =====\n${fs.readFileSync(path.join(dir, f), 'utf8')}`),
      ]
        .filter(Boolean)
        .join('\n'),
    );
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint' }));
if (fs.existsSync(path.join(ROOT, 'dist/index.html'))) {
  app.use(express.static(path.join(ROOT, 'dist')));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(ROOT, 'dist/index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.message);
  res.status(err.status || 400).json({
    error:
      err instanceof z.ZodError
        ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        : err.message || 'Something went wrong.',
  });
});
for (const source of all<Source>('sources'))
  if (source.status === 'processing')
    put('sources', {
      ...source,
      status: 'failed',
      error: 'File processing was interrupted by a restart. Upload this file again.',
    });
backup();
recoverJobs();
const daily = setInterval(backup, 60 * 60 * 1000);
daily.unref();
const server = app.listen(PORT, '127.0.0.1', () =>
  console.log(`Studyroom is ready at http://localhost:${PORT}`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    shutdownAgents();
    stopHarnessProcesses();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
