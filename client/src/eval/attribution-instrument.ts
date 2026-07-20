/**
 * Stage 2 corpus-autoload attribution instrument (#1843).
 *
 * This is deliberately an analysis boundary, not a fleet runner. Operators
 * preregister a fixed 3×2 design, run the six controlled marketplace cells,
 * and provide the verdict-grounded facts. The analyzer fails closed unless the
 * population, snapshots, treatment identity, and fixed window all match.
 *
 * Statistics are reused rather than invented:
 * - exact paired McNemar for off→on changes (`paired.ts`)
 * - Wilson intervals for marginal context only (`wilson.ts`)
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { comparePaired, mcnemarExact } from './paired.js';
import { wilsonInterval, type Interval } from './wilson.js';

export const MARKETPLACE_ARMS = ['seedsOnly', 'rawEvidence', 'distilled'] as const;
export const AUTOLOAD_STATES = ['off', 'on'] as const;

const MarketplaceArmSchema = z.enum(MARKETPLACE_ARMS);
const AutoloadStateSchema = z.enum(AUTOLOAD_STATES);
const IsoDateTimeSchema = z.string().datetime({ offset: true });

const AttributionCellDefinitionSchema = z.object({
  marketplaceArm: MarketplaceArmSchema,
  autoload: AutoloadStateSchema,
  corpusSnapshotRef: z.string().trim().min(1),
}).strict();

const AttributionRuntimeSchema = z.object({
  modelRef: z.string().trim().min(1),
  harnessRef: z.string().trim().min(1),
  graderRef: z.string().trim().min(1),
  taskSourceRef: z.string().trim().min(1),
  sourceRevision: z.string().trim().min(1),
}).strict();

export const AttributionPreregistrationSchema = z.object({
  schema: z.literal('jinn.attribution-preregistration.v1'),
  instrumentId: z.string().trim().min(1),
  registeredAt: IsoDateTimeSchema,
  design: z.literal('matched-crossed-3x2'),
  window: z.object({
    startsAt: IsoDateTimeSchema,
    endsAt: IsoDateTimeSchema,
  }).strict(),
  primaryOutcome: z.literal('completed-with-accepted-diff'),
  primaryMarketplaceArm: MarketplaceArmSchema,
  alpha: z.number().positive().lt(1),
  minimumMatchedPairs: z.number().int().positive(),
  minimumDiscordantPairs: z.number().int().positive(),
  executionOrderSeed: z.string().trim().min(1),
  runtime: AttributionRuntimeSchema,
  population: z.object({
    instanceIds: z.array(z.string().trim().min(1)).min(1),
  }).strict(),
  cells: z.array(AttributionCellDefinitionSchema).length(6),
}).strict().superRefine((registration, ctx) => {
  const registeredAt = Date.parse(registration.registeredAt);
  const startsAt = Date.parse(registration.window.startsAt);
  const endsAt = Date.parse(registration.window.endsAt);
  if (registeredAt >= startsAt) {
    ctx.addIssue({
      code: 'custom',
      path: ['registeredAt'],
      message: 'preregistration must be recorded before the evaluation window starts',
    });
  }
  if (startsAt >= endsAt) {
    ctx.addIssue({
      code: 'custom',
      path: ['window'],
      message: 'evaluation window startsAt must be before endsAt',
    });
  }

  const uniqueInstances = new Set(registration.population.instanceIds);
  if (uniqueInstances.size !== registration.population.instanceIds.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['population', 'instanceIds'],
      message: 'preregistered population contains duplicate instance IDs',
    });
  }
  if (registration.minimumMatchedPairs > uniqueInstances.size) {
    ctx.addIssue({
      code: 'custom',
      path: ['minimumMatchedPairs'],
      message: 'minimumMatchedPairs cannot exceed the preregistered population',
    });
  }
  if (registration.minimumDiscordantPairs > registration.minimumMatchedPairs) {
    ctx.addIssue({
      code: 'custom',
      path: ['minimumDiscordantPairs'],
      message: 'minimumDiscordantPairs cannot exceed minimumMatchedPairs',
    });
  }
  let minimumSignificantDiscordant = 1;
  while (mcnemarExact(minimumSignificantDiscordant, 0) >= registration.alpha) {
    minimumSignificantDiscordant++;
  }
  if (registration.minimumDiscordantPairs < minimumSignificantDiscordant) {
    ctx.addIssue({
      code: 'custom',
      path: ['minimumDiscordantPairs'],
      message:
        `minimumDiscordantPairs=${registration.minimumDiscordantPairs} cannot reach significance `
        + `at alpha=${registration.alpha}; minimum is ${minimumSignificantDiscordant}`,
    });
  }

  const cellsByKey = new Map<string, z.infer<typeof AttributionCellDefinitionSchema>>();
  for (const cell of registration.cells) {
    const key = cellKey(cell.marketplaceArm, cell.autoload);
    if (cellsByKey.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['cells'],
        message: `duplicate preregistered cell ${key}`,
      });
    }
    cellsByKey.set(key, cell);
  }
  for (const marketplaceArm of MARKETPLACE_ARMS) {
    for (const autoload of AUTOLOAD_STATES) {
      const key = cellKey(marketplaceArm, autoload);
      if (!cellsByKey.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['cells'],
          message: `preregistration must contain exactly six cells; missing ${key}`,
        });
      }
    }
    const off = cellsByKey.get(cellKey(marketplaceArm, 'off'));
    const on = cellsByKey.get(cellKey(marketplaceArm, 'on'));
    if (off && on && off.corpusSnapshotRef !== on.corpusSnapshotRef) {
      ctx.addIssue({
        code: 'custom',
        path: ['cells'],
        message: `${marketplaceArm} off/on cells must use the same corpus snapshot`,
      });
    }
  }
});

const AttributionObservationSchema = z.object({
  instanceId: z.string().trim().min(1),
  passed: z.boolean().nullable(),
  unscorable: z.boolean(),
  sessionKind: z.enum(['user', 'host-internal']),
  origin: z.string().trim().min(1),
  verdictRef: z.string().trim().min(1),
  deliveredRefs: z.array(z.string().trim().min(1)),
}).strict().superRefine((observation, ctx) => {
  if (observation.passed === null && !observation.unscorable) {
    ctx.addIssue({
      code: 'custom',
      path: ['passed'],
      message: 'passed may be null only when unscorable=true',
    });
  }
  if (observation.passed !== null && observation.unscorable) {
    ctx.addIssue({
      code: 'custom',
      path: ['unscorable'],
      message: 'unscorable observations must have passed=null',
    });
  }
});

const AttributionFactsCellSchema = AttributionCellDefinitionSchema.extend({
  results: z.array(AttributionObservationSchema).min(1),
}).strict();

export const AttributionFactsSchema = z.object({
  schema: z.literal('jinn.attribution-facts.v1'),
  instrumentId: z.string().trim().min(1),
  completedAt: IsoDateTimeSchema,
  runtime: AttributionRuntimeSchema,
  cells: z.array(AttributionFactsCellSchema).min(1),
}).strict();

export type MarketplaceArm = z.infer<typeof MarketplaceArmSchema>;
export type AutoloadState = z.infer<typeof AutoloadStateSchema>;
export type AttributionPreregistration = z.infer<typeof AttributionPreregistrationSchema>;
export type AttributionFacts = z.infer<typeof AttributionFactsSchema>;

export type AttributionSignal =
  | 'helped'
  | 'harmed'
  | 'no-difference-detected'
  | 'inconclusive';

export interface AttributionRate {
  passed: number;
  scorable: number;
  unscorable: number;
  wilson: Interval;
}

export interface AttributionArmReadout {
  marketplaceArm: MarketplaceArm;
  primary: boolean;
  signal: AttributionSignal;
  barMet: boolean;
  plannedN: number;
  matchedN: number;
  excludedN: number;
  improved: number;
  regressed: number;
  discordant: number;
  concordantPass: number;
  concordantFail: number;
  pValue: number;
  alpha: number;
  minimumMatchedPairs: number;
  minimumDiscordantPairs: number;
  offRate: AttributionRate;
  onRate: AttributionRate;
  offDeliveredRefsDigest: string;
  onDeliveredRefsDigest: string;
}

export interface AttributionReadout {
  schema: 'jinn.attribution-readout.v1';
  instrumentId: string;
  generatedAt: string;
  registeredAt: string;
  factsCompletedAt: string;
  preregistrationDigest: string;
  factsDigest: string;
  design: 'matched-crossed-3x2';
  executionOrderSeed: string;
  runtime: AttributionPreregistration['runtime'];
  window: { startsAt: string; endsAt: string };
  primaryOutcome: 'completed-with-accepted-diff';
  /** Frozen execution order and corpus identity from the preregistration. */
  cells: AttributionPreregistration['cells'];
  plannedN: number;
  primary: AttributionArmReadout;
  exploratory: AttributionArmReadout[];
}

