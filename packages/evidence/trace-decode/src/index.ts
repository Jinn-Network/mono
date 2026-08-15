// SPDX-License-Identifier: Apache-2.0

// Format identity
export {
  FORMAT_IDENTITIES,
  FORMAT_IRI_PATTERN,
  formatIdentity,
  formatIriForEnvelopeFormat,
  formatIriForLegacySourceFormat,
} from "./formats.js";
export type { FormatIdentity } from "./formats.js";

// The decoder contract
export {
  ADMITTED_ATTRIBUTE_KEYS,
  DECODE_FAILURE_REASONS,
  DecoderContractError,
  SourceDigestMismatchError,
  TIMEBASES,
  UnsupportedFormatError,
  sortAttributes,
} from "./contract.js";
export type {
  Completeness,
  DecodeFailureReason,
  DecodeResult,
  SpanDraft,
  Timebase,
  TraceDecoder,
  TraceDecoderFixture,
} from "./contract.js";

// Registries
export { createDecoderRegistry } from "./registry.js";
export type { DecoderRegistry } from "./registry.js";
export { SHIPPED_DECODERS, createDefaultDecoderRegistry } from "./default-registry.js";

// Decoding
export { decodeTrace, finalizeSpans, tryDecodeTrace } from "./decode.js";
export type {
  DecodeOutcome,
  DecodeTraceInput,
  DigestBearingDescriptor,
  TraceDocument,
} from "./decode.js";

// Decoders
export {
  CLAUDE_CODE_STREAM_JSON_FORMAT_IRI,
  createClaudeCodeStreamJsonDecoder,
} from "./claude-code-stream-json.js";
