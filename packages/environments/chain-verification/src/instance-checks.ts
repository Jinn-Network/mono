// SPDX-License-Identifier: Apache-2.0

import type {
  ChainEnvironmentRecord,
  VerifiedChainInstance,
} from "@jinn-network/chain-environment-record";
import type { Sha256Digest } from "@jinn-network/trust-core";

import {
  assessArtifactCoverage,
  type CoverageAssessment,
  type FixtureMutationDeclaration,
} from "./coverage.js";
import { fromDigestSet, type DigestSet } from "./digests.js";
import { conformanceFailure, invalidInput } from "./errors.js";
import type { EnvironmentObservation } from "./predicate.js";
import type { ResolutionResult } from "./resolve.js";
import type {
  ChainVerificationFailureReason,
} from "./outcomes.js";

function asDigestSet(digest: unknown): DigestSet {
  const sha256 = (digest as { sha256?: string }).sha256;
  if (sha256 === undefined) {
    invalidInput("descriptor digest.sha256 is required.");
  }
  return { sha256 };
}

function fixtureCoverageManifestDigest(record: ChainEnvironmentRecord): Sha256Digest {
  const manifest = record.stateMaterialization.fixtureCoverage?.manifest;
  if (manifest === undefined) {
    invalidInput("fixtureCoverage.manifest is absent on this record.");
  }
  return fromDigestSet(asDigestSet(manifest.digest));
}

interface FixtureCoverageDocument {
  readonly format?: string;
  readonly declarations: readonly FixtureMutationDeclaration[];
}

