/**
 * The bridge — legacy facts cards and legacy-evaluator-parseable deliveries (cutover stage 1,
 * Task 15). See `docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md` Task 15 and
 * coordinator amendment 4 (D3 ratified): a namespaced `deliveryExtensions` hook on
 * `LocalTaskExecutionBackendConfig` (permitted by `DeliveryRecordSchema`'s `.loose()` and TEP
 * §21.3) plus a read-path preference in the mech adapter. Retires with `legacyManifestDigest`
 * after stage 5.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RECORD_KINDS_SUBMISSION, type AnnouncedSubmissionCard } from '@jinn-network/marketplace-pipeline';
import { documentDigest } from '@jinn-network/task-execution-protocol';
import { REPOSITORY_WORK_PROFILE_URI } from '@jinn-network/task-execution-profiles';
import type { HarvestResult } from '@jinn-network/task-execution-workspace';
import { keccak256 } from 'viem';
import { canonicalJson } from '../harnesses/engine/canonical-json.js';
import type { SignedTaskV1 } from '../types/task-document.js';

export const LEGACY_ENVELOPE_EXTENSION_KEY =
  'https://jinn.network/bridge/legacy-execution-envelope/1.0';

/** Deterministic `urn:uuid:`-shaped identifier derived from a digest's first 16 bytes. */
function uuidFromDigest(digest: `0x${string}` | `sha256:${string}`): `urn:uuid:${string}` {
  const hex = digest.replace(/^(0x|sha256:)/u, '').padEnd(32, '0').slice(0, 32);
  const groups = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ];
  return `urn:uuid:${groups.join('-')}`;
}

/** The projector's synthesized submission card for a legacy-posted task (contract 9). */
export function synthesizeLegacyFactsCard(anchored: {
  readonly taskId: bigint;
  readonly manifestDigest: string;
  readonly taskCidDigest: `0x${string}`;
  readonly taskBytes: Uint8Array;
  readonly solutionBudgetWei: bigint;
}): AnnouncedSubmissionCard {
  const taskDigest = documentDigest(anchored.taskBytes);
  return {
    record: { kind: RECORD_KINDS_SUBMISSION, digest: taskDigest },
    facts: {
      taskDigest,
      // A legacy-posted task carries no sealed Submission and therefore no profile URI; the
      // bridge names the repository-work profile the legacy harnesses always ran under.
      //
      // E39 (diagnose→fix cycle 2): this used to hardcode a stale/misremembered URI
      // ('.../profiles/task-execution/repository-work/1.0') that doesn't match the real
      // `REPOSITORY_WORK_PROFILE_URI` every backend actually registers
      // ('.../task-profiles/repository-work/1.0') -- `verifyPreclaim`'s
      // `capabilities.taskProfiles.includes(facts.profileUri)` check never matched, so every
      // legacy-bridged card was declined `profile-mismatch` regardless of backend capability.
      taskProfileUri: REPOSITORY_WORK_PROFILE_URI,
      requirements: {},
    },
    chain: {
      taskId: anchored.taskId,
      // Legacy tasks have no Submission UUID; the bridge derives a stable one from the anchor.
      submission: uuidFromDigest(anchored.taskCidDigest),
      nonce: anchored.taskCidDigest,
      intendedSpendWei: anchored.solutionBudgetWei,
    },
    derivationKind: 'legacy',
    legacyManifestDigest: anchored.manifestDigest,
  };
}

/**
 * The projector's synthesized bridge Submission-equivalent for a legacy-posted task (finding
 * E32, ruling E32). A `today`-mode `CreatorLoop` posts the older `SignedTaskV1` document
 * directly on-chain -- there is no separate sealed TEP Submission wrapping it. Per the
 * composition spec §10 "Bridge-era document rules" and program cross-plan contract 9, until
 * stage 3 the projector SYNTHESIZES the Submission-equivalent from the resolved SignedTaskV1
 * bytes themselves under a `legacy` derivation annotation -- the same annotation contract
 * `synthesizeLegacyFactsCard` above already established for `AnnouncedSubmissionCard`
 * (`derivationKind`/`legacyManifestDigest`, Task 5/15).
 *
 * Unlike the sealed-Submission path, there is no separate Submission→Task indirection to join:
 * the resolved bytes ARE the Task content, so `taskDigest` is the digest of the exact bytes
 * passed in (the caller still cross-checks this against the on-chain anchor -- this function
 * does not, so it stays a pure synthesis step), and `submission` is a stable synthetic UUID
 * derived from that same digest (mirrors `synthesizeLegacyFactsCard`'s
 * `uuidFromDigest(anchored.taskCidDigest)` above).
 *
 * Retires with the `legacyManifestDigest` bridge after stage 5 (contract 9): once the legacy
 * `CreatorLoop` posts sealed TEP Submissions, `resolveTaskProjection` resolves a real Submission
 * on its first attempt and never reaches this fallback.
 */
export function synthesizeLegacyTaskProjection(input: {
  readonly task: SignedTaskV1;
  readonly taskBytes: Uint8Array;
}): {
  readonly submission: `urn:uuid:${string}`;
  readonly taskDigest: `sha256:${string}`;
  readonly effectiveDeadline: string;
} {
  const taskDigest = documentDigest(input.taskBytes);
  return {
    submission: uuidFromDigest(taskDigest),
    taskDigest,
    effectiveDeadline: new Date(input.task.window.endTs * 1000).toISOString(),
  };
}

