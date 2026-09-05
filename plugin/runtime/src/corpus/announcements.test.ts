// SPDX-License-Identifier: Apache-2.0
import {
  LOCATION_PROFILE_HTTPS,
  LOCATION_PROFILE_IPFS,
  RECORD_DISCOVERY_VERSION,
  RECORD_KINDS,
  SOURCE_NAME_GRAMMAR,
} from "@jinn-network/record-discovery-protocol";
import { describe, expect, test } from "vitest";

import { createFollowedSourceAdmission } from "./admission.js";
import { adaptAnnouncementEntry, sourceIdOf } from "./announcements.js";

const source = {
  agent: "https://agents.test/alice",
  name: "attempts",
  servingRoot: "https://archive.test",
  archiveRootUrl: "https://archive.test/sources/attempts/entries/0000000000000001",
  repositoryId: "archive.test/attempts",
  signingKeys: [],
};

const admission = createFollowedSourceAdmission([source]);

const digest = (fill: string) => `sha256:${fill.repeat(64)}` as const;

const entry = (announcements: unknown[]) =>
  ({
    protocol: RECORD_DISCOVERY_VERSION,
    source: { agent: source.agent, name: source.name },
    sequence: "0000000000000002",
    previous: digest("0"),
    timestamp: "2026-07-30T00:00:00Z",
    announcements,
  }) as never;

const available = (kind: string, fill = "a") => ({
  announcementId: `ann-${fill}`,
  action: "available" as const,
  record: { kind, digest: digest(fill) },
});

describe("source-name grammar pin", () => {
  test("the config module's local copy matches the protocol's grammar", () => {
    // config.ts keeps a local copy so it stays dependency-pure; this is the
    // assertion that keeps the copy honest.
    expect(SOURCE_NAME_GRAMMAR.source).toBe(
      /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/.source,
    );
  });
});

describe("announcement adaptation", () => {
  test("maps the three evidence record kinds onto their families", () => {
    const result = adaptAnnouncementEntry(
      entry([
        available(RECORD_KINDS.executionEvidence, "a"),
        available(RECORD_KINDS.resultEvaluation, "b"),
        available(RECORD_KINDS.executionVerification, "c"),
      ]),
      source,
      admission,
    );
    expect(result.announcements.map((a) => (a as { reference: { family: string } }).reference.family))
      .toEqual(["execution-evidence", "result-evaluation", "execution-verification"]);
    expect(result.excluded).toEqual([]);
  });

  test("stamps the configured source id and repository id on every announcement", () => {
    const result = adaptAnnouncementEntry(
      entry([available(RECORD_KINDS.executionEvidence)]),
      source,
      admission,
    );
    const first = result.announcements[0] as { sourceId: string; repositoryId: string };
    expect(first.sourceId).toBe("https://agents.test/alice/attempts");
    expect(first.sourceId).toBe(sourceIdOf(source));
    expect(first.repositoryId).toBe("archive.test/attempts");
  });

  test("excludes a record kind this runtime does not mirror", () => {
    const result = adaptAnnouncementEntry(
      entry([available(RECORD_KINDS.task), available(RECORD_KINDS.plugin, "b")]),
      source,
      admission,
    );
    expect(result.announcements).toEqual([]);
    expect(result.excluded.map((e) => e.reason)).toEqual(["unsupported-kind", "unsupported-kind"]);
  });

  test("carries a withdrawal through untouched", () => {
    const result = adaptAnnouncementEntry(
      entry([
        { announcementId: "ann-w", action: "withdrawn", retracts: "ann-a", reason: "superseded" },
      ]),
      source,
      admission,
    );
    expect(result.announcements[0]).toEqual({
      kind: "withdrawn",
      sourceId: "https://agents.test/alice/attempts",
      announcementId: "ann-w",
      retractsAnnouncementId: "ann-a",
    });
  });

  test("lifts an https location into the evidence location shape", () => {
    const result = adaptAnnouncementEntry(
      entry([
        {
          ...available(RECORD_KINDS.executionEvidence),
          locations: [{ profile: LOCATION_PROFILE_HTTPS, locator: "https://archive.test/records/aa" }],
        },
      ]),
      source,
      admission,
    );
    expect((result.announcements[0] as { publishedLocation: unknown }).publishedLocation).toEqual({
      bindingProfile: LOCATION_PROFILE_HTTPS,
      locator: { uri: "https://archive.test/records/aa" },
    });
  });

  test("lifts an ipfs location under its own locator key", () => {
    const result = adaptAnnouncementEntry(
      entry([
        {
          ...available(RECORD_KINDS.executionEvidence),
          locations: [{ profile: LOCATION_PROFILE_IPFS, locator: "bafy" }],
        },
      ]),
      source,
      admission,
    );
    expect((result.announcements[0] as { publishedLocation: unknown }).publishedLocation).toEqual({
      bindingProfile: LOCATION_PROFILE_IPFS,
      locator: { cid: "bafy" },
    });
  });

  test("indexes without a published location when no profile is recognized", () => {
    const result = adaptAnnouncementEntry(
      entry([
        {
          ...available(RECORD_KINDS.executionEvidence),
          locations: [{ profile: "https://example.test/unknown", locator: "x" }],
        },
      ]),
      source,
      admission,
    );
    expect(result.announcements).toHaveLength(1);
    expect(result.announcements[0]).not.toHaveProperty("publishedLocation");
  });

  test("TRUST: excludes every announcement from an archive this runtime does not follow", () => {
    const foreign = entry([available(RECORD_KINDS.executionEvidence)]) as unknown as {
      source: { agent: string; name: string };
    };
    foreign.source = { agent: "https://agents.test/mallory", name: "attempts" };

    const result = adaptAnnouncementEntry(foreign as never, source, admission);
    expect(result.announcements).toEqual([]);
    expect(result.excluded).toEqual([
      { announcementId: "ann-a", reason: "admission-rejected", detail: "source-mismatch" },
    ]);
  });

  test("TRUST: excludes everything when the admission rejects the configured archive", () => {
    const denyAll = createFollowedSourceAdmission([]);
    const result = adaptAnnouncementEntry(
      entry([available(RECORD_KINDS.executionEvidence)]),
      source,
      denyAll,
    );
    expect(result.announcements).toEqual([]);
    expect(result.excluded[0]).toEqual({
      announcementId: "ann-a",
      reason: "admission-rejected",
      detail: "source-not-followed",
    });
  });
});
