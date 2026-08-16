/**
 * trajectory/index.ts — re-exports for consumers.
 *
 * Import path: '../../trajectory/index.js' (or '../trajectory/index.js' etc.)
 * from any file within operator/src/.
 */

// Collector + input type
export { TrajectoryCollector } from './collector.js';
export type { CollectorInit, SpanInput } from './collector.js';

// Emitter
export { emitTrajectory } from './emit.js';
export type { EmitTrajectoryParams, EmitTrajectoryResult } from './emit.js';

// Hash chain helpers
export { computeGenesisHash, computePrevSpanHash } from './hash-chain.js';

// Schema types + validators
export {
  JinnSpanKindSchema,
  SpanSchema,
  RedactionManifestSchema,
  JinnTrajectoryV1Schema,
  UnsignedTrajectorySchema,
  CaptureManifestSchema,
  EMPTY_BUNDLE_SHA256,
} from './schema.js';
export type {
  JinnSpanKind,
  Span,
  RedactionManifest,
  JinnTrajectoryV1,
  UnsignedTrajectory,
  CaptureManifest,
} from './schema.js';

// Harness bundle manifest (artifact-type harness-bundle.v1)
export {
  HarnessBundleManifestSchema,
  HARNESS_BUNDLE_ARTIFACT_TYPE,
} from './harness-bundle-schema.js';
export type { HarnessBundleManifest } from './harness-bundle-schema.js';

// Secret scrub helpers
export {
  SECRET_NAME_PATTERNS,
  isSecretKey,
  scrubAttributes,
  scrubMcpArgs,
} from './secret-scrub.js';

// Span profile checker
export {
  SPAN_PROFILE,
  validateSpanProfile,
  findFirstProfileViolation,
} from './span-profile.js';
export type { SpanProfileResult } from './span-profile.js';

// Traced I/O wrappers
export { tracedHttpCall } from './wrappers/http.js';
export type {
  HttpRequestLike,
  HttpResponseLike,
  GenAiAttrs,
  TracedHttpCallParams,
} from './wrappers/http.js';

export { tracedMcpCall } from './wrappers/mcp.js';
export type { TracedMcpCallParams } from './wrappers/mcp.js';

export { tracedSpawn } from './wrappers/subprocess.js';
export type { TracedSpawnParams, TracedSpawnResult } from './wrappers/subprocess.js';

// Path C LLM API proxy
export { createLlmProxyApp, startLlmProxyServer } from './llm-proxy.js';
export type { LlmProxyConfig, LlmProxyServer } from './llm-proxy.js';
export { exchangeToSpanAttributes, emitLlmProxyExchange } from './llm-proxy-spans.js';
export type { LlmProxyExchange, LlmProxyProvider } from './llm-proxy-spans.js';

// Transcript-to-spans (DR-2026-07-14, #1473)
export { getTranscriptSpanParser } from './transcript-to-spans/index.js';
export type { TranscriptSpanParser, TranscriptSpanParserResolution } from './transcript-to-spans/types.js';
