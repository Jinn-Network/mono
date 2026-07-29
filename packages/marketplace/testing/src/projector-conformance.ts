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
}

/**
 * Native marketplace-projector conformance seam. The subject owns fixture adaptation so another
 * implementation can run the same published vectors without importing the reference projector.
 */
export interface MarketplaceProjectorConformanceSubject {
  project(
    fixture: MarketplaceProjectorFixture,
  ): Promise<MarketplaceProjectorConformanceRun>;
  projectReorg(
    fixture: MarketplaceProjectorReorgFixture,
  ): Promise<MarketplaceProjectorReorgRun>;
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

function sameDerivation(
  left: ProjectedDerivation,
  right: ProjectedDerivation,
): boolean {
  return left.chainId === right.chainId
    && left.contract === right.contract
    && left.event === right.event
    && left.blockNumber === right.blockNumber
    && left.blockHash === right.blockHash
    && left.txHash === right.txHash
    && left.logIndex === right.logIndex
    && left.finalityTier === right.finalityTier
    && left.contractGeneration === right.contractGeneration;
}

type DerivationOutcome = "present" | "fabricated" | "reorged-away";

function classifyDerivation(
  derivation: ProjectedDerivation,
  substrate: {
    readonly logs: readonly ProjectedDerivation[];
    readonly reorgedBlockHashes: readonly string[];
  },
): DerivationOutcome {
  if (substrate.reorgedBlockHashes.includes(derivation.blockHash)) {
    return "reorged-away";
  }
  return substrate.logs.some((candidate) =>
    sameDerivation(candidate, derivation)
  )
    ? "present"
    : "fabricated";
}

function substrateFor(
  derivation: ProjectedDerivation,
  outcome: DerivationOutcome,
): {
  readonly logs: readonly ProjectedDerivation[];
  readonly reorgedBlockHashes: readonly string[];
} {
  if (outcome === "present") {
    return { logs: [{ ...derivation }], reorgedBlockHashes: [] };
  }
  if (outcome === "reorged-away") {
    return { logs: [], reorgedBlockHashes: [derivation.blockHash] };
  }
  return { logs: [], reorgedBlockHashes: [] };
}

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
        expect(sha256(first.observationBytes)).toBe(
          fixture.expect.observationSha256,
        );
        expect(sha256(first.announcementBytes)).toBe(
          fixture.expect.announcementSha256,
        );
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
            classifyDerivation(
              derivation,
              substrateFor(derivation, expected),
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
        expect(sha256(run.correctionEntryBytes)).toBe(
          fixture.expect.correctionSha256,
        );
      });
    }
  });
}
