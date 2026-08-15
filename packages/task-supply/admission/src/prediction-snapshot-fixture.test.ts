import { describe, expect, it } from "vitest";
import { verifyPredictionSnapshotFixture } from "./prediction-snapshot-fixture.js";

describe("prediction snapshot golden fixture", () => {
  it("reproduces every exact native record without chain or database setup", async () => {
    const verified = await verifyPredictionSnapshotFixture();

    // #2534 F3b: these pins moved with the fixture. The Task used to name the transcribed
    // `sha256:e61dc765…` profile digest, which no sealed prediction-forecast/1.0 document has had
    // since the profile was re-sealed under spec.jinn.network — so the golden fixture agreed with
    // the stale constant and this suite stayed green while every live solve was rejected. The Task
    // now names the derived digest, so its digest (and the Submission/receipt over it) shifted.
    expect(verified.profile).toBe("https://spec.jinn.network/task-profiles/prediction-forecast/1.0");
    expect(verified.operationId).toBe("native-prediction-forecast:c0c3d703b3938a94:e65e9abf1caa3332");
    expect(verified.artifactDigests).toStrictEqual({
      task: "sha256:c0c3d703b3938a944095dcc91b4ec7da96f1bc10b1bb85b0419440a5f44d1204",
      evaluationSpec: "sha256:a6821a066168cb199adf550ec515ad14dc7f9a27587963cbb5cc549732a31e0c",
      admissionReceiptDsse: "sha256:08ec0c0c186ca4109bfb2aaec7e80106008933a51a10c78d4879e02a5471111b",
      submission: "sha256:e65e9abf1caa33321d28e73944d1bdab49ae4f4282ce13d69e9a7251cf8c140b",
      requesterDsse: "sha256:198c65a8a00b370ce6b73a84d18c2f2d0e1bb4f4e38461cf1c140bb2ce9d68ac",
    });
  });
});
