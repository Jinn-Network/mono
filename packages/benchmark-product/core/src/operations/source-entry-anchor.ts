/**
 * `anchorSourceEntry` (publication-head anchoring design §7 items 4–6).
 *
 * Obtains third-party time evidence over one announcement-entry digest, stores
 * the sealed `AnchorEvidence` via `putSealedBytes`, and records it on the
 * source-scoped ledger. The append hook never throws. Dedicated all-anchor
 * announcements are flushed after the publication lock callback so they cannot
 * collide with 1 ms-spaced substantive timestamps inside that callback.
 */

import {
  ANCHOR_EVIDENCE_KIND,
  ANCHOR_EVIDENCE_MEDIA_TYPE,
  OPENTIMESTAMPS_ANCHOR_PROFILE,
  compareCalendarStrictRfc3339Instants,
  decodeAnchorProofContent,
  parseExactAnchorEvidence,
  sealAnchorEvidence,
} from "@jinn-network/trust-core";
import type { AnchorProofResult, AnchorProofSource } from "@jinn-network/trust-core";
import {
  LOCATION_PROFILE_HTTPS,
  RECORD_KINDS,
  anchorAnnouncementFacts,
  isAnchorAnnouncingEntry,
  recordPath,
} from "@jinn-network/record-discovery-protocol";
import type { Announcement } from "@jinn-network/record-discovery-protocol";
import {
  anchorProofMediaType,
  encodeAnchorProofContent,
  isProducibleAnchorProfile,
  type ProducibleAnchorProfile,
} from "../anchor/profiles.js";
import type { OpenTimestampsProofSource } from "../anchor/sources.js";
import { BenchmarkProductError, refuse, toErrorEnvelope } from "../errors.js";
import {
  bareEntryDigest,
  listEntryAnchorLedgers,
  readEntryAnchorLedger,
  rowsForPair,
  writeEntryAnchorLedger,
  type EntryAnchorLedger,
  type EntryAnchorLedgerRow,
} from "../run/entry-anchor-ledger.js";
import type { WorkspacePublicationSource } from "../run/publication-source.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import {
  assertWorkspace,
  entryAnchorSkewAllowanceMs,
} from "../workspace/workspace.js";
import type { OperationContext } from "./context.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";
import {
  buildSource,
  resolveAnchorConfiguration,
  requireVerifiable,
  verifyAcquiredProof,
  type RunAnchorDeps,
} from "./run-anchor.js";

export interface AnchorSourceEntryInput {
  readonly agent: string;
  readonly sourceName: string;
  readonly entryDigest: string;
  readonly sequence: string;
  readonly entryTimestamp: string;
  readonly providerProfile?: string;
  readonly endpoint?: string;
}

export interface AnchorSourceEntryResult {
  readonly sequence: string;
  readonly provider: string;
  readonly recordSha256: string;
  readonly subjectSha256: string;
  readonly proofStatus: AnchorProofResult["status"];
  readonly upgradesRecordSha256?: string;
}

export type EntryAnchorAfterAppendOutcome =
  | { readonly attempted: false; readonly reason: "disabled" | "unconfigured" | "anchor-announcing" | "already-held" }
  | { readonly attempted: true; readonly result: OperationResult<AnchorSourceEntryResult> };

function asUpgradeCapable(source: AnchorProofSource): OpenTimestampsProofSource {
  const candidate = source as Partial<OpenTimestampsProofSource>;
  if (typeof candidate.upgradeProof !== "function") {
    refuse("venue-unavailable", `anchor.${source.profile}`, "the configured source cannot upgrade a pending proof");
  }
  return source as OpenTimestampsProofSource;
}

