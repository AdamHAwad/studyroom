import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { all, get, put, id, now, DATA, ROOT, transaction } from './db';
import {
  runAgent,
  atomicJSON,
  assertActive,
  patchJob,
  recoverSavedAgentResponse,
} from './agent-runner';
import {
  evidenceUnits,
  makeBatches,
  stableHash,
  canonical,
  type Evidence,
  type Batch,
} from './generation-contract';
import { materializeImage, type Asset } from './assets';
import { currentHarness, agentSelections } from './harness';
import type { Job, Source, StudyDocument, RetrievalTerm, ExamQuestion } from '../src/types';

const text = z.string();
const strings = z.array(text);
const termSchema = z.object({
  term: text,
  topic: text,
  cue: text,
  definition: text,
  example: text,
  memoryAid: text,
  compareWith: text,
  importance: z.number(),
  refs: strings,
});
export const inventorySchema = z.object({
  terms: z.array(termSchema),
  overview: strings,
  essentialQuestions: strings,
  warnings: strings,
});
export const examPlanSchema = z.object({
  instructions: text,
  durationMinutes: z.number(),
  style: z.object({
    font: z.enum(['serif', 'sans-serif']),
    columns: z.number(),
    optionLayout: z.enum(['stacked', 'inline']),
    headingCase: z.enum(['normal', 'uppercase']),
  }),
  sections: z.array(
    z.object({
      title: text,
      instructions: text,
      kind: text,
      count: z.number(),
      pointsEach: z.number(),
      topics: strings,
    }),
  ),
  warnings: strings,
});
export const examQuestionsSchema = z.object({
  questions: z.array(
    z.object({
      prompt: text,
      stimulus: text,
      options: strings,
      answer: text,
      explanation: text,
      points: z.number(),
      lines: z.number(),
      refs: strings,
      visualRef: text,
      visualRevealsAnswer: z.boolean(),
      parts: z.array(
        z.object({
          label: text,
          prompt: text,
          answer: text,
          points: z.number(),
          lines: z.number(),
        }),
      ),
    }),
  ),
  warnings: strings,
});
// The model gets a predictable shape, without editorial constraints that reject useful work.
export const fastCardsSchema = z.object({
  cards: z.array(
    z.object({
      term: text,
      answer: text,
      question: text,
      wrong: strings,
      why: text,
      topic: text,
      aliases: strings,
      refs: strings,
      image: z
        .object({
          ref: text,
          side: z.enum(['question', 'answer']),
          alt: text,
          caption: text,
          reason: text,
          matchUsable: z.boolean(),
          revealsAnswer: z.boolean(),
          crop: z.array(z.number()).nullable(),
        })
        .nullable(),
    }),
  ),
  skipped: z.array(z.object({ ref: text, reason: text })),
});
type Call = typeof runAgent;

export function fillResponseDefaults(value: any, schema: any): any {
  if (value === null && schema.anyOf?.some((s: any) => s.type === 'null')) return null;
  if (schema.anyOf)
    return fillResponseDefaults(
      value,
      schema.anyOf.find((s: any) => s.type !== 'null') || schema.anyOf[0],
    );
  if (schema.type === 'object')
    return Object.fromEntries(
      Object.entries(schema.properties || {}).map(([key, child]) => [
        key,
        fillResponseDefaults(value?.[key], child),
      ]),
    );
  if (schema.type === 'array')
    return (Array.isArray(value) ? value : []).map((item) =>
      fillResponseDefaults(item, schema.items),
    );
  if (schema.enum) return schema.enum.includes(value) ? value : schema.enum[0];
  if (schema.type === 'string')
    return typeof value === 'string' ? value : value == null ? '' : String(value);
  if (schema.type === 'number' || schema.type === 'integer')
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  if (schema.type === 'boolean') return value === true;
  return value ?? null;
}

async function parallel<T, R>(
  items: T[],
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(3, items.length) }, async () => {
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
  // Keep the job running until its in-flight calls have saved their checkpoints.
  // Otherwise the queue can start another job while old workers still write.
  if (failure) throw failure;
  return results;
}

