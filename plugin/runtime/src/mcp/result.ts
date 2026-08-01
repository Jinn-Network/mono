// SPDX-License-Identifier: Apache-2.0

import { fenceRecord, sanitizeUntrustedText } from "./untrusted.js";

export interface ToolResponse extends Record<string, unknown> {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
}

export interface ToolFailure {
  /** Stable machine code; the adapter and the model both branch on it. */
  readonly code: string;
  readonly detail: string;
  /** True when the same call may succeed shortly: lock contention, timeout. */
  readonly retryable: boolean;
}

const MAX_DETAIL_CHARS = 512;

function text(value: string): ToolResponse {
  return { content: [{ type: "text", text: value }] };
}

/** A structured, machine-readable answer. Never carries unfenced record text. */
export function toolJson(value: unknown): ToolResponse {
  return text(JSON.stringify(value));
}

/** An answer that carries record-derived content, behind C6's provenance boundary. */
export function toolFenced(
  heading: string,
  provenance: readonly string[],
  body: string,
): ToolResponse {
  return text(fenceRecord(heading, provenance, body));
}

/** A refusal. `isError` is the MCP-level signal; `code` is the product-level one. */
export function toolFailure(failure: ToolFailure): ToolResponse {
  return {
    ...toolJson({
      error: {
        code: failure.code,
        detail: sanitizeUntrustedText(failure.detail, MAX_DETAIL_CHARS).text,
        retryable: failure.retryable,
      },
    }),
    isError: true,
  };
}