function resolveUpgradeTarget(
  workspaceDir: string,
  ledger: EntryAnchorLedger,
  entryDigest: string,
  profile: ProducibleAnchorProfile,
  subjectSha256: string,
): { readonly recordSha256: string; readonly proofBytes: Uint8Array } | undefined {
  const carried = rowsForPair(ledger, entryDigest, profile).filter((row) => row.recordSha256 !== undefined);
  if (carried.length === 0) return undefined;
  const conflict = (detail: string): never => refuse("conflict", "publication.entry-anchors", detail);
  if (profile !== OPENTIMESTAMPS_ANCHOR_PROFILE) {
    return conflict(`this source already carries an entry anchor from ${profile} over ${entryDigest}`);
  }
  const alreadyUpgraded = new Set(
    carried.flatMap((row) => row.upgradesRecordSha256 === undefined ? [] : [row.upgradesRecordSha256]),
  );
  const target = carried
    .filter((row) => row.recordSha256 !== undefined && !alreadyUpgraded.has(row.recordSha256))
    .map((row) => ({
      recordSha256: row.recordSha256!,
      proofBytes: decodeAnchorProofContent(
        parseExactAnchorEvidence(getSealedBytes(workspaceDir, row.recordSha256!)).proof.content,
      ),
    }))
    .filter((candidate) => verifyAcquiredProof(profile, subjectSha256, candidate.proofBytes).status === "pending")
    .at(-1);
  if (target === undefined) {
    return conflict(`this source already carries a completed entry anchor from ${profile} over ${entryDigest}`);
  }
  return target;
}

function assertEntryAnchorSkew(
  profile: ProducibleAnchorProfile,
  result: AnchorProofResult,
  entryTimestamp: string,
  skewAllowanceMs: number,
): void {
  if (result.status !== "present" && result.status !== "verified") return;
  if (result.timeBasis !== "authority-time") return;
  const genTime = (result.facts as { readonly genTime?: unknown }).genTime;
  if (typeof genTime !== "string") return;
  const compared = compareCalendarStrictRfc3339Instants(genTime, entryTimestamp);
  if (compared === undefined || compared >= 0) return;
  const deltaMs = Date.parse(entryTimestamp) - Date.parse(genTime);
  if (!Number.isFinite(deltaMs) || deltaMs <= skewAllowanceMs) return;
  refuse(
    "venue-unverifiable",
    `anchor.${profile}`,
    `the token's genTime ${genTime} precedes this entry's timestamp ${entryTimestamp} by more than the configured skew allowance of ${skewAllowanceMs}ms; nothing is stored`,
  );
}

export async function acquireSourceEntryAnchor(
  workspaceDir: string,
  input: AnchorSourceEntryInput,
  deps: RunAnchorDeps = {},
): Promise<AnchorSourceEntryResult> {
  const workspace = assertWorkspace(workspaceDir);
  const resolution = resolveAnchorConfiguration({
    workspaceAnchoring: workspace.anchoring ?? [],
    ...(input.providerProfile === undefined ? {} : { providerProfile: input.providerProfile }),
    ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
  });
  if (resolution.kind !== "target") {
    refuse("venue-unavailable", "workspace.anchoring", "no anchor provider endpoint resolves");
  }
  const { providerProfile, endpoint } = resolution.target;
  if (!isProducibleAnchorProfile(providerProfile)) {
    refuse("venue-unavailable", "workspace.anchoring", `no acquisition source implements ${providerProfile}`);
  }

  const subjectSha256 = bareEntryDigest(input.entryDigest);
  let ledger = readEntryAnchorLedger(workspaceDir, input.agent, input.sourceName);
  const upgrade = resolveUpgradeTarget(workspaceDir, ledger, subjectSha256, providerProfile, subjectSha256);

  const source = buildSource(providerProfile, deps);
  const proofBytes = upgrade === undefined
    ? await source.obtainProof({ subjectSha256, endpoint })
    : await asUpgradeCapable(source).upgradeProof({
      subjectSha256,
      proofBytes: upgrade.proofBytes,
      endpoint,
    });

  const verified = verifyAcquiredProof(providerProfile, subjectSha256, proofBytes);
  const proofStatus = requireVerifiable(providerProfile, verified, undefined);
  assertEntryAnchorSkew(providerProfile, verified, input.entryTimestamp, entryAnchorSkewAllowanceMs(workspace));

  await deps.afterObtainBeforeStore?.();

  ledger = readEntryAnchorLedger(workspaceDir, input.agent, input.sourceName);
  const upgradeAtStore = resolveUpgradeTarget(workspaceDir, ledger, subjectSha256, providerProfile, subjectSha256);
  if (upgradeAtStore?.recordSha256 !== upgrade?.recordSha256) {
    refuse(
      "conflict",
      "publication.entry-anchors",
      "another anchor over this entry from this provider landed while this proof was being acquired",
    );
  }

  const record = {
    kind: ANCHOR_EVIDENCE_KIND,
    subject: { kind: RECORD_KINDS.announcementEntry, digest: { sha256: subjectSha256 } },
    provider: providerProfile,
    proof: {
      mediaType: anchorProofMediaType(providerProfile),
      content: encodeAnchorProofContent(proofBytes),
    },
  };
  const sealed = sealAnchorEvidence(record);
  const recordSha256 = putSealedBytes(workspaceDir, sealed.bytes);

  const row: EntryAnchorLedgerRow = {
    entryDigest: subjectSha256,
    sequence: input.sequence,
    entryTimestamp: input.entryTimestamp,
    provider: providerProfile,
    recordSha256,
    ...(upgrade === undefined ? {} : { upgradesRecordSha256: upgrade.recordSha256 }),
    proofStatus,
  };
  writeEntryAnchorLedger(workspaceDir, input.agent, input.sourceName, {
    version: 1,
    sourceName: input.sourceName,
    rows: [...ledger.rows, row],
  });

  return {
    sequence: input.sequence,
    provider: providerProfile,
    recordSha256,
    subjectSha256,
    proofStatus,
    ...(upgrade === undefined ? {} : { upgradesRecordSha256: upgrade.recordSha256 }),
  };
}