function loadSources(job: Job) {
  const sources = (job.payload.sourceIds as string[]).map((sourceId) =>
    get<Source>('sources', sourceId),
  );
  if (
    !sources.length ||
    sources.some((s) => !s || s.courseId !== job.courseId || s.status !== 'ready')
  )
    throw Error('Selected files must be readable and belong to this course.');
  const ready = sources as Source[];
  const assets = all<Asset>('assets').filter((a) => ready.some((s) => s.id === a.sourceId));
  const units = ready.flatMap((s) =>
    evidenceUnits(
      s,
      fs.readFileSync(s.textPath, 'utf8'),
      assets.filter((a) => a.sourceId === s.id),
    ),
  );
  if (!units.length)
    throw Error('These files contain no readable text or images. Upload readable course material.');
  // Combine small extraction batches to reduce model round trips.
  const batches: Batch[] = [];
  for (const batch of makeBatches(units, assets)) {
    const last = batches.at(-1);
    if (
      last &&
      last.units.reduce((n, u) => n + u.text.length, 0) +
        batch.units.reduce((n, u) => n + u.text.length, 0) <=
        18000 &&
      last.images.length + batch.images.length <= 6
    ) {
      last.units.push(...batch.units);
      last.images.push(...batch.images);
      last.key = stableHash(last.units.map((u) => u.ref)).slice(0, 16);
    } else batches.push({ ...batch, units: [...batch.units], images: [...batch.images] });
  }
  return { sources: ready, assets, units, batches };
}

function checkpoint(job: Job, fingerprint: string, call: Call) {
  const dirs = [path.join(DATA, 'jobs', job.id)];
  let previousId = job.payload.resumeFromJobId;
  const seen = new Set([job.id]);
  while (previousId && !seen.has(previousId)) {
    seen.add(previousId);
    const previous = get<Job>('jobs', previousId);
    if (!previous || previous.courseId !== job.courseId) break;
    dirs.push(path.join(DATA, 'jobs', previousId));
    previousId = previous.payload.resumeFromJobId;
  }
  return async <S extends z.ZodType>(
    part: string,
    schema: S,
    skill: string,
    request: unknown,
    images: Asset[] = [],
  ): Promise<z.infer<S>> => {
    assertActive(job);
    const key = stableHash({
      fingerprint,
      request,
      skill: fs.readFileSync(path.join(ROOT, skill), 'utf8'),
    });
    for (const dir of dirs) {
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(dir, `${part}-ready.json`), 'utf8'));
        if (saved.key === key) return schema.parse(saved.result) as z.infer<S>;
      } catch {
        /* A missing checkpoint simply starts this bounded part. */
      }
    }
    const shape = z.toJSONSchema(schema);
    const normalize = (value: any) => {
      // Defaults fill editorial details, never invent a missing content payload.
      const contentKey = ['cards', 'terms', 'questions', 'sections'].find(
        (k) => shape.properties?.[k],
      );
      if (!value || typeof value !== 'object' || (contentKey && !Array.isArray(value[contentKey])))
        throw Error('The requested content is missing.');
      return fillResponseDefaults(value, shape);
    };
    for (const dir of dirs) {
      const recovered = recoverSavedAgentResponse(dir, {
        part,
        request,
        schema,
        normalize,
        cacheKey: key,
      });
      if (recovered) {
        atomicJSON(path.join(dirs[0], `${part}-ready.json`), { key, ...recovered });
        return recovered.result as z.infer<S>;
      }
    }
    const result = schema.parse(
      normalize(
        await call({
          job,
          part,
          schema,
          skill,
          request,
          images,
          timeoutMs: 240000,
          normalize,
          cacheKey: key,
        }),
      ),
    );
    atomicJSON(path.join(dirs[0], `${part}-ready.json`), { key, result });
    return result as z.infer<S>;
  };
}

function supportingEvidence(units: Evidence[], assigned: Evidence[], maxChars = 18000) {
  const assignedRefs = new Set(assigned.map((u) => u.ref));
  const words = new Set(assigned.flatMap((u) => u.text.toLowerCase().match(/[a-z]{4,}/g) || []));
  const ranked = units
    .filter((u) => !u.assetId && !assignedRefs.has(u.ref))
    .map((u) => ({
      u,
      score: (u.text.toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => words.has(w)).length,
    }));
  ranked.sort((a, b) => b.score - a.score);
  const result: Evidence[] = [];
  let size = 0;
  for (const { u } of ranked)
    if (size + u.text.length <= maxChars) {
      result.push(u);
      size += u.text.length;
    }
  return result;
}

