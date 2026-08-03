import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PREDICTION_FORECAST_PROFILE_URI } from "../identifiers.js";
import { buildPredictionForecastProfile } from "./prediction-forecast-1.0.js";
import { parseTaskProfile, sealTaskProfile } from "../task-profile/seal.js";

describe("prediction-forecast/1.0 sealed document", () => {
  it("seals the native forecast contract with one bounded prediction output", async () => {
    const profile = buildPredictionForecastProfile();
    const sealed = sealTaskProfile(profile);
    const pinned = (await readFile(new URL(
      "../../profiles/task-profiles/prediction-forecast/1.0/profile.sha256",
      import.meta.url,
    ), "utf8")).trim();

    expect(profile.profile).toBe(PREDICTION_FORECAST_PROFILE_URI);
    expect(profile.outputConventions.slots).toStrictEqual([
      expect.objectContaining({ name: "prediction", required: true, mediaType: "application/json" }),
    ]);
    expect(profile.payloadSchema.required).toEqual(["forecast"]);
    expect(sealed.digest).toBe(pinned);
    expect(parseTaskProfile(sealed.bytes)).toStrictEqual(profile);
  });
});
