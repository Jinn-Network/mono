// SPDX-License-Identifier: Apache-2.0

/**
 * The sixth sealed venue sentence and its claim section (issue #3401).
 *
 * The interoperability profile (section 9.3) requires a self-run publisher to disclose that its
 * publication source is owner-controlled. The five `LOCAL_VENUE_LIMITS` sentences cover dispatch,
 * not publication. The operator ruling of 2026-09-24 adds a sixth sentence, declared as the `/10`
 * capability `owner-controlled-publication`: a bundle that declares it seals the sentence right
 * after the five, in the Report limitations and in `venueHonesty.limits`, and carries it again as
 * its claim section. A bundle that does not declare it keeps the five sentences byte for byte.
 *
 * The wording is the ruling's, verbatim. It is spelled once, here, and the product core imports
 * it: the producer's sealed copy and the verifier's rebuild have to be the same bytes.
 */

import { z } from "zod";
import { refuse } from "./errors.js";

export const OWNER_CONTROLLED_PUBLICATION_LIMIT =
  "This venue's publication source is owner-controlled and has no witness: the owner holds its signing key and hosts its archive, so it can rewrite what it published before a reader first fetches it, and only a reader who kept an earlier copy can detect a later rewrite.";

/** The claim section is the sentence itself: present exactly when the bundle declares the
 * capability, and never any other text. */
export const ClaimOwnerControlledPublicationSectionSchema = z.literal(OWNER_CONTROLLED_PUBLICATION_LIMIT);

export type ClaimOwnerControlledPublicationSection = z.infer<typeof ClaimOwnerControlledPublicationSectionSchema>;

/**
 * The sealed Report's half of the declaration.
 *
 * `claim-consistency` rebuilds the claim, `venueHonesty.limits` included, and byte-compares it
 * whole, so the claim's copies are settled there. The Report's `limitations` are the signed
 * source the claim copies, and they are byte-compared only when an earlier gate applies. This
 * settles the one fact the capability adds to them, on every bundle:
 *
 * - declared: the Report limitations open with exactly the venue sentences the rebuild derives,
 *   the publication-source sentence last among them;
 * - not declared: the sentence appears nowhere in them.
 */
export function assertOwnerControlledPublicationLimitations(input: {
  readonly reportLimitations: readonly string[];
  readonly venueLimits: readonly string[];
  readonly declared: boolean;
}): void {
  if (input.declared) {
    const opening = input.reportLimitations.slice(0, input.venueLimits.length);
    if (
      input.venueLimits.at(-1) !== OWNER_CONTROLLED_PUBLICATION_LIMIT
      || opening.length !== input.venueLimits.length
      || opening.some((line, index) => line !== input.venueLimits[index])
    ) {
      refuse(
        "record-integrity",
        "claim-consistency",
        "a bundle declaring owner-controlled-publication must seal the publication-source sentence in its Report limitations, right after the venue sentences",
      );
    }
    return;
  }
  if (input.reportLimitations.includes(OWNER_CONTROLLED_PUBLICATION_LIMIT)) {
    refuse(
      "record-integrity",
      "claim-consistency",
      "Report limitations carry the publication-source sentence, but the bundle does not declare owner-controlled-publication",
    );
  }
}
