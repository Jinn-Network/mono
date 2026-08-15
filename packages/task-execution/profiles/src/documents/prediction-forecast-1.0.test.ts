import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PREDICTION_FORECAST_PROFILE_URI } from "../identifiers.js";
import {
  PREDICTION_FORECAST_PROFILE_DIGEST,
  PREDICTION_FORECAST_PROFILE_DIGEST_HEX,
  buildPredictionForecastProfile,
} from "./prediction-forecast-1.0.js";
import { parseTaskProfile, sealTaskProfile } from "../task-profile/seal.js";

const pinnedDigest = async (): Promise<string> => (await readFile(new URL(
  "../../profiles/task-profiles/prediction-forecast/1.0/profile.sha256",
  import.meta.url,
), "utf8")).trim();

describe("prediction-forecast/1.0 sealed document", () => {
  it("seals the native forecast contract with one bounded prediction output", async () => {
    const profile = buildPredictionForecastProfile();
    const sealed = sealTaskProfile(profile);
    const pinned = await pinnedDigest();

    expect(profile.profile).toBe(PREDICTION_FORECAST_PROFILE_URI);
    expect(profile.outputConventions.slots).toStrictEqual([
      expect.objectContaining({ name: "prediction", required: true, mediaType: "application/json" }),
    ]);
    expect(profile.payloadSchema.required).toEqual(["forecast"]);
    expect(sealed.digest).toBe(pinned);
    expect(parseTaskProfile(sealed.bytes)).toStrictEqual(profile);
  });
});

// #2534 F3b. `sha256:e61dc765…` was transcribed into two other packages and then left behind when
// the profile was re-sealed under `spec.jinn.network`. Consumers now import the exported constant
// rather than transcribing, so this is the one place a drift between the exported digest and the
// sealed fixture can surface — and it surfaces as a red test rather than as every prediction solve
// failing with "profile digest … is not resolvable in the store".
describe("PREDICTION_FORECAST_PROFILE_DIGEST", () => {
  it("equals the sealed profile.sha256 fixture", async () => {
    expect(PREDICTION_FORECAST_PROFILE_DIGEST).toBe(await pinnedDigest());
  });

  it("is derived from the builder, so it cannot be transcribed stale", () => {
    expect(PREDICTION_FORECAST_PROFILE_DIGEST)
      .toBe(sealTaskProfile(buildPredictionForecastProfile()).digest);
  });

  it("exposes bare lowercase hex for the Task documents that carry digest.sha256", () => {
    expect(PREDICTION_FORECAST_PROFILE_DIGEST_HEX).toMatch(/^[0-9a-f]{64}$/u);
    expect(`sha256:${PREDICTION_FORECAST_PROFILE_DIGEST_HEX}`).toBe(PREDICTION_FORECAST_PROFILE_DIGEST);
  });
});
