/**
 * Destination policy for manifest-supplied artifact origins (#1901).
 *
 * A corpus manifest is attacker-controlled input: `artifact.access.endpoint`
 * arrives from whoever published the envelope. Fetching it unguarded turns
 * every daemon into an SSRF proxy for loopback, RFC1918, link-local, and
 * cloud metadata services. This module is the single place that decides
 * whether a destination is allowed to be contacted at all.
 *
 * The policy is deny-by-default: a destination is public only if we can
 * positively classify every address behind it as public.
 *
 * Residual gap, stated plainly: we validate the addresses that `dns.lookup`
 * returns, then hand the URL to `fetch`, which resolves the name again on
 * connect. A DNS entry that flips between those two lookups (rebinding) is
 * not caught here. Closing it needs a socket-level `connect.lookup` hook,
 * which means either dropping to `node:http` or taking an `undici`
 * dependency in a published package; #1901's acceptance criteria permit
 * per-hop revalidation instead, which is what this does.
 */

import { isIPv4, isIPv6 } from 'node:net';
import { lookup } from 'node:dns/promises';

/** Why a destination was refused, or `'public'` when it is allowed. */
export type AddressClass = 'public' | ProhibitedReason;

export type ProhibitedReason =
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'multicast'
  | 'unspecified'
  | 'broadcast'
  | 'reserved'
  | 'carrier-nat'
  | 'unique-local'
  | 'documentation'
  | 'unparsable';

export class ProhibitedDestinationError extends Error {
  constructor(
    readonly detail: string,
    readonly reason: ProhibitedReason | 'scheme' | 'credentials' | 'malformed-url' | 'redirect-cap',
  ) {
    super(detail);
    this.name = 'ProhibitedDestinationError';
  }
}

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** Classify a dotted-quad IPv4 address against the prohibited-range table. */
export function classifyIpv4(ip: string): AddressClass {
  const octets = parseIpv4(ip);
  if (!octets) return 'unparsable';
  const [a, b, c] = octets;
  if (a === 0) return 'unspecified';            // 0.0.0.0/8 "this network"
  if (a === 10) return 'private';               // RFC1918
  if (a === 127) return 'loopback';             // RFC1122
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-nat';   // RFC6598 100.64/10
  if (a === 169 && b === 254) return 'link-local';              // incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return 'private';        // RFC1918
  if (a === 192 && b === 0 && c === 0) return 'reserved';       // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return 'documentation';  // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return 'reserved';     // 6to4 relay anycast
  if (a === 192 && b === 168) return 'private';                 // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return 'reserved';   // benchmarking
  if (a === 198 && b === 51 && c === 100) return 'documentation'; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return 'documentation';  // TEST-NET-3
  if (a >= 224 && a <= 239) return 'multicast';
  if (ip === '255.255.255.255') return 'broadcast';
  if (a >= 240) return 'reserved';              // 240/4 future use
  return 'public';
}

/** Expand an IPv6 literal (with optional `::` and trailing IPv4) to 16 bytes. */
function parseIpv6(ip: string): number[] | null {
  const zoneless = ip.split('%')[0];
  const halves = zoneless.split('::');
  if (halves.length > 2) return null;

  const expand = (segment: string): number[] | null => {
    if (segment === '') return [];
    const bytes: number[] = [];
    const groups = segment.split(':');
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i];
      if (group.includes('.')) {
        // Trailing dotted-quad form is only legal in the last position.
        if (i !== groups.length - 1) return null;
        const octets = parseIpv4(group);
        if (!octets) return null;
        bytes.push(...octets);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/u.test(group)) return null;
      const value = Number.parseInt(group, 16);
      bytes.push((value >> 8) & 0xff, value & 0xff);
    }
    return bytes;
  };

  const head = expand(halves[0]);
  const tail = halves.length === 2 ? expand(halves[1]) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 16 ? head : null;
  const gap = 16 - head.length - tail.length;
  if (gap < 0) return null;
  return [...head, ...new Array<number>(gap).fill(0), ...tail];
}

/**
 * Classify an IPv6 address. Embedded-IPv4 forms (IPv4-mapped, NAT64, 6to4)
 * are unwrapped and classified as IPv4 so `::ffff:127.0.0.1` cannot smuggle
 * loopback past the IPv4 table.
 */
