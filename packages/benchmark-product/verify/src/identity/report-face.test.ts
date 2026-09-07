// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { domainBindingProof, DOMAIN_BINDING_FORMAT, type VerifiedDomainBinding } from "./domain-binding.js";
import {
  publisherIdentityClass,
  publisherIdentityLines,
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
    confirmation: "key-signature-only",
  };
}

describe("publisher identity report face (issue #2983)", () => {
  test("classifies bound and unbound publication", () => {
    expect(publisherIdentityClass(undefined)).toBe("bare-key");
    // Never "domain-bound": what was established is that the key CLAIMED the domain.
    expect(publisherIdentityClass(binding("dns-txt"))).toBe("domain-claimed");
  });

  test("renders the domain with the proof mechanism named plainly, and attributively", () => {
    expect(publisherIdentityLines(binding("dns-txt"), "sha256:aa")).toEqual([
      "key sha256:aa",
      "claims publication by example.com — unconfirmed here; check the DNS TXT record at _colophon.example.com",
      `expect: colophon-domain-binding=1; key=${KEY_ID}`,
    ]);
    expect(publisherIdentityLines(binding("well-known-url"), "sha256:aa")[1])
      .toBe("claims publication by example.com — unconfirmed here; check the well-known URL at https://example.com/.well-known/colophon-domain-binding.txt");
  });

  test("never asserts the domain published anything: only the key signature was checked", () => {
    for (const mechanism of ["dns-txt", "well-known-url"] as const) {
      const [, claim] = publisherIdentityLines(binding(mechanism), "sha256:aa");
      expect(claim).not.toMatch(/^published by/);
      expect(claim).toContain("unconfirmed here");
    }
  });

  test("renders the bare key fingerprint when nothing is bound", () => {
    expect(publisherIdentityLines(undefined, "sha256:aa")).toEqual(["key sha256:aa — no domain bound"]);
  });

  test("says so plainly when there is not even a fingerprint to render", () => {
    expect(publisherIdentityLines(undefined, undefined))
      .toEqual(["this key carries no fingerprint this reader can compute — no domain bound"]);
  });

  test("states exactly what trusting the binding rests on: DNS, the zone holder, and the registrar", () => {
    const sentence = publisherIdentitySentence(binding("dns-txt"))!;
    expect(sentence).toContain("checked that signature offline");
    expect(sentence).toContain("derived from that key, not taken from");
    expect(sentence).toContain("actually publishes the record named above");
    expect(sentence).toContain("DNS resolution");
    expect(sentence).toContain("registrar");
    expect(sentence).toContain("says nothing about what the zone held on the date the statement carries");
    // The stated date is surfaced attributively: it is the statement's own field, and the check
    // establishes that the key signed a statement BEARING it, not that it signed AT it.
    expect(sentence).toContain("naming example.com, dated 2026-09-02T00:00:00.000Z");
    expect(sentence).toContain("nothing here places the signature at it");
  });

  test("adds no paragraph about the limits of a binding that is not there", () => {
    expect(publisherIdentitySentence(undefined)).toBeUndefined();
  });
});