function boundedEvidence(units: Evidence[], maxChars: number) {
  // Round-robin sources so a large first upload cannot hide the others.
  const groups = new Map<string, Evidence[]>();
  for (const unit of units) groups.set(unit.sourceId, [...(groups.get(unit.sourceId) || []), unit]);
  const result: Evidence[] = [];
  let size = 0;
  for (let i = 0; i < Math.max(0, ...[...groups.values()].map((g) => g.length)); i++) {
    for (const group of groups.values()) {
      const unit = group[i];
      if (unit && size + unit.text.length <= maxChars) {
        result.push(unit);
        size += unit.text.length;
      }
    }
  }
  return result;
}

export function normalizeCards(raw: any[], units: Evidence[]) {
  const notes: string[] = [];
  const refs = new Map(units.map((u) => [u.ref, u]));
  const seen = new Set<string>();
  const cards: any[] = [];
  for (const draft of raw) {
    if (!draft.term?.trim() || !(draft.answer || draft.definition)?.trim()) continue;
    const answer = draft.answer || draft.definition;
    const key = canonical(draft.term) + '\n' + canonical(answer);
    if (seen.has(key)) continue;
    seen.add(key);
    const cited = [...new Set<string>(draft.refs || [])].filter((ref) => refs.has(ref));
    if ((draft.refs || []).some((ref: string) => !refs.has(ref)))
      notes.push(
        'Some source references could not be matched. Check the references on those cards.',
      );
    let image = draft.image ? { ...draft.image } : null;
    const visual = image && refs.get(image.ref);
    if (image && !visual?.assetId) {
      image = null;
      notes.push('An unavailable illustration was omitted.');
    }
    if (image) {
      if (image.revealsAnswer) {
        image.side = 'answer';
        image.matchUsable = false;
      }
      const c = image.crop;
      if (
        c &&
        (c.length !== 4 ||
          c.some((n: number) => !Number.isFinite(n) || n < 0) ||
          c[2] <= 0 ||
          c[3] <= 0 ||
          c[0] + c[2] > 1 ||
          c[1] + c[3] > 1)
      )
        image.crop = null;
      image.assetId = visual!.assetId;
      if (!cited.includes(image.ref)) cited.push(image.ref);
    }
    if (!cited.length)
      notes.push(
        'Some cards have no matched source reference. You can check them against your uploads.',
      );
    const choices = [
      ...new Map<string, string>(
        (draft.wrong || draft.distractors || [])
          .filter((s: string) => s?.trim() && canonical(s) !== canonical(answer))
          .map((s: string) => [canonical(s), s]),
      ).values(),
    ].slice(0, 3);
    cards.push({
      term: draft.term.trim(),
      definition: answer.trim(),
      question: draft.question?.trim() || draft.term.trim(),
      distractors: choices,
      explanation: draft.why || draft.explanation || answer,
      topic: draft.topic || 'General',
      aliases: draft.aliases || [],
      image,
      sources: cited.map((ref) => {
        const u = refs.get(ref)!;
        return {
          sourceId: u.sourceId,
          locator: u.locator,
          quote: u.assetId ? '' : u.text,
          assetId: u.assetId || null,
        };
      }),
    });
  }
  return { cards, warnings: [...new Set(notes)] };
}

function recoverSavedCards(job: Job, units: Evidence[]) {
  const result: { cards: any[]; skipped: { ref: string; reason: string }[] } = {
    cards: [],
    skipped: [],
  };
  let previousId = job.payload.resumeFromJobId;
  const visited = new Set<string>();
  while (previousId && !visited.has(previousId)) {
    visited.add(previousId);
    const prior = get<Job>('jobs', previousId);
    if (
      !prior ||
      prior.courseId !== job.courseId ||
      prior.payload.instructions !== job.payload.instructions ||
      stableHash([...(prior.payload.sourceIds || [])].sort()) !==
        stableHash([...job.payload.sourceIds].sort())
    )
      break;
    const dir = path.join(DATA, 'jobs', previousId);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const finals = files.filter((f) => f === 'final-validated.json' || f === 'part-1-result.json');
    const candidates = finals.length
      ? finals
      : files.filter((f) => /^batch-.*-checkpoint\.json$/.test(f));
    for (const file of candidates) {
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        const output = saved.result || saved;
        for (const card of output.cards || []) {
          const refs =
            card.refs ||
            (card.sources || []).flatMap((citation: any) =>
              units
                .filter(
                  (u) =>
                    u.sourceId === citation.sourceId &&
                    (citation.assetId
                      ? u.assetId === citation.assetId
                      : citation.quote && canonical(citation.quote) === canonical(u.text)),
                )
                .map((u) => u.ref),
            );
          // Import only citations to the unchanged, selected source evidence.
          if (!refs.length || refs.some((ref: string) => !units.some((u) => u.ref === ref)))
            continue;
          result.cards.push({ ...card, refs, image: card.image?.ref ? card.image : null });
        }
        result.skipped.push(
          ...(output.skipped || []).filter((s: any) => units.some((u) => u.ref === s.ref)),
        );
      } catch {
        /* Keep the readable saved parts and regenerate anything else. */
      }
    }
    previousId = prior.payload.resumeFromJobId;
  }
  return result;
}

