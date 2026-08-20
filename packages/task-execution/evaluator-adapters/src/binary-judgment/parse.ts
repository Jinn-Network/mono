// SPDX-License-Identifier: Apache-2.0

/**
 * Pure implementations of the five closed response-parser contracts sealed under the
 * `network.jinn.parser.binary-*` identities (profiles `binary-judgment/contracts.ts`). There is
 * deliberately no locale, Unicode normalization, regular-expression whitespace class, model
 * call, or clock anywhere in this file.
 */
import {
  BINARY_ACCEPT_REJECT_PARSER_ID,
  BINARY_CORRECT_WRONG_PARSER_ID,
  BINARY_JSON_VERDICT_PARSER_ID,
  BINARY_LABEL_IN_PROSE_PARSER_ID,
  BINARY_YES_NO_PARSER_ID,
  type BinaryJudgmentResponseParserId,
} from "@jinn-network/task-execution-profiles";

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

function invalidUtf8(): BinaryJudgmentResponseParse {
  return { decision: "REJECT", parseValid: false, invalidReason: "invalid-utf8" };
}

function unexpectedToken(): BinaryJudgmentResponseParse {
  return { decision: "REJECT", parseValid: false, invalidReason: "unexpected-token" };
}

function decodeStrictUtf8(bytes: Uint8Array): string | undefined {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * PC-1/PC-2/PC-3 share this discipline over a two-token alphabet: edge-trim, then require the
 * entire remaining text to equal one of the two tokens exactly, case-sensitively.
 */
function parseWholeOutputToken(
  bytes: Uint8Array,
  acceptToken: string,
  rejectToken: string,
): BinaryJudgmentResponseParse {
  const decoded = decodeStrictUtf8(bytes);
  if (decoded === undefined) return invalidUtf8();
  const token = trimBinaryJudgmentResponseEdges(decoded);
  if (token === acceptToken) return { decision: "ACCEPT", parseValid: true };
  if (token === rejectToken) return { decision: "REJECT", parseValid: true };
  return unexpectedToken();
}

/** PC-1 `network.jinn.parser.binary-accept-reject@1.0.0`: exactly ACCEPT or REJECT. */
export function parseBinaryJudgmentResponse(bytes: Uint8Array): BinaryJudgmentResponseParse {
  return parseWholeOutputToken(bytes, "ACCEPT", "REJECT");
}

/** PC-2 `network.jinn.parser.binary-yes-no@1.0.0`: exactly YES or NO. */
export function parseBinaryYesNoResponse(bytes: Uint8Array): BinaryJudgmentResponseParse {
  return parseWholeOutputToken(bytes, "YES", "NO");
}

/** PC-3 `network.jinn.parser.binary-correct-wrong@1.0.0`: exactly CORRECT or WRONG. */
export function parseBinaryCorrectWrongResponse(bytes: Uint8Array): BinaryJudgmentResponseParse {
  return parseWholeOutputToken(bytes, "CORRECT", "WRONG");
}

function decodeJsonStringLiteral(literal: string): string {
  return JSON.parse(literal) as string;
}

/**
 * Scans JSON text already confirmed to parse as a single object-rooted JSON value, and returns
 * the member names declared directly on the root object, in source order, including duplicates.
 * `JSON.parse` itself cannot answer "was this root key written twice": it silently collapses a
 * duplicate key to its last value. Depth is tracked independently so a member name that happens
 * to share a name with the root's own member (nested inside a member's own object or array
 * value) is never mistaken for a second root-level occurrence.
 */
function rootObjectMemberNames(text: string): readonly string[] {
  const names: string[] = [];
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const ch = text[index]!;
    if (ch === '"') {
      const start = index;
      index += 1;
      while (index < text.length) {
        const inner = text[index]!;
        if (inner === "\\") {
          index += 2;
          continue;
        }
        if (inner === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      if (depth === 1) {
        let lookahead = index;
        while (lookahead < text.length && isAsciiEdgeWhitespace(text.charCodeAt(lookahead))) {
          lookahead += 1;
        }
        if (text[lookahead] === ":") {
          names.push(decodeJsonStringLiteral(text.slice(start, index)));
        }
      }
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      index += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth -= 1;
      index += 1;
      continue;
    }
    index += 1;
  }
  return names;
}

/**
 * PC-4 `network.jinn.parser.binary-json-verdict@1.0.0`: edge-trim, then require the remainder to
 * parse as a single strict RFC 8259 object whose `verdict` string member (edge-trimmed the same
 * way) is exactly ACCEPT or REJECT. `JSON.parse` alone is the strict-JSON gate (it already
 * refuses trailing content, comments, `NaN`, and `Infinity`); the duplicate-member check needs
 * its own raw-text scan because `JSON.parse` cannot see a duplicate key.
 */
export function parseBinaryJsonVerdictResponse(bytes: Uint8Array): BinaryJudgmentResponseParse {
  const decoded = decodeStrictUtf8(bytes);
  if (decoded === undefined) return invalidUtf8();
  const trimmed = trimBinaryJudgmentResponseEdges(decoded);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return unexpectedToken();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return unexpectedToken();
  }
  const verdictOccurrences = rootObjectMemberNames(trimmed)
    .filter((name) => name === "verdict").length;
  if (verdictOccurrences !== 1) return unexpectedToken();
  const value = (parsed as Record<string, unknown>)["verdict"];
  if (typeof value !== "string") return unexpectedToken();
  const token = trimBinaryJudgmentResponseEdges(value);
  if (token === "ACCEPT") return { decision: "ACCEPT", parseValid: true };
  if (token === "REJECT") return { decision: "REJECT", parseValid: true };
  return unexpectedToken();
}

function isAsciiWordCharCode(codeUnit: number): boolean {
  return (codeUnit >= 0x41 && codeUnit <= 0x5a) // A-Z
    || (codeUnit >= 0x61 && codeUnit <= 0x7a) // a-z
    || (codeUnit >= 0x30 && codeUnit <= 0x39) // 0-9
    || codeUnit === 0x5f; // _
}

/**
 * True when `token` occurs in `text` at least once with both neighbouring code units (where one
 * exists) not an ASCII letter, ASCII digit, or `_`. Scans every occurrence, advancing by one
 * code unit past each hit, so an undelimited hit never masks a later delimited one.
 */
function hasDelimitedTokenOccurrence(text: string, token: string): boolean {
  let index = text.indexOf(token);
  while (index !== -1) {
    const beforeDelimited = index === 0 || !isAsciiWordCharCode(text.charCodeAt(index - 1));
    const afterIndex = index + token.length;
    const afterDelimited = afterIndex >= text.length
      || !isAsciiWordCharCode(text.charCodeAt(afterIndex));
    if (beforeDelimited && afterDelimited) return true;
    index = text.indexOf(token, index + 1);
  }
  return false;
}

/**
 * PC-5 `network.jinn.parser.binary-label-in-prose@1.0.0`: no trim. Scans for delimited
 * occurrences of ACCEPT and REJECT; exactly one of the two present (any number of times, no
 * positional preference) decides, both or neither is invalid.
 */
export function parseBinaryLabelInProseResponse(bytes: Uint8Array): BinaryJudgmentResponseParse {
  const decoded = decodeStrictUtf8(bytes);
  if (decoded === undefined) return invalidUtf8();
  const acceptFound = hasDelimitedTokenOccurrence(decoded, "ACCEPT");
  const rejectFound = hasDelimitedTokenOccurrence(decoded, "REJECT");
  if (acceptFound === rejectFound) return unexpectedToken();
  return { decision: acceptFound ? "ACCEPT" : "REJECT", parseValid: true };
}

/**
 * The complete v1 response-parser implementation registry, keyed by the profiles-owned closed id
 * union so TypeScript enforces exhaustiveness against the registered set (profiles
 * `BINARY_JUDGMENT_RESPONSE_PARSER_REGISTRY`).
 */
export const BINARY_JUDGMENT_RESPONSE_PARSERS: Record<
  BinaryJudgmentResponseParserId,
  (bytes: Uint8Array) => BinaryJudgmentResponseParse
> = {
  [BINARY_ACCEPT_REJECT_PARSER_ID]: parseBinaryJudgmentResponse,
  [BINARY_CORRECT_WRONG_PARSER_ID]: parseBinaryCorrectWrongResponse,
  [BINARY_JSON_VERDICT_PARSER_ID]: parseBinaryJsonVerdictResponse,
  [BINARY_LABEL_IN_PROSE_PARSER_ID]: parseBinaryLabelInProseResponse,
  [BINARY_YES_NO_PARSER_ID]: parseBinaryYesNoResponse,
};

/**
 * The instrument's `response.parser.id` selects one registered response parser; this function
 * never supplies parser configuration itself (spec §4.1 rule 4).
 */
export function selectBinaryJudgmentResponseParser(
  id: BinaryJudgmentResponseParserId,
): (bytes: Uint8Array) => BinaryJudgmentResponseParse {
  return BINARY_JUDGMENT_RESPONSE_PARSERS[id];
}
