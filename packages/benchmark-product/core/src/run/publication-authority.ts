/** Durable authority evidence for exact records entering the workspace publication closure. */

import { canonicalJsonBytes, dssePreAuthEncoding, parseExactDsseEnvelope, sealDsseEnvelope } from "@jinn-network/trust-core";
import { isSourceName } from "@jinn-network/record-discovery-protocol";
import type { OriginReference } from "@jinn-network/record-publication";
import { z } from "zod";
import { refuse } from "../errors.js";
import { atomicWriteFileSync, readFileIfExistsSync } from "../fs/atomic.js";
import { loadOrCreateReportSigningKey, verifyReportEnvelopeSignatures } from "../report/signing.js";
import { publicationAuthorshipPath, publicationOriginPath } from "../workspace/layout.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import { acquireRunPublicationGuard } from "./finalization-lock.js";

export const WORKSPACE_AUTHORSHIP_MEDIA_TYPE = "application/vnd.jinn.colophon.workspace-authorship.v1+json";
export const WORKSPACE_AUTHORSHIP_ROLE = "https://product.jinn.network/artifact-roles/workspace-authorship/v1";
export const WORKSPACE_AUTHORSHIP_PREDICATE = "https://product.jinn.network/predicates/workspace-authorship/v1";
export const WORKSPACE_AUTHORSHIP_SCOPE = "jinn:benchmark-publication";

const Hex = z.string().regex(/^[a-f0-9]{64}$/u);
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const Rfc3339 = z.string().datetime({ offset: true });
const AuthorshipStatementSchema = z.strictObject({
  _type: z.literal("https://in-toto.io/Statement/v1"),
  subject: z.tuple([z.strictObject({ name: z.literal("record"), digest: z.strictObject({ sha256: Hex }) })]),
  predicateType: z.literal(WORKSPACE_AUTHORSHIP_PREDICATE),
  predicate: z.strictObject({
    scope: z.literal(WORKSPACE_AUTHORSHIP_SCOPE),
    author: z.string().startsWith("did:key:z"),
    recordKind: z.string().url(),
    authoredAt: Rfc3339,
  }),
});
const AuthorshipRefSchema = z.strictObject({ version: z.literal(1), envelopeSha256: Hex });
const OriginSchema = z.strictObject({
  version: z.literal(1),
  recordDigest: Digest,
  source: z.strictObject({ agent: z.string().min(1), name: z.string().min(1) }),
  sequence: z.string().regex(/^[0-9]{16}$/u),
  entryDigest: Digest,
});

function parseJson(bytes: Uint8Array, label: string): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (cause) { throw new Error(`${label} is not UTF-8 JSON: ${cause instanceof Error ? cause.message : String(cause)}`); }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export interface WorkspaceAuthorshipArtifact {
  readonly digestHex: string;
  readonly bytes: Uint8Array;
  readonly mediaType: typeof WORKSPACE_AUTHORSHIP_MEDIA_TYPE;
  readonly authoredAt: string;
}

