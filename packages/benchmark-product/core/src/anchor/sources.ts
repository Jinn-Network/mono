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

/**
 * Bounded by construction: an acquisition that never returns would hold the lock-time attempt open
 * for as long as the far side felt like it.
 *
 * This is the bound on the **whole operation**, not on each request. A source that stamps through
 * several calendars issues several requests in sequence, so a per-request bound would multiply by
 * the number of configured calendars and the lock verb's worst case would grow with configuration
 * rather than stay where the design put it. Each source therefore opens one deadline per
 * `obtainProof` / `upgradeProof` call and every request it makes shares it; the default transport
 * keeps a per-request bound of its own only as a backstop for a caller that supplies no signal.
 */
export const DEFAULT_ANCHOR_TIMEOUT_MS = 30_000;

/** One deadline for a whole acquisition, combined with whatever the caller supplied. */
function operationSignal(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return caller === undefined ? deadline : AbortSignal.any([caller, deadline]);
}

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

/**
 * One canonical spelling for an http(s) endpoint, or `undefined` for anything that is not one.
 * Non-throwing because it is used on two different kinds of input: configuration, where a bad
 * value is a refusal, and foreign bytes, where a bad value is one branch to skip.
 */
function normalizeHttpEndpoint(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  return url.toString().replace(/\/$/, "");
}

function requireHttpsEndpoint(endpoint: string, path: string): string {
  const normalized = normalizeHttpEndpoint(endpoint);
  if (normalized === undefined) {
    unavailable(path, `anchor endpoint "${endpoint}" is not an absolute http(s) URL`);
  }
  return normalized;
}

