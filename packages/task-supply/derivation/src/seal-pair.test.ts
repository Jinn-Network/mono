// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  parseEvaluationSpec,
  sealEvaluationSpec,
  sweRebenchRowToTaskAndSpec,
} from "@jinn-network/task-execution-profiles";
import { sealEnvironmentRecord } from "@jinn-network/environment-record";
import { checkInlineEnvironmentMatch } from "@jinn-network/task-admission";
import { sealTask } from "@jinn-network/task-execution-protocol";
import { readEnvironmentRecordExtension } from "./environment-extension.js";
import { buildCandidateEvaluationSpec, buildSealedTask } from "./seal-pair.js";
import { computeSourceCommitment } from "./source-commitment.js";
import { loadDerivationEnvironment } from "./strategy.js";
import { buildFixtureCandidate, buildFixtureEnvironmentRecordBody } from "./testing-support.js";

function environment(overrides: Record<string, unknown> = {}) {
  const body = { ...buildFixtureEnvironmentRecordBody(), ...overrides };
  return loadDerivationEnvironment(sealEnvironmentRecord(body as never));
}

const decoder = new TextDecoder();

describe("sealed pair", () => {
  it("copies image, platform and parser FROM the record, so C3's match rule passes by construction", () => {
    const env = environment();
    const spec = buildCandidateEvaluationSpec(buildFixtureCandidate(), env);
    const block = spec.document.familyBlock as Record<string, never>;

    expect((block["image"] as { uri: string }).uri).toBe(env.record.image.reference);
    expect((block["image"] as { digest: { sha256: string } }).digest.sha256)
      .toBe(env.record.image.manifestDigest.slice("sha256:".length));
    expect(block["platform"]).toBe(env.record.image.platform);
    expect(block["parser"]).toEqual({
      id: env.record.parser.id,
      version: env.record.parser.version,
      digest: env.record.parser.digest,
    });
  });

  it("seals a pair from a record that declares no advisory image reference", () => {
    const base = buildFixtureEnvironmentRecordBody();
    // §4.2 makes `reference` an optional pull hint; `manifestDigest` is the identity. A record
    // that omits the hint is well-formed, and the DigestSet alone satisfies the descriptor's
    // locator rule (protocol `resourceDescriptorHasLocator`).
    const env = environment({
      image: { manifestDigest: base.image.manifestDigest, platform: base.image.platform },
    });
    const spec = buildCandidateEvaluationSpec(buildFixtureCandidate(), env);
    const image = (spec.document.familyBlock as Record<string, unknown>)["image"] as {
      digest: { sha256: string };
    };

    expect(image).not.toHaveProperty("uri");
    expect(image.digest.sha256).toBe(base.image.manifestDigest.slice("sha256:".length));
    // C3 resolves the manifest digest from the DigestSet when there is no reference to read.
    expect(checkInlineEnvironmentMatch(env.record, spec.document, env.recordDigest))
      .toEqual({ fields: ["image", "parser", "platform"], specKeyPresent: true });
  });

  it("overrides the mapper's hardcoded platform for a non-amd64 record", () => {
    const base = buildFixtureEnvironmentRecordBody();
    const env = environment({ image: { ...base.image, platform: "linux/arm64" } });
    const spec = buildCandidateEvaluationSpec(buildFixtureCandidate(), env);
    expect((spec.document.familyBlock as Record<string, unknown>)["platform"]).toBe("linux/arm64");
  });

  it("drops the record parser's advisory uri — ParserIdentitySchema is strict", () => {
    const spec = buildCandidateEvaluationSpec(buildFixtureCandidate(), environment());
    expect((spec.document.familyBlock as Record<string, Record<string, unknown>>)["parser"])
      .not.toHaveProperty("uri");
  });

  it("stamps every test-material descriptor and the grader public (D5)", () => {
    const spec = buildCandidateEvaluationSpec(buildFixtureCandidate(), environment());
    const block = spec.document.familyBlock as { testMaterial: { accessClass?: string }[] };
    for (const material of block.testMaterial) expect(material.accessClass).toBe("public");
    expect((spec.document.grader as { accessClass?: string }).accessClass).toBe("public");
  });

  it("carries the namespaced environment-record key, and the sealed bytes still validate", () => {
    const env = environment();
    const spec = buildCandidateEvaluationSpec(buildFixtureCandidate(), env);
    expect(readEnvironmentRecordExtension(spec.document.familyBlock as Record<string, unknown>))
      .toBe(env.recordDigest);
    const reparsed = parseEvaluationSpec(spec.bytes);
    expect(sealEvaluationSpec(reparsed).bytes).toEqual(spec.bytes);
    expect(spec.digest).toBe(sealEvaluationSpec(spec.document).digest);
  });

  it("uses the statement verbatim as the Task's instructions, whitespace included", () => {
    const candidate = buildFixtureCandidate({ statement: "Trailing space and CRLF.  \r\n" });
    const env = environment();
    const spec = buildCandidateEvaluationSpec(candidate, env);
    const task = buildSealedTask(candidate, env, spec.digest);
    const document = JSON.parse(decoder.decode(task.bytes)) as { instructions: string };
    expect(document.instructions).toBe("Trailing space and CRLF.  \r\n");
  });

  it("writes provenance.kind mined, the source commitment, and the SPDX licence", () => {
    const candidate = buildFixtureCandidate();
    const env = environment();
    const spec = buildCandidateEvaluationSpec(candidate, env);
    const task = buildSealedTask(candidate, env, spec.digest);
    const document = JSON.parse(decoder.decode(task.bytes)) as {
      payload: {
        instance_id: string;
        provenance: { kind: string; sourceCommitment: string; timestamp: string };
        rights: { sourceLicense: string };
      };
      inputs: { name: string; uri: string; annotations: { ref: string } }[];
      evaluation: { digest: { sha256: string } };
    };

    expect(document.payload.provenance.kind).toBe("mined");
    expect(document.payload.provenance.sourceCommitment)
      .toBe(computeSourceCommitment(candidate.provenance.upstream, candidate.statement));
    expect(document.payload.provenance.timestamp).toBe(candidate.provenance.timestamp);
    expect(document.payload.instance_id).toBe(candidate.provenance.upstream.instanceId);
    expect(document.payload.rights.sourceLicense).toBe("Apache-2.0");
    expect(document.inputs[0]).toEqual({
      name: "repository-state",
      uri: env.record.source.repoUrl,
      annotations: { ref: env.record.source.commit },
    });
    expect(document.evaluation.digest.sha256).toBe(spec.digest.slice("sha256:".length));
  });

  it("keeps the locally built payload aligned with the profiles mapper (Finding (d) drift guard)", () => {
    const candidate = buildFixtureCandidate();
    const env = environment();
    const task = buildSealedTask(
      candidate,
      env,
      buildCandidateEvaluationSpec(candidate, env).digest,
    );
    const document = JSON.parse(decoder.decode(task.bytes)) as { payload: Record<string, unknown> };
    const mapped = sweRebenchRowToTaskAndSpec({
      instance_id: candidate.provenance.upstream.instanceId,
      repo: env.record.source.repo,
      base_commit: env.record.source.commit,
      problem_statement: candidate.statement,
      language: candidate.language,
      image: { uri: env.record.image.reference },
      testMaterial: [{ name: "t", digest: { sha256: "0".repeat(64) } }],
      parser: {
        id: env.record.parser.id,
        version: env.record.parser.version,
        digest: env.record.parser.digest,
      },
      transitions: { failToPass: ["a"], passToPass: [] },
      timeout: 900,
    }).taskPayload as Record<string, unknown>;

    expect(document.payload["instance_id"]).toBe(mapped["instance_id"]);
    expect(document.payload["language"]).toBe(mapped["language"]);
    expect((document.payload["provenance"] as { kind: string }).kind)
      .toBe((mapped["provenance"] as { kind: string }).kind);
  });

  it("re-seals to identical bytes, so the namespaced key survives a round trip (F4 locally)", () => {
    const candidate = buildFixtureCandidate();
    const env = environment();
    const spec = buildCandidateEvaluationSpec(candidate, env);
    const task = buildSealedTask(candidate, env, spec.digest);
    expect(sealTask(JSON.parse(decoder.decode(task.bytes)))).toEqual(task.bytes);
  });

  it("puts no gold patch bytes in either sealed document", () => {
    const candidate = buildFixtureCandidate();
    const env = environment();
    const spec = buildCandidateEvaluationSpec(candidate, env);
    const task = buildSealedTask(candidate, env, spec.digest);
    const gold = decoder.decode(candidate.goldPatch);
    // Base64 as well as plaintext: `testMaterial[].content` is the one channel by which patch
    // material rides into a sealed spec at all, and it is base64.
    const goldBase64 = Buffer.from(candidate.goldPatch).toString("base64");
    for (const bytes of [task.bytes, spec.bytes]) {
      expect(decoder.decode(bytes)).not.toContain(gold);
      expect(decoder.decode(bytes)).not.toContain(goldBase64);
    }
  });
});
