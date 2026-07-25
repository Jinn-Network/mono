// SPDX-License-Identifier: MIT
import { EvidenceAnnouncementJournalError } from "./errors.js";
import type { AnnouncementJournalCursorV1 } from "./types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

function invalid(message: string, cause?: unknown): never {
  throw new EvidenceAnnouncementJournalError(
    "CURSOR_INVALID",
    message,
    cause === undefined ? undefined : { cause },
  );
}

export function encodeJournalCursor(
  cursor: AnnouncementJournalCursorV1,
): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeJournalCursor(value: unknown): AnnouncementJournalCursorV1 {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    invalid("The announcement journal cursor is malformed.");
  }
  try {
    const decodedBytes = Buffer.from(value, "base64url");
    if (decodedBytes.toString("base64url") !== value) {
      invalid("The announcement journal cursor is not canonical base64url.");
    }
    const parsed = JSON.parse(decodedBytes.toString("utf8")) as
      Record<string, unknown>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype ||
      Object.keys(parsed).sort().join("\0") !==
        ["entryDigest", "revision", "sourceId", "version"].join("\0") ||
      parsed.version !== 1 ||
      typeof parsed.sourceId !== "string" ||
      parsed.sourceId.trim().length === 0 ||
      !Number.isSafeInteger(parsed.revision) ||
      (parsed.revision as number) < 1 ||
      typeof parsed.entryDigest !== "string" ||
      !DIGEST.test(parsed.entryDigest)
    ) {
      invalid("The announcement journal cursor has an invalid shape.");
    }
    const canonical: AnnouncementJournalCursorV1 = {
      version: 1,
      sourceId: parsed.sourceId,
      revision: parsed.revision as number,
      entryDigest: parsed.entryDigest as `sha256:${string}`,
    };
    if (!Buffer.from(JSON.stringify(canonical)).equals(decodedBytes)) {
      invalid("The announcement journal cursor JSON is not canonical.");
    }
    return canonical;
  } catch (error) {
    if (error instanceof EvidenceAnnouncementJournalError) throw error;
    return invalid("The announcement journal cursor is malformed.", error);
  }
}
