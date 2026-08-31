// Destination policy for peer-supplied URLs (§7, §14.1). Everything a peer
// introduces -- a `.well-known` `archiveRoot`, a `locations[].locator` -- is
// attacker-influenced by construction, so it must be classified before it is
// ever handed to a transport.
//
// Two independent primitives live here because they answer two different
// questions:
//
//  - `resolveContainedUrl` asks "does this stay inside the serving root the
//    OPERATOR configured?". It is the stronger of the two and it is what the
//    archive-root path uses: after it, a peer can only ever move the fetch
//    within an origin the operator already chose. It is also the invariant the
//    rest of the sync path already assumes -- `sync.ts`'s `pageUrl` rebuilds
//    every archive page after the first as `servingRoot + archivePagePath`, so
//    only page one was ever able to escape.
//
//  - `isPrivateOrReservedHost` asks "is this destination in private or reserved
//    address space?". It is what `checkLocator` applies where there is no
//    configured origin to contain a locator to. It deliberately does NOT run on
//    the archive-root path: a serving root is loopback in every local
//    deployment, and containment there is both stronger and correct.
//
// Neither resolves DNS. Address pinning is not expressible through the injected
// `Transport`/`FetchLike` ports these paths use, and on the contained path the
// destination is an operator-configured origin, so a rebinding attack would have
// to target the operator's own host.

/** A peer-introduced URL that does not stay inside the configured serving root. */
export class ContainedOriginError extends Error {
  override readonly name = "ContainedOriginError";

  constructor(
    readonly servingRoot: string,
    readonly candidate: string,
    detail: string,
  ) {
    super(`introduced URL ${JSON.stringify(candidate)} is not contained by serving root ${servingRoot}: ${detail}`);
  }
}

function httpBase(servingRoot: string, candidate: string): URL {
  let base: URL;
  try {
    base = new URL(`${servingRoot.replace(/\/+$/u, "")}/`);
  } catch {
    throw new ContainedOriginError(servingRoot, candidate, "the serving root is not an absolute URL");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new ContainedOriginError(servingRoot, candidate, "the serving root is not HTTP(S)");
  }
  return base;
}

/**
 * Resolves a peer-introduced path against the configured serving root and
 * refuses anything that leaves it.
 *
 * The vulnerability this closes is `new URL(candidate, base)` silently
 * DISCARDING `base` whenever `candidate` is absolute (#3411): an introduced
 * `"http://127.0.0.1:8545/"` resolved to exactly that, and the HTTP transport
 * forwards an absolute `http(s)://` target verbatim.
 *
 * Path comparison is done on the serving root's directory prefix, which always
 * ends in `/`, so a sibling that merely shares a textual prefix (`/archive`
 * vs `/archived-elsewhere`) is refused. `..` segments are normalized by `URL`
 * before the comparison, so an escaping traversal fails the same test.
 */
