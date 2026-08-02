import type {
  BackendCapabilities,
  TaskExecutionBackend,
} from '@jinn-network/task-execution-backend';
import {
  mapAnnouncedSubmissionToFacts,
  RECORD_KINDS_SUBMISSION,
  validateRequirementsAgainstRunPinning,
  verifyPreclaim,
  type AnnouncedSubmissionCard,
  type SubmissionFacts,
} from '@jinn-network/marketplace-pipeline';
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import {
  documentDigest,
  serializeCanonicalJson,
  SubmissionRecordSchema,
  TaskSpecificationSchema,
} from '@jinn-network/task-execution-protocol';
import { PREDICTION_FORECAST_PROFILE_URI } from '@jinn-network/task-execution-profiles';

export const PHASE_B_NATIVE_PROFILE_ALLOWLIST = [PREDICTION_FORECAST_PROFILE_URI] as const;

export interface NativeLauncherInspection {
  readonly launcherId: string;
  readonly taskProfiles: readonly string[];
  readonly executable: { readonly path: string; readonly digest: string };
  readonly probe: {
    readonly ready: boolean;
    readonly detail?: string;
    readonly executable?: { readonly path: string; readonly digest: string };
  };
}

export interface NativeLauncherCapabilityPort {
  inspect(input: {
    readonly profileUri: string;
    readonly requirements: Readonly<Record<string, unknown>>;
  }): Promise<NativeLauncherInspection>;
}

export interface NativeTier4ClaimPolicy {
  readonly chainId: number;
  readonly coordinator: string;
  readonly generation: 'today' | 'revised';
  readonly allowedProfiles?: readonly string[];
  readonly maxSpendWei: bigint;
  readonly minDeadlineLeadMs: number;
  readonly maxConcurrent: number;
}

export interface NativeClaimEvaluationInput {
  readonly card: AnnouncedSubmissionCard;
  readonly taskBytes: Uint8Array;
  readonly submissionBytes: Uint8Array;
  readonly backend: TaskExecutionBackend;
  readonly launcher: NativeLauncherCapabilityPort | undefined;
  readonly policy: NativeTier4ClaimPolicy;
  readonly activeEngagements: number;
  readonly canonicalFinalized: boolean;
  readonly now: Date;
}

export interface NativeCapabilityEvidence {
  readonly ok: boolean;
  readonly reason?: string;
  readonly backend?: BackendCapabilities;
  readonly launcher?: NativeLauncherInspection;
  readonly preflight?: { readonly ready: boolean; readonly detail?: string };
}

export interface NativePolicyEvidence {
  readonly ok: boolean;
  readonly reason?: string;
  readonly chainId: number;
  readonly coordinator: string;
  readonly profileUri?: string;
  readonly intendedSpendWei: string;
  readonly deadline?: string;
  readonly activeEngagements: number;
  readonly canonicalFinalized: boolean;
}

export type NativeClaimDecision =
  | {
      readonly ok: true;
      readonly facts: SubmissionFacts;
      readonly capability: NativeCapabilityEvidence & { readonly ok: true };
      readonly policy: NativePolicyEvidence & { readonly ok: true };
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly retryable: boolean;
      readonly capability: NativeCapabilityEvidence;
      readonly policy: NativePolicyEvidence;
    };

const decoder = new TextDecoder('utf-8', { fatal: true });
const SHA256_HEX = /^[0-9a-f]{64}$/u;

function normalizedAddress(value: string): string {
  return value.toLowerCase();
}

function policyEvidence(input: NativeClaimEvaluationInput, profileUri?: string, deadline?: string): NativePolicyEvidence {
  return {
    ok: false,
    chainId: input.policy.chainId,
    coordinator: normalizedAddress(input.policy.coordinator),
    ...(profileUri === undefined ? {} : { profileUri }),
    intendedSpendWei: input.card.chain.intendedSpendWei.toString(10),
    ...(deadline === undefined ? {} : { deadline }),
    activeEngagements: input.activeEngagements,
    canonicalFinalized: input.canonicalFinalized,
  };
}

function refused(
  reason: string,
  retryable: boolean,
  capability: NativeCapabilityEvidence,
  policy: NativePolicyEvidence,
): NativeClaimDecision {
  return {
    ok: false,
    reason,
    retryable,
    capability: capability.ok ? capability : { ...capability, reason: capability.reason ?? reason },
    policy: policy.ok ? policy : { ...policy, reason: policy.reason ?? reason },
  };
}

function parseExact(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes));
}

function equalCanonical(left: unknown, right: unknown): boolean {
  return Buffer.from(serializeCanonicalJson(left as never))
    .equals(Buffer.from(serializeCanonicalJson(right as never)));
}

