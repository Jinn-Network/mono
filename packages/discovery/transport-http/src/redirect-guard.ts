import type { FetchLike } from "./ports.js";

// The per-hop destination guard shared by this package's two GET-shaped
// transports (`fetch-transport`, `sse-transport`). It lives in its own module
// so the rule has exactly one implementation: a guard that two callers
// re-derive independently is a guard that drifts.
//
// This module takes its network primitive as the injected `FetchLike` port and
// never names an ambient one, so it stays outside the source-boundaries
// allowlist that the three transport modules occupy.

export class TransportRedirectError extends Error {
  readonly url: string;
  readonly location: string;

  constructor(url: string, location: string, detail: string) {
    super(`GET ${url} was redirected to ${location}: ${detail}`);
    this.name = "TransportRedirectError";
    this.url = url;
    this.location = location;
  }
}

/**
 * Redirect statuses this guard treats as a redirect. 304 sits in the same
 * numeric band and is emphatically NOT one -- it is the §7.3 revalidation hit
 * `fetch-transport`'s caller turns back into cached bytes.
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Enough hops for a peer normalizing its own paths; far short of undici's 20. */
const MAX_REDIRECTS = 5;

/** The port a scheme uses when the URL names none. */
const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/**
 * Is this hop the one origin change that strictly increases assurance -- a
 * same-host plain-to-TLS upgrade (#3433)?
 *
 * A scheme change is an origin change, so PR #3414's guard refused
 * `http://peer.example` -> `https://peer.example`, which is the single most
 * common thing a real host does: terminate TLS and 301 everything up to it.
 * That turned a previously self-healing operator misconfiguration into a hard
 * refusal, and on the startup path into a failed boot.
 *
 * The carve-out is deliberately narrow enough that it cannot move a request
 * anywhere new. The hostname must be byte-identical, and BOTH sides must be on
 * their scheme's default port -- so `http://h:8080` -> `https://h:9443` is
 * still refused, and no port is ever chosen by the peer. #3411's actual attack
 * (`302 Location: http://127.0.0.1:8545/`) changes the host and so remains
 * refused, as does a downgrade from `https:` to `http:`, which decreases
 * assurance and has no legitimate deployment shape.
 */
function isSameHostTlsUpgrade(current: URL, next: URL): boolean {
  if (current.protocol !== "http:" || next.protocol !== "https:") return false;
  if (current.hostname !== next.hostname) return false;
  const currentPort = current.port === "" ? DEFAULT_PORTS["http:"] : current.port;
  const nextPort = next.port === "" ? DEFAULT_PORTS["https:"] : next.port;
  return currentPort === DEFAULT_PORTS["http:"] && nextPort === DEFAULT_PORTS["https:"];
}

/**
 * Did the primitive obey `redirect: "manual"`, or did it walk the chain itself
 * (#3432)?
 *
 * `FetchLike` makes `redirect` optional, so an injected implementation that
 * ignores it follows the hops and hands back the FINAL response. Every hop
 * check below then runs against a chain that has already been walked, and the
 * guard is decorative with nothing noticing. No production construction does
 * this today -- they all pass the Node 22 global -- but a guard that cannot
 * tell whether it is armed is one refactor away from being useless.
 *
 * The tell is free and comes from the Fetch spec itself: a response the
 * primitive arrived at by following a hop carries `redirected === true` and a
 * `url` moved to the final destination, and both stay put under `manual`. A
 * synthetic `Response` (what this package's own test loopbacks build) reports
 * `redirected === false` and an empty `url`, so the check is silent for an
 * honest injected port.
 *
 * `redirected` alone is enough to refuse: real undici never sets it under
 * `manual`. The `url` origin comparison catches the narrower case of an
 * implementation that follows without setting the flag.
 */
function assertNoHopWasFollowed(response: Response, requested: URL, target: string): void {
  if (response.redirected === true) {
    throw new TransportRedirectError(
      target,
      response.url === "" ? "an unreported destination" : response.url,
      "the primitive followed the redirect itself despite redirect: \"manual\", so the per-hop origin "
        + "rule could not be applied",
    );
  }
  if (response.url === "" || response.url === undefined) return;
  let settled: URL;
  try {
    settled = new URL(response.url);
  } catch {
    return;
  }
  if (settled.origin !== requested.origin) {
    throw new TransportRedirectError(
      target,
      response.url,
      `the primitive settled on origin ${settled.origin} rather than the requested ${requested.origin}, `
        + "so the per-hop origin rule could not be applied",
    );
  }
}

