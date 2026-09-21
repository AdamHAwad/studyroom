import { z } from 'zod';
import { auditOutput, stableHash } from './generation-contract';
import { requirementChecks, requirementFailures } from './generation-requirements';
import type { AgentCall } from './agent-runner';
import type { Asset } from './assets';
import type { Job } from '../src/types';

type Options = {
  job: Job;
  request: any;
  images: Asset[];
  call: (options: AgentCall) => Promise<any>;
  load: (name: string) => any;
  save: (name: string, result: any) => void;
  stage: (stage: string) => void;
  assertActive: () => void;
  harness: string;
  map: <T, R>(
    items: T[],
    limit: number,
    work: (item: T, index: number) => Promise<R>,
  ) => Promise<R[]>;
};
export function largeReview(request: any) {
  return (
    request.cards.length > 24 ||
    request.evidence.length > 30 ||
    JSON.stringify(request).length > 60000
  );
}
function chunks<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );
}
export async function reviewInParts(options: Options) {
  const { request, job } = options;
  const base = {
    title: request.title,
    instructions: request.instructions,
    requirements: request.requirements,
    requirementInstruction: request.requirementInstruction,
    wholeSetCount: request.cards.length,
    setPlan: request.setPlan && {
      targetCount: request.setPlan.targetCount,
      explanation: request.setPlan.explanation,
    },
  };
  const allIndices = new Set<number>(request.cards.map((c: any) => c.index));
  const allRefs = new Set<string>(request.evidence.map((u: any) => u.ref));
  const validate = (report: any, allowedIndices: Set<number>) => {
    const parsed = auditOutput.parse(report);
    if (
      parsed.issues.some((issue) => !allowedIndices.has(issue.index)) ||
      parsed.missing.some((gap) => gap.refs.some((ref) => !allRefs.has(ref)))
    )
      throw Error('Review returned an unknown card or evidence reference. Saved work is kept.');
    return parsed;
  };
  const invoke = async (partRequest: any, images: Asset[], schema = auditOutput) => {
    const key = `review-part-${stableHash(partRequest).slice(0, 18)}`;
    const cached = options.load(`${key}-checkpoint.json`);
    const report = schema.parse(
      cached ||
        (await options.call({
          job,
          part: key,
          request: partRequest,
          images,
          schema,
          skill: '.agents/skills/review-set/SKILL.md',
          model: process.env.STUDYROOM_REVIEW_MODEL,
          reasoningEffort: options.harness === 'codex' ? 'low' : undefined,
          timeoutMs: 120000,
          maxAttempts: 1,
        })),
    );
    validate(report, new Set(partRequest.cards.map((c: any) => c.index)));
    options.save(`${key}-checkpoint.json`, report);
    return report;
  };
  // Compact cues help distinguish genuine omissions from coverage in other batches.
  const index = request.cards.map((c: any) => ({
    index: c.index,
    term: c.term.slice(0, 100),
    topic: c.topic.slice(0, 50),
  }));
  const fullIndex = JSON.stringify(index).length <= 32000;
  const audit = async (kind: 'cards' | 'coverage', items: any[]): Promise<any[]> => {
    options.assertActive();
    const cards =
      kind === 'cards'
        ? items
        : request.cards.filter((c: any) =>
            items.some((u: any) => c.refs.includes(u.ref) || c.image?.ref === u.ref),
          );
    const evidence =
      kind === 'coverage'
        ? items
        : request.evidence.filter((u: any) =>
            cards.some((c: any) => c.refs.includes(u.ref) || c.image?.ref === u.ref),
          );
    const selectedImages =
      kind === 'cards'
        ? request.images.filter((image: any) => cards.some((c: any) => c.index === image.cardIndex))
        : [];
    const partRequest = {
      ...base,
      task:
        kind === 'cards'
          ? 'Review only these cards against their cited evidence. Check accuracy, wording, answers, explanations, and supplied images. Check applicable user instructions. Do not report global coverage gaps or judge whole-set requirements from this subset.'
          : 'Check this evidence for important missing targets, using the related cards and the compact whole-set cue index. Study-guide questions are priorities, not answer evidence. Avoid duplicate cards or exhaustive detail that defeats the user limit. For each gap include instructional evidence refs that can support its repair. Do not infer a global omission solely from a partial index. Do not assess wording or factual accuracy from shortened card summaries.',
      cards:
        kind === 'cards'
          ? cards
          : cards.slice(0, 24).map((c: any) => ({
              index: c.index,
              term: c.term,
              answer: c.answer,
              topic: c.topic,
              refs: c.refs,
            })),
      relatedCardsArePartial: kind === 'coverage' && cards.length > 24,
      evidence,
      skipped: request.skipped.filter((s: any) => evidence.some((u: any) => u.ref === s.ref)),
      ...(kind === 'coverage'
        ? {
            wholeSetCueIndex: fullIndex
              ? index
              : index
                  .filter((c: any) => cards.some((card: any) => card.index === c.index))
                  .slice(0, 80),
            cueIndexIsPartial: !fullIndex,
          }
        : {}),
      images: selectedImages.map((image: any, i: number) => ({ ...image, index: i + 1 })),
    };
    const splitKey = `review-split-${stableHash(partRequest).slice(0, 18)}.json`;
    if (!options.load(splitKey)) {
      try {
        return [
          await invoke(
            partRequest,
            selectedImages.map((image: any) => options.images[image.index - 1]),
          ),
        ];
      } catch (error) {
        options.assertActive();
        if (items.length <= 1) throw error;
        options.save(splitKey, { split: true });
      }
    }
    const half = Math.ceil(items.length / 2);
    return [
      ...(await audit(kind, items.slice(0, half))),
      ...(await audit(kind, items.slice(half))),
    ];
  };
  const work = [
    ...chunks(request.cards, 8).map((items) => ({ kind: 'cards' as const, items })),
    ...chunks(request.evidence, 12).map((items) => ({ kind: 'coverage' as const, items })),
  ];
  let completed = 0;
  const groups = await options.map(work, 3, async ({ kind, items }) => {
    const reports = await audit(kind, items);
    options.stage(`Reviewing your set · ${++completed} of ${work.length} checks saved`);
    return reports;
  });
  const reports = groups.flat();
  const issues = reports.flatMap((r) => r.issues);
  const missing = reports.flatMap((r) => r.missing);
  const summaries = reports.map((r) => r.summary.slice(0, 600));
  const checks: any[] = [];
  // Assess each supplementary requirement separately against the saved findings.
  // Never feed every full card and all source text into one call again.
  for (const [requirementIndex, requirement] of request.requirements.requirements.entries()) {
    options.assertActive();
    options.stage(
      `Checking requirement ${requirementIndex + 1} of ${request.requirements.requirements.length}`,
    );
    const partRequest = {
      ...base,
      task: 'Assess this one supplementary requirement across the whole set using the completed card and coverage audits. Return one requirementChecks entry with the ORIGINAL requirementIndex. Do not infer problems from fields omitted here. Counts are enforced by code. Report actionable violations in issues or missing using known indices or evidence refs from the audit findings.',
      requirementIndex,
      requirement,
      requirements: { ...request.requirements, requirements: [requirement] },
      cards: index,
      evidence: [],
      skipped: [],
      images: [],
      auditSummaries: summaries,
      issues,
      missing,
    };
    const schema = auditOutput.extend({ requirementChecks });
    const key = `review-requirement-${stableHash(partRequest).slice(0, 18)}`;
    let report = options.load(`${key}-checkpoint.json`);
    if (!report) {
      // Keep the legacy lookup above so already completed audits remain reusable.
      // Findings are already saved; this step only needs a verdict, not copies of them.
      const unique = (items: any[]) => [
        ...new Map(items.map((item) => [JSON.stringify(item), item])).values(),
      ];
      const verdict = await options.call({
        job,
        part: key,
        request: {
          ...partRequest,
          issues: unique(issues),
          missing: unique(missing),
          task: 'Assess only this supplementary requirement using the supplied cards and saved audit findings. Return exactly one requirementChecks entry with the ORIGINAL requirementIndex and a concise reason. Do not repeat the findings or generate replacement cards. Do not infer problems from omitted fields. Counts are enforced by code.',
        },
        schema: z.object({ requirementChecks }),
        skill: '.agents/skills/review-set/SKILL.md',
        model: process.env.STUDYROOM_REVIEW_MODEL,
        reasoningEffort: options.harness === 'codex' ? 'low' : undefined,
        timeoutMs: 120000,
        maxAttempts: 1,
      });
      report = {
        issues: [],
        missing: [],
        summary: 'Requirement assessed against saved findings.',
        ...z.object({ requirementChecks }).parse(verdict),
      };
    }
    report = schema.parse(report);
    validate(report, allIndices);
    if (
      report.requirementChecks.length !== 1 ||
      report.requirementChecks[0].requirementIndex !== requirementIndex
    )
      throw Error(
        'The requirement review returned the wrong requirement index. Completed checks are saved.',
      );
    options.save(`${key}-checkpoint.json`, report);
    checks.push(...report.requirementChecks);
    issues.push(...report.issues);
    missing.push(...report.missing);
  }
  requirementFailures(checks, request.requirements);
  return {
    issues: [...new Map(issues.map((issue: any) => [JSON.stringify(issue), issue])).values()],
    missing: [...new Map(missing.map((gap: any) => [JSON.stringify(gap), gap])).values()],
    summary: `Reviewed ${request.cards.length} cards and ${request.evidence.length} evidence units in saved checks. ${summaries.filter(Boolean).slice(0, 3).join(' ')}`,
    requirementChecks: checks,
  };
}
