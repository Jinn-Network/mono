/**
 * The two acquisition sources, exercised entirely through the injected transport. No test here
 * touches `globalThis.fetch`; every request is recorded and every response is minted by the
 * conformance kit, so what these tests prove is that the sources speak the profiles' own HTTP
 * bindings and hand back exactly the bytes the real verifiers accept.
 */

import { describe, expect, test } from "vitest";
import {
  DER_TAG,
  OID_SHA256,
  createOpenTimestampsProofVerifier,
  createRfc3161AnchorProofVerifier,
  decodeDer,
  decodeDerChildren,
  encodeDerElement,
  readDerOid,
} from "@jinn-network/trust-core";
import { nodeCryptoAnchorPorts } from "@colophon-claims/verify";
import {
  KIT_AUTHORITY_SEED,
  KIT_BITCOIN_BLOCK_HEIGHT,
  KIT_CALENDAR_URI,
  KIT_SECOND_CALENDAR_URI,
  buildLinearOtsProof,
  createFixtureAuthority,
} from "@jinn-network/trust-testing";
import type { OtsAttestation, OtsOperation } from "./opentimestamps.js";
import { parseDetachedOtsProof, toHex } from "./opentimestamps.js";
import {
  buildTimeStampRequest,
  createOpenTimestampsProofSource,
  createRfc3161ProofSource,
  extractTimeStampToken,
  type AnchorHttpFetch,
  type AnchorHttpRequest,
} from "./sources.js";

const SUBJECT = "47fe3768e164b8663dd4da743c8f416fa09658c652f21617f45eea8a5a8a705c";
const TSA_ENDPOINT = "https://timestamp.invalid/tsr";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

const fileDigest = hexToBytes(SUBJECT);

interface Recorder {
  readonly requests: AnchorHttpRequest[];
  readonly fetch: AnchorHttpFetch;
}

function recorder(handler: (request: AnchorHttpRequest) => Promise<{ status: number; bytes: Uint8Array }>): Recorder {
  const requests: AnchorHttpRequest[] = [];
  return {
    requests,
    fetch: async (request) => {
      requests.push(request);
      return handler(request);
    },
  };
}

// --- RFC 3161 ---------------------------------------------------------------

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

/** `TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken OPTIONAL }`. */
function timeStampResp(status: number, tokenDer?: Uint8Array): Uint8Array {
  const statusInfo = derSequence([encodeDerElement(DER_TAG.INTEGER, Uint8Array.of(status))]);
  return derSequence(tokenDer === undefined ? [statusInfo] : [statusInfo, tokenDer]);
}

const authority = createFixtureAuthority(KIT_AUTHORITY_SEED);
const mintedToken = authority.mintTimeStampToken({ subjectSha256: SUBJECT });

describe("buildTimeStampRequest", () => {
  test("is a v1 request over the exact subject digest with certReq set and no nonce", () => {
    const parts = decodeDerChildren(decodeDer(buildTimeStampRequest(fileDigest)));
    expect(parts).toHaveLength(3);
    expect(toHex(parts[0]!.content)).toBe("01");

    const imprint = decodeDerChildren(parts[1]!);
    const algorithm = decodeDerChildren(imprint[0]!);
    expect(readDerOid(algorithm[0]!)).toBe(OID_SHA256);
    // Explicit NULL parameter: what `openssl ts -query` emits and what deployed authorities are
    // calibrated to. This is the request side; no verification rule reads these bytes back.
    expect(algorithm[1]!.identifier).toBe(DER_TAG.NULL);
    expect(toHex(imprint[1]!.content)).toBe(SUBJECT);

    // certReq TRUE, so the signer certificate travels in the token and the proof is
    // self-contained. A nonce is deliberately absent (§6.1).
    expect(parts[2]!.identifier).toBe(DER_TAG.BOOLEAN);
    expect(toHex(parts[2]!.content)).toBe("ff");
  });
});

