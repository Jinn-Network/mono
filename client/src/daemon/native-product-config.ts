import { isAbsolute } from 'node:path';
import { AgentIriSchema } from '@jinn-network/trust-core';
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import { z } from 'zod/v3';
import type {
  NativeEvaluationMethodDigests,
  NativeGraderReportBinding,
} from './native-evaluator-composition.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/u);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
// A `sha256:<64 hex>` whose INFERRED type is the `sha256:${string}` template literal the native
// composition consumes, so `evaluationMethodDigest` threads to `buildNativeEvaluatorComposition`
// without a narrowing cast (the regex is the whole runtime check; `.transform` only re-types).
const brandedDigest = digest.transform((value) => value as `sha256:${string}`);
/**
 * One digest every configured registration's evaluation-method descriptor must declare, or an
 * exact per-`registrationId` map for a deployment serving more than one method (M1's map form,
 * PR #2463). The `satisfies` clause keeps the parsed output assignable to the type the composition
 * accepts (`NativeEvaluationMethodDigests`) — the two stop compiling if they ever diverge.
 */
const evaluationMethodDigests = z.union([
  brandedDigest,
  z.record(z.string().min(1), brandedDigest),
]) satisfies z.ZodType<NativeEvaluationMethodDigests, z.ZodTypeDef, unknown>;
/**
 * Grader-execution binding per container-graded registration the deployment declares. Only the
 * `"deployment-owned"` literal is expressible in a config file: a live host `GraderReportSource`
 * object cannot cross the spawned-child boundary (#2467 Finding P0-5-A). The `satisfies` clause
 * keeps the parsed value assignable to the composition's `NativeGraderReportBinding`.
 */
const graderReportSources = z.record(
  z.string().min(1),
  z.literal('deployment-owned'),
) satisfies z.ZodType<Record<string, NativeGraderReportBinding>, z.ZodTypeDef, unknown>;
const UINT256_MAX = (1n << 256n) - 1n;
const wei = z.string().regex(/^(0|[1-9]\d{0,77})$/u, 'must be a canonical uint256 decimal')
  .refine((value) => BigInt(value) <= UINT256_MAX, 'must fit uint256');
const absolutePath = z.string().min(1).refine(isAbsolute, 'must be an absolute path');
const moduleLocation = z.string().min(1).refine(
  (value) => isAbsolute(value) || value.startsWith('file:'),
  'must be an absolute path or file URL',
);
const agentIri = z.string().min(1).refine(
  (value) => AgentIriSchema.safeParse(value).success,
  'must be an accepted Agent IRI',
);
const publicHttpUrl = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'https:' || protocol === 'http:';
}, 'must use HTTP(S)');

