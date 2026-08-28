// SPDX-License-Identifier: Apache-2.0

/**
 * Pure implementations of the closed response-parser contracts sealed under the
 * `network.jinn.parser.binary-*` identities (profiles `binary-judgment/contracts.ts`). There is
 * deliberately no locale-sensitive API, Unicode normalization, model call, or clock anywhere
 * in this file. The two source-derived extractors retain their published `\s` regular-expression
 * behavior as part of their sealed contracts.
 */
import {
  BINARY_ACCEPT_REJECT_PARSER_ID,
  BINARY_COMPLETE_JSON_LABEL_PARSER_ID,
  BINARY_COMPLETE_JSON_LABEL_PARSER_V2_VERSION,
  BINARY_CORRECT_WRONG_PARSER_ID,
  BINARY_EVERMEM_JSON_LABEL_PARSER_ID,
  BINARY_EVERMEM_JSON_LABEL_PARSER_V2_VERSION,
  BINARY_JSON_VERDICT_PARSER_ID,
  BINARY_LABEL_IN_PROSE_PARSER_ID,
  BINARY_MEM0_JSON_LABEL_PARSER_ID,
  BINARY_MEM0_JSON_LABEL_PARSER_V2_VERSION,
  BINARY_STRICT_JSON_LABEL_PARSER_ID,
  BINARY_STRICT_JSON_LABEL_PARSER_V2_VERSION,
  BINARY_YES_NO_PARSER_ID,
  type BinaryJudgmentResponseParserId,
} from "@jinn-network/task-execution-profiles";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type BinaryJudgmentDecision = "ACCEPT" | "REJECT" | "INVALID";

export interface BinaryJudgmentResponseParse {
  /** V1 parsers map invalid output to REJECT; neutral v2 parsers return INVALID. */
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

function neutralInvalid(parse: BinaryJudgmentResponseParse): BinaryJudgmentResponseParse {
  return parse.parseValid ? parse : { ...parse, decision: "INVALID" };
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

function parseObjectRoot(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
}

/**
 * Accept either a complete bare JSON response or one exact outer Markdown fence. The fence must
 * be untyped or lowercase `json`, occupy its own opening and closing lines, and be the entire
 * edge-trimmed response. Surrounding prose and multiple outer fences are therefore refused.
 */
function extractExactOptionalJsonFence(text: string): string | undefined {
  const trimmed = trimBinaryJudgmentResponseEdges(text);
  if (!trimmed.startsWith("```")) return trimmed;
  const match = /^```(?:json)?\r?\n([\s\S]*)\r?\n```$/u.exec(trimmed);
  return match?.[1];
}

function labelDecision(accepted: boolean): BinaryJudgmentResponseParse {
  return { decision: accepted ? "ACCEPT" : "REJECT", parseValid: true };
}

/** Backboard/revised-family complete-JSON parser. */
export function parseBinaryCompleteJsonLabelResponse(
  bytes: Uint8Array,
): BinaryJudgmentResponseParse {
  const decoded = decodeStrictUtf8(bytes);
  if (decoded === undefined) return invalidUtf8();
  const parsed = parseObjectRoot(decoded);
  if (parsed === undefined) return unexpectedToken();
  const label = Object.hasOwn(parsed, "label") ? parsed["label"] : "WRONG";
  if (typeof label !== "string") return unexpectedToken();
  return labelDecision(label.toUpperCase() === "CORRECT");
}

function extractEvermemJson(text: string): string {
  const fenced = /```(?:json)?\s*(\{[^`]*\})\s*```/s.exec(text);
  if (fenced?.[1] !== undefined) return fenced[1];
  const flat = /\{[^{}]*"label"\s*:\s*"[^"]*"[^{}]*\}/s.exec(text);
  return flat?.[0] ?? text.trim();
}

/** EverMemOS-family fenced/flat/complete JSON extraction and label comparison. */
export function parseBinaryEvermemJsonLabelResponse(
  bytes: Uint8Array,
): BinaryJudgmentResponseParse {
  const decoded = decodeStrictUtf8(bytes);
  if (decoded === undefined) return invalidUtf8();
  const parsed = parseObjectRoot(extractEvermemJson(decoded));
  if (parsed === undefined) return unexpectedToken();
  const label = parsed["label"];
  if (typeof label !== "string" || label.length === 0) return unexpectedToken();
  return labelDecision(label.trim().toUpperCase() === "CORRECT");
}

function extractMem0Json(text: string): string {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*(.*?)\s*```/s.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

/** Mem0 extract_json behavior and exact label comparison. */
export function parseBinaryMem0JsonLabelResponse(
  bytes: Uint8Array,
): BinaryJudgmentResponseParse {
  const decoded = decodeStrictUtf8(bytes);
  if (decoded === undefined) return invalidUtf8();
  const parsed = parseObjectRoot(extractMem0Json(decoded));
  if (parsed === undefined || !Object.hasOwn(parsed, "label")) return unexpectedToken();
  return labelDecision(parsed["label"] === "CORRECT");
}

/** Project-declared strict-dial complete JSON contract. */
export function parseBinaryStrictJsonLabelResponse(
  bytes: Uint8Array,
): BinaryJudgmentResponseParse {
  const decoded = decodeStrictUtf8(bytes);
  if (decoded === undefined) return invalidUtf8();
  const parsed = parseObjectRoot(decoded);
  if (parsed === undefined) return unexpectedToken();
  const memberNames = rootObjectMemberNames(decoded);
  if (
    memberNames.length !== 2
    || memberNames.filter((name) => name === "label").length !== 1
    || memberNames.filter((name) => name === "reasoning").length !== 1
  ) return unexpectedToken();
  if (typeof parsed["label"] !== "string" || typeof parsed["reasoning"] !== "string") {
    return unexpectedToken();
  }
  if (parsed["label"] === "CORRECT") return labelDecision(true);
  if (parsed["label"] === "WRONG") return labelDecision(false);
  return unexpectedToken();
}