describe("extractTimeStampToken", () => {
  test("returns the token's exact bytes on granted and on grantedWithMods", () => {
    for (const status of [0, 1]) {
      const token = extractTimeStampToken(timeStampResp(status, mintedToken.tokenDer), "t");
      expect(toHex(token)).toBe(toHex(mintedToken.tokenDer));
    }
  });

  test("refuses every other PKIStatus before any token is extracted", () => {
    for (const status of [2, 3, 4, 5]) {
      // A rejection carrying a token would be exactly the case a lenient reader lets through.
      expect(() => extractTimeStampToken(timeStampResp(status, mintedToken.tokenDer), "t"))
        .toThrowError(/PKIStatus/);
    }
  });

  test("refuses a granted response that carries no token", () => {
    expect(() => extractTimeStampToken(timeStampResp(0), "t")).toThrowError(/no timestamp token/);
  });

  test("refuses bytes that are not readable DER", () => {
    expect(() => extractTimeStampToken(Uint8Array.of(1, 2, 3), "t")).toThrowError(/DER/);
  });
});

describe("createRfc3161ProofSource", () => {
  test("POSTs application/timestamp-query and returns a token the real verifier accepts", async () => {
    const transport = recorder(async () => ({ status: 200, bytes: timeStampResp(0, mintedToken.tokenDer) }));
    const source = createRfc3161ProofSource({ fetch: transport.fetch });

    const proofBytes = await source.obtainProof({ subjectSha256: SUBJECT, endpoint: TSA_ENDPOINT });

    expect(transport.requests).toHaveLength(1);
    const request = transport.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe(TSA_ENDPOINT);
    expect(request.headers["content-type"]).toBe("application/timestamp-query");
    expect(request.headers.accept).toBe("application/timestamp-reply");
    expect(toHex(request.body!)).toBe(toHex(buildTimeStampRequest(fileDigest)));

    const result = createRfc3161AnchorProofVerifier(nodeCryptoAnchorPorts)
      .verifyProof({ subjectSha256: SUBJECT, proofBytes });
    // No trust material at acquisition time: `present`, never `verified`.
    expect(result.status).toBe("present");
  });

  test("refuses venue-unavailable on a non-2xx answer", async () => {
    const source = createRfc3161ProofSource({ fetch: async () => ({ status: 503, bytes: new Uint8Array(0) }) });
    await expect(source.obtainProof({ subjectSha256: SUBJECT, endpoint: TSA_ENDPOINT }))
      .rejects.toMatchObject({ code: "venue-unavailable" });
  });

  test("refuses venue-unavailable when the transport itself fails", async () => {
    const source = createRfc3161ProofSource({ fetch: async () => { throw new Error("ECONNREFUSED"); } });
    await expect(source.obtainProof({ subjectSha256: SUBJECT, endpoint: TSA_ENDPOINT }))
      .rejects.toMatchObject({ code: "venue-unavailable" });
  });

  test("refuses an endpoint that is not an http(s) URL, without asking anything", async () => {
    const transport = recorder(async () => ({ status: 200, bytes: new Uint8Array(0) }));
    const source = createRfc3161ProofSource({ fetch: transport.fetch });
    await expect(source.obtainProof({ subjectSha256: SUBJECT, endpoint: "ftp://timestamp.invalid" }))
      .rejects.toMatchObject({ code: "venue-unavailable" });
    expect(transport.requests).toHaveLength(0);
  });
});

// --- OpenTimestamps ---------------------------------------------------------

/** A bare timestamp node, as a calendar answers — the kit's proof minus its 36-byte header. */
function calendarBody(operations: readonly OtsOperation[], attestations: readonly OtsAttestation[]): Uint8Array {
  return buildLinearOtsProof({ fileDigest, operations, attestations }).subarray(31 + 1 + 1 + 32);
}

const FIRST_CALENDAR_PATH: readonly OtsOperation[] = [
  { kind: "append", argument: Uint8Array.of(0x6a, 0x69, 0x6e, 0x6e) },
  { kind: "sha256" },
];
const SECOND_CALENDAR_PATH: readonly OtsOperation[] = [
  { kind: "append", argument: Uint8Array.of(0, 1, 2, 3) },
  { kind: "sha256" },
];

