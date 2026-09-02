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
 * The raw characters RFC 3986 §3.3 and §3.4 permit unescaped, per component. `pchar` is
 * `unreserved / pct-encoded / sub-delims / ":" / "@"`; a path adds `/`, and a query or fragment
 * adds `/` and `?`. `%` is here because it introduces an escape, which
 * `hasNormalizedPercentEncoding` judges separately.
 */
const RFC3986_PATH_OCTET = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*$/u;
const RFC3986_QUERY_OCTET = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]*$/u;

/**
 * Every character of the path, query, and fragment is one RFC 3986 lets stand unescaped there.
 * WHATWG's percent-encode sets are narrower than `pchar`, so it round-trips both `…/a^b` and
 * `…/a%5Eb` — and without this rule both would pass, putting one rail in an offer twice at two
 * prices, which is the exact duplicate the uniqueness rule exists to refuse. The raw form loses,
 * not the escape: `^ | [ ] { } \` and the backtick are in none of RFC 3986's production rules for
 * these components, so the raw spelling is not a URI at all, while `%5E` is, round-trips
 * unchanged, and is therefore the one accepted spelling rather than a second one.
 */
function hasOnlyRfc3986RawOctets(url: URL): boolean {
  return RFC3986_PATH_OCTET.test(url.pathname)
    && RFC3986_QUERY_OCTET.test(url.search.slice(1))
    && RFC3986_QUERY_OCTET.test(url.hash.slice(1));
}

/**
 * No empty query and no empty fragment. RFC 3986 §6.2.3 is explicit that these are *not*
 * equivalent to the bare URI — an empty query may be elided only where a scheme licenses it, and
 * a fragment is not subject to scheme-based normalization at all — so this is not a normalization
 * rule but this package's own identity policy: `https://r.example/v1?` and `https://r.example/v1#`
 * are refused outright rather than folded onto `https://r.example/v1`, because WHATWG round-trips
 * all three unchanged and a rail vocabulary that spelled a delimiter it does not use would put
 * one destination in an offer under three identifiers. The cost is stated where the guarantee is:
 * a rail that means something by a trailing `?` or `#` has no accepted spelling here.
 *
 * `value` is already WHATWG's own serialization when this runs, so the first `#` delimits the
 * fragment and the first `?` before it delimits the query — a literal one anywhere else is
 * percent-encoded by then.
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
 * same DNS name), a non-normalized percent-escape (`%2f` for `%2F`, `%62` for `b`), a raw octet
 * outside the component's RFC 3986 grammar (`…/a^b` beside `…/a%5Eb`), and an empty query or
 * fragment (`…/v1?`, `…/v1#`). Each was a second identifier for one rail.
 *
 * What remains outside the guarantee is opaque hosts and opaque paths, which round-trip
 * verbatim: `ipfs://BAFYBEIGD/x` and `ipfs://bafybeigd/x` are still two distinct rails here,
 * as are `urn:UUID:x` and `urn:uuid:x` even though RFC 8141 calls URN namespace identifiers
 * case-insensitive. A rail vocabulary that mints identifiers under such a scheme owes its own
 * spelling rule; this check cannot supply one without knowing the scheme's equivalence law. The
 * trailing-dot rule is scoped to the special schemes for the same reason, so nothing here
 * reaches into a region it cannot reason about.
 *
 * Stated positively, and this is the whole of the guarantee: under a special scheme, two strings
 * this check calls equivalent never both pass, and every equivalence class it admits has an
 * accepted spelling. "Equivalent" is RFC 3986 §6.2.2 syntax-based normalization — case,
 * percent-encoding, path segments — plus one rule from §6.2.1, that a raw octet and its escape
 * are the same character where the grammar permits only the escape. It borrows nothing from
 * §6.2.3: the two scheme-based rules this check also applies, the DNS trailing dot and the
 * refusal of an empty query or fragment, are this package's own identity policy and that section
 * licenses neither. §6.2.3 in fact withholds the empty-query elision absent a scheme license and
 * disclaims fragment normalization outright, and §3.2.2 treats a trailing dot as meaningful
 * rather than as a spelling variant.
 *
 * So say the cost plainly rather than let the sentence above absorb it. Three classes have no
 * accepted spelling here at all, by policy and not by oversight: `https://r.example./v1`,
 * `https://r.example/v1?`, and `https://r.example/v1#`. A rail vocabulary that mints an
 * FQDN-rooted identifier, or means something by a delimiter it leaves empty, cannot be spelled by
 * this check and needs a vocabulary-level rule the same way an opaque scheme does. A string
 * carrying a malformed escape is refused for a different reason: it is not an RFC 3986 URI to
 * begin with. `extensions.test.ts` runs both directions over two sweeps of hand-picked
 * special-scheme spellings — every component spelling against a few authorities, every authority
 * spelling against a few components — because a rule that claims more than it delivers is worse
 * than a modest one, which is the whole reason this function grew past its round-trip check.
 *
 * Under any other scheme the raw-octet rule still applies, so a string carrying an octet outside
 * the component's RFC 3986 grammar is refused whatever the scheme; everything else about the
 * spelling is one per string, and the vocabulary owns it.
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
  return hasOnlyRfc3986RawOctets(url)
    && hasNormalizedPercentEncoding(value)
    && hasNoEmptyQueryOrFragment(value);
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
