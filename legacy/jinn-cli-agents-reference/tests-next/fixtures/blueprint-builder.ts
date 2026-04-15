/**
 * Test data builders for blueprint structures
 * Used across unit, integration, and system tests for Phase 1 verification
 *
 * Uses the four-type invariant schema:
 * - FLOOR: metric must be at least min
 * - CEILING: metric must be at most max
 * - RANGE: metric must be between min and max
 * - BOOLEAN: condition must be true
 */

import type { Invariant, BooleanInvariant } from 'jinn-node/worker/prompt/types.js';

export interface BlueprintStructure {
  invariants: Invariant[];
}

/**
 * Build a complete blueprint JSON string from invariants array
 */
export function buildTestBlueprint(invariants: Invariant[]): string {
  return JSON.stringify({ invariants });
}

/**
 * Build a minimal valid BOOLEAN invariant for testing
 */
export function buildMinimalInvariant(id: string): BooleanInvariant {
  return {
    id,
    type: 'BOOLEAN',
    condition: `You satisfy test invariant ${id}`,
    assessment: `Verify that ${id} requirements are met`,
    examples: {
      do: ['Example positive behavior'],
      dont: ['Example negative behavior'],
    },
  };
}

/**
 * Build a BOOLEAN invariant with custom content
 */
export function buildCustomInvariant(
  id: string,
  condition: string,
  doExamples: string[],
  dontExamples: string[],
  assessment?: string
): BooleanInvariant {
  return {
    id,
    type: 'BOOLEAN',
    condition,
    assessment: assessment || `Verify: ${condition}`,
    examples: {
      do: doExamples,
      dont: dontExamples,
    },
  };
}

/**
 * Build a complete multi-invariant blueprint for complex tests
 */
export function buildMultiInvariantBlueprint(count: number): string {
  const invariants: Invariant[] = [];
  for (let i = 1; i <= count; i++) {
    invariants.push(buildMinimalInvariant(`JOB-${String(i).padStart(3, '0')}`));
  }
  return buildTestBlueprint(invariants);
}

/**
 * Build an invalid blueprint for negative testing
 */
export function buildInvalidBlueprint(issue: 'missing-id' | 'missing-type' | 'invalid-structure'): string {
  switch (issue) {
    case 'missing-id':
      return JSON.stringify({
        invariants: [{
          type: 'BOOLEAN',
          condition: 'Test condition',
          assessment: 'Test assessment',
        }],
      });
    case 'missing-type':
      return JSON.stringify({
        invariants: [{
          id: 'JOB-001',
          condition: 'Test condition',
          assessment: 'Test assessment',
        }],
      });
    case 'invalid-structure':
      return JSON.stringify({
        notInvariants: 'invalid',
      });
    default:
      return '{}';
  }
}

/**
 * Parse blueprint JSON string back to structure (for testing round-trip)
 */
export function parseBlueprint(blueprintJson: string): BlueprintStructure {
  return JSON.parse(blueprintJson);
}

// Legacy exports for backwards compatibility with existing tests
export { buildMinimalInvariant as buildMinimalAssertion };
export { buildCustomInvariant as buildCustomAssertion };
export { buildMultiInvariantBlueprint as buildMultiAssertionBlueprint };
export type BlueprintAssertion = Invariant;

