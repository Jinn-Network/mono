import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixtureFamily, runStructuralCheck } from "../../testing.js";
import { EvaluationSpecSchema } from "../schema.js";
import type { StatePredicateBlock } from "../family-blocks.js";
import type { CanonicalChainObservation } from "./observation.js";
import { evaluatePredicates } from "./evaluate.js";
import { sourceReadKey } from "./reads.js";

const familyDir = fileURLToPath(new URL("../../../fixtures/state-predicate-evaluation", import.meta.url));

const TOKEN = "0x00000000000000000000000000000000000000aa";
const ADDR2 = "0x0000000000000000000000000000000000000002";
const ABI_DIGEST = "a".repeat(64);
const BALANCE_OF_CALL = `0x70a08231${"0".repeat(24)}${ADDR2.slice(2)}`;
const DECLARATIVE_CALL = {
  abiRef: { digest: { sha256: ABI_DIGEST } },
  function: "balanceOf(address)",
  args: [{ type: "address" as const, value: ADDR2 }],
};

function checkEvaluation(input: unknown): unknown {
  const { block, observation } = input as {
    block: StatePredicateBlock;
    observation: CanonicalChainObservation;
  };
  return evaluatePredicates(observation, block);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.hasOwn(bRecord, key) && deepEqual(aRecord[key], bRecord[key]));
}

