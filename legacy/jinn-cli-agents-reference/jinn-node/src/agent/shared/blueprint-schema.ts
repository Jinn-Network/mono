import { z } from 'zod';

// Shared examples schema for invariants
export const invariantExamplesSchema = z.object({
  do: z.array(z.string()).min(1).describe('Positive examples showing correct application'),
  dont: z.array(z.string()).min(1).describe('Negative examples showing violation or anti-pattern'),
}).optional().describe('Two-column guidance with concrete positive and negative examples');

// FLOOR: metric must be at least min
export const floorInvariantSchema = z.object({
  id: z.string().describe('Unique identifier (e.g., "QUAL-001")'),
  type: z.literal('FLOOR').describe('Floor type: metric must be at least min value'),
  metric: z.string().min(1).describe('What is being measured (e.g., "content_quality_score")'),
  min: z.number().describe('Minimum acceptable value'),
  assessment: z.string().min(10).describe('HOW to measure this metric'),
  examples: invariantExamplesSchema,
});

// CEILING: metric must be at most max
export const ceilingInvariantSchema = z.object({
  id: z.string().describe('Unique identifier (e.g., "COST-001")'),
  type: z.literal('CEILING').describe('Ceiling type: metric must be at most max value'),
  metric: z.string().min(1).describe('What is being measured (e.g., "compute_cost_usd")'),
  max: z.number().describe('Maximum acceptable value'),
  assessment: z.string().min(10).describe('HOW to measure this metric'),
  examples: invariantExamplesSchema,
});

// RANGE: metric must be between min and max
export const rangeInvariantSchema = z.object({
  id: z.string().describe('Unique identifier (e.g., "FREQ-001")'),
  type: z.literal('RANGE').describe('Range type: metric must be between min and max'),
  metric: z.string().min(1).describe('What is being measured (e.g., "posts_per_week")'),
  min: z.number().describe('Minimum acceptable value'),
  max: z.number().describe('Maximum acceptable value'),
  assessment: z.string().min(10).describe('HOW to measure this metric'),
  examples: invariantExamplesSchema,
});

// BOOLEAN: condition must be true
export const booleanInvariantSchema = z.object({
  id: z.string().describe('Unique identifier (e.g., "BUILD-001")'),
  type: z.literal('BOOLEAN').describe('Boolean type: condition must be true'),
  condition: z.string().min(1).describe('The condition that must be true'),
  assessment: z.string().min(10).describe('HOW to verify this condition'),
  examples: invariantExamplesSchema,
});

// Discriminated union of all four invariant types
export const blueprintInvariantSchema = z.discriminatedUnion('type', [
  floorInvariantSchema,
  ceilingInvariantSchema,
  rangeInvariantSchema,
  booleanInvariantSchema,
]);

export const blueprintStructureSchema = z.object({
  invariants: z.array(blueprintInvariantSchema).min(1).describe('Array of invariants defining the job requirements'),
});