describe("createOpenTimestampsProofSource — stamping", () => {
  test("POSTs the raw 32-byte digest to /digest and assembles a pending proof", async () => {
    const transport = recorder(async () => ({
      status: 200,
      bytes: calendarBody(FIRST_CALENDAR_PATH, [{ kind: "pending", uri: KIT_CALENDAR_URI }]),
    }));
    const source = createOpenTimestampsProofSource({ fetch: transport.fetch });

    const proofBytes = await source.obtainProof({ subjectSha256: SUBJECT, endpoint: KIT_CALENDAR_URI });

    const request = transport.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`${KIT_CALENDAR_URI}/digest`);
    expect(request.headers.accept).toBe("application/vnd.opentimestamps.v1");
    expect(toHex(request.body!)).toBe(SUBJECT);

    const result = createOpenTimestampsProofVerifier().verifyProof({ subjectSha256: SUBJECT, proofBytes });
    expect(result.status).toBe("pending");
  });

  test("stamps through every configured calendar and forks their branches", async () => {
    const transport = recorder(async (request) => ({
      status: 200,
      bytes: request.url.startsWith(KIT_CALENDAR_URI)
        ? calendarBody(FIRST_CALENDAR_PATH, [{ kind: "pending", uri: KIT_CALENDAR_URI }])
        : calendarBody(SECOND_CALENDAR_PATH, [{ kind: "pending", uri: KIT_SECOND_CALENDAR_URI }]),
    }));
    const source = createOpenTimestampsProofSource({ fetch: transport.fetch });

    const proofBytes = await source.obtainProof({
      subjectSha256: SUBJECT,
      endpoint: `${KIT_CALENDAR_URI}, ${KIT_SECOND_CALENDAR_URI}`,
    });

    expect(transport.requests.map((request) => request.url)).toEqual([
      `${KIT_CALENDAR_URI}/digest`,
      `${KIT_SECOND_CALENDAR_URI}/digest`,
    ]);
    expect(parseDetachedOtsProof(proofBytes).pendingSites).toHaveLength(2);
  });

  test("carries on when one calendar of several is down", async () => {
    const transport = recorder(async (request) => (request.url.startsWith(KIT_CALENDAR_URI)
      ? { status: 502, bytes: new Uint8Array(0) }
      : { status: 200, bytes: calendarBody(SECOND_CALENDAR_PATH, [{ kind: "pending", uri: KIT_SECOND_CALENDAR_URI }]) }));
    const source = createOpenTimestampsProofSource({ fetch: transport.fetch });

    const proofBytes = await source.obtainProof({
      subjectSha256: SUBJECT,
      endpoint: `${KIT_CALENDAR_URI},${KIT_SECOND_CALENDAR_URI}`,
    });
    expect(parseDetachedOtsProof(proofBytes).pendingSites).toHaveLength(1);
  });

  test("refuses venue-unavailable when no calendar answers", async () => {
    const source = createOpenTimestampsProofSource({ fetch: async () => ({ status: 500, bytes: new Uint8Array(0) }) });
    await expect(source.obtainProof({ subjectSha256: SUBJECT, endpoint: KIT_CALENDAR_URI }))
      .rejects.toMatchObject({ code: "venue-unavailable" });
  });
});

