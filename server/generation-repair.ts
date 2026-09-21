import { cardErrors, repairOutput, stableHash, type Evidence } from './generation-contract';
import type { AgentCall } from './agent-runner';
import type { Asset } from './assets';
import type { Job } from '../src/types';

export function relatedRepairEvidence(
  card: any,
  errors: string[],
  units: Evidence[],
  excluded: Set<string>,
) {
  const words = (text: string) => new Set(text.toLowerCase().match(/[a-z]{4,}/g) || []);
  const query = words(`${card.term} ${card.answer} ${card.topic} ${errors.join(' ')}`);
  const candidates = units.filter((unit) => !unit.assetId);
  const tokens = candidates.map((unit) => words(unit.text));
  const frequency = new Map<string, number>();
  for (const terms of tokens)
    for (const word of query)
      if (terms.has(word)) frequency.set(word, (frequency.get(word) || 0) + 1);
  const phrase = card.term.split(':')[0].toLowerCase().trim();
  return candidates
    .map((unit, i) => ({
      unit,
      score:
        [...query].reduce(
          (score, word) =>
            score +
            (tokens[i].has(word)
              ? Math.log(1 + candidates.length / (frequency.get(word) || 1))
              : 0),
          0,
        ) + (phrase.length > 8 && unit.text.toLowerCase().includes(phrase) ? 20 : 0),
    }))
    .filter(({ unit, score }) => score > 0 && !excluded.has(unit.ref))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ unit }) => unit);
}

type Options = {
  job: Job;
  request: any;
  initial: unknown;
  units: Evidence[];
  assets: Asset[];
  call: (options: AgentCall) => Promise<any>;
  load: (name: string) => any;
  save: (name: string, result: any) => void;
  assertActive: () => void;
  stage: (stage: string) => void;
  harness: string;
};
export async function completeTargetedRepair(options: Options) {
  const { request } = options;
  const key = `correction-${stableHash(request).slice(0, 18)}`;
  const initial = repairOutput.parse(options.load(`${key}-progress.json`) || options.initial);
  const expected = new Set<number>(request.badCards.map((bad: any) => bad.index));
  const accepted = initial.replacements.filter(
    (replacement) =>
      expected.has(replacement.index) &&
      !cardErrors(replacement.card, options.units).length &&
      initial.replacements.filter((r) => r.index === replacement.index).length === 1,
  );
  // Additions are not index repairs. Never silently import an unsupported addition.
  if (initial.additions.some((card) => cardErrors(card, request.evidence).length))
    throw Error(
      'A corrected addition failed source or answer validation. Saved replacements are kept.',
    );
  const result = { replacements: accepted, additions: initial.additions, skipped: initial.skipped };
  const saveProgress = () => options.save(`${key}-progress.json`, result);
  saveProgress();
  for (const bad of request.badCards) {
    if (result.replacements.some((r) => r.index === bad.index)) continue;
    options.assertActive();
    options.stage(`Repairing card ${bad.index + 1}; completed fixes are saved`);
    const extra = relatedRepairEvidence(
      bad.card,
      bad.errors,
      options.units,
      new Set(request.evidence.map((u: any) => u.ref)),
    );
    const evidence = [...request.evidence, ...extra];
    const images = options.assets.filter((asset) =>
      evidence.some((u: any) => u.assetId === asset.id),
    );
    const singleRequest = {
      ...request,
      evidence,
      badCards: [bad],
      missing: [],
      images: images.map((asset, index) => ({
        index: index + 1,
        ref: evidence.find((u: any) => u.assetId === asset.id)!.ref,
        locator: asset.locator,
        width: asset.width,
        height: asset.height,
      })),
      instruction: `Return exactly one replacement for the original global card index ${bad.index}. Do not renumber it to zero. Use the additional instructional passages to resolve the reviewer finding. No additions and no changes to other cards. Cite only provided evidence. Do not invent a missing explanation; if the supplied material still cannot support a correction, state that in skipped.`,
    };
    const part = `${key}-card-${bad.index}-${stableHash(singleRequest).slice(0, 12)}`;
    const fixed = repairOutput.parse(
      options.load(`${part}-checkpoint.json`) ||
        (await options.call({
          job: options.job,
          part,
          request: singleRequest,
          schema: repairOutput,
          skill: '.agents/skills/create-set/SKILL.md',
          images,
          reasoningEffort: options.harness === 'codex' ? 'low' : undefined,
          timeoutMs: 120000,
          maxAttempts: 1,
        })),
    );
    if (
      fixed.replacements.length !== 1 ||
      fixed.replacements[0].index !== bad.index ||
      fixed.additions.length ||
      cardErrors(fixed.replacements[0].card, evidence).length
    )
      throw Error(
        `Card ${bad.index + 1} still needs a supported correction. Completed repairs are saved. ${fixed.skipped
          .map((s) => s.reason)
          .join(' ')
          .slice(0, 600)}`,
      );
    options.save(`${part}-checkpoint.json`, fixed);
    result.replacements.push(fixed.replacements[0]);
    // Remove obsolete unresolved notes for evidence the repaired card now covers.
    const covered = new Set(fixed.replacements[0].card.refs);
    result.skipped = result.skipped.filter((skip) => !covered.has(skip.ref));
    saveProgress();
  }
  return result;
}
