const IPFS_FETCH_TIMEOUT_MS = 15_000;
/**
 * Bound on one whole `fetchFromIpfs` / `fetchBytesFromIpfs` call. The
 * per-attempt timer above is re-armed for every gateway x CID candidate, so
 * without this a single call could legitimately run for the product of the
 * two. Every candidate is still attempted: the per-attempt timer is clamped
 * to an equal share of whatever budget remains.
 */
const IPFS_TOTAL_FETCH_TIMEOUT_MS = 45_000;
/**
 * Cap on any single gateway response, JSON or raw. Corpus manifests and
 * donation artifacts are JSON envelopes orders of magnitude smaller than this
 * (#3410); the raw-bytes path added in #3438 also carries source-bundle files
 * and sealed documents, which are larger but nowhere near this. A response
 * above it is hostile or broken, and buffering it would exhaust memory — so
 * size this against the largest legitimate *source file*, not against the
 * JSON envelopes alone.
 */
const MAX_IPFS_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_IPFS_REDIRECT_HOPS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FALLBACK_IPFS_GATEWAY_BASE = 'https://ipfs.io/ipfs/';

/**
 * A gateway response the byte cap refused. FAILURE IS NOT ABSENCE (#2647, #3451): the gateway
 * answered FOR this content, so the refusal is positive evidence that it EXISTS and is merely
 * larger than policy allows. (On the declared-`content-length` path the body is discarded unread,
 * so the evidence is the headers rather than the bytes — still an answer, not a miss.) A caller
 * that reports it as "not on IPFS" turns a size-policy decision into a silent data gap.
 */
export class IpfsResponseTooLargeError extends Error {
  override readonly name = 'IpfsResponseTooLargeError';

  constructor(readonly limitBytes: number, readonly declaredBytes?: number) {
    super(
      `IPFS response exceeds the ${limitBytes}-byte cap`
        + (declaredBytes === undefined ? '' : ` (content-length ${declaredBytes})`),
    );
  }
}

/**
 * The gateway answered that this content is not there. The one failure mode that IS absence
 * (#3451) — every other one leaves the question unanswered.
 */
export class IpfsContentNotFoundError extends Error {
  override readonly name = 'IpfsContentNotFoundError';

  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Every gateway x CID candidate failed. Carries the per-candidate causes so a caller can classify
 * the whole operation with {@link classifyIpfsFetchFailure} instead of string-matching the joined
 * message, which is a display artifact and not a contract.
 */
export class IpfsFetchFailedError extends Error {
  override readonly name = 'IpfsFetchFailedError';

  constructor(message: string, readonly causes: readonly unknown[]) {
    super(message);
  }
}

/**
 * Classify a failed IPFS fetch into the three answers a caller can act on differently:
 *
 *   - `'too-large'` — at least one candidate served the content and the byte cap refused it. This
 *     dominates: a size refusal is positive proof of presence, so it outranks any number of
 *     not-found answers from other candidates.
 *   - `'not-found'` — every candidate answered, and every answer was "not there". Genuine absence.
 *   - `'unavailable'` — anything else (transport error, timeout, malformed candidate URL). Nothing
 *     was learned about whether the content exists.
 *
 * `'not-found'` is deliberately strict, and in production it is therefore the rarest answer: a
 * default fetch also tries the `ipfs.io` fallback, which typically stalls into a 504 or an abort
 * for an unpinned digest rather than answering 404. Such a run classifies `'unavailable'` — the
 * safe direction, since absence is never claimed without proof of it.
 */
export function classifyIpfsFetchFailure(
  error: unknown,
): 'too-large' | 'not-found' | 'unavailable' {
  const causes = error instanceof IpfsFetchFailedError ? error.causes : [error];
  if (causes.some((cause) => cause instanceof IpfsResponseTooLargeError)) return 'too-large';
  if (causes.length > 0 && causes.every((cause) => cause instanceof IpfsContentNotFoundError)) {
    return 'not-found';
  }
  return 'unavailable';
}

export function normalizeIpfsGatewayBase(gatewayUrl: string): string {
  let normalized = gatewayUrl.trim();
  if (normalized === '') normalized = 'https://gateway.autonolas.tech';
  // Drop any userinfo at the source. `fetch` rejects a credentialed URL
  // outright, and its own error message quotes the URL back — so a gateway
  // configured Infura-style would otherwise put its secret into every
  // aggregated fetch error, which callers log.
  try {
    const parsed = new URL(normalized);
    if (parsed.username !== '' || parsed.password !== '') {
      parsed.username = '';
      parsed.password = '';
      normalized = parsed.toString();
    }
  } catch {
    // Not an absolute URL; leave it to the caller's own failure path.
  }
  normalized = normalized.replace(/\/+$/, '');
  if (!normalized.toLowerCase().endsWith('/ipfs')) normalized = `${normalized}/ipfs`;
  return `${normalized}/`;
}

export function buildIpfsHexCidCandidatesFromPartialHex(hex: string): string[] {
  const normalized = (hex.startsWith('0x') ? hex.slice(2) : hex).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) return [hex];
  return [`f01551220${normalized}`, `f01701220${normalized}`];
}

