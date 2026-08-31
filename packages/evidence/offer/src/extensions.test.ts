import { describe, expect, test } from "vitest";

import { isNormalizedAbsoluteUri } from "./extensions.js";

const SPECIAL_SCHEMES = ["http:", "https:", "ws:", "wss:", "ftp:", "file:"];
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

// The raw characters RFC 3986 permits unescaped in each component, spelled out here rather than
// imported so the oracle stays an independent statement of the rule. Anything else that WHATWG
// nonetheless round-trips raw (`^ | [ ] { } \` and the backtick) has its escape as the normal
// form, which is what makes `…/a^b` and `…/a%5Eb` one identity rather than two.
// Written as the complement of that set so the whole component is escaped in one pass: the
// per-character spread this replaced allocated an array and ran a regex per octet, and the
// reachability direction below runs it over every corpus member.
const PATH_ILLEGAL = /[^A-Za-z0-9\-._~!$&'()*+,;=:@/%]/gu;
const QUERY_ILLEGAL = /[^A-Za-z0-9\-._~!$&'()*+,;=:@/?%]/gu;

function escapeIllegalRaw(value: string, illegal: RegExp): string {
  return value.replace(illegal, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/**
 * The normalized spelling of a WHATWG-stable URI, written independently of the implementation:
 * RFC 3986 §6.2.2 percent-escape normalization, §6.2.1 escaping of a raw octet the component's
 * grammar does not permit, empty-query and empty-fragment elision, and the DNS trailing-dot rule
 * where the host has a real label. WHATWG has already done the scheme and host case-folding, the
 * default port, and the dot segments by the time a string is stable.
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
    + escapeIllegalRaw(normalizePercent(url.pathname), PATH_ILLEGAL)
    + (query === null || query === ""
      ? ""
      : `?${escapeIllegalRaw(normalizePercent(query), QUERY_ILLEGAL)}`)
    + (fragment === null || fragment === ""
      ? ""
      : `#${escapeIllegalRaw(normalizePercent(fragment), QUERY_ILLEGAL)}`);
}

const HOSTS = ["r.example", "R.Example", "r.example.", "r.example..", ".", "..", "a.b.c", "a.b.c.", "127.0.0.1", "[::1]", ""];
const PORTS = ["", ":80", ":443", ":8443"];
// `^ [ |` and their escapes are here because WHATWG round-trips both spellings of each: without
// the RFC 3986 raw-octet rule the pair is one rail under two identifiers, which is the collision
// the first test below would then report.
const PATHS = ["/", "/v1", "/a%62c", "/abc", "/%2f", "/%2F", "/~x", "/%7ex", "/a/../v1", "/%25", "/%2541", "/%E2%82%AC", "/%e2%82%ac", "/a^b", "/a%5Eb", "/a[b", "/a%5Bb", "/a|b", "/a%7Cb", ""];
const QUERIES = ["", "?", "?a=1", "?a=%2F", "?a=%2f", "?a=%62", "?a{b", "?a%7Bb", "?a`b", "?a%60b", "?a^b", "?a%5Eb", "?#"];
const FRAGMENTS = ["", "#", "#f", "#%7e", "#%7E", "#~", "#a{b", "#a%7Bb", "#a|b", "#a%7Cb"];
// `r.example.@` and `a%2Eb:r.example.@` exist to keep the oracle honest: they put the host
// string inside the userinfo, which is what broke an earlier offset-splice implementation.
const USERINFOS = ["", "u@", "u:p@", "@", "r.example.@", "a%2Eb:r.example.@"];

// The corpus is two sweeps rather than one cross product. Crossing every component spelling
// against every authority spelling multiplies the work without testing anything more: the
// raw-octet and percent-escape rules are per component and read nothing of the authority, and
// the trailing-dot and userinfo rules read nothing of the components. One full cross product of
// all six lists reached 3.8M members, which put the reachability direction — the only direction
// that runs the oracle over every member rather than skipping refused ones — 58% over vitest's
// 5s budget on CI while passing on a developer laptop. Sweeping the two axes separately carries
// every component spelling and every authority spelling — including the six characters the last
// version to run green had none of — and drops only the cross terms between the two axes.
const AUTHORITY_SWEEP_PATHS = ["/", "/v1", "/a%62c", "/%2f", "/a/../v1", "/%25", "/a^b", ""];
const AUTHORITY_SWEEP_QUERIES = ["", "?", "?a=1", "?a=%2f"];
const AUTHORITY_SWEEP_FRAGMENTS = ["", "#", "#%7e", "#a{b"];
// The component sweep keeps one authority per shape that the components could conceivably
// interact with — a registrable name, a trailing dot, an IPv6 literal — rather than all eleven.
const COMPONENT_SWEEP_HOSTS = ["r.example", "r.example.", "[::1]"];
const COMPONENT_SWEEP_PORTS = ["", ":8443"];
const COMPONENT_SWEEP_USERINFOS = ["", "u:p@"];

function collectStable(
  stable: Set<string>,
  userinfos: readonly string[],
  hosts: readonly string[],
  ports: readonly string[],
  paths: readonly string[],
  queries: readonly string[],
  fragments: readonly string[],
): void {
  for (const scheme of SPECIAL_SCHEMES) {
    for (const userinfo of userinfos) {
      for (const host of hosts) {
        for (const port of ports) {
          for (const path of paths) {
            for (const query of queries) {
              for (const fragment of fragments) {
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
}

function stableUris(): readonly string[] {
  const stable = new Set<string>();
  collectStable(stable, USERINFOS, HOSTS, PORTS, AUTHORITY_SWEEP_PATHS, AUTHORITY_SWEEP_QUERIES, AUTHORITY_SWEEP_FRAGMENTS);
  collectStable(stable, COMPONENT_SWEEP_USERINFOS, COMPONENT_SWEEP_HOSTS, COMPONENT_SWEEP_PORTS, PATHS, QUERIES, FRAGMENTS);
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
