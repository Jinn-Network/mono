import type { PublishedLocation } from "@jinn-network/record-discovery-protocol";
import { LOCATION_PROFILE_HTTPS, LOCATION_PROFILE_IPFS } from "@jinn-network/record-discovery-protocol";

// Location profiles (design §7): `locations[].locator` is attacker-
// influenced by construction, so consumers apply size/content-type/SSRF
// guards and treat the digest re-hash as the only accepted outcome (§7,
// §14, `client`'s hostile-locator conformance, M6). Here `serve` only
// formats and grammar-checks locators before publishing them -- the two v1
// location profiles' locator grammars, pinned at implementation.

// CIDv0: base58btc-encoded SHA-256 multihash, always "Qm" + 44 base58 chars
// (46 total). CIDv1: multibase-prefixed; the common textual form is
// lowercase base32 starting with "b".
const IPFS_CID_GRAMMAR = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;

/** LOCATION_PROFILE_HTTPS locator grammar: an https URL. */
export function isHttpsLocator(locator: string): boolean {
  try {
    return new URL(locator).protocol === "https:";
  } catch {
    return false;
  }
}

/** LOCATION_PROFILE_IPFS locator grammar: a CIDv0 or CIDv1 string. */
export function isIpfsLocator(locator: string): boolean {
  return IPFS_CID_GRAMMAR.test(locator);
}

const LOCATOR_VALIDATORS: Record<string, (locator: string) => boolean> = {
  [LOCATION_PROFILE_HTTPS]: isHttpsLocator,
  [LOCATION_PROFILE_IPFS]: isIpfsLocator,
};

/** Builds a `PublishedLocation`, rejecting an unknown profile or a locator that doesn't conform to its declared profile's grammar. */
export function formatLocation(profile: string, locator: string): PublishedLocation {
  const validator = LOCATOR_VALIDATORS[profile];
  if (validator === undefined) {
    throw new Error(`Unknown location profile: ${profile}`);
  }
  if (!validator(locator)) {
    throw new Error(`Locator does not conform to profile "${profile}": ${locator}`);
  }
  return { profile, locator };
}
