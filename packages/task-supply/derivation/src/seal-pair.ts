// SPDX-License-Identifier: Apache-2.0

import {
  REPOSITORY_WORK_PROFILE_URI,
  buildRepositoryWorkProfile,
  sealEvaluationSpec,
  sealTaskProfile,
  sweRebenchRowToTaskAndSpec,
  type DeterministicProcessBlock,
  type EvaluationSpec,
  type SweRebenchRow,
} from "@jinn-network/task-execution-profiles";
import { TASK_EXECUTION_PROTOCOL_URI, sealTask } from "@jinn-network/task-execution-protocol";
import type { Candidate } from "./candidate.js";
import { assertPrefixedDigest, documentDigest, toBareHex, type Sha256Digest } from "./digest.js";
import {
  ENVIRONMENT_RECORD_EXTENSION_KEY,
  buildEnvironmentRecordExtension,
} from "./environment-extension.js";
import { DerivationError } from "./errors.js";
import { computeSourceCommitment } from "./source-commitment.js";
import type { DerivationEnvironment } from "./strategy.js";

export interface SealedEvaluationSpec {
  readonly document: EvaluationSpec;
  readonly bytes: Uint8Array;
  readonly digest: Sha256Digest;
}

export interface SealedTask {
  readonly bytes: Uint8Array;
  readonly digest: Sha256Digest;
}

/**
 * The row handed to the profiles mapper, with `image` and `parser` taken from the
 * environment record rather than from upstream. Because the record is the only source for
 * those fields, the pair that comes out cannot disagree with the record it cites
 * (design §7.1's inline-match rule holds by construction, not by a later check).
 */
function recordAlignedRow(candidate: Candidate, env: DerivationEnvironment): SweRebenchRow {
  const { record } = env;
  return {
    instance_id: candidate.provenance.upstream.instanceId,
    repo: record.source.repo,
    base_commit: record.source.commit,
    problem_statement: candidate.statement,
    language: candidate.language,
    image: {
      name: "environment-image",
      // The DigestSet is the identity and is always written. `reference` is an optional
      // advisory pull hint (§4.2, required to end with `@<manifestDigest>`), so it is copied
      // only when the record carries one — a record without it is well-formed, the descriptor
      // still has a locator (protocol `resourceDescriptorHasLocator`), and C3's inline match
      // resolves the manifest digest from the DigestSet. Nothing is invented either way.
      ...(record.image.reference === undefined ? {} : { uri: record.image.reference }),
      digest: { sha256: toBareHex(record.image.manifestDigest, "record image.manifestDigest") },
    },
    testMaterial: candidate.testMaterial.map((material) => ({
      name: material.name,
      mediaType: material.mediaType,
      content: material.content,
      digest: { sha256: toBareHex(material.digest, `test material "${material.name}" digest`) },
    })),
    // ParserIdentitySchema is strict (no extra keys): the record's advisory `uri`
    // acquisition hint is deliberately dropped here — the digest is what binds.
    parser: {
      id: record.parser.id,
      version: record.parser.version,
      digest: assertPrefixedDigest(record.parser.digest, "record parser.digest"),
    },
    transitions: {
      failToPass: [...candidate.transitions.failToPass],
      passToPass: [...candidate.transitions.passToPass],
    },
    timeout: candidate.timeout,
  };
}

/**
 * Builds and seals the candidate's EvaluationSpec. Reuses the profiles mapper for the
 * family-block body (including its `accessClass: "public"` stamping, D5), then overlays
 * the record's platform — the mapper hardcodes `linux/amd64`, planning Finding (d) — and
 * the namespaced environment-record key (§7.2).
 */
export function buildCandidateEvaluationSpec(
  candidate: Candidate,
  env: DerivationEnvironment,
): SealedEvaluationSpec {
  const mapped = sweRebenchRowToTaskAndSpec(recordAlignedRow(candidate, env));
  const baseBlock = mapped.evaluationSpec.familyBlock as DeterministicProcessBlock;

  const familyBlock = {
    ...baseBlock,
    platform: env.record.image.platform,
    [ENVIRONMENT_RECORD_EXTENSION_KEY]: buildEnvironmentRecordExtension(env.recordDigest),
  };

  const document: EvaluationSpec = { ...mapped.evaluationSpec, familyBlock };
  const { bytes, digest } = sealEvaluationSpec(document);
  return { document, bytes, digest };
}

/**
 * Builds and seals the Task around an already-sealed EvaluationSpec digest (the spec is
 * sealed strictly first; the Task only ever references it by digest, design §7).
 *
 * `inputs` and `payload` are built here rather than taken from the mapper: the record is
 * authoritative for the repository locator, and the payload carries two fields the mapper
 * does not write — `provenance.sourceCommitment` (§7.2) and `rights.sourceLicense` (D12,
 * planning Finding (c)).
 */
export function buildSealedTask(
  candidate: Candidate,
  env: DerivationEnvironment,
  evaluationSpecDigest: string,
): SealedTask {
  const profile = buildRepositoryWorkProfile();
  const profileDigest = sealTaskProfile(profile).digest;

  const outputs = profile.outputConventions.slots.map((slot) => {
    if (slot.mediaType === undefined) {
      throw new DerivationError(
        "invalid-input",
        `repository-work output slot "${slot.name}" declares no mediaType.`,
      );
    }
    return { name: slot.name, mediaType: slot.mediaType, required: slot.required };
  });

  const task = {
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: {
      uri: REPOSITORY_WORK_PROFILE_URI,
      digest: { sha256: toBareHex(profileDigest, "repository-work profile digest") },
    },
    instructions: candidate.statement,
    payload: {
      instance_id: candidate.provenance.upstream.instanceId,
      language: candidate.language,
      provenance: {
        kind: candidate.provenance.kind,
        sourceCommitment: computeSourceCommitment(candidate.provenance.upstream, candidate.statement),
      },
      rights: { sourceLicense: candidate.rights.sourceLicense },
    },
    inputs: [
      {
        name: "repository-state",
        uri: env.record.source.repoUrl,
        annotations: { ref: env.record.source.commit },
      },
    ],
    outputs,
    evaluation: {
      digest: { sha256: toBareHex(evaluationSpecDigest, "evaluation spec digest") },
    },
  };

  const bytes = sealTask(task);
  return { bytes, digest: documentDigest(bytes) };
}
