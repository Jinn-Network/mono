/** Public bundle members required by the Colophon bundle profile. */
export const PUBLIC_BUNDLE_FILES = [
  "static-bundle.json", "benchmark.json", "run.json", "matrix.json", "report.json",
  "report-envelope.json", "claim-package.json", "verdicts.json", "evidence.json",
  "verification/assembly.jsonl", "trust/public-keys.json", "index.html", "badge.svg",
  "social-card.svg", "README.md", "share.txt",
] as const;

/** V4 is the fixed v2 graph with exactly one canonical qualification projection added. */
export const PUBLIC_BUNDLE_V4_FILES = [
  ...PUBLIC_BUNDLE_FILES.slice(0, 7),
  "qualification.json",
  ...PUBLIC_BUNDLE_FILES.slice(7),
] as const;
