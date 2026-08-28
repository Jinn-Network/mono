// SPDX-License-Identifier: Apache-2.0

import {
  isEvaluationOperationalError,
  resolveEvaluationMethod,
  validateEvaluatorRegistrationSet,
  type EvaluationHarnessDeployment,
  type EvaluationOperationalError,
} from "@jinn-network/task-execution-evaluation-harness";
import {
  BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY,
  EVALUATION_SPEC_FORMAT_URI,
  EVAL_SEMANTICS_VERSION,
  parserAllowlistKey,
  type DeterministicProcessBlock,
  type EvaluationSpec,
  type ParserIdentity,
} from "@jinn-network/task-execution-profiles";
import { describe, expect, test } from "vitest";
import {
  evaluatorAdaptersParserAllowlist,
  PREDICTION_PARSER,
  SWE_REBENCH_PARSER,
} from "./parser-identity.js";
import { contextGraderReportSource } from "./swe-rebench/adapter.js";
import { contextResolutionSnapshotSource } from "./prediction/adapter.js";
import {
  buildBinaryJudgmentEvaluationSpecification,
  evaluationPolicyFromSpecification,
} from "./binary-judgment/adapter.js";
import {
  BINARY_JUDGMENT_REGISTRATION_ID,
  binaryJudgmentMethodForSpecification,
  createBinaryJudgmentEvaluatorRegistration,
  createPredictionEvaluatorRegistration,
  createSweRebenchEvaluatorRegistration,
  PREDICTION_REGISTRATION_ID,
  SWE_REBENCH_REGISTRATION_ID,
} from "./registrations.js";

const method = {
  name: "evaluator-adapters",
  digest: { sha256: "9".repeat(64) },
  uri: "https://spec.jinn.network/software/evaluator-adapters/v1",
};

function registrations() {
  return [
    createBinaryJudgmentEvaluatorRegistration({
      evaluatorId: "did:key:z6MkhzYwRj8TvZEp41ApnVVDN5a5hBCk8tQYp4w7vGkVn5F8",
      signerHandle: "evaluator-agent-key.pem",
    }),
    createSweRebenchEvaluatorRegistration({
      evaluatorId: "did:key:z6MkhzYwRj8TvZEp41ApnVVDN5a5hBCk8tQYp4w7vGkVn5F8",
      signerHandle: "evaluator-agent-key.pem",
      evaluationMethod: method,
      graderReportSource: contextGraderReportSource(),
    }),
    createPredictionEvaluatorRegistration({
      evaluatorId: "did:key:z6MkhzYwRj8TvZEp41ApnVVDN5a5hBCk8tQYp4w7vGkVn5F8",
      signerHandle: "evaluator-agent-key.pem",
      evaluationMethod: method,
      resolutionSnapshotSource: contextResolutionSnapshotSource(),
    }),
  ];
}

function binaryJudgmentSpec(): EvaluationSpec {
  return buildBinaryJudgmentEvaluationSpecification(`sha256:${"2".repeat(64)}`);
}

function specFor(parser: ParserIdentity): EvaluationSpec {
  return {
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    family: "deterministic-process",
    grader: {
      name: parser.id,
      digest: { sha256: parser.digest.slice("sha256:".length) },
      accessClass: "public",
    },
    familyBlock: {
      image: { name: "grader-image", digest: { sha256: "2".repeat(64) } },
      platform: "linux/amd64",
      workspace: {},
      testMaterial: [],
      parser,
      transitions: { failToPass: [], passToPass: [] },
      timeout: 60,
    },
    measurements: [{ name: "passed", type: "boolean", required: true }],
    verdictRule: { threshold: { measurement: "passed", op: "eq", value: true } },
    unscorable: [],
    evidenceConventions: { requiredRefs: [] },
  } as EvaluationSpec;
}

/** Mirrors runtime.ts's own selection: exactly one compatible registration, or refuse. */
function resolve(
  deployment: EvaluationHarnessDeployment,
  specification: EvaluationSpec,
): string {
  const compatible = validateEvaluatorRegistrationSet(deployment.registrations)
    .filter((registration) => registration.specificationCompatibility(specification));
  if (compatible.length !== 1) {
    throw new Error(
      compatible.length === 0
        ? "no host evaluator registration supports the EvaluationSpec"
        : "more than one host evaluator registration supports the EvaluationSpec",
    );
  }
  return compatible[0]!.registrationId;
}

const deployment = {
  registrations: registrations(),
  parserAllowlist: evaluatorAdaptersParserAllowlist(),
  maxClaimEvidenceBytes: 1024 * 1024,
  evidenceWriter: {
    async putClaimEvidence({ name }: { name: string }) {
      return { name, digest: { sha256: "4".repeat(64) } };
    },
  },
} as unknown as EvaluationHarnessDeployment;

