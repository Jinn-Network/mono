// SPDX-License-Identifier: Apache-2.0

import { createClaudeCodeStreamJsonDecoder } from "./claude-code-stream-json.js";
import type { TraceDecoder } from "./contract.js";
import { createDecoderRegistry } from "./registry.js";
import type { DecoderRegistry } from "./registry.js";

/**
 * Every decoder this package ships. One today; a format with no decoder is a known
 * absence, reported as `unsupported-format`, not a silent one.
 */
export const SHIPPED_DECODERS: readonly TraceDecoder[] = Object.freeze([
  createClaudeCodeStreamJsonDecoder(),
]);

/** The registry most consumers want: pure, cheap, and safe to hold for a process lifetime. */
export function createDefaultDecoderRegistry(): DecoderRegistry {
  return createDecoderRegistry(SHIPPED_DECODERS);
}