function mergeRequirements(
  task: Readonly<Record<string, unknown>>,
  submission: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  const merged: Record<string, unknown> = { ...task };
  for (const [key, value] of Object.entries(submission)) {
    if (Object.hasOwn(merged, key) && !equalCanonical(merged[key], value)) return undefined;
    merged[key] = value;
  }
  return merged;
}

function validatePolicy(
  input: NativeClaimEvaluationInput,
  facts: SubmissionFacts,
  deadline: string,
): NativePolicyEvidence & { readonly ok: boolean; readonly reason?: string; readonly retryable?: boolean } {
  const evidence = policyEvidence(input, facts.profileUri, deadline);
  const expected = BASE_SEPOLIA_TODAY;
  if (
    input.policy.chainId !== expected.chainId
    || input.policy.generation !== 'today'
    || normalizedAddress(input.policy.coordinator) !== normalizedAddress(expected.taskCoordinator)
  ) return { ...evidence, reason: 'network-policy', retryable: false };

  const allowlist = input.policy.allowedProfiles ?? PHASE_B_NATIVE_PROFILE_ALLOWLIST;
  if (!allowlist.includes(facts.profileUri)) {
    return { ...evidence, reason: 'unsupported-profile', retryable: false };
  }
  if (input.card.chain.intendedSpendWei > input.policy.maxSpendWei) {
    return { ...evidence, reason: 'spend-policy', retryable: false };
  }
  if (
    !Number.isSafeInteger(input.policy.minDeadlineLeadMs)
    || input.policy.minDeadlineLeadMs < 0
    || Date.parse(deadline) - input.now.getTime() < input.policy.minDeadlineLeadMs
  ) return { ...evidence, reason: 'deadline-policy', retryable: false };
  if (
    !Number.isSafeInteger(input.policy.maxConcurrent)
    || input.policy.maxConcurrent <= 0
    || input.activeEngagements >= input.policy.maxConcurrent
  ) return { ...evidence, reason: 'capacity-policy', retryable: true };
  if (!input.canonicalFinalized) return { ...evidence, reason: 'finality-policy', retryable: true };
  return { ...evidence, ok: true };
}

async function evaluateCapability(
  input: NativeClaimEvaluationInput,
  facts: SubmissionFacts,
  requiredOutputMediaTypes: readonly string[],
): Promise<NativeCapabilityEvidence & { readonly retryable?: boolean }> {
  const capabilitiesPort = (input.backend as { capabilities?: TaskExecutionBackend['capabilities'] }).capabilities;
  if (typeof capabilitiesPort !== 'function') {
    return { ok: false, reason: 'capability-unavailable', retryable: true };
  }
  let backendCapabilities: BackendCapabilities;
  try {
    backendCapabilities = await capabilitiesPort.call(input.backend);
  } catch (error) {
    return {
      ok: false,
      reason: 'capability-unavailable',
      retryable: true,
      preflight: { ready: false, detail: error instanceof Error ? error.message : String(error) },
    };
  }
  if (!backendCapabilities.preflight || typeof input.backend.preflight !== 'function') {
    return { ok: false, reason: 'preflight-unavailable', retryable: false, backend: backendCapabilities };
  }
  if (!backendCapabilities.signedDeliveries) {
    return { ok: false, reason: 'unsigned-deliveries', retryable: false, backend: backendCapabilities };
  }
  if (backendCapabilities.evidenceCapture === 'none') {
    return { ok: false, reason: 'evidence-unavailable', retryable: false, backend: backendCapabilities };
  }
  if (!backendCapabilities.deadlineEnforcement) {
    return { ok: false, reason: 'deadline-unenforced', retryable: false, backend: backendCapabilities };
  }
  if (requiredOutputMediaTypes.some((mediaType) => !backendCapabilities.outputMediaTypes.includes(mediaType))) {
    return { ok: false, reason: 'output-media-type-unsupported', retryable: false, backend: backendCapabilities };
  }
  const runPinningByKey = new Map(backendCapabilities.runPinning.keys.map((support) => [support.key, support]));
  if (validateRequirementsAgainstRunPinning(facts.requirements, backendCapabilities.runPinning) !== undefined) {
    return { ok: false, reason: 'unsupported-requirement', retryable: false, backend: backendCapabilities };
  }
  for (const key of Object.keys(facts.requirements)) {
    if (key === 'maxAttemptDurationMs') continue;
    if (runPinningByKey.get(key)?.posture !== 'enforced') {
      return { ok: false, reason: 'run-pinning-not-enforced', retryable: false, backend: backendCapabilities };
    }
  }
  if (input.launcher === undefined) {
    return {
      ok: false,
      reason: 'launcher-capability-unavailable',
      retryable: false,
      backend: backendCapabilities,
    };
  }

  let launcher: NativeLauncherInspection;
  try {
    launcher = await input.launcher.inspect({
      profileUri: facts.profileUri,
      requirements: facts.requirements,
    });
  } catch (error) {
    return {
      ok: false,
      reason: 'launcher-probe-failed',
      retryable: true,
      backend: backendCapabilities,
      preflight: { ready: false, detail: error instanceof Error ? error.message : String(error) },
    };
  }
  const probeExecutable = launcher.probe.executable;
  if (
    !launcher.probe.ready
    || launcher.executable.path.length === 0
    || !SHA256_HEX.test(launcher.executable.digest)
    || (
      probeExecutable !== undefined
      && (
        probeExecutable.path !== launcher.executable.path
        || probeExecutable.digest !== launcher.executable.digest
      )
    )
  ) {
    return {
      ok: false,
      reason: 'launcher-probe-failed',
      retryable: true,
      backend: backendCapabilities,
      launcher,
      preflight: { ready: false, ...(launcher.probe.detail === undefined ? {} : { detail: launcher.probe.detail }) },
    };
  }
  if (!launcher.taskProfiles.includes(facts.profileUri)) {
    return { ok: false, reason: 'profile-mismatch', retryable: false, backend: backendCapabilities, launcher };
  }

  const preclaim = await verifyPreclaim(facts, input.backend, backendCapabilities);
  if (!preclaim.ok) {
    const retryable = preclaim.reason === 'preflight-not-ready';
    return {
      ok: false,
      reason: preclaim.reason,
      retryable,
      backend: backendCapabilities,
      launcher,
      preflight: {
        ready: false,
        ...(preclaim.detail === undefined ? {} : { detail: preclaim.detail }),
      },
    };
  }
  return {
    ok: true,
    backend: backendCapabilities,
    launcher,
    preflight: { ready: true },
  };
}

