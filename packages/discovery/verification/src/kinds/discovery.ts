// SPDX-License-Identifier: Apache-2.0

import { MEDIA_FACTS_PROFILE, RECORD_DISCOVERY_VERSION, parseFactsProfile } from "@jinn-network/record-discovery-protocol";

import { documentField } from "../record-view.js";
import type { RecordView } from "../record-view.js";
import { describeError } from "../results.js";
import type { Finding } from "../results.js";
import type { RecordKind } from "./kind.js";

/**
 * The specification's README lists facts profiles "alongside the families", and record discovery's
 * §12 makes one declarative field labeling for a record kind. Its `kind` member names the kind it
 * describes, not what it is, and its own name is `profile`.
 *
 * It has no type URL either, because `protocol` is shared with entries and heads, so the media type
 * keys it, the way a schema's served URL keys an observation.
 */
const PUBLISHED_DOCUMENT = "The published facts profiles are not RFC 8785 bytes; the specification's signed release manifest pins them.";

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
