import { describe, expect, it } from "vitest";
import { verifyPredictionSnapshotFixture } from "./prediction-snapshot-fixture.js";

describe("prediction snapshot golden fixture", () => {
  it("reproduces every exact native record without chain or database setup", async () => {
    const verified = await verifyPredictionSnapshotFixture();

    expect(verified.profile).toBe("https://jinn.network/task-profiles/prediction-forecast/1.0");
    expect(verified.operationId).toBe("native-prediction-forecast:40ae3efd61b75951:5514ad79452da75e");
    expect(verified.artifactDigests).toStrictEqual({
      task: "sha256:40ae3efd61b75951ad68a868fdd020de931e3d27eb1b448f341997bf4917a598",
      evaluationSpec: "sha256:4e9b938d24e7752630f0fb27c2295781a7b5ecfcb130daa28d320bbedd96e962",
      admissionReceiptDsse: "sha256:63f36443d682269bb3dd8f256e5f859f735abc0b14627e61ad50adce94ef826d",
      submission: "sha256:5514ad79452da75e10978092ae46c2e90eaaa69b239fc459b70712e2f8aeaed0",
      requesterDsse: "sha256:ae1282dbc54308fcf35fabc2764b7a6966dcd463be06393dd1550fb5cb923367",
    });
  });
});
