import type { ParserIdentity } from "./family-blocks.js";

/**
 * Deployment-side execution allowlist lookup key for a parser identity (§7.2/§11). A parser
 * identity is always structurally valid on its own — whether a given deployment actually trusts
 * and executes that parser is a runtime allowlist decision entirely outside this package. This
 * function never executes anything: it is a pure string projection a deployment uses as an
 * allowlist map key, never a document-validity gate.
 */
export function parserAllowlistKey(parser: ParserIdentity): string {
  return `${parser.id}@${parser.version}#${parser.digest}`;
}
