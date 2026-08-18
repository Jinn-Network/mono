/**
 * The two `AnchorProofSource` implementations (anchor-evidence design §6.1, §6.2).
 *
 * This is the I/O half of the §4.3 contract, and the only half that touches a network. The rules
 * live in `trust-core`; nothing here decides whether a proof is good — `runAnchor` runs the real
 * verifier over whatever these return, before anything is stored (§7.1 rule 4).
 *
 * **The fetch is injected, always.** A source built without one gets a `globalThis.fetch`-backed
 * default, but the seam is the parameter, not the global: every test in this package supplies its
 * own transport, so no test can reach a network by accident and no source can be exercised only
 * through a mock of a global.
 *
 * **No endpoint ships as a default and no vendor name appears here** (§7.3, the issue's
 * standards-only constraint). An endpoint is always configuration the operator supplied, which is
 * also what makes anchoring structurally opt-in.
 */

import {
  DER_TAG,
  OPENTIMESTAMPS_ANCHOR_PROFILE,
  OID_SHA256,
  RFC3161_TSA_ANCHOR_PROFILE,
  decodeDer,
  decodeDerChildren,
  encodeDerElement,
  encodeOid,
} from "@jinn-network/trust-core";
import type { AnchorProofRequest, AnchorProofSource } from "@jinn-network/trust-core";
import { refuse } from "../errors.js";
import {
  OpenTimestampsFormatError,
  forkOtsBranches,
  hasBitcoinAttestation,
  parseDetachedOtsProof,
  parseOtsCalendarResponse,
  serializeDetachedOtsProof,
  spliceOtsUpgrade,
  toHex,
} from "./opentimestamps.js";

// ---------------------------------------------------------------------------
// The injected transport
// ---------------------------------------------------------------------------

export interface AnchorHttpRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface AnchorHttpResponse {
  readonly status: number;
  readonly bytes: Uint8Array;
}

export type AnchorHttpFetch = (request: AnchorHttpRequest) => Promise<AnchorHttpResponse>;

/** Bounded by construction: an acquisition that never returns would hold the lock-time attempt
 * open for as long as the far side felt like it. */
export const DEFAULT_ANCHOR_TIMEOUT_MS = 30_000;

/** The `globalThis.fetch`-backed default. Injected like every other transport rather than reached
 * for inside the sources, so a caller can replace it without patching a global. */
export function createGlobalAnchorHttpFetch(timeoutMs = DEFAULT_ANCHOR_TIMEOUT_MS): AnchorHttpFetch {
  return async (request) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
    const response = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      // A fresh copy, so the request body is never a view onto a buffer the caller still holds.
      ...(request.body === undefined ? {} : { body: Uint8Array.from(request.body) }),
      signal,
    });
    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
  };
}

/**
 * Every acquisition failure is `venue-unavailable`: the configured venue did not supply a proof.
 * `venue-unverifiable` is reserved for §7.1 rule 4 — a proof that arrived and did not verify —
 * so the two codes stay readable as "nothing came back" versus "what came back does not hold".
 * (§7.1 names a code for neither transport failure nor a `PKIStatus` rejection; this split is
 * the packet's recorded disposition, and it adds no code to the taxonomy.)
 */
function unavailable(path: string, detail: string): never {
  refuse("venue-unavailable", path, detail);
}

