import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJsonBytes } from "@jinn-network/policy-identity";
import { expect, test } from "vitest";
import {
  runPinnedOciGrader,
  validateAndSignEvaluatorStatement,
  type ExpectedEvaluationBindings,
} from "./grader-oci.js";

const REAL_PINNED_IMAGE =
  "python@sha256:db3ff2e1800a8581e2c48a27c3995339d47bdf046da21c7627accd3d51053a93";

test.runIf(process.env["JINN_RUN_OCI_INTEGRATION"] === "1")(
  "a real network-disabled OCI grader emits unsigned bytes that the host binds and signs",
  async () => {
    const expected: ExpectedEvaluationBindings = {
      task: { name: "subject-task.json", digest: { sha256: "1".repeat(64) } },
      results: [{ name: "result.patch", digest: { sha256: "2".repeat(64) } }],
      evaluatorId: "urn:jinn:evaluator-role",
      evaluatorSigningKeyId: "evaluator-role-key",
      evaluationSpecification: {
        name: "evaluation-spec.json",
        digest: { sha256: "3".repeat(64) },
      },
      evaluationMethod: { name: "swe-rebench", digest: { sha256: "4".repeat(64) } },
    };
    const statementBytes = canonicalJsonBytes({
      _type: "https://in-toto.io/Statement/v1",
      subject: [expected.task, ...expected.results],
      predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
      predicate: {
        evaluatedAt: "2026-08-05T12:00:00Z",
        evaluator: { id: expected.evaluatorId },
        evaluationMethod: expected.evaluationMethod,
        evaluationSpecification: expected.evaluationSpecification,
        taskSubject: expected.task.name,
        resultSubjects: expected.results.map((result) => result.name),
        verdict: "pass",
        measurements: [{ name: "passed", value: true }],
      },
    });
    const root = mkdtempSync(join(tmpdir(), "jinn-real-oci-campaign-"));
    const inputPath = join(root, "unsigned-statement.json");
    const outputDirectory = join(root, "output");
    writeFileSync(inputPath, statementBytes);

    const emitted = await runPinnedOciGrader({
      runtime: "docker",
      image: REAL_PINNED_IMAGE,
      platform: "linux/arm64",
      inputs: [{ source: inputPath, targetName: "statement.json" }],
      outputDirectory,
      command: [
        "python3",
        "-c",
        "from pathlib import Path; Path('/jinn/out/verdict').write_bytes(Path('/jinn/input/statement.json').read_bytes())",
      ],
      timeoutMs: 60_000,
      profileRequiresNetwork: false,
    });
    expect(emitted).toEqual(statementBytes);
    let signed = false;
    const sealed = await validateAndSignEvaluatorStatement({
      statementBytes: emitted,
      expected,
      signer: async () => {
        signed = true;
        return [{ keyid: "evaluator-role-key", signature: new Uint8Array([7, 8, 9]) }];
      },
    });
    expect(signed).toBe(true);
    expect(sealed.payloadBytes).toEqual(statementBytes);
  },
  90_000,
);
