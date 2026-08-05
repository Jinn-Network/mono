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
// digest-pinned file. It is read from a per-operator SIDECAR FILE next to this module
// (`prediction-market-deployment.local.json`, resolved via `import.meta.url`), never
// hardcoded here and never read from Task material.
//
// Why a sidecar file and not an environment variable: this module is imported twice --
// once by the daemon (parent) process, and once more by the evaluation-harness child
// process the daemon SPAWNS for every attempt (`makeEvaluationLauncher`'s launch plan
// forwards a fixed, small env allowlist -- see
// `packages/task-execution/backend-local/workspace/src/dir-provisioner.ts`'s
// `executionEnv()` -- that allowlist has no slot for an arbitrary operator env var, so
// nothing named here would ever reach the child). A file next to this module on disk,
// by contrast, is visible to both processes identically: the child imports this exact
// same absolute module path (see `deploymentFromEnvironment()` in
// `packages/task-execution/evaluation-harness/src/runtime.ts`), and dynamic `import()`
// is not sandboxed to the spawned attempt's workspace directory.
//
// Why NOT also (or instead) an `os.homedir()`-based location outside the package tree
// (which would survive an `npm install -g` upgrade replacing this directory -- see
// docs/operator/native-evaluator-deployment.md's upgrade callout for how that's handled
// instead): `os.homedir()` reads `$HOME`, and the daemon (parent) and the spawned child
// do NOT necessarily agree on it. The child's env is reconstructed from the launcher's
// small fixed allowlist above, which never forwards `HOME` -- so if the daemon process
// ever runs with an overridden `HOME` (a containerized deployment, a systemd unit with
// `Environment=HOME=...`, this repo's own test suite, which isolates `HOME` per test
// file -- see `client/test/_support/isolate-home.ts`), the child's `os.homedir()` falls
// back to the OS user database and silently resolves somewhere ELSE. That reintroduces
// exactly the class of bug this whole design avoids: a value visible to the parent that
// isn't identically visible to the child. Only a location derived from this file's own
// `import.meta.url` is structurally guaranteed identical for both processes.
//
// Identity is still enforced where it must be. The parent composition
// (`native-evaluator-composition.ts`) cross-checks this module's declared
// `evaluatorIdentity.id` against the trusted `operator.native.agent` config value on
// every construction -- a sidecar naming the wrong agent means the daemon never boots
// the evaluator role at all. And even a sidecar that differs ONLY for the spawned child
// (compromised or misconfigured independently of the parent) cannot forge a trusted
// verdict: the verdict statement's `evaluator.id` comes from this same registration, and
// the parent's harvest step separately requires `predicate.evaluator.id === roles.agent`
// before it will seal and publish anything (`native-evaluator-composition.ts`'s
// `stateBackedProvisioner` harvest contract).
//
// Once read (at import), this value is not re-read for the lifetime of the process --
// editing the sidecar file requires restarting the daemon (and any in-flight spawned
// attempts pick up the edit on their own next process, since they import fresh). It is
// also NOT upgrade-safe on its own: `npm install -g @jinn-network/client@latest`
// replaces this whole directory, deleting the sidecar with it. See
// docs/operator/native-evaluator-deployment.md's upgrade callout -- re-run the
// create-sidecar step after every version bump.
//
// The sidecar is deliberately NOT part of `moduleDigest`: `moduleDigest` pins this
// file's logic, which is identical for every operator; the sidecar carries only the
// per-operator parameters (identity, evidence root), the same relationship
// `native-config.json` itself already has to the rest of the trusted deployment. It is
// NEVER git-committed (this repo's `.gitignore`) or published in the npm tarball
// (`client/package.json`'s negated `files` entry -- a `.gitignore` rule alone does not
// exclude a files-array-included path from `npm pack`/`npm publish`).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  contextResolutionSnapshotSource,
  createPredictionEvaluatorRegistration,
  PREDICTION_PARSER,
} from '@jinn-network/task-execution-evaluator-adapters';
import { parserAllowlistKey } from '@jinn-network/task-execution-profiles';
import { createFilesystemEvidenceRepository } from '@jinn-network/evidence-repository/fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIDECAR_PATH = join(HERE, 'prediction-market-deployment.local.json');

