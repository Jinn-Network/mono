import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalAttestationJsonBytes } from "@jinn-network/attestation-issuer";
import { describe, expect, test } from "vitest";
import {
  buildPinnedOciInvocation,
  validateAndSignEvaluatorStatement,
  type ExpectedEvaluationBindings,
} from "./grader-oci.js";

const IMAGE = `ghcr.io/jinn-network/swe-rebench@sha256:${"a".repeat(64)}`;

function roots() {
  const root = mkdtempSync(join(tmpdir(), "jinn-oci-grader-"));
  const input = join(root, "public-input");
  const output = join(root, "output");
  writeFileSync(input, "fixture");
  return { root, input, output };
}

describe("pinned OCI grader", () => {
  test("pins image/platform and applies bounded read-only credential-free isolation", () => {
    const { input, output } = roots();
    const invocation = buildPinnedOciInvocation({
      runtime: "docker",
      image: IMAGE,
      platform: "linux/amd64",
      inputs: [{ source: input, targetName: "campaign" }],
      outputDirectory: output,
      command: ["/usr/local/bin/grade", "--out", "/jinn/out/verdict"],
      timeoutMs: 60_000,
      profileRequiresNetwork: false,
    });
    expect(invocation.args).toContain("--read-only");
    expect(invocation.args).toContain("--pull");
    expect(invocation.args).toContain("never");
    expect(invocation.args).toContain("none");
    expect(invocation.args).toContain("ALL");
    expect(invocation.args).toContain("HOME=/tmp/jinn-grader-home");
    expect(invocation.args).toContain(IMAGE);
    expect(invocation.args.join(" ")).toContain("readonly");
    expect(invocation.args.join(" ")).not.toMatch(/secret|credential/u);
  });

  test("refuses mutable image identity, implicit network, host network, and credential mounts", () => {
    const { root, input, output } = roots();
    expect(() => buildPinnedOciInvocation({
      runtime: "docker", image: "ghcr.io/jinn/grader:latest", platform: "linux/amd64",
      inputs: [{ source: input, targetName: "campaign" }], outputDirectory: output,
      command: ["grade"], timeoutMs: 1_000, profileRequiresNetwork: false,
    })).toThrow(/pinned/u);
    expect(() => buildPinnedOciInvocation({
      runtime: "docker", image: IMAGE, platform: "linux/amd64",
      inputs: [{ source: input, targetName: "campaign" }], outputDirectory: output,
      command: ["grade"], timeoutMs: 1_000, profileRequiresNetwork: true,
    })).toThrow(/network/u);
    expect(() => buildPinnedOciInvocation({
      runtime: "docker", image: IMAGE, platform: "linux/amd64",
      inputs: [{ source: input, targetName: "campaign" }], outputDirectory: output,
      command: ["grade"], timeoutMs: 1_000, profileRequiresNetwork: true, allowedNetwork: "host",
    })).toThrow(/network/u);
    const secrets = join(root, "secrets");
    writeFileSync(secrets, "private key");
    expect(() => buildPinnedOciInvocation({
      runtime: "docker", image: IMAGE, platform: "linux/amd64",
      inputs: [{ source: secrets, targetName: "campaign" }], outputDirectory: output,
      command: ["grade"], timeoutMs: 1_000, profileRequiresNetwork: false,
    })).toThrow(/credential|signer/u);
  });
});

describe("host-side evaluator signing", () => {
  const expected: ExpectedEvaluationBindings = {
    task: { name: "subject-task.json", digest: { sha256: "1".repeat(64) } },
    results: [{ name: "result.patch", digest: { sha256: "2".repeat(64) } }],
    evaluatorId: "urn:jinn:evaluator-role",
    evaluatorSigningKeyId: "evaluator-role-key",
    evaluationSpecification: { name: "evaluation-spec.json", digest: { sha256: "3".repeat(64) } },
    evaluationMethod: { name: "swe-rebench", digest: { sha256: "4".repeat(64) } },
  };

  function statement() {
    return {
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
    };
  }

  test("signs only after exact canonical binding validation", async () => {
    const bytes = canonicalAttestationJsonBytes(statement());
    let signed = false;
    const sealed = await validateAndSignEvaluatorStatement({
      statementBytes: bytes,
      expected,
      signer: async () => {
        signed = true;
        return [{ keyid: "evaluator-role-key", signature: new Uint8Array([1, 2, 3]) }];
      },
    });
    expect(signed).toBe(true);
    expect(sealed.payloadBytes).toEqual(bytes);
  });

  test("fixture verdicts and changed bindings cannot satisfy the live signing path", async () => {
    const fixtureEnvelope = new Uint8Array(readFileSync(new URL(
      "../../../evidence/protocol/fixtures/golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json",
      import.meta.url,
    )));
    let signed = false;
    const signer = async () => {
      signed = true;
      return [{ signature: new Uint8Array([1]) }] as const;
    };
    await expect(validateAndSignEvaluatorStatement({
      statementBytes: fixtureEnvelope, expected, signer,
    })).rejects.toThrow(/statement/u);
    const changed = statement();
    changed.predicate.evaluator.id = "urn:jinn:fixture-evaluator";
    await expect(validateAndSignEvaluatorStatement({
      statementBytes: canonicalAttestationJsonBytes(changed), expected, signer,
    })).rejects.toThrow(/binding/u);
    expect(signed).toBe(false);
  });

  test("refuses a signer from any role other than the evaluator verdict role", async () => {
    await expect(validateAndSignEvaluatorStatement({
      statementBytes: canonicalAttestationJsonBytes(statement()),
      expected,
      signer: async () => [{
        keyid: "journal-author-key",
        signature: new Uint8Array([1, 2, 3]),
      }],
    })).rejects.toThrow(/signer key/u);
  });
});