export function buildIpfsFetchCidPathCandidates(cidOrPath: string): string[] {
  const value = cidOrPath.trim();
  const lower = value.toLowerCase();
  if (lower.startsWith('f01551220') && lower.length > 9) {
    return buildIpfsHexCidCandidatesFromPartialHex(lower.slice(9));
  }
  if (lower.startsWith('f01701220') && lower.length > 9) {
    return buildIpfsHexCidCandidatesFromPartialHex(lower.slice(9));
  }
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return buildIpfsHexCidCandidatesFromPartialHex(value);
  }
  return [value];
}

function isHostInGatewayFamily(host: string, gatewayHost: string): boolean {
  const candidate = host.toLowerCase();
  const gateway = gatewayHost.toLowerCase();
  return candidate === gateway || candidate.endsWith(`.${gateway}`);
}

/**
 * A gateway may legitimately redirect the path form of a CID to its subdomain
 * form, so hops are allowed inside the configured gateway's host family. They
 * are never allowed to leave it, to reach a different port on it, to downgrade
 * the transport, or to smuggle credentials.
 */
function assertRedirectAllowed(next: URL, current: URL, gateway: URL): void {
  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    throw new Error(`IPFS redirect uses an unsupported scheme (${next.protocol})`);
  }
  if (current.protocol === 'https:' && next.protocol === 'http:') {
    throw new Error('IPFS redirect downgrades https to http');
  }
  if (next.username !== '' || next.password !== '') {
    throw new Error('IPFS redirect carries embedded credentials');
  }
  if (!isHostInGatewayFamily(next.hostname, gateway.hostname)) {
    throw new Error(`IPFS redirect leaves the configured gateway (${next.hostname})`);
  }
  // Host family alone would let a self-hosted gateway (`http://127.0.0.1:8080/ipfs/`)
  // pivot onto any other service on the same host. `URL.port` is '' for the
  // scheme default, so the comparison is already normalized.
  if (next.port !== gateway.port) {
    throw new Error(
      `IPFS redirect changes the gateway port (${next.port === '' ? 'default' : next.port})`,
    );
  }
}

/** Location for an error message, with any configured gateway credentials dropped. */
function displayUrl(url: URL): string {
  return `${url.origin}${url.pathname}`.slice(0, 100);
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that refuses to cancel is not worth failing the request over.
  }
}

/** Read a response body as bytes, refusing anything past the byte cap. */
async function readBoundedBytes(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IPFS_RESPONSE_BYTES) {
    await discardBody(response);
    throw new IpfsResponseTooLargeError(MAX_IPFS_RESPONSE_BYTES, declared);
  }
  const body = response.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_IPFS_RESPONSE_BYTES) {
        throw new IpfsResponseTooLargeError(MAX_IPFS_RESPONSE_BYTES);
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already terminal; the read result (or throw) above is what matters.
    }
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/** Read a response body as text, refusing anything past the byte cap. */
async function readBoundedText(response: Response): Promise<string> {
  const joined = await readBoundedBytes(response);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(joined);
  } catch {
    throw new Error('IPFS response is not valid UTF-8');
  }
}

/**
 * Request `url`, resolving redirects here rather than in `fetch`, so every hop
 * is revalidated against the configured gateway before it is requested.
 * Returns the first non-redirect, ok response; its body is still unread.
 */
async function fetchThroughGateway(url: URL, signal: AbortSignal): Promise<Response> {
  const gateway = url;
  let current = new URL(url);
  for (let hop = 0; ; hop += 1) {
    const response = await fetch(current, { method: 'GET', redirect: 'manual', signal });
    if (REDIRECT_STATUSES.has(response.status)) {
      await discardBody(response);
      if (hop >= MAX_IPFS_REDIRECT_HOPS) {
        throw new Error(`IPFS fetch exceeded ${MAX_IPFS_REDIRECT_HOPS} redirects`);
      }
      const location = response.headers.get('location');
      if (location === null || location.trim() === '') {
        throw new Error(`IPFS gateway returned ${response.status} without a Location header`);
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error('IPFS redirect Location is not a valid URL');
      }
      assertRedirectAllowed(next, current, gateway);
      current = next;
      continue;
    }
    if (!response.ok) {
      await discardBody(response);
      const message =
        `IPFS fetch failed: ${response.status} ${response.statusText} ` +
        `(${displayUrl(current)}…)`;
      // 404/410 is the gateway ANSWERING "not there" — the only status that carries absence.
      // Every other one (429, 5xx, …) leaves the question open and stays a plain failure.
      if (response.status === 404 || response.status === 410) {
        throw new IpfsContentNotFoundError(message, response.status);
      }
      throw new Error(message);
    }
    return response;
  }
}