function cellKey(marketplaceArm: MarketplaceArm, autoload: AutoloadState): string {
  return `${marketplaceArm}:${autoload}`;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function deliveredRefsDigest(results: AttributionFacts['cells'][number]['results']): string {
  const identities = results.flatMap((result) =>
    result.deliveredRefs.map((ref) => `${result.instanceId}\0${ref}`),
  );
  return `sha256:${createHash('sha256').update(sorted(identities).join('\n')).digest('hex')}`;
}

function normalizedContentDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function marginalRate(results: AttributionFacts['cells'][number]['results']): AttributionRate {
  const scorable = results.filter((result) => !result.unscorable && result.passed !== null);
  const passed = scorable.filter((result) => result.passed === true).length;
  return {
    passed,
    scorable: scorable.length,
    unscorable: results.length - scorable.length,
    wilson: wilsonInterval(passed, scorable.length),
  };
}

function assertFactsMatchPreregistration(
  registration: AttributionPreregistration,
  facts: AttributionFacts,
): Map<string, AttributionFacts['cells'][number]> {
  if (facts.instrumentId !== registration.instrumentId) {
    throw new Error(
      `facts instrumentId ${facts.instrumentId} does not match preregistration ${registration.instrumentId}`,
    );
  }
  if (normalizedContentDigest(facts.runtime) !== normalizedContentDigest(registration.runtime)) {
    throw new Error('recorded runtime provenance does not match the preregistration');
  }
  if (facts.cells.length !== 6) {
    throw new Error(`recorded facts must contain exactly six cells; received ${facts.cells.length}`);
  }
  const preregisteredOrder = registration.cells.map((cell) =>
    cellKey(cell.marketplaceArm, cell.autoload),
  );
  const recordedOrder = facts.cells.map((cell) => cellKey(cell.marketplaceArm, cell.autoload));
  if (!preregisteredOrder.every((key, index) => recordedOrder[index] === key)) {
    throw new Error(
      `recorded cell execution order does not match the preregistration: `
      + `expected ${preregisteredOrder.join(', ')}, received ${recordedOrder.join(', ')}`,
    );
  }

  const factsByKey = new Map<string, AttributionFacts['cells'][number]>();
  for (const cell of facts.cells) {
    const key = cellKey(cell.marketplaceArm, cell.autoload);
    if (factsByKey.has(key)) {
      throw new Error(`recorded facts contain duplicate cell ${key}; expected exactly six cells`);
    }
    factsByKey.set(key, cell);
  }
  if (factsByKey.size !== 6) {
    throw new Error(`recorded facts must contain exactly six cells; received ${factsByKey.size}`);
  }

  const preregByKey = new Map(
    registration.cells.map((cell) => [cellKey(cell.marketplaceArm, cell.autoload), cell]),
  );
  for (const marketplaceArm of MARKETPLACE_ARMS) {
    for (const autoload of AUTOLOAD_STATES) {
      const key = cellKey(marketplaceArm, autoload);
      const expected = preregByKey.get(key);
      const actual = factsByKey.get(key);
      if (!expected || !actual) {
        throw new Error(`recorded facts must contain exactly six cells; missing ${key}`);
      }
      if (actual.corpusSnapshotRef !== expected.corpusSnapshotRef) {
        throw new Error(
          `${key} snapshot drift: expected ${expected.corpusSnapshotRef}, received ${actual.corpusSnapshotRef}`,
        );
      }

      const resultIds = actual.results.map((result) => result.instanceId);
      if (new Set(resultIds).size !== resultIds.length) {
        throw new Error(`${key} population contains duplicate instance IDs`);
      }
      if (!sameStrings(resultIds, registration.population.instanceIds)) {
        throw new Error(`${key} population does not match the preregistered instance IDs`);
      }

      for (const result of actual.results) {
        if (result.sessionKind !== 'user') {
          throw new Error(
            `${key}/${result.instanceId} must have sessionKind=user; host-internal observations are excluded`,
          );
        }
        if (result.origin.toLowerCase().includes('synthetic')) {
          throw new Error(`${key}/${result.instanceId} has excluded synthetic origin ${result.origin}`);
        }
        if (!result.verdictRef.trim()) {
          throw new Error(`${key}/${result.instanceId} is not verdict-grounded`);
        }
        if (autoload === 'off' && result.deliveredRefs.length > 0) {
          throw new Error(
            `${key}/${result.instanceId} is an autoload-off observation but records delivered refs`,
          );
        }
      }
    }
  }

  return factsByKey;
}

function analyzeArm(
  registration: AttributionPreregistration,
  factsByKey: Map<string, AttributionFacts['cells'][number]>,
  marketplaceArm: MarketplaceArm,
): AttributionArmReadout {
  const off = factsByKey.get(cellKey(marketplaceArm, 'off'))!;
  const on = factsByKey.get(cellKey(marketplaceArm, 'on'))!;
  const paired = comparePaired(
    off.results.map((result) => ({
      instance_id: result.instanceId,
      passed: result.passed,
      unscorable: result.unscorable,
    })),
    on.results.map((result) => ({
      instance_id: result.instanceId,
      passed: result.passed,
      unscorable: result.unscorable,
    })),
    { alpha: registration.alpha },
  );
  const discordant = paired.improved + paired.regressed;
  const barMet =
    paired.pairs >= registration.minimumMatchedPairs
    && discordant >= registration.minimumDiscordantPairs;

  let signal: AttributionSignal = 'inconclusive';
  if (barMet) {
    if (paired.pValue < registration.alpha && paired.improved > paired.regressed) {
      signal = 'helped';
    } else if (paired.pValue < registration.alpha && paired.regressed > paired.improved) {
      signal = 'harmed';
    } else {
      signal = 'no-difference-detected';
    }
  }

  return {
    marketplaceArm,
    primary: marketplaceArm === registration.primaryMarketplaceArm,
    signal,
    barMet,
    plannedN: registration.population.instanceIds.length,
    matchedN: paired.pairs,
    excludedN: paired.excluded,
    improved: paired.improved,
    regressed: paired.regressed,
    discordant,
    concordantPass: paired.concordantPass,
    concordantFail: paired.concordantFail,
    pValue: paired.pValue,
    alpha: registration.alpha,
    minimumMatchedPairs: registration.minimumMatchedPairs,
    minimumDiscordantPairs: registration.minimumDiscordantPairs,
    offRate: marginalRate(off.results),
    onRate: marginalRate(on.results),
    offDeliveredRefsDigest: deliveredRefsDigest(off.results),
    onDeliveredRefsDigest: deliveredRefsDigest(on.results),
  };
}

export function analyzeAttributionInstrument(
  registrationInput: unknown,
  factsInput: unknown,
  opts: { now?: Date } = {},
): AttributionReadout {
  const registration = AttributionPreregistrationSchema.parse(registrationInput);
  const facts = AttributionFactsSchema.parse(factsInput);
  const now = opts.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('readout clock is invalid');

  const endsAt = Date.parse(registration.window.endsAt);
  if (now.getTime() < endsAt) {
    throw new Error(
      `fixed evaluation window has not closed; endsAt=${registration.window.endsAt}, now=${now.toISOString()}`,
    );
  }
  const completedAt = Date.parse(facts.completedAt);
  if (completedAt < endsAt) {
    throw new Error(
      `facts were marked complete before the fixed evaluation window ended; `
      + `completedAt=${facts.completedAt}, endsAt=${registration.window.endsAt}`,
    );
  }
  if (completedAt > now.getTime()) {
    throw new Error('facts completedAt is in the future relative to the readout clock');
  }

  const factsByKey = assertFactsMatchPreregistration(registration, facts);
  const arms = MARKETPLACE_ARMS.map((marketplaceArm) =>
    analyzeArm(registration, factsByKey, marketplaceArm),
  );
  const primary = arms.find((arm) => arm.primary)!;

  return {
    schema: 'jinn.attribution-readout.v1',
    instrumentId: registration.instrumentId,
    generatedAt: now.toISOString(),
    registeredAt: registration.registeredAt,
    factsCompletedAt: facts.completedAt,
    preregistrationDigest: normalizedContentDigest(registration),
    factsDigest: normalizedContentDigest(facts),
    design: registration.design,
    executionOrderSeed: registration.executionOrderSeed,
    runtime: registration.runtime,
    window: registration.window,
    primaryOutcome: registration.primaryOutcome,
    cells: registration.cells,
    plannedN: registration.population.instanceIds.length,
    primary,
    exploratory: arms.filter((arm) => !arm.primary),
  };
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function renderArm(readout: AttributionArmReadout): string[] {
  return [
    `### ${readout.primary ? 'Primary' : 'Exploratory'}: ${readout.marketplaceArm}`,
    '',
    `- Mechanical signal: ${readout.signal}`,
    `- Matched N: ${readout.matchedN} (planned ${readout.plannedN}; excluded ${readout.excludedN})`,
    `- Discordant: ${readout.discordant} (${readout.improved} improved, ${readout.regressed} regressed)`,
    `- Exact paired McNemar p: ${readout.pValue.toPrecision(4)} (α=${readout.alpha})`,
    `- Preregistered bar: ${readout.barMet ? 'met' : 'not met'} `
      + `(matched ≥${readout.minimumMatchedPairs}; discordant ≥${readout.minimumDiscordantPairs})`,
    `- Autoload off: ${readout.offRate.passed}/${readout.offRate.scorable} `
      + `(${percentage(readout.offRate.wilson.p)}; Wilson `
      + `${percentage(readout.offRate.wilson.lo)}–${percentage(readout.offRate.wilson.hi)})`,
    `- Autoload on: ${readout.onRate.passed}/${readout.onRate.scorable} `
      + `(${percentage(readout.onRate.wilson.p)}; Wilson `
      + `${percentage(readout.onRate.wilson.lo)}–${percentage(readout.onRate.wilson.hi)})`,
    `- Delivered-ref identity (off/on): ${readout.offDeliveredRefsDigest} / ${readout.onDeliveredRefsDigest}`,
  ];
}

export function renderAttributionReadoutMarkdown(readout: AttributionReadout): string {
  return [
    '# Stage 2 attribution readout',
    '',
    `Instrument: ${readout.instrumentId}`,
    `Design: ${readout.design}`,
    `Execution-order seed: ${readout.executionOrderSeed}`,
    `Runtime: ${readout.runtime.modelRef} · ${readout.runtime.harnessRef} · ${readout.runtime.graderRef}`,
    `Task source/revision: ${readout.runtime.taskSourceRef} · ${readout.runtime.sourceRevision}`,
    `Window: ${readout.window.startsAt} → ${readout.window.endsAt}`,
    `Primary outcome: ${readout.primaryOutcome}`,
    `Primary marketplace arm: ${readout.primary.marketplaceArm}`,
    `Planned N: ${readout.plannedN}`,
    `Preregistration digest: ${readout.preregistrationDigest}`,
    `Facts digest: ${readout.factsDigest}`,
    '',
    ...renderArm(readout.primary),
    '',
    ...readout.exploratory.flatMap((arm) => [...renderArm(arm), '']),
    'Interpretation and downstream posture decisions remain human. This file is the mechanical readout only.',
  ].join('\n');
}
