// SPDX-License-Identifier: Apache-2.0

/**
 * Pure implementation of the response-parser semantics sealed by
 * `BINARY_ACCEPT_REJECT_PARSER_IDENTITY`. There is deliberately no locale, Unicode
 * normalization, regular-expression whitespace class, model call, or clock in this parser.
 */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type BinaryJudgmentDecision = "ACCEPT" | "REJECT";

export interface BinaryJudgmentResponseParse {
  /** Invalid delivered output deterministically maps to REJECT. */
  readonly decision: BinaryJudgmentDecision;
  /** Distinguishes an actual REJECT token from the invalid-output fallback. */
  readonly parseValid: boolean;
  readonly invalidReason?: "invalid-utf8" | "unexpected-token";
}

function isAsciiEdgeWhitespace(codeUnit: number): boolean {
  return codeUnit === 0x20 || codeUnit === 0x09 || codeUnit === 0x0d || codeUnit === 0x0a;
}

/** Trims only U+0020, U+0009, U+000D, and U+000A at the two edges. */
export function trimBinaryJudgmentResponseEdges(value: string): string {
  let start = 0;
  while (start < value.length && isAsciiEdgeWhitespace(value.charCodeAt(start))) start += 1;
  let end = value.length;
  while (end > start && isAsciiEdgeWhitespace(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

/**
 * Parses exact response bytes. A delivered malformed response is scientific output, not an
 * operational failure: it is scored as REJECT while preserving `parseValid=false`.
 */
export function parseBinaryJudgmentResponse(
  bytes: Uint8Array,
): BinaryJudgmentResponseParse {
  let decoded: string;
  try {
    decoded = decoder.decode(bytes);
  } catch {
    return { decision: "REJECT", parseValid: false, invalidReason: "invalid-utf8" };
  }
  const token = trimBinaryJudgmentResponseEdges(decoded);
  if (token === "ACCEPT" || token === "REJECT") {
    return { decision: token, parseValid: true };
  }
  return { decision: "REJECT", parseValid: false, invalidReason: "unexpected-token" };
}
