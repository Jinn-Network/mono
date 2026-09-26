import { parseHeadTimestamp } from "@jinn-network/record-discovery-protocol";
import { refuse } from "../errors.js";

/** Next announcement instant strictly after `priorIssuedAt`, never before `clockAt`. */
export function timestampAfter(clockAt: string, priorIssuedAt: string | undefined): string {
  const clockMs = parseHeadTimestamp(clockAt);
  const priorMs = priorIssuedAt === undefined ? Number.NEGATIVE_INFINITY : parseHeadTimestamp(priorIssuedAt);
  if (Number.isNaN(clockMs) || Number.isNaN(priorMs)) {
    refuse(
      "validation",
      "publication.report.announcedAt",
      "clock or source head issuedAt is not a calendar-strict RFC 3339 timestamp",
    );
  }
  return new Date(Math.max(clockMs, priorMs + (priorIssuedAt === undefined ? 0 : 1))).toISOString();
}
