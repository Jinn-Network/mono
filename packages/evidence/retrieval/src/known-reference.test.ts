import { describe, expect, test } from "vitest";

import { retrieveKnownReference } from "./known-reference.js";
import { createKnownReferenceFixture } from "./test-support.js";

describe("retrieveKnownReference", () => {
  test("retrieves a known reference without invoking candidate search", async () => {
    const fixture = await createKnownReferenceFixture();
    const outcome = await retrieveKnownReference(
      fixture.dependencies,
      { reference: fixture.reference },
    );
    expect(outcome).toMatchObject({
      status: "validated",
      result: {
        reference: fixture.reference,
        discoveryProvenance: [],
        artifacts: [],
        completeness: "complete",
      },
    });
    expect(fixture.locator.locate).toHaveBeenCalledOnce();
    expect(fixture.repository.getRecord).toHaveBeenCalledWith(
      fixture.reference,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  test("returns a typed failure and never exposes invalid bytes", async () => {
    const fixture = await createKnownReferenceFixture({
      returnedRecordBytes: new TextEncoder().encode("wrong"),
    });
    const outcome = await retrieveKnownReference(
      fixture.dependencies,
      { reference: fixture.reference },
    );
    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "RECORD_DIGEST_MISMATCH" },
    });
    expect(outcome).not.toHaveProperty("result");
  });
});
