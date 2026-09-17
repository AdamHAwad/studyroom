import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Source } from '../src/types';
import type { Asset } from './assets';

export const compactCard = z.object({
  term: z.string().min(1),
  answer: z.string().min(1),
  question: z.string().min(1),
  wrong: z.array(z.string().min(1)).length(3),
  why: z.string().min(1),
  topic: z.string().min(1),
  aliases: z.array(z.string()),
  refs: z.array(z.string()).min(1),
  image: z
    .object({
      ref: z.string(),
      side: z.enum(['question', 'answer']),
      alt: z.string(),
      caption: z.string(),
      reason: z.string().min(1),
      matchUsable: z.boolean(),
      revealsAnswer: z.boolean(),
      crop: z.array(z.number().min(0).max(1)).length(4).nullable(),
    })
    .nullable(),
});
export type DraftCard = z.infer<typeof compactCard>;
export const batchOutput = z.object({
  cards: z.array(compactCard),
  skipped: z.array(z.object({ ref: z.string(), reason: z.string().min(1) })),
});
export type BatchOutput = z.infer<typeof batchOutput>;
export const repairOutput = z.object({
  replacements: z.array(z.object({ index: z.number().int().min(0), card: compactCard })),
  additions: z.array(compactCard),
  skipped: z.array(z.object({ ref: z.string(), reason: z.string().min(1) })),
});
export const auditOutput = z.object({
  issues: z.array(z.object({ index: z.number().int().min(0), reason: z.string().min(1) })),
  missing: z.array(z.object({ refs: z.array(z.string()).min(1), reason: z.string().min(1) })),
  summary: z.string(),
});
export type Evidence = {
  ref: string;
  sourceId: string;
  name: string;
  locator: string;
  text: string;
  assetId?: string;
};
export type Batch = { key: string; units: Evidence[]; images: Asset[] };
export const stableHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const canonical = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[.,!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
export function evidenceUnits(source: Source, text: string, assets: Asset[]): Evidence[] {
  const units: Evidence[] = [];
  const sections = text.split(/(?=\[(?:Page|Slide) \d+\])/);
  for (const section of sections) {
    const match = section.match(/^\[(Page|Slide) (\d+)\]/);
    const locator = match ? `${match[1]} ${match[2]}` : 'Document';
    const body = section.replace(/^\[(?:Page|Slide) \d+\]/, '').trim();
    if (!body || body.startsWith('[Visual source]')) continue;
    const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim());
    let current = '';
    const push = () => {
      if (!current.trim()) return;
      const content = current.trim();
      const ref = 'E' + stableHash([source.id, locator, content, units.length]).slice(0, 9);
      units.push({ ref, sourceId: source.id, name: source.name, locator, text: content });
      current = '';
    };
    for (const paragraph of paragraphs) {
      if (current.length + paragraph.length > 1000) push();
      for (let i = 0; i < paragraph.length; i += 1200) {
        const piece = paragraph.slice(i, i + 1200);
        if (current.length + piece.length > 1400) push();
        current += (current ? '\n\n' : '') + piece;
      }
    }
    push();
  }
  for (const asset of assets)
    units.push({
      ref: 'V' + asset.id.replaceAll('-', '').slice(0, 10),
      sourceId: source.id,
      name: source.name,
      locator: asset.locator,
      text: 'Inspect the attached visual. This label is not factual evidence.',
      assetId: asset.id,
    });
  return units;
}
export function makeBatches(units: Evidence[], assets: Asset[]): Batch[] {
  const groups = new Map<string, Evidence[]>();
  for (const unit of units) {
    const key = unit.sourceId + ':' + unit.locator.toLowerCase().replace('rendered page', 'page');
    groups.set(key, [...(groups.get(key) || []), unit]);
  }
  const batches: Batch[] = [];
  let current: Evidence[] = [];
  let textSize = 0,
    imageCount = 0;
  const flush = () => {
    if (!current.length) return;
    const ids = new Set(current.flatMap((u) => (u.assetId ? [u.assetId] : [])));
    batches.push({
      key: stableHash(current.map((u) => [u.ref, u.text])).slice(0, 16),
      units: current,
      images: assets.filter((a) => ids.has(a.id)),
    });
    current = [];
    textSize = 0;
    imageCount = 0;
  };
  for (const group of groups.values()) {
    const size = group.reduce((n, u) => n + u.text.length, 0),
      images = group.filter((u) => u.assetId).length;
    if (current.length && (textSize + size > 5000 || imageCount + images > 5)) flush();
    for (const unit of group) {
      if (
        current.length &&
        (textSize + unit.text.length > 6000 || imageCount + Number(Boolean(unit.assetId)) > 5)
      )
        flush();
      current.push(unit);
      textSize += unit.text.length;
      imageCount += Number(Boolean(unit.assetId));
    }
  }
  flush();
  return batches;
}
export function cardErrors(card: DraftCard, units: Evidence[]): string[] {
  const errors: string[] = [];
  const refs = new Set(units.map((u) => u.ref));
  if (card.refs.some((ref) => !refs.has(ref))) errors.push('Use only provided evidence IDs.');
  if (new Set([card.answer, ...card.wrong].map(canonical)).size !== 4)
    errors.push('All four answer options must differ.');
  if (card.image) {
    if (!units.some((u) => u.ref === card.image!.ref && u.assetId))
      errors.push('Image must refer to an attached visual ID.');
    if (card.image.side === 'question' && card.image.revealsAnswer)
      errors.push('An image that reveals the answer belongs on the answer side.');
    const crop = card.image.crop;
    if (
      crop &&
      (crop[2] <= 0 || crop[3] <= 0 || crop[0] + crop[2] > 1.001 || crop[1] + crop[3] > 1.001)
    )
      errors.push('Crop must have positive dimensions entirely within the image.');
  }
  return errors;
}
export function hydrateCard(card: DraftCard, units: Evidence[]) {
  const errors = cardErrors(card, units);
  if (errors.length) throw Error(errors.join(' '));
  const refs = [...new Set([...card.refs, ...(card.image ? [card.image.ref] : [])])];
  const visual = card.image && units.find((u) => u.ref === card.image!.ref)!;
  return {
    term: card.term,
    definition: card.answer,
    question: card.question,
    distractors: card.wrong,
    explanation: card.why,
    topic: card.topic,
    aliases: card.aliases,
    sources: refs.map((ref) => {
      const unit = units.find((u) => u.ref === ref)!;
      return {
        sourceId: unit.sourceId,
        locator: unit.locator,
        quote: unit.assetId ? '' : unit.text,
        assetId: unit.assetId || null,
      };
    }),
    image: card.image && visual ? { ...card.image, assetId: visual.assetId! } : null,
  };
}
export function uncovered(result: BatchOutput, units: Evidence[]) {
  const accounted = new Set([
    ...result.cards.flatMap((c) => [...c.refs, ...(c.image ? [c.image.ref] : [])]),
    ...result.skipped.filter((s) => s.reason.trim()).map((s) => s.ref),
  ]);
  return units.filter((u) => !accounted.has(u.ref));
}