// A fixed logical handle, not a secret. Operators copy this literal into
// `evaluator.signerHandle` in native-config.json; the composition layer cross-checks
// the two are equal before trusting this deployment.
const SIGNER_HANDLE = 'prediction-market-evaluator-verdict';

// Generous headroom over the adapter's current zero-evidence behavior (see the
// evaluation-method descriptor's "evidence" field) -- large enough for a future
// adapter revision that attaches a modest claim-evidence attachment, small enough to
// bound a single evaluator claim.
const MAX_CLAIM_EVIDENCE_BYTES = 65_536;

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readSidecar() {
  let bytes;
  try {
    bytes = readFileSync(SIDECAR_PATH);
  } catch (cause) {
    throw new Error(
      `prediction-market-deployment.mjs requires a per-operator sidecar file at `
      + `${SIDECAR_PATH} (see docs/operator/native-evaluator-deployment.md): ${String(cause?.message ?? cause)}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error(`${SIDECAR_PATH} is not valid UTF-8 JSON: ${String(cause?.message ?? cause)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${SIDECAR_PATH} must contain a JSON object`);
  }
  const agent = trimmedString(parsed.agent);
  if (agent.length === 0) {
    throw new Error(`${SIDECAR_PATH} must declare a non-empty "agent" (the evaluator's persistent Agent IRI)`);
  }
  if (parsed.claimEvidenceDir !== undefined && typeof parsed.claimEvidenceDir !== 'string') {
    throw new Error(`${SIDECAR_PATH}'s "claimEvidenceDir", if present, must be a string`);
  }
  const claimEvidenceDir = trimmedString(parsed.claimEvidenceDir);
  return { agent, claimEvidenceDir: claimEvidenceDir.length === 0 ? undefined : claimEvidenceDir };
}

// The evaluation-method descriptor is hashed live, from the sibling file, rather than
// embedding a hardcoded hex digest -- the published `evaluationMethod.digest.sha256`
// can never drift out of sync with the descriptor document it describes.
function evaluationMethodDescriptorDigestHex() {
  const bytes = readFileSync(join(HERE, 'prediction-market-evaluation-method.v1.json'));
  return createHash('sha256').update(bytes).digest('hex');
}

const sidecar = readSidecar();
const evaluatorId = sidecar.agent;
// Same `os.homedir()` divergence risk as the identity lookup above applies to this
// DEFAULT, unless the sidecar sets `claimEvidenceDir` explicitly (recommended -- see
// docs/operator/native-evaluator-deployment.md). Harmless today (the prediction
// adapter's `evaluate()` currently returns no `claimEvidence` entries, so this
// directory is created but never written to), but set `claimEvidenceDir` explicitly
// before a future adapter revision starts using it for real.
const claimEvidenceRoot = sidecar.claimEvidenceDir
  ?? join(homedir(), '.jinn-client', 'native-evaluator', 'claim-evidence');

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
    uri: 'https://spec.jinn.network/evaluation-methods/prediction-market/v1',
    digest: { sha256: evaluationMethodDescriptorDigestHex() },
  },
  resolutionSnapshotSource: contextResolutionSnapshotSource(),
});

// Narrowed to exactly the parser this deployment's single registration can serve. The
// deployment has no swe-rebench registration, so it declares no swe-rebench parser key.
export const evaluationHarnessDeployment = Object.freeze({
  registrations: [registration],
  parserAllowlist: new Set([parserAllowlistKey(PREDICTION_PARSER)]),
  evidenceWriter,
  maxClaimEvidenceBytes: MAX_CLAIM_EVIDENCE_BYTES,
});
