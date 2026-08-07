import type { MatrixRecord, ReportRecord } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import type { ClaimPackage } from "../report/claim.js";

export interface PublicAssetInput {
  readonly claim: ClaimPackage;
  readonly matrix: MatrixRecord;
  readonly report: ReportRecord;
  readonly reportSha256: string;
  readonly matrixSha256: string;
  readonly dissentCellKeys: readonly string[];
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function summary(input: PublicAssetInput) {
  return {
    scope: {
      tasks: input.claim.scope.taskCount,
      arms: input.claim.scope.arms.length,
      replicates: input.claim.scope.replicates,
      venue: input.claim.scope.venue,
    },
    completeness: input.matrix.completeness,
    attrition: input.matrix.attrition,
    conflicts: input.claim.conflicted,
    dissentCellKeys: [...input.dissentCellKeys].sort(),
    limitations: [...(input.report.limitations ?? [])],
  };
}

/** Fixed BP-40 presentation bytes. BP-41 may enrich appearance, but it must preserve these paths
 * and re-derive every byte from the already verified neutral facts. */
export function buildPublicAssets(input: PublicAssetInput): Readonly<Record<string, Uint8Array>> {
  const facts = summary(input);
  const factJson = new TextDecoder().decode(canonicalJsonBytes(facts));
  const noWinner = "No comparative winner is stated; wilson@1 reports neutral per-arm facts only.";
  const adverse = `Conflicts: ${facts.conflicts.count}; dissenting cells: ${facts.dissentCellKeys.length}; limitations: ${facts.limitations.length}.`;
  const text = new TextEncoder();
  const scope = `${facts.scope.tasks} tasks, ${facts.scope.arms} arms, ${facts.scope.replicates} replicates, ${facts.scope.venue}`;
  return {
    "index.html": text.encode(
      "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">"
      + "<title>Benchmark report</title><main><h1>Benchmark report</h1>"
      + `<p>${escapeHtml(scope)}</p><p>${escapeHtml(noWinner)}</p><p>${escapeHtml(adverse)}</p>`
      + `<p>Report SHA-256: <code>${input.reportSha256}</code></p><p>Matrix SHA-256: <code>${input.matrixSha256}</code></p>`
      + `<h2>Verified facts</h2><pre>${escapeHtml(factJson)}</pre>`
      + "<p>Verify after copying this directory: <code>benchmark-product bundle verify --bundle . --json</code></p></main></html>",
    ),
    "badge.svg": text.encode(
      `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Benchmark record; no winner stated" width="260" height="32"><rect width="260" height="32" fill="#171717"/><text x="12" y="21" fill="#fff" font-family="sans-serif" font-size="14">Benchmark record · no winner stated</text></svg>`,
    ),
    "social-card.svg": text.encode(
      `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Benchmark report; no winner stated" width="1200" height="630"><rect width="1200" height="630" fill="#fafafa"/><text x="80" y="220" fill="#171717" font-family="sans-serif" font-size="72">Benchmark report</text><text x="80" y="300" fill="#525252" font-family="sans-serif" font-size="34">${escapeHtml(scope)}</text><text x="80" y="370" fill="#525252" font-family="sans-serif" font-size="28">${escapeHtml(adverse)}</text><text x="80" y="440" fill="#171717" font-family="sans-serif" font-size="28">No comparative winner stated</text><text x="80" y="520" fill="#525252" font-family="monospace" font-size="22">${input.reportSha256}</text></svg>`,
    ),
    "README.md": text.encode(
      `# Benchmark report\n\nScope: ${scope}.\n\n${noWinner}\n\n${adverse}\n\n## Completeness, attrition, conflicts, dissent, and limitations\n\n\`\`\`json\n${factJson}\n\`\`\`\n\nReport SHA-256: \`${input.reportSha256}\`\n\nMatrix SHA-256: \`${input.matrixSha256}\`\n\nVerify this copied bundle without its source workspace:\n\n\`benchmark-product bundle verify --bundle . --json\`\n`,
    ),
    "share.txt": text.encode(
      `Benchmark report ${input.reportSha256}. ${scope}. ${adverse} ${noWinner} Verify with: benchmark-product bundle verify --bundle <bundle-dir> --json\n`,
    ),
  };
}
