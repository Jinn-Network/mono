// SPDX-License-Identifier: MIT

/** DSSE in-toto Statement binding conformance (substrate §5.2, §8). */

import { describe, expect, it } from "vitest";

import {
  preAuthenticationEncoding,
  verifyCandidateStatementBinding,
  verifyEd25519Signature,
} from "./conformance.js";
import { loadFixtureDirectory } from "./fixtures.js";
import type { DsseEnvelope } from "./conformance.js";

interface DsseFixture {
  readonly name: string;
  readonly envelope: DsseEnvelope;
  readonly publicKeyHex: string;
  readonly signatureHex: string;
  readonly expect: Record<string, unknown>;
}

const golden = loadFixtureDirectory("dsse", "golden") as unknown as DsseFixture[];
const adversarial = loadFixtureDirectory("dsse", "adversarial") as unknown as DsseFixture[];

describe("DSSE in-toto Statement — golden", () => {
  for (const fixture of golden) {
    const expected = fixture.expect as { manifestDigest: string };

    it(`${fixture.name}: the binding verifies and yields the pinned manifest digest`, () => {
      const result = verifyCandidateStatementBinding(fixture.envelope);
      expect(result.ok).toBe(true);
    });

    it(`${fixture.name}: the pinned signature is REAL — verified over the DSSE PAE`, () => {
      expect(verifyEd25519Signature(fixture.envelope, fixture.publicKeyHex, fixture.signatureHex)).toBe(true);
    });

    it(`${fixture.name}: the PAE is the DSSEv1 encoding, not the bare payload`, () => {
      const payload = Uint8Array.from(atob(fixture.envelope.payload), (c) => c.charCodeAt(0));
      const pae = preAuthenticationEncoding(fixture.envelope.payloadType, payload);
      expect(new TextDecoder().decode(pae.slice(0, 6))).toBe("DSSEv1");
      expect(new TextDecoder().decode(pae)).toContain(
        `DSSEv1 ${fixture.envelope.payloadType.length} ${fixture.envelope.payloadType} ${payload.length} `,
      );
    });

    it(`${fixture.name}: a one-byte payload edit breaks the signature`, () => {
      const tampered: DsseEnvelope = {
        ...fixture.envelope,
        payload: btoa(atob(fixture.envelope.payload).replace("candidate/1.0", "candidate/1.1")),
      };
      expect(verifyEd25519Signature(tampered, fixture.publicKeyHex, fixture.signatureHex)).toBe(false);
    });

    it(`${fixture.name}: the subject digest matches the pinned manifest digest`, () => {
      const statement = JSON.parse(atob(fixture.envelope.payload)) as {
        subject: { digest: { sha256: string } }[];
      };
      expect(`sha256:${statement.subject[0]?.digest.sha256}`).toBe(expected.manifestDigest);
    });
  }
});

describe("DSSE in-toto Statement — adversarial", () => {
  for (const fixture of adversarial) {
    const expected = fixture.expect as { code: string; path: string; signatureValid: boolean };

    it(`${fixture.name}: the SIGNATURE is valid — so signature verification alone would pass`, () => {
      // The point of both negatives. An attacker does not need to forge a signature; they need
      // a verifier that stops once the signature checks out.
      expect(verifyEd25519Signature(fixture.envelope, fixture.publicKeyHex, fixture.signatureHex)).toBe(
        expected.signatureValid,
      );
    });

    it(`${fixture.name}: the BINDING is refused at ${expected.path}`, () => {
      const result = verifyCandidateStatementBinding(fixture.envelope);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.map(({ code, path }) => ({ code, path }))).toContainEqual({
        code: expected.code,
        path: expected.path,
      });
    });
  }
});

describe("DSSE envelope structure", () => {
  const base = golden[0];

  it("refuses a payloadType other than the pinned in-toto media type", () => {
    if (base === undefined) throw new Error("no golden DSSE fixture");
    const result = verifyCandidateStatementBinding({ ...base.envelope, payloadType: "application/json" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((issue) => issue.path === "payloadType")).toBe(true);
  });

  it("refuses an envelope with no signatures — raw-bytes signing is not a conforming alternative", () => {
    if (base === undefined) throw new Error("no golden DSSE fixture");
    const result = verifyCandidateStatementBinding({ ...base.envelope, signatures: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((issue) => issue.path === "signatures")).toBe(true);
  });

  it("refuses a payload that is not strict base64", () => {
    if (base === undefined) throw new Error("no golden DSSE fixture");
    const result = verifyCandidateStatementBinding({ ...base.envelope, payload: "not base64!!" });
    expect(result.ok).toBe(false);
  });

  it("refuses a Statement whose _type is not the in-toto v1 Statement type", () => {
    if (base === undefined) throw new Error("no golden DSSE fixture");
    const statement = JSON.parse(atob(base.envelope.payload)) as Record<string, unknown>;
    statement["_type"] = "https://in-toto.io/Statement/v0.1";
    const result = verifyCandidateStatementBinding({
      ...base.envelope,
      payload: btoa(JSON.stringify(statement)),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((issue) => issue.path === "payload._type")).toBe(true);
  });
});
