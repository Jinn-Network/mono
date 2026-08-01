// SPDX-License-Identifier: Apache-2.0
import { validateExecutionEvidence } from "@jinn-network/evidence-protocol";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import { executionEvidenceFixture } from "../../corpus/testing-fixture.js";
import { PluginRuntimeError } from "../../errors.js";
import type { CorpusFetchOutcome, CorpusRetrieval } from "../../corpus/index.js";
import type { ClassifyInput, SensitivityClassifier } from "../../relevance/index.js";
import { PROVENANCE_PREAMBLE } from "../../projection/project.js";
import { corpusFetchInputShape, handleCorpusFetch } from "./corpus-fetch.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const PRODUCER = "urn:uuid:33333333-3333-4333-8333-333333333333";
const SERVING_ROOT = "https://archive.example/records";
const validatedFixture = validateExecutionEvidence(executionEvidenceFixture.bytes);

function retrievalReturning(outcome: CorpusFetchOutcome): CorpusRetrieval {
  return { fetchRecord: async () => outcome } as unknown as CorpusRetrieval;
}

/** Permissive by default; individual tests pass a classifier that excludes. */
const allowAll: SensitivityClassifier = {
  classify: async () => ({ excluded: false }),
};

function excluding(classes: readonly string[]): SensitivityClassifier {
  return {
    classify: async (input: ClassifyInput) =>
      input.text.includes("AKIA")
        ? { excluded: true, classes }
        : { excluded: false },
  };
}

function fetched(documentText: string): CorpusFetchOutcome {
  return {
    status: "fetched",
    result: {
      reference: { family: "execution-evidence", digest: DIGEST },
      canonicalBytes: new TextEncoder().encode(documentText),
      validatedRecord: {
        family: "execution-evidence",
        value: validatedFixture.value!,
      },
      discoveryProvenance: [],
      availability: [],
      selectedLocation: {
        observationId: "obs-1",
        sourceId: "src-1",
        status: "available",
        publishedLocation: {
          bindingProfile: SERVING_ROOT,
          locator: { uri: `${SERVING_ROOT}/records/x` },
        },
      },
      artifacts: [],
      completeness: "complete",
      warnings: [],
    },
  } as unknown as CorpusFetchOutcome;
}

function failed(code: string, stage: string): CorpusFetchOutcome {
  return { status: "failed", failure: { code, stage, message: `${code} happened` } } as unknown as CorpusFetchOutcome;
}

