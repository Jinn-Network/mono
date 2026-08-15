/**
 * Stage 2 daemon-autoload attribution analyzer (#1899).
 *
 * The Human-owned experiment supplies a frozen matched 1×2 design, two
 * isolated daemon cells, and manifest-grounded receipts. This module analyzes
 * those fixed facts; it never launches a fleet or interprets the result.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { canonicalJson } from '../util/canonical-json.js';
import {
  AttributionVerdictProofSchema,
  verifyAttributionVerdictProof,
} from './attribution-verdict-evidence.js';
import { comparePaired, mcnemarExact } from './paired.js';
import { wilsonInterval, type Interval } from './wilson.js';

export const AUTOLOAD_STATES = ['off', 'on'] as const;
const MAX_INSTANCES = 1023;
const MAX_DELIVERED_REFS_PER_OBSERVATION = 128;
const MAX_EVIDENCE_FILES = MAX_INSTANCES * 2;
const MAX_MANIFEST_BYTES = 1_000_000;

const AutoloadStateSchema = z.enum(AUTOLOAD_STATES);
const IsoDateTimeSchema = z.string().datetime({ offset: true });
const SingleLineSchema = z.string().trim().min(1).max(512).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  'must be printable single-line text',
);
const Sha256DigestSchema = z.string().regex(
  /^sha256:[0-9a-f]{64}$/,
  'must be a lowercase sha256 content digest',
);
const ContentRefSchema = z.union([
  Sha256DigestSchema,
  z.string().max(512).regex(/^bafy[a-z2-7]{20,}$/, 'must be a CID or sha256 digest'),
]);
const DeliveredRefsSchema = z.array(ContentRefSchema).max(
  MAX_DELIVERED_REFS_PER_OBSERVATION,
);
const VerdictRefSchema = SingleLineSchema.regex(
  /^verdict:[A-Za-z0-9._:/-]+$/,
  'must be an immutable verdict reference',
);

export function deriveAttributionCellOrder(
  seed: string,
): readonly (typeof AUTOLOAD_STATES)[number][] {
  const lowBit = createHash('sha256').update(seed, 'utf8').digest()[0]! & 1;
  return lowBit === 0 ? ['off', 'on'] : ['on', 'off'];
}

const AttributionRuntimeSchema = z.object({
  modelRef: SingleLineSchema,
  harnessRef: SingleLineSchema,
  graderRef: SingleLineSchema,
  taskSourceRef: ContentRefSchema,
  sourceRevision: SingleLineSchema,
}).strict();

const AttributionIsolationSchema = z.object({
  runId: SingleLineSchema,
  agentHomeDigest: Sha256DigestSchema,
  storeDigest: Sha256DigestSchema,
}).strict();

const AttributionCostSchema = z.object({
  inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  usdMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  usdMicrosEstimated: z.boolean(),
}).strict();

const AttributionCellDefinitionSchema = z.object({
  autoload: AutoloadStateSchema,
  corpusSnapshotRef: ContentRefSchema,
  treatmentConfigDigest: Sha256DigestSchema,
}).strict();

export const AttributionPreregistrationSchema = z.object({
  schema: z.literal('jinn.attribution-preregistration.v1'),
  instrumentId: SingleLineSchema,
  registeredAt: IsoDateTimeSchema,
  design: z.literal('matched-daemon-autoload-1x2'),
  window: z.object({
    startsAt: IsoDateTimeSchema,
    endsAt: IsoDateTimeSchema,
  }).strict(),
  primaryOutcome: z.literal('completed-with-accepted-diff'),
  alpha: z.literal(0.05),
  minimumMatchedPairs: z.number().int().positive(),
  minimumDiscordantPairs: z.number().int().positive(),
  executionOrderSeed: SingleLineSchema,
  runtime: AttributionRuntimeSchema,
  population: z.object({
    instanceIds: z.array(SingleLineSchema).min(1).max(
      MAX_INSTANCES,
      `exact paired analysis supports at most ${MAX_INSTANCES} instances`,
    ),
  }).strict(),
  cells: z.array(AttributionCellDefinitionSchema).length(2),
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
  const derivedOrder = deriveAttributionCellOrder(registration.executionOrderSeed);
  if (
    registration.cells.map((cell) => cell.autoload).join(',')
    !== derivedOrder.join(',')
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['cells'],
      message:
        'cell order does not match the order derived from the execution order seed '
        + `(${derivedOrder.join(',')})`,
    });
  }
  const cells = new Map(registration.cells.map((cell) => [cell.autoload, cell]));
  if (!cells.has('off') || !cells.has('on')) {
    ctx.addIssue({
      code: 'custom',
      path: ['cells'],
      message: 'preregistration must contain exactly one autoload-off and one autoload-on cell',
    });
    return;
  }
  if (cells.get('off')!.corpusSnapshotRef !== cells.get('on')!.corpusSnapshotRef) {
    ctx.addIssue({
      code: 'custom',
      path: ['cells'],
      message: 'autoload off/on cells must use the same frozen corpus snapshot',
    });
  }
  if (cells.get('off')!.treatmentConfigDigest === cells.get('on')!.treatmentConfigDigest) {
    ctx.addIssue({
      code: 'custom',
      path: ['cells'],
      message: 'autoload off/on cells must have distinct treatment configuration digests',
    });
  }
});

const AttributionObservationSchema = z.object({
  instanceId: SingleLineSchema,
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema,
  passed: z.boolean().nullable(),
  unscorable: z.boolean(),
  sessionKind: z.enum(['user', 'host-internal']),
  origin: z.enum(['marketplace', 'synthetic', 'fixture', 'generated', 'unknown']),
  verdictRef: VerdictRefSchema,
  verdictEvidenceDigest: Sha256DigestSchema,
  deliveredRefs: DeliveredRefsSchema,
  cost: AttributionCostSchema,
}).strict().superRefine((observation, ctx) => {
  if ((observation.passed === null) !== observation.unscorable) {
    ctx.addIssue({
      code: 'custom',
      path: ['passed'],
      message: 'passed must be null exactly when unscorable=true',
    });
  }
  if (new Set(observation.deliveredRefs).size !== observation.deliveredRefs.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['deliveredRefs'],
      message: 'deliveredRefs must be duplicate-free',
    });
  }
});

const AttributionFactsCellSchema = AttributionCellDefinitionSchema.extend({
  runtime: AttributionRuntimeSchema,
  isolation: AttributionIsolationSchema,
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema,
  results: z.array(AttributionObservationSchema).min(1).max(MAX_INSTANCES),
}).strict();

export const AttributionFactsSchema = z.object({
  schema: z.literal('jinn.attribution-facts.v1'),
  instrumentId: SingleLineSchema,
  completedAt: IsoDateTimeSchema,
  evidenceManifestDigest: Sha256DigestSchema,
  cells: z.array(AttributionFactsCellSchema).length(2),
}).strict();

export type AutoloadState = z.infer<typeof AutoloadStateSchema>;
export type AttributionPreregistration = z.infer<typeof AttributionPreregistrationSchema>;
export type AttributionFacts = z.infer<typeof AttributionFactsSchema>;

const AttributionVerdictReceiptSchema = z.object({
  schema: z.literal('jinn.attribution-verdict-receipt.v1'),
  instrumentId: SingleLineSchema,
  autoload: AutoloadStateSchema,
  corpusSnapshotRef: ContentRefSchema,
  treatmentConfigDigest: Sha256DigestSchema,
  runtime: AttributionRuntimeSchema,
  isolation: AttributionIsolationSchema,
  cellStartedAt: IsoDateTimeSchema,
  cellCompletedAt: IsoDateTimeSchema,
  instanceId: SingleLineSchema,
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema,
  sessionKind: z.enum(['user', 'host-internal']),
  origin: z.literal('marketplace'),
  verdictProof: AttributionVerdictProofSchema,
  deliveredRefs: DeliveredRefsSchema,
  cost: AttributionCostSchema,
}).strict();

export interface AttributionEvidenceFile {
  path: string;
  content: Uint8Array;
}

export interface AttributionEvidenceBundle {
  manifest: string;
  files: AttributionEvidenceFile[];
}

export interface AttributionEvidenceManifestEntry {
  path: string;
  digest: string;
}

export function parseAttributionEvidenceManifest(
  manifest: string,
): AttributionEvidenceManifestEntry[] {
  if (Buffer.byteLength(manifest, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new Error('evidence manifest exceeds the maximum byte size');
  }
  if (!manifest.endsWith('\n') || manifest.includes('\r')) {
    throw new Error('evidence manifest must be LF-terminated UTF-8 text');
  }
  const lines = manifest.slice(0, -1).split('\n');
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw new Error('evidence manifest must contain at least one nonempty entry');
  }
  if (lines.length > MAX_EVIDENCE_FILES) {
    throw new Error('evidence manifest contains too many files');
  }
  const entries = lines.map((line, index) => {
    const match = /^([0-9a-f]{64})  (cells\/[A-Za-z0-9._/-]+)$/.exec(line);
    if (!match) {
      throw new Error(`evidence manifest line ${index + 1} is not a canonical shasum entry`);
    }
    const path = match[2]!;
    if (
      path.includes('//')
      || path.endsWith('/')
      || path.split('/').some((segment) => segment === '.' || segment === '..')
    ) {
      throw new Error(`evidence manifest line ${index + 1} contains an unsafe path`);
    }
    return { digest: `sha256:${match[1]}`, path };
  });
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new Error('evidence manifest contains duplicate paths');
  }
  return entries;
}

export type AttributionSignal =
  | 'helped'
  | 'harmed'
  | 'no-difference-detected'
  | 'inconclusive';

export interface AttributionRate {
  passed: number;
  scorable: number;
  unscorable: number;
  wilson95: Interval | null;
}

export interface AttributionComparisonReadout {
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
  alpha: 0.05;
  minimumMatchedPairs: number;
  minimumDiscordantPairs: number;
  offRate: AttributionRate;
  onRate: AttributionRate;
  offDeliveredRefsDigest: string;
  onDeliveredRefsDigest: string;
  offCost: AttributionCostTotal;
  onCost: AttributionCostTotal;
}

export interface AttributionCostTotal {
  inputTokens: number;
  outputTokens: number;
  usdMicros: number;
  estimatedObservations: number;
}

export interface AttributionReadout {
  schema: 'jinn.attribution-readout.v1';
  instrumentId: string;
  registeredAt: string;
  factsCompletedAt: string;
  preregistrationDigest: string;
  factsDigest: string;
  evidenceManifestDigest: string;
  design: 'matched-daemon-autoload-1x2';
  executionOrderSeed: string;
  runtime: AttributionPreregistration['runtime'];
  window: { startsAt: string; endsAt: string };
  primaryOutcome: 'completed-with-accepted-diff';
  cells: AttributionPreregistration['cells'];
  execution: Array<{
    autoload: AutoloadState;
    runId: string;
    startedAt: string;
    completedAt: string;
  }>;
  comparison: AttributionComparisonReadout;
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function verifySourceBytes(
  label: 'preregistration' | 'facts',
  parsed: unknown,
  bytes: Uint8Array,
): string {
  let fromBytes: unknown;
  try {
    fromBytes = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error(`${label} source bytes are not valid UTF-8 JSON`);
  }
  if (canonicalJson(fromBytes) !== canonicalJson(parsed)) {
    throw new Error(`${label} source bytes do not match the analyzed value`);
  }
  return sha256(bytes);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function verifyEvidenceBundle(
  evidence: AttributionEvidenceBundle,
  expectedManifestDigest?: string,
): Map<string, AttributionEvidenceFile> {
  const manifestDigest = sha256(evidence.manifest);
  if (expectedManifestDigest && manifestDigest !== expectedManifestDigest) {
    throw new Error('evidence manifest digest does not match facts');
  }
  const entries = parseAttributionEvidenceManifest(evidence.manifest);
  const filesByPath = new Map<string, Uint8Array>();
  for (const file of evidence.files) {
    if (filesByPath.has(file.path)) throw new Error(`duplicate evidence file ${file.path}`);
    filesByPath.set(file.path, file.content);
  }
  if (filesByPath.size !== entries.length) {
    throw new Error('evidence bundle file set does not match the evidence manifest');
  }
  const verified = new Map<string, AttributionEvidenceFile>();
  for (const entry of entries) {
    const content = filesByPath.get(entry.path);
    if (!content) throw new Error(`missing evidence file ${entry.path}`);
    if (sha256(content) !== entry.digest) {
      throw new Error(`${entry.path} evidence digest does not match the manifest`);
    }
    if (verified.has(entry.digest)) {
      throw new Error('evidence manifest contains duplicate file content');
    }
    verified.set(entry.digest, { path: entry.path, content });
  }
  return verified;
}

function decodeReceipt(
  file: AttributionEvidenceFile,
): z.infer<typeof AttributionVerdictReceiptSchema> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(file.content),
    ) as unknown;
  } catch {
    throw new Error(`${file.path} verdict receipt is not UTF-8 JSON`);
  }
  return AttributionVerdictReceiptSchema.parse(raw);
}

function expectedReceipt(
  facts: AttributionFacts,
  cell: AttributionFacts['cells'][number],
  result: AttributionFacts['cells'][number]['results'][number],
): Omit<z.infer<typeof AttributionVerdictReceiptSchema>, 'verdictProof'> {
  return {
    schema: 'jinn.attribution-verdict-receipt.v1',
    instrumentId: facts.instrumentId,
    autoload: cell.autoload,
    corpusSnapshotRef: cell.corpusSnapshotRef,
    treatmentConfigDigest: cell.treatmentConfigDigest,
    runtime: cell.runtime,
    isolation: cell.isolation,
    cellStartedAt: cell.startedAt,
    cellCompletedAt: cell.completedAt,
    instanceId: result.instanceId,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    sessionKind: result.sessionKind,
    origin: 'marketplace',
    deliveredRefs: result.deliveredRefs,
    cost: result.cost,
  };
}

async function verifyVerdictReceipts(
  facts: AttributionFacts,
  evidence: Map<string, AttributionEvidenceFile>,
): Promise<void> {
  const usedDigests = new Set<string>();
  for (const cell of facts.cells) {
    for (const result of cell.results) {
      const file = evidence.get(result.verdictEvidenceDigest);
      if (!file) {
        throw new Error(
          `${cell.autoload}/${result.instanceId} verdict digest is not in the verified manifest`,
        );
      }
      if (!file.path.startsWith(`cells/${cell.autoload}/`)) {
        throw new Error(
          `${cell.autoload}/${result.instanceId} verdict receipt is in the wrong cell directory`,
        );
      }
      if (usedDigests.has(result.verdictEvidenceDigest)) {
        throw new Error(`${cell.autoload}/${result.instanceId} reuses a verdict receipt`);
      }
      usedDigests.add(result.verdictEvidenceDigest);
      const receipt = decodeReceipt(file);
      const { verdictProof, ...receiptMetadata } = receipt;
      if (
        canonicalJson(receiptMetadata)
        !== canonicalJson(expectedReceipt(facts, cell, result))
      ) {
        throw new Error(
          `${cell.autoload}/${result.instanceId} facts do not match the verified verdict receipt`,
        );
      }
      const signedOutcome = await verifyAttributionVerdictProof(
        verdictProof,
        result.instanceId,
      );
      if (
        signedOutcome.acceptedDiff !== result.passed
        || signedOutcome.unscorable !== result.unscorable
        || signedOutcome.verdictRef !== result.verdictRef
      ) {
        throw new Error(
          `${cell.autoload}/${result.instanceId} facts do not match the authenticated verdict`,
        );
      }
    }
  }
  if (usedDigests.size !== evidence.size) {
    throw new Error('evidence manifest contains files not bound to a recorded observation');
  }
}

export async function buildAttributionFacts(
  registrationInput: unknown,
  completedAtInput: unknown,
  evidenceBundle: AttributionEvidenceBundle,
): Promise<AttributionFacts> {
  const registration = AttributionPreregistrationSchema.parse(registrationInput);
  const completedAt = IsoDateTimeSchema.parse(completedAtInput);
  if (Date.parse(completedAt) < Date.parse(registration.window.endsAt)) {
    throw new Error('facts export must run at or after the preregistered window end');
  }
  const evidence = verifyEvidenceBundle(evidenceBundle);
  const receipts = await Promise.all(
    [...evidence.entries()].map(async ([digestValue, file]) => {
      const receipt = decodeReceipt(file);
      return {
        digest: digestValue,
        file,
        receipt,
        outcome: await verifyAttributionVerdictProof(
          receipt.verdictProof,
          receipt.instanceId,
        ),
      };
    }),
  );
  const cells = registration.cells.map((definition) => {
    const cellReceipts = receipts.filter(({ receipt }) => receipt.autoload === definition.autoload);
    if (cellReceipts.length !== registration.population.instanceIds.length) {
      throw new Error(
        `${definition.autoload} receipt count does not match the preregistered population`,
      );
    }
    const byInstance = new Map<string, typeof cellReceipts[number]>();
    for (const item of cellReceipts) {
      if (!item.file.path.startsWith(`cells/${definition.autoload}/`)) {
        throw new Error(`${item.file.path} is in the wrong cell directory`);
      }
      if (byInstance.has(item.receipt.instanceId)) {
        throw new Error(`${definition.autoload} has duplicate receipt instance IDs`);
      }
      byInstance.set(item.receipt.instanceId, item);
      if (item.receipt.instrumentId !== registration.instrumentId) {
        throw new Error(`${item.file.path} instrumentId drift`);
      }
      if (
        item.receipt.corpusSnapshotRef !== definition.corpusSnapshotRef
        || item.receipt.treatmentConfigDigest !== definition.treatmentConfigDigest
      ) {
        throw new Error(`${item.file.path} treatment identity drift`);
      }
      if (canonicalJson(item.receipt.runtime) !== canonicalJson(registration.runtime)) {
        throw new Error(`${item.file.path} runtime provenance drift`);
      }
    }
    const ordered = registration.population.instanceIds.map((instanceId) => {
      const item = byInstance.get(instanceId);
      if (!item) throw new Error(`${definition.autoload}/${instanceId} receipt is missing`);
      return item;
    });
    const first = ordered[0]!.receipt;
    for (const item of ordered.slice(1)) {
      if (
        canonicalJson(item.receipt.isolation) !== canonicalJson(first.isolation)
        || item.receipt.cellStartedAt !== first.cellStartedAt
        || item.receipt.cellCompletedAt !== first.cellCompletedAt
      ) {
        throw new Error(`${definition.autoload} receipts disagree on cell identity or timing`);
      }
    }
    return {
      ...definition,
      runtime: first.runtime,
      isolation: first.isolation,
      startedAt: first.cellStartedAt,
      completedAt: first.cellCompletedAt,
      results: ordered.map(({ digest: verdictEvidenceDigest, outcome, receipt }) => ({
        instanceId: receipt.instanceId,
        startedAt: receipt.startedAt,
        completedAt: receipt.completedAt,
        passed: outcome.acceptedDiff,
        unscorable: outcome.unscorable,
        sessionKind: receipt.sessionKind,
        origin: receipt.origin,
        verdictRef: outcome.verdictRef,
        verdictEvidenceDigest,
        deliveredRefs: receipt.deliveredRefs,
        cost: receipt.cost,
      })),
    };
  });
  const facts = AttributionFactsSchema.parse({
    schema: 'jinn.attribution-facts.v1',
    instrumentId: registration.instrumentId,
    completedAt,
    evidenceManifestDigest: sha256(evidenceBundle.manifest),
    cells,
  });
  validateFacts(registration, facts);
  await verifyVerdictReceipts(facts, evidence);
  return facts;
}

function validateFacts(
  registration: AttributionPreregistration,
  facts: AttributionFacts,
): Map<AutoloadState, AttributionFacts['cells'][number]> {
  if (facts.instrumentId !== registration.instrumentId) {
    throw new Error('facts instrumentId does not match preregistration');
  }
  if (facts.cells.map((cell) => cell.autoload).join(',') !==
      registration.cells.map((cell) => cell.autoload).join(',')) {
    throw new Error('recorded cell execution order does not match the preregistration');
  }
  const byState = new Map(facts.cells.map((cell) => [cell.autoload, cell]));
  if (byState.size !== 2 || !byState.has('off') || !byState.has('on')) {
    throw new Error('facts must contain exactly one autoload-off and one autoload-on cell');
  }
  const startsAt = Date.parse(registration.window.startsAt);
  const endsAt = Date.parse(registration.window.endsAt);
  let priorCompletedAt = startsAt;
  const verdictRefs = new Set<string>();
  const runIds = new Set<string>();
  const homeDigests = new Set<string>();
  const storeDigests = new Set<string>();
  for (let index = 0; index < facts.cells.length; index++) {
    const actual = facts.cells[index]!;
    const expected = registration.cells[index]!;
    if (canonicalJson(actual.runtime) !== canonicalJson(registration.runtime)) {
      throw new Error(`${actual.autoload} runtime provenance drift`);
    }
    if (
      actual.corpusSnapshotRef !== expected.corpusSnapshotRef
      || actual.treatmentConfigDigest !== expected.treatmentConfigDigest
    ) {
      throw new Error(`${actual.autoload} treatment identity drift`);
    }
    const cellStartedAt = Date.parse(actual.startedAt);
    const cellCompletedAt = Date.parse(actual.completedAt);
    if (
      cellStartedAt < startsAt
      || cellCompletedAt > endsAt
      || cellStartedAt >= cellCompletedAt
    ) {
      throw new Error(`${actual.autoload} cell interval is outside the preregistered window`);
    }
    if (cellStartedAt < priorCompletedAt) {
      throw new Error(`${actual.autoload} cell timing contradicts the frozen execution order`);
    }
    priorCompletedAt = cellCompletedAt;
    for (const [set, value, label] of [
      [runIds, actual.isolation.runId, 'runId'],
      [homeDigests, actual.isolation.agentHomeDigest, 'agent home'],
      [storeDigests, actual.isolation.storeDigest, 'operator store'],
    ] as const) {
      if (set.has(value)) throw new Error(`cells reuse ${label} identity`);
      set.add(value);
    }
    const ids = actual.results.map((result) => result.instanceId);
    if (new Set(ids).size !== ids.length) {
      throw new Error(`${actual.autoload} population contains duplicate instance IDs`);
    }
    if (!sameStrings(ids, registration.population.instanceIds)) {
      throw new Error(`${actual.autoload} population drift`);
    }
    for (const result of actual.results) {
      const observationStartedAt = Date.parse(result.startedAt);
      const observationCompletedAt = Date.parse(result.completedAt);
      if (
        observationStartedAt < cellStartedAt
        || observationCompletedAt > cellCompletedAt
        || observationStartedAt >= observationCompletedAt
      ) {
        throw new Error(`${actual.autoload}/${result.instanceId} observation timing drift`);
      }
      if (result.sessionKind !== 'user') throw new Error('host-internal rows are excluded');
      if (result.origin !== 'marketplace') throw new Error('non-marketplace rows are excluded');
      if (verdictRefs.has(result.verdictRef)) throw new Error('verdict references must be unique');
      verdictRefs.add(result.verdictRef);
      if (actual.autoload === 'off' && result.deliveredRefs.length > 0) {
        throw new Error('autoload-off rows cannot record delivered refs');
      }
    }
  }
  return byState;
}

function rate(
  results: AttributionFacts['cells'][number]['results'],
): AttributionRate {
  const scorable = results.filter((result) => !result.unscorable && result.passed !== null);
  const passed = scorable.filter((result) => result.passed === true).length;
  return {
    passed,
    scorable: scorable.length,
    unscorable: results.length - scorable.length,
    wilson95: scorable.length === 0 ? null : wilsonInterval(passed, scorable.length),
  };
}

function deliveredDigest(
  results: AttributionFacts['cells'][number]['results'],
): string {
  return sha256(sorted(results.flatMap((result) =>
    result.deliveredRefs.map((ref) => `${result.instanceId}\0${ref}`))).join('\n'));
}

function costTotal(
  results: AttributionFacts['cells'][number]['results'],
): AttributionCostTotal {
  const total = results.reduce<AttributionCostTotal>((sum, result) => ({
    inputTokens: sum.inputTokens + result.cost.inputTokens,
    outputTokens: sum.outputTokens + result.cost.outputTokens,
    usdMicros: sum.usdMicros + result.cost.usdMicros,
    estimatedObservations:
      sum.estimatedObservations + (result.cost.usdMicrosEstimated ? 1 : 0),
  }), {
    inputTokens: 0,
    outputTokens: 0,
    usdMicros: 0,
    estimatedObservations: 0,
  });
  if (
    !Number.isSafeInteger(total.inputTokens)
    || !Number.isSafeInteger(total.outputTokens)
    || !Number.isSafeInteger(total.usdMicros)
  ) {
    throw new Error('recorded cost totals exceed exact integer range');
  }
  return total;
}

function compare(
  registration: AttributionPreregistration,
  cells: Map<AutoloadState, AttributionFacts['cells'][number]>,
): AttributionComparisonReadout {
  const off = cells.get('off')!;
  const on = cells.get('on')!;
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
    offRate: rate(off.results),
    onRate: rate(on.results),
    offDeliveredRefsDigest: deliveredDigest(off.results),
    onDeliveredRefsDigest: deliveredDigest(on.results),
    offCost: costTotal(off.results),
    onCost: costTotal(on.results),
  };
}

export async function analyzeAttributionInstrument(
  registrationInput: unknown,
  factsInput: unknown,
  opts: {
    now?: Date;
    evidence: AttributionEvidenceBundle;
    sourceBytes: { preregistration: Uint8Array; facts: Uint8Array };
  },
): Promise<AttributionReadout> {
  const registration = AttributionPreregistrationSchema.parse(registrationInput);
  const facts = AttributionFactsSchema.parse(factsInput);
  const preregistrationDigest = verifySourceBytes(
    'preregistration',
    registrationInput,
    opts.sourceBytes.preregistration,
  );
  const factsDigest = verifySourceBytes('facts', factsInput, opts.sourceBytes.facts);
  const now = opts.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('readout clock is invalid');
  const endsAt = Date.parse(registration.window.endsAt);
  if (now.getTime() < endsAt) throw new Error('fixed evaluation window has not closed');
  const completedAt = Date.parse(facts.completedAt);
  if (completedAt < endsAt) throw new Error('facts completed before the fixed window ended');
  if (completedAt > now.getTime()) throw new Error('facts completedAt is in the future');

  const cells = validateFacts(registration, facts);
  const evidence = verifyEvidenceBundle(opts.evidence, facts.evidenceManifestDigest);
  await verifyVerdictReceipts(facts, evidence);
  return {
    schema: 'jinn.attribution-readout.v1',
    instrumentId: registration.instrumentId,
    registeredAt: registration.registeredAt,
    factsCompletedAt: facts.completedAt,
    preregistrationDigest,
    factsDigest,
    evidenceManifestDigest: facts.evidenceManifestDigest,
    design: registration.design,
    executionOrderSeed: registration.executionOrderSeed,
    runtime: registration.runtime,
    window: registration.window,
    primaryOutcome: registration.primaryOutcome,
    cells: registration.cells,
    execution: facts.cells.map((cell) => ({
      autoload: cell.autoload,
      runId: cell.isolation.runId,
      startedAt: cell.startedAt,
      completedAt: cell.completedAt,
    })),
    comparison: compare(registration, cells),
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function markdownInline(value: string): string {
  return value.replace(/[\\`*_[\]{}()#+\-.!|<>]/g, '\\$&');
}

function renderRate(label: string, rate: AttributionRate): string {
  const interval = rate.wilson95;
  if (!interval) {
    return `- ${label}: 0/0 (95% Wilson n/a; ${rate.unscorable} unscorable)`;
  }
  return `- ${label}: ${rate.passed}/${rate.scorable} `
    + `(${percent(interval.p)}; 95% Wilson `
    + `${percent(interval.lo)}–${percent(interval.hi)}; `
    + `${rate.unscorable} unscorable)`;
}

export function renderAttributionReadoutMarkdown(readout: AttributionReadout): string {
  const result = readout.comparison;
  return [
    '# Stage 2 daemon-autoload attribution readout',
    '',
    `Instrument: ${markdownInline(readout.instrumentId)}`,
    `Design: ${readout.design}`,
    `Execution-order seed: ${markdownInline(readout.executionOrderSeed)}`,
    `Runtime: ${markdownInline(readout.runtime.modelRef)} · `
      + `${markdownInline(readout.runtime.harnessRef)} · `
      + `${markdownInline(readout.runtime.graderRef)}`,
    `Window: ${readout.window.startsAt} → ${readout.window.endsAt}`,
    `Primary outcome: ${readout.primaryOutcome}`,
    `Preregistration digest: ${readout.preregistrationDigest}`,
    `Facts digest: ${readout.factsDigest}`,
    `Evidence manifest digest: ${readout.evidenceManifestDigest}`,
    '',
    '### Primary comparison: daemon autoload off → on',
    '',
    `- Mechanical signal: ${result.signal}`,
    `- Matched N: ${result.matchedN} (planned ${result.plannedN}; excluded ${result.excludedN})`,
    `- Discordant: ${result.discordant} `
      + `(${result.improved} improved, ${result.regressed} regressed)`,
    `- Exact paired McNemar p: ${result.pValue.toPrecision(4)} (α=${result.alpha})`,
    `- Preregistered bar: ${result.barMet ? 'met' : 'not met'} `
      + `(matched ≥${result.minimumMatchedPairs}; `
      + `discordant ≥${result.minimumDiscordantPairs})`,
    renderRate('Autoload off', result.offRate),
    renderRate('Autoload on', result.onRate),
    `- Delivered-ref identity (off/on): `
      + `${result.offDeliveredRefsDigest} / ${result.onDeliveredRefsDigest}`,
    `- Recorded cost off/on (USD micros): `
      + `${result.offCost.usdMicros} / ${result.onCost.usdMicros} `
      + `(estimated observations ${result.offCost.estimatedObservations} / `
      + `${result.onCost.estimatedObservations})`,
    `- Recorded tokens off/on (input, output): `
      + `${result.offCost.inputTokens}, ${result.offCost.outputTokens} / `
      + `${result.onCost.inputTokens}, ${result.onCost.outputTokens}`,
    '',
    'Interpretation and downstream posture decisions remain human. '
      + 'This file is the mechanical readout only.',
  ].join('\n');
}
