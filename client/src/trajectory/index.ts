/**
 * trajectory/index.ts — re-exports for consumers.
 *
 * Import path: '../../trajectory/index.js' (or '../trajectory/index.js' etc.)
 * from any file within client/src/.
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
} from './schema.js';
export type {
  JinnSpanKind,
  Span,
  RedactionManifest,
  JinnTrajectoryV1,
  UnsignedTrajectory,
} from './schema.js';

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