function parseBinaryCompleteJsonLabelV2Response(
  bytes: Uint8Array,
): BinaryJudgmentResponseParse {
  const decoded = decodeStrictUtf8(bytes);
  if (decoded === undefined) return neutralInvalid(invalidUtf8());
  const extracted = extractExactOptionalJsonFence(decoded);
  if (extracted === undefined) return neutralInvalid(unexpectedToken());
  return neutralInvalid(parseBinaryCompleteJsonLabelResponse(new TextEncoder().encode(extracted)));
}

function parseBinaryEvermemJsonLabelV2Response(
  bytes: Uint8Array,
): BinaryJudgmentResponseParse {
  const decoded = decodeStrictUtf8(bytes);
  if (decoded === undefined) return neutralInvalid(invalidUtf8());
  const extracted = extractExactOptionalJsonFence(decoded);
  if (extracted === undefined) return neutralInvalid(unexpectedToken());
  const parsed = parseObjectRoot(extracted);
  if (parsed === undefined) return neutralInvalid(unexpectedToken());
  const label = parsed["label"];
  if (typeof label !== "string" || label.length === 0) return neutralInvalid(unexpectedToken());
  return labelDecision(label.trim().toUpperCase() === "CORRECT");
}

function parseBinaryMem0JsonLabelV2Response(
  bytes: Uint8Array,
): BinaryJudgmentResponseParse {
  const decoded = decodeStrictUtf8(bytes);
  if (decoded === undefined) return neutralInvalid(invalidUtf8());
  const extracted = extractExactOptionalJsonFence(decoded);
  if (extracted === undefined) return neutralInvalid(unexpectedToken());
  const parsed = parseObjectRoot(extracted);
  if (parsed === undefined || !Object.hasOwn(parsed, "label")) {
    return neutralInvalid(unexpectedToken());
  }
  return labelDecision(parsed["label"] === "CORRECT");
}

function parseBinaryStrictJsonLabelV2Response(
  bytes: Uint8Array,
): BinaryJudgmentResponseParse {
  const decoded = decodeStrictUtf8(bytes);
  if (decoded === undefined) return neutralInvalid(invalidUtf8());
  const extracted = extractExactOptionalJsonFence(decoded);
  if (extracted === undefined) return neutralInvalid(unexpectedToken());
  return neutralInvalid(parseBinaryStrictJsonLabelResponse(new TextEncoder().encode(extracted)));
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
  [BINARY_COMPLETE_JSON_LABEL_PARSER_ID]: parseBinaryCompleteJsonLabelResponse,
  [BINARY_CORRECT_WRONG_PARSER_ID]: parseBinaryCorrectWrongResponse,
  [BINARY_EVERMEM_JSON_LABEL_PARSER_ID]: parseBinaryEvermemJsonLabelResponse,
  [BINARY_JSON_VERDICT_PARSER_ID]: parseBinaryJsonVerdictResponse,
  [BINARY_LABEL_IN_PROSE_PARSER_ID]: parseBinaryLabelInProseResponse,
  [BINARY_MEM0_JSON_LABEL_PARSER_ID]: parseBinaryMem0JsonLabelResponse,
  [BINARY_STRICT_JSON_LABEL_PARSER_ID]: parseBinaryStrictJsonLabelResponse,
  [BINARY_YES_NO_PARSER_ID]: parseBinaryYesNoResponse,
};

const BINARY_JUDGMENT_NEUTRAL_RESPONSE_PARSERS = new Map<string, (
  bytes: Uint8Array,
) => BinaryJudgmentResponseParse>([
  [`${BINARY_COMPLETE_JSON_LABEL_PARSER_ID}@${BINARY_COMPLETE_JSON_LABEL_PARSER_V2_VERSION}`, parseBinaryCompleteJsonLabelV2Response],
  [`${BINARY_EVERMEM_JSON_LABEL_PARSER_ID}@${BINARY_EVERMEM_JSON_LABEL_PARSER_V2_VERSION}`, parseBinaryEvermemJsonLabelV2Response],
  [`${BINARY_MEM0_JSON_LABEL_PARSER_ID}@${BINARY_MEM0_JSON_LABEL_PARSER_V2_VERSION}`, parseBinaryMem0JsonLabelV2Response],
  [`${BINARY_STRICT_JSON_LABEL_PARSER_ID}@${BINARY_STRICT_JSON_LABEL_PARSER_V2_VERSION}`, parseBinaryStrictJsonLabelV2Response],
]);

/**
 * The instrument's `response.parser.id` selects one registered response parser; this function
 * never supplies parser configuration itself (spec §4.1 rule 4).
 */
export function selectBinaryJudgmentResponseParser(
  id: BinaryJudgmentResponseParserId,
  version = "1.0.0",
): (bytes: Uint8Array) => BinaryJudgmentResponseParse {
  const neutral = BINARY_JUDGMENT_NEUTRAL_RESPONSE_PARSERS.get(`${id}@${version}`);
  if (neutral !== undefined) return neutral;
  if (version === "1.0.0") return BINARY_JUDGMENT_RESPONSE_PARSERS[id];
  throw new TypeError(`unsupported binary judgment response parser ${id}@${version}`);
}
