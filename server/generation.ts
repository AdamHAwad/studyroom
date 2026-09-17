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

const VERSION = 3;
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
): Promise<BatchOutput> {
  let result = structuredClone(initial);
  for (let repair = 0; repair < 2; repair++) {
    const bad = result.cards.flatMap((card, index) => {
      const errors = cardErrors(card, batch.units);
      return errors.length ? [{ index, card, errors }] : [];
    });
    const missing = uncovered(result, batch.units);
    const foreignSkips = result.skipped.filter((s) => !batch.units.some((u) => u.ref === s.ref));
    if (!bad.length && !missing.length && !foreignSkips.length) return result;
    if (repair === 1)
      throw Error(
        'Some cards could not be completed after a retry. Your saved cards are kept; retry to continue.',
      );
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
  const legacy = await recoverLegacyDraft(job, ready, assets);
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
  const states = batches.map((b) => ({ key: b.key, status: 'queued', cards: 0 }));
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
    states[index].status = 'running';
    progress();
    const run = async (current: Batch, depth: number): Promise<BatchOutput> => {
      const cacheName = `batch-${current.key}-checkpoint.json`;
      let result = loadCache(dirs, cacheName, fingerprint);
      if (result) {
        try {
          result = batchOutput.parse(result);
          if (
            result.cards.some((c: DraftCard) => cardErrors(c, current.units).length) ||
            uncovered(result, current.units).length
          )
            result = null;
        } catch {
          result = null;
        }
      }
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
              ...context,
              batch: { index: index + 1, total: batches.length },
              evidence: current.units,
              images: imageManifest(current.units, current.images),
            },
          });
          result = await validateBatch(job, current, result, context, call);
        }
        atomicJSON(path.join(dir, cacheName), { fingerprint, result, validatedAt: now() });
        return result as BatchOutput;
      } catch (error) {
        if (depth >= 2 || current.units.length < 2) throw error;
        patchJob(job.id, { stage: 'Trying this part in smaller pieces' });
        const parts = splitBatch(current);
        const done: BatchOutput[] = [];
        for (const part of parts) done.push(await run(part, depth + 1));
        return {
          cards: done.flatMap((output) => output.cards),
          skipped: done.flatMap((output) => output.skipped),
        };
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
  let summary = '';
  let finalCards: any[] = [];
  let reviewFindings: { issues: any[]; missing: any[]; summary: string } | null = null;
  for (let round = 0; round < 2; round++) {
    assertActive(job);
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
    const reports = await mapLimit(reviewGroups, CONCURRENCY, async (images, group) => {
      const reviewedCards = drafts
        .map((card, index) => ({ index, ...card }))
        .filter((c) => group === 0 || images.some((i) => i.cardIndex === c.index));
      const request = {
        task: group
          ? 'Review only these cards and their images. Do not report unrelated coverage gaps.'
          : 'Review all cards and all evidence for material errors and missing learning targets.',
        title: job.payload.title,
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
        report = await call({
          job,
          part: `review-${reviewHash}`,
          request,
          schema: auditOutput,
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
    });
    const issues: { index: number; reason: string }[] = reports.flatMap((r) => r.issues);
    const missing: { refs: string[]; reason: string }[] = reports.flatMap((r) => r.missing);
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
    atomicJSON(path.join(dir, `quality-round-${round + 1}.json`), { issues, missing, summary });
    if (!issues.length && !missing.length) break;
    if (round === 1) {
      reviewFindings = { issues, missing, summary };
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
          ...context,
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
        let fixed = loadCache(dirs, name, fingerprint);
        if (!fixed)
          fixed = await call({
            job,
            part: `correction-${key}`,
            schema: repairOutput,
            skill: createSkill,
            images,
            request,
          });
        if (
          fixed.replacements.some((r: any) => !badIndices.includes(r.index)) ||
          badIndices.some((index) => !fixed.replacements.some((r: any) => r.index === index))
        )
          throw Error('Targeted repair did not cover the requested card indices.');
        for (const card of [...fixed.replacements.map((r: any) => r.card), ...fixed.additions])
          if (cardErrors(card, evidence).length)
            throw Error('A corrected card failed source or answer validation.');
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
  const setId = id();
  const cited = new Set(drafts.flatMap((c) => c.refs));
  const warnings = [
    ...new Set([
      ...ready.flatMap((s) => (s as any).warnings || []),
      ...skipped
        .filter((s) => !cited.has(s.ref) && /unreadable|unclear|missing|illegible/i.test(s.reason))
        .map((s) => `${units.find((u) => u.ref === s.ref)?.locator}: ${s.reason}`),
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
