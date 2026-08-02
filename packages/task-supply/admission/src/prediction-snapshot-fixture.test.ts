import { describe, expect, it } from "vitest";
import { verifyPredictionSnapshotFixture } from "./prediction-snapshot-fixture.js";

describe("prediction snapshot golden fixture", () => {
  it("reproduces every exact native record without chain or database setup", async () => {
    const verified = await verifyPredictionSnapshotFixture();

    expect(verified.profile).toBe("https://jinn.network/task-profiles/prediction-forecast/1.0");
    expect(verified.operationId).toBe("native-prediction-forecast:will-jinn-ship:2026-08-02");
    expect(verified.artifactDigests).toStrictEqual(expect.objectContaining({
      task: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      evaluationSpec: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      admissionReceiptDsse: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      submission: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      requesterDsse: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    }));
  });
});