export interface AnchorSourceEntryCommand {
  readonly sourceName: string;
  readonly agent: string;
  readonly sequence: string;
  readonly entryDigest: `sha256:${string}`;
  readonly entryTimestamp: string;
  readonly announcement: Announcement;
}

export async function acquireEntryAnchorAfterAppend(
  workspaceDir: string,
  command: AnchorSourceEntryCommand,
  deps: RunAnchorDeps = {},
): Promise<EntryAnchorAfterAppendOutcome> {
  try {
    if (isAnchorAnnouncingEntry({ announcements: [command.announcement] })) {
      return { attempted: false, reason: "anchor-announcing" };
    }
    const workspace = assertWorkspace(workspaceDir);
    const resolution = resolveAnchorConfiguration({ workspaceAnchoring: workspace.anchoring ?? [] });
    if (resolution.kind !== "target") return { attempted: false, reason: resolution.kind };

    const digest = bareEntryDigest(command.entryDigest);
    const ledger = readEntryAnchorLedger(workspaceDir, command.agent, command.sourceName);
    const existing = rowsForPair(ledger, digest, resolution.target.providerProfile);
    if (existing.some((row) => row.recordSha256 !== undefined && row.upgradesRecordSha256 === undefined)
      && resolution.target.providerProfile !== OPENTIMESTAMPS_ANCHOR_PROFILE) {
      return { attempted: false, reason: "already-held" };
    }

    try {
      const result = await acquireSourceEntryAnchor(workspaceDir, {
        sourceName: command.sourceName,
        agent: command.agent,
        entryDigest: digest,
        sequence: command.sequence,
        entryTimestamp: command.entryTimestamp,
      }, deps);
      return { attempted: true, result: { ok: true, result } };
    } catch (cause) {
      if (cause instanceof BenchmarkProductError) {
        return { attempted: true, result: { ok: false, error: toErrorEnvelope(cause) } };
      }
      return {
        attempted: true,
        result: { ok: false, error: toErrorEnvelope(cause) },
      };
    }
  } catch {
    return { attempted: false, reason: "unconfigured" };
  }
}

function nextMillisecond(timestamp: string, offset: number): string {
  return new Date(Date.parse(timestamp) + offset).toISOString();
}

