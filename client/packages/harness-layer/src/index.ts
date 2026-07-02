/**
 * @jinn-network/harness-layer — embeddable harness-layer surface.
 *
 * v0 exposes the corpus consume path (search/get), the frozen layer-1 trace
 * envelope schema, the capture path (scrub + preview), and the publish path
 * (consent conversion + anchor + contribution ledger).
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
  capture,
  parseCapturedTask,
  CapturedTaskSchema,
  CaptureScrubError,
  PENDING_ENVELOPE_KIND,
  type CapturedTask,
  type CaptureOptions,
  type PendingEnvelope,
  type ScrubRedaction,
} from './capture.js';

export {
  preview,
  stripBeforeValues,
  type ScrubReport,
} from './preview.js';

export {
  publish,
  toTraceEnvelope,
  TRACE_ENVELOPE_ARTIFACT_TYPE,
  type HarnessPublishDeps,
  type PublishOptions,
  type PublishResult,
} from './publish.js';

export {
  createLivePublishDeps,
  DEFAULT_TESTNET_IDENTITY_REGISTRY,
  DEFAULT_TESTNET_RPC_URL,
  type LivePublishConfig,
} from './publish-live.js';

export {
  createFileLedger,
  createMemoryLedger,
  ledger,
  LedgerEntrySchema,
  DEFAULT_LEDGER_PATH,
  type LedgerEntry,
  type LedgerStore,
} from './ledger.js';

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
