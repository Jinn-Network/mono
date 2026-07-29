import type { Hex } from 'viem';
import type { Task, TaskResult } from '../../types/index.js';
import { parseSignedTaskV1, type SignedTaskV1 } from '../../types/task-document.js';
import { IPFS_GATEWAY_PREFIX } from './types.js';
import { canonicalJson } from '../../harnesses/engine/canonical-json.js';
import {
  buildIpfsFetchCidPathCandidates,
  buildIpfsHexCidCandidatesFromPartialHex,
  fetchFromIpfs,
  normalizeIpfsGatewayBase,
  type FetchFromIpfsOptions,
} from '@jinn-network/core/corpus-read';

export {
  buildIpfsFetchCidPathCandidates,
  buildIpfsHexCidCandidatesFromPartialHex,
  fetchFromIpfs,
  normalizeIpfsGatewayBase,
  type FetchFromIpfsOptions,
} from '@jinn-network/core/corpus-read';

export interface TaskPayload {
  taskId: string;
  description: string;
  context?: Record<string, unknown>;
  role?: 'restoration' | 'evaluation';
  attemptId?: string;
  attemptNumber?: number;
  restorationRequestId?: string;
  solverType?: string;
  // typed solver payload; dispatcher is top-level `solverType`.
  spec?: Record<string, unknown>;
  window?: { startTs: number; endTs: number };
  eligibility?: Record<string, unknown>;
}

export interface RestorationResultPayload {
  requestId: string;
  data: string;
  artifacts?: string[];
}

export function buildTaskPayload(state: Task): TaskPayload {
  return {
    taskId: state.id,
    description: state.description,
    context: state.context,
    solverType: state.solverType,
    role: state.role,
    attemptId: state.attemptId,
    attemptNumber: state.attemptNumber,
    restorationRequestId: state.restorationRequestId,
    ...(state.spec ? { spec: state.spec } : {}),
    ...(state.window ? { window: state.window } : {}),
    ...(state.eligibility ? { eligibility: state.eligibility } : {}),
  };
}

export function parseTaskFromPayload(payload: Record<string, unknown>): Task {
  const spec = payload.spec as Task['spec'] | undefined;
  const rawWindow = payload.window as { startTs?: unknown; endTs?: unknown } | undefined;
  const window =
    rawWindow && typeof rawWindow.startTs === 'number' && typeof rawWindow.endTs === 'number'
      ? { startTs: rawWindow.startTs, endTs: rawWindow.endTs }
      : undefined;
  const eligibility = payload.eligibility as Record<string, unknown> | undefined;

  return {
    id: (payload.taskId as string) ?? '',
    description: (payload.description as string) ?? '',
    context: payload.context as Record<string, unknown> | undefined,
    solverType: payload.solverType as string | undefined,
    role: payload.role as 'restoration' | 'evaluation' | undefined,
    attemptId: payload.attemptId as string | undefined,
    attemptNumber: payload.attemptNumber as number | undefined,
    restorationRequestId: payload.restorationRequestId as string | undefined,
    ...(spec ? { spec } : {}),
    ...(window ? { window } : {}),
    ...(eligibility ? { eligibility } : {}),
  };
}

export function buildResultPayload(requestId: string, result: TaskResult): RestorationResultPayload {
  return {
    requestId,
    data: result.data,
    artifacts: result.artifacts,
  };
}

/**
 * Default per-request timeout (ms) when fetching from a gateway.
 * jinn-node uses 7–10s; we allow a bit more for slow public gateways.
 */
const IPFS_FETCH_TIMEOUT_MS = 15_000;
const IPFS_UPLOAD_TIMEOUT_MS = 60_000;

const FALLBACK_IPFS_GATEWAY_BASE = 'https://ipfs.io/ipfs/';

/** Same opts semantics as core `fetchFromIpfs` — raw fetchers share the pin for hermetic parity (#1648). */
function resolveMechIpfsGateways(
  gatewayUrl: string,
  opts?: FetchFromIpfsOptions,
): Array<readonly [string, string]> {
  const primary = normalizeIpfsGatewayBase(gatewayUrl);
  const list: Array<readonly [string, string]> = [['primary', primary]];
  if (opts?.fallbackGatewayBase === false) return list;
  if (typeof opts?.fallbackGatewayBase === 'string') {
    list.push(['fallback', normalizeIpfsGatewayBase(opts.fallbackGatewayBase)]);
    return list;
  }
  list.push(['fallback', FALLBACK_IPFS_GATEWAY_BASE]);
  return list;
}