/** The comma-separated spelling one configured endpoint may use (§6.2's several calendars). */
function endpointSegments(endpoint: string): readonly string[] {
  return endpoint.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/**
 * Canonicalizes an endpoint for *durable workspace configuration*, or `undefined` when it is not
 * one this product would accept — non-throwing, so the configuration surface refuses with its own
 * error code while the endpoint spelling stays this module's fact.
 *
 * It reads the endpoint the way the named profile's own source will read it (one URL, or §6.2's
 * comma-separated calendars) and is deliberately **stricter on one axis**: a configured endpoint
 * must be `https`. Acquisition itself still admits a plain-`http` endpoint, so a per-invocation
 * `--endpoint` is unchanged; what an operator writes into a workspace once and then anchors
 * through automatically on every later lock is held to TLS.
 */
export function normalizeConfiguredAnchorEndpoint(profile: string, endpoint: string): string | undefined {
  const segments = profile === OPENTIMESTAMPS_ANCHOR_PROFILE ? endpointSegments(endpoint) : [endpoint];
  if (segments.length === 0) return undefined;
  const normalized: string[] = [];
  for (const segment of segments) {
    const canonical = normalizeHttpEndpoint(segment);
    if (canonical === undefined || !canonical.startsWith("https://")) return undefined;
    normalized.push(canonical);
  }
  return normalized.join(",");
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
  /** Bound on the whole acquisition. See `DEFAULT_ANCHOR_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/**
 * The `rfc3161-tsa/v1` acquisition source: one `application/timestamp-query` POST, one
 * `TimeStampResp` back, one DER `TimeStampToken` out.
 */
export function createRfc3161ProofSource(options: Rfc3161ProofSourceOptions = {}): AnchorProofSource {
  const transport = options.fetch ?? createGlobalAnchorHttpFetch();
  const timeoutMs = options.timeoutMs ?? DEFAULT_ANCHOR_TIMEOUT_MS;
  return {
    profile: RFC3161_TSA_ANCHOR_PROFILE,
    async obtainProof(request: AnchorProofRequest): Promise<Uint8Array> {
      const path = "anchor.rfc3161-tsa";
      const url = requireHttpsEndpoint(request.endpoint, path);
      const body = buildTimeStampRequest(subjectDigestBytes(request.subjectSha256, path));
      const signal = operationSignal(request.signal, timeoutMs);

      let response: AnchorHttpResponse;
      try {
        response = await transport({
          url,
          method: "POST",
          headers: { "content-type": TIMESTAMP_QUERY_MEDIA_TYPE, accept: TIMESTAMP_REPLY_MEDIA_TYPE },
          body,
          signal,
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
  const entries = endpointSegments(endpoint);
  if (entries.length === 0) unavailable(path, "no OpenTimestamps calendar is configured");
  return entries.map((entry) => requireHttpsEndpoint(entry, path));
}

export interface OpenTimestampsProofSourceOptions {
  readonly fetch?: AnchorHttpFetch;
  /** Bound on the whole acquisition. See `DEFAULT_ANCHOR_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** A branch that will never upgrade however long anyone waits, kept apart from a branch that has
 * simply not confirmed yet (§6.2). Reporting the first as the second would describe a permanent
 * condition with a transient headline and invite an operator to keep retrying forever. */
interface UpgradeAttemptReport {
  readonly transient: string[];
  readonly permanent: string[];
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
    /**
     * The configured calendars, in the same comma-separated spelling `obtainProof` takes.
     *
     * Required, and it is an allowlist rather than a hint. The calendar a promise names comes out
     * of the stored proof, which is foreign bytes: a hostile or substituted attestation can name
     * any URI it likes, and following it would turn the upgrade path into a request primitive
     * pointed wherever the attestation says — with the response status echoed back in the refusal
     * detail. A promise from a calendar this operator never configured is not upgraded. The
     * reference client applies a calendar whitelist for exactly this reason.
     */
    readonly endpoint: string;
    readonly signal?: AbortSignal;
  }): Promise<Uint8Array>;
}

export function createOpenTimestampsProofSource(
  options: OpenTimestampsProofSourceOptions = {},
): OpenTimestampsProofSource {
  const transport = options.fetch ?? createGlobalAnchorHttpFetch();
  const timeoutMs = options.timeoutMs ?? DEFAULT_ANCHOR_TIMEOUT_MS;
  const path = "anchor.opentimestamps";

  return {
    profile: OPENTIMESTAMPS_ANCHOR_PROFILE,

    async obtainProof(request: AnchorProofRequest): Promise<Uint8Array> {
      const digest = subjectDigestBytes(request.subjectSha256, path);
      const calendars = calendarBaseUrls(request.endpoint, path);
      const signal = operationSignal(request.signal, timeoutMs);

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
            signal,
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

      const configured = new Set(calendarBaseUrls(request.endpoint, path));
      const signal = operationSignal(request.signal, timeoutMs);
      let spliced = 0;
      const report: UpgradeAttemptReport = { transient: [], permanent: [] };

      for (const site of parsed.pendingSites) {
        // The calendar to ask is the one that made *this* promise, named inside the attestation
        // itself. Those are foreign bytes, so the URI is normalized and checked against the
        // configured calendars before anything is sent: an attestation naming an unconfigured host
        // is refused rather than fetched. The commitment is the message at that node, which is not
        // the file digest (44 bytes in the program's real capture).
        const calendar = normalizeHttpEndpoint(site.uri);
        if (calendar === undefined || !configured.has(calendar)) {
          report.permanent.push(
            `${site.uri}: not one of this workspace's configured calendars, so its promise is never followed`,
          );
          continue;
        }
        let response: AnchorHttpResponse;
        try {
          response = await transport({
            url: `${calendar}/timestamp/${site.commitmentHex}`,
            method: "GET",
            headers: { accept: OPENTIMESTAMPS_MEDIA_TYPE },
            signal,
          });
        } catch (cause) {
          report.transient.push(`${calendar}: unreachable (${describe(cause)})`);
          continue;
        }
        if (response.status < 200 || response.status > 299) {
          report.transient.push(`${calendar}: HTTP ${response.status}`);
          continue;
        }
        try {
          spliceOtsUpgrade(site, parseOtsCalendarResponse(response.bytes, site.node.message).root);
          spliced += 1;
        } catch (cause) {
          if (!(cause instanceof OpenTimestampsFormatError)) throw cause;
          // The calendar answered, and its answer is one this producer cannot re-serialize -- an
          // attestation class it does not know, or a shape the splice cannot merge. Waiting does
          // not change any of that.
          report.permanent.push(`${calendar}: ${cause.message}`);
        }
      }

      if (spliced === 0) {
        if (report.transient.length === 0) {
          unavailable(
            path,
            `this proof can never be upgraded by this workspace — ${report.permanent.join("; ")}`,
          );
        }
        unavailable(
          path,
          `no calendar has published the attestation yet — ${[...report.transient, ...report.permanent].join("; ")}`,
        );
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
