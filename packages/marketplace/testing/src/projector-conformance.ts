// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadVectorsByKind } from "@jinn-network/record-discovery-testing";
import { describe, expect, test } from "vitest";

export interface MarketplaceProjectorFixture {
  readonly name: string;
  readonly description: string;
  readonly generation: "today" | "revised";
  readonly logs: readonly unknown[];
  readonly expect: {
    readonly observationCount: number;
    readonly announcementCount: number;
    readonly observationSha256: `sha256:${string}`;
    readonly announcementSha256: `sha256:${string}`;
    readonly requiredObservationTypes?: readonly string[];
    readonly announcementActions?: readonly string[];
    readonly attemptReorg?: boolean;
  };
}

export interface MarketplaceProjectorReorgFixture {
  readonly name: string;
  readonly description: string;
  readonly generation: "today" | "revised";
  readonly logs: readonly unknown[];
  readonly reorg: {
    readonly blockHash: `0x${string}`;
    readonly timestamp: string;
  };
  readonly expect: {
    readonly correctionSha256: `sha256:${string}`;
  };
}

export interface ProjectedDerivation {
  readonly chainId: number;
  readonly contract: `0x${string}`;
  readonly event: string;
  readonly blockNumber: number;
  readonly blockHash: `0x${string}`;
  readonly txHash: `0x${string}`;
  readonly logIndex: number;
  readonly finalityTier: "safe" | "finalized";
  readonly contractGeneration: "today" | "revised";
}

export interface MarketplaceProjectorConformanceRun {
  readonly observations: readonly unknown[];
  readonly announcements: readonly unknown[];
  readonly derivations: readonly ProjectedDerivation[];
  /** Exact serialized output bytes exposed by the implementation under test. */
  readonly observationBytes: Uint8Array;
  /** Exact serialized output bytes exposed by the implementation under test. */
  readonly announcementBytes: Uint8Array;
  /** Exact serialized final caller-owned reducer state. */
  readonly stateBytes: Uint8Array;
}

export interface MarketplaceProjectorReplayRun {
  readonly first: MarketplaceProjectorConformanceRun;
  readonly replayObservations: readonly unknown[];
  readonly replayAnnouncements: readonly unknown[];
  readonly stateBytesAfterReplay: Uint8Array;
}

export interface MarketplaceProjectorReorgRun {
  readonly priorEntry: unknown;
  readonly priorEntryBytesBefore: Uint8Array;
  readonly priorEntryBytesAfter: Uint8Array;
  readonly priorAnnouncementId: string;
  readonly correctionEntry: {
    readonly sequence: string;
    readonly previous: string | null;
    readonly announcements: ReadonlyArray<{
      readonly action: string;
      readonly retracts?: string;
      readonly reason?: string;
    }>;
  };
  readonly correctionEntryBytes: Uint8Array;
  readonly expectedPreviousDigest: string;
  readonly signatureCount: number;
  /** Task-post reorg has no TEP correction under ruling §7.30. */
  readonly tepCorrections: readonly unknown[];
}

export interface MarketplaceAttemptReorgRun {
  readonly priorObservation: {
    readonly source: string;
    readonly subject: string;
    readonly sequence: string;
  };
  readonly priorBytesBefore: Uint8Array;
  readonly priorBytesAfter: Uint8Array;
  readonly lostObservation: {
    readonly source: string;
    readonly subject: string;
    readonly sequence: string;
    readonly data: { readonly state: string };
    readonly correction?: {
      readonly retractsObservationId: string;
      readonly orphanedBlockHash: string;
    };
  };
  readonly laterTerminal: {
    readonly source: string;
    readonly subject: string;
    readonly sequence: string;
    readonly data: { readonly state: string };
  };
  readonly folded: {
    readonly state: string;
    readonly terminal: boolean;
    readonly contradictory: boolean;
  };
  readonly rawFolded: {
    readonly state: string;
    readonly terminal: boolean;
    readonly contradictory: boolean;
  };
  readonly canonicalLostFolded: {
    readonly state: string;
    readonly terminal: boolean;
    readonly contradictory: boolean;
  };
  readonly canonicalPreservedRaw: boolean;
  readonly missingProvenanceRefused: boolean;
  readonly invalidCorrectionsRefused: {
    readonly absentTarget: boolean;
    readonly duplicateTarget: boolean;
    readonly nonOrphanedHash: boolean;
    readonly wrongSource: boolean;
    readonly wrongSubject: boolean;
    readonly wrongTargetBlock: boolean;
    readonly mismatchedDerivation: boolean;
  };
}