export async function announcePendingEntryAnchors(
  publication: Pick<WorkspacePublicationSource, "source" | "writer" | "head">,
  workspaceDir: string,
): Promise<readonly AnchorSourceEntryResult[]> {
  const ledger = readEntryAnchorLedger(workspaceDir, publication.source.agent, publication.source.name);
  const pending = ledger.rows.filter((row) => row.recordSha256 !== undefined && row.announcedAnnouncementId === undefined);
  if (pending.length === 0) return [];

  const head = await publication.head.getExact();
  const base = head?.issuedAt ?? pending[0]!.entryTimestamp;
  const announced: AnchorSourceEntryResult[] = [];
  const rows = [...ledger.rows];

  for (const [index, row] of pending.entries()) {
    const recordSha256 = row.recordSha256!;
    const bytes = getSealedBytes(workspaceDir, recordSha256);
    const announcementId = `entry-anchor:${row.entryDigest}:${row.provider}:${recordSha256}`;
    const facts = anchorAnnouncementFacts({
      subject: { kind: RECORD_KINDS.announcementEntry, digest: row.entryDigest },
      provider: row.provider,
      ...(row.upgradesRecordSha256 === undefined ? {} : { upgrades: row.upgradesRecordSha256 }),
    });
    await publication.writer.append({
      timestamp: nextMillisecond(base, index + 1),
      announcement: {
        announcementId,
        action: "available",
        record: {
          kind: ANCHOR_EVIDENCE_KIND,
          digest: `sha256:${recordSha256}`,
          mediaType: ANCHOR_EVIDENCE_MEDIA_TYPE,
        },
        locations: [{
          profile: LOCATION_PROFILE_HTTPS,
          locator: recordPath(`sha256:${recordSha256}`),
        }],
        facts,
      },
      record: { bytes, contentType: ANCHOR_EVIDENCE_MEDIA_TYPE },
    });
    const at = rows.findIndex((candidate) =>
      candidate.entryDigest === row.entryDigest
      && candidate.provider === row.provider
      && candidate.recordSha256 === row.recordSha256
      && candidate.announcedAnnouncementId === undefined
    );
    if (at >= 0) rows[at] = { ...rows[at]!, announcedAnnouncementId: announcementId };
    announced.push({
      sequence: row.sequence,
      provider: row.provider,
      recordSha256,
      subjectSha256: row.entryDigest,
      proofStatus: (row.proofStatus ?? "present") as AnchorProofResult["status"],
      ...(row.upgradesRecordSha256 === undefined ? {} : { upgradesRecordSha256: row.upgradesRecordSha256 }),
    });
  }

  writeEntryAnchorLedger(workspaceDir, publication.source.agent, publication.source.name, {
    version: 1,
    sourceName: publication.source.name,
    rows,
  });
  return announced;
}

export async function flushPendingEntryAnchorAnnouncements(
  workspaceDir: string,
  openSource: (sourceName: string) => WorkspacePublicationSource,
): Promise<readonly AnchorSourceEntryResult[]> {
  const announced: AnchorSourceEntryResult[] = [];
  for (const ledger of listEntryAnchorLedgers(workspaceDir)) {
    const publication = openSource(ledger.sourceName);
    announced.push(...await announcePendingEntryAnchors(publication, workspaceDir));
  }
  return announced;
}

export function formatEntryAnchorLine(result: AnchorSourceEntryResult): string {
  return `anchoring: entry ${result.sequence} ${result.provider} as ${result.recordSha256} (${result.proofStatus})\n`;
}

export function formatEntryAnchorLines(workspaceDir: string, agent: string, sourceName: string): string {
  const ledger = readEntryAnchorLedger(workspaceDir, agent, sourceName);
  return ledger.rows
    .filter((row) => row.recordSha256 !== undefined)
    .map((row) => formatEntryAnchorLine({
      sequence: row.sequence,
      provider: row.provider,
      recordSha256: row.recordSha256!,
      subjectSha256: row.entryDigest,
      proofStatus: (row.proofStatus ?? "present") as AnchorProofResult["status"],
      ...(row.upgradesRecordSha256 === undefined ? {} : { upgradesRecordSha256: row.upgradesRecordSha256 }),
    }))
    .join("");
}

export function anchorSourceEntry(
  context: OperationContext,
  input: AnchorSourceEntryInput,
  deps: RunAnchorDeps = {},
): Promise<OperationResult<AnchorSourceEntryResult>> {
  return operateAsync({
    context,
    action: "anchor-source-entry",
    subject: `${input.sourceName}:${input.entryDigest}`,
    inputs: input,
    run: () => acquireSourceEntryAnchor(context.workspaceDir, input, deps),
  });
}
