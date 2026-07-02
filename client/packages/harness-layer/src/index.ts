/**
 * @jinn-network/harness-layer — embeddable harness-layer surface.
 *
 * v0 exposes the corpus consume path (search/get) and the frozen layer-1
 * trace envelope schema. Capture / publish paths are later plan tasks.
 */

export {
  createHarnessLayer,
  DEFAULT_IPFS_GATEWAY_URL,
  type HarnessLayer,
  type HarnessLayerConfig,
  type ResolvedHarnessLayerConfig,
  type CorpusSearchHit,
  type CorpusRecord,
  type CorpusArtifact,
} from './consume.js';

export {
  TraceEnvelopeV0Schema,
  TraceStepSchema,
  VerifiabilityTierSchema,
  OutcomeStatusSchema,
  parseTraceEnvelopeV0,
  TRACE_ENVELOPE_SCHEMA_VERSION,
  MAX_STEPS,
  MAX_STEP_ATTRIBUTES_BYTES,
  MAX_DISTRIBUTION_TAGS,
  VERIFIABILITY_TIERS,
  type TraceEnvelopeV0,
  type TraceStep,
  type VerifiabilityTier,
  type OutcomeStatus,
} from './envelope.js';
