import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import { documentDigest, serializeCanonicalJson } from '@jinn-network/task-execution-protocol';
import { AgentIriSchema } from '@jinn-network/trust-core';
import { z } from 'zod/v3';

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/u);
const commit = z.string().regex(/^[0-9a-f]{40}$/u);
const decimal = z.string().regex(/^(0|[1-9]\d*)$/u);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/u);
const agentIri = z.string().refine(
  (value) => AgentIriSchema.safeParse(value).success,
  'must be an accepted Agent IRI',
);

export const PHASE_B_ROLE_SET = [
  'requester-submission', 'admission', 'requester-discovery', 'solver-delivery',
  'solver-discovery', 'evaluator-verdict', 'evaluator-discovery',
] as const;
export const PHASE_B_SOURCE_ROLE_SET = ['requester', 'solver', 'evaluator'] as const;
export const PHASE_B_RECORD_ROOT_SET = [
  'task', 'submission', 'evaluation-spec', 'admission-receipt', 'requester-envelope',
  'solution-evidence', 'solution-output', 'solution-delivery', 'solution-delivery-envelope',
  'evaluation-task', 'evaluation-submission', 'evaluation-evidence', 'evaluation-delivery',
  'evaluation-delivery-envelope', 'verdict-envelope',
] as const;
export const PHASE_B_RESTART_CHECKPOINT_SET = [
  'posting', 'claim', 'backend-submit', 'evidence', 'solution-settlement', 'verdict-settlement',
] as const;

const PhaseBSettlementFactSchema = z.object({
  operationId: sha256,
  transactionHash: hash,
  blockHash: hash,
  blockNumber: decimal,
  finalized: z.literal(true),
  baseScanUrl: z.string().url(),
}).strict();

export const PhaseBClosureManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('jinn.phase-b-native-vertical-closure'),
  liveRun: z.literal(true),
  commit,
  createdAt: z.string().datetime(),
  chain: z.object({
    chainId: z.literal(84532),
    generation: z.literal('today'),
    taskCoordinator: address,
    jinnRouter: address,
    mechMarketplace: address,
    activityChecker: address,
  }).strict(),
  packageTarballs: z.array(z.object({
    name: z.string().min(1),
    digest: sha256,
  }).strict()).min(1),
  build: z.object({
    b9PlatformManifestDigest: sha256,
    b9NativeAcceptanceManifestDigest: sha256,
    productDigest: sha256,
    infrastructureBundleDigest: sha256,
  }).strict(),
  publicRoles: z.array(z.object({
    role: z.enum(PHASE_B_ROLE_SET),
    agent: agentIri,
    keyId: z.string().regex(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/u),
    bindingDigest: sha256,
  }).strict()).min(5),
  sourceHeads: z.array(z.object({
    role: z.enum(PHASE_B_SOURCE_ROLE_SET),
    agent: agentIri,
    name: z.string().min(1),
    sequence: z.string().min(1),
    entryDigest: sha256,
  }).strict()).min(3),
  recordRoots: z.array(z.object({
    role: z.enum(PHASE_B_RECORD_ROOT_SET),
    digest: sha256,
  }).strict()).min(1),
  settlements: z.object({
    solution: PhaseBSettlementFactSchema,
    verdict: PhaseBSettlementFactSchema,
  }).strict(),
  recoveryReports: z.array(z.object({
    checkpoint: z.enum(PHASE_B_RESTART_CHECKPOINT_SET),
    digest: sha256,
  }).strict()).min(6),
  consumerReportDigest: sha256,
  configDigest: sha256,
  acceptanceCriteria: z.array(z.object({
    id: z.number().int().min(1).max(62),
    status: z.literal('passed'),
    evidence: z.array(sha256).min(1),
  }).strict()).length(62, 'live closure requires all 62 acceptance criteria'),
}).strict().superRefine((manifest, context) => {
  const expected = BASE_SEPOLIA_TODAY;
  for (const key of ['taskCoordinator', 'jinnRouter', 'mechMarketplace', 'activityChecker'] as const) {
    if (manifest.chain[key].toLowerCase() !== expected[key].toLowerCase()) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['chain', key], message: 'wrong Base Sepolia today address' });
    }
  }
  const uniquenessChecks: ReadonlyArray<{
    path: string;
    values: readonly string[];
  }> = [
    { path: 'packageTarballs', values: manifest.packageTarballs.map(({ name }) => name) },
    { path: 'publicRoles', values: manifest.publicRoles.map(({ role }) => role) },
    { path: 'publicRoleKeyIds', values: manifest.publicRoles.map(({ keyId }) => keyId) },
    { path: 'publicRoleBindingDigests', values: manifest.publicRoles.map(({ bindingDigest }) => bindingDigest) },
    { path: 'sourceHeads', values: manifest.sourceHeads.map(({ role }) => role) },
    { path: 'sourceIdentities', values: manifest.sourceHeads.map(({ agent, name }) => `${agent}\0${name}`) },
    { path: 'sourceEntryDigests', values: manifest.sourceHeads.map(({ entryDigest }) => entryDigest) },
    { path: 'recordRoots', values: manifest.recordRoots.map(({ role }) => role) },
    { path: 'recordRootDigests', values: manifest.recordRoots.map(({ digest }) => digest) },
    { path: 'recoveryReports', values: manifest.recoveryReports.map(({ checkpoint }) => checkpoint) },
    { path: 'recoveryReportDigests', values: manifest.recoveryReports.map(({ digest }) => digest) },
    { path: 'acceptanceCriteria', values: manifest.acceptanceCriteria.map(({ id }) => String(id)) },
  ];
  for (const { path, values } of uniquenessChecks) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: 'duplicate authority entry' });
    }
  }
  const exactSets: ReadonlyArray<{ readonly path: string; readonly actual: readonly string[]; readonly expected: readonly string[] }> = [
    { path: 'publicRoles', actual: manifest.publicRoles.map(({ role }) => role), expected: PHASE_B_ROLE_SET },
    { path: 'sourceHeads', actual: manifest.sourceHeads.map(({ role }) => role), expected: PHASE_B_SOURCE_ROLE_SET },
    { path: 'recordRoots', actual: manifest.recordRoots.map(({ role }) => role), expected: PHASE_B_RECORD_ROOT_SET },
    { path: 'recoveryReports', actual: manifest.recoveryReports.map(({ checkpoint }) => checkpoint), expected: PHASE_B_RESTART_CHECKPOINT_SET },
  ];
  for (const { path, actual, expected: required } of exactSets) {
    const actualSet = new Set(actual);
    if (actualSet.size !== required.length || required.some((value) => !actualSet.has(value))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: 'does not contain the exact Phase B closure set' });
    }
  }
  const criterionIds = new Set(manifest.acceptanceCriteria.map(({ id }) => id));
  if (criterionIds.size !== 62 || Array.from({ length: 62 }, (_, index) => index + 1).some((id) => !criterionIds.has(id))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['acceptanceCriteria'],
      message: 'live closure requires the exact 62 acceptance criteria',
    });
  }
  const roleAgent = new Map(manifest.publicRoles.map(({ role, agent }) => [role, agent]));
  const sourceAgent = new Map(manifest.sourceHeads.map(({ role, agent }) => [role, agent]));
  const actorJoins = [
    ['requester-submission', 'requester-discovery', 'requester'],
    ['solver-delivery', 'solver-discovery', 'solver'],
    ['evaluator-verdict', 'evaluator-discovery', 'evaluator'],
  ] as const;
  for (const [authorityRole, discoveryRole, sourceRole] of actorJoins) {
    if (roleAgent.get(authorityRole) !== roleAgent.get(discoveryRole)
      || roleAgent.get(authorityRole) !== sourceAgent.get(sourceRole)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publicRoles'],
        message: `${sourceRole} authority and signed source agents do not join`,
      });
    }
  }
  const admission = roleAgent.get('admission');
  if (admission === roleAgent.get('requester-submission')
    || admission === roleAgent.get('solver-delivery')
    || admission === roleAgent.get('evaluator-verdict')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['publicRoles'], message: 'admission agent must remain a distinct actor' });
  }
  for (const [kind, fact] of Object.entries(manifest.settlements)) {
    const expectedUrl = `https://sepolia.basescan.org/tx/${fact.transactionHash}`;
    if (fact.baseScanUrl !== expectedUrl) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['settlements', kind, 'baseScanUrl'], message: 'BaseScan URL does not bind transactionHash' });
    }
  }
});

