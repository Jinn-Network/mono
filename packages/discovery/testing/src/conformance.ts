import { describe, expect, it } from "vitest";
import {
  CEILINGS,
  parseSourceHead,
} from "@jinn-network/record-discovery-protocol";
import type {
  DiscoveryQueryService,
  ItemOutcome,
  SourceChainOutcome,
  SourceCursor,
  verifyItem,
  verifySourceChain,
} from "@jinn-network/record-discovery-protocol";

import { makeInMemoryPorts } from "./fakes.js";
import {
  isFactsConsistencyInput,
  isItemInput,
  isParseErrorVector,
  isRunnableSourceChainInput,
  toAsyncIterable,
  type DerivationConsistencyVectorInput,
  type FactsConsistencyVectorInput,
  type ItemVectorInput,
} from "./harness.js";
import { loadVectorsByKind, type Vector } from "./vectors.js";

// The exported conformance suites (plan Task 11): each maps the §18
// vectors of its plane onto assertions against an injected implementation.
// `runSourceChainConformance` and `runItemConformance` drive `protocol`'s
// own reference procedures (RED until M4, plan Task 12/13); the other four
// describe the surfaces `serve` (M5) and `client` (M6) must satisfy --
// this milestone only exports them, since no concrete implementation
// exists yet to run them against.

// ---------------------------------------------------------------------------
// source-chain-verification (§10.3)
// ---------------------------------------------------------------------------

function assertSourceChainOutcome(outcome: SourceChainOutcome, vector: Vector): void {
  const expected = vector.expect as { status: string; advanced?: SourceCursor };
  expect(outcome.status, `${vector.name}: ${vector.description}`).toBe(expected.status);
  if (outcome.status === "ok" && expected.advanced !== undefined) {
    expect(outcome.advanced).toEqual(expected.advanced);
  }
}

function assertNonRunnableSourceChainVector(vector: Vector): void {
  const input = vector.input as Record<string, unknown>;
  if ("headA" in input && "headB" in input) {
    const headA = parseSourceHead(JSON.parse((input["headA"] as { payload: string }).payload));
    const headB = parseSourceHead(JSON.parse((input["headB"] as { payload: string }).payload));
    // §5.3: two heads for the same origin at the same sequence citing
    // different entry digests is the fork condition with no benign reading.
    expect(headA.origin).toBe(headB.origin);
    expect(headA.sequence).toBe(headB.sequence);
    expect(headA.entry).not.toBe(headB.entry);
    return;
  }
  if ("archivePage" in input) {
    const page = input["archivePage"] as { declaredBytes: number };
    expect(page.declaredBytes).toBeGreaterThan(CEILINGS.archivePageBytes);
    return;
  }
  throw new Error(`Unrecognized non-runnable source-chain vector shape: ${vector.name}`);
}

