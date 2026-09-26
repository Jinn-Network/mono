// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #2981: GUI reader surfaces must not name an unhosted origin or dump internal protocol
 * identifiers. Sealed records and server JSON keep the raw spelling.
 */

const PROTOCOL_IDENTIFIER_CANDIDATE =
  /https?:\/\/[^\s,;)"']*|jinn\.(?:network|benchmarking)[^\s,;)"']*/gu;
const INTERNAL_PROTOCOL_URL =
  /^https?:\/\/(?:[^/?#]*\.)?jinn\.(?:network|benchmarking)(?::[0-9]+)?(?:[/?#]|$)/u;

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
    if (match.startsWith("http") && !INTERNAL_PROTOCOL_URL.test(match)) return match;
    return presentProtocolAlias(match);
  });
}

export function presentAnchorProfile(profile: string): string {
  return presentProtocolText(profile);
}
