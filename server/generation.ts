import fs from 'node:fs';
import path from 'node:path';
import { all, get, put, DATA, ROOT, id, now, transaction } from './db';
import { materializeImage, type Asset } from './assets';
import { runAgent, atomicJSON, assertActive, patchJob } from './agent-runner';
import { currentHarness, agentSelections } from './harness';
import {
  batchOutput,
  repairOutput,
  auditOutput,
  evidenceUnits,
  makeBatches,
  cardErrors,
  hydrateCard,
  uncovered,
  stableHash,
  canonical,
  type Batch,
  type BatchOutput,
  type DraftCard,
  type Evidence,
} from './generation-contract';
import type { Job, Source } from '../src/types';

import {
  requirementsOutput,
  noRequirements,
  validateRequirements,
  countProblem,
  validateSetPlan,
  countPlanOutput,
  validateCountPlan,
  requirementChecks,
  requirementFailures,
  type Requirements,
  type SetPlan,
} from './generation-requirements';

import { planSet, needsVisualAllocation } from './generation-planner';
import { largeReview, reviewInParts } from './generation-review';
import { completeTargetedRepair } from './generation-repair';

const VERSION = 4;
const CONCURRENCY = 3;
const createSkill = '.agents/skills/create-set/SKILL.md';
const reviewSkill = '.agents/skills/review-set/SKILL.md';
type Call = typeof runAgent;
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failure && cursor < items.length) {
        const index = cursor++;
        try {
          results[index] = await work(items[index], index);
        } catch (error) {
          failure ||= error;
        }
      }
    }),
  );
  if (failure) throw failure;
  return results;
}

