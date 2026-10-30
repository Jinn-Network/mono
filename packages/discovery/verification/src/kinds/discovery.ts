// SPDX-License-Identifier: Apache-2.0

import { MEDIA_FACTS_PROFILE, RECORD_DISCOVERY_VERSION, parseFactsProfile } from "@jinn-network/record-discovery-protocol";

import { documentField } from "../record-view.js";
import type { RecordView } from "../record-view.js";
import { describeError } from "../results.js";
import type { Finding } from "../results.js";
import type { RecordKind } from "./kind.js";

/**
 * A facts profile is a document the specification publishes, not a sealed record. The README lists
 * facts profiles "alongside the families", and record discovery's §12 makes one declarative field
 * labeling for a record kind. Its `kind` member names the kind it describes, not what it is, and its
 * own name is `profile`. Its bytes are pinned by the release manifest of the set it is served in, so
 * it has no canonical form and no signature of its own, and a spelling of one is not a failure.
 *
 * It has no type URL either, because `protocol` is shared with entries and heads, so the media type
 * keys it, the way a schema's served URL keys an observation.
 */
const PUBLISHED_DOCUMENT = "Record discovery §12: a facts profile is a published document, not a sealed record. The specification's signed release manifest pins its bytes.";

const FACTS_PROFILE_PREFIX = "https://spec.jinn.network/facts/";

function isFactsProfile(view: RecordView): boolean {
  const profile = documentField(view, "profile");
  return documentField(view, "protocol") === RECORD_DISCOVERY_VERSION
    && typeof profile === "string"
    && profile.startsWith(FACTS_PROFILE_PREFIX);
}

function factsProfileFindings({ document }: RecordView): readonly Finding[] {
  try {
    parseFactsProfile(document);
    return [];
  } catch (cause) {
    return [{ code: "invalid-document", detail: describeError(cause) }];
  }
}

export const DISCOVERY_KINDS: Readonly<Record<string, RecordKind>> = {
  [MEDIA_FACTS_PROFILE]: {
    family: "record-discovery",
    identify: isFactsProfile,
    validate: factsProfileFindings,
    encodingExemption: PUBLISHED_DOCUMENT,
    unsignedBecause: PUBLISHED_DOCUMENT,
  },
};