export function classifyIpv6(ip: string): AddressClass {
  const bytes = parseIpv6(ip);
  if (!bytes) return 'unparsable';
  const dotted = (offset: number): string => bytes.slice(offset, offset + 4).join('.');

  if (bytes.every((byte) => byte === 0)) return 'unspecified';
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return 'loopback';

  // ::ffff:0:0/96 — IPv4-mapped.
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return classifyIpv4(dotted(12));
  }
  // 64:ff9b::/96 — NAT64 well-known prefix.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b
    && bytes.slice(4, 12).every((byte) => byte === 0)) {
    return classifyIpv4(dotted(12));
  }
  // 2002::/16 — 6to4, embeds the IPv4 relay address.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    const embedded = classifyIpv4(dotted(2));
    return embedded === 'public' ? 'reserved' : embedded;
  }
  // 100::/64 — discard-only.
  if (bytes[0] === 0x01 && bytes[1] === 0x00 && bytes.slice(2, 8).every((byte) => byte === 0)) {
    return 'reserved';
  }
  if ((bytes[0] & 0xfe) === 0xfc) return 'unique-local';                    // fc00::/7
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return 'link-local'; // fe80::/10
  if (bytes[0] === 0xff) return 'multicast';                                // ff00::/8
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return 'documentation';                                                 // 2001:db8::/32
  }
  return 'public';
}

/** Classify any IP literal. Anything we cannot parse is refused. */
export function classifyIpAddress(ip: string): AddressClass {
  if (isIPv4(ip)) return classifyIpv4(ip);
  if (isIPv6(ip)) return classifyIpv6(ip);
  return 'unparsable';
}

/** Resolve a hostname to every A/AAAA address the resolver knows. */
export type HostnameResolver = (hostname: string) => Promise<string[]>;

const defaultResolver: HostnameResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

export interface OriginGuardOptions {
  /** Injection seam for tests; defaults to `dns.lookup(..., { all: true })`. */
  resolveHostname?: HostnameResolver;
  /**
   * Escape hatch for local development and e2e, where an operator's
   * `publicEndpoint` legitimately defaults to `http://localhost:<apiPort>`.
   * Off unless explicitly enabled — the default is fail-closed.
   */
  allowPrivateDestinations?: boolean;
}

/** `[::1]` → `::1`; other hostnames are returned unchanged. */
function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Validate one destination. Throws `ProhibitedDestinationError` unless the
 * URL is a credential-free public `http:`/`https:` destination whose every
 * resolved address classifies as public.
 */
export async function assertPublicHttpDestination(
  url: URL,
  options: OriginGuardOptions = {},
): Promise<void> {
  if (options.allowPrivateDestinations === true) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ProhibitedDestinationError(
        `artifact origin scheme ${url.protocol} is not http(s): ${url.href}`, 'scheme');
    }
    return;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProhibitedDestinationError(
      `artifact origin scheme ${url.protocol} is not http(s): ${url.href}`, 'scheme');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ProhibitedDestinationError(
      `artifact origin must not carry credentials: ${url.host}`, 'credentials');
  }

  const host = unbracket(url.hostname);
  if (host === '') {
    throw new ProhibitedDestinationError('artifact origin has no host', 'malformed-url');
  }

  if (isIPv4(host) || isIPv6(host)) {
    const verdict = classifyIpAddress(host);
    if (verdict !== 'public') {
      throw new ProhibitedDestinationError(
        `artifact origin address ${host} is ${verdict}, not a public destination`, verdict);
    }
    return;
  }

  let addresses: string[];
  try {
    addresses = await (options.resolveHostname ?? defaultResolver)(host);
  } catch (err) {
    throw new ProhibitedDestinationError(
      `artifact origin ${host} did not resolve: ${err instanceof Error ? err.message : String(err)}`,
      'unparsable',
    );
  }
  if (addresses.length === 0) {
    throw new ProhibitedDestinationError(
      `artifact origin ${host} resolved to no addresses`, 'unparsable');
  }
  for (const address of addresses) {
    const verdict = classifyIpAddress(address);
    if (verdict !== 'public') {
      throw new ProhibitedDestinationError(
        `artifact origin ${host} resolves to ${address} (${verdict}), not a public destination`,
        verdict,
      );
    }
  }
}
