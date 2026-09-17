import { z } from 'zod';
import { all, get, put, id, now, transaction } from './db';
import { agentSnapshot } from './snapshot';
import { generateSet } from './generation';
import { evidenceUnits, auditOutput } from './generation-contract';
import type { Asset } from './assets';
import fs from 'node:fs';
import { runAgent, patchJob, stopAgents, assertActive, clearUnavailable } from './agent-runner';
import type { Job, ChatMessage } from '../src/types';
import type { Source } from '../src/types';

const chatOutput = z.object({
  message: z.string().min(1),
  actions: z.array(z.object({ label: z.string(), path: z.string(), reason: z.string() })),
  evidenceIds: z.array(z.string()).min(1),
});
let queueRunning = false;

function factsForSnapshot(snap: any) {
  return [
    {
      id: 'overall',
      text: `${snap.stats.attempts} objective attempts, ${snap.stats.accuracy === null ? 'no accuracy yet' : snap.stats.accuracy + '% accuracy'}, ${snap.stats.due} due cards, ${snap.stats.studyDays} active days. Self-ratings excluded.`,
    },
    ...snap.byMode.map((m: any) => ({
      id: 'mode:' + m.kind,
      text: `${m.kind}: ${m.correct}/${m.attempts} correct including retries; ${m.firstCorrect}/${m.firstAttempts} correct on first attempt per session and card.`,
    })),
    ...snap.cards.slice(0, 150).map((c: any) => ({
      id: 'card:' + c.id,
      text: `${c.term} [${c.id}]: ${c.progress.correct}/${c.progress.objectiveAttempts} objective answers correct, ${c.progress.recallAttempts} written attempts, ${c.progress.recognitionAttempts} recognition attempts, ${c.progress.selfRatings} self-ratings. Last studied ${c.progress.lastStudied || 'never'}, last answer ${c.progress.lastCorrect === null ? 'unassessed' : c.progress.lastCorrect ? 'correct' : 'incorrect'}, due ${c.progress.dueAt || 'not scheduled'}.`,
    })),
  ];
}

async function chat(job: Job) {
  patchJob(job.id, { stage: 'Reviewing your study history', progress: 15 });
  assertActive(job);
  const snap: any = agentSnapshot(job.courseId || undefined);
  const conversation = get<any>('conversations', job.payload.conversationId);
  if (!conversation) throw Error('This conversation no longer exists.');
  const facts = factsForSnapshot(snap);
  const query =
    all<ChatMessage>('messages')
      .filter((m) => m.conversationId === conversation.id && m.role === 'user')
      .at(-1)
      ?.content.toLowerCase() || '';
  const words = query.split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  const ranked = [...snap.cards].sort((a: any, b: any) => {
    const score = (card: any) =>
      words.filter((w) => `${card.term} ${card.topic}`.toLowerCase().includes(w)).length * 15 +
      (card.progress.lastCorrect === false ? 10 : 0) +
      (card.progress.dueAt && card.progress.dueAt <= now() ? 5 : 0) +
      (card.progress.objectiveAttempts ? 1 : 0);
    return score(b) - score(a);
  });
  const selectedCards = ranked.slice(0, 150);
  const supplied = {
    ...snap,
    cards: selectedCards,
    facts,
    sampling: {
      totalCards: snap.cards.length,
      includedCards: selectedCards.length,
      selection:
        'Errors, due cards, then practiced cards; all-course aggregate stats are complete.',
    },
  };
  const history = all<ChatMessage>('messages')
    .filter((m) => m.conversationId === conversation.id)
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content }));
  patchJob(job.id, { stage: 'Writing a grounded response', progress: 30 });
  const out: any = await runAgent({
    job,
    part: 'insights',
    schema: chatOutput,
    skill: '.agents/skills/progress-insights/SKILL.md',
    request: { snapshot: supplied, conversation: history },
    model: process.env.STUDYROOM_CHAT_MODEL,
    timeoutMs: 180000,
  });
  const allowed = new Set([
    ...supplied.cards.flatMap((c: any) => Object.values(c.actions)),
    ...supplied.availableActions.map((a: any) => a.path),
  ]);
  if (out.evidenceIds.some((ref: string) => !facts.some((f) => f.id === ref)))
    throw Error('The agent returned an evidence reference that could not be verified.');
  if (out.actions.some((a: any) => !allowed.has(a.path)))
    throw Error('The agent returned a study link that could not be verified.');
  transaction(() => {
    const messageId = id();
    put('messages', {
      id: messageId,
      conversationId: conversation.id,
      role: 'assistant',
      content: out.message,
      actions: out.actions,
      evidence: out.evidenceIds.map((ref: string) => facts.find((f) => f.id === ref)!.text),
      evidenceIds: out.evidenceIds,
      jobId: job.id,
      createdAt: now(),
    });
    patchJob(job.id, {
      status: 'completed',
      stage: 'Response ready',
      progress: 100,
      resultId: messageId,
    });
  });
}