export function resolveContainedUrl(servingRoot: string, candidate: string): URL {
  const trimmed = candidate.trim();
  if (trimmed === "") {
    throw new ContainedOriginError(servingRoot, candidate, "the introduced path is empty");
  }
  const base = httpBase(servingRoot, candidate);

  let resolved: URL;
  try {
    resolved = new URL(trimmed, base);
  } catch {
    throw new ContainedOriginError(servingRoot, candidate, "it is not a resolvable URL");
  }

  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    throw new ContainedOriginError(servingRoot, candidate, `scheme ${resolved.protocol} is not HTTP(S)`);
  }
  // Credentials are checked separately from the origin test, which strips them.
  if (resolved.username !== "" || resolved.password !== "") {
    throw new ContainedOriginError(servingRoot, candidate, "it carries embedded credentials");
  }
  if (resolved.origin !== base.origin) {
    throw new ContainedOriginError(servingRoot, candidate, `origin ${resolved.origin} is not ${base.origin}`);
  }
  if (!resolved.pathname.startsWith(base.pathname)) {
    throw new ContainedOriginError(servingRoot, candidate, `path ${resolved.pathname} is outside ${base.pathname}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Literal-address classification.
// ---------------------------------------------------------------------------

/** Strict dotted-quad parse. Returns the four octets, or `undefined` for anything else. */
function parseIPv4(host: string): readonly number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    octets.push(value);
  }
  return octets;
}

/**
 * Parses an IPv6 literal into its 16 bytes, expanding `::` and accepting the
 * trailing dotted-quad form (`64:ff9b::127.0.0.1`) that carries an embedded
 * IPv4 address. Returns `undefined` for anything that is not an IPv6 literal.
 */
function parseIPv6(host: string): readonly number[] | undefined {
  if (!host.includes(":")) return undefined;
  const halves = host.split("::");
  if (halves.length > 2) return undefined;

  const expand = (text: string): number[] | undefined => {
    if (text === "") return [];
    const groups = text.split(":");
    const bytes: number[] = [];
    for (const [index, group] of groups.entries()) {
      if (index === groups.length - 1 && group.includes(".")) {
        const embedded = parseIPv4(group);
        if (embedded === undefined) return undefined;
        bytes.push(...embedded);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/iu.test(group)) return undefined;
      const value = Number.parseInt(group, 16);
      bytes.push(value >>> 8, value & 0xff);
    }
    return bytes;
  };

  const head = expand(halves[0]!);
  if (head === undefined) return undefined;
  if (halves.length === 1) return head.length === 16 ? head : undefined;

  const tail = expand(halves[1]!);
  if (tail === undefined) return undefined;
  const gap = 16 - head.length - tail.length;
  if (gap < 1) return undefined;
  return [...head, ...new Array<number>(gap).fill(0), ...tail];
}

/** IPv4 blocks that must never be a peer-named destination. */
function isReservedIPv4(octets: readonly number[]): boolean {
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64.0.0/10)
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private (172.16.0.0/12)
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking (198.18.0.0/15)
  if (a >= 224) return true; // multicast (224/4) plus reserved and broadcast (240/4)
  return false;
}

function isReservedIPv6(bytes: readonly number[]): boolean {
  const zeroThrough = (end: number): boolean => bytes.slice(0, end).every((byte) => byte === 0);

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) forms carry a
  // real IPv4 destination; classify the embedding, not the wrapper.
  if (zeroThrough(10) && bytes[10] === 0xff && bytes[11] === 0xff) return isReservedIPv4(bytes.slice(12));
  if (zeroThrough(12)) {
    const embedded = bytes.slice(12);
    // `::` and `::1` are the unspecified and loopback addresses themselves.
    if (embedded.every((byte) => byte === 0)) return true;
    if (embedded[0] === 0 && embedded[1] === 0 && embedded[2] === 0 && embedded[3] === 1) return true;
    return isReservedIPv4(embedded);
  }
  // NAT64 well-known prefix 64:ff9b::/96.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b
    && bytes.slice(4, 12).every((byte) => byte === 0)) {
    return isReservedIPv4(bytes.slice(12));
  }
  // 6to4 2002::/16 embeds the IPv4 address in the next four bytes.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return isReservedIPv4(bytes.slice(2, 6));

  if (bytes[0] === 0xff) return true; // multicast ff00::/8
  if ((bytes[0]! & 0xfe) === 0xfc) return true; // unique local fc00::/7
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // link-local fe80::/10
  return false;
}

/**
 * Whether a URL hostname names private, loopback, link-local, CGNAT, multicast
 * or otherwise reserved address space.
 *
 * Accepts the bracketed IPv6 form `URL.hostname` produces (`[::1]`). Names that
 * are not address literals are treated as public apart from the reserved
 * `localhost` name (RFC 6761) -- this is a literal classifier, not a resolver,
 * so a hostname that RESOLVES into private space is not caught here.
 */
export function isPrivateOrReservedHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host === "") return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  const ipv4 = parseIPv4(host);
  if (ipv4 !== undefined) return isReservedIPv4(ipv4);

  const ipv6 = parseIPv6(host);
  if (ipv6 !== undefined) return isReservedIPv6(ipv6);

  return false;
}
