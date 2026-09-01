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

/**
 * V8 (issue #2839) adds no mandatory MEMBER. The disclosure-specification record travels at the
 * already-allowlisted `records/<sha256>.bin` path, driven by the evidence catalog exactly like every
 * other sealed record, so v8's mandatory list is v7's — which is v4's. The alias exists so the
 * equality is stated in the file that owns member lists rather than inferred at the call site.
 */
export const PUBLIC_BUNDLE_V8_FILES = PUBLIC_BUNDLE_V4_FILES;