/**
 * Native marketplace-projector conformance seam. The subject owns fixture adaptation so another
 * implementation can run the same published vectors without importing the reference projector.
 */
export interface MarketplaceProjectorConformanceSubject {
  project(
    fixture: MarketplaceProjectorFixture,
    options?: { readonly batchSizes?: readonly number[] },
  ): Promise<MarketplaceProjectorConformanceRun>;
  replay(
    fixture: MarketplaceProjectorFixture,
  ): Promise<MarketplaceProjectorReplayRun>;
  projectReorg(
    fixture: MarketplaceProjectorReorgFixture,
  ): Promise<MarketplaceProjectorReorgRun>;
  projectAttemptReorg(
    fixture: MarketplaceProjectorFixture,
  ): Promise<MarketplaceAttemptReorgRun>;
  /**
   * Runs the projected annotation through the consumer's discovery item-verification path under
   * the requested substrate outcome. Reference implementations should delegate to
   * `record-discovery-protocol.verifyItem`, not echo `substrateOutcome`.
   */
  verifyDerivation(
    fixture: MarketplaceProjectorFixture,
    derivation: ProjectedDerivation,
    substrateOutcome: DerivationOutcome,
  ): Promise<DerivationOutcome>;
}

const fixturesRoot = fileURLToPath(
  new URL("../fixtures/projector/", import.meta.url),
);

