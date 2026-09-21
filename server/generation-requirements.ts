import { z } from 'zod';

const bound = z.number().int().min(1).nullable();
export const requirementsOutput = z.object({
  cardCount: z.object({ min: bound, max: bound, quotes: z.array(z.string().min(1)) }),
  requirements: z.array(z.object({ instruction: z.string().min(1), quote: z.string().min(1) })),
  conflicts: z.array(z.string().min(1)),
});
export type Requirements = z.infer<typeof requirementsOutput>;
export const noRequirements: Requirements = {
  cardCount: { min: null, max: null, quotes: [] },
  requirements: [],
  conflicts: [],
};
export function validateRequirements(value: unknown, instructions: string): Requirements {
  const result = requirementsOutput.parse(value);
  const { min, max, quotes } = result.cardCount;
  for (const quote of [...quotes, ...result.requirements.map((r) => r.quote)])
    if (!instructions.includes(quote))
      throw Error(
        'An interpreted requirement did not quote your instructions exactly. Retry to interpret them again.',
      );
  if ((min !== null || max !== null) && !quotes.length)
    throw Error('The card-count requirement needs a quote from your instructions.');
  if (min !== null && max !== null && min > max)
    throw Error(
      `Your card-count requirements conflict: minimum ${min}, maximum ${max}. Edit the instructions to resolve them.`,
    );
  if (result.conflicts.length)
    throw Error(`Your set requirements need clarification: ${result.conflicts.join(' ')}`);
  return result;
}
export function countProblem(count: number, requirements: Requirements): string | null {
  const { min, max } = requirements.cardCount;
  if (min !== null && count < min) return `The draft has ${count} cards; your minimum is ${min}.`;
  if (max !== null && count > max) return `The draft has ${count} cards; your maximum is ${max}.`;
  return null;
}
export const setPlanOutput = z.object({
  targetCount: z.number().int().min(1),
  allocations: z.array(
    z.object({
      batchKey: z.string(),
      count: z.number().int().min(0),
      focus: z.string().min(1),
    }),
  ),
  explanation: z.string().min(1),
});
export type SetPlan = z.infer<typeof setPlanOutput>;
export function validateSetPlan(
  value: unknown,
  keys: string[],
  requirements: Requirements,
): SetPlan {
  const plan = setPlanOutput.parse(value);
  const problem = countProblem(plan.targetCount, requirements);
  if (problem) throw Error(`The set plan violates your instructions. ${problem}`);
  if (
    plan.allocations.length !== keys.length ||
    new Set(plan.allocations.map((a) => a.batchKey)).size !== keys.length ||
    plan.allocations.some((a) => !keys.includes(a.batchKey))
  )
    throw Error('The set plan must allocate each evidence batch exactly once.');
  if (plan.allocations.reduce((sum, a) => sum + a.count, 0) !== plan.targetCount)
    throw Error('The batch budgets do not add up to the planned set size.');
  return plan;
}
export const countPlanOutput = z.object({
  keepIndices: z.array(z.number().int().min(0)),
  additions: z.array(
    z.object({
      batchKey: z.string(),
      count: z.number().int().min(1).max(12),
      focus: z.string().min(1),
    }),
  ),
  explanation: z.string().min(1),
});
export function validateCountPlan(
  value: unknown,
  cardCount: number,
  target: number,
  keys: string[],
) {
  const plan = countPlanOutput.parse(value);
  if (
    new Set(plan.keepIndices).size !== plan.keepIndices.length ||
    plan.keepIndices.some((i) => i >= cardCount) ||
    plan.additions.some((a) => !keys.includes(a.batchKey)) ||
    plan.keepIndices.length + plan.additions.reduce((sum, a) => sum + a.count, 0) !== target
  )
    throw Error(
      'The count repair plan must preserve valid indices and match the required set size.',
    );
  if (cardCount < target && plan.keepIndices.length !== cardCount)
    throw Error('A minimum-count repair must preserve the existing cards.');
  if (cardCount > target && plan.additions.length)
    throw Error('A maximum-count repair must select existing cards without generating extras.');
  return plan;
}
export const requirementChecks = z.array(
  z.object({
    requirementIndex: z.number().int().min(0),
    satisfied: z.boolean(),
    reason: z.string().min(1),
  }),
);
export function requirementFailures(value: unknown, requirements: Requirements): string[] {
  const checks = requirementChecks.parse(value);
  if (
    checks.length !== requirements.requirements.length ||
    new Set(checks.map((c) => c.requirementIndex)).size !== checks.length ||
    checks.some((c) => c.requirementIndex >= requirements.requirements.length)
  )
    throw Error('The final review did not check every supplementary requirement.');
  return checks
    .filter((c) => !c.satisfied)
    .map((c) => `${requirements.requirements[c.requirementIndex].instruction}: ${c.reason}`);
}
