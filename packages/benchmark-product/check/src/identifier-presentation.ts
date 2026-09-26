// SPDX-License-Identifier: Apache-2.0

/**
 * Presentation rewrite of Jinn protocol identifiers (issue #2981).
 *
 * The identifiers themselves stay in sealed records and `--json`. Reader-facing strings must not
 * name an origin a stranger cannot resolve, so this pass keeps the path (the name) and drops the
 * host (the invitation to fetch).
 */

/** URL candidates are classified in the replacer so an actionable third-party URL remains intact. */
const PROTOCOL_IDENTIFIER_CANDIDATE =
  /https?:\/\/[^\s,;)"']*|jinn\.(?:network|benchmarking)[^\s,;)"']*/gu;
const INTERNAL_PROTOCOL_URL =
  /^https?:\/\/(?:[^/?#]*\.)?jinn\.(?:network|benchmarking)(?::[0-9]+)?(?:[/?#]|$)/u;

export function rewriteInternalProtocolIdentifiers(
  text: string,
  alias: (match: string) => string,
): string {
  return text.replace(PROTOCOL_IDENTIFIER_CANDIDATE, (match) => {
    if (match.startsWith("http") && !INTERNAL_PROTOCOL_URL.test(match)) return match;
    return alias(match);
  });
}

/** Path remainder of an unhosted Jinn URL, or the namespace-stripped method/extension name. */
export function presentProtocolAlias(match: string): string {
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

/** Reader-facing rewrite: names stay, unhosted origins do not. */
export function presentInternalProtocolIdentifiers(text: string): string {
  return rewriteInternalProtocolIdentifiers(text, presentProtocolAlias);
}
