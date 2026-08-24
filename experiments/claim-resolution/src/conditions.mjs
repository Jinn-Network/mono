/**
 * Experimental conditions.
 *
 *  A_opus    — strongest single web-enabled agent. The baseline to beat.
 *  A_sonnet  — one ordinary network member, alone. Reported as the first
 *              member of B rather than re-run, so it is literally "one draw
 *              from the network".
 *  B         — five independent attempts, diverse across model and research
 *              strategy. Every member is individually weaker than A_opus,
 *              which is the point: the question is whether the network beats
 *              the strong single agent, not whether opus beats haiku.
 *  C         — aggregation over B. Defined in src/aggregate.mjs.
 */

export const SINGLE_BASELINE = { key: 'A_opus', model: 'claude-opus-5', strategy: 'default' };

export const MULTI_SOLVERS = [
  { key: 'B1', model: 'claude-sonnet-5', strategy: 'default' },
  { key: 'B2', model: 'claude-sonnet-5', strategy: 'adversarial' },
  { key: 'B3', model: 'claude-sonnet-5', strategy: 'criteria' },
  { key: 'B4', model: 'claude-haiku-4-5-20251001', strategy: 'timeline' },
  { key: 'B5', model: 'claude-haiku-4-5-20251001', strategy: 'default' },
];

/** A_sonnet is an alias for the first network member, not a separate run. */
export const SINGLE_MEMBER_ALIAS = 'B1';

export const ALL_SPECS = [SINGLE_BASELINE, ...MULTI_SOLVERS];