export async function generateStudySet(job: Job, call: Call = runAgent) {
  const { sources, units, batches: allBatches } = loadSources(job);
  const recovered = recoverSavedCards(job, units);
  const accounted = new Set([
    ...recovered.cards.flatMap((c) => c.refs),
    ...recovered.skipped.map((s) => s.ref),
  ]);
  const batches = allBatches
    .map((batch) => {
      const remaining = batch.units.filter((u) => !accounted.has(u.ref));
      return {
        ...batch,
        key: stableHash(remaining.map((u) => u.ref)).slice(0, 16),
        units: remaining,
        images: batch.images.filter((a) => remaining.some((u) => u.assetId === a.id)),
      };
    })
    .filter((batch) => batch.units.length);
  const skill = '.agents/skills/create-set/SKILL.md';
  const context = {
    course: get('courses', job.courseId!)?.name,
    title: job.payload.title,
    focus: job.payload.instructions || '',
    instruction:
      'Focus is guidance. Cover important material throughout the sources. Return your usable first draft after one self-check. Do not reject it over count, coverage bookkeeping, or stylistic preferences.',
    files: sources.map((s) => ({ id: s.id, name: s.name })),
  };
  const cached = checkpoint(
    job,
    stableHash({ version: 1, context, units, agent: [currentHarness(), agentSelections()] }),
    call,
  );
  let done = 0;
  const failures: string[] = [];
  patchJob(job.id, {
    stage: 'Creating your study set',
    requirements: null,
    progress: 8,
    details: { totalBatches: batches.length, completedBatches: 0 },
  });
  const results = await parallel(batches, async (batch, index) => {
    try {
      return await cached(
        `create-${batch.key}`,
        fastCardsSchema,
        skill,
        {
          ...context,
          task: 'create',
          batch: index + 1,
          totalBatches: batches.length,
          evidence: batch.units,
          supportingEvidence: supportingEvidence(units, batch.units),
          images: batch.images.map((a) => ({
            ref: units.find((u) => u.assetId === a.id)!.ref,
            locator: a.locator,
          })),
        },
        batch.images,
      );
    } catch (error) {
      if (get<Job>('jobs', job.id)?.status === 'cancelled') throw error;
      failures.push(
        `${sources.find((s) => s.id === batch.units[0]?.sourceId)?.name || 'A source section'}: ${(error as Error).message}`,
      );
      return { cards: [], skipped: [] };
    } finally {
      done++;
      patchJob(job.id, {
        stage: `Creating cards · ${done} of ${batches.length} parts ready`,
        progress: 8 + Math.round((80 * done) / batches.length),
        details: { totalBatches: batches.length, completedBatches: done },
      });
    }
  });
  if (get<Job>('jobs', job.id)?.status === 'cancelled') throw Error('Job cancelled');
  const { cards, warnings } = normalizeCards(
    [...recovered.cards, ...results.flatMap((r) => r.cards)],
    units,
  );
  if (!cards.length)
    throw Error(
      failures[0] ||
        'The agent returned no study content. The response is saved in job diagnostics.',
    );
  for (const card of cards)
    if (card.image) {
      try {
        card.image = await materializeImage(
          card.image,
          sources.map((s) => s.id),
        );
      } catch {
        card.image = null;
        warnings.push('One illustration could not be rendered. Its card text is saved.');
      }
    }
  warnings.push(...failures.map((f) => `Some material could not be processed. ${f}`));
  const cited = new Set(cards.flatMap((c) => c.sources.map((s: any) => s.sourceId)));
  warnings.push(
    ...sources
      .filter((s) => !cited.has(s.id))
      .map((s) => `No source references were returned for ${s.name}.`),
  );
  warnings.push(...sources.flatMap((s) => (s as any).warnings || []));
  const setId = id();
  atomicJSON(path.join(DATA, 'jobs', job.id, 'final-validated.json'), { cards, warnings });
  transaction(() => {
    if (get<Job>('jobs', job.id)?.status === 'cancelled') throw Error('Job cancelled');
    put('sets', {
      id: setId,
      courseId: job.courseId,
      title: job.payload.title,
      description: `${cards.length} cards from your course materials.`,
      createdAt: now(),
      updatedAt: now(),
      archived: false,
      origin: 'lecture',
      warnings: [...new Set(warnings)],
      sourceIds: sources.map((s) => s.id),
      generationJobId: job.id,
      coverage: {
        qualityReview: 'optional',
        totalEvidenceUnits: units.length,
        skipped: results.flatMap((r) => r.skipped),
        incomplete: failures.length > 0,
      },
    });
    cards.forEach((card, position) =>
      put('cards', { ...card, id: id(), setId, position, version: 1, starred: false }),
    );
    patchJob(job.id, {
      status: 'completed',
      stage: failures.length
        ? 'Ready to study · some source sections need attention'
        : 'Ready to study',
      progress: 100,
      resultId: setId,
      error: null,
    });
  });
  return setId;
}