describe("evaluatePredicates", () => {
  it("passes every golden and adversarial fixture case", async () => {
    const cases = await loadFixtureFamily(familyDir);
    expect(cases.length).toBe(13);
    const results = runStructuralCheck(cases, checkEvaluation);
    for (const result of results) {
      expect(result, `${result.kind}/${result.case}: ${result.detail ?? ""}`).toMatchObject({ ok: true });
    }
  });

  it("resolves encoded and declarative callResult through the same state-read path", () => {
    const stateRead = {
      key: `call|${TOKEN}|encoded|${BALANCE_OF_CALL}`,
      state: "post-replay" as const,
      resolution: "resolved" as const,
      value: "0x00000000000000000000000000000000000000000000000000000000000003e8",
    };
    const observation = {
      observationVersion: "1",
      environmentRecord: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      informationWorlds: ["corpus-world"],
      replay: { status: "completed" },
      timeline: {
        initialBlockNumber: "100",
        initialChainTimestamp: "1700000000",
        finalStateChangingBlockNumber: "100",
        finalStateChangingChainTimestamp: "1700000000",
      },
      transactions: [],
      blocks: [
        {
          number: "100",
          timestamp: "1700000000",
          hash: "0x0000000000000000000000000000000000000000000000000000000000000000",
        },
      ],
      touchedState: [],
      traceProjectionDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      finalStateCommitment: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      errorClasses: [],
      stateReads: [stateRead],
      sourceReads: [],
      sourceConsultations: [],
      reports: [],
    } satisfies CanonicalChainObservation;

    const blockBase = {
      environmentRecord: {
        digest: { sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        mediaType: "application/vnd.jinn.crypto-environment.v1+json",
      },
      predicateSemanticsVersion: "1",
      safetyConstraints: [],
      measurements: [],
      timeout: 600,
    } satisfies Partial<StatePredicateBlock>;

    const encodedBlock = {
      ...blockBase,
      successPredicates: [{
        kind: "callResult" as const,
        to: TOKEN,
        call: { encodedCall: BALANCE_OF_CALL },
        decode: "uint256" as const,
        cmp: "eq" as const,
        value: "1000",
      }],
    } satisfies StatePredicateBlock;

    const declarativeBlock = {
      ...blockBase,
      successPredicates: [{
        kind: "callResult" as const,
        to: TOKEN,
        call: DECLARATIVE_CALL,
        decode: "uint256" as const,
        cmp: "eq" as const,
        value: "1000",
      }],
    } satisfies StatePredicateBlock;

  const declarativeObservation = {
      ...observation,
      stateReads: [{
        ...stateRead,
        key: `call|${TOKEN}|abi|${ABI_DIGEST}|balanceOf(address)|address:${ADDR2}`,
      }],
    } satisfies CanonicalChainObservation;

    const encodedOutcome = evaluatePredicates(observation, encodedBlock);
    const declarativeOutcome = evaluatePredicates(declarativeObservation, declarativeBlock);

    expect(encodedOutcome.evaluations[0]).toEqual({
      slot: "success",
      index: 0,
      kind: "callResult",
      state: "satisfied",
      observed: "1000",
      expected: "1000",
    });
    expect(declarativeOutcome.evaluations[0]).toEqual(encodedOutcome.evaluations[0]);
  });

  it("honors ne comparator for boolean sourceValue (B1 regression)", () => {
    const observation = {
      observationVersion: "1",
      environmentRecord: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      informationWorlds: ["corpus-world"],
      replay: { status: "completed" },
      timeline: {
        initialBlockNumber: "100",
        initialChainTimestamp: "1700000000",
        finalStateChangingBlockNumber: "100",
        finalStateChangingChainTimestamp: "1700000000",
      },
      transactions: [],
      blocks: [],
      touchedState: [],
      traceProjectionDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      finalStateCommitment: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      errorClasses: [],
      stateReads: [],
      sourceReads: [{
        key: sourceReadKey({ world: "test", requestKey: "key1", selector: "flag" }),
        resolution: "resolved",
        value: true,
      }],
      sourceConsultations: [],
      reports: [],
    } satisfies CanonicalChainObservation;

    const block = {
      environmentRecord: {
        digest: { sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        mediaType: "application/vnd.jinn.crypto-environment.v1+json",
      },
      predicateSemanticsVersion: "1",
      successPredicates: [{
        kind: "sourceValue" as const,
        world: "test",
        requestKey: "key1",
        selector: "flag",
        cmp: "ne" as const,
        value: true,
      }],
      safetyConstraints: [],
      measurements: [],
      timeout: 600,
    } satisfies StatePredicateBlock;

    const outcome = evaluatePredicates(observation, block);
    expect(outcome.evaluations[0]).toMatchObject({
      state: "violated",
      observed: true,
      expected: true,
    });
  });

  it("fails closed on approval logs with empty data when noUnlimited is set (B2 regression)", () => {
    const observation = {
      observationVersion: "1",
      environmentRecord: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      informationWorlds: ["corpus-world"],
      replay: { status: "completed" },
      timeline: {
        initialBlockNumber: "100",
        initialChainTimestamp: "1700000000",
        finalStateChangingBlockNumber: "100",
        finalStateChangingChainTimestamp: "1700000000",
      },
      transactions: [{
        index: "0",
        hash: "0x0000000000000000000000000000000000000000000000000000000000000001",
        from: ADDR2,
        to: TOKEN,
        valueWei: "0",
        status: "success",
        gasUsed: "21000",
        returnData: "0x",
        logs: [{
          index: "0",
          address: TOKEN,
          topics: [
            "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
            `0x${"0".repeat(24)}${ADDR2.slice(2)}`,
            `0x${"0".repeat(24)}${ADDR2.slice(2)}`,
          ],
          data: "0x",
        }],
        blockNumber: "100",
        blockTimestamp: "1700000000",
      }],
      blocks: [],
      touchedState: [],
      traceProjectionDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      finalStateCommitment: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      errorClasses: [],
      stateReads: [],
      sourceReads: [],
      sourceConsultations: [],
      reports: [],
    } satisfies CanonicalChainObservation;

    const block = {
      environmentRecord: {
        digest: { sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        mediaType: "application/vnd.jinn.crypto-environment.v1+json",
      },
      predicateSemanticsVersion: "1",
      successPredicates: [{ kind: "txOutcome" as const, selector: { all: true }, status: "success" }],
      safetyConstraints: [{ kind: "approvalConstraint" as const, noUnlimited: true }],
      measurements: [],
      timeout: 600,
    } satisfies StatePredicateBlock;

    const outcome = evaluatePredicates(observation, block);
    expect(outcome.unevaluable).toBe(true);
    expect(outcome.evaluations.find((e) => e.kind === "approvalConstraint")).toMatchObject({
      state: "unevaluable",
      reason: "value-not-decodable",
    });
  });

  it("rejects EvaluationSpec with hand-rolled verdictRule at schema level (M4 regression)", async () => {
    const golden = JSON.parse(await readFile(
      new URL("../../../fixtures/evaluation-spec/golden/state-predicate-minimal.json", import.meta.url),
      "utf8",
    ));
    const bad = {
      ...golden,
      verdictRule: {
        all: [
          golden.verdictRule.all[0],
          golden.verdictRule.all[1],
        ],
      },
    };
    const parsed = EvaluationSpecSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  it("is deterministic and does not mutate its inputs", async () => {
    const raw = await readFile(
      `${familyDir}/golden/source-value-and-consulted.json`,
      "utf8",
    );
    const fixture = JSON.parse(raw) as {
      input: { block: StatePredicateBlock; observation: CanonicalChainObservation };
    };
    const blockClone = structuredClone(fixture.input.block);
    const observationClone = structuredClone(fixture.input.observation);

    const first = evaluatePredicates(observationClone, blockClone);
    const second = evaluatePredicates(observationClone, blockClone);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(deepEqual(fixture.input.block, blockClone)).toBe(true);
    expect(deepEqual(fixture.input.observation, observationClone)).toBe(true);
  });
});