/**
 * Performs the request, following only redirects that stay on the origin the
 * caller asked for.
 *
 * A destination guard that inspects the requested URL is worth nothing if the
 * server at that URL can then post a forwarding address (#3411). The serving
 * root is operator-CONFIGURED but peer-OPERATED: with the default
 * `redirect: "follow"` a peer answered a perfectly contained request with
 * `302 Location: http://127.0.0.1:8545/` and undici walked the daemon there,
 * restoring exactly the arbitrary-destination request the containment guard in
 * `discovery/client`'s `origin-policy` exists to remove.
 *
 * Same-origin is the invariant enforced here because it is precisely the
 * promise the guard makes: a peer may move a request only within an origin the
 * operator already chose. The path within that origin stays the peer's to
 * choose -- it always was, since the peer serves the archive. The one
 * exception is `isSameHostTlsUpgrade`, which cannot move the request to a host
 * or port the peer picked.
 *
 * Note this is deliberately weaker than the resolver's test, which is origin
 * PLUS the serving root's path prefix. This guard has no serving root to
 * compare against -- the fleet daemon builds the transport with an empty base
 * and shares one instance across sources -- so a same-origin redirect could
 * move the request outside that prefix. Harmless today (a path-bearing serving
 * root has never had a working `.well-known` read, so the prefix is always
 * `/`), but a deployment that changes that must move the prefix test in here
 * rather than inherit the asymmetry silently.
 */
export async function requestWithinOrigin(
  fetchLike: FetchLike,
  target: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  // Carried as a URL, not a string: every hop needs its origin, and re-parsing
  // the spelling each time invites the two forms disagreeing. Parsing here also
  // names the one input these transports cannot work with -- a relative target,
  // which the primitive would have rejected a line later with a bare TypeError.
  let current: URL;
  try {
    current = new URL(target);
  } catch {
    throw new TypeError(
      `GET ${target} is not an absolute URL; the transport needs one to hold each redirect hop to its origin.`,
    );
  }
  for (let hop = 0; ; hop += 1) {
    // eslint-disable-next-line no-await-in-loop -- a redirect chain is sequential by definition.
    // The signal is re-supplied on EVERY hop: a redirect chain is a fresh
    // request each time, and a deadline that only covered the first one would
    // let a peer stretch the read indefinitely by redirecting within its own
    // origin.
    const requested = current;
    const response = await fetchLike(requested.toString(), {
      method: "GET",
      headers,
      redirect: "manual",
      ...(signal === undefined ? {} : { signal }),
    });
    assertNoHopWasFollowed(response, requested, target);
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("location");
    // A redirect status with no Location is malformed; hand it back so the
    // caller's ordinary non-2xx check reports it as the HTTP error it is.
    if (location === null || location.trim() === "") return response;
    if (hop >= MAX_REDIRECTS) {
      throw new TransportRedirectError(target, location, `more than ${MAX_REDIRECTS} redirects`);
    }

    let next: URL;
    try {
      next = new URL(location, requested);
    } catch {
      throw new TransportRedirectError(target, location, "the redirect target is not a resolvable URL");
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new TransportRedirectError(target, location, `scheme ${next.protocol} is not HTTP(S)`);
    }
    // Checked before the origin test, which strips userinfo. `resolveContainedUrl`
    // refuses credentials explicitly for the same reason (`origin-policy.ts`), and
    // without this the hop dies inside undici with a bare `Request cannot be
    // constructed from a URL that includes credentials` -- no security
    // consequence, but an illegible one (#3432).
    if (next.username !== "" || next.password !== "") {
      throw new TransportRedirectError(target, location, "the redirect target carries embedded credentials");
    }
    if (next.origin !== requested.origin && !isSameHostTlsUpgrade(requested, next)) {
      throw new TransportRedirectError(target, location, `origin ${next.origin} is not ${requested.origin}`);
    }
    current = next;
  }
}
