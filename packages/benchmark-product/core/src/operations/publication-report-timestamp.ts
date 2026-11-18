import { parseHeadTimestamp } from "@jinn-network/record-discovery-protocol";
import { createDiscoverySourceAnnouncementPort, type PublicationAnnouncementPort } from "@jinn-network/record-publication";
import { refuse } from "../errors.js";
import type { WorkspacePublicationSource } from "../run/publication-source.js";

/**
 * Next announcement instant strictly after `priorIssuedAt`, never before `clockAt`. `field` names
 * the stage time being frozen in the refusal.
 */
export function timestampAfter(clockAt: string, priorIssuedAt: string | undefined, field = "publication.report.announcedAt"): string {
  const clockMs = parseHeadTimestamp(clockAt);
  const priorMs = priorIssuedAt === undefined ? Number.NEGATIVE_INFINITY : parseHeadTimestamp(priorIssuedAt);
  if (Number.isNaN(clockMs) || Number.isNaN(priorMs)) {
    refuse(
      "validation",
      field,
      "clock or source head issuedAt is not a calendar-strict RFC 3339 timestamp",
    );
  }
  return new Date(Math.max(clockMs, priorMs + (priorIssuedAt === undefined ? 0 : 1))).toISOString();
}

/**
 * The announcement port for a publication plan, used under the source lock: a plan's time is the
 * earliest a record is announced, not the exact time (#5348, #5349, #5369). Every retry replays the
 * plan, but the head may have passed a planned time since it was planned: through entry anchors,
 * which each release of the source lock announces at one millisecond after the head and on, or
 * through another draft. The writer refuses an append that does not strictly advance the head, so
 * announcing at exactly that time could never succeed. A record the source already holds under its
 * announcement id is reused without a new append, so it replays as it was; any other is announced
 * at its planned time, or one millisecond after the served head once the head has reached that
 * time. Under the lock only the hold's own appends move the head, so when nothing moved it every
 * record is announced at its planned time.
 *
 * `field` names the stage time in a refusal. `announcementId` defaults to the plan's announcement
 * id; signed Report v2 passes the id its envelope has always been announced under.
 */
export function announceAfterServedHead(
  source: WorkspacePublicationSource,
  field: string,
  announcementId: (value: Parameters<PublicationAnnouncementPort["announce"]>[0]) => string = (value) => value.idempotencyKey,
): PublicationAnnouncementPort {
  const announcer = createDiscoverySourceAnnouncementPort({ writer: source.writer });
  return { async announce(value) {
    const id = announcementId(value);
    const announced = (await source.writer.readState())?.announcements[id];
    if (announced !== undefined) {
      if (announced.receipt.record?.digest !== value.record.digest) throw new Error(`source announcement ${id} names a different record than ${value.record.id}`);
      return announced.receipt;
    }
    const announcementTimestamp = timestampAfter(value.record.announcementTimestamp!, (await source.head.getExact())?.issuedAt, field);
    // The source adapter announces under `idempotencyKey` verbatim, so it carries the chosen id.
    return announcer.announce({ idempotencyKey: id as typeof value.idempotencyKey, record: { ...value.record, announcementTimestamp } });
  } };
}