export function normalizeIpfsRegistryAddUrl(registryUrl: string): string {
  let t = registryUrl.trim();
  if (t === '') t = 'https://registry.autonolas.tech';
  t = t.replace(/\/+$/, '');
  if (t.endsWith('/api/v0/add')) return t;
  return `${t}/api/v0/add`;
}

export function parseRegistryUploadCid(responseText: string): string {
  let lastHash: string | undefined;
  for (const line of responseText.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { Hash?: unknown };
      if (typeof entry.Hash === 'string' && entry.Hash.length > 0) {
        lastHash = entry.Hash;
      }
    } catch {
      // Ignore non-JSON lines — the registry returns newline-delimited JSON.
    }
  }
  if (!lastHash) throw new Error('IPFS registry upload did not return a CID');
  return lastHash;
}

/**
 * Upload JSON serialized to JCS canonical bytes (RFC 8785) so CID and sha256
 * fields are reproducible by any third party with a standard JCS library.
 */
export interface UploadToIpfsOptions {
  /**
   * Ask Kubo to address the payload bytes directly. Manifest consumers verify
   * canonical body bytes against the CID multihash, so manifests must opt in.
   */
  rawLeaves?: boolean;
}

export async function uploadToIpfs(
  registryUrl: string,
  data: unknown,
  options: UploadToIpfsOptions = {},
): Promise<string> {
  const url = new URL(normalizeIpfsRegistryAddUrl(registryUrl));
  url.searchParams.set('pin', 'true');
  url.searchParams.set('cid-version', '1');
  url.searchParams.set('wrap-with-directory', 'false');
  if (options.rawLeaves) url.searchParams.set('raw-leaves', 'true');

  const jcsBytes = new TextEncoder().encode(canonicalJson(data));
  const formData = new FormData();
  formData.append('file', new Blob([jcsBytes], { type: 'application/json' }), 'content.json');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IPFS_UPLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
    const responseText = await response.text();
    if (response.status !== 200) {
      throw new Error(`IPFS registry upload failed with status ${response.status}: ${responseText.slice(0, 200)}`);
    }
    return parseRegistryUploadCid(responseText);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a Task CID from IPFS and parse it through `parseSignedTaskV1`.
 *
 * Use this whenever you have a Task CID and want a typed `SignedTaskV1`
 * document. Throws `ZodError` if the fetched bytes don't conform to the
 * `task.v1` schema.
 */
export async function fetchSignedTaskFromIpfs(
  gatewayUrl: string,
  cid: string,
  opts?: FetchFromIpfsOptions,
): Promise<SignedTaskV1> {
  const raw = await fetchFromIpfs(gatewayUrl, cid, opts);
  return parseSignedTaskV1(raw);
}

/**
 * Extract the 32-byte SHA256 digest from a CIDv1 string.
 *
 * CIDv1 structure (base32): multibase + version + codec + multihash
 * Multihash: [0x12 (sha2-256)] [0x20 (32 bytes)] [32 bytes digest]
 *
 * The Mech marketplace uses the raw 32-byte digest as requestData on-chain.
 */
export function cidToDigestHex(cid: string): Hex {
  let bytes: Uint8Array;

  if (cid.startsWith('Qm')) {
    // CIDv0 — base58btc encoded multihash directly
    bytes = base58Decode(cid);
  } else if (cid.startsWith('f') || cid.startsWith('F')) {
    // CIDv1 hex multibase ('f' prefix per multibase spec).
    // Format: f + <hex bytes> where hex bytes = version(01) + codec(varint) + multihash.
    // e.g. `f01551220{sha256hex}` = version 0x01, codec 0x55 (raw), multihash sha2-256.
    const hexBody = cid.slice(1).toLowerCase();
    const rawBytes: number[] = [];
    for (let i = 0; i < hexBody.length; i += 2) {
      rawBytes.push(parseInt(hexBody.slice(i, i + 2), 16));
    }
    const raw = new Uint8Array(rawBytes);
    // Skip version (1 byte) and codec varint (1+ bytes)
    let offset = 1;
    while (raw[offset]! & 0x80) offset++;
    offset++;
    bytes = raw.slice(offset);
  } else {
    // CIDv1 — decode multibase, skip version byte and codec varint
    const raw = cid.startsWith('b')
      ? base32Decode(cid.slice(1)) // strip 'b' multibase prefix
      : base58Decode(cid.slice(1)); // strip 'z' multibase prefix

    // Skip version (1 byte) and codec (1-2 bytes varint)
    let offset = 1; // skip version
    while (raw[offset]! & 0x80) offset++;
    offset++; // skip last byte of varint
    bytes = raw.slice(offset);
  }

  // bytes is now the multihash: [hashFn, length, ...digest]
  // Reject truncated inputs up front so the error message names the real
  // failure (length) rather than reading undefined out of an empty array
  // and rendering "fn=0xundefined, len=undefined".
  if (bytes.length < 34) {
    throw new Error(
      `CID payload too short for sha2-256 multihash: expected ≥ 34 bytes (fn + len + 32 digest), got ${bytes.length} (cid=${cid.slice(0, 16)}…)`,
    );
  }
  if (bytes[0] !== 0x12 || bytes[1] !== 0x20) {
    throw new Error(`Unsupported multihash: fn=0x${bytes[0]!.toString(16)}, len=${bytes[1]}`);
  }

  const digest = bytes.slice(2, 34);
  return `0x${Buffer.from(digest).toString('hex')}` as Hex;
}

/**
 * Decode only the canonical CID forms accepted at a manifest boundary:
 * CIDv1, raw codec, sha2-256, encoded as canonical base16 or base32.
 */
export function rawSha256CidToDigestHex(cid: string): Hex {
  let bytes: Uint8Array;
  if (
    cid.length === 73
    && cid.startsWith('f')
    && /^[0-9a-f]{72}$/u.test(cid.slice(1))
  ) {
    bytes = Uint8Array.from(
      cid.slice(1).match(/.{2}/gu)!.map((byte) => Number.parseInt(byte, 16)),
    );
  } else if (
    cid.length === 73
    && cid.startsWith('F')
    && /^[0-9A-F]{72}$/u.test(cid.slice(1))
  ) {
    bytes = Uint8Array.from(
      cid.slice(1).match(/.{2}/gu)!.map((byte) => Number.parseInt(byte, 16)),
    );
  } else if (
    cid.length === 59
    && cid.startsWith('b')
    && /^[a-z2-7]{58}$/u.test(cid.slice(1))
    && (BASE32_ALPHABET.indexOf(cid.at(-1)!) & 0x03) === 0
  ) {
    bytes = base32Decode(cid.slice(1));
  } else {
    throw new Error(
      'manifest CID must use canonical CIDv1 base16 or base32 encoding',
    );
  }

  if (
    bytes.length !== 36
    || bytes[0] !== 0x01
    || bytes[1] !== 0x55
    || bytes[2] !== 0x12
    || bytes[3] !== 0x20
  ) {
    throw new Error(
      'manifest CID must use the raw codec and a 32-byte sha2-256 multihash',
    );
  }
  return `0x${Buffer.from(bytes.slice(4)).toString('hex')}` as Hex;
}

/** Compare canonical raw/sha2-256 CIDv1 values across multibase encodings. */
export function rawSha256CidsEqual(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return rawSha256CidToDigestHex(left).toLowerCase()
      === rawSha256CidToDigestHex(right).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Construct an Autonolas IPFS gateway URL from a raw SHA256 digest hex string.
 */
export function digestHexToGatewayUrl(digestHex: string): string {
  const hex = digestHex.startsWith('0x') ? digestHex.slice(2) : digestHex;
  return `${IPFS_GATEWAY_PREFIX}${hex}`;
}

/**
 * Fetch content from IPFS using a raw SHA256 digest hex (with or without `0x`).
 * Uses the same multi-codec and multi-gateway path as `fetchFromIpfs`.
 */
export async function fetchFromDigest(digestHex: string): Promise<unknown> {
  const hex = (digestHex.startsWith('0x') ? digestHex.slice(2) : digestHex).toLowerCase();
  return fetchFromIpfs('https://gateway.autonolas.tech', `f01551220${hex}`);
}

// ── Conformance harness IPFS fetch helpers ───────────────────────────────────

async function fetchRawBytesFromUrl(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { method: 'GET', signal });
  if (!response.ok) {
    throw new Error(`IPFS fetch failed: ${response.status} ${response.statusText} (${url.slice(0, 80)}…)`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Fetch a SignedEnvelope from IPFS by CID as raw bytes.
 * Returns the exact bytes stored at the CID — no JSON parse/re-encode roundtrip.
 * Use this whenever the bytes will be hashed (conformance hash-signature check).
 */
export async function fetchSignedEnvelopeBytesRaw(
  gatewayUrl: string,
  cid: string,
  opts?: FetchFromIpfsOptions,
): Promise<Uint8Array> {
  const gateways = resolveMechIpfsGateways(gatewayUrl, opts);
  const candidates = buildIpfsFetchCidPathCandidates(cid);
  const errors: string[] = [];
  for (const cidPath of candidates) {
    for (const [name, baseUrl] of gateways) {
      const url = `${baseUrl}${cidPath}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IPFS_FETCH_TIMEOUT_MS);
      try {
        return await fetchRawBytesFromUrl(url, controller.signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${name}:${url.slice(0, 100)}: ${message}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw new Error(`IPFS raw bytes fetch failed after all candidates: ${errors.join(' | ')}`);
}

/**
 * Fetch a SignedEnvelope from IPFS by CID.
 * Returns the raw parsed JSON object (caller must validate schema).
 */
export async function fetchSignedEnvelopeFromIpfs(
  gatewayUrl: string,
  cid: string,
  opts?: FetchFromIpfsOptions,
): Promise<unknown> {
  return fetchFromIpfs(gatewayUrl, cid, opts);
}

/**
 * Fetch a JinnTrajectoryV1 from IPFS by CID.
 * Returns the raw parsed JSON object (caller must validate schema).
 */
export async function fetchTrajectoryFromIpfs(
  gatewayUrl: string,
  cid: string,
  opts?: FetchFromIpfsOptions,
): Promise<unknown> {
  return fetchFromIpfs(gatewayUrl, cid, opts);
}

/**
 * Fetch raw bytes from IPFS by CID.
 *
 * Unlike `fetchFromIpfs`, this does not attempt JSON parsing — it returns
 * the raw `Uint8Array` from the gateway response. Use for source files
 * (`.ts`, `.js`, `text/plain`, etc.) that are not JSON documents.
 */
export async function fetchRawBytesFromIpfs(
  gatewayUrl: string,
  cid: string,
  opts?: FetchFromIpfsOptions,
): Promise<Uint8Array> {
  const gateways = resolveMechIpfsGateways(gatewayUrl, opts);
  const candidates = buildIpfsFetchCidPathCandidates(cid);
  const errors: string[] = [];
  for (const cidPath of candidates) {
    for (const [name, baseUrl] of gateways) {
      const url = `${baseUrl}${cidPath}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IPFS_FETCH_TIMEOUT_MS);
      try {
        return await fetchRawBytesFromUrl(url, controller.signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${name}:${url.slice(0, 100)}: ${message}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw new Error(`IPFS raw bytes fetch failed after all candidates: ${errors.join(' | ')}`);
}

/**
 * Fetch a text file from IPFS by CID.
 *
 * Fetches raw bytes via `fetchRawBytesFromIpfs` and decodes them as UTF-8.
 * Use for source files (`.ts`, `.js`, `text/plain`, etc.) that are not JSON.
 */
export async function fetchTextFromIpfs(
  gatewayUrl: string,
  cid: string,
  opts?: FetchFromIpfsOptions,
): Promise<string> {
  const bytes = await fetchRawBytesFromIpfs(gatewayUrl, cid, opts);
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Fetch a source bundle from IPFS by CID.
 *
 * V1 acceptable impl: the bundle root is a JSON manifest listing files by
 * relative path and CID. We fetch the manifest as JSON, then fetch each
 * listed source file as raw bytes (decoded to UTF-8 via TextDecoder).
 * Source files are typically `.ts` / `.js` / `text/plain` — not JSON —
 * so they must NOT be fetched through the JSON-only `fetchFromIpfs` path.
 *
 * Format: `{ files: Array<{ path: string; cid: string }> }`
 */
export async function fetchSourceBundleFromIpfs(
  gatewayUrl: string,
  bundleCid: string,
  opts?: FetchFromIpfsOptions,
): Promise<{ files: Map<string, string>; manifest?: Record<string, unknown> }> {
  // Manifest is a JSON document — JSON fetch is correct here.
  const manifest = await fetchFromIpfs(gatewayUrl, bundleCid, opts) as Record<string, unknown>;
  const fileEntries = manifest['files'] as Array<{ path: string; cid: string }> | undefined;

  const files = new Map<string, string>();
  if (Array.isArray(fileEntries)) {
    await Promise.all(
      fileEntries.map(async ({ path, cid }) => {
        // Source files are raw text, not JSON — use fetchTextFromIpfs.
        const content = await fetchTextFromIpfs(gatewayUrl, cid, opts);
        files.set(path, content);
      }),
    );
  }

  return { files, manifest };
}

// ── Base encoding helpers ────────────────────────────────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(str: string): Uint8Array {
  const bytes: number[] = [0];
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base58 character: ${char}`);
    let carry = idx;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of str) {
    if (char !== '1') break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function base32Decode(str: string): Uint8Array {
  const input = str.toLowerCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of input) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}
