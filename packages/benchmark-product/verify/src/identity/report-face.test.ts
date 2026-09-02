// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { domainBindingProof, DOMAIN_BINDING_FORMAT, type VerifiedDomainBinding } from "./domain-binding.js";
import {
  publisherIdentityClass,
  publisherIdentityLine,
  publisherIdentitySentence,
} from "./report-face.js";

const KEY_ID = "did:key:zH3C2AVvLMv6gmMNam3uVAjZpfkcJCwDwnZn6z3wXmqPV";

function binding(mechanism: VerifiedDomainBinding["mechanism"]): VerifiedDomainBinding {
  return {
    format: DOMAIN_BINDING_FORMAT,
    domain: "example.com",
    keyId: KEY_ID,
    mechanism,
    statedAt: "2026-09-02T00:00:00.000Z",
    proof: domainBindingProof("example.com", KEY_ID, mechanism),
  };
}

describe("publisher identity report face (issue #2983)", () => {
  test("classifies bound and unbound publication", () => {
    expect(publisherIdentityClass(undefined)).toBe("bare-key");
    expect(publisherIdentityClass(binding("dns-txt"))).toBe("domain-bound");
  });

  test("renders the domain with the proof mechanism named plainly", () => {
    expect(publisherIdentityLine(binding("dns-txt"), "sha256:aa"))
      .toBe("published by example.com — DNS TXT record at _colophon.example.com");
    expect(publisherIdentityLine(binding("well-known-url"), "sha256:aa"))
      .toBe("published by example.com — well-known URL at https://example.com/.well-known/colophon-domain-binding.txt");
  });

  test("renders the bare key fingerprint when nothing is bound", () => {
    expect(publisherIdentityLine(undefined, "sha256:aa")).toBe("no domain bound; key sha256:aa");
  });

  test("says so plainly when there is not even a fingerprint to render", () => {
    expect(publisherIdentityLine(undefined, undefined))
      .toBe("no domain bound; this key carries no fingerprint this reader can compute");
  });

  test("states exactly what trusting the binding rests on: DNS, the zone holder, and the registrar", () => {
    const sentence = publisherIdentitySentence(binding("dns-txt"))!;
    expect(sentence).toContain("checked that signature offline");
    expect(sentence).toContain("derived from that key, not taken from");
    expect(sentence).toContain("_colophon.example.com");
    expect(sentence).toContain("colophon-domain-binding=1; key=");
    expect(sentence).toContain("DNS resolution");
    expect(sentence).toContain("registrar");
    expect(sentence).toContain("says nothing about what the zone held when this bundle was made");
  });

  test("adds no paragraph about the limits of a binding that is not there", () => {
    expect(publisherIdentitySentence(undefined)).toBeUndefined();
  });
});
