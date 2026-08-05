import { describe, expect, it } from "vitest";
import { verifyPredictionSnapshotFixture } from "./prediction-snapshot-fixture.js";

describe("prediction snapshot golden fixture", () => {
  it("reproduces every exact native record without chain or database setup", async () => {
    const verified = await verifyPredictionSnapshotFixture();

    expect(verified.profile).toBe("https://spec.jinn.network/task-profiles/prediction-forecast/1.0");
    expect(verified.operationId).toBe("native-prediction-forecast:5f021ff3ba8f132c:3a55080f7e764705");
    expect(verified.artifactDigests).toStrictEqual({
      task: "sha256:5f021ff3ba8f132c19d43e0ec4bb927ac53da9f659827e2490c6e181d687fe69",
      evaluationSpec: "sha256:a6821a066168cb199adf550ec515ad14dc7f9a27587963cbb5cc549732a31e0c",
      admissionReceiptDsse: "sha256:02cc633a85bbb2e5714431164f4abd6e881019d71f91af1ab83ee0184cde4aaf",
      submission: "sha256:3a55080f7e7647050d7351295f97c8d10369478f0b11a4c37c02284f54587c5d",
      requesterDsse: "sha256:060a04de17ac1b02b3f2463cdd36b7b8fca843a356c42ce9e8283fb24fe252a9",
    });
  });
});
