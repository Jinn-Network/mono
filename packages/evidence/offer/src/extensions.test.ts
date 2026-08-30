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
  let out = href.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED.test(character) ? character : `%${hex.toUpperCase()}`;
  });
  // The FIRST `#` delimits the fragment, so an empty fragment is that `#` being the last
  // character — not merely the string ending in one, which `…/?##` does with a fragment of `#`.
  const emptyFragmentAt = out.indexOf("#");
  if (emptyFragmentAt !== -1 && emptyFragmentAt === out.length - 1) out = out.slice(0, -1);
  const hashIndex = out.indexOf("#");
  const beforeFragment = hashIndex === -1 ? out : out.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : out.slice(hashIndex);
  const queryIndex = beforeFragment.indexOf("?");
  const trimmed = queryIndex !== -1 && queryIndex === beforeFragment.length - 1
    ? beforeFragment.slice(0, -1)
    : beforeFragment;
  out = trimmed + fragment;
  if (SPECIAL_SCHEMES.includes(url.protocol) && /[^.]/u.test(url.hostname)
    && url.hostname.endsWith(".")) {
    const at = out.indexOf(url.host);
    const stripped = url.host.replace(url.hostname, url.hostname.replace(/\.+$/u, ""));
    out = out.slice(0, at) + stripped + out.slice(at + url.host.length);
  }
  return out;
}

const HOSTS = ["r.example", "R.Example", "r.example.", "r.example..", ".", "..", "a.b.c", "a.b.c.", "127.0.0.1", "[::1]", ""];
const PORTS = ["", ":80", ":443", ":8443"];
const PATHS = ["/", "/v1", "/a%62c", "/abc", "/%2f", "/%2F", "/~x", "/%7ex", "/a/../v1", "/%25", "/%2541", "/%E2%82%AC", "/%e2%82%ac", ""];
const QUERIES = ["", "?", "?a=1", "?a=%2F", "?a=%2f", "?a=%62", "?#"];
const FRAGMENTS = ["", "#", "#f", "#%7e", "#%7E", "#~"];
const USERINFOS = ["", "u@", "u:p@", "@"];

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
    expect(byIdentity.size).toBeGreaterThan(0);
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
