import { describe, expect, it } from "vitest";
import { ANCHOR_EVIDENCE_KIND } from "@jinn-network/trust-core";
import {
  ANCHOR_ANNOUNCEMENT_FACTS_PROFILE,
  anchorAnnouncementFacts,
  anchorAnnouncementFactsProfile,
} from "./anchor-announcement-facts.js";
import { referenceBearingFields } from "./facts-profile.js";

describe("anchor-announcement facts profile", () => {
  it("labels an AnchorEvidence announcement and marks the subject and upgrade edges", () => {
    expect(anchorAnnouncementFactsProfile.kind).toBe(ANCHOR_EVIDENCE_KIND);
    expect(anchorAnnouncementFactsProfile.profile).toBe(ANCHOR_ANNOUNCEMENT_FACTS_PROFILE);
    expect(referenceBearingFields(anchorAnnouncementFactsProfile)).toEqual(["subject", "upgrades"]);
  });

  it("omits upgrades when the announcement is not an OpenTimestamps successor", () => {
    expect(anchorAnnouncementFacts({
      subject: { kind: "https://spec.jinn.network/records/announcement-entry/v1", digest: "aa" },
      provider: "https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1",
    })).toEqual({
      subject: { kind: "https://spec.jinn.network/records/announcement-entry/v1", digest: "aa" },
      provider: "https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1",
    });
  });
});