export type PhaseBClosureManifest = z.infer<typeof PhaseBClosureManifestSchema>;

export interface ValidatedPhaseBClosureManifest {
  readonly manifest: PhaseBClosureManifest;
  readonly digest: `sha256:${string}`;
}

const FORBIDDEN_KEY = /(private|password|secret|token|credential|stateDir|identityStore|trustRoots|producerPath)/iu;
const PRIVATE_PATH = /(?:^|["'])\s*(?:\/Users\/|\/home\/|\/var\/lib\/|file:|\.\.?\/)/u;

function rejectPrivateMaterial(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectPrivateMaterial(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) throw new Error(`Phase B closure manifest contains forbidden field ${path}.${key}`);
      rejectPrivateMaterial(item, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === 'string' && PRIVATE_PATH.test(value)) {
    throw new Error(`Phase B closure manifest contains a private producer path at ${path}`);
  }
}

export function buildPhaseBClosureManifest(input: PhaseBClosureManifest): Uint8Array {
  rejectPrivateMaterial(input);
  const parsed = PhaseBClosureManifestSchema.parse(input);
  return serializeCanonicalJson(parsed as Parameters<typeof serializeCanonicalJson>[0]);
}

export function parseValidatedPhaseBClosureManifest(bytes: Uint8Array): ValidatedPhaseBClosureManifest {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error(`Phase B closure manifest is not UTF-8 JSON: ${String(cause)}`);
  }
  rejectPrivateMaterial(decoded);
  const manifest = PhaseBClosureManifestSchema.parse(decoded);
  const canonical = buildPhaseBClosureManifest(manifest);
  if (!Buffer.from(canonical).equals(Buffer.from(bytes))) {
    throw new Error('Phase B closure manifest does not use the canonical producer encoding');
  }
  if (manifest.settlements.solution.operationId === manifest.settlements.verdict.operationId
    || manifest.settlements.solution.transactionHash.toLowerCase() === manifest.settlements.verdict.transactionHash.toLowerCase()) {
    throw new Error('Phase B closure manifest must carry independent solution and verdict settlements');
  }
  return { manifest, digest: documentDigest(bytes) };
}