async function recoverLegacyDraft(job: Job, sources: Source[], assets: Asset[]) {
  let previousId = job.payload.resumeFromJobId;
  let previous: Job | undefined;
  let priorDir = '';
  for (let depth = 0; previousId && depth < 20; depth++) {
    previous = get<Job>('jobs', previousId);
    if (!previous || previous.courseId !== job.courseId) return null;
    priorDir = path.join(DATA, 'jobs', previous.id);
    if (fs.existsSync(path.join(priorDir, 'part-1-result.json'))) break;
    previousId = previous.payload?.resumeFromJobId;
  }
  if (!previous || !fs.existsSync(path.join(priorDir, 'part-1-result.json'))) return null;
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(priorDir, 'part-1-result.json'), 'utf8'));
  } catch {
    return null;
  }
  if (
    !raw?.cards?.length ||
    raw.cards.some((card: any) => !card.term || !card.definition || !Array.isArray(card.sources))
  )
    return null;
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const textMap = new Map(
    sources.map((source) => [source.id, canonical(fs.readFileSync(source.textPath, 'utf8'))]),
  );
  const termKeys = new Set<string>(),
    definitionKeys = new Set<string>();
  const cards: any[] = [];
  try {
    for (const draft of raw.cards) {
      if (termKeys.has(canonical(draft.term)) || definitionKeys.has(canonical(draft.definition)))
        throw Error('duplicate cue or answer');
      termKeys.add(canonical(draft.term));
      definitionKeys.add(canonical(draft.definition));
      if (new Set([draft.definition, ...(draft.distractors || [])].map(canonical)).size !== 4)
        throw Error('duplicate answer choices');
      for (const ref of draft.sources) {
        if (!sourceMap.has(ref.sourceId)) throw Error('unknown source');
        if (ref.assetId) {
          if (!assets.some((asset) => asset.id === ref.assetId && asset.sourceId === ref.sourceId))
            throw Error('unknown visual citation');
        } else if (!ref.quote?.trim() || !textMap.get(ref.sourceId)?.includes(canonical(ref.quote)))
          throw Error(`unverified quote for ${draft.term}`);
      }
      let image = null;
      if (draft.image) {
        if (!assets.some((asset) => asset.id === draft.image.assetId))
          throw Error('unknown card image');
        image = await materializeImage(
          draft.image,
          sources.map((source) => source.id),
        );
      }
      cards.push({ ...draft, image });
    }
  } catch {
    return null;
  }
  const setId = id();
  const warnings = [
    ...(raw.warnings || []),
    'Recovered a saved draft from an earlier attempt. The full quality review will run when you retry this job.',
  ];
  const summary = raw.description || 'Recovered source-grounded study set.';
  transaction(() => {
    put('sets', {
      id: setId,
      courseId: job.courseId,
      title: job.payload.title,
      description: summary,
      createdAt: now(),
      updatedAt: now(),
      archived: false,
      origin: 'lecture',
      warnings,
      sourceIds: sources.map((source) => source.id),
      coverage: { recoveredCards: cards.length, qualityReview: 'pending' },
      generationJobId: job.id,
    });
    cards.forEach((card, position) =>
      put('cards', { ...card, id: id(), setId, position, version: 1, starred: false }),
    );
    patchJob(job.id, {
      status: 'completed',
      stage: 'Ready to study · quality review pending',
      progress: 100,
      resultId: setId,
      elapsedMs: 0,
      error: null,
      recoveredFromJobId: previous.id,
    });
  });
  return setId;
}
function imageManifest(units: Evidence[], images: Asset[]) {
  return images.map((image, index) => ({
    index: index + 1,
    ref: units.find((u) => u.assetId === image.id)!.ref,
    locator: image.locator,
    width: image.width,
    height: image.height,
  }));
}
function mergeDrafts(cards: DraftCard[]) {
  const result: DraftCard[] = [];
  for (const card of cards) {
    const existing = result.find((c) => canonical(c.answer) === canonical(card.answer));
    if (existing) {
      existing.refs = [...new Set([...existing.refs, ...card.refs])];
      if (!existing.image && card.image) existing.image = card.image;
    } else result.push(structuredClone(card));
  }
  return result;
}
export async function validateBatch(
  job: Job,
  batch: Batch,
  initial: BatchOutput,
  context: any,
  call: Call = runAgent,
  targetCount?: number,
): Promise<BatchOutput> {
  let result = structuredClone(initial);
  for (let repair = 0; repair < 2; repair++) {
    const bad = result.cards.flatMap((card, index) => {
      const errors = cardErrors(card, batch.units);
      return errors.length ? [{ index, card, errors }] : [];
    });
    const missing = uncovered(result, batch.units);
    const foreignSkips = result.skipped.filter((s) => !batch.units.some((u) => u.ref === s.ref));
    const wrongCount = targetCount !== undefined && result.cards.length > targetCount;
    if (!bad.length && !missing.length && !foreignSkips.length && !wrongCount) return result;
    if (repair === 1 && wrongCount)
      throw Error(
        `This batch produced ${result.cards.length} supported cards but its budget is ${targetCount}. Your work is saved; the set will not publish outside your requirements.`,
      );
    if (repair === 1)
      throw Error(
        'Some cards could not be completed after a retry. Your saved cards are kept; retry to continue.',
      );
    if (wrongCount) {
      patchJob(job.id, { stage: 'Adjusting this batch to your set budget' });
      result = batchOutput.parse(
        await call({
          job,
          part: `batch-${batch.key}-count-repair`,
          schema: batchOutput,
          skill: createSkill,
          images: batch.images,
          request: {
            ...context,
            task: 'budget-repair',
            evidence: batch.units,
            images: imageManifest(batch.units, batch.images),
            draft: result,
            cardBudget: { exact: targetCount },
            instruction:
              'Return this batch with exactly cardBudget.exact cards. Keep the strongest supported targets and repair defects. Account for other evidence with specific skip reasons under the whole-set budget. Never pad with duplicates or invented facts. If the evidence cannot support the budget, return only supported cards; the server will report the shortfall.',
          },
        }),
      );
      continue;
    }
    patchJob(job.id, { stage: 'Improving a few cards; your saved work is kept' });
    const fixed = await call({
      job,
      part: `batch-${batch.key}-repair`,
      schema: repairOutput,
      skill: createSkill,
      images: batch.images,
      request: {
        task: 'repair',
        ...context,
        cardBudget:
          targetCount === undefined ? null : { exact: targetCount, allowSupportedShortfall: true },
        evidence: batch.units,
        images: imageManifest(batch.units, batch.images),
        badCards: bad,
        missing: missing.map((u) => ({
          ref: u.ref,
          reason: 'Not yet covered or explicitly skipped',
        })),
        validTargets: result.cards
          .filter((_, index) => !bad.some((b) => b.index === index))
          .map((c) => ({ term: c.term, answer: c.answer })),
        instruction:
          'Return replacements only for badCards indices, additions for missing learning targets, and explicit skipped reasons for non-study evidence. Do not repeat validTargets.',
      },
    });
    for (const replacement of fixed.replacements) {
      if (!bad.some((b) => b.index === replacement.index))
        throw Error('Repair attempted to change a valid card.');
      result.cards[replacement.index] = replacement.card;
    }
    result.cards.push(...fixed.additions);
    result.skipped = [...result.skipped.filter((s) => !foreignSkips.includes(s)), ...fixed.skipped];
  }
  return result;
}
function cacheDirectories(job: Job) {
  const dirs = [path.join(DATA, 'jobs', job.id)];
  let previousId = job.payload.resumeFromJobId;
  for (let i = 0; previousId && i < 20; i++) {
    const previous = get<Job>('jobs', previousId);
    if (
      !previous ||
      previous.courseId !== job.courseId ||
      JSON.stringify(previous.payload.sourceIds) !== JSON.stringify(job.payload.sourceIds)
    )
      break;
    dirs.push(path.join(DATA, 'jobs', previous.id));
    previousId = previous.payload.resumeFromJobId;
  }
  return dirs;
}
function loadCache(dirs: string[], name: string, fingerprint: string): any | null {
  for (const dir of dirs) {
    try {
      const cached = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (cached.fingerprint === fingerprint) return cached.result;
    } catch {}
  }
  return null;
}
function splitBatch(batch: Batch): Batch[] {
  const half = Math.max(1, Math.ceil(batch.units.length / 2));
  return [batch.units.slice(0, half), batch.units.slice(half)]
    .filter((units) => units.length)
    .map((units) => {
      const ids = new Set(units.flatMap((unit) => (unit.assetId ? [unit.assetId] : [])));
      return {
        key: stableHash(units.map((unit) => [unit.ref, unit.text])).slice(0, 16),
        units,
        images: batch.images.filter((asset) => ids.has(asset.id)),
      };
    });
}
export async function generateSet(job: Job, call: Call = runAgent) {
  const began = Date.now();
  const sources = (job.payload.sourceIds as string[]).map((sourceId) =>
    get<Source>('sources', sourceId),
  );
  if (sources.some((s) => !s || s.courseId !== job.courseId || s.status !== 'ready'))
    throw Error('Every selected source must be ready and belong to this course.');
  const ready = sources as Source[];
  const assets = all<Asset>('assets').filter((a) => ready.some((s) => s.id === a.sourceId));
  const legacy = job.payload.instructions?.trim()
    ? null
    : await recoverLegacyDraft(job, ready, assets);
  if (legacy) return legacy;
  const units = ready.flatMap((s) =>
    evidenceUnits(
      s,
      fs.readFileSync(s.textPath, 'utf8'),
      assets.filter((a) => a.sourceId === s.id),
    ),
  );
  if (!units.length) throw Error('No readable text or visual evidence was found.');
  const batches = makeBatches(units, assets);
  const dirs = cacheDirectories(job),
    dir = dirs[0];
  const context = {
    title: job.payload.title,
    instructions: job.payload.instructions || '',
    course: get('courses', job.courseId!),
    overview: ready.map((s) => ({
      name: s.name,
      sections: [
        ...new Set(
          units
            .filter((u) => u.sourceId === s.id && !u.assetId)
            .map((u) => u.locator + ': ' + u.text.split('\n')[0].slice(0, 100)),
        ),
      ],
    })),
  };
  const fingerprint = stableHash({
    version: VERSION,
    context,
    units,
    images: assets.map((a) => [a.id, a.width, a.height]),
    model: process.env.STUDYROOM_AGENT_MODEL || 'gpt-5.6-sol',
    agent: { harness: currentHarness(), selections: agentSelections() },
    skills: [createSkill, reviewSkill].map((s) => fs.readFileSync(path.join(ROOT, s), 'utf8')),
  });
  let requirements: Requirements = noRequirements;
  const instructions = job.payload.instructions?.trim() || '';
  if (instructions) {
    patchJob(job.id, { stage: 'Reading your set requirements' });
    const cached = loadCache(dirs, 'requirements-checkpoint.json', fingerprint);
    requirements = validateRequirements(
      cached ||
        (await call({
          job,
          part: 'requirements',
          schema: requirementsOutput,
          skill: createSkill,
          request: {
            task: 'interpret-requirements',
            instructions,
            instruction:
              'Interpret only the user instructions supplied here, not uploaded material. Extract whole-set card-count bounds: exactly N means min=max=N; at least N sets min only; at most/up to N sets max only; between A and B or A-B means min=A,max=B. A range followed by maximum still means that range unless clearly overridden. Understand numbers written as words and paraphrases, distinguish examples, negation, per-topic counts and unrelated numbers. Respect explicit later corrections. Do not invent bounds for vague preferences. Quote the exact text supporting every bound. Preserve other explicit content, style, language, and scope requirements as independently checkable instructions with exact quotes. Treat aspirations such as getting 100% on an exam as priorities, not promises. Report contradictory or ambiguous mandatory requirements in conflicts rather than guessing. Do not generate cards.',
          },
        })),
      instructions,
    );
    atomicJSON(path.join(dir, 'requirements-checkpoint.json'), {
      fingerprint,
      result: requirements,
    });
  }
  patchJob(job.id, { requirements });
  const constrained = requirements.cardCount.min !== null || requirements.cardCount.max !== null;
  let setPlan: SetPlan | null = null;
  const overview = batches.map((batch) => ({
    batchKey: batch.key,
    evidence: batch.units.map((unit) => ({
      ref: unit.ref,
      name: unit.name,
      locator: unit.locator,
      excerpt: unit.text.slice(0, 500),
    })),
  }));
  if (constrained) {
    patchJob(job.id, { stage: 'Planning the whole set within your card limit' });
    const cachedPlan = loadCache(dirs, 'set-plan-checkpoint.json', fingerprint);
    setPlan = validateSetPlan(
      (cachedPlan && !needsVisualAllocation(cachedPlan, batches) ? cachedPlan : null) ||
        (await planSet({
          job,
          requirements,
          batches,
          call,
          load: (name) => loadCache(dirs, name, fingerprint),
          save: (name, result) => atomicJSON(path.join(dir, name), { fingerprint, result }),
          stage: (stage) => patchJob(job.id, { stage }),
          assertActive: () => assertActive(job),
          harness: currentHarness(),
        })),
      batches.map((b) => b.key),
      requirements,
    );
    atomicJSON(path.join(dir, 'set-plan-checkpoint.json'), { fingerprint, result: setPlan });
    patchJob(job.id, { plannedCards: setPlan.targetCount });
  }
  const generationContext = { ...context, requirements, setPlan };
  const budgets = new Map<string, number>();
  const assignBudget = (batch: Batch, count: number, depth = 0) => {
    budgets.set(batch.key, count);
    if (depth >= 2 || batch.units.length < 2) return;
    const parts = splitBatch(batch);
    const first = Math.ceil((count * parts[0].units.length) / batch.units.length);
    assignBudget(parts[0], first, depth + 1);
    assignBudget(parts[1], count - first, depth + 1);
  };
  for (const batch of batches) {
    const allocation = setPlan?.allocations.find((a) => a.batchKey === batch.key);
    if (allocation) assignBudget(batch, allocation.count);
  }
  // Older runs saved split children without saving their combined parent.
  // Restore the tree before scheduling calls so retries never redo saved pieces.
  const restored = new Map<string, BatchOutput>();
  const restore = (batch: Batch, depth = 0): BatchOutput | null => {
    const cached = loadCache(dirs, `batch-${batch.key}-checkpoint.json`, fingerprint);
    if (cached) {
      const parsed = batchOutput.safeParse(cached);
      if (
        parsed.success &&
        !parsed.data.cards.some((card) => cardErrors(card, batch.units).length) &&
        !uncovered(parsed.data, batch.units).length &&
        (!budgets.has(batch.key) || parsed.data.cards.length <= budgets.get(batch.key)!) &&
        !parsed.data.skipped.some((skip) => !batch.units.some((unit) => unit.ref === skip.ref))
      ) {
        restored.set(batch.key, parsed.data);
        return parsed.data;
      }
    }
    const before = restored.size;
    if (depth < 2 && batch.units.length > 1) {
      const children = splitBatch(batch).map((part) => restore(part, depth + 1));
      if (children.every((child) => child)) {
        const result = {
          cards: children.flatMap((child) => child!.cards),
          skipped: children.flatMap((child) => child!.skipped),
        };
        restored.set(batch.key, result);
        return result;
      }
    }
    // Keep completed descendants instead of replacing them with an older parent draft.
    if (restored.size > before) return null;
    // Older versions rejected supported shortfalls before writing a checkpoint.
    // Recover only complete outputs from the same input fingerprint and exact evidence.
    for (const previousDir of dirs) {
      try {
        const pipeline = JSON.parse(
          fs.readFileSync(path.join(previousDir, 'pipeline.json'), 'utf8'),
        );
        if (pipeline.fingerprint !== fingerprint) continue;
      } catch {
        continue;
      }
      for (const suffix of ['-count-repair', '']) {
        for (let attempt = 3; attempt >= 1; attempt--) {
          const prefix = `batch-${batch.key}${suffix}-attempt-${attempt}`;
          try {
            const request = JSON.parse(
              fs.readFileSync(path.join(previousDir, `${prefix}-request.json`), 'utf8'),
            );
            if (stableHash(request.evidence) !== stableHash(batch.units)) continue;
            const candidate = batchOutput.parse(
              JSON.parse(fs.readFileSync(path.join(previousDir, `${prefix}-result.json`), 'utf8')),
            );
            if (
              candidate.cards.some((card) => cardErrors(card, batch.units).length) ||
              uncovered(candidate, batch.units).length ||
              candidate.skipped.some(
                (skip) => !batch.units.some((unit) => unit.ref === skip.ref),
              ) ||
              (budgets.has(batch.key) && candidate.cards.length > budgets.get(batch.key)!)
            )
              continue;
            restored.set(batch.key, candidate);
            return candidate;
          } catch {}
        }
      }
    }
    return null;
  };
  batches.forEach((batch) => restore(batch));
  const savedCount = (batch: Batch, depth = 0): number => {
    const saved = restored.get(batch.key);
    if (saved) return saved.cards.length;
    return depth < 2 && batch.units.length > 1
      ? splitBatch(batch).reduce((count, part) => count + savedCount(part, depth + 1), 0)
      : 0;
  };
  const hasSavedChild = (batch: Batch, depth: number): boolean =>
    depth < 2 &&
    batch.units.length > 1 &&
    splitBatch(batch).some((part) => restored.has(part.key) || hasSavedChild(part, depth + 1));
  const states = batches.map((b) => ({
    key: b.key,
    status: restored.has(b.key) ? 'validated' : 'queued',
    cards: savedCount(b),
  }));
  const progress = (stage?: string) => {
    const complete = states.filter((s) => s.status === 'validated').length;
    patchJob(job.id, {
      stage: stage || 'Creating cards',
      progress: 8 + Math.round((complete / batches.length) * 60),
      pipelineVersion: VERSION,
      details: {
        batches: states,
        evidenceUnits: units.length,
        stagedCards: states.reduce((n, s) => n + s.cards, 0),
      },
    });
    atomicJSON(path.join(dir, 'pipeline.json'), {
      version: VERSION,
      fingerprint,
      states,
      updatedAt: now(),
    });
  };
  progress('Planning your set');
  const outputs = await mapLimit(batches, CONCURRENCY, async (batch, index) => {
    assertActive(job);
    if (!restored.has(batch.key)) states[index].status = 'running';
    progress();
    const run = async (current: Batch, depth: number): Promise<BatchOutput> => {
      const cacheName = `batch-${current.key}-checkpoint.json`;
      const targetCount = budgets.get(current.key);
      let result: any = restored.get(current.key);
      if (!result && targetCount === 0)
        result = {
          cards: [],
          skipped: current.units.map((unit) => ({
            ref: unit.ref,
            reason: `Not selected under the whole-set card budget. ${setPlan!.allocations.find((a) => a.batchKey === batch.key)!.focus}`,
          })),
        };
      const runParts = async (): Promise<BatchOutput> => {
        const done: BatchOutput[] = [];
        for (const part of splitBatch(current)) done.push(await run(part, depth + 1));
        const combined = {
          cards: done.flatMap((output) => output.cards),
          skipped: done.flatMap((output) => output.skipped),
        };
        atomicJSON(path.join(dir, cacheName), {
          fingerprint,
          result: combined,
          validatedAt: now(),
        });
        return combined;
      };
      if (!result && hasSavedChild(current, depth)) return runParts();
      try {
        if (!result) {
          result = await call({
            job,
            part: `batch-${current.key}`,
            schema: batchOutput,
            skill: createSkill,
            images: current.images,
            request: {
              task: 'create',
              ...generationContext,
              cardBudget:
                targetCount === undefined
                  ? null
                  : { exact: targetCount, allowSupportedShortfall: true },
              budgetInstruction:
                'The exact allocation is a target and upper bound, not a mandatory batch minimum. Return fewer cards when the evidence cannot support that many distinct targets, with explicit skip reasons for all remaining evidence. Study-guide questions without answers may guide coverage elsewhere but do not justify invented answers. The server enforces the minimum on the complete set.',
              batch: { index: index + 1, total: batches.length },
              evidence: current.units,
              images: imageManifest(current.units, current.images),
            },
          });
          result = await validateBatch(
            job,
            current,
            batchOutput.parse(result),
            generationContext,
            call,
            targetCount,
          );
        }
        atomicJSON(path.join(dir, cacheName), { fingerprint, result, validatedAt: now() });
        return result as BatchOutput;
      } catch (error) {
        if (depth >= 2 || current.units.length < 2) throw error;
        patchJob(job.id, { stage: 'Trying this part in smaller pieces' });
        return runParts();
      }
    };
    try {
      const result = await run(batch, 0);
      states[index] = { key: batch.key, status: 'validated', cards: result.cards.length };
      progress();
      return result;
    } catch (error) {
      states[index].status = 'failed';
      progress(
        `Some cards need another pass; ${states.filter((s) => s.status === 'validated').length} saved`,
      );
      throw error;
    }
  });
  let drafts = mergeDrafts(outputs.flatMap((out) => out.cards));
  let skipped = outputs.flatMap((out) => out.skipped);
  if (!drafts.length) throw Error('These materials do not contain anything that can become cards.');
  const reconcileCount = async () => {
    for (let attempt = 0; countProblem(drafts.length, requirements) && attempt < 2; attempt++) {
      patchJob(job.id, { stage: 'Checking the whole-set card count' });
      const target = Math.max(
        requirements.cardCount.min || 1,
        Math.min(drafts.length, requirements.cardCount.max ?? drafts.length),
      );
      const request = {
        task: 'reconcile-count',
        ...generationContext,
        targetCount: target,
        cards: drafts.map((card, index) => ({
          index,
          term: card.term,
          answer: card.answer,
          topic: card.topic,
          refs: card.refs,
        })),
        batches: overview,
        instruction:
          'Plan the smallest count correction. If over targetCount, select the strongest existing cards across topics and user priorities with keepIndices; do not truncate by position. If under targetCount, keep every existing card and allocate only the deficit to supported missing targets, at most 12 cards per addition group. The retained count plus additions must equal targetCount. Never request duplicate targets or invent material to fill a quota.',
      };
      const key = `count-plan-${stableHash(request).slice(0, 18)}`;
      const plan = validateCountPlan(
        loadCache(dirs, `${key}-checkpoint.json`, fingerprint) ||
          (await call({
            job,
            part: key,
            request,
            schema: countPlanOutput,
            skill: createSkill,
          })),
        drafts.length,
        target,
        batches.map((b) => b.key),
      );
      atomicJSON(path.join(dir, `${key}-checkpoint.json`), { fingerprint, result: plan });
      const kept = plan.keepIndices.map((index) => drafts[index]);
      const additions: DraftCard[] = [];
      for (const [index, addition] of plan.additions.entries()) {
        const batch = batches.find((b) => b.key === addition.batchKey)!;
        const additionRequest = {
          ...generationContext,
          task: 'create',
          evidence: batch.units,
          images: imageManifest(batch.units, batch.images),
          cardBudget: { exact: addition.count },
          focus: addition.focus,
          validTargets: [...kept, ...additions].map((c) => ({ term: c.term, answer: c.answer })),
          instruction:
            'Create only the requested additional distinct supported targets. Do not repeat validTargets. Account for already-covered evidence with explicit skip reasons.',
        };
        const part = `count-add-${stableHash({ key, index, additionRequest }).slice(0, 18)}`;
        let output = loadCache(dirs, `${part}-checkpoint.json`, fingerprint);
        if (!output)
          output = await call({
            job,
            part,
            request: additionRequest,
            schema: batchOutput,
            skill: createSkill,
            images: batch.images,
          });
        output = await validateBatch(
          job,
          batch,
          batchOutput.parse(output),
          additionRequest,
          call,
          addition.count,
        );
        atomicJSON(path.join(dir, `${part}-checkpoint.json`), { fingerprint, result: output });
        additions.push(...output.cards);
      }
      const next = mergeDrafts([...kept, ...additions]);
      const covered = new Set(next.flatMap((c) => [...c.refs, ...(c.image ? [c.image.ref] : [])]));
      for (const unit of units)
        if (!covered.has(unit.ref) && !skipped.some((skip) => skip.ref === unit.ref))
          skipped.push({
            ref: unit.ref,
            reason: `Not selected under the whole-set card limit. ${plan.explanation}`,
          });
      drafts = next;
    }
    const problem = countProblem(drafts.length, requirements);
    if (problem)
      throw Error(
        `${problem} Count repair could not meet your requirements with distinct supported cards. Your draft is saved; it has not been published.`,
      );
  };
  let summary = '';
  let finalCards: any[] = [];
  let reviewFindings: {
    issues: any[];
    missing: any[];
    summary: string;
    failedRequirements?: string[];
  } | null = null;
  for (let round = 0; round < 2; round++) {
    assertActive(job);
    await reconcileCount();
    patchJob(job.id, {
      stage: round ? 'Checking the fixes' : 'Reviewing your set for accuracy and coverage',
      progress: 75 + round * 12,
    });
    finalCards = await Promise.all(
      drafts.map(async (draft) => {
        const card = hydrateCard(draft, units);
        return {
          ...card,
          image: await materializeImage(
            card.image,
            ready.map((s) => s.id),
          ),
        };
      }),
    );
    const reviewImages = finalCards.flatMap((card, index) => {
      if (!card.image) return [];
      const asset = assets.find((a) => a.id === card.image.assetId)!;
      const crop = card.image.cropId && get<any>('crops', card.image.cropId);
      return [
        {
          cardIndex: index,
          side: card.image.side,
          asset: { ...asset, path: crop?.path || asset.path },
        },
      ];
    });
    const reviewGroups = [reviewImages.slice(0, 8)];
    for (let i = 8; i < reviewImages.length; i += 8)
      reviewGroups.push(reviewImages.slice(i, i + 8));
    const reviewGroup = async (images: typeof reviewImages, group: number) => {
      const reviewedCards = drafts
        .map((card, index) => ({ index, ...card }))
        .filter((c) => group === 0 || images.some((i) => i.cardIndex === c.index));
      const request = {
        task: group
          ? 'Review only these cards and their images. Do not report unrelated coverage gaps.'
          : 'Review all cards and all evidence for material errors and missing learning targets.',
        title: job.payload.title,
        instructions: context.instructions,
        requirements,
        setPlan,
        requirementInstruction:
          'The whole-set count and user scope take precedence over exhaustive coverage. Study-guide questions without answers define priorities, not standalone factual evidence: check their coverage against instructional cards from other sources. For a missing target, cite the explanatory evidence needed to repair it, not only an unanswered study-guide question. Do not ask to add every omitted detail when a bounded set deliberately prioritizes stronger targets. Check every non-count requirement by its zero-based index on the main review, with satisfied and a concrete reason. Report fixable violations in issues or missing as well. For a required addition at the maximum, propose a substitution for a weaker card in issues instead of increasing the count.',
        evidence: group
          ? units.filter((u) =>
              reviewedCards.some((c) => c.refs.includes(u.ref) || c.image?.ref === u.ref),
            )
          : units,
        cards: reviewedCards,
        skipped: group ? [] : skipped,
        images: images.map((image, index) => ({
          index: index + 1,
          cardIndex: image.cardIndex,
          side: image.side,
          exactDisplayedCrop: true,
        })),
      };
      const reviewHash = stableHash(request).slice(0, 18),
        name = `review-${reviewHash}-checkpoint.json`;
      let report = loadCache(dirs, name, fingerprint);
      if (!report) {
        report =
          group === 0 && largeReview(request)
            ? await reviewInParts({
                job,
                request,
                images: images.map((i) => i.asset),
                call,
                load: (name) => loadCache(dirs, name, fingerprint),
                save: (name, result) => atomicJSON(path.join(dir, name), { fingerprint, result }),
                stage: (stage) => patchJob(job.id, { stage }),
                assertActive: () => assertActive(job),
                harness: currentHarness(),
                map: mapLimit,
              })
            : await call({
                job,
                part: `review-${reviewHash}`,
                request,
                schema:
                  group === 0 && requirements.requirements.length
                    ? auditOutput.extend({ requirementChecks })
                    : auditOutput,
                skill: reviewSkill,
                images: images.map((i) => i.asset),
                model: process.env.STUDYROOM_REVIEW_MODEL,
              });
        atomicJSON(path.join(dir, name), { fingerprint, result: report, reviewedAt: now() });
      }
      if (
        report.issues.some((issue: any) => !reviewedCards.some((c) => c.index === issue.index)) ||
        report.missing.some((missing: any) =>
          missing.refs.some((ref: string) => !units.some((u) => u.ref === ref)),
        )
      )
        throw Error(
          'Review returned an unknown evidence or card reference. Completed generation is saved.',
        );
      return report;
    };
    const mainReport = await reviewGroup(reviewGroups[0], 0);
    const reports = [
      mainReport,
      ...(await mapLimit(reviewGroups.slice(1), CONCURRENCY, (images, index) =>
        reviewGroup(images, index + 1),
      )),
    ];
    const issues: { index: number; reason: string }[] = reports.flatMap((r) => r.issues);
    const missing: { refs: string[]; reason: string }[] = reports.flatMap((r) => r.missing);
    const failedRequirements = requirements.requirements.length
      ? requirementFailures(reports[0].requirementChecks, requirements)
      : [];
    // Identical cues with different answers remain ambiguous in Match even if the reviewer misses them.
    drafts.forEach((card, index) => {
      if (drafts.some((other, i) => i < index && canonical(other.term) === canonical(card.term)))
        issues.push({
          index,
          reason:
            'This cue duplicates another card but has a different answer. Make the cue unambiguous.',
        });
    });
    summary = reports[0].summary;
    atomicJSON(path.join(dir, `quality-round-${round + 1}.json`), {
      issues,
      missing,
      summary,
      failedRequirements,
    });
    if (!issues.length && !missing.length && !failedRequirements.length) break;
    if (round === 1) {
      if (failedRequirements.length && !job.payload.allowQualityWarnings)
        throw Error(
          `The draft still violates your set requirements: ${failedRequirements.join(' ')} Your work is saved; it has not been published.`,
        );
      reviewFindings = { issues, missing, summary, failedRequirements };
      break;
    }
    patchJob(job.id, {
      stage: `Improving ${new Set(issues.map((i) => i.index)).size} cards and filling ${missing.length} gaps`,
      progress: 83,
    });
    const repairGroups = batches
      .map((batch) => ({
        batch,
        issues: issues.filter((issue) =>
          batch.units.some((u) => u.ref === drafts[issue.index].refs[0]),
        ),
        missing: missing.filter((gap) => batch.units.some((u) => u.ref === gap.refs[0])),
      }))
      .filter((group) => group.issues.length || group.missing.length);
    const repaired = await mapLimit(
      repairGroups,
      CONCURRENCY,
      async ({ batch, issues, missing }) => {
        const badIndices = [...new Set(issues.map((i) => i.index))];
        const requiredRefs = new Set([
          ...batch.units.map((u) => u.ref),
          ...badIndices.flatMap((index) => drafts[index].refs),
          ...missing.flatMap((m) => m.refs),
        ]);
        const evidence = units.filter((u) => requiredRefs.has(u.ref));
        const images = assets.filter((a) => evidence.some((u) => u.assetId === a.id));
        const request = {
          task: 'repair',
          ...generationContext,
          currentSetCount: drafts.length,
          remainingCardCapacity:
            requirements.cardCount.max === null
              ? null
              : Math.max(0, requirements.cardCount.max - drafts.length),
          evidence,
          images: imageManifest(evidence, images),
          badCards: badIndices.map((index) => ({
            index,
            card: drafts[index],
            errors: issues.filter((i) => i.index === index).map((i) => i.reason),
          })),
          missing,
          validTargets: drafts
            .filter((_, i) => !badIndices.includes(i))
            .map((c) => ({ term: c.term, answer: c.answer })),
          instruction:
            'Change only listed badCards; add supported cards for missing targets. Preserve all valid targets. Every replacement must resolve its reviewer finding.',
        };
        const key = stableHash(request).slice(0, 18),
          name = `correction-${key}-checkpoint.json`;
        let fixed =
          loadCache(dirs, name, fingerprint) ||
          loadCache(dirs, `correction-${key}-progress.json`, fingerprint);
        if (!fixed) {
          for (const previousDir of dirs) {
            try {
              const pipeline = JSON.parse(
                fs.readFileSync(path.join(previousDir, 'pipeline.json'), 'utf8'),
              );
              if (pipeline.fingerprint !== fingerprint) continue;
            } catch {
              continue;
            }
            for (let attempt = 3; attempt >= 1; attempt--) {
              const prefix = `correction-${key}-attempt-${attempt}`;
              try {
                const priorRequest = JSON.parse(
                  fs.readFileSync(path.join(previousDir, `${prefix}-request.json`), 'utf8'),
                );
                if (stableHash(priorRequest) !== stableHash(request)) continue;
                fixed = repairOutput.parse(
                  JSON.parse(
                    fs.readFileSync(path.join(previousDir, `${prefix}-result.json`), 'utf8'),
                  ),
                );
                break;
              } catch {}
            }
            if (fixed) break;
          }
        }
        if (!fixed)
          fixed = await call({
            job,
            part: `correction-${key}`,
            schema: repairOutput,
            skill: createSkill,
            images,
            request,
          });
        fixed = await completeTargetedRepair({
          job,
          request,
          initial: fixed,
          units,
          assets,
          call,
          load: (name) => loadCache(dirs, name, fingerprint),
          save: (name, result) => atomicJSON(path.join(dir, name), { fingerprint, result }),
          assertActive: () => assertActive(job),
          stage: (stage) => patchJob(job.id, { stage }),
          harness: currentHarness(),
        });
        atomicJSON(path.join(dir, name), { fingerprint, result: fixed, correctedAt: now() });
        return fixed;
      },
    );
    for (const fixed of repaired) {
      fixed.replacements.forEach((r: any) => {
        drafts[r.index] = r.card;
      });
      drafts.push(...fixed.additions);
      skipped.push(...fixed.skipped);
    }
    drafts = mergeDrafts(drafts);
  }
  assertActive(job);
  for (const card of drafts) {
    const errors = cardErrors(card, units);
    if (errors.length) throw Error(`Publication blocked by an invalid card: ${errors.join(' ')}`);
  }
  if (new Set(drafts.map((card) => canonical(card.term))).size !== drafts.length)
    throw Error('Publication blocked: duplicate cues would make the set ambiguous.');
  const finalCountProblem = countProblem(finalCards.length, requirements);
  if (finalCountProblem)
    throw Error(`${finalCountProblem} Publication blocked; your draft is saved.`);
  const setId = id();
  const cited = new Set(drafts.flatMap((c) => c.refs));
  const warnings = [
    ...new Set([
      ...ready.flatMap((s) => (s as any).warnings || []),
      ...skipped
        .filter((s) => !cited.has(s.ref) && /unreadable|unclear|missing|illegible/i.test(s.reason))
        .map((s) => `${units.find((u) => u.ref === s.ref)?.locator}: ${s.reason}`),
      ...(reviewFindings?.failedRequirements?.length
        ? [
            'Published with your approval while these quality notes remain: ' +
              reviewFindings.failedRequirements.join(' '),
          ]
        : []),
      ...(reviewFindings
        ? [
            `The quality review flagged ${new Set(reviewFindings.issues.map((issue) => issue.index)).size} card(s) and ${reviewFindings.missing.length} coverage gap(s) after an automatic repair pass. Your cards are saved; you can edit them or run another quality review from this set.`,
          ]
        : []),
    ]),
  ];
  atomicJSON(path.join(dir, 'final-validated.json'), {
    cards: finalCards,
    skipped,
    summary,
    fingerprint,
    requirements,
    setPlan,
  });
  transaction(() => {
    put('sets', {
      id: setId,
      courseId: job.courseId,
      title: job.payload.title,
      description: summary,
      createdAt: now(),
      updatedAt: now(),
      archived: false,
      origin: 'lecture',
      warnings,
      sourceIds: ready.map((s) => s.id),
      coverage: {
        totalEvidenceUnits: units.length,
        citedEvidenceUnits: cited.size,
        skipped,
        qualityReview: reviewFindings ? 'issues-found' : 'passed',
        ...(reviewFindings
          ? {
              qualityReviewReport: reviewFindings,
              reviewedAt: now(),
            }
          : {}),
      },
      generationJobId: job.id,
      requirements,
      setPlan,
    });
    finalCards.forEach((card, position) =>
      put('cards', { ...card, id: id(), setId, position, version: 1, starred: false }),
    );
    patchJob(job.id, {
      status: 'completed',
      stage: reviewFindings ? 'Ready to study · a few review notes to check' : 'Ready to study',
      progress: 100,
      resultId: setId,
      elapsedMs: Date.now() - began,
      error: null,
    });
  });
}
