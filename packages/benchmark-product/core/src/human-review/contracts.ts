// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { canonicalJsonBytes, recordDigest } from "@jinn-network/task-execution-profiles";
import { refuse, refuseWithIssues } from "../errors.js";

export * from "@colophon-claims/check/admission";

function issues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
    message: issue.message,
  }));
}

/** Product error adapter retained for existing operation callers. Canonical schemas live in verify. */
export function parseHumanReviewDocument<T>(schema: z.ZodType<T>, input: unknown, _label: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) refuseWithIssues("validation", issues(parsed.error));
  return parsed.data;
}

export function parseCanonicalHumanReviewBytes<T>(
  schema: z.ZodType<T>,
  bytes: Uint8Array,
  label: string,
): T {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refuse("validation", label, `${label} is not valid UTF-8 JSON`);
  }
  const parsed = parseHumanReviewDocument(schema, value, label);
  const expected = canonicalJsonBytes(parsed);
  if (expected.byteLength !== bytes.byteLength || expected.some((byte, index) => byte !== bytes[index])) {
    refuse("validation", label, `${label} is not in canonical JSON encoding`);
  }
  return parsed;
}

export function sealHumanReviewDocument<T>(schema: z.ZodType<T>, input: unknown, label: string) {
  const value = parseHumanReviewDocument(schema, input, label);
  const bytes = canonicalJsonBytes(value);
  return { value, bytes, digest: recordDigest(bytes) } as const;
}