describe("deployment registrations", () => {
  test("the set validates and has unique ids", () => {
    expect(validateEvaluatorRegistrationSet(deployment.registrations)).toHaveLength(3);
  });

  test("the swe-rebench parser identity resolves the swe-rebench registration", () => {
    expect(resolve(deployment, specFor(SWE_REBENCH_PARSER)))
      .toBe(SWE_REBENCH_REGISTRATION_ID);
  });

  test("the prediction parser identity resolves the prediction registration", () => {
    expect(resolve(deployment, specFor(PREDICTION_PARSER)))
      .toBe(PREDICTION_REGISTRATION_ID);
  });

  test("the exact binary judgment contract resolves its generated registration", () => {
    expect(resolve(deployment, binaryJudgmentSpec()))
      .toBe(BINARY_JUDGMENT_REGISTRATION_ID);
  });

  test("an unlisted parser identity matches no registration", () => {
    const unlisted: ParserIdentity = {
      id: "network.jinn.parser.unlisted",
      version: "1.0.0",
      digest: `sha256:${"7".repeat(64)}`,
    };
    expect(() => resolve(deployment, specFor(unlisted)))
      .toThrow("no host evaluator registration supports the EvaluationSpec");
  });

  test("an unlisted parser identity is also outside the deployment allowlist", () => {
    const spec = specFor({
      id: "network.jinn.parser.unlisted",
      version: "1.0.0",
      digest: `sha256:${"7".repeat(64)}`,
    });
    const key = parserAllowlistKey(
      (spec.familyBlock as DeterministicProcessBlock).parser,
    );
    expect(deployment.parserAllowlist.has(key)).toBe(false);
  });

  test("a matching id at a different digest is refused (the digest is the commitment)", () => {
    const drifted: ParserIdentity = {
      id: SWE_REBENCH_PARSER.id,
      version: SWE_REBENCH_PARSER.version,
      digest: `sha256:${"8".repeat(64)}`,
    };
    expect(() => resolve(deployment, specFor(drifted)))
      .toThrow("no host evaluator registration supports the EvaluationSpec");
    expect(deployment.parserAllowlist.has(parserAllowlistKey(drifted))).toBe(false);
  });

  /**
   * Hardening for the #3050 defect class: a future v3 evaluation parser added to the builder and
   * the compatibility predicate, but not to the policy derivation, must refuse loudly instead of
   * silently disclosing v1 semantics for a v3 run.
   */
  describe("binary judgment method disclosure for an unrecognized parser", () => {
    const v3: ParserIdentity = {
      id: BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.id,
      version: "3.0.0",
      digest: `sha256:${"c".repeat(64)}`,
    };

    function specWithParser(parser: ParserIdentity): EvaluationSpec {
      const spec = binaryJudgmentSpec();
      return {
        ...spec,
        familyBlock: { ...(spec.familyBlock as DeterministicProcessBlock), parser },
      } as EvaluationSpec;
    }

    test("the policy derivation reports no policy rather than guessing one", () => {
      expect(evaluationPolicyFromSpecification(specWithParser(v3))).toBeUndefined();
      // Contract control: the two sealed identities still derive.
      expect(evaluationPolicyFromSpecification(
        buildBinaryJudgmentEvaluationSpecification(`sha256:${"2".repeat(64)}`, "reject"),
      )).toBe("reject");
      expect(evaluationPolicyFromSpecification(
        buildBinaryJudgmentEvaluationSpecification(`sha256:${"2".repeat(64)}`, "abstain"),
      )).toBe("abstain");
    });

    test("resolving the registration's method refuses and names the parser", () => {
      const registration = createBinaryJudgmentEvaluatorRegistration({
        evaluatorId: "did:key:z6MkhzYwRj8TvZEp41ApnVVDN5a5hBCk8tQYp4w7vGkVn5F8",
        signerHandle: "evaluator-agent-key.pem",
      });
      let thrown: unknown;
      try {
        resolveEvaluationMethod(registration, specWithParser(v3));
      } catch (cause) {
        thrown = cause;
      }
      expect(isEvaluationOperationalError(thrown)).toBe(true);
      const error = thrown as EvaluationOperationalError;
      expect(error.reason).toBe("unsupported-specification");
      expect(error.recoveryAdvice).toBe("do-not-retry");
      expect(error.safeDetail).toContain(parserAllowlistKey(v3));
    });

    test("a non-deterministic-process specification refuses without reading a family block", () => {
      expect(() => binaryJudgmentMethodForSpecification(
        { ...binaryJudgmentSpec(), family: "human-review" } as unknown as EvaluationSpec,
      )).toThrow(/not deterministic-process/u);
    });
  });

  test("the two registrations never both claim one specification", () => {
    for (const spec of [
      specFor(SWE_REBENCH_PARSER),
      specFor(PREDICTION_PARSER),
      binaryJudgmentSpec(),
    ]) {
      const claimed = deployment.registrations
        .filter((registration) => registration.specificationCompatibility(spec));
      expect(claimed).toHaveLength(1);
    }
  });
});
