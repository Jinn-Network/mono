// SPDX-License-Identifier: Apache-2.0
import { quoteBlock } from "../projection/fence.js";
import { renderFencedBlock } from "../projection/project.js";

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export interface SanitizedText {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Corpus content is untrusted input. Terminal-control sequences are stripped
 * before anything is rendered or handed to a model; newline and tab survive
 * because they carry meaning in a transcript excerpt.
 */
export function sanitizeUntrustedText(value: string, maxChars: number): SanitizedText {
  const stripped = value.replace(CONTROL_CHARACTERS, "");
  if (stripped.length <= maxChars) return { text: stripped, truncated: false };
  return { text: stripped.slice(0, maxChars), truncated: true };
}

const MAX_PROVENANCE_CHARS = 512;

/**
 * The model-visible provenance boundary for a fetched record.
 *
 * The boundary itself is C6's: `renderFencedBlock` and `quoteBlock` are the same
 * functions `projectContext` calls, so the tool route and the pickup route are
 * byte-for-byte the same construction and C6's fence-breakout fixture covers
 * both. C7 adds only what C6 never sees: the provenance facts, sanitised and
 * bounded, rendered above the quoted body.
 */
export function fenceRecord(
  heading: string,
  provenance: readonly string[],
  body: string,
): string {
  const facts = provenance.map((entry) => sanitizeUntrustedText(entry, MAX_PROVENANCE_CHARS).text);
  const { text } = sanitizeUntrustedText(body, Number.MAX_SAFE_INTEGER);
  return renderFencedBlock(heading, [...facts, quoteBlock(text)]);
}