/** Signs and durably binds the workspace did:key to one exact product-created record. */
export function recordWorkspaceAuthorship(input: {
  readonly workspaceDir: string;
  readonly recordSha256: string;
  readonly recordKind: string;
  readonly authoredAt: string;
}): WorkspaceAuthorshipArtifact {
  const path = publicationAuthorshipPath(input.workspaceDir, input.recordSha256);
  const started = Date.now();
  let lock: ReturnType<typeof acquireRunPublicationGuard>;
  do {
    lock = acquireRunPublicationGuard(input.workspaceDir, `__workspace-authorship-${input.recordSha256}__`);
    if (lock.acquired) break;
    if (lock.reason !== "contended") throw new Error(`workspace authorship lock is ${lock.reason}: ${lock.detail}`);
    if (Date.now() - started >= 30_000) throw new Error(`timed out waiting for workspace authorship lock for ${input.recordSha256}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  } while (!lock.acquired);
  try {
    const key = loadOrCreateReportSigningKey(input.workspaceDir);
    const existing = readFileIfExistsSync(path);
    if (existing !== undefined) {
      return requireWorkspaceAuthorship({
        workspaceDir: input.workspaceDir,
        recordSha256: input.recordSha256,
        recordKind: input.recordKind,
        author: key.keyId,
      });
    }
    const statement = AuthorshipStatementSchema.parse({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "record", digest: { sha256: input.recordSha256 } }],
    predicateType: WORKSPACE_AUTHORSHIP_PREDICATE,
      predicate: {
        scope: WORKSPACE_AUTHORSHIP_SCOPE,
        author: key.keyId,
        recordKind: input.recordKind,
        authoredAt: input.authoredAt,
      },
    });
    const payloadBytes = canonicalJsonBytes(statement);
    const envelopeBytes = sealDsseEnvelope({
      payloadType: WORKSPACE_AUTHORSHIP_MEDIA_TYPE,
      payloadBytes,
      signatures: [{ keyid: key.keyId, signature: key.sign(dssePreAuthEncoding(WORKSPACE_AUTHORSHIP_MEDIA_TYPE, payloadBytes)) }],
    });
    const envelopeSha256 = putSealedBytes(input.workspaceDir, envelopeBytes);
    atomicWriteFileSync(path, JSON.stringify({ version: 1, envelopeSha256 }));
    return { digestHex: envelopeSha256, bytes: envelopeBytes, mediaType: WORKSPACE_AUTHORSHIP_MEDIA_TYPE, authoredAt: input.authoredAt };
  } finally {
    if (lock.acquired) lock.release();
  }
}

/** Cryptographically verifies the exact authorship envelope and its record binding. */
export function requireWorkspaceAuthorship(input: {
  readonly workspaceDir: string;
  readonly recordSha256: string;
  readonly recordKind: string;
  readonly author: string;
}): WorkspaceAuthorshipArtifact {
  const refBytes = readFileIfExistsSync(publicationAuthorshipPath(input.workspaceDir, input.recordSha256));
  if (refBytes === undefined) throw new Error("workspace-authored record has no durable signed authorship proof");
  const ref = AuthorshipRefSchema.parse(parseJson(refBytes, "workspace authorship reference"));
  const bytes = getSealedBytes(input.workspaceDir, ref.envelopeSha256);
  const envelope = parseExactDsseEnvelope(bytes);
  if (envelope.payloadType !== WORKSPACE_AUTHORSHIP_MEDIA_TYPE) throw new Error("workspace authorship envelope has the wrong payload type");
  const statement = AuthorshipStatementSchema.parse(parseJson(envelope.payloadBytes, "workspace authorship statement"));
  if (!equalBytes(canonicalJsonBytes(statement), envelope.payloadBytes)) throw new Error("workspace authorship payload is not exact canonical bytes");
  if (
    statement.subject[0].digest.sha256 !== input.recordSha256
    || statement.predicate.recordKind !== input.recordKind
    || statement.predicate.author !== input.author
  ) throw new Error("workspace authorship proof does not bind this exact record/kind/author");
  const key = loadOrCreateReportSigningKey(input.workspaceDir);
  if (key.keyId !== input.author || !verifyReportEnvelopeSignatures(bytes, key).validSignerKeyids.includes(input.author)) {
    throw new Error("workspace authorship signature does not verify under the source did:key");
  }
  return {
    digestHex: ref.envelopeSha256,
    bytes,
    mediaType: WORKSPACE_AUTHORSHIP_MEDIA_TYPE,
    authoredAt: statement.predicate.authoredAt,
  };
}

/** Persists immutable external source coordinates; publication still requires injected verification. */
export function recordPublicationOrigin(
  workspaceDir: string,
  recordDigest: `sha256:${string}`,
  origin: OriginReference,
): void {
  const parsed = OriginSchema.parse({ version: 1, recordDigest, ...origin });
  if (!isSourceName(parsed.source.name) || !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u.test(parsed.source.agent)) {
    refuse("validation", "publication.origin.source", "origin source must carry an absolute agent IRI and valid source name");
  }
  const path = publicationOriginPath(workspaceDir, recordDigest.slice(7));
  const bytes = canonicalJsonBytes(parsed);
  const existing = readFileIfExistsSync(path);
  if (existing !== undefined && !equalBytes(existing, bytes)) {
    refuse("conflict", `publication.origins.${recordDigest}`, "an exact record digest already has different durable origin coordinates");
  }
  if (existing === undefined) atomicWriteFileSync(path, bytes);
}

export function readPublicationOrigin(
  workspaceDir: string,
  recordDigest: `sha256:${string}`,
): OriginReference | undefined {
  const bytes = readFileIfExistsSync(publicationOriginPath(workspaceDir, recordDigest.slice(7)));
  if (bytes === undefined) return undefined;
  const parsed = OriginSchema.parse(parseJson(bytes, "publication origin reference"));
  if (parsed.recordDigest !== recordDigest || !isSourceName(parsed.source.name)) {
    throw new Error("publication origin reference does not bind this exact digest/source");
  }
  return { source: parsed.source, sequence: parsed.sequence, entryDigest: parsed.entryDigest as `sha256:${string}` };
}
