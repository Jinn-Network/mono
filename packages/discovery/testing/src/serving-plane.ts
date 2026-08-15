import { describe, expect, it } from "vitest";
import {
  RECORD_DISCOVERY_VERSION,
  WELL_KNOWN_PATH,
  sha256Hex,
} from "@jinn-network/record-discovery-protocol";

// The kit's first TRANSPORT-shaped conformance suite (cutover stage 4 / one-swap M6).
//
// The other `run*Conformance` suites drive golden vectors through in-memory ports; none
// of them accepts a URL, a live server, or an HTTP surface. "The archive is consumable by
// a second daemon" and "the serving plane is conformant against the live surface" cannot be
// asserted without one that does. This suite is that surface contract: give it a running
// serving plane (any transport that answers the protocol's serving paths) and it verifies
// the §7 / §7.3 wire profile against it — the well-known document, the head as the only
// mutable object (ETag + conditional GET), immutable content-addressed objects, typed 404s
// for unknown objects, structural exposure scoping, and — when the plane serves a live tail
// — the §9.3 five-case SSE cursor contract.
//
// It deliberately re-declares the transport shapes structurally rather than importing them
// from `record-discovery-client`: the kit must not depend on any consumer package. The only
// dependency is `record-discovery-protocol` (the serving paths and media identifiers).

export interface ServingPlaneResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface ServingPlaneTailEvent {
  id?: string;
  event?: string;
  data: string;
}

export interface ServingPlaneTailSubscription {
  events: AsyncIterable<ServingPlaneTailEvent>;
  close(): void;
}

export interface ServingPlaneUnderTest {
  /** Absolute base URL the serving paths resolve against, no trailing slash. */
  baseUrl: string;
  /**
   * Raw conditional-GET probe. The suite needs response headers, which the consumer's
   * `Transport` port cannot express, so this is a header-carrying request instead.
   */
  request(path: string, headers?: Record<string, string>): Promise<ServingPlaneResponse>;
  /** Opens the SSE tail. `lastEventId` maps to the `Last-Event-ID` request header. */
  tail?(lastEventId: string | undefined): Promise<ServingPlaneTailSubscription>;
  /** Paths that MUST NOT be reachable on this plane. Empty/absent skips the scoping block. */
  forbiddenPaths?: readonly string[];
  /**
   * A relay cursor that has been evicted from the live window (older than the retained
   * replay window). Absent skips the `cursor-too-old` case — a plane cannot demonstrate
   * eviction it has not produced.
   */
  evictedTailCursor?: string;
}

const IMMUTABLE = /\bimmutable\b/;

