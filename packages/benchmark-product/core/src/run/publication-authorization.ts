/** A real trust-core Authorization Statement, sealed as a DSSE envelope by the source did:key. */

import { createHash, verify as cryptoVerify } from "node:crypto";
import {
  DSSE_ENVELOPE_MEDIA_TYPE,
  dssePreAuthEncoding,
  parseDsseEnvelope,
  sealDsseEnvelope,
  validateAuthorization,
} from "@jinn-network/trust-core";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { loadOrCreateReportSigningKey } from "../report/signing.js";
import { BENCHMARK_PUBLICATION_AUTHORIZATION_SCOPE } from "./publication-source.js";
import { sha256Hex } from "../workspace/sealed-store.js";

export interface PublisherAuthorizationArtifact {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly publisher: string;
  readonly owner: string;
  readonly effectiveAt: string;
}

/** Extra predicate fields are permitted by trust-core's loose authorization schema. */
function statement(owner: string, publisher: string, effectiveAt: string) {
  return {
    _type: "https://in-toto.io/Statement/v1" as const,
    subject: [{
      name: "benchmark-publication-run-owner",
      digest: { sha256: createHash("sha256").update(owner, "utf8").digest("hex") },
    }],
    predicateType: "https://spec.jinn.network/trust/authorization/v1" as const,
    predicate: {
      // The deterministic Run owner delegates publication authority to the source did:key.
      issuer: owner,
      audience: publisher,
      capabilities: [BENCHMARK_PUBLICATION_AUTHORIZATION_SCOPE],
      // A Run's close boundary is the natural authorization expiry. Effective time is explicit
      // evidence used by accounting and checked below, not inferred from filesystem mtime.
      expiry: "9999-12-31T23:59:59Z",
      nonce: `benchmark-publication:${effectiveAt}:${createHash("sha256").update(`${owner}\u001f${publisher}`).digest("hex")}`,
      "https://spec.jinn.network/benchmark-publication/effective-at": effectiveAt,
    },
  };
}

export function createPublisherAuthorizationArtifact(input: {
  readonly workspaceDir: string;
  readonly owner: string;
  readonly effectiveAt: string;
}): PublisherAuthorizationArtifact {
  const key = loadOrCreateReportSigningKey(input.workspaceDir);
  const payload = canonicalJsonBytes(statement(input.owner, key.keyId, input.effectiveAt) as never);
  const bytes = sealDsseEnvelope({
    payloadBytes: payload,
    signatures: [{ keyid: key.keyId, signature: key.sign(dssePreAuthEncoding("application/vnd.in-toto+json", payload)) }],
  });
  return { bytes, digest: sha256Hex(bytes), publisher: key.keyId, owner: input.owner, effectiveAt: input.effectiveAt };
}

/** Full structural envelope/schema/signature/scope/effectivity verification against the workspace key. */
export function verifyPublisherAuthorizationArtifact(input: {
  readonly workspaceDir: string;
  readonly bytes: Uint8Array;
  readonly owner: string;
  readonly publisher: string;
  readonly effectiveNoLaterThan: string;
}): boolean {
  try {
    const structural = validateAuthorization(input.bytes);
    if (!structural.conforms || structural.value === undefined) return false;
    const predicate = structural.value.predicate as typeof structural.value.predicate & Record<string, unknown>;
    const effectiveAt = predicate["https://spec.jinn.network/benchmark-publication/effective-at"];
    if (structural.value.predicate.issuer !== input.owner || structural.value.predicate.audience !== input.publisher
      || !structural.value.predicate.capabilities.includes(BENCHMARK_PUBLICATION_AUTHORIZATION_SCOPE)
      || typeof effectiveAt !== "string" || !Number.isFinite(Date.parse(effectiveAt))
      || Date.parse(effectiveAt) > Date.parse(input.effectiveNoLaterThan)) return false;
    const key = loadOrCreateReportSigningKey(input.workspaceDir);
    if (key.keyId !== input.publisher) return false;
    const envelope = parseDsseEnvelope(input.bytes);
    return envelope.signatures.some((signature) => signature.keyid === key.keyId
      && cryptoVerify(null, Buffer.from(dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes)), key.publicKey, Buffer.from(signature.sig, "base64")));
  } catch {
    return false;
  }
}

export const AUTHORIZATION_MEDIA_TYPE = DSSE_ENVELOPE_MEDIA_TYPE;
