// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";
import type { ValidatedEvidenceResult } from "@jinn-network/evidence-retrieval";

import { excerptsFromRetrieval } from "./excerpts-public.js";

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
      { spanSource: { spansFor: () => [] } },
    );
    expect(outcome.summary).toBe("Rebuild the corpus index");
  });

  test("result artifacts become note excerpts, attributed to their digests", () => {
    const outcome = excerptsFromRetrieval(
      result([
        artifact("task.json", "task", "b", encode('{"summary":"t"}')),
        artifact("result.json", "result", "c", encode('{"output":"127 tests passed"}')),
      ]),
      { spanSource: { spansFor: () => [] } },
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
                { key: "jinn.trajectory.source.ordinal", value: { intValue: "0" } },
              ],
              events: [],
              status: { code: 1 },
            } as never,
          ],
        },
        traceFormatIri: "https://jinn.network/formats/claude-code-stream-json/v1",
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
      { spanSource: { spansFor: () => [] } },
    );
    expect(outcome.excerpts).toEqual([]);
    expect(outcome.summary).toBe("t");
  });

  test("a record with no task artifact yields an empty summary and is the caller's problem", () => {
    const outcome = excerptsFromRetrieval(result([]), { spanSource: { spansFor: () => [] } });
    expect(outcome.summary).toBe("");
    expect(outcome.excerpts).toEqual([]);
  });
});
