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
import { artifactsDir, draftsDir, publicationDir, recordsDir, workspaceMetadataPath } from "./layout.js";

export const WORKSPACE_STORAGE_VERSION = 1;

/** RFC 3339 date-time: `YYYY-MM-DDThh:mm:ss[.fraction](Z|±hh:mm)`. */
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * One configured anchor provider (anchor-evidence design §7.3). The endpoint is configuration and
 * never a shipped default: no endpoint and no vendor name appears anywhere in this product's
 * source, which is what makes anchoring structurally opt-in and keeps the §13 item-7 disclosure
 * the operator's own decision.
 *
 * The endpoint's syntax is the provider's own — an HTTP(S) URL for a timestamp authority; one or
 * more comma-separated calendar base URLs for OpenTimestamps, since stamping through several
 * calendars is that profile's standard availability mitigation (§6.2). It is validated by the
 * source that uses it, not here, so a future profile needs no schema change.
 */
export const WorkspaceAnchoringEntrySchema = z.object({
  providerProfile: z.string().min(1),
  endpoint: z.string().min(1),
});

export type WorkspaceAnchoringEntry = z.infer<typeof WorkspaceAnchoringEntrySchema>;

export const WorkspaceMetadataSchema = z.object({
  storageVersion: z.literal(WORKSPACE_STORAGE_VERSION),
  createdAt: z.string().regex(RFC3339_PATTERN, "must be an RFC 3339 timestamp"),
  /**
   * Ordered; first matching entry wins. Optional and absent by default, so every workspace written
   * before this field existed parses unchanged and `storageVersion` does not move: an absent
   * optional field is not a storage-format change (§12). Absent any configuration nothing is
   * attempted, no warning prints, and the unconditional limitation stands (§7.3).
   */
  anchoring: z.array(WorkspaceAnchoringEntrySchema).optional(),
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
  mkdirSync(publicationDir(workspaceDir), { recursive: true });
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

/**
 * Replaces the workspace's `anchoring` block (anchor-evidence design §7.3), atomically and through
 * the same schema every read validates against.
 *
 * An empty list **removes** the key rather than storing `[]`. Absence is the documented default —
 * "absent any configuration nothing is attempted, no warning prints, and the unconditional
 * limitation stands" — so clearing configuration must return the file to exactly the shape a
 * never-configured workspace has, not to a second spelling of the same thing.
 *
 * Every other field is carried through unchanged: this reads the file it is about to rewrite, so a
 * field a later storage version adds is never dropped by an anchoring edit.
 */
export function writeWorkspaceAnchoring(
  workspaceDir: string,
  entries: readonly WorkspaceAnchoringEntry[],
): readonly WorkspaceAnchoringEntry[] {
  const { anchoring: _replaced, ...rest } = assertWorkspace(workspaceDir);
  const parsed = WorkspaceMetadataSchema.safeParse(
    entries.length === 0 ? rest : { ...rest, anchoring: entries },
  );
  if (!parsed.success) {
    refuseWithIssues("validation", zodIssuesToProductIssues(parsed.error));
  }
  atomicWriteFileSync(workspaceMetadataPath(workspaceDir), JSON.stringify(parsed.data, null, 2));
  return parsed.data.anchoring ?? [];
}

/** True when `workspaceDir` has already been initialized as a workspace. */
export function isWorkspace(workspaceDir: string): boolean {
  return existsSync(workspaceMetadataPath(workspaceDir));
}
