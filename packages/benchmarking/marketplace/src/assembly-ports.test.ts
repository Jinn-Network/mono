import { createMarketplaceProjectionState } from "@jinn-network/marketplace-projector";
import { describe, expect, test } from "vitest";
import {
  marketplaceAssemblyPorts,
  type CoherentProjectorScopePorts,
} from "./assembly-ports.js";
import type { AuthorityProjection } from "./authority-projection.js";
import { deriveAuthorityProjection } from "./authority-projection.js";
import {
  CloseAuthorityMismatchError,
} from "./close-authority.js";
import {
  CoherentProjectionResolverError,
  freezeAuthorityProjection,
  memoizeAuthorityProjectionResolver,
} from "./projection-resolver.js";

const ANCHOR = {
  chain: "eip155:84532",
  blockNumber: 10,
  blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const OTHER_ANCHOR = {
  chain: "eip155:84532",
  blockNumber: 11,
  blockHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};

const CLOSE_BOUNDARY = {
  at: "2099-01-01T00:00:00Z",
  anchor: ANCHOR,
};

function emptyProjection(): AuthorityProjection {
  return {
    observations: [],
    events: [],
    state: createMarketplaceProjectionState(),
  };
}

function baseTrust() {
  return {
    async resolveAgent() {
      return "unresolved" as const;
    },
  };
}

function baseCost() {
  return {
    generation: "revised" as const,
    budgetUnit: "wei",
  };
}

function baseCloseBoundaryPorts() {
  return {
    blocks: {
      async firstFinalizedAtOrAfter() {
        return {
          chain: ANCHOR.chain,
          blockNumber: ANCHOR.blockNumber,
          blockHash: ANCHOR.blockHash,
          timestamp: "2099-01-01T00:00:01Z",
        };
      },
    },
  };
}

function coherentInput(
  inputScope: CoherentProjectorScopePorts,
  authorityProjection = freezeAuthorityProjection(emptyProjection()),
) {
  return {
    closeBoundary: baseCloseBoundaryPorts(),
    coherentClose: {
      boundary: CLOSE_BOUNDARY,
      anchor: ANCHOR,
    },
    authorityProjection,
    inputScope,
    cost: baseCost(),
    trust: baseTrust(),
  };
}

describe("marketplaceAssemblyPorts", () => {
  test("wires standalone ports with honest defaults", async () => {
    const ports = marketplaceAssemblyPorts({
      closeBoundary: baseCloseBoundaryPorts(),
      inputScope: {
        eventsThroughAnchor: () => [],
        closeAnchor: ANCHOR,
        join: { cellsFromObservations: () => [] },
      },
      cost: baseCost(),
      trust: baseTrust(),
    });
    await expect(ports.pinning.observe(null, {})).resolves.toMatchObject({
      harness: "unverifiable",
    });
    await expect(
      ports.admission.tierFor({ cellKey: "t/armA/1", taskDigest: "t" }),
    ).resolves.toBe("attested-only");
    await expect(ports.cost.costFor({
      cellKey: `${"a".repeat(64)}/armA/1`,
      armId: "armA",
      replicate: 1,
      taskDigest: "a".repeat(64),
      dispatches: 0,
      verdicts: [],
    })).resolves.toBeUndefined();
  });

  test("coherent close uses frozen resolver A and never re-reads mutable events", async () => {
    const projectionA = emptyProjection();
    let deriveCalls = 0;
    const authorityProjection = memoizeAuthorityProjectionResolver(async () => {
      deriveCalls += 1;
      return projectionA;
    });

    let eventsReadCount = 0;
    const mutableEvents: never[] = [];
    const projectionIfRead = deriveAuthorityProjection(mutableEvents, ANCHOR);
    expect(projectionIfRead).not.toBe(projectionA);

    expect(() => marketplaceAssemblyPorts({
      ...coherentInput({
        closeAnchor: ANCHOR,
        join: { cellsFromObservations: () => [] },
      }, authorityProjection),
      inputScope: {
        closeAnchor: ANCHOR,
        eventsThroughAnchor: () => {
          eventsReadCount += 1;
          return mutableEvents;
        },
        join: { cellsFromObservations: () => [] },
      },
    } as Parameters<typeof marketplaceAssemblyPorts>[0])).toThrow(CoherentProjectionResolverError);

    const ports = marketplaceAssemblyPorts(coherentInput({
      closeAnchor: ANCHOR,
      join: { cellsFromObservations: () => [] },
    }, authorityProjection));

    for await (const _submission of ports.inputScope.submissionsForRun("sha256:deadbeef")) {
      void _submission;
    }
    await ports.cost.costFor({
      cellKey: `${"a".repeat(64)}/armA/1`,
      armId: "armA",
      replicate: 1,
      taskDigest: "a".repeat(64),
      dispatches: 0,
      verdicts: [],
    });

    expect(eventsReadCount).toBe(0);
    expect(deriveCalls).toBe(1);
    expect(await authorityProjection.resolve()).toBe(projectionA);
  });

  test("memoizes resolver across repeated input scope and cost queries", async () => {
    let deriveCalls = 0;
    const projectionA = emptyProjection();
    const authorityProjection = memoizeAuthorityProjectionResolver(async () => {
      deriveCalls += 1;
      return projectionA;
    });

    const ports = marketplaceAssemblyPorts(coherentInput({
      closeAnchor: ANCHOR,
      join: { cellsFromObservations: () => [] },
    }, authorityProjection));

    for (let index = 0; index < 3; index += 1) {
      for await (const _submission of ports.inputScope.submissionsForRun(`sha256:${index}`)) {
        void _submission;
      }
    }
    for (let index = 0; index < 3; index += 1) {
      await ports.cost.costFor({
        cellKey: `${"a".repeat(64)}/armA/1`,
        armId: "armA",
        replicate: 1,
        taskDigest: "a".repeat(64),
        dispatches: 0,
        verdicts: [],
      });
    }

    expect(deriveCalls).toBe(1);
    expect(await authorityProjection.resolve()).toBe(projectionA);
  });

  test("fails before assembly output when coherent close omits authorityProjection", () => {
    expect(() => marketplaceAssemblyPorts({
      closeBoundary: baseCloseBoundaryPorts(),
      coherentClose: {
        boundary: CLOSE_BOUNDARY,
        anchor: ANCHOR,
      },
      inputScope: {
        closeAnchor: ANCHOR,
        join: { cellsFromObservations: () => [] },
      },
      cost: baseCost(),
      trust: baseTrust(),
    } as unknown as Parameters<typeof marketplaceAssemblyPorts>[0])).toThrow(CoherentProjectionResolverError);
  });

  test("rejects mismatched coherent close anchor before wiring ports", () => {
    expect(() => marketplaceAssemblyPorts(coherentInput({
      closeAnchor: OTHER_ANCHOR,
      join: { cellsFromObservations: () => [] },
    }))).toThrow(CloseAuthorityMismatchError);
  });

  test("standalone assembly collects events exactly once", async () => {
    let eventsReadCount = 0;
    const ports = marketplaceAssemblyPorts({
      closeBoundary: baseCloseBoundaryPorts(),
      inputScope: {
        eventsThroughAnchor: () => {
          eventsReadCount += 1;
          return [];
        },
        closeAnchor: ANCHOR,
        join: { cellsFromObservations: () => [] },
      },
      cost: baseCost(),
      trust: baseTrust(),
    });

    for await (const _submission of ports.inputScope.submissionsForRun("sha256:1")) {
      void _submission;
    }
    await ports.cost.costFor({
      cellKey: `${"a".repeat(64)}/armA/1`,
      armId: "armA",
      replicate: 1,
      taskDigest: "a".repeat(64),
      dispatches: 0,
      verdicts: [],
    });
    await ports.cost.costFor({
      cellKey: `${"b".repeat(64)}/armA/1`,
      armId: "armA",
      replicate: 1,
      taskDigest: "b".repeat(64),
      dispatches: 0,
      verdicts: [],
    });

    expect(eventsReadCount).toBe(1);
  });
});
