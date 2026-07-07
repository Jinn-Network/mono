/**
 * Client-side corpus-trace fetch (spec §2.4).
 *
 * The indexer stores only tool *names* + a step count; the full scrubbed
 * per-step payloads live in the IPFS trace artifact, never indexed. To show an
 * attempt "in full" the detail view fetches them in the browser:
 *
 *   1. fetch the manifest at ipfs/<cid>
 *   2. find its public trace artifact source (kind: 'ipfs') and fetch it
 *   3. base64-decode the donation artifact's `data` → the trace envelope JSON
 *   4. project each step to { name, args, result, redactedKeyCount }
 *
 * All rendering downstream is React text (auto-escaped) — the payloads are
 * scrubbed but still attacker-influenceable, so nothing here is ever treated
 * as HTML. A byte cap bounds a hostile/huge artifact; any failure (no public
 * source, gateway down, malformed JSON) surfaces as an error the caller falls
 * back on (the indexed tool-name list stays as the degraded view).
 */

import { useQuery } from '@tanstack/react-query';
import { ipfsUrl } from './format';

/** Reject artifacts larger than this (bytes) before parsing — DoS bound. */
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

export interface TraceStep {
  /** Span/tool name, e.g. "tool:terminal". */
  name: string;
  /** Scrubbed tool arguments (arbitrary shape), or null. */
  args: unknown;
  /** Scrubbed tool result, always a string for display. */
  result: string;
  /** How many keys the scrubber redacted on this step. */
  redactedKeyCount: number;
}

export interface CorpusTrace {
  steps: TraceStep[];
  model: string;
  harness: string;
}

// ── pure helpers (unit-testable, no network) ───────────────────────────────────

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null;
}

/** Find the first public IPFS trace-artifact source CID in a manifest. */
export function findTraceSourceCid(manifest: unknown): string | null {
  if (!isObj(manifest) || !Array.isArray(manifest.artifacts)) return null;
  // Prefer an artifact whose type names a trace envelope; fall back to any
  // artifact with a public ipfs source.
  const artifacts = manifest.artifacts.filter(isObj);
  const ordered = [
    ...artifacts.filter((a) => String(a.artifactType ?? '').includes('trace')),
    ...artifacts.filter((a) => !String(a.artifactType ?? '').includes('trace')),
  ];
  for (const artifact of ordered) {
    const sources = Array.isArray(artifact.sources) ? artifact.sources : [];
    for (const src of sources) {
      if (isObj(src) && src.kind === 'ipfs' && typeof src.cid === 'string' && src.cid) {
        return src.cid;
      }
    }
  }
  return null;
}

/** UTF-8-safe base64 decode (the donation `data` is base64 of a UTF-8 JSON). */
function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Decode a donation artifact ({ data: base64(json) }) to its inner trace JSON. */
export function decodeDonationArtifact(artifact: unknown): unknown {
  if (!isObj(artifact) || typeof artifact.data !== 'string') {
    throw new Error('trace artifact has no base64 `data` field');
  }
  return JSON.parse(decodeBase64Utf8(artifact.data));
}

/** Project the decoded trace envelope to the display shape. */
export function parseTraceEnvelope(inner: unknown): CorpusTrace {
  const steps: TraceStep[] = [];
  if (isObj(inner) && Array.isArray(inner.steps)) {
    for (const raw of inner.steps) {
      if (!isObj(raw)) continue;
      const attrs = isObj(raw.attributes) ? raw.attributes : {};
      const rawResult = attrs['tool.result'];
      const result =
        typeof rawResult === 'string'
          ? rawResult
          : rawResult == null
            ? ''
            : JSON.stringify(rawResult, null, 2);
      steps.push({
        name: typeof raw.name === 'string' ? raw.name : 'step',
        args: 'tool.args' in attrs ? attrs['tool.args'] : null,
        result,
        redactedKeyCount: Array.isArray(raw.redactedKeys) ? raw.redactedKeys.length : 0,
      });
    }
  }
  const env = isObj(inner) && isObj(inner.environment) ? inner.environment : {};
  const harness = isObj(env.harness) && typeof env.harness.name === 'string' ? env.harness.name : '';
  return {
    steps,
    model: typeof env.model === 'string' ? env.model : '',
    harness,
  };
}

// ── fetch ───────────────────────────────────────────────────────────────────

async function fetchGatewayJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`gateway ${res.status}`);
  // Reject an oversized artifact up front when the gateway declares its size,
  // before buffering the whole body into memory. The post-read length check
  // stays as a floor for gateways that omit content-length (text.length is
  // UTF-16 code units — a soft byte bound, but bounded).
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ARTIFACT_BYTES) {
    throw new Error('artifact too large to render');
  }
  const text = await res.text();
  if (text.length > MAX_ARTIFACT_BYTES) throw new Error('artifact too large to render');
  return JSON.parse(text);
}

export function useCorpusTrace(cid: string) {
  return useQuery({
    queryKey: ['corpus-trace', cid],
    enabled: Boolean(cid),
    // Immutable content-addressed data; a miss is terminal (no public source).
    retry: false,
    staleTime: Infinity,
    queryFn: async (): Promise<CorpusTrace> => {
      const manifestUrl = ipfsUrl(cid);
      if (!manifestUrl) throw new Error('no cid');
      const manifest = await fetchGatewayJson(manifestUrl);
      const sourceCid = findTraceSourceCid(manifest);
      if (!sourceCid) throw new Error('no public trace source in manifest');
      const artifactUrl = ipfsUrl(sourceCid);
      if (!artifactUrl) throw new Error('bad trace source cid');
      const artifact = await fetchGatewayJson(artifactUrl);
      return parseTraceEnvelope(decodeDonationArtifact(artifact));
    },
  });
}
