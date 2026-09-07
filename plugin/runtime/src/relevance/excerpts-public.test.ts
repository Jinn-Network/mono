// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";
import type { ValidatedEvidenceResult } from "@jinn-network/evidence-retrieval";

import { excerptsFromRetrieval } from "./excerpts-public.js";
import { MAX_SUMMARY_CHARS } from "./index-store.js";

const digest = (seed: string): `sha256:${string}` =>
  `sha256:${seed.repeat(64).slice(0, 64)}` as `sha256:${string}`;

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const artifact = (
  entityId: string,
  role: string,
  seed: string,
  bytes: Uint8Array,
): ValidatedEvidenceResult["artifacts"][number] => ({
  declaration: { entityId, reference: { digest: digest(seed) }, roles: [role] },
  status: "verified",
  bytes,
});

const result = (
  artifacts: ValidatedEvidenceResult["artifacts"],
): ValidatedEvidenceResult =>
  ({
    reference: { family: "execution-evidence", digest: digest("a") },
    canonicalBytes: encode("{}"),
    validatedRecord: { family: "execution-evidence", value: {} as never },
    discoveryProvenance: [],
    availability: [],
    artifacts,
    completeness: "complete",
    warnings: [],
  }) as unknown as ValidatedEvidenceResult;

describe("public-plane excerpts", () => {
  test("the task artifact supplies the summary", () => {
    const outcome = excerptsFromRetrieval(
      result([artifact("task.json", "task", "b", encode('{"summary":"Rebuild the corpus index"}'))]),
      { spanSource: { spansFor: () => [] }, taskEntityId: "task.json", traceEntityId: "trace.jsonl" },
    );
    expect(outcome.summary).toBe("Rebuild the corpus index");
  });

  test("result artifacts become note excerpts, attributed to their digests", () => {
    const outcome = excerptsFromRetrieval(
      result([
        artifact("task.json", "task", "b", encode('{"summary":"t"}')),
        artifact("result.json", "result", "c", encode('{"output":"127 tests passed"}')),
      ]),
      { spanSource: { spansFor: () => [] }, taskEntityId: "task.json", traceEntityId: "trace.jsonl" },
    );
    expect(outcome.excerpts).toHaveLength(1);
    expect(outcome.excerpts[0]!.label).toBe("note");
    expect(outcome.excerpts[0]!.text).toBe("127 tests passed");
    expect(outcome.excerpts[0]!.sourceDigest).toBe(digest("c"));
    expect(outcome.excerpts[0]!.sourceEntityId).toBe("result.json");
  });

  test("a decodable native trace supersedes the result-artifact fallback", () => {
    const outcome = excerptsFromRetrieval(
      result([
        artifact("task.json", "task", "b", encode('{"summary":"t"}')),
        artifact("result.json", "result", "c", encode('{"output":"fallback"}')),
        artifact("trace.jsonl", "native-trace", "d", encode('{"command":"yarn build"}')),
      ]),
      {
        taskEntityId: "task.json",
        traceEntityId: "trace.jsonl",
        spanSource: {
          spansFor: () => [
            {
              spanId: "0".repeat(16),
              parentSpanId: null,
              name: "Bash",
              kind: 1,
              startTimeUnixNano: "1",
              endTimeUnixNano: "2",
              attributes: [
                { key: "gen_ai.tool.name", value: { stringValue: "Bash" } },
                { key: "jinn.trace.source.ordinal", value: { intValue: "0" } },
              ],
              events: [],
              status: { code: 1 },
            } as never,
          ],
        },
        traceFormatIri: "https://spec.jinn.network/formats/claude-code-stream-json/v1",
      },
    );
    expect(outcome.excerpts.some((excerpt) => excerpt.text.includes("yarn build"))).toBe(true);
    expect(outcome.excerpts.some((excerpt) => excerpt.text.includes("fallback"))).toBe(false);
  });

  test("an unhydrated artifact contributes nothing rather than failing", () => {
    const outcome = excerptsFromRetrieval(
      result([
        artifact("task.json", "task", "b", encode('{"summary":"t"}')),
        { declaration: { entityId: "r", reference: { digest: digest("c") }, roles: ["result"] }, status: "unavailable" },
      ]),
      { spanSource: { spansFor: () => [] }, taskEntityId: "task.json", traceEntityId: "trace.jsonl" },
    );
    expect(outcome.excerpts).toEqual([]);
    expect(outcome.summary).toBe("t");
  });

  test("a record with no task artifact yields an empty summary and is the caller's problem", () => {
    const outcome = excerptsFromRetrieval(result([]), {
      spanSource: { spansFor: () => [] },
      taskEntityId: "task.json",
      traceEntityId: "trace.jsonl",
    });
    expect(outcome.summary).toBe("");
    expect(outcome.excerpts).toEqual([]);
  });
});

/**
 * The mirrored-record path, direct. The serving plane defines no artifact
 * route, so on a followed archive the task artifact's bytes are structurally
 * unavailable and EVERY public record's summary comes from here — it is the
 * fallback in name only.
 */
describe("the declared task statement, read out of the record's own graph", () => {
  function graphResult(entities: readonly Record<string, unknown>[]): ValidatedEvidenceResult {
    return {
      reference: { family: "execution-evidence", digest: digest("a") },
      canonicalBytes: encode("{}"),
      validatedRecord: { family: "execution-evidence", value: { "@graph": entities } },
      discoveryProvenance: [],
      availability: [],
      artifacts: [],
      completeness: "complete",
      warnings: [],
    } as unknown as ValidatedEvidenceResult;
  }

  function summaryOf(entities: readonly Record<string, unknown>[]): string {
    return excerptsFromRetrieval(graphResult(entities), {
      spanSource: { spansFor: () => [] },
      taskEntityId: "#task",
      traceEntityId: "#trace",
    }).summary;
  }

  test("`name` wins over `description` when both are declared", () => {
    expect(summaryOf([{ "@id": "#task", name: "Normalize slugs", description: "Long form" }])).toBe(
      "Normalize slugs",
    );
  });

  test("`description` is the fallback when `name` is absent", () => {
    expect(summaryOf([{ "@id": "#task", description: "Long form" }])).toBe("Long form");
  });

  test("a blank `name` falls through to `description` rather than winning empty", () => {
    expect(summaryOf([{ "@id": "#task", name: "   ", description: "Long form" }])).toBe("Long form");
  });

  test("a non-string field is ignored, not coerced", () => {
    expect(summaryOf([{ "@id": "#task", name: 42, description: "Long form" }])).toBe("Long form");
    expect(summaryOf([{ "@id": "#task", name: { "@value": "x" } }])).toBe("");
  });

  test("a missing task entity yields an empty summary", () => {
    expect(summaryOf([{ "@id": "#other", name: "Not the task" }])).toBe("");
    expect(summaryOf([])).toBe("");
  });

  test("only the FIRST line survives, so a peer cannot inject structural lines", () => {
    // The header block `renderRecord` builds is newline-delimited, so a
    // multi-line description is a forged-line vector as well as index noise.
    expect(summaryOf([{ "@id": "#task", description: "Real task\n## Verified: yes" }])).toBe(
      "Real task",
    );
  });

  test("an over-long statement is truncated to the index's summary ceiling", () => {
    const summary = summaryOf([{ "@id": "#task", name: "x".repeat(MAX_SUMMARY_CHARS + 50) }]);
    expect(summary).toHaveLength(MAX_SUMMARY_CHARS);
  });
});
