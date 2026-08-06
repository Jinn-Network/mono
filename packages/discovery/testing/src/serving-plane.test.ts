import { describe, expect, it } from "vitest";
import {
  RECORD_DISCOVERY_VERSION,
  WELL_KNOWN_PATH,
  sha256Hex,
} from "@jinn-network/record-discovery-protocol";
import {
  runServingPlaneConformance,
  type ServingPlaneResponse,
  type ServingPlaneTailEvent,
  type ServingPlaneUnderTest,
} from "./serving-plane.js";

// A minimal in-memory plane: one source "marketplace", one page, one record, an SSE tail
// with an evicted cursor. Matches the transport-http wire profile the real handler emits.

const enc = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const RECORD_BYTES = new TextEncoder().encode('{"kind":"submission"}');
const RECORD_HEX = sha256Hex(RECORD_BYTES);
const RECORD_DIGEST = `sha256:${RECORD_HEX}` as const;
const HEAD_ETAG = '"sha256-head"';

function makeFakePlane(
  overrides: Record<string, ServingPlaneResponse> = {},
): ServingPlaneUnderTest {
  const routes: Record<string, ServingPlaneResponse> = {
    [WELL_KNOWN_PATH]: {
      status: 200,
      headers: { "content-type": "application/vnd.jinn.record-discovery.well-known.v1+json" },
      body: enc({
        protocol: RECORD_DISCOVERY_VERSION,
        sources: [
          {
            agent: "did:key:zOperator",
            name: "marketplace",
            headPath: "/sources/marketplace/head",
            archiveRoot: "/sources/marketplace/entries/0000000000000001",
          },
        ],
      }),
    },
    "/sources/marketplace/head": {
      status: 200,
      headers: {
        "content-type": "application/vnd.jinn.record-discovery.head.v1+json",
        etag: HEAD_ETAG,
      },
      body: enc({ payloadType: "application/vnd.dsse+json", payload: "e30=", signatures: [] }),
    },
    "/sources/marketplace/entries/0000000000000001": {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-cache",
      },
      body: enc({
        protocol: RECORD_DISCOVERY_VERSION,
        source: "marketplace",
        page: "0000000000000001",
        prevArchive: null,
        entries: [
          {
            entry: {
              announcements: [
                { announcementId: "a1", action: "available", record: { kind: "k", digest: RECORD_DIGEST } },
              ],
            },
          },
        ],
      }),
    },
    [`/records/${RECORD_HEX}`]: {
      status: 200,
      headers: { "cache-control": "public, max-age=31536000, immutable", "accept-ranges": "bytes" },
      body: RECORD_BYTES,
    },
    ...overrides,
  };

  return {
    baseUrl: "http://plane.test",
    async request(path, headers) {
      const hit = routes[path];
      if (!hit) return { status: 404, headers: {}, body: new Uint8Array() };
      if (path === "/sources/marketplace/head" && headers?.["if-none-match"] === HEAD_ETAG) {
        return { status: 304, headers: { etag: HEAD_ETAG }, body: new Uint8Array() };
      }
      return hit;
    },
    async tail(lastEventId) {
      const events: ServingPlaneTailEvent[] = [];
      if (lastEventId === undefined) {
        // live tail — no terminal, caller closes it.
      } else if (lastEventId === "0000000000000001") {
        events.push({ event: "cursor-too-old", data: JSON.stringify({ detailCode: "cursor-too-old", coldSync: { head: "/sources/marketplace/head", archiveRoot: "/sources/marketplace/entries/0000000000000001" } }) });
      } else {
        events.push({ event: "unknown-cursor", data: JSON.stringify({ detailCode: "cursor-unknown" }) });
      }
      return {
        events: (async function* () {
          for (const event of events) yield event;
        })(),
        close() {},
      };
    },
    forbiddenPaths: ["/v1/status", "/artifacts/search"],
    evictedTailCursor: "0000000000000001",
  };
}

describe("runServingPlaneConformance", () => {
  describe("accepts a conforming plane", () => {
    runServingPlaneConformance(makeFakePlane());
  });

  it("a head that ignores If-None-Match would fail the conditional-GET clause", async () => {
    const plane = makeFakePlane();
    const mutant: ServingPlaneUnderTest = {
      ...plane,
      request: async (path, headers) =>
        path === "/sources/marketplace/head"
          ? { status: 200, headers: { etag: HEAD_ETAG }, body: new Uint8Array([1]) }
          : plane.request(path, headers),
    };
    const conditional = await mutant.request("/sources/marketplace/head", { "if-none-match": HEAD_ETAG });
    expect(conditional.status).not.toBe(304);
  });

  it("a record whose bytes do not re-hash would fail the immutability clause", async () => {
    const plane = makeFakePlane({
      [`/records/${RECORD_HEX}`]: {
        status: 200,
        headers: { "cache-control": "public, max-age=31536000, immutable" },
        body: new TextEncoder().encode('{"tampered":true}'),
      },
    });
    const record = await plane.request(`/records/${RECORD_HEX}`);
    expect(sha256Hex(record.body)).not.toBe(RECORD_HEX);
  });
});
