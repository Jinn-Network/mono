/**
 * The cancel-requested marker (BP-22, plan decision 1): `<ws>/runs/<draftId>.cancel-requested.json`
 * (`runCancelMarkerPath`, `../workspace/layout.ts`). A durable, per-draft fact written once, atomically,
 * by the gated `run.cancel` operation (`../operations/run-cancel.ts`) BEFORE any other effect, and
 * never removed. A present AND schema-valid marker is what `../run/assembly-ports.ts` re-derives
 * `completeness.runOutcome: "cancelled"` from, so once it is written every later `run.verify`
 * agrees the run was cancelled — even if `run.cancel` itself never gets to finalize (the venue was
 * busy; the process crashed right after writing it).
 *
 * `cancelRequested` intentionally pays the bounded cost of reading and validating this tiny
 * document even on live-drive checks. Arbitrary regular bytes are not cancellation authority:
 * malformed content fails closed as record-integrity everywhere, including status, assembly,
 * collect/resume guards, and verification.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fsyncBestEffortSync } from "@jinn-network/task-execution-supervisor";
import { z } from "zod";
import { refuse, refuseWithIssues, type ProductIssue } from "../errors.js";
import { fsyncDirectorySync } from "../fs/atomic.js";
import { runCancelMarkerPath } from "../workspace/layout.js";

const Rfc3339Schema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  "must be an RFC 3339 timestamp",
);

export const CancelMarkerSchema = z.object({
  requestedAt: Rfc3339Schema,
  /** The principal that requested the cancellation (spec §4.2/§4.4 attribution). */
  principal: z.string().min(1),
});

export type CancelMarker = z.infer<typeof CancelMarkerSchema>;

export interface CancelMarkerPublicationDeps {
  /** Test-only sequencing observation; production callers omit it. */
  readonly onPublicationStep?: (
    step:
      | "owner-file-synced"
      | "canonical-linked"
      | "directory-synced-after-link"
      | "owner-unlinked"
      | "directory-synced-after-unlink",
  ) => void;
}

function issuesFromZodError(error: z.ZodError): ProductIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
}

function nodeCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function inspectRegularMarker(path: string): "absent" | "regular" {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      refuse("record-integrity", path, "cancel marker path must be a regular file, never a symbolic link");
    }
    return "regular";
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return "absent";
    throw error;
  }
}

function readRegularMarkerText(path: string): string | undefined {
  if (inspectRegularMarker(path) === "absent") return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(fd).isFile()) {
      refuse("record-integrity", path, "cancel marker path must remain a regular file while being read");
    }
    return readFileSync(fd, "utf8");
  } catch (error) {
    if (nodeCode(error) === "ELOOP") {
      refuse("record-integrity", path, "cancel marker path must never be a symbolic link");
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** True iff a regular, schema-valid cancel-requested marker exists for `draftId`. This hot path
 * intentionally pays the bounded cost of parsing the tiny record; malformed bytes fail closed. */
export function cancelRequested(workspaceDir: string, draftId: string): boolean {
  return readCancelMarker(workspaceDir, draftId) !== undefined;
}

/** Reads and validates the cancel marker for `draftId`, or `undefined` when none exists yet.
 * Refuses `"record-integrity"` when existing bytes are not valid JSON or fail the schema. */
export function readCancelMarker(workspaceDir: string, draftId: string): CancelMarker | undefined {
  const path = runCancelMarkerPath(workspaceDir, draftId);
  const text = readRegularMarkerText(path);
  if (text === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    refuse("record-integrity", path, "cancel marker is not valid JSON");
  }
  const result = CancelMarkerSchema.safeParse(parsed);
  if (!result.success) {
    refuseWithIssues("record-integrity", issuesFromZodError(result.error));
  }
  return result.data;
}

/** Validates and publishes a fully-written marker exactly once. A private owner file is fsynced
 * before an atomic hard link claims the canonical path; an existing intent is never overwritten. */
export function writeCancelMarker(
  workspaceDir: string,
  draftId: string,
  marker: CancelMarker,
  deps: CancelMarkerPublicationDeps = {},
): void {
  const result = CancelMarkerSchema.safeParse(marker);
  if (!result.success) {
    refuseWithIssues("validation", issuesFromZodError(result.error));
  }
  const path = runCancelMarkerPath(workspaceDir, draftId);
  if (inspectRegularMarker(path) === "regular") {
    refuse("conflict", path, `a cancellation intent already exists for ${draftId}`);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const ownerPath = `${path}.owner-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(
      ownerPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(fd, JSON.stringify(result.data, null, 2));
    fsyncBestEffortSync(fd);
    deps.onPublicationStep?.("owner-file-synced");
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(ownerPath, path);
      deps.onPublicationStep?.("canonical-linked");
      fsyncDirectorySync(dirname(path));
      deps.onPublicationStep?.("directory-synced-after-link");
    } catch (error) {
      if (nodeCode(error) === "EEXIST") {
        refuse("conflict", path, `a cancellation intent already exists for ${draftId}`);
      }
      throw error;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    let ownerUnlinked = false;
    try {
      unlinkSync(ownerPath);
      ownerUnlinked = true;
    } catch {
      // The canonical hard link, when published, owns the complete marker bytes.
    }
    if (ownerUnlinked) {
      deps.onPublicationStep?.("owner-unlinked");
      fsyncDirectorySync(dirname(path));
      deps.onPublicationStep?.("directory-synced-after-unlink");
    }
  }
}