export function selectPacketTerms(terms: RetrievalTerm[], max = 76) {
  const unique = new Map<string, RetrievalTerm>();
  for (const term of terms) {
    if (!term.term.trim() || !term.definition.trim()) continue;
    const key = canonical(term.term);
    const prior = unique.get(key);
    if (prior) {
      prior.refs = [...new Set([...prior.refs, ...term.refs])];
      prior.importance = Math.max(prior.importance, term.importance);
    } else unique.set(key, structuredClone(term));
  }
  const ranked = [...unique.values()].sort((a, b) => b.importance - a.importance);
  const chosen = new Set(ranked.slice(0, max).map((t) => canonical(t.term)));
  return {
    terms: [...unique.values()].filter((t) => chosen.has(canonical(t.term))),
    omittedTerms: ranked.slice(max).map((t) => t.term),
  };
}

export async function generateDocument(job: Job, call: Call = runAgent) {
  const { sources, assets, units, batches } = loadSources(job);
  const kind = job.kind as StudyDocument['kind'];
  const skill = `.agents/skills/create-${kind}/SKILL.md`;
  const context = {
    course: get('courses', job.courseId!)?.name,
    title: job.payload.title,
    focus: job.payload.instructions || '',
    variant: job.payload.variant || job.id,
    files: sources.map((s) => ({
      id: s.id,
      name: s.name,
      role: job.payload.referenceSourceIds?.includes(s.id) ? 'sample-exam' : 'course-material',
    })),
  };
  const cached = checkpoint(
    job,
    stableHash({ version: 1, units, context, agent: [currentHarness(), agentSelections()] }),
    call,
  );
  let done = 0;
  const warnings: string[] = sources.flatMap((s) => (s as any).warnings || []);
  patchJob(job.id, { stage: 'Reading your materials', progress: 5 });
  const inventories = await parallel(batches, async (batch) => {
    const result = await cached(
      `inventory-${batch.key}`,
      inventorySchema,
      skill,
      {
        ...context,
        task: 'inventory',
        evidence: batch.units,
        supportingEvidence: supportingEvidence(units, batch.units),
        images: batch.images.map((a) => ({
          ref: units.find((u) => u.assetId === a.id)!.ref,
          locator: a.locator,
        })),
      },
      batch.images,
    );
    done++;
    patchJob(job.id, {
      stage: `Reading materials · ${done} of ${batches.length} parts ready`,
      progress: 5 + Math.round((35 * done) / batches.length),
    });
    return result;
  });
  const allTerms = inventories.flatMap((i) => i.terms) as RetrievalTerm[];
  warnings.push(...inventories.flatMap((i) => i.warnings));
  const packet = selectPacketTerms(allTerms);
  const content: StudyDocument['content'] = {
    overview: [...new Set<string>(inventories.flatMap((i) => i.overview))].slice(0, 6),
    essentialQuestions: [
      ...new Set<string>(inventories.flatMap((i) => i.essentialQuestions)),
    ].slice(0, 6),
    terms: kind === 'retrieval-packet' ? packet.terms : [],
    omittedTerms: kind === 'retrieval-packet' ? packet.omittedTerms : [],
    examInstructions: '',
    durationMinutes: 0,
    style: { font: 'sans-serif', columns: 1, optionLayout: 'stacked', headingCase: 'normal' },
    sections: [],
    evidence: units,
  };
  if (kind === 'retrieval-packet') {
    if (!packet.terms.length)
      throw Error(
        'The agent returned no supported terms. Its response is saved in job diagnostics.',
      );
    if (packet.omittedTerms.length)
      warnings.push(
        `${packet.omittedTerms.length} lower-priority terms are listed under coverage notes to preserve writing space in the 20-page target.`,
      );
    patchJob(job.id, { stage: 'Laying out your retrieval packet', progress: 90 });
  } else {
    const sampleUnits = units.filter((u) => job.payload.referenceSourceIds?.includes(u.sourceId));
    const sampleText = boundedEvidence(
      sampleUnits.filter((u) => !u.assetId),
      60000,
    );
    if (sampleText.length < sampleUnits.filter((u) => !u.assetId).length)
      warnings.push(
        'Sample exam text was sampled across files for format matching. The material inventory includes every processed section.',
      );
    const sampleImages = assets
      .filter((a) => job.payload.referenceSourceIds?.includes(a.sourceId))
      .slice(0, 6);
    // Inventory covers every source; raw sample text preserves wording and structure.
    patchJob(job.id, { stage: 'Matching the sample exam structure', progress: 43 });
    const plan = await cached(
      'exam-plan',
      examPlanSchema,
      skill,
      {
        ...context,
        task: 'exam-plan',
        courseInventory: allTerms.map((t) => ({
          term: t.term,
          topic: t.topic,
          importance: t.importance,
        })),
        instruction:
          'Assign topics to each section. Distribute the full course scope across sections and avoid testing the same concept twice. Keep the sample section structure, item types and counts.',
        sampleExams: sampleText,
        images: sampleImages.map((a) => ({
          ref: units.find((u) => u.assetId === a.id)!.ref,
          locator: a.locator,
        })),
      },
      sampleImages,
    );
    warnings.push(...plan.warnings);
    if (!sampleUnits.length)
      warnings.push(
        'No sample exam was selected. The question format is based on your course materials.',
      );
    content.examInstructions = plan.instructions;
    content.durationMinutes = plan.durationMinutes;
    content.style = { ...plan.style, columns: plan.style.columns === 2 ? 2 : 1 };
    const sections: z.infer<typeof examPlanSchema>['sections'] = plan.sections.length
      ? plan.sections
      : [
          {
            title: 'Practice questions',
            instructions: 'Answer each question.',
            kind: 'mixed',
            count: 20,
            pointsEach: 0,
            topics: [],
          },
        ];
    const prior = all<StudyDocument>('documents').filter(
      (d) =>
        d.kind === kind &&
        d.courseId === job.courseId &&
        d.sourceIds.some((s) => sources.some((src) => src.id === s)),
    );
    const previousQuestions = prior
      .flatMap((d) => d.content.sections.flatMap((s) => s.questions.map((q) => q.prompt)))
      .slice(-250);
    const tasks = sections.flatMap((section: any, sectionIndex: number) => {
      const count = Math.max(1, Math.min(200, Math.round(section.count) || 10));
      return Array.from({ length: Math.ceil(count / 6) }, (_, i) => ({
        section,
        sectionIndex,
        offset: i * 6,
        count: Math.min(6, count - i * 6),
      }));
    });
    let completed = 0;
    const outputs = await parallel(tasks, async (task) => {
      const topicText = `${task.section.title} ${task.section.instructions} ${task.section.topics.join(' ')}`;
      const relevant = supportingEvidence(units, [{ text: topicText, ref: '' } as Evidence], 26000);
      const sectionTerms = [...allTerms].sort(
        (a, b) =>
          Number(topicText.toLowerCase().includes(b.topic.toLowerCase())) -
            Number(topicText.toLowerCase().includes(a.topic.toLowerCase())) ||
          b.importance - a.importance,
      );
      const chunkCount = Math.max(1, Math.ceil(task.section.count / 6));
      const assignedTerms = sectionTerms
        .filter((_, i) => i % chunkCount === Math.floor(task.offset / 6))
        .slice(0, 70);
      const sectionImages = assets
        .filter((a) => !job.payload.referenceSourceIds?.includes(a.sourceId))
        .slice(0, 6);
      const result = await cached(
        `exam-${task.sectionIndex}-${task.offset}`,
        examQuestionsSchema,
        skill,
        {
          ...context,
          task: 'exam-questions',
          section: task.section,
          startInSection: task.offset + 1,
          count: task.count,
          courseInventory: assignedTerms,
          evidence: relevant,
          sampleExams: sampleText,
          images: sectionImages.map((a) => ({
            ref: units.find((u) => u.assetId === a.id)!.ref,
            locator: a.locator,
          })),
          previousQuestions,
          instruction:
            'Write new substantive questions using the assigned concepts and section topics, not superficial variations of the sample. Include every assigned question and answer. Leave question numbers and option letters out of prompt/options; the app adds them. Use visualRef only for a supplied image necessary to answer a question. Set visualRevealsAnswer honestly; revealing images will be excluded.',
        },
        sectionImages,
      );
      completed++;
      patchJob(job.id, {
        stage: `Writing exam · ${completed} of ${tasks.length} parts ready`,
        progress: 48 + Math.round((42 * completed) / tasks.length),
      });
      return { ...task, result };
    });
    const seen = new Set<string>();
    content.sections = sections.map((section: any, index: number) => ({
      ...section,
      questions: outputs
        .filter((o) => o.sectionIndex === index)
        .flatMap((o) => {
          warnings.push(...o.result.warnings);
          return o.result.questions
            .filter((q: ExamQuestion) => {
              if (!q.prompt.trim()) return false;
              const key = canonical(q.prompt);
              if (seen.has(key)) {
                warnings.push('An exact duplicate question was omitted.');
                return false;
              }
              seen.add(key);
              return true;
            })
            .map((q: ExamQuestion & { visualRevealsAnswer?: boolean }) => ({
              ...q,
              prompt: q.prompt.replace(/^\s*\d+[.)]\s+/, ''),
              options: q.options.map((o) => o.replace(/^\s*[A-Z][.)]\s+/, '')),
              visualRef:
                !q.visualRevealsAnswer &&
                units.some(
                  (u) =>
                    u.ref === q.visualRef &&
                    u.assetId &&
                    !job.payload.referenceSourceIds?.includes(u.sourceId),
                )
                  ? q.visualRef
                  : '',
              refs: q.refs.filter((ref) => units.some((u) => u.ref === ref)),
              lines: Math.max(0, Math.min(18, Math.round(q.lines))),
              parts: q.parts.map((p) => ({
                ...p,
                lines: Math.max(0, Math.min(18, Math.round(p.lines))),
              })),
            }));
        }),
    }));
    if (!content.sections.some((s) => s.questions.length))
      throw Error(
        'The agent returned no exam questions. Its response is saved in job diagnostics.',
      );
    for (const section of content.sections)
      if (section.questions.length !== section.count)
        warnings.push(
          `${section.title} contains ${section.questions.length} questions; the sample plan called for ${section.count}.`,
        );
  }
  assertActive(job);
  const doc: StudyDocument = {
    id: id(),
    courseId: job.courseId!,
    kind,
    title: job.payload.title,
    description:
      kind === 'retrieval-packet'
        ? `${content.terms.length} terms with space to recall and connect.`
        : `${content.sections.reduce((n, s) => n + s.questions.length, 0)} original practice questions.`,
    createdAt: now(),
    updatedAt: now(),
    archived: false,
    version: 1,
    sourceIds: sources.map((s) => s.id),
    referenceSourceIds: job.payload.referenceSourceIds || [],
    instructions: job.payload.instructions || '',
    generationJobId: job.id,
    warnings: [...new Set(warnings)],
    content,
  };
  atomicJSON(path.join(DATA, 'jobs', job.id, 'document-ready.json'), doc);
  transaction(() => {
    put('documents', doc);
    patchJob(job.id, {
      status: 'completed',
      stage: kind === 'retrieval-packet' ? 'Ready to print' : 'Practice exam ready',
      progress: 100,
      resultId: doc.id,
      error: null,
    });
  });
  return doc.id;
}
