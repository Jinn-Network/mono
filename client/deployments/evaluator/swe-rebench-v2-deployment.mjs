// Production evaluator deployment module for the native evaluator role host's container-graded
// `swe-rebench-v2` registration (client/src/daemon/native-evaluator-composition.ts). It is the
// container-graded sibling of `prediction-market-deployment.mjs`; read that module's header first
// for the sidecar-identity and digest-stability design — everything there applies here unchanged.
//
// Operational path and the config wiring this module requires:
//   docs/operator/native-evaluator-deployment.md
//
// WHAT IS DIFFERENT FROM THE PREDICTION MODULE — the grader source is CONTAINER-GRADED, and this
// module is where "deployment-owned" is made concrete (#2467, Finding P0-5-A). A container grader
// runs an untrusted, digest-pinned image; the package's `containerGraderReportSource` composes the
// run request and reads what the container leaves on disk, but it never shells out — the concrete
// runtime is a live host object (`createDockerContainerRuntime`). A live host object cannot cross
// the boundary into the SPAWNED evaluation-harness child (`deploymentFromEnvironment()` in
// `packages/task-execution/evaluation-harness/src/runtime.ts` re-imports THIS module from scratch in
// the child; nothing from the parent's object graph reaches it). So the ONLY way the child gets a
// working grader source is for THIS module — imported identically by parent and child — to
// construct it. That is what "deployment-owned" means in the config: the composition binds this
// registration `deployment-owned` and leaves the module's own grader source in place, rather than
// substituting a host-supplied one (which it structurally cannot forward to the child).
//
// THE DOCKER DRIVER IS DAEMON CODE, PINNED BY DAEMON INTEGRITY — NOT BY moduleDigest. `moduleDigest`
// pins THIS file's bytes (its declared identity: registration set, evaluation-method identity,
// parser allowlist). The Docker driver
// (`createDockerContainerRuntime`, client/src/daemon/native-evaluator-container-runtime.js) is the
// security-critical execution substrate — the thing that bounds and confines the untrusted grader
// container. Per the M4 ruling on #2461 it is DAEMON code, pinned by whatever pins the installed
// daemon (release/canary build integrity), the same one mechanism that would already have to be
// subverted to swap the daemon itself. An attacker who can swap the driver can already swap the
// daemon — a strictly larger capability than swapping a deployment module — so the driver being
// trusted daemon code adds no attack surface. This module therefore IMPORTS the driver rather than
// inlining it: inlining the driver would fold security-critical, separately-reviewed code into these
// digest-pinned bytes, defeating its in-place reviewability without adding any real protection.
//
// OPTIONAL SIDECAR "dockerPath" (#2542) — the daemon spawns `docker` bare by default, which relies
// on the daemon process's inherited `PATH` containing it. That holds on most Linux hosts (`/usr/bin`
// or `/usr/local/bin` is normally on PATH) but not on macOS Docker Desktop, where the CLI lives at
// `/usr/local/bin/docker` and a daemon launched from, say, a login item or a service manager with a
// minimal PATH never finds it — `spawn docker ENOENT`. Rather than widen the spawned child's closed
// env allowlist to carry PATH through (a materially bigger trust surface for every other spawn in the
// stack, not just this one), the fix is operator-declared: an optional absolute `dockerPath` in this
// same per-operator sidecar, threaded into `createDockerContainerRuntime`'s `dockerPath` option. Unset
// (the default) preserves today's bare-`docker`-on-PATH behavior unchanged. A relative value is
// refused loudly at sidecar-read time — see `readSidecar()` — because the daemon (parent) and the
// spawned evaluation-harness child do not share a working directory, so a relative path would resolve
// to two different places (or nowhere) depending which process read the sidecar.
//
// WHY THE RELATIVE DIST PATH (`../../dist/daemon/...`), not a package specifier: `@jinn-network/client`
// ships no exports map, so `import('@jinn-network/client/...')` does not resolve. The published
// tarball ships both `deployments/` and `dist/`, so `../../dist/daemon/native-evaluator-container-runtime.js`
// resolves relative to this module in the parent daemon AND in the spawned child (both load this
// .mjs by its absolute path, so the relative specifier resolves identically for both). In a source
// checkout the driver must be built first (`yarn build`) — the module reads compiled daemon JS, not
// the .ts source.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  containerGraderReportSource,
  createSweRebenchEvaluatorRegistration,
  SWE_REBENCH_PARSER,
} from '@jinn-network/task-execution-evaluator-adapters';
import { parserAllowlistKey } from '@jinn-network/task-execution-profiles';
import { createFilesystemEvidenceRepository } from '@jinn-network/evidence-repository/fs';
import { createDockerContainerRuntime } from '../../dist/daemon/native-evaluator-container-runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIDECAR_PATH = join(HERE, 'swe-rebench-v2-deployment.local.json');

// A fixed logical handle, not a secret. Operators copy this literal into
// `evaluator.signerHandle` in native-config.json; the composition layer cross-checks the two are
// equal before trusting this deployment.
const SIGNER_HANDLE = 'swe-rebench-v2-evaluator-verdict';