function loadDirectory<T>(directory: string): T[] {
  return readdirSync(`${fixturesRoot}${directory}`, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort()
    .map((name) =>
      JSON.parse(
        readFileSync(`${fixturesRoot}${directory}/${name}`, "utf8"),
      ) as T
    );
}

export function loadMarketplaceProjectorFixtures(): MarketplaceProjectorFixture[] {
  return loadDirectory<MarketplaceProjectorFixture>("golden-events");
}

export function loadMarketplaceProjectorReorgFixtures(): MarketplaceProjectorReorgFixture[] {
  return loadDirectory<MarketplaceProjectorReorgFixture>("reorg-scenarios");
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export type DerivationOutcome = "present" | "fabricated" | "reorged-away";

/**
 * Authors projector #1's determinism and reorg contract natively. Discovery contributes only its
 * correction-by-append discipline and derivation-consistency vector outcomes; there is no
 * discovery projector suite to re-export.
 */
export function describeMarketplaceProjectorConformance(
  projector: MarketplaceProjectorConformanceSubject,
): void {
  describe("marketplace projector determinism (§8, §13)", () => {
    for (const fixture of loadMarketplaceProjectorFixtures()) {
      test(`${fixture.name}: byte-identical observations and announcements`, async () => {
        const first = await projector.project(fixture);
        const second = await projector.project(fixture);

        expect(first.observations, fixture.description).toHaveLength(
          fixture.expect.observationCount,
        );
        expect(first.announcements, fixture.description).toHaveLength(
          fixture.expect.announcementCount,
        );
        expect(first.observationBytes).toEqual(second.observationBytes);
        expect(first.announcementBytes).toEqual(second.announcementBytes);
        expect(first.stateBytes).toEqual(second.stateBytes);
        expect(sha256(first.observationBytes)).toBe(
          fixture.expect.observationSha256,
        );
        expect(sha256(first.announcementBytes)).toBe(
          fixture.expect.announcementSha256,
        );
        if (fixture.expect.requiredObservationTypes !== undefined) {
          const actual = new Set(
            (first.observations as Array<{ type?: string }>)
              .map((observation) => observation.type),
          );
          for (const required of fixture.expect.requiredObservationTypes) {
            expect(actual.has(required), `${fixture.name}: ${required}`).toBe(true);
          }
        }
        if (fixture.expect.announcementActions !== undefined) {
          expect(
            (first.announcements as Array<{ action?: string }>)
              .map((announcement) => announcement.action),
          ).toEqual(fixture.expect.announcementActions);
        }
        const lastSequence = new Map<string, bigint>();
        for (
          const observation of first.observations as Array<{
            source: string;
            subject: string;
            sequence: string;
          }>
        ) {
          const key = `${observation.source.length}:${observation.source}${observation.subject}`;
          const sequence = BigInt(observation.sequence);
          const previous = lastSequence.get(key);
          if (previous !== undefined) {
            expect(
              sequence,
              `${fixture.name}: monotonic sequence for ${observation.subject}`,
            ).toBeGreaterThan(previous);
          }
          lastSequence.set(key, sequence);
        }

        const split = await projector.project(fixture, {
          batchSizes: fixture.logs.map(() => 1),
        });
        expect(split.observationBytes).toEqual(first.observationBytes);
        expect(split.announcementBytes).toEqual(first.announcementBytes);
        expect(split.stateBytes).toEqual(first.stateBytes);

        const replay = await projector.replay(fixture);
        expect(replay.first.observationBytes).toEqual(first.observationBytes);
        expect(replay.first.announcementBytes).toEqual(first.announcementBytes);
        expect(replay.replayObservations).toEqual([]);
        expect(replay.replayAnnouncements).toEqual([]);
        expect(replay.stateBytesAfterReplay).toEqual(first.stateBytes);

        if (fixture.expect.attemptReorg === true) {
          const reorg = await projector.projectAttemptReorg(fixture);
          expect(reorg.priorBytesAfter).toEqual(reorg.priorBytesBefore);
          expect(reorg.lostObservation).toMatchObject({
            source: reorg.priorObservation.source,
            subject: reorg.priorObservation.subject,
            data: { state: "lost" },
            correction: {
              retractsObservationId: expect.any(String),
              orphanedBlockHash: expect.stringMatching(/^0x[0-9a-f]{64}$/u),
            },
          });
          expect(BigInt(reorg.lostObservation.sequence)).toBeGreaterThan(
            BigInt(reorg.priorObservation.sequence),
          );
          expect(reorg.laterTerminal).toMatchObject({
            source: reorg.priorObservation.source,
            subject: reorg.priorObservation.subject,
            data: { state: "delivered" },
          });
          expect(BigInt(reorg.laterTerminal.sequence)).toBeGreaterThan(
            BigInt(reorg.lostObservation.sequence),
          );
          expect(reorg.rawFolded).toMatchObject({
            contradictory: true,
          });
          expect(reorg.canonicalLostFolded).toMatchObject({
            state: "lost",
            terminal: true,
            contradictory: false,
          });
          expect(reorg.folded).toMatchObject({
            state: "delivered",
            terminal: true,
            contradictory: false,
          });
          expect(reorg.canonicalPreservedRaw).toBe(true);
          expect(reorg.missingProvenanceRefused).toBe(true);
          expect(reorg.invalidCorrectionsRefused).toEqual({
            absentTarget: true,
            duplicateTarget: true,
            nonOrphanedHash: true,
            wrongSource: true,
            wrongSubject: true,
            wrongTargetBlock: true,
            mismatchedDerivation: true,
          });
        }
      });

      test(`${fixture.name}: discovery derivation-consistency vectors target exact annotations`, async () => {
        const projected = await projector.project(fixture);
        expect(projected.derivations.length).toBeGreaterThan(0);
        const derivation = projected.derivations[0]!;
        expect(derivation).toEqual({
          chainId: expect.any(Number),
          contract: expect.stringMatching(/^0x[0-9a-f]{40}$/u),
          event: expect.any(String),
          blockNumber: expect.any(Number),
          blockHash: expect.stringMatching(/^0x[0-9a-f]{64}$/u),
          txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/u),
          logIndex: expect.any(Number),
          finalityTier: expect.stringMatching(/^(safe|finalized)$/u),
          contractGeneration: fixture.generation,
        });

        const vectors = loadVectorsByKind("derivation-consistency");
        expect(vectors.map((vector) => vector.name)).toEqual([
          "derivation-consistency-fabricated",
          "derivation-consistency-present",
          "derivation-consistency-reorged-away",
        ]);
        for (const vector of vectors) {
          const expected = (vector.expect as { derivation: DerivationOutcome })
            .derivation;
          expect(
            await projector.verifyDerivation(
              fixture,
              derivation,
              expected,
            ),
            vector.description,
          ).toBe(expected);
        }
      });
    }
  });

  describe("marketplace projector reorg correction (§8, §13)", () => {
    for (const fixture of loadMarketplaceProjectorReorgFixtures()) {
      test(`${fixture.name}: correction is a signed append, never a rewrite`, async () => {
        const run = await projector.projectReorg(fixture);
        expect(run.priorEntryBytesAfter).toEqual(run.priorEntryBytesBefore);
        expect(run.correctionEntry.previous).toBe(run.expectedPreviousDigest);
        expect(run.correctionEntry.announcements).toEqual([
          expect.objectContaining({
            action: "withdrawn",
            retracts: run.priorAnnouncementId,
            reason: "reorged",
          }),
        ]);
        expect(run.signatureCount).toBeGreaterThan(0);
        expect(run.tepCorrections).toEqual([]);
        expect(sha256(run.correctionEntryBytes)).toBe(
          fixture.expect.correctionSha256,
        );
      });
    }
  });
}
