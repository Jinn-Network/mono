import { describe, expect, it } from "vitest";

import { RECORD_DISCOVERY_VERSION, RECORD_KINDS } from "./identifiers.js";
import type { AnnouncedItem } from "./item.js";
import type { FactsProfileDocument } from "./facts-profile.js";
import { announcementDedupeKey, toAnnouncementEvent } from "./cloudevents.js";

// CloudEvents envelope mapping for the announcement stream (design §9.1,
// plan Task 7). Observation streams (TEP lifecycle observations relayed
// as-is) are NOT modeled here -- a relay forwards them unaltered, per §9.1;
// this module covers only the announcement-stream mapping.

const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const entryDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;

function item(facts?: unknown): AnnouncedItem {
  return {
    record: { kind: RECORD_KINDS.submission, digest },
    facts,
    provenance: {
      source: { agent: "did:key:zSourceAgent", name: "feed" },
      entry: entryDigest,
      announcementId: "ann-1",
    },
  };
}

function profile(fields: FactsProfileDocument["fields"]): FactsProfileDocument {
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    kind: RECORD_KINDS.submission,
    profile: "https://jinn.network/records/submission/facts-profile/1.0",
    fields,
  };
}

describe("toAnnouncementEvent", () => {
  it("sets subject to the record digest and the discovery extension attributes", () => {
    const event = toAnnouncementEvent(item(), undefined);
    expect(event.specversion).toBe("1.0");
    expect(event.subject).toBe(digest);
    expect(event.recordkind).toBe(RECORD_KINDS.submission);
    expect(event.sourceagent).toBe("did:key:zSourceAgent");
    expect(event.sourcename).toBe("feed");
    expect(event.entrydigest).toBe(entryDigest);
    expect(event.announcementid).toBe("ann-1");
    expect(event.data).toEqual(item());
  });

  it("lifts exactly the cloudEvents-flagged facts fields under their declared attribute names", () => {
    const p = profile([
      { name: "taskDigest", class: "record", cloudEvents: { attribute: "taskdigest", scalar: "string" } },
      { name: "escrowTerms", class: "substrate" },
    ]);
    const event = toAnnouncementEvent(
      item({ taskDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", escrowTerms: "net-30" }),
      p,
    );
    expect(event["taskdigest"]).toBe(
      "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    );
    expect(Object.prototype.hasOwnProperty.call(event, "escrowterms")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(event, "escrowTerms")).toBe(false);
  });

  it("never lifts a fact field that is not declared cloudEvents-liftable, even when a profile is present", () => {
    const p = profile([{ name: "deadline", class: "record" }]);
    const event = toAnnouncementEvent(item({ deadline: "2026-08-01T00:00:00Z" }), p);
    expect(Object.prototype.hasOwnProperty.call(event, "deadline")).toBe(false);
  });

  it("lifts nothing when no profile is supplied", () => {
    const event = toAnnouncementEvent(item({ deadline: "2026-08-01T00:00:00Z" }), undefined);
    expect(Object.keys(event)).not.toContain("deadline");
  });
});

describe("announcementDedupeKey", () => {
  it("is the (source identity, entry digest, announcementId) tuple, space-joined", () => {
    const event = toAnnouncementEvent(item(), undefined);
    expect(announcementDedupeKey(event)).toBe(`did:key:zSourceAgent feed ${entryDigest} ann-1`);
  });

  it("differs when the announcementId differs, all else equal", () => {
    const a = toAnnouncementEvent(item(), undefined);
    const b = toAnnouncementEvent(
      { ...item(), provenance: { ...item().provenance, announcementId: "ann-2" } },
      undefined,
    );
    expect(announcementDedupeKey(a)).not.toBe(announcementDedupeKey(b));
  });
});