async function reviewExistingSet(job: Job) {
  const set = get<any>('sets', job.payload.setId);
  if (!set) throw Error('This study set no longer exists.');
  const cards = all<any>('cards').filter((card) => card.setId === set.id && !card.archived);
  const sources = (set.sourceIds || [])
    .map((sourceId: string) => get<Source>('sources', sourceId))
    .filter(Boolean) as Source[];
  const assets = all<Asset>('assets').filter((asset) =>
    sources.some((source) => source.id === asset.sourceId),
  );
  const units = sources.flatMap((source) =>
    evidenceUnits(
      source,
      fs.readFileSync(source.textPath, 'utf8'),
      assets.filter((asset) => asset.sourceId === source.id),
    ),
  );
  if (!sources.length || !units.length)
    throw Error('No readable source evidence is available for this set.');
  patchJob(job.id, { stage: 'Checking the saved set against its sources', progress: 25 });
  const report: any = await runAgent({
    job,
    part: 'quality-review',
    schema: auditOutput,
    skill: '.agents/skills/review-set/SKILL.md',
    request: {
      task: 'Review this existing saved set only. Do not rewrite it.',
      title: set.title,
      evidence: units,
      cards,
      skipped: set.coverage?.skipped || [],
      images: assets.map((asset) => ({
        ref: units.find((unit) => unit.assetId === asset.id)?.ref,
        locator: asset.locator,
        width: asset.width,
        height: asset.height,
      })),
    },
    model: process.env.STUDYROOM_REVIEW_MODEL,
    images: assets,
    timeoutMs: 180000,
  });
  if (
    report.issues.some((issue: any) => issue.index < 0 || issue.index >= cards.length) ||
    report.missing.some((gap: any) =>
      gap.refs.some((ref: string) => !units.some((unit) => unit.ref === ref)),
    )
  )
    throw Error('The review returned an unknown card or evidence reference.');
  const qualityReview = report.issues.length || report.missing.length ? 'issues-found' : 'passed';
  const warnings = [...(set.warnings || [])].filter(
    (warning: string) => !warning.startsWith('Recovered a saved draft'),
  );
  if (qualityReview === 'issues-found')
    warnings.push(
      `Quality review found ${report.issues.length} card issues and ${report.missing.length} coverage gaps. Open the job diagnostics for the reviewer findings.`,
    );
  put('sets', {
    ...set,
    warnings,
    coverage: {
      ...(set.coverage || {}),
      qualityReview,
      qualityReviewReport: report,
      reviewedAt: now(),
    },
    updatedAt: now(),
  });
  patchJob(job.id, {
    status: qualityReview === 'passed' ? 'completed' : 'failed',
    stage: qualityReview === 'passed' ? 'Quality review passed' : 'Review found issues to repair',
    progress: 100,
    resultId: set.id,
    error:
      qualityReview === 'passed'
        ? null
        : 'The reviewer found issues. See the job log and edit the flagged cards.',
  });
}

export function enqueue(kind: 'set' | 'chat' | 'review', courseId: string | null, payload: any) {
  const job: Job = {
    id: id(),
    kind,
    courseId,
    payload,
    status: 'queued',
    stage: 'Waiting to start',
    progress: 0,
    error: null,
    resultId: null,
    createdAt: now(),
    updatedAt: now(),
  };
  put('jobs', job);
  void runQueue();
  return job;
}

export async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (true) {
      const job = all<Job>('jobs').find((j) => j.status === 'queued');
      if (!job) break;
      patchJob(job.id, {
        status: 'running',
        stage: 'Getting started',
        progress: 2,
        startedAt: now(),
      });
      try {
        if (job.kind === 'set') await generateSet(job);
        else if (job.kind === 'review') await reviewExistingSet(job);
        else await chat(job);
      } catch (error) {
        const fresh = get<Job>('jobs', job.id);
        if (fresh?.status !== 'cancelled')
          patchJob(job.id, {
            status: 'failed',
            stage: 'Needs attention · your saved work is kept',
            error: error instanceof Error ? error.message : String(error),
          });
      } finally {
        clearUnavailable(job.id);
      }
    }
  } finally {
    queueRunning = false;
  }
}

export function recoverJobs() {
  for (const job of all<Job>('jobs')) {
    if (job.status === 'running')
      patchJob(job.id, {
        status: 'failed',
        stage: 'Interrupted by a restart · retry continues where it left off',
        error:
          'The app restarted while this job was running. Retry to continue from its checkpoints.',
      });
  }
  void runQueue();
}

export function cancelJob(job: Job) {
  patchJob(job.id, { status: 'cancelled', stage: 'Cancelled', error: null });
  stopAgents(job.id);
}

export function shutdownAgents() {
  stopAgents();
}