function decode(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Reads all frames of a tail subscription to its close, then unsubscribes. */
async function drain(subscription: ServingPlaneTailSubscription): Promise<ServingPlaneTailEvent[]> {
  const seen: ServingPlaneTailEvent[] = [];
  try {
    for await (const event of subscription.events) seen.push(event);
  } finally {
    subscription.close();
  }
  return seen;
}

export function runServingPlaneConformance(plane: ServingPlaneUnderTest): void {
  describe("serving plane — well-known document (§7)", () => {
    it("serves the well-known document with the profile media type", async () => {
      const res = await plane.request(WELL_KNOWN_PATH);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"] ?? "").toContain("well-known");
      const doc = decode(res.body) as {
        protocol: string;
        sources: Array<{ name: string; headPath: string; archiveRoot: string }>;
      };
      expect(doc.protocol).toBe(RECORD_DISCOVERY_VERSION);
      expect(doc.sources.length).toBeGreaterThan(0);
    });
  });

  describe("serving plane — the head is the only mutable object (§7.3)", () => {
    it("returns an ETag on the head", async () => {
      const doc = decode((await plane.request(WELL_KNOWN_PATH)).body) as {
        sources: Array<{ headPath: string }>;
      };
      const res = await plane.request(doc.sources[0]!.headPath);
      expect(res.status).toBe(200);
      expect(res.headers["etag"]).toBeTruthy();
    });

    it("answers a matching If-None-Match with 304 and an empty body", async () => {
      const doc = decode((await plane.request(WELL_KNOWN_PATH)).body) as {
        sources: Array<{ headPath: string }>;
      };
      const first = await plane.request(doc.sources[0]!.headPath);
      const second = await plane.request(doc.sources[0]!.headPath, {
        "if-none-match": first.headers["etag"]!,
      });
      expect(second.status).toBe(304);
      expect(second.body.byteLength).toBe(0);
    });
  });

  describe("serving plane — content-addressed objects are immutable (§7.3)", () => {
    it("serves each announced record by digest, immutable and re-hashing to its path", async () => {
      const doc = decode((await plane.request(WELL_KNOWN_PATH)).body) as {
        sources: Array<{ archiveRoot: string }>;
      };
      const page = await plane.request(doc.sources[0]!.archiveRoot);
      expect(page.status).toBe(200);
      const digests = collectRecordDigests(decode(page.body));
      expect(digests.length).toBeGreaterThan(0);
      for (const digest of digests) {
        const hex = digest.slice("sha256:".length);
        const record = await plane.request(`/records/${hex}`);
        expect(record.status).toBe(200);
        expect(record.headers["cache-control"] ?? "").toMatch(IMMUTABLE);
        expect(sha256Hex(record.body)).toBe(hex);
      }
    });
  });

  describe("serving plane — unknown objects fail typed, never as another object (§7)", () => {
    it("returns a 404 for an unknown archive page", async () => {
      const res = await plane.request("/sources/marketplace/entries/0000000000000099");
      expect(res.status).toBe(404);
    });

    it("returns a 404 for an unknown record digest", async () => {
      const res = await plane.request(`/records/${"f".repeat(64)}`);
      expect(res.status).toBe(404);
    });
  });

  const forbiddenPaths = plane.forbiddenPaths;
  if (forbiddenPaths && forbiddenPaths.length > 0) {
    describe("serving plane — exposure scoping (cross-plan contract 7)", () => {
      for (const path of forbiddenPaths) {
        it(`does not serve ${path}`, async () => {
          const res = await plane.request(path);
          expect(res.status).toBe(404);
        });
      }
    });
  }

  if (plane.tail) {
    describe("serving plane — SSE tail cursor contract (§9.3)", () => {
      it("opens a live tail with no Last-Event-ID", async () => {
        const subscription = await plane.tail!(undefined);
        subscription.close();
      });

      it("closes with a typed unknown-cursor terminal for a never-issued cursor", async () => {
        const subscription = await plane.tail!("0009999999999999");
        const seen = await drain(subscription);
        const terminal = seen.at(-1);
        expect(terminal?.event).toBe("unknown-cursor");
        expect(JSON.parse(terminal!.data).detailCode).toBe("cursor-unknown");
      });

      if (plane.evictedTailCursor !== undefined) {
        it("closes with cursor-too-old and names the cold-sync path", async () => {
          const subscription = await plane.tail!(plane.evictedTailCursor);
          const seen = await drain(subscription);
          const terminal = seen.at(-1);
          expect(terminal?.event).toBe("cursor-too-old");
          const detail = JSON.parse(terminal!.data);
          expect(detail.detailCode).toBe("cursor-too-old");
          // The evicted case must name where to resume — the head plus the archive page
          // the client's own cursor maps to — so a consumer never has to guess.
          expect(detail.coldSync).toBeDefined();
          expect(detail.coldSync.head).toBeTruthy();
        });
      }
    });
  }
}

/** Walks an archive page body for every announced record digest, defensively. */
function collectRecordDigests(page: unknown): Array<`sha256:${string}`> {
  const digests: Array<`sha256:${string}`> = [];
  const entries =
    page !== null && typeof page === "object" && Array.isArray((page as { entries?: unknown }).entries)
      ? ((page as { entries: unknown[] }).entries)
      : [];
  for (const signed of entries) {
    const entry = (signed as { entry?: unknown }).entry;
    const announcements =
      entry !== null && typeof entry === "object" && Array.isArray((entry as { announcements?: unknown }).announcements)
        ? ((entry as { announcements: unknown[] }).announcements)
        : [];
    for (const announcement of announcements) {
      const record = (announcement as { record?: { digest?: unknown } }).record;
      const digest = record?.digest;
      if (typeof digest === "string" && digest.startsWith("sha256:")) {
        digests.push(digest as `sha256:${string}`);
      }
    }
  }
  return digests;
}
