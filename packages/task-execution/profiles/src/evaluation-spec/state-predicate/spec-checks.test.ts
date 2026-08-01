import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateVerdictRule } from "../verdict-rule.js";
import { parseEvaluationSpec, sealEvaluationSpec } from "../seal.js";
import { evaluatePredicates } from "./evaluate.js";
import {
  STATE_PREDICATE_VERDICT_RULE,
  checkStatePredicateSpec,
} from "./spec-checks.js";
import type { StatePredicateBlock } from "../family-blocks.js";

const fixture = (relativePath: string) =>
  readFile(new URL(`../../../fixtures/evaluation-spec/${relativePath}`, import.meta.url), "utf8");

const evaluationFixture = (name: string) =>
  readFile(
    new URL(`../../../fixtures/state-predicate-evaluation/${name}`, import.meta.url),
    "utf8",
  );

const satisfiedObservation = {
  observationVersion: "1" as const,
  environmentRecord: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  informationWorlds: ["corpus-world"],
  replay: { status: "completed" as const },
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
  stateReads: [
    {
      key: "native-balance|0x0000000000000000000000000000000000000001",
      state: "post-replay" as const,
      resolution: "resolved" as const,
      value: "0x0000000000000000000000000000000000000000000000000000000000000000",
    },
  ],
  sourceReads: [],
  sourceConsultations: [],
  reports: [],
};

describe("state-predicate spec checks", () => {
  it("round-trips the golden minimal spec, seals to the pinned digest, and closes the verdict loop", async () => {
    const golden = JSON.parse(await fixture("golden/state-predicate-minimal.json"));
    const pinned = (await fixture("golden/state-predicate-minimal.sha256")).trim();
    const sealed = sealEvaluationSpec(golden);
    expect(sealed.digest).toBe(pinned);
    const spec = parseEvaluationSpec(sealed.bytes);
    expect(spec).toEqual(golden);
    expect(checkStatePredicateSpec(spec)).toEqual({ ok: true });

    const block = spec.familyBlock as StatePredicateBlock;
    const passMeasurements = evaluatePredicates(satisfiedObservation, block).measurements;
    expect(evaluateVerdictRule(spec.verdictRule, passMeasurements)).toEqual({ verdict: "pass" });

    const safetyViolated = JSON.parse(await evaluationFixture("golden/safety-violated-unlimited-approval.json"));
    const failMeasurements = evaluatePredicates(
      safetyViolated.input.observation,
      safetyViolated.input.block,
    ).measurements;
    expect(evaluateVerdictRule(spec.verdictRule, failMeasurements)).toEqual({ verdict: "fail" });

    const gaming = JSON.parse(await evaluationFixture("adversarial/reported-value-post-replay-only.json"));
    const inconclusiveMeasurements = evaluatePredicates(
      gaming.input.observation,
      gaming.input.block,
    ).measurements;
    expect(evaluateVerdictRule(spec.verdictRule, inconclusiveMeasurements)).toEqual({
      verdict: "inconclusive",
      inconclusiveClass: "state-predicate-unevaluable",
    });
  });

  it("rejects a hand-rolled verdictRule that omits the safety clause", async () => {
    const golden = JSON.parse(await fixture("golden/state-predicate-minimal.json"));
    const bad = {
      ...golden,
      verdictRule: {
        all: [
          golden.verdictRule.all[0],
          golden.verdictRule.all[1],
        ],
      },
    };
    expect(checkStatePredicateSpec(bad)).toMatchObject({ ok: false });
  });

  it("rejects a spec missing the unscorable unevaluable class", async () => {
    const golden = JSON.parse(await fixture("golden/state-predicate-minimal.json"));
    const bad = { ...golden, unscorable: [] };
    expect(checkStatePredicateSpec(bad)).toMatchObject({ ok: false });
  });

  it("rejects a block measurement absent from top-level declarations", async () => {
    const golden = JSON.parse(await fixture("golden/state-predicate-minimal.json"));
    const bad = {
      ...golden,
      familyBlock: {
        ...golden.familyBlock,
        measurements: [{ name: "totalGas", observe: { kind: "gasTotal" } }],
      },
    };
    expect(checkStatePredicateSpec(bad)).toMatchObject({ ok: false });
  });

  it("exports the canonical verdict rule verbatim", () => {
    expect(STATE_PREDICATE_VERDICT_RULE).toEqual({
      all: [
        {
          inconclusiveWhen: {
            threshold: { measurement: "statePredicateUnevaluable", op: "eq", value: true },
          },
          class: "state-predicate-unevaluable",
        },
        { threshold: { measurement: "successPredicatesSatisfied", op: "eq", value: true } },
        { not: { threshold: { measurement: "safetyConstraintsViolated", op: "eq", value: true } } },
      ],
    });
  });
});
