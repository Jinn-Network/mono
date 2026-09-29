// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #2981: GUI reader surfaces print a Jinn protocol identifier whole only when the spec origin
 * serves it, so a reader can follow it; any other Jinn identifier keeps its name without the
 * origin. Sealed records and server JSON keep the raw spelling.
 *
 * This package does not depend on `@colophon-claims/check`, so the rule is a copy of that package's
 * `src/identifier-presentation.ts`. `present-protocol-profile.test.ts` fails when the two served
 * sets differ.
 */

/** The protocol spec origin. No other Jinn host serves protocol documents. */
const SPEC_ORIGIN = "https://spec.jinn.network/";

/**
 * Every path the Jinn protocol spec release `v0.1.0` (`Jinn-Network/spec`) serves at `SPEC_ORIGIN`,
 * less its conformance fixtures. Exact paths, not path prefixes; see the verifier's copy.
 */
export const SPEC_RELEASE_SERVED_PATHS: ReadonlySet<string> = new Set([
  "facts/authorization/v1",
  "facts/authorization/v2",
  "facts/chain-environment/v1",
  "facts/chain-environment/v2",
  "facts/checkpoint/v1",
  "facts/crypto-environment/v1",
  "facts/crypto-environment/v2",
  "facts/delivery/v1",
  "facts/delivery/v2",
  "facts/environment/v1",
  "facts/environment/v2",
  "facts/evaluation-spec/v1",
  "facts/evaluation-spec/v2",
  "facts/execution-evidence/v1",
  "facts/execution-evidence/v2",
  "facts/execution-evidence/v3",
  "facts/execution-verification/v1",
  "facts/execution-verification/v2",
  "facts/information-world/v1",
  "facts/information-world/v2",
  "facts/key-binding/v1",
  "facts/key-binding/v2",
  "facts/offer/v1",
  "facts/plugin/v1",
  "facts/profile-document/v1",
  "facts/profile-document/v2",
  "facts/result-evaluation/v1",
  "facts/result-evaluation/v2",
  "facts/result-evaluation/v3",
  "facts/submission/v1",
  "facts/task/v1",
  "facts/task/v2",
  "facts/trust-policy/v1",
  "profile/v1/specification.md",
  "profiles/binary-judgment/parsers/binary-accept-reject/1.0.0/semantics.json",
  "profiles/binary-judgment/parsers/binary-complete-json-label/1.0.0/semantics.json",
  "profiles/binary-judgment/parsers/binary-complete-json-label/2.0.0/semantics.json",
  "profiles/binary-judgment/parsers/binary-correct-wrong/1.0.0/semantics.json",
  "profiles/binary-judgment/parsers/binary-evermem-json-label/1.0.0/semantics.json",
  "profiles/binary-judgment/parsers/binary-evermem-json-label/2.0.0/semantics.json",
  "profiles/binary-judgment/parsers/binary-json-verdict/1.0.0/semantics.json",
  "profiles/binary-judgment/parsers/binary-judgment-evaluation/1.0.0/semantics.json",
  "profiles/binary-judgment/parsers/binary-judgment-evaluation/2.0.0/semantics.json",
  "profiles/binary-judgment/parsers/binary-label-in-prose/1.0.0/semantics.json",
  "profiles/binary-judgment/parsers/binary-mem0-json-label/1.0.0/semantics.json",
  "profiles/binary-judgment/parsers/binary-mem0-json-label/2.0.0/semantics.json",
  "profiles/binary-judgment/parsers/binary-strict-json-label/1.0.0/semantics.json",
  "profiles/binary-judgment/parsers/binary-strict-json-label/2.0.0/semantics.json",
  "profiles/binary-judgment/parsers/binary-yes-no/1.0.0/semantics.json",
  "profiles/evidence-repository-ipfs-registration/v1/registration.schema.json",
  "profiles/evidence-repository-oci/v1/schemas/evidence-oci-manifest.schema.json",
  "profiles/evidence-repository-oci/v1/specification.md",
  "profiles/execution-evidence/v1/ro-crate-metadata.json",
  "profiles/execution-evidence/v1/schemas/dsse-envelope.schema.json",
  "profiles/execution-evidence/v1/schemas/execution-evidence-document.schema.json",
  "profiles/execution-evidence/v1/schemas/execution-verification-statement.schema.json",
  "profiles/execution-evidence/v1/schemas/resource-descriptor.schema.json",
  "profiles/execution-evidence/v1/schemas/result-evaluation-statement.schema.json",
  "profiles/execution-evidence/v1/specification.md",
  "profiles/execution-evidence/v1/vocabulary.jsonld",
  "profiles/task-execution/v1",
  "profiles/task-profile/v1",
  "profiles/trace-vocabulary/v1",
  "schemas/chain-environment/v1",
  "schemas/crypto-environment/v1",
  "schemas/delivery.schema.json",
  "schemas/dispatch-context.schema.json",
  "schemas/environment/v1",
  "schemas/information-world/v1",
  "schemas/observation.schema.json",
  "schemas/submission.schema.json",
  "schemas/task.schema.json",
  "schemas/trace-derivation-statement/v1",
  "schemas/trace/v1",
  "task-profiles/binary-judgment/2.0",
  "task-profiles/evaluation-task/1.0",
  "task-profiles/prediction-forecast/1.0",
  "task-profiles/repository-work/1.0",
]);

const PROTOCOL_IDENTIFIER_CANDIDATE =
  /https?\\?:\/\/[^\s,;)"'&<>\\]*|jinn\.(?:network|benchmarking)[^\s,;)"'&<>\\]*/gu;
const INTERNAL_PROTOCOL_URL =
  /^https?:\/\/(?:[^/?#]*\.)?jinn\.(?:network|benchmarking)(?::[0-9]+)?(?:[/?#]|$)/u;

function resolvesAtSpecOrigin(url: string): boolean {
  if (!url.startsWith(SPEC_ORIGIN)) return false;
  return SPEC_RELEASE_SERVED_PATHS.has(url.slice(SPEC_ORIGIN.length).replace(/\.+$/u, ""));
}

function presentProtocolAlias(match: string): string {
  const trailing = /[.,;]+$/u.exec(match)?.[0] ?? "";
  const body = trailing === "" ? match : match.slice(0, -trailing.length);
  if (body.startsWith("http")) {
    const named = /^https?:\/\/[^/]+\/(?:[^/]+\/)*anchor-profiles\/(.+)$/u.exec(body)?.[1];
    if (named !== undefined && named !== "") return `${named}${trailing}`;
    const path = /^https?:\/\/[^/?#]+(\/[^?#]*)?/u.exec(body)?.[1] ?? "";
    const presented = path.replace(/^\//u, "");
    return `${presented === "" ? "<protocol identifier>" : presented}${trailing}`;
  }
  if (body.startsWith("jinn.benchmarking.")) {
    return `${body.slice("jinn.benchmarking.".length)}${trailing}`;
  }
  if (body.startsWith("jinn.network/")) {
    return `${body.slice("jinn.network/".length)}${trailing}`;
  }
  return `<protocol identifier>${trailing}`;
}

export function presentProtocolText(text: string): string {
  return text.replace(PROTOCOL_IDENTIFIER_CANDIDATE, (match) => {
    if (!match.startsWith("http")) return presentProtocolAlias(match);
    const url = match.replace(/^(https?)\\:/u, "$1:");
    if (!INTERNAL_PROTOCOL_URL.test(url) || resolvesAtSpecOrigin(url)) return match;
    return presentProtocolAlias(url);
  });
}

export function presentAnchorProfile(profile: string): string {
  return presentProtocolText(profile);
}