// Headroom over the adapter's current claim-evidence behavior: the swe-rebench adapter attaches a
// tail-capped test log (default 1 MiB) as claim evidence. Sized to bound a single claim.
const MAX_CLAIM_EVIDENCE_BYTES = 4 * 1024 * 1024;

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readSidecar() {
  let bytes;
  try {
    bytes = readFileSync(SIDECAR_PATH);
  } catch (cause) {
    throw new Error(
      `swe-rebench-v2-deployment.mjs requires a per-operator sidecar file at `
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
  if (parsed.dockerPath !== undefined && typeof parsed.dockerPath !== 'string') {
    throw new Error(`${SIDECAR_PATH}'s "dockerPath", if present, must be a string`);
  }
  const dockerPathRaw = trimmedString(parsed.dockerPath);
  let dockerPath;
  if (dockerPathRaw.length > 0) {
    if (!isAbsolute(dockerPathRaw)) {
      throw new Error(
        `${SIDECAR_PATH}'s "dockerPath" must be an absolute path (got ${JSON.stringify(dockerPathRaw)}); `
        + 'a relative path is not portable between the daemon process and the spawned evaluation-harness '
        + 'child, which do not share a working directory',
      );
    }
    dockerPath = dockerPathRaw;
  }
  return {
    agent,
    claimEvidenceDir: claimEvidenceDir.length === 0 ? undefined : claimEvidenceDir,
    dockerPath,
  };
}

// The evaluation-method descriptor is hashed live, from the sibling file, so the published
// `evaluationMethod.digest.sha256` can never drift out of sync with the descriptor it describes.
function evaluationMethodDescriptorDigestHex() {
  const bytes = readFileSync(join(HERE, 'swe-rebench-v2-evaluation-method.v1.json'));
  return createHash('sha256').update(bytes).digest('hex');
}

const sidecar = readSidecar();
const evaluatorId = sidecar.agent;
const claimEvidenceRoot = sidecar.claimEvidenceDir
  ?? join(homedir(), '.jinn-client', 'native-evaluator', 'swe-rebench-v2-claim-evidence');

const repository = await createFilesystemEvidenceRepository({ rootDir: claimEvidenceRoot });

/**
 * Durable, content-addressed claim-evidence writer — same pattern as the prediction module. The
 * swe-rebench adapter DOES attach claim evidence (the tail-capped test log), so this writer is
 * exercised on every graded attempt, not merely provisioned.
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

// The Docker driver, constructed once at module import with the isolation profile documented in the
// sibling `swe-rebench-v2-evaluation-method.v1.json`. `readOnlyRootfs: false` is the one deliberate
// relaxation from the driver's default: the swe-rebench grade path installs pytest into the image's
// Python site-packages at grade time (`python3 -m ensurepip --upgrade` / `python3 -m pip install
// pytest`, see client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts) — those writes
// land on the rootfs, not under the writable bind-mounted workdir, and a read-only rootfs would fail
// them on any instance whose base image lacks pytest. Every OTHER bound stays at the driver default
// (--network none, --cap-drop ALL, --no-new-privileges, --pids-limit, --memory, --cpus, a
// noexec/nosuid /tmp tmpfs), so the container is still resource-capped and confined.
const runtime = createDockerContainerRuntime({
  readOnlyRootfs: false,
  ...(sidecar.dockerPath === undefined ? {} : { dockerPath: sidecar.dockerPath }),
});

/**
 * The deployment-owned container grader source. `workspaceRoot` is the attempt's writable `work`
 * directory, which only exists in the SPAWNED evaluation-harness child and only as the per-attempt
 * `JINN_ATTEMPT_WORK` env var (the fixed launcher allowlist forwards it — see
 * `packages/task-execution/backend-local/workspace/src/dir-provisioner.ts`'s `executionEnv`). It is
 * resolved LAZILY, at grade time, for two reasons: it does not exist when the PARENT daemon imports
 * this module during composition (composition binds this registration `deployment-owned` and never
 * calls `read`, so no workspace is needed there); and reading it lazily lets this module load
 * cleanly in the parent while still failing loud, rather than provisioning somewhere wrong, if
 * `read` is ever reached without the per-attempt work directory.
 */
const graderReportSource = {
  async read(request) {
    const workspaceRoot = process.env.JINN_ATTEMPT_WORK;
    if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
      throw new Error(
        'swe-rebench-v2 container grader requires the per-attempt work directory (JINN_ATTEMPT_WORK); '
        + 'it is set only in the spawned evaluation-harness child, never in the parent daemon',
      );
    }
    // The container environment is intentionally empty: a deterministic grader is run with
    // --network none and has no business reading host env. The runtime adds nothing of its own.
    return containerGraderReportSource({ runtime, workspaceRoot, env: {} }).read(request);
  },
};

const registration = createSweRebenchEvaluatorRegistration({
  evaluatorId,
  signerHandle: SIGNER_HANDLE,
  evaluationMethod: {
    name: 'jinn-swe-rebench-v2-evaluator-v1',
    uri: 'https://spec.jinn.network/evaluation-methods/swe-rebench/v2',
    digest: { sha256: evaluationMethodDescriptorDigestHex() },
  },
  graderReportSource,
});

// Narrowed to exactly the parser this deployment's single registration serves.
export const evaluationHarnessDeployment = Object.freeze({
  registrations: [registration],
  parserAllowlist: new Set([parserAllowlistKey(SWE_REBENCH_PARSER)]),
  evidenceWriter,
  maxClaimEvidenceBytes: MAX_CLAIM_EVIDENCE_BYTES,
});
