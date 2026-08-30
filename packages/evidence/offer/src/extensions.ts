// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

const REVERSE_DNS_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/;

/**
 * Absolute URI with a real scheme and no whitespace. `new URL` alone accepts
 * `"http://a/b c"` by percent-encoding the space, which would let one producer seal a
 * spelling another implementation refuses; the whitespace rule closes that.
 */
export function isAbsoluteUri(value: string): boolean {
  if (/\s/u.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The schemes WHATWG calls special — the ones whose host is a real domain it parses and
 * normalizes, rather than an opaque string it copies through. The trailing-dot rule is scoped
 * to these because `r.example.` is the same DNS name as `r.example` only where there is a DNS
 * name; under an opaque-host scheme the dot is just a character the vocabulary owns.
 *
 * A host of nothing but dots (`.`, the DNS root, and its degenerate siblings) is exempt, and
 * `HAS_A_LABEL` is what exempts it. The rule exists to collapse `name.` onto `name`, and when
 * every label is empty there is no `name` to collapse onto — refusing it would leave a URI
 * with no accepted spelling at all, which is the one thing the guarantee below forbids.
 */
const SPECIAL_SCHEMES = new Set(["http:", "https:", "ws:", "wss:", "ftp:", "file:"]);

const HAS_A_LABEL = /[^.]/u;

const UNRESERVED_OCTET = /^[A-Za-z0-9\-._~]$/;

/**
 * Every percent-escape is a well-formed triplet in the one spelling RFC 3986 §6.2.2 calls
 * normalized: uppercase hex digits, and never an escape of an unreserved octet. Both halves
 * are equivalence rules, not style — `%2f` and `%2F` are the same octet, and `%62` is the
 * same character as `b` — so admitting either spelling puts one rail in an offer twice.
 * A malformed escape (`%zz`, a trailing `%`) is refused with them: `new URL` round-trips it
 * verbatim, and a consumer that decodes per RFC 3986 cannot read it at all.
 */
function hasNormalizedPercentEncoding(value: string): boolean {
  for (let index = value.indexOf("%"); index !== -1; index = value.indexOf("%", index + 1)) {
    const triplet = value.slice(index + 1, index + 3);
    if (!/^[0-9A-F]{2}$/.test(triplet)) return false;
    if (UNRESERVED_OCTET.test(String.fromCharCode(Number.parseInt(triplet, 16)))) return false;
  }
  return true;
}

/**
 * No empty query and no empty fragment. `https://r.example/v1`, `https://r.example/v1?`, and
 * `https://r.example/v1#` all address the same resource, and WHATWG round-trips the last two
 * unchanged, so without this one rail has three identifiers. `value` is already WHATWG's own
 * serialization when this runs, so the first `#` delimits the fragment and the first `?`
 * before it delimits the query — a literal one anywhere else is percent-encoded by then.
 */
function hasNoEmptyQueryOrFragment(value: string): boolean {
  const hashIndex = value.indexOf("#");
  if (hashIndex !== -1 && hashIndex === value.length - 1) return false;
  const beforeFragment = hashIndex === -1 ? value : value.slice(0, hashIndex);
  const queryIndex = beforeFragment.indexOf("?");
  return queryIndex === -1 || queryIndex !== beforeFragment.length - 1;
}

/**
 * An absolute URI already written in its one normalized spelling. Used where a URI is an
 * identity key rather than a locator: `HTTPS://R.EXAMPLE/v1`, `https://r.example:443/v1`, and
 * `https://r.example/v1` are the same identifier, so admitting all three would let one rail
 * appear twice in an offer and defeat the uniqueness rule that makes "pay on one of its
 * rails" unambiguous.
 *
 * `new URL` round-tripping the value unchanged is the first half of the check and not the
 * whole of it. WHATWG normalizes scheme and host case for the special schemes (http, https,
 * ws, wss, ftp, file), drops default ports, resolves dot segments, and drops empty userinfo
 * and an empty port — but it round-trips several spellings RFC 3986 calls equivalent, so this
 * check refuses those itself: a trailing-dot host under a special scheme (`r.example.`, the
 * same DNS name), a non-normalized percent-escape (`%2f` for `%2F`, `%62` for `b`), and an
 * empty query or fragment (`…/v1?`, `…/v1#`). Each was a second identifier for one rail.
 *
 * What remains outside the guarantee is opaque hosts and opaque paths, which round-trip
 * verbatim: `ipfs://BAFYBEIGD/x` and `ipfs://bafybeigd/x` are still two distinct rails here,
 * as are `urn:UUID:x` and `urn:uuid:x` even though RFC 8141 calls URN namespace identifiers
 * case-insensitive. A rail vocabulary that mints identifiers under such a scheme owes its own
 * spelling rule; this check cannot supply one without knowing the scheme's equivalence law. The
 * trailing-dot rule is scoped to the special schemes for the same reason, so nothing here
 * reaches into a region it cannot reason about.
 *
 * Stated positively, and this is the whole of the guarantee: under a special scheme, two URIs
 * that are equivalent never both pass, and the normalized spelling of any URI always does, so no
 * rail is left unspellable. "Equivalent" there is RFC 3986 §6.2.2 syntax-based normalization —
 * case, percent-encoding, path segments — plus two §6.2.3 scheme-based rules this check also
 * applies: the DNS trailing dot, and the elision of an empty query or fragment. Naming §6.2.2
 * alone would make the second half false, since `…/v1?` is already its own syntax-based normal
 * form and is refused all the same. A string carrying a malformed escape is
 * refused outright and is not an RFC 3986 URI to begin with, so it is outside that claim rather
 * than a counterexample to it. `extensions.test.ts` runs both directions over the special-scheme
 * space, because a rule that claims more than it delivers is worse than a modest one — which is
 * the whole reason this function grew past its round-trip check.
 *
 * Under any other scheme it accepts one spelling per string, and the vocabulary owns the rest.
 */
export function isNormalizedAbsoluteUri(value: string): boolean {
  if (/\s/u.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.href !== value) return false;
  if (SPECIAL_SCHEMES.has(url.protocol) && HAS_A_LABEL.test(url.hostname)
    && url.hostname.endsWith(".")) {
    return false;
  }
  return hasNormalizedPercentEncoding(value) && hasNoEmptyQueryOrFragment(value);
}

/** Extension names are reverse-DNS or absolute URIs (TEP §21.3); a bare key is neither. */
export function isNamespacedExtensionKey(key: string): boolean {
  return REVERSE_DNS_KEY_PATTERN.test(key) || isAbsoluteUri(key);
}

/**
 * Keeps an object open only to namespaced extension names: unknown namespaced keys survive
 * round-trips (they reach the sealed bytes and re-parse unchanged) but can never shadow a
 * core field, and a bare key is `invalid-document` rather than silently accepted.
 */
export function namespacedObject<const Shape extends z.ZodRawShape>(shape: Shape) {
  const knownKeys = new Set(Object.keys(shape));
  return z.looseObject(shape).superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if (knownKeys.has(key) || isNamespacedExtensionKey(key)) continue;
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `Extension key "${key}" must be namespaced (reverse-DNS or absolute URI, TEP §21.3).`,
      });
    }
  });
}
