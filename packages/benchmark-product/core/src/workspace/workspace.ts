/**
 * Workspace initialization and metadata (spec §4.5, assumption A4).
 *
 * A workspace is an explicit directory the user chose — never auto-discovered
 * upward. `workspace.json` marks a directory as one; `drafts/`, `records/`,
 * `artifacts/` hold the three storage disciplines this module's siblings
 * implement (mutable drafts, digest-addressed sealed bytes, derived outputs).
 * This module owns only the metadata file and directory creation; every
 * other module resolves workspace paths through `./layout.js`.
 */

import { existsSync, mkdirSync } from "node:fs";
import { z } from "zod";
import { refuse, refuseWithIssues } from "../errors.js";
import { atomicWriteFileSync, readFileIfExistsSync } from "../fs/atomic.js";
import { artifactsDir, draftsDir, recordsDir, workspaceMetadataPath } from "./layout.js";

export const WORKSPACE_STORAGE_VERSION = 1;

/** RFC 3339 date-time: `YYYY-MM-DDThh:mm:ss[.fraction](Z|±hh:mm)`. */
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const WorkspaceMetadataSchema = z.object({
  storageVersion: z.literal(WORKSPACE_STORAGE_VERSION),
  createdAt: z.string().regex(RFC3339_PATTERN, "must be an RFC 3339 timestamp"),
});

export type WorkspaceMetadata = z.infer<typeof WorkspaceMetadataSchema>;

function zodIssuesToProductIssues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
}

/**
 * Creates a fresh workspace at `workspaceDir`: the three storage-discipline
 * directories plus `workspace.json`, written atomically. Refuses `"conflict"`
 * when the directory is already a workspace — re-init is never silent —
 * and `"validation"` when `createdAt` does not fit the schema. Returns the
 * metadata written.
 */
export function createWorkspaceLayout(workspaceDir: string, createdAt: string): WorkspaceMetadata {
  const metadataPath = workspaceMetadataPath(workspaceDir);
  if (existsSync(metadataPath)) {
    refuse("conflict", metadataPath, "workspace.json already exists — this directory is already a workspace");
  }

  const parsed = WorkspaceMetadataSchema.safeParse({
    storageVersion: WORKSPACE_STORAGE_VERSION,
    createdAt,
  });
  if (!parsed.success) {
    refuseWithIssues("validation", zodIssuesToProductIssues(parsed.error));
  }

  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(draftsDir(workspaceDir), { recursive: true });
  mkdirSync(recordsDir(workspaceDir), { recursive: true });
  mkdirSync(artifactsDir(workspaceDir), { recursive: true });
  atomicWriteFileSync(metadataPath, JSON.stringify(parsed.data, null, 2));
  return parsed.data;
}

/**
 * Reads and validates `workspace.json`. Refuses `"not-found"` when the
 * directory is not a workspace (the file is absent), and `"validation"`
 * when the file is present but is not JSON or fails the schema.
 */
export function assertWorkspace(workspaceDir: string): WorkspaceMetadata {
  const metadataPath = workspaceMetadataPath(workspaceDir);
  const bytes = readFileIfExistsSync(metadataPath);
  if (bytes === undefined) {
    refuse("not-found", metadataPath, "workspace.json not found — this directory is not a workspace");
  }

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refuse("validation", metadataPath, "workspace.json is not valid JSON");
  }

  const parsed = WorkspaceMetadataSchema.safeParse(json);
  if (!parsed.success) {
    refuseWithIssues("validation", zodIssuesToProductIssues(parsed.error));
  }
  return parsed.data;
}

/** True when `workspaceDir` has already been initialized as a workspace. */
export function isWorkspace(workspaceDir: string): boolean {
  return existsSync(workspaceMetadataPath(workspaceDir));
}
