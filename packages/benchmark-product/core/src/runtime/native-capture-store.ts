// SPDX-License-Identifier: Apache-2.0

/**
 * Workspace-backed `NativeCaptureStore` (#3340).
 *
 * `NativeCaptureCoordinator` takes five collaborators; four of them already had production
 * bindings (`./native-ports.ts` for the snapshot port and the launcher, the adapters for the rest).
 * The store did not: the only implementation in the repo was the test double in
 * `../conformance/evidence-native-commissioning-parity.test.ts`. Without it nothing shipped could
 * drive a native capture, which is the gap issue #3340 names.
 *
 * Everything here is content-addressed. A record or artifact is filed under the digest of its own
 * bytes, so the path cannot disagree with the content, and `resolveEvidence` re-checks that digest
 * on the way out — the coordinator's `verify` compares what it reads against the reference it
 * stored, and that comparison is only worth making if the read is honest about what it found.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  documentDigest,
  type EvidenceRecordReference,
  type SealedRecord,
  type TypedRecordReference,
} from "@jinn-network/benchmarking-protocol";
import type {
  NativeCaptureSession,
  NativeCaptureStore,
} from "@jinn-network/benchmarking-native-capture";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import {
  evidenceCaptureSessionPath,
  evidenceSessionArtifactsDir,
  evidenceSessionRecordsDir,
} from "../workspace/layout.js";

/**
 * `application/ld+json`, named `ro-crate-metadata.json`: Execution Evidence v1 is an RO-Crate, and
 * both golden fixtures reference it under that name. The name is cosmetic for addressing —
 * `evidenceReferenceKey` keys on family plus digest — but it is what a reader sees.
 */
const EXECUTION_EVIDENCE_NAME = "ro-crate-metadata.json";
const EXECUTION_EVIDENCE_MEDIA_TYPE = "application/ld+json";

/**
 * Read off the store interface rather than imported by name. The declaring package is
 * `@jinn-network/execution-evidence-builder`, a devDependency: naming it here would put it on a
 * production import path, and `native-capture` does not re-export the type.
 */
type ArtifactSource = Parameters<NativeCaptureStore["putArtifact"]>[0];

export interface WorkspaceNativeCaptureStoreOptions {
  readonly workspaceDir: string;
  readonly sessionId: string;
}

interface IdempotencyIndex {
  readonly [idempotencyKey: string]: string;
}

/**
 * Workspace-backed `NativeCaptureStore` for one evidence session.
 *
 * Records and artifacts are digest-addressed; `resolveEvidence` re-verifies the digest before
 * returning bytes. `saveSession` honors the coordinator's revision compare-and-set rather than
 * overwriting, so two processes driving one session cannot interleave into a state neither wrote.
 */
