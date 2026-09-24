/**
 * Source-scoped write-once ledger for announcement-entry anchors
 * (publication-head anchoring design §4.4 / §7 item 3).
 *
 * Keyed `(entryDigest, provider)` beside the publication CAS documents. Not
 * `RunState.anchors`: a source has no report window and an unbounded subject
 * set. Written only while the caller already holds the publication source lock.
 */

import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { atomicWriteFileSync, fsyncDirectorySync, readFileIfExistsSync } from "../fs/atomic.js";
import { publicationDir, publicationStatePath } from "../workspace/layout.js";

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

const LedgerRowSchema = z.object({
  entryDigest: Sha256HexSchema,
  sequence: z.string().regex(/^[0-9]{16}$/),
  entryTimestamp: z.string().min(1),
  provider: z.string().min(1),
  recordSha256: Sha256HexSchema.optional(),
  upgradesRecordSha256: Sha256HexSchema.optional(),
  announcedAnnouncementId: z.string().min(1).optional(),
  proofStatus: z.string().min(1).optional(),
});

const LedgerDocumentSchema = z.object({
  version: z.literal(1),
  sourceName: z.string().min(1),
  rows: z.array(LedgerRowSchema),
});

export type EntryAnchorLedgerRow = z.infer<typeof LedgerRowSchema>;
export type EntryAnchorLedger = z.infer<typeof LedgerDocumentSchema>;

function opaqueId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function entryAnchorSourceId(agent: string, sourceName: string): string {
  return `${agent}\u001f${sourceName}`;
}

export function entryAnchorLedgerPath(workspaceDir: string, agent: string, sourceName: string): string {
  return publicationStatePath(workspaceDir, opaqueId(entryAnchorSourceId(agent, sourceName)), "entry-anchors");
}

export function bareEntryDigest(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}

export function readEntryAnchorLedger(workspaceDir: string, agent: string, sourceName: string): EntryAnchorLedger {
  const path = entryAnchorLedgerPath(workspaceDir, agent, sourceName);
  const bytes = readFileIfExistsSync(path);
  if (bytes === undefined) return { version: 1, sourceName, rows: [] };
  const parsed = LedgerDocumentSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (!parsed.success) return { version: 1, sourceName, rows: [] };
  return parsed.data.sourceName === sourceName ? parsed.data : { ...parsed.data, sourceName };
}

export function writeEntryAnchorLedger(
  workspaceDir: string,
  agent: string,
  sourceName: string,
  ledger: EntryAnchorLedger,
): void {
  const path = entryAnchorLedgerPath(workspaceDir, agent, sourceName);
  atomicWriteFileSync(path, JSON.stringify({ ...ledger, version: 1, sourceName }));
  fsyncDirectorySync(dirname(path));
}

export function rowsForPair(
  ledger: EntryAnchorLedger,
  entryDigest: string,
  provider: string,
): readonly EntryAnchorLedgerRow[] {
  const digest = bareEntryDigest(entryDigest);
  return ledger.rows.filter((row) => row.entryDigest === digest && row.provider === provider);
}

export function listEntryAnchorLedgers(workspaceDir: string): readonly EntryAnchorLedger[] {
  let files: readonly string[];
  try {
    files = readdirSync(join(publicationDir(workspaceDir), "sources"));
  } catch {
    return [];
  }
  const ledgers: EntryAnchorLedger[] = [];
  for (const file of files) {
    if (!file.endsWith(".entry-anchors.json")) continue;
    const bytes = readFileIfExistsSync(join(publicationDir(workspaceDir), "sources", file));
    if (bytes === undefined) continue;
    const parsed = LedgerDocumentSchema.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (parsed.success) ledgers.push(parsed.data);
  }
  return ledgers;
}
