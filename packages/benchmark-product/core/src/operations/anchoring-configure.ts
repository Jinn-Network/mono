/**
 * `anchoring.configure` (anchor-evidence design §7.3): the workspace's ordered list of
 * `{ providerProfile, endpoint }` entries — the configuration that makes anchoring happen at all.
 *
 * It is the sibling of `publication.configure` and shares its posture: a durable, gated,
 * consent-shaped setting the operator writes once, whose effect is that later operations reach a
 * third party. §7.1 puts the grant here rather than on `anchor` itself — "configuring an endpoint
 * is the operator's consent to the disclosure in §13 item 7" — and §7.3 puts the consequence here
 * too: "once configured at the workspace level, every subsequent lock attempts anchoring
 * automatically". Both facts land on this one call.
 *
 * Three disciplines:
 *
 * - **Whole-list replacement.** The input is the complete ordered list, and an empty list clears
 *   the block back to absent (§7.3's "absent any configuration nothing is attempted"). There is no
 *   append verb: resolution is "first matching entry wins", so an append whose position the caller
 *   did not choose is an append whose effect the caller did not choose either.
 * - **Refuse what could never work.** A profile no acquisition source implements, or an endpoint no
 *   source would accept, is refused here rather than stored and discovered at the next lock — where
 *   §7.2 would swallow it into a note the operator may not read. Configuration is the one place a
 *   bad value can still be a loud refusal.
 * - **No endpoint ever comes from this package.** Nothing here has a default, and no vendor name
 *   appears; the operator supplies every endpoint, which is what keeps anchoring structurally
 *   opt-in (§7.3).
 */

import { z } from "zod";
import { isProducibleAnchorProfile, PRODUCIBLE_ANCHOR_PROFILES } from "../anchor/profiles.js";
import { normalizeConfiguredAnchorEndpoint } from "../anchor/sources.js";
import { refuse, refuseWithIssues } from "../errors.js";
import {
  WorkspaceAnchoringEntrySchema,
  writeWorkspaceAnchoring,
  type WorkspaceAnchoringEntry,
} from "../workspace/workspace.js";
import type { OperationContext } from "./context.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";

export interface AnchoringConfigureInput {
  /**
   * The complete ordered list, replacing whatever is configured now. Empty clears the block.
   * Ordered because resolution takes the first entry matching the requested profile, and takes the
   * first entry outright when nothing narrows it.
   */
  readonly entries: readonly WorkspaceAnchoringEntry[];
}

export interface AnchoringConfigureResult {
  /** The stored list, with every endpoint in its canonical spelling. */
  readonly anchoring: readonly WorkspaceAnchoringEntry[];
}

/**
 * The list's own schema runs first, so a caller that hands over `[null]`, a missing field, or a
 * number where a URI belongs refuses `validation` naming the entry index and field — not
 * `execution` carrying whatever message a property read on `undefined` happened to produce. The
 * CLI's `--file` and the GUI's server configuration both arrive here as parsed JSON that nothing
 * has shape-checked yet, which is exactly the input this guards.
 */
const AnchoringEntriesSchema = z.array(WorkspaceAnchoringEntrySchema);

function validateEntries(entries: readonly WorkspaceAnchoringEntry[]): WorkspaceAnchoringEntry[] {
  const parsed = AnchoringEntriesSchema.safeParse(entries);
  if (!parsed.success) {
    refuseWithIssues(
      "validation",
      parsed.error.issues.map((issue) => ({
        path: `anchoring.${issue.path.join(".")}`,
        message: issue.message,
      })),
    );
  }
  const seen = new Set<string>();
  return parsed.data.map((entry, index) => {
    const at = `anchoring.${index}`;
    if (!isProducibleAnchorProfile(entry.providerProfile)) {
      refuse(
        "validation",
        `${at}.providerProfile`,
        `no acquisition source implements ${entry.providerProfile}; this product can produce anchors for `
        + PRODUCIBLE_ANCHOR_PROFILES.join(", "),
      );
    }
    // A second entry for one profile is never reached: resolution takes the first match. Storing it
    // would present configuration the workspace does not act on.
    if (seen.has(entry.providerProfile)) {
      refuse("validation", `${at}.providerProfile`, `${entry.providerProfile} is configured more than once`);
    }
    seen.add(entry.providerProfile);
    const endpoint = normalizeConfiguredAnchorEndpoint(entry.providerProfile, entry.endpoint);
    if (endpoint === undefined) {
      refuse(
        "validation",
        `${at}.endpoint`,
        `"${entry.endpoint}" is not an absolute https URL this profile can be reached at`,
      );
    }
    return { providerProfile: entry.providerProfile, endpoint };
  });
}

/** Replaces (or clears) the workspace anchoring configuration. Gated; see `../authority/policy.ts`. */
export function anchoringConfigure(
  context: OperationContext,
  input: AnchoringConfigureInput,
): OperationResult<AnchoringConfigureResult> {
  return operate({
    context,
    action: "anchoring.configure",
    subject: "workspace",
    inputs: input,
    run: () => ({ anchoring: writeWorkspaceAnchoring(context.workspaceDir, validateEntries(input.entries)) }),
  });
}
