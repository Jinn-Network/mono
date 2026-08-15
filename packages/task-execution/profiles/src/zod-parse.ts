import type { z } from "zod";
import { decodeUtf8 } from "./bytes.js";
import { ProfilesError } from "./errors.js";

/** Shared decode-then-validate helper used by every `parseX(bytes)` entry point (§6.1/§7.1). */
export function parseJsonDocument<T>(schema: z.ZodType<T>, bytes: Uint8Array, label: string): T {
  const text = decodeUtf8(bytes);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new ProfilesError("invalid-document", `${label} bytes are not valid JSON.`, { cause });
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new ProfilesError("invalid-document", `${label} failed schema validation: ${detail}`);
  }
  return result.data;
}

/** Shared validate-before-seal helper: re-validates a typed value before it reaches JCS bytes. */
export function assertValidDocument<T>(schema: z.ZodType<T>, value: T, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new ProfilesError("invalid-document", `${label} failed schema validation: ${detail}`);
  }
  return result.data;
}
