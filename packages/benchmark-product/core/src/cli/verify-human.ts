import type { AnchorSubjectReport, AnchorVerificationEntry, IntegrityAnchorsReport } from "@colophon-claims/check";
import type { RunVerifyResult } from "../operations/verify.js";

function evaluationNote(entry: AnchorVerificationEntry): string {
  if (entry.status === "verified") {
    return "time basis evaluated against trust material you supplied";
  }
  if (entry.status === "pending") {
    return entry.reason === undefined ? "no chain attestation yet" : entry.reason;
  }
  if (entry.status === "invalid") {
    return entry.reason === undefined ? "the proof does not verify" : entry.reason;
  }
  entry.status satisfies "present";
  return entry.trustMaterial === "supplied"
    ? "time basis not evaluated: the trust material you supplied does not verify this anchor"
    : "time basis not evaluated: no trust material supplied";
}

/** Keeps the declared provider's useful profile path while dropping its unresolvable host. */
function anchorProfileName(profile: string): string {
  return /^https?:\/\/[^/]+\/(?:[^/]+\/)*anchor-profiles\/(.+)$/u.exec(profile)?.[1] ?? profile;
}

function renderSubject(subject: AnchorSubjectReport): string {
  if (subject.outcome === "declared-but-absent") {
    return `  ${subject.subject}: declared-but-absent — this run declared `
      + `${subject.declaredProfiles?.map(anchorProfileName).join(", ") ?? "an anchor provider"} and the bundle carries no matching anchor`;
  }
  if (subject.outcome === "absent") return `  ${subject.subject}: absent — no anchor was carried and none was declared`;
  return `  ${subject.subject}: anchored`;
}

function renderSubjects(report: IntegrityAnchorsReport): string {
  return `Anchor subjects\n${report.subjects.map(renderSubject).join("\n")}`;
}

export function renderWorkspaceVerifyHuman(value: RunVerifyResult): string {
  const lines = [`verified draft ${value.draftId}: ${value.checks.join(", ")}`];
  for (const anchor of value.anchors?.anchors ?? []) {
    const basis = [anchor.provider, anchor.timeBasis].filter((part) => part !== undefined).join(", ");
    lines.push(
      `anchor ${anchor.subject ?? "unknown"}: ${basis.length === 0 ? "unknown provider/time basis" : basis}, `
      + `${anchor.status}, record ${anchor.recordSha256}`,
    );
    lines.push(`  ${evaluationNote(anchor)}`);
  }
  if (value.anchors !== undefined) {
    lines.push(renderSubjects(value.anchors));
  }
  if (value.anchoringWindow !== undefined) {
    lines.push("unresolved pending anchor evidence exists and `report` closes the anchoring window.");
  }
  return `${lines.join("\n")}\n`;
}