export async function evaluateNativeClaim(input: NativeClaimEvaluationInput): Promise<NativeClaimDecision> {
  const basePolicy = policyEvidence(input);
  const noCapability: NativeCapabilityEvidence = { ok: false };
  if (input.card.derivationKind === 'legacy') {
    return refused('legacy-card', false, noCapability, basePolicy);
  }
  if (input.card.discovery === undefined) {
    return refused('unverified-source', false, noCapability, basePolicy);
  }
  if (input.card.record.kind !== RECORD_KINDS_SUBMISSION) {
    return refused('sealed-document-mismatch', false, noCapability, basePolicy);
  }

  let task;
  let submission;
  try {
    if (
      documentDigest(input.taskBytes) !== input.card.facts['taskDigest']
      || documentDigest(input.submissionBytes) !== input.card.record.digest
    ) return refused('sealed-document-mismatch', false, noCapability, basePolicy);
    task = TaskSpecificationSchema.parse(parseExact(input.taskBytes));
    submission = SubmissionRecordSchema.parse(parseExact(input.submissionBytes));
  } catch {
    return refused('sealed-document-mismatch', false, noCapability, basePolicy);
  }

  const taskDigest = documentDigest(input.taskBytes);
  if (
    submission.task.digest?.sha256 !== taskDigest.slice('sha256:'.length)
    || submission.submission !== input.card.chain.submission
    || submission.nonce !== input.card.chain.nonce
    || task.profile.uri !== input.card.facts['taskProfileUri']
  ) return refused('sealed-document-mismatch', false, noCapability, policyEvidence(input, task.profile.uri, submission.deadline));

  const requirements = mergeRequirements(task.requirements ?? {}, submission.requirements ?? {});
  if (requirements === undefined) {
    return refused('sealed-document-mismatch', false, noCapability, policyEvidence(input, task.profile.uri, submission.deadline));
  }
  const advertisedRequirements = input.card.facts['requirements'];
  if (
    advertisedRequirements !== undefined
    && (
      typeof advertisedRequirements !== 'object'
      || advertisedRequirements === null
      || Array.isArray(advertisedRequirements)
      || !equalCanonical(requirements, advertisedRequirements)
    )
  ) return refused('sealed-document-mismatch', false, noCapability, policyEvidence(input, task.profile.uri, submission.deadline));

  const mapped = mapAnnouncedSubmissionToFacts(input.card, {
    acceptLegacyCards: false,
    estimateAiUnits: () => 0,
  });
  if (!mapped.ok) return refused('sealed-document-mismatch', false, noCapability, basePolicy);
  const facts: SubmissionFacts = { ...mapped.facts, requirements };
  const policy = validatePolicy(input, facts, submission.deadline);
  if (!policy.ok) {
    return refused(policy.reason!, policy.retryable ?? false, noCapability, policy);
  }

  const capability = await evaluateCapability(
    input,
    facts,
    task.outputs.filter((output) => output.required).map((output) => output.mediaType),
  );
  if (!capability.ok) {
    return refused(capability.reason!, capability.retryable ?? false, capability, policy);
  }
  return { ok: true, facts, capability: { ...capability, ok: true }, policy: { ...policy, ok: true } };
}
