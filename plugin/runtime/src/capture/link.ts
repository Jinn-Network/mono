// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  EvidenceArtifactReference,
  EvidenceRepository,
} from "@jinn-network/evidence-repository";
import {
  type JsonValue,
  type RepositorySha256Digest,
  type TraceDerivationStatement,
  TraceDerivationStatementSchema,
  type TraceRecord,
  documentDigest,
  parseTrace,
  serializeCanonicalJson,
  toBareSha256Hex,
  TRACE_RECORD_IDENTIFIER_PROPERTY,
} from "@jinn-network/evidence-trace";
import { DSSE_PAYLOAD_TYPE, parseSignedRecordEnvelope } from "@jinn-network/trust-core";

import { PluginRuntimeError } from "../errors.js";
import type { CapturePaths } from "./paths.js";
import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile } from "./paths.js";

const SHA256_REFERENCE = /^sha256:[0-9a-f]{64}$/u;

export interface TraceDerivationAttestationLink {
  readonly version: 1;
  readonly executionDigest: RepositorySha256Digest;
  readonly traceDigest: RepositorySha256Digest;
  readonly attestationDigest: RepositorySha256Digest;
  readonly nativeTraceDigest: RepositorySha256Digest;
  readonly derivedAt: string;
}

export function derivationLinkPath(
  paths: CapturePaths,
  executionDigest: RepositorySha256Digest,
): string {
  return join(paths.derivationLinksDirectory, `${toBareSha256Hex(executionDigest)}.json`);
}

/**
 * LEGACY, transition window only: the pre-re-seal field spelling for `traceDigest`. A
 * derivation link file sealed before the trajectory -> trace convergence (re-seal program
 * wave 7) carries this key instead of the canonical one. Removed by C2.
 */
const LEGACY_TRACE_DIGEST_FIELD = "trajectoryDigest";

/**
 * Dual-accept parse boundary for derivation link files, following the same discipline
 * `packages/discovery/protocol/src/origins.ts` and `packages/evidence/trace-decode/src/formats.ts`
 * state: **legacy spellings are inputs to translation, never selection keys.** A link file
 * written before the trajectory -> trace convergence carries `trajectoryDigest` instead of
 * `traceDigest`; this function accepts either on read and normalizes to the canonical
 * `traceDigest` field immediately, here, so nothing downstream of this function ever branches
 * on which spelling was on disk. `writeTraceDerivationAttestationLink` never emits the legacy
 * key. TRANSITION WINDOW: this fallback is migration scaffolding, not a permanent dual format;
 * component C2 owns narrowing it away once every derivation link on disk has been touched by
 * a canonical write (`derivedAt` bumps under sync, or a plain reseal sweep).
 */
function parseLinkBytes(bytes: Uint8Array): TraceDerivationAttestationLink {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PluginRuntimeError(
      "capture-derivation-link-invalid",
      "A derivation link file is not valid UTF-8 JSON.",
    );
  }
  if (decoded === null || typeof decoded !== "object") {
    throw new PluginRuntimeError(
      "capture-derivation-link-invalid",
      "A derivation link file must be a JSON object.",
    );
  }
  const candidate = decoded as Record<string, unknown>;
  if (candidate.version !== 1) {
    throw new PluginRuntimeError(
      "capture-derivation-link-invalid",
      "A derivation link file must declare version 1.",
    );
  }
  const traceDigest = candidate.traceDigest ?? candidate[LEGACY_TRACE_DIGEST_FIELD];
  for (const [field, value] of [
    ["executionDigest", candidate.executionDigest],
    ["traceDigest", traceDigest],
    ["attestationDigest", candidate.attestationDigest],
    ["nativeTraceDigest", candidate.nativeTraceDigest],
  ] as const) {
    if (typeof value !== "string" || !SHA256_REFERENCE.test(value)) {
      throw new PluginRuntimeError(
        "capture-derivation-link-invalid",
        `A derivation link file carries an invalid ${field}.`,
      );
    }
  }
  if (typeof candidate.derivedAt !== "string" || candidate.derivedAt.length === 0) {
    throw new PluginRuntimeError(
      "capture-derivation-link-invalid",
      "A derivation link file must carry a non-empty derivedAt.",
    );
  }
  return {
    version: 1,
    executionDigest: candidate.executionDigest as RepositorySha256Digest,
    traceDigest: traceDigest as RepositorySha256Digest,
    attestationDigest: candidate.attestationDigest as RepositorySha256Digest,
    nativeTraceDigest: candidate.nativeTraceDigest as RepositorySha256Digest,
    derivedAt: candidate.derivedAt,
  };
}