describe("createOpenTimestampsProofSource — upgrading", () => {
  async function pendingProof(): Promise<Uint8Array> {
    const source = createOpenTimestampsProofSource({
      fetch: async () => ({
        status: 200,
        bytes: calendarBody(FIRST_CALENDAR_PATH, [{ kind: "pending", uri: KIT_CALENDAR_URI }]),
      }),
    });
    return source.obtainProof({ subjectSha256: SUBJECT, endpoint: KIT_CALENDAR_URI });
  }

  test("GETs /timestamp/<commitment> at the pending node, not at the file digest", async () => {
    const proofBytes = await pendingProof();
    const [site] = parseDetachedOtsProof(proofBytes).pendingSites;
    // The upgraded path continues from the pending node's own message, which is why the calendar
    // is keyed by that commitment rather than by the file digest.
    const transport = recorder(async () => ({ status: 200, bytes: upgradeFrom(KIT_BITCOIN_BLOCK_HEIGHT) }));
    const source = createOpenTimestampsProofSource({ fetch: transport.fetch });

    const upgraded = await source.upgradeProof({ subjectSha256: SUBJECT, proofBytes });

    const request = transport.requests.at(-1)!;
    expect(request.method).toBe("GET");
    expect(request.url).toBe(`${KIT_CALENDAR_URI}/timestamp/${site!.commitmentHex}`);
    expect(request.headers.accept).toBe("application/vnd.opentimestamps.v1");
    expect(site!.commitmentHex).not.toBe(SUBJECT);

    const result = createOpenTimestampsProofVerifier().verifyProof({ subjectSha256: SUBJECT, proofBytes: upgraded });
    expect(result.status).toBe("present");
    if (result.status !== "present") return;
    expect(result.facts.blockHeight).toBe(KIT_BITCOIN_BLOCK_HEIGHT);
  });

  test("a 404 is the normal not-yet: it refuses, records nothing, and the next call re-asks", async () => {
    const proofBytes = await pendingProof();
    const [site] = parseDetachedOtsProof(proofBytes).pendingSites;

    const seen: string[] = [];
    let confirmed = false;
    const source = createOpenTimestampsProofSource({
      fetch: async (request) => {
        seen.push(request.url);
        return confirmed
          ? { status: 200, bytes: upgradeFrom(KIT_BITCOIN_BLOCK_HEIGHT) }
          : { status: 404, bytes: new TextEncoder().encode("Pending confirmation in Bitcoin blockchain") };
      },
    });

    await expect(source.upgradeProof({ subjectSha256: SUBJECT, proofBytes }))
      .rejects.toMatchObject({ code: "venue-unavailable" });

    // Nothing about the 404 is durable, so the very same call succeeds once the calendar confirms.
    confirmed = true;
    const upgraded = await source.upgradeProof({ subjectSha256: SUBJECT, proofBytes });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(createOpenTimestampsProofVerifier().verifyProof({ subjectSha256: SUBJECT, proofBytes: upgraded }).status)
      .toBe("present");
  });

  test("refuses when a calendar answers with more path but still no chain attestation", async () => {
    const proofBytes = await pendingProof();
    const [site] = parseDetachedOtsProof(proofBytes).pendingSites;
    const source = createOpenTimestampsProofSource({
      fetch: async () => ({
        status: 200,
        bytes: bodyFrom([{ kind: "sha256" }], [{ kind: "pending", uri: KIT_SECOND_CALENDAR_URI }]),
      }),
    });
    await expect(source.upgradeProof({ subjectSha256: SUBJECT, proofBytes }))
      .rejects.toMatchObject({ code: "venue-unavailable" });
  });

  test("refuses to upgrade a proof detached from a different subject", async () => {
    const proofBytes = await pendingProof();
    const source = createOpenTimestampsProofSource({ fetch: async () => ({ status: 200, bytes: new Uint8Array(0) }) });
    await expect(source.upgradeProof({ subjectSha256: `${"0".repeat(63)}1`, proofBytes }))
      .rejects.toMatchObject({ code: "venue-unavailable" });
  });

  test("refuses to upgrade a proof that carries no calendar promise", async () => {
    const complete = buildLinearOtsProof({
      fileDigest,
      operations: [{ kind: "sha256" }],
      attestations: [{ kind: "bitcoin", height: KIT_BITCOIN_BLOCK_HEIGHT }],
    });
    const source = createOpenTimestampsProofSource({ fetch: async () => ({ status: 200, bytes: new Uint8Array(0) }) });
    await expect(source.upgradeProof({ subjectSha256: SUBJECT, proofBytes: complete }))
      .rejects.toMatchObject({ code: "venue-unavailable" });
  });
});

// --- helpers ---------------------------------------------------------------

/**
 * A calendar's upgrade answer: a bare node, minted through the kit's serializer and stripped of
 * the 36-byte detached-file header. The node's own starting message is whatever the reader
 * carries into it, so the body is independent of it.
 */
function bodyFrom(
  operations: readonly OtsOperation[],
  attestations: readonly OtsAttestation[],
): Uint8Array {
  return buildLinearOtsProof({ fileDigest: new Uint8Array(32), operations, attestations })
    .subarray(31 + 1 + 1 + 32);
}

function upgradeFrom(height: number): Uint8Array {
  return bodyFrom([{ kind: "sha256" }], [{ kind: "bitcoin", height }]);
}