async function fetchJson(url: URL, signal: AbortSignal): Promise<unknown> {
  const response = await fetchThroughGateway(url, signal);
  const contentType = response.headers.get('content-type') ?? '';
  const text = await readBoundedText(response);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`IPFS response is not JSON (content-type: ${contentType || 'none'})`);
  }
}

async function fetchBytes(url: URL, signal: AbortSignal): Promise<Uint8Array> {
  return readBoundedBytes(await fetchThroughGateway(url, signal));
}

export type FetchFromIpfsOptions = {
  /**
   * Extra gateway base after the primary fails.
   * - omit / undefined → production default `https://ipfs.io/ipfs/`
   * - false → primary gateway only (hermetic / pinned rigs)
   * - string → alternate fallback (normalized via `normalizeIpfsGatewayBase`)
   */
  fallbackGatewayBase?: string | false;
};

function resolveFallbackGatewayBases(
  opts?: FetchFromIpfsOptions,
): Array<readonly [string, string]> {
  if (opts?.fallbackGatewayBase === false) return [];
  if (typeof opts?.fallbackGatewayBase === 'string') {
    return [['fallback', normalizeIpfsGatewayBase(opts.fallbackGatewayBase)] as const];
  }
  return [['fallback', FALLBACK_IPFS_GATEWAY_BASE] as const];
}

/**
 * Run every gateway x CID candidate through `read`, under one whole-operation
 * deadline. Shared by the JSON and raw-bytes entry points so both inherit the
 * same redirect revalidation, byte cap, and deadline (#3438).
 */
async function fetchCandidatesFromIpfs<T>(
  gatewayUrl: string,
  cid: string,
  opts: FetchFromIpfsOptions | undefined,
  read: (url: URL, signal: AbortSignal) => Promise<T>,
  failureLabel: string,
): Promise<T> {
  const primary = normalizeIpfsGatewayBase(gatewayUrl);
  const gateways: Array<readonly [string, string]> = [
    ['primary', primary] as const,
    ...resolveFallbackGatewayBases(opts),
  ];
  const attempts: Array<readonly [string, string]> = [];
  for (const cidPath of buildIpfsFetchCidPathCandidates(cid)) {
    for (const [name, baseUrl] of gateways) attempts.push([name, `${baseUrl}${cidPath}`] as const);
  }

  const errors: string[] = [];
  // Parallel to `errors`: the display message is for the operator, the cause is what
  // `classifyIpfsFetchFailure` reads to tell a size refusal and a transport failure apart from
  // genuine absence (#3451).
  const causes: unknown[] = [];
  const deadline = Date.now() + IPFS_TOTAL_FETCH_TIMEOUT_MS;
  for (let index = 0; index < attempts.length; index += 1) {
    const [name, url] = attempts[index];
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      const message = `whole-operation timeout after ${IPFS_TOTAL_FETCH_TIMEOUT_MS}ms`;
      errors.push(message);
      causes.push(new Error(message));
      break;
    }
    // Share what is left of the budget across the candidates still to try, so a
    // run of slow early candidates cannot starve a later one that would have
    // succeeded. Without this the whole-operation bound would silently narrow
    // the candidate matrix instead of only bounding it.
    const attemptMs = Math.min(
      IPFS_FETCH_TIMEOUT_MS,
      Math.ceil(remainingMs / (attempts.length - index)),
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptMs);
    // Parsed once here rather than inside the catch, so a URL this candidate
    // cannot even parse is reported as a candidate failure instead of escaping
    // as a bare TypeError that discards the other candidates' errors.
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      const message = `${name}: candidate URL could not be parsed`;
      errors.push(message);
      causes.push(new Error(message));
      clearTimeout(timer);
      continue;
    }
    try {
      return await read(target, controller.signal);
    } catch (error) {
      errors.push(
        `${name}:${displayUrl(target)}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      causes.push(error);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new IpfsFetchFailedError(`${failureLabel}: ${errors.join(' | ')}`, causes);
}

/** Read-only multi-codec, primary-plus-fallback IPFS JSON fetch. */
export async function fetchFromIpfs(
  gatewayUrl: string,
  cid: string,
  opts?: FetchFromIpfsOptions,
): Promise<unknown> {
  return fetchCandidatesFromIpfs(
    gatewayUrl,
    cid,
    opts,
    fetchJson,
    'IPFS JSON fetch failed after all candidates',
  );
}

/**
 * Read-only multi-codec, primary-plus-fallback IPFS fetch returning the exact
 * bytes stored at the CID — no JSON parse/re-encode roundtrip. Use this
 * whenever the bytes will be hashed, or whenever the content is not JSON.
 */
export async function fetchBytesFromIpfs(
  gatewayUrl: string,
  cid: string,
  opts?: FetchFromIpfsOptions,
): Promise<Uint8Array> {
  return fetchCandidatesFromIpfs(
    gatewayUrl,
    cid,
    opts,
    fetchBytes,
    'IPFS raw bytes fetch failed after all candidates',
  );
}
