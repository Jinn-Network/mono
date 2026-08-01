// SPDX-License-Identifier: Apache-2.0

import type { HealthReport } from "../../health.js";
import { type ToolResponse, toolJson } from "../result.js";

export const healthInputShape = {} as const;

export interface HealthToolDeps {
  health(): Promise<HealthReport>;
}

export const HEALTH_DESCRIPTION =
  "Report the runtime's own health checks: corpus sources, mirror position, trust policy, archive readability. Each check is {name, ok, detail, remedy}, where a null remedy means the break is not fixable from this machine.";

export async function handleHealth(deps: HealthToolDeps): Promise<ToolResponse> {
  try {
    return toolJson(await deps.health());
  } catch (error) {
    // A doctor that cannot run is itself a diagnosis. Answering with a report
    // keeps the adapter's merge (Task 17) on one code path.
    return toolJson({
      ok: false,
      version: "unknown",
      checks: [
        {
          name: "runtime-health",
          ok: false,
          detail: `the runtime could not run its own checks: ${
            error instanceof Error ? error.message : String(error)
          }`,
          remedy: "hermes plugins update jinn",
        },
      ],
    } satisfies HealthReport);
  }
}
