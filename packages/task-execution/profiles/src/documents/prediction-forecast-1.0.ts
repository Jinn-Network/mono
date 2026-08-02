import { PREDICTION_FORECAST_PROFILE_URI, TASK_PROFILE_FORMAT_URI } from "../identifiers.js";
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
