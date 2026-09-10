import { describe, expect, it } from "vitest";
import { executePublicationPlan, sha256, validatePublicationPlan } from "./publication.js";
import type { CasResult, CasSnapshot, PublicationJournal, PublicationJournalStore, PublicationPlan } from "./types.js";

class MemoryJournal implements PublicationJournalStore {
  value: CasSnapshot<PublicationJournal> | undefined; revision = 0;
  async read(): Promise<CasSnapshot<PublicationJournal> | undefined> { return this.value; }
  async compareAndSwap(_id: string, expected: string | null, next: PublicationJournal): Promise<CasResult> {
    if ((this.value?.revision ?? null) !== expected) return { ok: false };
    const revision = String(++this.revision); this.value = { revision, value: next }; return { ok: true, revision };
  }
}
const bytes = new TextEncoder().encode("exact public record");
const digest = sha256(bytes);
function plan(mode: "owner" | "origin-reference" = "owner"): PublicationPlan {
  return { id: "plan-1", stages: [{ stage: "registration", members: [{ id: "record", kind: "https://example.test/kind", digest, bytes, mediaType: "application/json", ...(mode === "owner" ? { announcementTimestamp: "2026-08-13T00:00:00.000Z" } : {}), authority: mode === "owner" ? { mode } : { mode, origin: { source: { agent: "did:example:origin", name: "source" }, sequence: "0000000000000001", entryDigest: digest } }, actions: mode === "owner" ? ["store", "announce"] : ["mirror", "verify-origin"] }] }] };
}

describe("record publication", () => {
  it("stores before announcing and resumes from CAS checkpoints", async () => {
    const journal = new MemoryJournal(); const calls: string[] = []; let fail = true;
    await expect(executePublicationPlan(plan(), { journal, objects: { async putExact() { calls.push("store"); } }, authority: { async authorizeAnnouncement() { calls.push("authorize"); } }, announce: { async announce() { calls.push("announce"); } }, faults: { async at({ action }) { if (action === "announce" && fail) { fail = false; throw new Error("crash"); } } } })).rejects.toThrow("crash");
    const receipt = await executePublicationPlan(plan(), { journal, objects: { async putExact() { calls.push("unexpected-store"); } }, authority: { async authorizeAnnouncement() { calls.push("authorize"); } }, announce: { async announce() { calls.push("announce"); } } });
    expect(calls).toEqual(["store", "authorize", "announce", "authorize", "announce"]); expect(receipt.complete).toBe(true);
  });

  it("preserves origin authority by verifying and mirroring without announcement", async () => {
    const journal = new MemoryJournal(); const calls: string[] = [];
    await executePublicationPlan(plan("origin-reference"), { journal, objects: { async putExact() { throw new Error("destination must receive mirror"); } }, destination: { async deliver({ action }) { calls.push(action); } }, verifyOrigin: { async verifyOrigin() { calls.push("verify"); } } });
    expect(calls).toEqual(["verify", "mirror"]);
  });

  it("refuses an announcement timestamp the durable writer would refuse (#4095)", () => {
    // The plan's `announcementTimestamp` becomes the entry `timestamp`, which
    // `assertIntentOwnership` pins equal to the head's `issuedAt` -- strict,
    // offset-bearing, calendar-real RFC 3339 since #3482. A plan that validates
    // must be a plan the writer accepts.
    for (const invalid of [
      "2026-08-13T00:00:00.000",  // offset-less: host-LOCAL by definition
      "2026-02-30T00:00:00.000Z", // silently rolled forward to March by Date.parse
      "August 13, 2026",          // legacy host-parser spelling
      "2026-08-13",               // date only
    ]) {
      const invalidPlan = plan();
      (invalidPlan.stages[0]!.members[0]! as any).announcementTimestamp = invalid;
      expect(() => validatePublicationPlan(invalidPlan), invalid).toThrow("immutable announcement timestamp");
    }

    // A leap second is admitted by §5.2 and so is admitted here.
    const leap = plan();
    (leap.stages[0]!.members[0]! as any).announcementTimestamp = "2026-06-30T23:59:60Z";
    expect(() => validatePublicationPlan(leap)).not.toThrow();
  });

  it("refuses an origin reference that asks to announce", () => {
    const invalid = plan("origin-reference");
    const member = invalid.stages[0]!.members[0]! as any; member.actions = ["announce", "verify-origin"];
    expect(() => validatePublicationPlan(invalid)).toThrow("cannot be locally announced");
  });
});
