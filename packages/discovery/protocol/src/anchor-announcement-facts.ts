import { ANCHOR_EVIDENCE_KIND } from "@jinn-network/trust-core";
import { parseFactsProfile, type FactsProfileDocument } from "./facts-profile.js";
import { RECORD_DISCOVERY_VERSION } from "./identifiers.js";

/** Facts profile URI for an announcement that carries an `AnchorEvidence` record. */
export const ANCHOR_ANNOUNCEMENT_FACTS_PROFILE =
  "https://spec.jinn.network/facts/anchor-announcement/v1" as const;

/**
 * Advisory facts card for an on-chain announcement of an entry-anchor record
 * (publication-head anchoring design §5.2 / §7 item 2). The record bytes stay
 * authoritative; `upgrades` is the announcement-side name for the pending
 * predecessor the sealed record itself does not carry.
 */
export const anchorAnnouncementFactsProfile: FactsProfileDocument = parseFactsProfile({
  protocol: RECORD_DISCOVERY_VERSION,
  kind: ANCHOR_EVIDENCE_KIND,
  profile: ANCHOR_ANNOUNCEMENT_FACTS_PROFILE,
  fields: [
    { name: "subject", class: "record", referenceBearing: true },
    { name: "provider", class: "record" },
    { name: "upgrades", class: "record", referenceBearing: true },
  ],
});

export interface AnchorAnnouncementFacts {
  readonly subject: { readonly kind: string; readonly digest: string };
  readonly provider: string;
  readonly upgrades?: string;
}

export function anchorAnnouncementFacts(input: AnchorAnnouncementFacts): AnchorAnnouncementFacts {
  return input.upgrades === undefined
    ? { subject: input.subject, provider: input.provider }
    : { subject: input.subject, provider: input.provider, upgrades: input.upgrades };
}
