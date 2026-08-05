// Production evaluator deployment module for the native evaluator role host's
// `prediction-market` registration (client/src/daemon/native-evaluator-composition.ts).
//
// Operational path and the config wiring this module requires:
//   docs/operator/native-evaluator-deployment.md
//
// Digest stability (the identity-parameterization design, see the doc above for the
// full rationale). This file's own bytes never vary by operator or by deployment --
// every value below is a fixed literal except the evaluator's own persistent Agent IRI.
// That identity is inherently unique per deployment, so it cannot be a literal in a
// digest-pinned file; it is read from JINN_NATIVE_EVALUATOR_AGENT at import time,
// never hardcoded here and never read from Task material. One published `moduleDigest`
// therefore stays valid for every operator running this exact release -- only the
// env var (and the matching `evaluator.agent`/`operator.native.agent` config value)
// differ per operator.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  contextResolutionSnapshotSource,
  createPredictionEvaluatorRegistration,
  evaluatorAdaptersParserAllowlist,
} from '@jinn-network/task-execution-evaluator-adapters';
import { createFilesystemEvidenceRepository } from '@jinn-network/evidence-repository/fs';

const HERE = dirname(fileURLToPath(import.meta.url));

// A fixed logical handle, not a secret. Operators copy this literal into
// `evaluator.signerHandle` in native-config.json; the composition layer cross-checks
// the two are equal before trusting this deployment.
const SIGNER_HANDLE = 'prediction-market-evaluator-verdict';

// Generous headroom over the adapter's current zero-evidence behavior (see the
// evaluation-method descriptor's "evidence" field) -- large enough for a future
// adapter revision that attaches a modest claim-evidence attachment, small enough to
// bound a single evaluator claim.
const MAX_CLAIM_EVIDENCE_BYTES = 65_536;

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`prediction-market-deployment.mjs requires ${name} to be set`);
  }
  return value;
}

// The evaluation-method descriptor is hashed live, from the sibling file, rather than
// embedding a hardcoded hex digest -- the published `evaluationMethod.digest.sha256`
// can never drift out of sync with the descriptor document it describes.
function evaluationMethodDescriptorDigestHex() {
  const bytes = readFileSync(join(HERE, 'prediction-market-evaluation-method.v1.json'));
  return createHash('sha256').update(bytes).digest('hex');
}

const evaluatorId = requiredEnv('JINN_NATIVE_EVALUATOR_AGENT');
const claimEvidenceRoot = (process.env.JINN_NATIVE_EVALUATOR_CLAIM_EVIDENCE_DIR ?? '').trim()
  || join(homedir(), '.jinn-client', 'native-evaluator', 'claim-evidence');

const repository = await createFilesystemEvidenceRepository({ rootDir: claimEvidenceRoot });

/**
 * Durable, content-addressed claim-evidence writer. Every write is persisted under
 * `claimEvidenceRoot` (filesystem evidence repository: sha256-addressed objects,
 * fsync + atomic publish -- see `@jinn-network/evidence-repository`'s `fs` store),
 * matching the durability pattern the rest of the native evaluator host uses for its
 * own evidence (`client/src/daemon/evidence-join.ts`).
 */
const evidenceWriter = {
  async putClaimEvidence({ name, bytes, mediaType }) {
    const receipt = await repository.putArtifact(bytes);
    return {
      name,
      digest: { sha256: receipt.reference.digest.slice('sha256:'.length) },
      ...(mediaType === undefined ? {} : { mediaType }),
    };
  },
};

const registration = createPredictionEvaluatorRegistration({
  evaluatorId,
  signerHandle: SIGNER_HANDLE,
  evaluationMethod: {
    name: 'jinn-prediction-market-evaluator-v1',
    uri: 'https://jinn.network/evaluation-methods/prediction-market/1.0',
    digest: { sha256: evaluationMethodDescriptorDigestHex() },
  },
  resolutionSnapshotSource: contextResolutionSnapshotSource(),
});

export const evaluationHarnessDeployment = Object.freeze({
  registrations: [registration],
  parserAllowlist: evaluatorAdaptersParserAllowlist(),
  evidenceWriter,
  maxClaimEvidenceBytes: MAX_CLAIM_EVIDENCE_BYTES,
});
