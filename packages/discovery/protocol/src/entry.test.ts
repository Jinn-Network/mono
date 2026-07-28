import { describe, it, expect } from "vitest";
import { parseAnnouncementEntry } from "./entry.js";
import { RECORD_DISCOVERY_VERSION, GENESIS_SEQUENCE } from "./identifiers.js";

const DIGEST_A = `sha256:${"a".repeat(64)}` as const;
const DIGEST_B = `sha256:${"b".repeat(64)}` as const;

function genesisEntry(overrides: Record<string, unknown> = {}) {
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    source: { agent: "urn:uuid:1234", name: "feed" },
    sequence: GENESIS_SEQUENCE,
    previous: null,
    timestamp: "2026-07-27T12:00:00Z",
    announcements: [
      {
        announcementId: "a1",
        action: "available",
        record: { kind: "https://jinn.network/records/task/1.0", digest: DIGEST_A },
      },
    ],
    ...overrides,
  };
}

describe("parseAnnouncementEntry", () => {
  it("accepts a well-formed genesis entry", () => {
    const entry = parseAnnouncementEntry(genesisEntry());
    expect(entry.sequence).toBe(GENESIS_SEQUENCE);
    expect(entry.previous).toBeNull();
  });

  it("accepts a well-formed non-genesis entry", () => {
    const entry = parseAnnouncementEntry(
      genesisEntry({ sequence: "0000000000000002", previous: DIGEST_A }),
    );
    expect(entry.sequence).toBe("0000000000000002");
    expect(entry.previous).toBe(DIGEST_A);
  });

  it("rejects a duplicate announcementId within one entry", () => {
    expect(() =>
      parseAnnouncementEntry(
        genesisEntry({
          announcements: [
            {
              announcementId: "a1",
              action: "available",
              record: { kind: "https://jinn.network/records/task/1.0", digest: DIGEST_A },
            },
            {
              announcementId: "a1",
              action: "available",
              record: { kind: "https://jinn.network/records/task/1.0", digest: DIGEST_B },
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects a withdrawn announcement missing its reason", () => {
    expect(() =>
      parseAnnouncementEntry(
        genesisEntry({
          announcements: [
            { announcementId: "a1", action: "withdrawn", retracts: "a0" },
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects a genesis entry (sequence === GENESIS_SEQUENCE) whose previous is not null", () => {
    expect(() =>
      parseAnnouncementEntry(genesisEntry({ previous: DIGEST_A })),
    ).toThrow();
  });

  it("rejects a non-genesis entry whose previous is null", () => {
    expect(() =>
      parseAnnouncementEntry(
        genesisEntry({ sequence: "0000000000000002", previous: null }),
      ),
    ).toThrow();
  });

  it("rejects an entry with an empty announcements array", () => {
    expect(() => parseAnnouncementEntry(genesisEntry({ announcements: [] }))).toThrow();
  });
});
