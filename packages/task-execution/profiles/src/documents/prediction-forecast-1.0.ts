import { PREDICTION_FORECAST_PROFILE_URI, TASK_PROFILE_FORMAT_URI } from "../identifiers.js";
import { sealTaskProfile } from "../task-profile/seal.js";
import type { TaskProfileDocument } from "../task-profile/schema.js";

/**
 * The bounded, public prediction-market task contract. The request records the exact
 * posted-time consensus snapshot; the solver delivers precisely one prediction document.
 */
export function buildPredictionForecastProfile(): TaskProfileDocument {
  return {
    protocol: TASK_PROFILE_FORMAT_URI,
    profile: PREDICTION_FORECAST_PROFILE_URI,
    description:
      "Public deterministic prediction forecast: a pinned market snapshot yields exactly one "
      + "bounded probability prediction.",
    payloadSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        forecast: {
          type: "object",
          additionalProperties: false,
          properties: {
            marketId: { type: "string" },
            question: { type: "string" },
            consensusProbabilityYes: { pattern: "^(0(\\.\\d+)?|1(\\.0+)?)$", type: "string" },
            observedAt: { format: "date-time", type: "string" },
            resolvesAt: { format: "date-time", type: "string" },
          },
          required: ["marketId", "question", "consensusProbabilityYes", "observedAt", "resolvesAt"],
        },
      },
      required: ["forecast"],
    },
    inputConventions: { slots: [] },
    outputConventions: {
      slots: [{
        name: "prediction",
        required: true,
        mediaType: "application/json",
        schema: {
          name: "prediction.schema.json",
          content: JSON.stringify({
            type: "object",
            additionalProperties: false,
            properties: {
              probabilityYes: { type: "string", pattern: "^(0(\\.\\d+)?|1(\\.0+)?)$" },
              submittedAt: { type: "string", format: "date-time" },
            },
            required: ["probabilityYes", "submittedAt"],
          }),
          mediaType: "application/schema+json",
        },
      }],
    },
    evaluationFamilies: ["deterministic-process"],
    requirementKeys: [],
  };
}

/**
 * The single source of truth for prediction-forecast/1.0's sealed digest (#2534).
 *
 * DERIVED, never transcribed. Every consumer that has to name this digest — the admission
 * policy in `@jinn-network/task-admission`, the `prediction-v1-baseline` launcher's inline
 * runner, the sealed `profiles/task-profiles/prediction-forecast/1.0/profile.sha256` fixture —
 * imports it from here instead of holding its own copy. Two packages previously hardcoded
 * `sha256:e61dc765…`; re-sealing the profile under `spec.jinn.network` moved the real digest to
 * `sha256:7e451784…` and neither copy followed, so every prediction solve was rejected with
 * "profile digest … is not resolvable in the store". A value computed from the builder cannot
 * drift from the builder.
 */
export const PREDICTION_FORECAST_PROFILE_DIGEST: `sha256:${string}` =
  sealTaskProfile(buildPredictionForecastProfile()).digest;

/** The bare lowercase hex of {@link PREDICTION_FORECAST_PROFILE_DIGEST}, without the `sha256:` prefix. */
export const PREDICTION_FORECAST_PROFILE_DIGEST_HEX: string =
  PREDICTION_FORECAST_PROFILE_DIGEST.slice("sha256:".length);
