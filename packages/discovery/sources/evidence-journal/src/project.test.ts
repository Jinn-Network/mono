import { describe, expect, it } from "vitest";
import { RECORD_KINDS, sealJson } from "@jinn-network/record-discovery-protocol";

import type { EvidenceJournalEntry } from "./ports.js";
import { familyToKind, projectAvailableAnnouncement, projectLocation, projectWithdrawnAnnouncement } from "./project.js";

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

describe("familyToKind (§11 crosswalk row 1, §12)", () => {
  it("maps every evidence record family to its pinned record-kind URI", () => {
    expect(familyToKind("execution-evidence")).toBe(RECORD_KINDS.executionEvidence);
    expect(familyToKind("result-evaluation")).toBe(RECORD_KINDS.resultEvaluation);
    expect(familyToKind("execution-verification")).toBe(RECORD_KINDS.executionVerification);
  });

  it("rejects an unknown family", () => {
    expect(() => familyToKind("unknown-family" as never)).toThrow();
  });
});

describe("projectLocation (§11: publishedLocation -> locations[])", () => {
  it("encodes the arbitrary locator object as canonical JSON text, deterministically", () => {
    const location = {
      bindingProfile: "https://example.invalid/oci",
      locator: { repository: "jinn/evidence", digest: "sha256:fixture" },
    };
    const projected = projectLocation(location);
    expect(projected.profile).toBe(location.bindingProfile);
    expect(projected.locator).toBe(new TextDecoder().decode(sealJson(location.locator).bytes));
    // Key order in the source object must not affect the encoded string (JCS).
    const reordered = projectLocation({
      bindingProfile: location.bindingProfile,
      locator: { digest: "sha256:fixture", repository: "jinn/evidence" },
    });
    expect(reordered.locator).toBe(projected.locator);
  });
});

describe("projectAvailableAnnouncement (§11 crosswalk row 1)", () => {
  const baseEntry: EvidenceJournalEntry = {
    version: 1,
    revision: 1,
    announcement: {
      kind: "available",
      sourceId: "evidence-source",
      announcementId: "available-1",
      reference: { family: "execution-evidence", digest: digest("a") },
      repositoryId: "local-repository",
    },
  };

  it("maps announcementId, action, and record{kind,digest} verbatim from reference", () => {
    const announcement = projectAvailableAnnouncement(baseEntry);
    expect(announcement).toEqual({
      announcementId: "available-1",
      action: "available",
      record: { kind: RECORD_KINDS.executionEvidence, digest: digest("a") },
    });
  });

  it("drops repositoryId (design §11: stays local, never published)", () => {
    const announcement = projectAvailableAnnouncement(baseEntry);
    expect(announcement).not.toHaveProperty("repositoryId");
    expect(JSON.stringify(announcement)).not.toContain("local-repository");
  });

  it("projects publishedLocation into a single-item locations[]", () => {
    const withLocation: EvidenceJournalEntry = {
      ...baseEntry,
      announcement: {
        ...baseEntry.announcement,
        publishedLocation: {
          bindingProfile: "https://example.invalid/oci",
          locator: { repository: "jinn/evidence", digest: "sha256:fixture" },
        },
      },
    };
    const announcement = projectAvailableAnnouncement(withLocation);
    expect(announcement.locations).toHaveLength(1);
    expect(announcement.locations![0]!.profile).toBe("https://example.invalid/oci");
  });

  it("omits locations entirely when no publishedLocation is present", () => {
    const announcement = projectAvailableAnnouncement(baseEntry);
    expect(announcement.locations).toBeUndefined();
  });

  it("never emits a facts card (§11: no facts card in v1)", () => {
    const announcement = projectAvailableAnnouncement(baseEntry);
    expect(announcement).not.toHaveProperty("facts");
  });
});

describe("projectWithdrawnAnnouncement (§11 crosswalk row 2)", () => {
  it("maps announcementId, retracts, and always reason=delisted", () => {
    const withdrawal = projectWithdrawnAnnouncement({
      sourceId: "evidence-source",
      announcementId: "withdrawn-1",
      retractsAnnouncementId: "available-1",
    });
    expect(withdrawal).toEqual({
      announcementId: "withdrawn-1",
      action: "withdrawn",
      retracts: "available-1",
      reason: "delisted",
    });
  });

  it("never emits reason=reorged (the evidence layer has no substrate, §11)", () => {
    const withdrawal = projectWithdrawnAnnouncement({
      sourceId: "evidence-source",
      announcementId: "withdrawn-2",
      retractsAnnouncementId: "available-2",
    });
    expect(withdrawal.reason).not.toBe("reorged");
  });

  it("drops sourceId (stays local, mirrors repositoryId's treatment)", () => {
    const withdrawal = projectWithdrawnAnnouncement({
      sourceId: "evidence-source",
      announcementId: "withdrawn-3",
      retractsAnnouncementId: "available-3",
    });
    expect(withdrawal).not.toHaveProperty("sourceId");
  });
});