export const NativeOperatorConfigSchema = z.object({
  role: z.enum(['requester', 'solver', 'evaluator']),
  agent: agentIri,
  admissionAgent: agentIri.optional(),
  safeAddress: address,
  marketplaceAgentAddress: address.optional(),
  evmCustody: z.object({
    keystorePath: absolutePath,
    expectedOwnerAddress: address,
    accountIndex: z.number().int().min(0).max(0xffff_ffff),
  }).strict(),
  publicBaseUrl: publicHttpUrl,
  publicListen: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
  }).strict(),
  sources: z.array(z.object({
    role: z.enum(['requester', 'solver', 'evaluator']),
    agent: agentIri,
    name: z.string().min(1),
    baseUrl: publicHttpUrl,
  }).strict()).min(1),
  ipfs: z.object({ apiUrl: publicHttpUrl }).strict(),
  chainId: z.literal(84532),
  generation: z.literal('today'),
  contracts: z.object({
    taskCoordinator: address,
    jinnRouter: address,
    mechMarketplace: address,
    activityChecker: address,
  }).strict(),
  transactionCaps: z.object({
    createTaskMaxWei: wei,
    claimMaxWei: wei,
    solutionSettlementMaxWei: wei,
    evaluationClaimMaxWei: wei,
    verdictSettlementMaxWei: wei,
    escrowMaxWei: wei,
  }).strict(),
  postingTerms: z.object({
    solutionMaxDeliveryRateWei: wei,
    verdictMaxDeliveryRateWei: wei,
    responseTimeoutSeconds: wei.refine((value) => BigInt(value) > 0n, 'must be positive'),
    allowSolverSelfEvaluation: z.literal(false),
  }).strict().optional(),
  stateDir: absolutePath,
  identityStores: z.object({
    requester: absolutePath.optional(),
    admission: absolutePath.optional(),
    solver: absolutePath.optional(),
    evaluator: absolutePath.optional(),
  }).strict(),
  trustRootsPath: absolutePath,
  trustPolicyGenesisDigest: digest,
  runtime: z.discriminatedUnion('provider', [
    z.object({ provider: z.literal('first-party'), nodeExecutableDigest: digest }).strict(),
    z.object({
      provider: z.literal('digest-pinned-bundle'),
      infrastructureBundle: absolutePath,
      bundleDigest: digest,
      nodeExecutableDigest: digest,
    }).strict(),
  ]),
  evaluator: z.object({
    deploymentModule: moduleLocation,
    moduleDigest: digest,
    signerHandle: z.string().min(1),
    evaluationMethodDigest: evaluationMethodDigests,
    /**
     * Grader-execution binding per container-graded registration the deployment declares. Omitted
     * for a deployment with no container-graded registration (today's prediction-only shape); a
     * container-graded registration with no binding is refused at composition (#2467).
     */
    graderReportSources: graderReportSources.optional(),
  }).strict().optional(),
  finality: z.object({ confirmations: z.number().int().positive() }).strict(),
  liveClosureReceiptPath: absolutePath,
}).strict().superRefine((value, context) => {
  for (const name of ['taskCoordinator', 'jinnRouter', 'mechMarketplace', 'activityChecker'] as const) {
    if (value.contracts[name].toLowerCase() !== BASE_SEPOLIA_TODAY[name].toLowerCase()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contracts', name],
        message: 'must equal the accepted Base Sepolia today deployment',
      });
    }
  }
  const seen = new Set<string>();
  for (const [index, source] of value.sources.entries()) {
    const key = `${source.agent}\0${source.name}`;
    if (seen.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sources', index],
        message: 'duplicate source identity',
      });
    }
    seen.add(key);
  }
  if (value.role === 'evaluator' && value.evaluator === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evaluator'],
      message: 'evaluator role requires a digest-pinned evaluator deployment',
    });
  }
  if (value.role === 'requester' && value.admissionAgent === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['admissionAgent'],
      message: 'requester role requires its distinct admission Agent IRI',
    });
  }
  if (value.role === 'requester' && value.postingTerms === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['postingTerms'],
      message: 'requester role requires explicit native posting terms',
    });
  }
  if (value.role !== 'requester' && value.postingTerms !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['postingTerms'],
      message: `${value.role} role must not carry requester posting authority`,
    });
  }
  if (value.postingTerms !== undefined) {
    const escrow = BigInt(value.postingTerms.solutionMaxDeliveryRateWei)
      + BigInt(value.postingTerms.verdictMaxDeliveryRateWei);
    if (escrow <= 0n || escrow > BigInt(value.transactionCaps.escrowMaxWei)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['postingTerms'],
        message: 'posting escrow must be non-zero and within the configured escrow cap',
      });
    }
  }
  if (value.role !== 'requester' && value.marketplaceAgentAddress === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['marketplaceAgentAddress'],
      message: `${value.role} role requires its deployed marketplace agent address`,
    });
  }
  const requesterSources = value.sources.filter(({ role }) => role === 'requester');
  const solverSources = value.sources.filter(({ role }) => role === 'solver');
  if (value.role === 'solver' && requesterSources.length !== 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sources'], message: 'solver role requires exactly one requester source' });
  }
  if (value.role === 'evaluator' && (requesterSources.length !== 1 || solverSources.length !== 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sources'], message: 'evaluator role requires exactly one requester and one solver source' });
  }
  const requiredStores = value.role === 'requester' ? ['requester', 'admission'] as const : [value.role] as const;
  const configuredStores = Object.entries(value.identityStores)
    .filter((entry): entry is [keyof typeof value.identityStores, string] => entry[1] !== undefined)
    .map(([role]) => role);
  for (const storeRole of requiredStores) {
    if (value.identityStores[storeRole] === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identityStores', storeRole],
        message: `${value.role} role requires the ${storeRole} identity store`,
      });
    }
  }
  for (const storeRole of configuredStores) {
    if (!(requiredStores as readonly string[]).includes(storeRole)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identityStores', storeRole],
        message: `${value.role} process must not be configured with ${storeRole} custody`,
      });
    }
  }
  if (value.role === 'requester'
    && value.identityStores.requester !== undefined
    && value.identityStores.requester === value.identityStores.admission) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['identityStores', 'admission'],
      message: 'admission identity store must be distinct from requester custody',
    });
  }
  if (value.role === 'requester' && value.admissionAgent === value.agent) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['admissionAgent'],
      message: 'admission Agent must be distinct from the requester Agent',
    });
  }
});

export type NativeOperatorConfig = z.infer<typeof NativeOperatorConfigSchema>;

/** In-process native production shape. The dedicated native-v1 file parser is gone (D5). */
export type NativeProductConfig = {
  readonly network: 'testnet';
  readonly rpcUrl: string;
  readonly operator: {
    readonly native: NativeOperatorConfig;
  };
};