/** Reads the bridge annotation off sealed Delivery bytes. `undefined` when absent. */
export function legacyRestorationResultFromDelivery(
  sealedDeliveryBytes: Uint8Array,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sealedDeliveryBytes));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const value = (parsed as Record<string, unknown>)[LEGACY_ENVELOPE_EXTENSION_KEY];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Builds and signs the `jinn.execution.v1` envelope the legacy evaluator expects.
 *
 * PLAN-VS-CODE GAP: the plan's declared input (`solverType`/`participant`/`harness`/`harvest`/
 * `outputsRoot`/`startedAt`/`endedAt`/`sign`) carries none of the on-chain task-provenance data
 * (`cid`/`onchainCreationTx`/`onchainCreationBlock`/`requestId`) that
 * `packages/core/src/execution-envelope.ts`'s `TaskProvenanceSchema` requires for a `role:
 * 'solution'` envelope, and no per-solverType "declared output slot" lookup is reachable from
 * this function's write scope (that lives in the solver-types registry, out of Task 15's write
 * scope). Bridge-era stand-ins are used for those fields below, each commented at the point of
 * use — this envelope is consumed by the legacy evaluator's `SignedEnvelopeSchema` (a shape
 * check, not an on-chain re-verification of task provenance), so a schema-valid placeholder does
 * not weaken the evaluator's actual correctness check, which reads `payload`.
 *
 * Cutover stage 1 close-out C7 (finding E24) closed part of this gap: `requestId` is now an
 * optional input, honestly supplied by `composition-root.ts`'s `deliveryExtensions` hook from the
 * C7 workKind seam (`LocalTaskExecutionBackend.noteAttemptWorkKind`) for today-generation claims.
 * `onchainCreationTx`/`onchainCreationBlock` remain placeholders -- C7's seam carries an attempt's
 * workKind and (today-generation) requestId, neither of which is the task's own on-chain creation
 * tx/block; `AnnouncedSubmissionCard` (`packages/marketplace/pipeline/src/facts-mapper.ts`) carries
 * no such field either, so this genuinely remains unreachable from the daemon's write scope.
 */
export function buildLegacyExecutionEnvelope(input: {
  readonly solverType: string;
  readonly participant: `0x${string}`;
  readonly harness: string;
  readonly harvest: HarvestResult;
  readonly outputsRoot: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly sign: (hash: `0x${string}`) => `0x${string}`;
  /** Today-generation marketplace requestId, when honestly available (C7 workKind seam). */
  readonly requestId?: `0x${string}`;
}): { readonly json: string; readonly evidenceHash: `0x${string}` } {
  const payload = readPrimaryOutputPayload(input.outputsRoot, input.harvest);
  const generatedAt = Date.parse(input.endedAt);
  const startTs = Math.floor(Date.parse(input.startedAt) / 1000);
  const endTs = Math.floor(Date.parse(input.endedAt) / 1000);
  const outputsDigest = documentDigest(new TextEncoder().encode(JSON.stringify(payload)));

  const unsigned = {
    schemaVersion: 'jinn.execution.v1' as const,
    solverType: input.solverType,
    role: 'solution' as const,
    generatedAt: Number.isFinite(generatedAt) ? generatedAt : Date.now(),
    task: {
      // Bridge-era stand-ins (see function doc): this hook has no on-chain creation tx/block for
      // the attempt it is sealing a Delivery for. `cid` carries the harvest-output digest so the
      // field is at least deterministic per-attempt, not a constant.
      cid: outputsDigest,
      onchainCreationTx: '0x' as const,
      onchainCreationBlock: 0,
      requestId: input.requestId ?? ('0x' as const),
    },
    participant: { safeAddress: input.participant, agentEoa: input.participant },
    window: { startTs: Number.isFinite(startTs) ? startTs : 0, endTs: Number.isFinite(endTs) ? endTs : 0 },
    executor: {
      implName: input.harness,
      implVersion: '0.0.0-bridge',
      clientGitSha: 'bridge',
      codeDigest: outputsDigest,
      runtimeBundleDigest: outputsDigest,
      plugins: [],
      signingKey: { kind: 'agent-eoa' as const, pubkey: input.participant },
      mode: 'train' as const,
    },
    evidenceTier: 'self-signed' as const,
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload,
  };

  const canonical = canonicalJson(unsigned);
  const evidenceHash = keccak256(new TextEncoder().encode(canonical));
  const sig = input.sign(evidenceHash);

  const signed = {
    ...unsigned,
    signature: {
      algo: 'secp256k1' as const,
      signer: input.participant,
      hash: evidenceHash,
      sig,
    },
  };

  return { json: JSON.stringify(signed), evidenceHash };
}

/**
 * Reads the first harvested output's bytes (relative to `outputsRoot`) and parses them as JSON
 * when the manifest declares a JSON media type; otherwise wraps the decoded text. Empty manifest
 * yields an empty payload object.
 */
function readPrimaryOutputPayload(outputsRoot: string, harvest: HarvestResult): Record<string, unknown> {
  const primary = harvest.manifest[0];
  if (primary === undefined) return {};
  try {
    const bytes = readFileSync(join(outputsRoot, primary.path));
    if (primary.mediaType === 'application/json' || primary.mediaType === undefined) {
      const parsed: unknown = JSON.parse(bytes.toString('utf-8'));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    }
    return { raw: bytes.toString('utf-8') };
  } catch {
    return {};
  }
}