function linksCoherent(
  left: TraceDerivationAttestationLink,
  right: TraceDerivationAttestationLink,
): boolean {
  return (
    left.executionDigest === right.executionDigest &&
    left.traceDigest === right.traceDigest &&
    left.attestationDigest === right.attestationDigest &&
    left.nativeTraceDigest === right.nativeTraceDigest &&
    left.derivedAt === right.derivedAt
  );
}

export async function writeTraceDerivationAttestationLink(
  paths: CapturePaths,
  link: TraceDerivationAttestationLink,
): Promise<void> {
  await ensureOwnerOnlyDirectory(paths.derivationLinksDirectory);
  const target = derivationLinkPath(paths, link.executionDigest);
  const bytes = serializeCanonicalJson(link as unknown as JsonValue);

  try {
    const existing = await readFile(target);
    const parsed = parseLinkBytes(existing);
    if (linksCoherent(parsed, link)) return;
    throw new PluginRuntimeError(
      "capture-derivation-link-mismatch",
      `A derivation link already exists at ${target} with different content.`,
    );
  } catch (error) {
    if (error instanceof PluginRuntimeError) throw error;
    // Missing file — write below.
  }

  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, bytes, { mode: 0o600 });
  await ensureOwnerOnlyFile(temp);
  await rename(temp, target);
  await ensureOwnerOnlyFile(target);
}

export async function readTraceDerivationAttestationLink(
  paths: CapturePaths,
  executionDigest: RepositorySha256Digest,
): Promise<TraceDerivationAttestationLink | null> {
  const target = derivationLinkPath(paths, executionDigest);
  try {
    return parseLinkBytes(await readFile(target));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    if (error instanceof PluginRuntimeError) throw error;
    throw error;
  }
}

export async function loadTraceDerivationAttestation(
  repository: EvidenceRepository,
  link: TraceDerivationAttestationLink,
): Promise<{ envelopeBytes: Uint8Array; statement: TraceDerivationStatement }> {
  const envelopeBytes = await repository.getArtifact(
    { digest: link.attestationDigest },
    undefined,
  );
  if (envelopeBytes === null) {
    throw new PluginRuntimeError(
      "capture-derivation-attestation-missing",
      `The derivation attestation ${link.attestationDigest} is not present in this archive.`,
    );
  }
  const { payloadBytes } = parseSignedRecordEnvelope(envelopeBytes, DSSE_PAYLOAD_TYPE);
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch {
    throw new PluginRuntimeError(
      "capture-derivation-attestation-invalid",
      "The derivation attestation payload is not valid UTF-8 JSON.",
    );
  }
  const parsed = TraceDerivationStatementSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new PluginRuntimeError(
      "capture-derivation-attestation-invalid",
      "The derivation attestation payload is not a valid Trace derivation statement.",
    );
  }
  return { envelopeBytes, statement: parsed.data };
}

function asArray(value: unknown): readonly unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Reads the trace record's digest out of a sealed execution record.
 *
 * The link is an `identifier` PropertyValue on the native-trace entity, which the recorder
 * emits from `ArtifactCapture.identifiers`
 * (`packages/evidence/execution-recorder/src/graph.ts:402-404`). It lives there rather than in
 * the catalog because `EVIDENCE_RECORD_FAMILIES` is closed
 * (`packages/evidence/repository/src/types.ts:1-5`) and a trace is therefore stored as a
 * repository artifact, which the catalog does not project.
 *
 * Returns `null` for any record that does not carry the link, including unreadable bytes —
 * a missing link is an ordinary state (every record written by another producer lacks one),
 * not an error.
 */
export function traceReferenceFromRecordBytes(
  bytes: Uint8Array,
): EvidenceArtifactReference | null {
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  const graph = (document as { readonly "@graph"?: unknown })?.["@graph"];
  if (!Array.isArray(graph)) return null;

  for (const entity of graph) {
    if (entity === null || typeof entity !== "object") continue;
    for (const identifier of asArray((entity as Record<string, unknown>).identifier)) {
      if (identifier === null || typeof identifier !== "object") continue;
      const candidate = identifier as Record<string, unknown>;
      if (candidate.propertyID !== TRACE_RECORD_IDENTIFIER_PROPERTY) continue;
      const value = candidate.value;
      if (typeof value === "string" && SHA256_REFERENCE.test(value)) {
        return { digest: value as `sha256:${string}` };
      }
    }
  }
  return null;
}

/** Fetches and parses the sealed trace artifact under C1's exact-bytes discipline. */
export async function loadTraceRecord(
  repository: EvidenceRepository,
  reference: EvidenceArtifactReference,
  options?: { readonly signal?: AbortSignal },
): Promise<TraceRecord> {
  const bytes = await repository.getArtifact(reference, options);
  if (bytes === null) {
    throw new PluginRuntimeError(
      "capture-trace-missing",
      `The trace record ${reference.digest} is not present in this archive.`,
    );
  }
  return parseTrace(bytes);
}