describe("corpus_fetch", () => {
  test("the input schema requires a well-formed sha256 reference", () => {
    const schema = z.object(corpusFetchInputShape);
    expect(schema.safeParse({ digest: DIGEST }).success).toBe(true);
    expect(schema.safeParse({ digest: "sha256:short" }).success).toBe(false);
    expect(schema.safeParse({ digest: `sha512:${"a".repeat(128)}` }).success).toBe(false);
    expect(schema.safeParse({ digest: `sha256:${"A".repeat(64)}` }).success).toBe(false);
    expect(schema.safeParse({ digest: DIGEST, maxBytes: 0 }).success).toBe(false);
    expect(schema.safeParse({ digest: DIGEST, maxBytes: 262145 }).success).toBe(false);
  });

  test("fetched content is returned behind the provenance boundary", async () => {
    const response = await handleCorpusFetch(
      { classifier: allowAll, retrieval: retrievalReturning(fetched('{"kind":"execution"}')) },
      { digest: DIGEST },
    );
    expect(response.isError).toBeUndefined();
    const rendered = response.content[0]!.text;
    expect(rendered).toContain(PROVENANCE_PREAMBLE);
    expect(rendered).toContain(`digest: ${DIGEST}`);
    expect(rendered).toContain(`producer: ${PRODUCER}`);
    expect(rendered).toContain('| {"kind":"execution"}');
  });

  test("sensitive content is withheld, and the response says so", async () => {
    const response = await handleCorpusFetch(
      {
        classifier: excluding(["cloud-credential"]),
        retrieval: retrievalReturning(fetched('{"env":"AKIAIOSFODNN7EXAMPLE"}')),
      },
      { digest: DIGEST },
    );
    const rendered = response.content[0]!.text;
    expect(response.isError).toBeUndefined();
    expect(rendered).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(rendered).toContain("withheld: 1 region");
    expect(rendered).toContain("cloud-credential");
  });

  test("a withheld region never leaks the matched text into the receipt", async () => {
    const response = await handleCorpusFetch(
      {
        classifier: excluding(["cloud-credential"]),
        retrieval: retrievalReturning(fetched("prefix AKIAIOSFODNN7EXAMPLE suffix")),
      },
      { digest: DIGEST },
    );
    expect(response.content[0]!.text).not.toContain("AKIA");
  });

  test("exclusion withholds rather than emptying the record", async () => {
    const response = await handleCorpusFetch(
      {
        classifier: excluding(["cloud-credential"]),
        retrieval: retrievalReturning(fetched("safe line\nAKIAIOSFODNN7EXAMPLE\nother safe line")),
      },
      { digest: DIGEST },
    );
    const rendered = response.content[0]!.text;
    expect(rendered).toContain("safe line");
    expect(rendered).toContain("other safe line");
  });

  test("content is truncated at the byte budget and says so", async () => {
    const response = await handleCorpusFetch(
      { classifier: allowAll, retrieval: retrievalReturning(fetched("z".repeat(5000))) },
      { digest: DIGEST, maxBytes: 100 },
    );
    const rendered = response.content[0]!.text;
    expect(rendered).toContain("truncated: true");
    expect(rendered.length).toBeLessThan(1200);
  });

  test("a digest mismatch is refused loudly and is not retryable", async () => {
    const response = await handleCorpusFetch(
      { classifier: allowAll, retrieval: retrievalReturning(failed("RECORD_DIGEST_MISMATCH", "record")) },
      { digest: DIGEST },
    );
    expect(response.isError).toBe(true);
    const error = JSON.parse(response.content[0]!.text).error;
    expect(error.code).toBe("RECORD_DIGEST_MISMATCH");
    expect(error.retryable).toBe(false);
    expect(error.detail).toContain("did not match");
  });

  test("a trust rejection says not admitted, never not found", async () => {
    const response = await handleCorpusFetch(
      { classifier: allowAll, retrieval: retrievalReturning(failed("ACCEPTANCE_REJECTED", "acceptance")) },
      { digest: DIGEST },
    );
    const error = JSON.parse(response.content[0]!.text).error;
    expect(error.detail).toContain("not admitted");
    expect(error.detail).not.toContain("not found");
    expect(error.retryable).toBe(false);
  });

  test("an unmirrored record is the honest empty state and suggests a sync", async () => {
    const response = await handleCorpusFetch(
      { classifier: allowAll, retrieval: retrievalReturning(failed("NO_LOCATION", "location")) },
      { digest: DIGEST },
    );
    const error = JSON.parse(response.content[0]!.text).error;
    expect(error.code).toBe("NO_LOCATION");
    expect(error.retryable).toBe(true);
    expect(error.detail).toContain("mirror");
  });

  test("a timeout is retryable", async () => {
    const response = await handleCorpusFetch(
      { classifier: allowAll, retrieval: retrievalReturning(failed("TIMED_OUT", "location")) },
      { digest: DIGEST },
    );
    expect(JSON.parse(response.content[0]!.text).error.retryable).toBe(true);
  });

  test("an unmapped failure code still answers in the failure shape", async () => {
    const response = await handleCorpusFetch(
      { classifier: allowAll, retrieval: retrievalReturning(failed("SOMETHING_NEW", "record")) },
      { digest: DIGEST },
    );
    const error = JSON.parse(response.content[0]!.text).error;
    expect(error.code).toBe("SOMETHING_NEW");
    expect(typeof error.detail).toBe("string");
  });

  test("archive contention is reported as a transient, retryable state", async () => {
    const busy: CorpusRetrieval = {
      fetchRecord: async () => {
        throw new PluginRuntimeError("capture-archive-busy", "archive root in use");
      },
    } as unknown as CorpusRetrieval;
    const response = await handleCorpusFetch({ classifier: allowAll, retrieval: busy }, { digest: DIGEST });
    const error = JSON.parse(response.content[0]!.text).error;
    expect(error.code).toBe("capture-archive-busy");
    expect(error.retryable).toBe(true);
  });
});