export function runSourceChainConformance(verify: typeof verifySourceChain): void {
  describe("source-chain-verification (§10.3, §18 vectors)", () => {
    for (const vector of loadVectorsByKind("source-chain")) {
      if (vector.name.startsWith("source-conformance-")) continue; // driven by runSourceConformance (M5)

      if (isParseErrorVector(vector)) {
        it(`${vector.name} (parse-error -- primary coverage is protocol's entry.test.ts, M1)`, () => {
          expect((vector.expect as { status: string }).status).toBe("parse-error");
        });
        continue;
      }

      if (!isRunnableSourceChainInput(vector.input)) {
        it(`${vector.name} (structural -- not a single verifySourceChain call)`, () => {
          assertNonRunnableSourceChainVector(vector);
        });
        continue;
      }

      const input = vector.input; // narrowed by the guard above; captured as a const so it survives into the closure

      it(vector.name, async () => {
        const ports = makeInMemoryPorts({
          now: input.seed.now,
          keys: input.seed.keys as never,
          hwm: input.seed.hwm as never,
        });
        const outcome = await verify({
          head: input.head,
          headSignature: input.headSignature,
          entries: toAsyncIterable(input.entries),
          ports: {
            keys: ports.keys,
            sigs: ports.sigs,
            fresh: ports.fresh,
            hwm: ports.hwm,
            now: ports.clock.now(),
            firstAdoption: input.firstAdoption,
          },
        });
        assertSourceChainOutcome(outcome, vector);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// item verification (§10.4) -- item / facts-consistency / derivation-consistency
// ---------------------------------------------------------------------------

function assertItemOutcome(outcome: ItemOutcome, vector: Vector): void {
  const expected = vector.expect as { status?: string; facts?: string; derivation?: string };
  if (expected.status !== undefined) {
    expect(outcome.status, `${vector.name}: ${vector.description}`).toBe(expected.status);
  }
  if (expected.facts !== undefined) {
    expect(outcome.status).toBe("verified");
    if (outcome.status === "verified") expect(outcome.facts).toBe(expected.facts);
  }
  if (expected.derivation !== undefined) {
    expect(outcome.status).toBe("verified");
    if (outcome.status === "verified") expect(outcome.derivation).toBe(expected.derivation);
  }
}

function buildItemCallOpts(vector: Vector): Parameters<typeof verifyItem>[0] {
  if (vector.kind === "facts-consistency") {
    const input = vector.input as FactsConsistencyVectorInput;
    const digest = input.item.record.digest;
    const ports = makeInMemoryPorts({
      records: { [digest]: input.recordBytes },
      withheldDigests: input.withheldReferencedDigests ?? [],
      factsProfile: input.profile as never,
      sourceClass: input.sourceClass ?? "projection",
      verifiedChainDigests: [input.item.provenance.entry],
    });
    return {
      item: input.item,
      profile: input.profile as never,
      decisionGrade: input.decisionGrade ?? false,
      ports: {
        records: ports.records,
        entries: ports.entries,
        keys: ports.keys,
        sigs: ports.sigs,
        factsRecompute: ports.factsRecompute,
        verifiedChain: async () => true,
      },
    };
  }
  if (vector.kind === "derivation-consistency") {
    const input = vector.input as DerivationConsistencyVectorInput;
    const outcome = (vector.expect as { derivation: "present" | "fabricated" | "reorged-away" }).derivation;
    const digest = input.item.record.digest;
    const ports = makeInMemoryPorts({
      substrateOutcome: outcome,
      records: input.recordBytes !== undefined ? { [digest]: input.recordBytes } : {},
    });
    return {
      item: input.item,
      decisionGrade: true,
      ports: {
        records: ports.records,
        entries: ports.entries,
        keys: ports.keys,
        sigs: ports.sigs,
        factsRecompute: ports.factsRecompute,
        substrate: ports.substrate,
        verifiedChain: async () => true,
      },
    };
  }
  const input = vector.input as ItemVectorInput;
  const digest = input.item.record.digest;
  const seedRecords: Record<string, unknown> = input.fetchedBytes !== undefined ? { [digest]: input.fetchedBytes } : {};
  const ports = makeInMemoryPorts({ records: seedRecords });
  return {
    item: input.item,
    decisionGrade: input.decisionGrade ?? false,
    ports: {
      records: ports.records,
      entries: ports.entries,
      keys: ports.keys,
      sigs: ports.sigs,
      factsRecompute: ports.factsRecompute,
      verifiedChain: async () => input.citedEntryReachable ?? true,
    },
  };
}

export function runItemConformance(verify: typeof verifyItem): void {
  describe("item verification (§10.4, §18 vectors: item / facts-consistency / derivation-consistency)", () => {
    const vectors = [
      ...loadVectorsByKind("item"),
      ...loadVectorsByKind("facts-consistency"),
      ...loadVectorsByKind("derivation-consistency"),
    ];
    for (const vector of vectors) {
      if (!isFactsConsistencyInput(vector.input) && !isItemInput(vector.input)) continue;
      it(vector.name, async () => {
        const opts = buildItemCallOpts(vector);
        const outcome = await verify(opts);
        assertItemOutcome(outcome, vector);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Source conformance (M5) -- published/unpublished profiles, correction-by-
// append, freshness maintenance, refreshBy bound (§7).
// ---------------------------------------------------------------------------

/** The minimal surface `discovery/serve` must expose for `runSourceConformance` (M5). */
export interface ServeUnderTest {
  isPublished(sourceName: string): boolean;
  maintainsFreshness(headEnvelopes: Array<{ payload: string }>): boolean;
  refreshByWithinBound(head: { issuedAt: string; refreshBy: string }, maxAheadHours: number): boolean;
}

export function runSourceConformance(serve: ServeUnderTest): void {
  describe("source conformance (§7, §18 source-conformance-* vectors)", () => {
    for (const vector of loadVectorsByKind("source-chain").filter((v) => v.name.startsWith("source-conformance-"))) {
      it(vector.name, () => {
        const input = vector.input as Record<string, unknown>;
        if ("profile" in input) {
          const expectSigned = (vector.expect as { signed: boolean }).signed;
          expect(serve.isPublished("feed")).toBe(expectSigned);
        }
        if ("refreshes" in input) {
          expect(serve.maintainsFreshness(input["refreshes"] as Array<{ payload: string }>)).toBe(true);
        }
        if ("withinBound" in input && "exceedsBound" in input) {
          const maxAheadHours = (input["maxAheadHours"] as number) ?? 24;
          expect(serve.refreshByWithinBound(input["withinBound"] as never, maxAheadHours)).toBe(true);
          expect(serve.refreshByWithinBound(input["exceedsBound"] as never, maxAheadHours)).toBe(false);
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Query plane (§8, M6).
// ---------------------------------------------------------------------------

export function runQueryConformance(svc: DiscoveryQueryService): void {
  describe("query conformance (§8, §18 query vectors)", () => {
    it("capabilities() resolves a well-formed QueryCapabilities object", async () => {
      const capabilities = await svc.capabilities();
      expect(Array.isArray(capabilities.kinds)).toBe(true);
      expect(Array.isArray(capabilities.sources)).toBe(true);
      expect(Array.isArray(capabilities.freshness)).toBe(true);
    });

    for (const vector of loadVectorsByKind("query")) {
      it(vector.name, () => {
        // Documents the §8 rule the vector names; §8's normative rules
        // (mandatory provenance, complete-vs-truncated honesty, no
        // origination) are asserted against a concrete DiscoveryQueryService
        // once `client` (M6) implements one -- this milestone only pins
        // the vector's own well-formedness (Task 10), already covered by
        // vectors.test.ts.
        expect(vector.kind).toBe("query");
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Subscribe plane (§9, M6).
// ---------------------------------------------------------------------------

/** The minimal surface a subscribe client must expose for `runSubscribeConformance` (M6). */
export interface SubscribeClientUnderTest {
  classifyCursor(cursor: string | undefined, replayWindowSize: number, cursorPosition?: number): Promise<{ behavior: string; detailCode?: string }>;
}

export function runSubscribeConformance(sub: SubscribeClientUnderTest): void {
  describe("subscribe conformance (§9, §18 subscribe vectors)", () => {
    for (const vector of loadVectorsByKind("subscribe")) {
      const input = vector.input as { cursor?: string; replayWindowSize?: number; cursorPosition?: number };
      if (!("behavior" in (vector.expect as Record<string, unknown>))) continue;
      it(vector.name, async () => {
        const result = await sub.classifyCursor(input.cursor, input.replayWindowSize ?? 0, input.cursorPosition);
        const expected = vector.expect as { behavior: string; detailCode?: string };
        expect(result.behavior).toBe(expected.behavior);
        if (expected.detailCode !== undefined) expect(result.detailCode).toBe(expected.detailCode);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Consumer conformance (§9.5, §7.4, §13.3, §5.1, M6).
// ---------------------------------------------------------------------------

/** The minimal surface a discovery client must expose for `runConsumerConformance` (M6). */
export interface ClientUnderTest {
  checkLocator(location: unknown): Promise<{ rejected: boolean; reason?: string }>;
}

export function runConsumerConformance(client: ClientUnderTest): void {
  describe("consumer conformance (§9.5/§7.4/§13.3/§5.1, §18 consumer vectors)", () => {
    for (const vector of loadVectorsByKind("consumer")) {
      const input = vector.input as { location?: unknown };
      if (input.location === undefined) continue; // non-locator consumer vectors (debounce, divergence, cold-start, withdrawal) await a full ClientUnderTest surface at M6
      it(vector.name, async () => {
        const result = await client.checkLocator(input.location);
        const expected = vector.expect as { rejected: boolean; reason?: string };
        expect(result.rejected).toBe(expected.rejected);
        if (expected.reason !== undefined) expect(result.reason).toBe(expected.reason);
      });
    }
  });
}
