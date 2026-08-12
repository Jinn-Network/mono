import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { canonicalJsonBytes, decodeUtf8 } from "./bytes.js";
import { requiredMeasurementNames } from "./evaluation-spec/measurements.js";
import type { EvaluationSpec } from "./evaluation-spec/schema.js";
import {
  ResultEvaluationStatementShape,
  buildVerdictEnvelope,
  type ResultEvaluationStatement,
} from "./result-evaluation.js";

describe("ResultEvaluationStatementShape — byte-pinned against real Evidence bytes (Finding 8)", () => {
  it("parses, round-trips, and deep-equals the byte-copied Evidence golden statement", async () => {
    const raw = await readFile(
      new URL("../fixtures/result-evaluation/golden/evidence-statement.json", import.meta.url),
      "utf8",
    );
    const original = JSON.parse(raw) as unknown;

    const parsed = ResultEvaluationStatementShape.parse(original);

    // Round-trip through this package's own canonical serializer: JCS re-sorts object keys, so
    // this checks shapes/types survive, not authored field order.
    const roundTripped = JSON.parse(decodeUtf8(canonicalJsonBytes(parsed)));
    expect(roundTripped).toEqual(original);

    // Spot-assert the exact shapes the design calls out as traps.
    for (const subject of parsed.subject) {
      expect(subject.digest).toEqual({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    }
    expect(parsed.predicate.evaluationSpecification).toMatchObject({ name: expect.any(String), digest: { sha256: expect.any(String) } });
    expect(parsed.predicate.evaluationMethod).toMatchObject({ name: expect.any(String), digest: { sha256: expect.any(String) } });
    expect(typeof parsed.predicate.taskSubject).toBe("string");
    expect(parsed.predicate.taskSubject).not.toMatch(/^sha256:/);
  });
});

describe("buildVerdictEnvelope — the delivered verdict IS the claim (design §9.2)", () => {
  it("produces a DSSE envelope whose decoded Statement structurally matches the shape and covers the spec's required measurements", async () => {
    const specRaw = JSON.parse(
      await readFile(new URL("../fixtures/evaluation-spec/golden/deterministic-minimal.json", import.meta.url), "utf8"),
    ) as EvaluationSpec;

    const subjectTask = {
      name: "execution/task/task.md",
      digest: { sha256: "37bbbbed5fd87cbc8c1b2084b1c48b52170cfe0d9d0ac70f0ebe26ef3d835c9b" },
    };
    const subjectResults = [
      {
        name: "execution/results/a-result.patch",
        digest: { sha256: "84db80aea1c9efdf9780191c37db919c78aef24a63eba74ef9c8cbc2a8186c89" },
      },
    ];

    const required = requiredMeasurementNames(specRaw);
    expect(required).toEqual(["passed"]);

    const statement: ResultEvaluationStatement = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [subjectTask, ...subjectResults],
      predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
      predicate: {
        evaluatedAt: "2026-07-28T00:00:00Z",
        evaluator: { id: "urn:uuid:00000000-0000-4000-8000-000000000000" },
        taskSubject: subjectTask.name,
        resultSubjects: subjectResults.map((result) => result.name),
        verdict: "pass",
        measurements: required.map((name) => ({ name, value: true })),
      },
    };

    const envelopeBytes = buildVerdictEnvelope(statement, [{ sig: "deadbeef", keyid: "evaluator-key-1" }]);
    const envelope = JSON.parse(decodeUtf8(envelopeBytes)) as {
      payloadType: string;
      payload: string;
      signatures: { keyid?: string; sig: string }[];
    };
    expect(envelope.payloadType).toBe("application/vnd.in-toto+json");

    const decoded = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    const parsedStatement = ResultEvaluationStatementShape.parse(decoded);
    expect(parsedStatement.subject).toEqual([subjectTask, ...subjectResults]);

    const deliveredNames = new Set((parsedStatement.predicate.measurements ?? []).map((m) => m.name));
    for (const name of required) {
      expect(deliveredNames.has(name), `measurement "${name}" must be delivered`).toBe(true);
    }
  });

  // Regression for the defect-#34 class (canonical JCS DSSE envelope encoding): the envelope
  // BYTES are the producer's contract. An insertion-ordered `JSON.stringify` spelling of the
  // same envelope object is refused by trust-core's authority-bearing `parseExactDsseEnvelope`
  // (it reconstructs through `sealDsseEnvelope` and byte-compares), so the producer must emit
  // the canonical encoding itself rather than leave the serialization to each caller.
  it("returns exact canonical JCS envelope bytes — code-unit-sorted keys, compact, no trailing newline", () => {
    const statement: ResultEvaluationStatement = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{
        name: "execution/task/task.md",
        digest: { sha256: "37bbbbed5fd87cbc8c1b2084b1c48b52170cfe0d9d0ac70f0ebe26ef3d835c9b" },
      }],
      predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
      predicate: {
        evaluatedAt: "2026-07-28T00:00:00Z",
        evaluator: { id: "urn:uuid:00000000-0000-4000-8000-000000000000" },
        taskSubject: "execution/task/task.md",
        resultSubjects: ["execution/task/task.md"],
        verdict: "pass",
      },
    };
    const payloadBase64 = Buffer.from(canonicalJsonBytes(statement)).toString("base64");

    const bytes = buildVerdictEnvelope(statement, [{ keyid: "evaluator-key-1", sig: "AA==" }]);

    // Hand-sorted independent expectation ("payload" < "payloadType" < "signatures";
    // "keyid" < "sig" in code-unit order), NOT derived from the implementation's serializer.
    expect(Buffer.from(bytes).toString("utf8")).toBe(
      `{"payload":"${payloadBase64}","payloadType":"application/vnd.in-toto+json",`
      + `"signatures":[{"keyid":"evaluator-key-1","sig":"AA=="}]}`,
    );
  });

  it("omits an undefined keyid from the sealed signature member instead of refusing to seal", () => {
    const statement: ResultEvaluationStatement = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{
        name: "execution/task/task.md",
        digest: { sha256: "37bbbbed5fd87cbc8c1b2084b1c48b52170cfe0d9d0ac70f0ebe26ef3d835c9b" },
      }],
      predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
      predicate: {
        evaluatedAt: "2026-07-28T00:00:00Z",
        evaluator: { id: "urn:uuid:00000000-0000-4000-8000-000000000000" },
        taskSubject: "execution/task/task.md",
        resultSubjects: ["execution/task/task.md"],
        verdict: "pass",
      },
    };

    const bytes = buildVerdictEnvelope(statement, [{ sig: "AA==" }]);

    const envelope = JSON.parse(decodeUtf8(bytes)) as { signatures: Record<string, unknown>[] };
    expect(envelope.signatures).toEqual([{ sig: "AA==" }]);
  });
});
