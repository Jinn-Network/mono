// SPDX-License-Identifier: MIT

import {
  canonicalJsonBytes,
  prefixedDigest,
  type JsonValue,
} from "@jinn-network/policy-identity";
import type { NextRunRoute } from "../next-run-policy-snapshot.js";
import { normalizeAffectedRoutes as normalizeCampaignAffectedRoutes } from "../live-campaign-inputs.js";
import { PolicyOptimizationError } from "../errors.js";

export const DECLARED_BASELINE_REVISION_DOMAIN =
  "network.jinn.policy-optimization.declared-baseline-revision/1.0" as const;

function refuse(path: string, message: string): never {
  throw new PolicyOptimizationError("invalid-document", [{ path, code: "invalid-document", message }]);
}

/** Validates, deduplicates, and code-unit sorts the complete operator-declared route set. */
export function normalizeAffectedRoutes(
  selected: NextRunRoute,
  affected: readonly NextRunRoute[],
): readonly NextRunRoute[] {
  for (const [index, route] of affected.entries()) {
    if (route.taskProfile.length === 0
      || route.taskProfile !== selected.taskProfile
      || route.route === undefined || route.route.length === 0 || route.route.includes("\0")) {
      refuse(`affectedRoutes.${index}`, "affected routes must be named routes under the selected task profile");
    }
  }
  return normalizeCampaignAffectedRoutes(selected, affected);
}

export interface DeclaredBaselineRevisionInput {
  readonly route: NextRunRoute;
  readonly affectedRoutes: readonly NextRunRoute[];
  readonly profileDigest: string;
  readonly harness: {
    readonly id: string;
    readonly executable: string;
    readonly digest: string;
    readonly version: string;
  };
  readonly model: string;
  readonly isolationPolicy: string;
  readonly loadout: { readonly archiveDigest: string; readonly treeDigest: string };
  readonly requirements: JsonValue;
}

/** Revision of the explicit optimizer baseline, never of a running deployment. */
export function declaredBaselineRevision(input: DeclaredBaselineRevisionInput): string {
  const affectedRoutes = normalizeAffectedRoutes(input.route, input.affectedRoutes);
  return prefixedDigest(canonicalJsonBytes({
    affectedRoutes,
    domain: DECLARED_BASELINE_REVISION_DOMAIN,
    harness: input.harness,
    isolationPolicy: input.isolationPolicy,
    loadout: input.loadout,
    model: input.model,
    profileDigest: input.profileDigest,
    requirements: input.requirements,
    route: input.route,
  } as unknown as JsonValue));
}
