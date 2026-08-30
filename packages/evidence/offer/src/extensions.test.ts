import { describe, expect, test } from "vitest";

import { isNormalizedAbsoluteUri } from "./extensions.js";

const SPECIAL_SCHEMES = ["http:", "https:", "ws:", "wss:", "ftp:", "file:"];
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * The normalized spelling of a WHATWG-stable URI, written independently of the implementation:
 * RFC 3986 §6.2.2 percent-escape normalization, empty-query and empty-fragment elision, and the
 * DNS trailing-dot rule where the host has a real label. WHATWG has already done the scheme and
 * host case-folding, the default port, and the dot segments by the time a string is stable.
 */
function normalizedSpelling(href: string): string {
  const url = new URL(href);
  // Rebuilt from URL parts rather than spliced by offset: `href.indexOf(url.host)` finds the
  // userinfo first when the userinfo contains the host string (`https://r.example.@r.example./x`)
  // and would strip the wrong dot.
  const normalizePercent = (value: string) =>
    value.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => {
      const character = String.fromCharCode(Number.parseInt(hex, 16));
      return UNRESERVED.test(character) ? character : `%${hex.toUpperCase()}`;
    });

  // The FIRST `#` delimits the fragment, so an empty fragment is that `#` being the last
  // character — not merely the string ending in one, which `…/?##` does with a fragment of `#`.
  const hashIndex = href.indexOf("#");
  const fragment = hashIndex === -1 ? null : href.slice(hashIndex + 1);
  const beforeFragment = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const queryIndex = beforeFragment.indexOf("?");
  const query = queryIndex === -1 ? null : beforeFragment.slice(queryIndex + 1);

  const hostname = SPECIAL_SCHEMES.includes(url.protocol) && /[^.]/u.test(url.hostname)
    ? url.hostname.replace(/\.+$/u, "")
    : url.hostname;
  const credentials = url.username === "" && url.password === ""
    ? ""
    : `${url.username}${url.password === "" ? "" : `:${url.password}`}@`;
  const authority = `${hostname}${url.port === "" ? "" : `:${url.port}`}`;

  return `${url.protocol}//${normalizePercent(credentials)}${authority}`
    + normalizePercent(url.pathname)
    + (query === null || query === "" ? "" : `?${normalizePercent(query)}`)
    + (fragment === null || fragment === "" ? "" : `#${normalizePercent(fragment)}`);
}

const HOSTS = ["r.example", "R.Example", "r.example.", "r.example..", ".", "..", "a.b.c", "a.b.c.", "127.0.0.1", "[::1]", ""];
const PORTS = ["", ":80", ":443", ":8443"];
const PATHS = ["/", "/v1", "/a%62c", "/abc", "/%2f", "/%2F", "/~x", "/%7ex", "/a/../v1", "/%25", "/%2541", "/%E2%82%AC", "/%e2%82%ac", ""];
const QUERIES = ["", "?", "?a=1", "?a=%2F", "?a=%2f", "?a=%62", "?#"];
const FRAGMENTS = ["", "#", "#f", "#%7e", "#%7E", "#~"];
// `r.example.@` and `a%2Eb:r.example.@` exist to keep the oracle honest: they put the host
// string inside the userinfo, which is what broke an earlier offset-splice implementation.
const USERINFOS = ["", "u@", "u:p@", "@", "r.example.@", "a%2Eb:r.example.@"];

function stableUris(): readonly string[] {
  const stable = new Set<string>();
  for (const scheme of SPECIAL_SCHEMES) {
    for (const userinfo of USERINFOS) {
      for (const host of HOSTS) {
        for (const port of PORTS) {
          for (const path of PATHS) {
            for (const query of QUERIES) {
              for (const fragment of FRAGMENTS) {
                let href: string;
                try {
                  href = new URL(`${scheme}//${userinfo}${host}${port}${path}${query}${fragment}`).href;
                } catch {
                  continue;
                }
                if (new URL(href).href === href) stable.add(href);
              }
            }
          }
        }
      }
    }
  }
  return [...stable];
}

// The docstring on isNormalizedAbsoluteUri states a two-directional guarantee, and the whole
// point of this issue is that a rule which claims more than it delivers is worse than a modest
// one. So both directions are executable here rather than asserted in prose.
describe("the normalized-identifier guarantee, under the special schemes", () => {
  const corpus = stableUris();

  test("the corpus is large enough for the claim to mean something", () => {
    expect(corpus.length).toBeGreaterThan(50_000);
  });

  test("no two accepted spellings are the same identifier", () => {
    const byIdentity = new Map<string, string>();
    const collisions: string[] = [];
    for (const href of corpus) {
      if (!isNormalizedAbsoluteUri(href)) continue;
      const identity = normalizedSpelling(href);
      const seen = byIdentity.get(identity);
      if (seen === undefined) byIdentity.set(identity, href);
      else collisions.push(`${seen} == ${href}`);
    }
    expect(collisions).toEqual([]);
    // A floor with teeth: an implementation that accepted almost nothing would satisfy the
    // no-collision assertion trivially.
    expect(byIdentity.size).toBeGreaterThan(10_000);
  });

  // If the oracle reconstructed a URI differently from how it is spelled, both directions above
  // could pass against a wrong normal form. An accepted spelling being its own normal form is
  // what ties the oracle back to the strings the implementation actually sees.
  test("an accepted spelling is already its own normal form", () => {
    const drifted: string[] = [];
    let accepted = 0;
    for (const href of corpus) {
      if (!isNormalizedAbsoluteUri(href)) continue;
      accepted += 1;
      const normalized = normalizedSpelling(href);
      if (normalized !== href) drifted.push(`${href} -> ${normalized}`);
    }
    expect(drifted).toEqual([]);
    // Its own floor rather than a borrowed one: this direction skips every refused spelling, so
    // acceptance collapsing to zero would leave `drifted` empty and pass it vacuously.
    expect(accepted).toBeGreaterThan(10_000);
  });

  test("every identifier has an accepted spelling — no rail is left unspellable", () => {
    const unspellable: string[] = [];
    for (const href of corpus) {
      const normalized = normalizedSpelling(href);
      if (!isNormalizedAbsoluteUri(normalized)) unspellable.push(`${href} -> ${normalized}`);
    }
    expect(unspellable).toEqual([]);
  });
});