function requireHttpsEndpoint(endpoint: string, path: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return unavailable(path, `anchor endpoint "${endpoint}" is not an absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    unavailable(path, `anchor endpoint "${endpoint}" must be an http(s) URL`);
  }
  return url;
}

const SUBJECT_PATTERN = /^[0-9a-f]{64}$/;

function subjectDigestBytes(subjectSha256: string, path: string): Uint8Array {
  if (!SUBJECT_PATTERN.test(subjectSha256)) {
    unavailable(path, "the anchor subject digest must be 64 lowercase hex characters");
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(subjectSha256.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// RFC 3161 over HTTP (§6.1)
// ---------------------------------------------------------------------------

const TIMESTAMP_QUERY_MEDIA_TYPE = "application/timestamp-query";
const TIMESTAMP_REPLY_MEDIA_TYPE = "application/timestamp-reply";

/** `PKIStatus` values that admit a token (§6.1 acquisition profile). */
const PKI_STATUS_GRANTED = 0;
const PKI_STATUS_GRANTED_WITH_MODS = 1;

function derSequence(children: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const child of children) length += child.length;
  const content = new Uint8Array(length);
  let offset = 0;
  for (const child of children) {
    content.set(child, offset);
    offset += child.length;
  }
  return encodeDerElement(DER_TAG.SEQUENCE, content);
}

/**
 * `TimeStampReq ::= SEQUENCE { version INTEGER { v1(1) }, messageImprint MessageImprint,
 * reqPolicy OPTIONAL, nonce OPTIONAL, certReq BOOLEAN DEFAULT FALSE, extensions [0] OPTIONAL }`
 * with `MessageImprint ::= SEQUENCE { hashAlgorithm AlgorithmIdentifier, hashedMessage OCTET STRING }`.
 *
 * `trust-core` reads timestamp tokens and never writes a request — request construction is
 * acquisition, which §6.1 places "entirely in the application-tier proof source" — so the DER is
 * assembled here out of core's own single-TLV encoder rather than a hand-rolled one.
 *
 * Two profile decisions are visible in these bytes:
 *
 * - **`certReq` is TRUE**, so the signer certificate travels inside the token and the stored proof
 *   is self-contained. Without it, §6.1 rule 6 refuses the token for an absent embedded
 *   certificate, and the anchor would depend on material no bundle carries.
 * - **No nonce.** A nonce protects a *live* requester against response replay; imprint equality
 *   already gives the stored artifact everything replay could threaten, and the verifier compares
 *   the imprint against a recomputed subject digest (§6.1 rule 12).
 *
 * The SHA-256 `AlgorithmIdentifier` carries an explicit NULL parameter. RFC 5754 prefers absent
 * parameters, but `openssl ts -query` emits NULL and deployed authorities are calibrated to it;
 * this is the request side, where interoperability with what is actually deployed decides, and no
 * verification rule reads these bytes back.
 */
export function buildTimeStampRequest(subjectDigest: Uint8Array): Uint8Array {
  const algorithmIdentifier = derSequence([
    encodeDerElement(DER_TAG.OBJECT_IDENTIFIER, encodeOid(OID_SHA256)),
    encodeDerElement(DER_TAG.NULL, new Uint8Array(0)),
  ]);
  return derSequence([
    encodeDerElement(DER_TAG.INTEGER, Uint8Array.of(1)),
    derSequence([algorithmIdentifier, encodeDerElement(DER_TAG.OCTET_STRING, subjectDigest)]),
    encodeDerElement(DER_TAG.BOOLEAN, Uint8Array.of(0xff)),
  ]);
}

function readSmallInteger(content: Uint8Array): number | undefined {
  if (content.length === 0 || content.length > 4 || (content[0]! & 0x80) !== 0) return undefined;
  let value = 0;
  for (const octet of content) value = value * 256 + octet;
  return value;
}

/**
 * Extracts the `TimeStampToken` from a `TimeStampResp ::= SEQUENCE { status PKIStatusInfo,
 * timeStampToken TimeStampToken OPTIONAL }`, refusing unless `PKIStatus` is `granted` or
 * `grantedWithMods` (§6.1). The token is returned as its **exact** bytes — the CMS `ContentInfo`
 * TLV, never re-encoded — because those bytes are what the record carries forever (§5 rule 2).
 */
export function extractTimeStampToken(responseBytes: Uint8Array, path: string): Uint8Array {
  let parts: readonly ReturnType<typeof decodeDer>[];
  try {
    parts = decodeDerChildren(decodeDer(responseBytes));
  } catch (cause) {
    return unavailable(path, `the timestamp authority's response is not readable DER: ${describe(cause)}`);
  }
  const statusInfo = parts[0];
  if (statusInfo === undefined) unavailable(path, "the timestamp authority's response carries no PKIStatusInfo");
  let status: number | undefined;
  try {
    status = readSmallInteger(decodeDerChildren(statusInfo)[0]!.content);
  } catch (cause) {
    return unavailable(path, `the timestamp authority's PKIStatusInfo is not readable: ${describe(cause)}`);
  }
  if (status !== PKI_STATUS_GRANTED && status !== PKI_STATUS_GRANTED_WITH_MODS) {
    unavailable(
      path,
      `the timestamp authority answered PKIStatus ${status ?? "(unreadable)"}; only granted (0) and grantedWithMods (1) carry a token`,
    );
  }
  const token = parts[1];
  if (token === undefined) {
    unavailable(path, "the timestamp authority granted the request but returned no timestamp token");
  }
  return token.bytes;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface Rfc3161ProofSourceOptions {
  readonly fetch?: AnchorHttpFetch;
}

/**
 * The `rfc3161-tsa/v1` acquisition source: one `application/timestamp-query` POST, one
 * `TimeStampResp` back, one DER `TimeStampToken` out.
 */
export function createRfc3161ProofSource(options: Rfc3161ProofSourceOptions = {}): AnchorProofSource {
  const transport = options.fetch ?? createGlobalAnchorHttpFetch();
  return {
    profile: RFC3161_TSA_ANCHOR_PROFILE,
    async obtainProof(request: AnchorProofRequest): Promise<Uint8Array> {
      const path = "anchor.rfc3161-tsa";
      const url = requireHttpsEndpoint(request.endpoint, path);
      const body = buildTimeStampRequest(subjectDigestBytes(request.subjectSha256, path));

      let response: AnchorHttpResponse;
      try {
        response = await transport({
          url: url.toString(),
          method: "POST",
          headers: { "content-type": TIMESTAMP_QUERY_MEDIA_TYPE, accept: TIMESTAMP_REPLY_MEDIA_TYPE },
          body,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
      } catch (cause) {
        return unavailable(path, `the timestamp authority was unreachable: ${describe(cause)}`);
      }
      if (response.status < 200 || response.status > 299) {
        unavailable(path, `the timestamp authority answered HTTP ${response.status}`);
      }
      return extractTimeStampToken(response.bytes, path);
    },
  };
}

// ---------------------------------------------------------------------------
// OpenTimestamps calendars (§6.2)
// ---------------------------------------------------------------------------

const OPENTIMESTAMPS_MEDIA_TYPE = "application/vnd.opentimestamps.v1";

/**
 * A single configured OpenTimestamps endpoint may name several calendars, comma-separated.
 * Stamping through several calendars is the standard mitigation for the availability caveat §6.2
 * names — a calendar that disappears before upgrade strands a pending proof permanently — and the
 * `AnchorProofSource` contract passes one `endpoint` string, so the several-calendars case is
 * spelled the way this repository already spells several endpoints elsewhere.
 */
function calendarBaseUrls(endpoint: string, path: string): readonly string[] {
  const entries = endpoint.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (entries.length === 0) unavailable(path, "no OpenTimestamps calendar is configured");
  return entries.map((entry) => requireHttpsEndpoint(entry, path).toString().replace(/\/$/, ""));
}

export interface OpenTimestampsProofSourceOptions {
  readonly fetch?: AnchorHttpFetch;
}

/**
 * The `opentimestamps/v1` source. Unlike RFC 3161 this profile has a two-step lifecycle, so the
 * source carries a second method beside the contract's `obtainProof`: `upgradeProof` fetches the
 * completed path a calendar has since published and splices it in. Upgrading is a producer-side
 * operation that appends a **new** record; the pending record is never rewritten (§6.2).
 */
export interface OpenTimestampsProofSource extends AnchorProofSource {
  /**
   * Asks every calendar that promised in `proofBytes` for its completed path, splicing in
   * whatever answers. Refuses `venue-unavailable` when no calendar has one yet.
   *
   * A 404 is the normal not-yet — a calendar answers it with a plain-text status for hours after
   * a stamp — and it is **not monotonic**: nothing about it is recorded, so a later invocation
   * asks that branch again. Only a branch that answers is spliced.
   */
  upgradeProof(request: {
    readonly subjectSha256: string;
    readonly proofBytes: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<Uint8Array>;
}

export function createOpenTimestampsProofSource(
  options: OpenTimestampsProofSourceOptions = {},
): OpenTimestampsProofSource {
  const transport = options.fetch ?? createGlobalAnchorHttpFetch();
  const path = "anchor.opentimestamps";

  return {
    profile: OPENTIMESTAMPS_ANCHOR_PROFILE,

    async obtainProof(request: AnchorProofRequest): Promise<Uint8Array> {
      const digest = subjectDigestBytes(request.subjectSha256, path);
      const calendars = calendarBaseUrls(request.endpoint, path);

      const branches = [];
      const failures: string[] = [];
      for (const calendar of calendars) {
        let response: AnchorHttpResponse;
        try {
          response = await transport({
            url: `${calendar}/digest`,
            method: "POST",
            headers: { "content-type": "application/octet-stream", accept: OPENTIMESTAMPS_MEDIA_TYPE },
            body: digest,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          });
        } catch (cause) {
          failures.push(`${calendar}: unreachable (${describe(cause)})`);
          continue;
        }
        if (response.status < 200 || response.status > 299) {
          failures.push(`${calendar}: HTTP ${response.status}`);
          continue;
        }
        try {
          // A calendar answers with a bare timestamp node -- the operation path from the digest
          // we submitted to that calendar's own commitment, ending in its promise.
          branches.push(parseOtsCalendarResponse(response.bytes, digest).root);
        } catch (cause) {
          failures.push(`${calendar}: ${describe(cause)}`);
        }
      }

      if (branches.length === 0) {
        unavailable(path, `no OpenTimestamps calendar answered the stamp — ${failures.join("; ")}`);
      }
      try {
        return serializeDetachedOtsProof(digest, forkOtsBranches(digest, branches));
      } catch (cause) {
        return unavailable(path, `the calendar responses do not assemble into a proof: ${describe(cause)}`);
      }
    },

    async upgradeProof(request): Promise<Uint8Array> {
      const digest = subjectDigestBytes(request.subjectSha256, path);
      let parsed;
      try {
        parsed = parseDetachedOtsProof(request.proofBytes);
      } catch (cause) {
        return unavailable(path, `the stored pending proof is not readable: ${describe(cause)}`);
      }
      if (toHex(parsed.fileDigest) !== request.subjectSha256) {
        unavailable(path, "the stored pending proof is detached from a different subject");
      }
      if (parsed.pendingSites.length === 0) {
        unavailable(path, "the stored proof carries no calendar promise to upgrade");
      }

      let spliced = 0;
      const notYet: string[] = [];
      for (const site of parsed.pendingSites) {
        // The calendar to ask is the one that made *this* promise, named inside the attestation
        // itself -- not a configured endpoint. The commitment is the message at that node, which
        // is not the file digest (44 bytes in the program's real capture).
        const url = `${site.uri.replace(/\/$/, "")}/timestamp/${site.commitmentHex}`;
        let response: AnchorHttpResponse;
        try {
          response = await transport({
            url,
            method: "GET",
            headers: { accept: OPENTIMESTAMPS_MEDIA_TYPE },
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          });
        } catch (cause) {
          notYet.push(`${site.uri}: unreachable (${describe(cause)})`);
          continue;
        }
        if (response.status < 200 || response.status > 299) {
          notYet.push(`${site.uri}: HTTP ${response.status}`);
          continue;
        }
        try {
          spliceOtsUpgrade(site, parseOtsCalendarResponse(response.bytes, site.node.message).root);
          spliced += 1;
        } catch (cause) {
          if (!(cause instanceof OpenTimestampsFormatError)) throw cause;
          notYet.push(`${site.uri}: ${cause.message}`);
        }
      }

      if (spliced === 0) {
        unavailable(path, `no calendar has published the attestation yet — ${notYet.join("; ")}`);
      }
      if (!hasBitcoinAttestation(parsed.root)) {
        // A calendar answered with more path but still no chain attestation. Storing that as an
        // "upgrade" would append a second pending record claiming to be the completed form.
        unavailable(path, "the calendars answered, but the proof still carries no chain attestation");
      }
      return serializeDetachedOtsProof(digest, parsed.root);
    },
  };
}