function decodeFixtureCoverageDocument(
  resolution: Extract<ResolutionResult, { ok: true }>,
  record: ChainEnvironmentRecord,
): FixtureCoverageDocument {
  const bytes = resolution.bytes.get(fixtureCoverageManifestDigest(record));
  if (bytes === undefined) {
    conformanceFailure(
      "Resolved fixture-coverage manifest bytes are missing from the resolution map.",
    );
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as FixtureCoverageDocument;
}

export function declaredFixtureAccounts(record: ChainEnvironmentRecord): readonly string[] {
  const accounts = new Set<string>();
  for (const fixture of record.fixtures.accounts) accounts.add(fixture.address);
  for (const role of record.capabilityEnvelope.signerRoles) {
    for (const address of role.accounts) accounts.add(address);
  }
  return [...accounts];
}

export function declaredFixtureMutations(
  record: ChainEnvironmentRecord,
  resolution: Extract<ResolutionResult, { ok: true }>,
): readonly FixtureMutationDeclaration[] {
  if (record.stateMaterialization.fixtureCoverage?.manifest === undefined) {
    return [];
  }
  return decodeFixtureCoverageDocument(resolution, record).declarations;
}

export function checkRuntimeIdentity(
  record: ChainEnvironmentRecord,
  verified: VerifiedChainInstance,
): { readonly reason: ChainVerificationFailureReason; readonly detail: string } | undefined {
  const declared = record.runtime;
  const observed = verified.report.runtimeIdentity;
  if (observed.imageManifestDigest !== declared.image.manifestDigest) {
    return {
      reason: "runtime-image-mismatch",
      detail: `image manifest ${observed.imageManifestDigest} does not match ${declared.image.manifestDigest}`,
    };
  }
  if (observed.binaryDigest !== declared.binary.digest) {
    return {
      reason: "runtime-image-mismatch",
      detail: `binary digest ${observed.binaryDigest} does not match ${declared.binary.digest}`,
    };
  }
  if (observed.reportedVersion !== declared.version) {
    return {
      reason: "runtime-version-mismatch",
      detail: `reported ${observed.reportedVersion}, record declares ${declared.version}`,
    };
  }
  if (observed.chainId !== declared.evm.sandboxChainId) {
    return {
      reason: "runtime-chain-id-mismatch",
      detail: `sandbox chain id ${observed.chainId} does not match ${declared.evm.sandboxChainId}`,
    };
  }
  if (observed.unsupportedControls.length > 0) {
    return {
      reason: "determinism-control-unsupported",
      detail: observed.unsupportedControls.join(", "),
    };
  }
  return undefined;
}

export function checkSourceAnchor(
  record: ChainEnvironmentRecord,
  verified: VerifiedChainInstance,
): { readonly reason: ChainVerificationFailureReason; readonly detail: string } | undefined {
  const anchor = record.sourceAnchor;
  if (anchor === undefined) return undefined;
  if (verified.report.runtimeIdentity.chainId !== anchor.nativeChainId) {
    return {
      reason: "anchor-block-mismatch",
      detail: `runtime chain id ${verified.report.runtimeIdentity.chainId} does not match anchor ${anchor.nativeChainId}`,
    };
  }
  const observedRoot = verified.report.runtimeIdentity.appliedControls.anchorStateRoot;
  if (observedRoot !== undefined && observedRoot !== anchor.stateRoot) {
    return {
      reason: "anchor-root-mismatch",
      detail: `runtime anchor root ${observedRoot} does not match record ${anchor.stateRoot}`,
    };
  }
  return undefined;
}

export function buildEnvironmentObservation(
  record: ChainEnvironmentRecord,
  identity: VerifiedChainInstance | undefined,
  coverage: CoverageAssessment | undefined,
): EnvironmentObservation {
  const report = identity?.report;
  const envelope = record.capabilityEnvelope;
  const anchor = record.sourceAnchor === undefined
    ? undefined
    : {
      caip2: record.sourceAnchor.caip2ChainId,
      chainId: record.sourceAnchor.nativeChainId,
      blockNumber: String(record.sourceAnchor.blockNumber),
      blockHash: record.sourceAnchor.blockHash,
      stateRoot: record.sourceAnchor.stateRoot,
      timestamp: String(record.sourceAnchor.timestamp),
      finalityPolicy: record.sourceAnchor.finalityPolicy,
      authenticity: record.sourceAnchor.headerProof === undefined
        ? "declared" as const
        : "header-proven" as const,
    };
  const controls: Record<string, string> = report === undefined
    ? {
      miningMode: record.determinismControls.miningMode,
      orderingPolicy: record.determinismControls.orderingPolicy,
      resetMechanism: record.determinismControls.resetMechanism,
    }
    : { ...report.runtimeIdentity.appliedControls };
  return {
    closureClass: record.stateMaterialization.closureClass,
    fidelityClass: record.stateMaterialization.fidelityClass,
    ...(anchor === undefined ? {} : { anchor }),
    runtime: {
      family: record.runtime.family,
      version: record.runtime.version,
      imageManifestDigest: report?.runtimeIdentity.imageManifestDigest
        ?? record.runtime.image.manifestDigest,
      platform: report?.runtimeIdentity.platform ?? record.runtime.image.platform,
      binaryDigest: report?.runtimeIdentity.binaryDigest ?? record.runtime.binary.digest,
      reportedVersion: report?.runtimeIdentity.reportedVersion ?? record.runtime.version,
      evmConfigurationDigest: report?.runtimeIdentity.evmConfigurationDigest
        ?? record.runtime.binary.digest,
      chainId: report?.runtimeIdentity.chainId ?? record.runtime.evm.sandboxChainId,
    },
    postFixtureCommitment: report?.postFixtureCommitment
      ?? record.stateMaterialization.initialStateCommitment,
    controls,
    envelope: {
      rpcAllowlist: {
        read: [...envelope.rpc.readMethods],
        stateChanging: [...envelope.rpc.stateChangingMethods],
      },
      signerRoles: envelope.signerRoles.map((role) => role.role),
      permittedChainId: envelope.permittedChainId,
      maxima: {
        maxTransactions: String(envelope.limits.maxTransactions),
        maxAggregateGas: envelope.limits.maxAggregateGas,
        maxExecutionDurationMs: String(envelope.limits.maxExecutionDurationMs),
      },
      egressPolicyId: envelope.egressPolicyId,
    },
    ...(record.stateMaterialization.fidelityClass === "local"
      ? {}
      : {
        coverage: coverage?.applicable
          ? {
            proofCovered: coverage.proofCovered,
            fixtureDeclared: coverage.fixtureDeclared,
            uncovered: coverage.uncovered,
            mutatesSourceProtocolState:
              record.stateMaterialization.mutatesSourceProtocolState ?? false,
          }
          : {
            proofCovered: 0,
            fixtureDeclared: 0,
            uncovered: 0,
            mutatesSourceProtocolState:
              record.stateMaterialization.mutatesSourceProtocolState ?? false,
          },
      }),
  };
}
