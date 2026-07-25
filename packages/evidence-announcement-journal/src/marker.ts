// SPDX-License-Identifier: MIT
import type {
  AppendAvailableAnnouncementInput,
  AnnouncementJournalMarkerV1,
} from "./types.js";
import { EvidenceAnnouncementJournalError } from "./errors.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

function invalid(message: string): never {
  throw new EvidenceAnnouncementJournalError("INVALID_ANNOUNCEMENT", message);
}

function nonEmpty(value: unknown, role: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${role} must be a non-empty string.`);
  }
}

function plainObject(
  value: unknown,
  role: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    invalid(`${role} must be a safe plain object.`);
  }
}

function finiteJson(
  value: unknown,
  role: string,
  ancestors = new WeakSet<object>(),
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${role} must contain finite numbers.`);
    return;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || ancestors.has(value)) {
      invalid(`${role} must contain safe acyclic arrays.`);
    }
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) invalid(`${role} must contain dense arrays.`);
      finiteJson(value[index], `${role}[${index}]`, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  if (typeof value === "object") {
    plainObject(value, role);
    if (ancestors.has(value)) invalid(`${role} must not contain cycles.`);
    ancestors.add(value);
    for (const [key, child] of Object.entries(value)) {
      finiteJson(child, `${role}.${key}`, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  invalid(`${role} must contain only finite JSON values.`);
}

export function createJournalMarker(sourceId: string): AnnouncementJournalMarkerV1 {
  nonEmpty(sourceId, "sourceId");
  return {
    format: "jinn-evidence-announcement-journal",
    version: 1,
    sourceId,
  };
}

export function validateAppendInput(
  value: AppendAvailableAnnouncementInput,
): void {
  plainObject(value, "announcement");
  nonEmpty(value.announcementId, "announcementId");
  nonEmpty(value.repositoryId, "repositoryId");
  plainObject(value.reference, "reference");
  const family = value.reference.family;
  const digest = value.reference.digest;
  if (
    typeof family !== "string" ||
    ![
      "execution-evidence",
      "result-evaluation",
      "execution-verification",
    ].includes(family) ||
    typeof digest !== "string" ||
    !DIGEST.test(digest)
  ) {
    invalid("reference must identify a supported family and canonical digest.");
  }
  if (value.publishedLocation !== undefined) {
    plainObject(value.publishedLocation, "publishedLocation");
    nonEmpty(value.publishedLocation.bindingProfile, "bindingProfile");
    try {
      new URL(value.publishedLocation.bindingProfile);
    } catch {
      invalid("bindingProfile must be an absolute identifier.");
    }
    plainObject(value.publishedLocation.locator, "locator");
    finiteJson(value.publishedLocation.locator, "locator");
  }
}