export function createWorkspaceNativeCaptureStore(
  options: WorkspaceNativeCaptureStoreOptions,
): NativeCaptureStore {
  const { workspaceDir, sessionId } = options;
  const sessionPath = evidenceCaptureSessionPath(workspaceDir, sessionId);
  const recordsDir = evidenceSessionRecordsDir(workspaceDir, sessionId);
  const artifactsDir = evidenceSessionArtifactsDir(workspaceDir, sessionId);
  // One flat file rather than a file per key: the whole point is to read the prior binding before
  // writing, and a single document makes that one read.
  const indexPath = join(recordsDir, "execution-idempotency.json");

  const readIndex = (): IdempotencyIndex =>
    existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) as IdempotencyIndex : {};

  const putBytes = (directory: string, bytes: Uint8Array): string => {
    const sha256 = documentDigest(bytes).slice(7);
    mkdirSync(directory, { recursive: true });
    atomicWriteFileSync(join(directory, `${sha256}.bin`), bytes);
    return sha256;
  };

  const readBytes = (directory: string, sha256: string, path: string): Uint8Array => {
    const file = join(directory, `${sha256}.bin`);
    if (!existsSync(file)) refuse("not-found", path, `evidence session ${sessionId} holds no record ${sha256}`);
    const bytes = new Uint8Array(readFileSync(file));
    const actual = documentDigest(bytes).slice(7);
    if (actual !== sha256) {
      refuse("record-integrity", path, `evidence session record ${sha256} reads back as ${actual}`);
    }
    return bytes;
  };

  return {
    loadSession(id: string): NativeCaptureSession | undefined {
      if (id !== sessionId) {
        refuse("not-found", "evidence", `this store is bound to session ${sessionId}, not ${id}`);
      }
      if (!existsSync(sessionPath)) return undefined;
      return JSON.parse(readFileSync(sessionPath, "utf8")) as NativeCaptureSession;
    },

    saveSession(session: NativeCaptureSession, expectedRevision: number | undefined): void {
      const held = existsSync(sessionPath)
        ? JSON.parse(readFileSync(sessionPath, "utf8")) as NativeCaptureSession
        : undefined;
      // The coordinator passes `undefined` only for the first write of a session. Treating that as
      // "overwrite whatever is there" would let a second `plan`/`import` silently discard a capture
      // already in progress.
      if (expectedRevision === undefined) {
        if (held !== undefined) {
          refuse("conflict", "evidence", `evidence session ${sessionId} already holds a native capture session`);
        }
      } else if (held === undefined || held.revision !== expectedRevision) {
        refuse(
          "conflict",
          "evidence",
          `native capture session ${sessionId} is at revision ${held === undefined ? "none" : held.revision}, not ${expectedRevision}`,
        );
      }
      atomicWriteFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
    },

    putRecord(recordKind: string, name: string, record: SealedRecord): TypedRecordReference {
      const sha256 = putBytes(recordsDir, record.bytes);
      if (`sha256:${sha256}` !== record.digest) {
        refuse("record-integrity", name, `sealed record ${name} declares ${record.digest} but its bytes hash to sha256:${sha256}`);
      }
      return { recordKind: recordKind as TypedRecordReference["recordKind"], record: { name, digest: { sha256 } } };
    },

    putExecution(idempotencyKey: string, bytes: Uint8Array): EvidenceRecordReference {
      const sha256 = documentDigest(bytes).slice(7);
      const index = readIndex();
      const bound = index[idempotencyKey];
      // Same posture as `createProcessNativeLauncher`: a key that already named other bytes is a
      // hard error, never a second record filed under the same claim of identity.
      if (bound !== undefined && bound !== sha256) {
        refuse(
          "conflict",
          "evidence",
          `native capture idempotency key already resolved to sha256:${bound}; an idempotency key cannot be reused`,
        );
      }
      putBytes(recordsDir, bytes);
      if (bound === undefined) {
        atomicWriteFileSync(indexPath, `${JSON.stringify({ ...index, [idempotencyKey]: sha256 }, null, 2)}\n`);
      }
      return {
        family: "execution-evidence",
        record: { name: EXECUTION_EVIDENCE_NAME, digest: { sha256 }, mediaType: EXECUTION_EVIDENCE_MEDIA_TYPE },
      };
    },

    putArtifact(source: ArtifactSource, bytes: Uint8Array): void {
      const sha256 = putBytes(artifactsDir, bytes);
      // The path is derived from the bytes, so this cannot mis-file anything; what it catches is a
      // caller whose DESCRIPTOR disagrees, which would surface later as an artifact the claim
      // package declares and the bundle does not carry.
      if (`sha256:${sha256}` !== source.digest) {
        refuse(
          "record-integrity",
          source.name ?? sha256,
          `artifact declares ${source.digest} but its bytes hash to sha256:${sha256}`,
        );
      }
    },

    resolveEvidence(reference: EvidenceRecordReference): Uint8Array {
      return readBytes(recordsDir, reference.record.digest.sha256, `${reference.family}/${reference.record.name}`);
    },
  };
}
