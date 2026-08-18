import { SUPPORTED_BUNDLE_FORMATS } from "./manifest.js";
import { EVIDENCE_NATIVE_BUNDLE_V5_CHECKS } from "@jinn-network/benchmarking-evidence";
import { PUBLIC_BUNDLE_VERIFICATION_CHECKS, PUBLIC_BUNDLE_V6_CHECKS } from "./reader-instructions.js";
import { verifyPublicBundle, type PublicBundleVerificationResult } from "./verify.js";
import { VERIFIER_VERSION } from "./version.js";

export { VERIFIER_VERSION } from "./version.js";

export interface VerifierCliResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VerifierCliDeps {
  readonly verify?: (bundleDir: string) => Promise<PublicBundleVerificationResult>;
}

function usage(): string {
  return "Usage: colophon-verify <bundle> [--json]\nExit 0: valid bundle; 1: invalid bundle; 2: usage or operational failure.\n";
}

export function renderVerifiedBundle(result: PublicBundleVerificationResult): string {
  const checks = result.checks.map((check) => `${check.padEnd(24)}passed`).join("\n");
  const totalChecks = result.format === "benchmark-product-public-bundle/5"
    ? EVIDENCE_NATIVE_BUNDLE_V5_CHECKS.length
    : result.format === "benchmark-product-public-bundle/6"
      ? PUBLIC_BUNDLE_V6_CHECKS.length
      : PUBLIC_BUNDLE_VERIFICATION_CHECKS.length;
  const identity = result.identity.startsWith("sha256:") ? result.identity : `sha256:${result.identity}`;
  return `Verified: ${result.checks.length} of ${totalChecks} checks passed
Bundle: ${identity}
Format: ${result.format}

${checks}

This checks the bundle's integrity, evidence closure, calculations, report,
and claim consistency. It does not prove that the machine that produced the
bundle was honest or that the compared identities are independent parties.
No files were uploaded.
`;
}

export async function runVerifierCli(
  args: readonly string[],
  deps: VerifierCliDeps = {},
): Promise<VerifierCliResult> {
  const json = args.includes("--json");
  const positional = args.filter((arg) => arg !== "--json");
  if (positional.length !== 1 || args.some((arg) => arg !== "--json" && arg !== positional[0])) {
    return { exitCode: 2, stdout: "", stderr: usage() };
  }

  try {
    const result = await (deps.verify ?? verifyPublicBundle)(positional[0]!);
    const stdout = json
      ? `${JSON.stringify({ ok: true, verifierVersion: VERIFIER_VERSION, supportedFormats: SUPPORTED_BUNDLE_FORMATS, ...result })}\n`
      : renderVerifiedBundle(result);
    return { exitCode: 0, stdout, stderr: "" };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const code = (cause !== null && typeof cause === "object" && "code" in cause)
      ? String((cause as { code?: unknown }).code) : "environment";
    const stdout = json
      ? `${JSON.stringify({ ok: false, verifierVersion: VERIFIER_VERSION, supportedFormats: SUPPORTED_BUNDLE_FORMATS, code, message: error.message })}\n`
      : "";
    const stderr = json ? "" : `colophon-verify: ${error.message}\n`;
    return { exitCode: code === "record-integrity" ? 1 : 2, stdout, stderr };
  }
}
