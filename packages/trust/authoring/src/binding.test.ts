// SPDX-License-Identifier: Apache-2.0

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindingTermsCommitment,
  ceremonyCurrencyFailure,
  ceremonyEvidenceDigest,
  matchCeremonyContent,
  serializeCeremonyMessage,
  validateKeyBinding,
  type KeyBinding,
} from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import { authorRoleBinding, roleBindingTerms } from "./binding.js";
import { performEoaCeremony } from "./ceremony.js";
import { openRoleSigners, type RoleSigner } from "./signers.js";
import type { NativeRoleIdentityRole } from "./roles.js";

const PASSWORD = "trust-authoring-binding-password";
const EOA = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const SAFE = "0x8464135c8F25Da09e49BC8782676a84730C318bC" as const;
const AGENT = "urn:uuid:00000000-0000-4000-8000-00000000000a";
const ANCHOR = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const;
/** Millisecond ISO, exactly the form `submitAnchor` emits from the mined block's timestamp. */
const ANCHOR_TIME = "2026-08-07T12:34:56.000Z";

const signer = {
  address: EOA,
  async signMessage(): Promise<`0x${string}`> { return `0x${"22".repeat(65)}`; },
};

async function solverSigners(): Promise<ReadonlyMap<NativeRoleIdentityRole, RoleSigner>> {
  const root = await mkdtemp(join(tmpdir(), "trust-authoring-binding-"));
  return openRoleSigners({
    storePath: join(root, "solver.enc.json"),
    password: PASSWORD,
    ownedRoles: ["solver-delivery", "solver-settlement"],
    create: true,
  });
}

function payloadOf(envelopeBytes: Uint8Array): KeyBinding {
  const report = validateKeyBinding(envelopeBytes);
  expect(report.conforms).toBe(true);
  return report.value!;
}

describe("authorRoleBinding", () => {
  it("binds validFrom to the VERBATIM anchor-time string and commits the ceremony to the binding's terms (§6 law 2, ceremony currency §2)", async () => {
    const signers = await solverSigners();
    const role = signers.get("solver-delivery")!;
    const terms = roleBindingTerms("solver-delivery", ANCHOR_TIME);
    const ceremony = await performEoaCeremony({
      signer, agent: AGENT, didKey: role.keyId, issuedAt: ANCHOR_TIME, terms,
    });
    const entry = await authorRoleBinding({
      role: "solver-delivery",
      signer: role,
      agent: AGENT,
      ceremonyAccount: EOA,
      ceremony,
      validFrom: ANCHOR_TIME,
      anchorDigest: ANCHOR,
    });
    const binding = payloadOf(entry.envelopeBytes);
    expect(binding.validFrom).toBe(ANCHOR_TIME);
    expect(binding.validFrom).toBe(ceremony.message.issuedAt);
    expect(binding.agent).toBe(AGENT);
    expect(binding.key.didKey).toBe(role.keyId);
    expect(binding.key.keyid).toBe(role.keyId);
    expect(binding.relationship).toBe("controls");
    expect(binding.strength).toBe("strong");
    expect(binding.scope).toEqual(["deliveries"]);
    expect(binding.voucher).toEqual({ kind: "account", did: `did:pkh:eip155:84532:${EOA}`, contractAccount: false });
    expect(binding.anchors).toEqual([{ digest: ANCHOR }]);
    expect(binding.ceremony).toEqual({ type: "eoa", digest: ceremonyEvidenceDigest(ceremony) });
    expect(entry.ceremony.message.resources).toEqual([
      AGENT,
      role.keyId,
      bindingTermsCommitment(terms),
    ]);
    // Content match passes with the rule off, and ceremonyCurrencyFailure passes with the rule on.
    expect(matchCeremonyContent(entry.ceremony, binding)).toEqual({ matches: true });
    expect(ceremonyCurrencyFailure(entry.ceremony.message, binding, {
      profile: { termsCutover: ANCHOR_TIME },
      effectiveStart: ANCHOR_TIME,
    })).toBeUndefined();
  });

  it("refuses a validFrom that is merely the same instant in a different spelling", async () => {
    const signers = await solverSigners();
    const role = signers.get("solver-delivery")!;
    const ceremony = await performEoaCeremony({
      signer,
      agent: AGENT,
      didKey: role.keyId,
      issuedAt: ANCHOR_TIME,
      terms: roleBindingTerms("solver-delivery", ANCHOR_TIME),
    });
    await expect(authorRoleBinding({
      role: "solver-delivery",
      signer: role,
      agent: AGENT,
      ceremonyAccount: EOA,
      ceremony,
      // Same instant, different string — the resolver compares these lexicographically.
      validFrom: "2026-08-07T12:34:56Z",
      anchorDigest: ANCHOR,
    })).rejects.toThrow(/verbatim anchor block time/u);
  });

  it("requires four ceremony resources (Safe ahead of terms commitment) for a settlement-scoped role (§2.3b, ceremony currency §3)", async () => {
    const signers = await solverSigners();
    const role = signers.get("solver-settlement")!;
    const terms = roleBindingTerms("solver-settlement", ANCHOR_TIME);
    const withoutSafe = await performEoaCeremony({
      signer, agent: AGENT, didKey: role.keyId, issuedAt: ANCHOR_TIME, terms,
    });
    await expect(authorRoleBinding({
      role: "solver-settlement",
      signer: role,
      agent: AGENT,
      ceremonyAccount: EOA,
      ceremony: withoutSafe,
      validFrom: ANCHOR_TIME,
      anchorDigest: ANCHOR,
    })).rejects.toThrow(/exactly 4 ceremony resources/u);

    const withSafe = await performEoaCeremony({
      signer, agent: AGENT, didKey: role.keyId, issuedAt: ANCHOR_TIME, terms, settlementSafe: SAFE,
    });
    const entry = await authorRoleBinding({
      role: "solver-settlement",
      signer: role,
      agent: AGENT,
      ceremonyAccount: EOA,
      ceremony: withSafe,
      validFrom: ANCHOR_TIME,
      anchorDigest: ANCHOR,
    });
    const binding = payloadOf(entry.envelopeBytes);
    expect(binding.scope).toEqual(["settlements"]);
    expect(entry.ceremony.message.resources).toEqual([
      AGENT,
      role.keyId,
      `did:pkh:eip155:84532:${SAFE}`,
      bindingTermsCommitment(terms),
    ]);
    expect(ceremonyCurrencyFailure(entry.ceremony.message, binding, {
      profile: { termsCutover: ANCHOR_TIME },
      effectiveStart: ANCHOR_TIME,
    })).toBeUndefined();
  });

  it("requires three ceremony resources (no Safe, with terms commitment) for a non-settlement role", async () => {
    const signers = await solverSigners();
    const role = signers.get("solver-delivery")!;
    const terms = roleBindingTerms("solver-delivery", ANCHOR_TIME);
    const ceremony = await performEoaCeremony({
      signer, agent: AGENT, didKey: role.keyId, issuedAt: ANCHOR_TIME, terms, settlementSafe: SAFE,
    });
    await expect(authorRoleBinding({
      role: "solver-delivery",
      signer: role,
      agent: AGENT,
      ceremonyAccount: EOA,
      ceremony,
      validFrom: ANCHOR_TIME,
      anchorDigest: ANCHOR,
    })).rejects.toThrow(/exactly 3 ceremony resources/u);

    const uncommittedMessage = { ...ceremony.message, resources: [AGENT, role.keyId] };
    await expect(authorRoleBinding({
      role: "solver-delivery",
      signer: role,
      agent: AGENT,
      ceremonyAccount: EOA,
      ceremony: {
        ...ceremony,
        message: uncommittedMessage,
        messageBytes: serializeCeremonyMessage("eoa", uncommittedMessage),
      },
      validFrom: ANCHOR_TIME,
      anchorDigest: ANCHOR,
    })).rejects.toThrow(/exactly 3 ceremony resources/u);
  });

  it("refuses a ceremony whose commitment is for different binding terms", async () => {
    const signers = await solverSigners();
    const delivery = signers.get("solver-delivery")!;
    const wrongTermsCeremony = await performEoaCeremony({
      signer,
      agent: AGENT,
      didKey: delivery.keyId,
      issuedAt: ANCHOR_TIME,
      terms: roleBindingTerms("solver-discovery", ANCHOR_TIME),
    });
    await expect(authorRoleBinding({
      role: "solver-delivery",
      signer: delivery,
      agent: AGENT,
      ceremonyAccount: EOA,
      ceremony: wrongTermsCeremony,
      validFrom: ANCHOR_TIME,
      anchorDigest: ANCHOR,
    })).rejects.toThrow(/ceremony commits to terms/u);

    const settlement = signers.get("solver-settlement")!;
    const settlementTerms = roleBindingTerms("solver-settlement", ANCHOR_TIME);
    const validSettlement = await performEoaCeremony({
      signer,
      agent: AGENT,
      didKey: settlement.keyId,
      issuedAt: ANCHOR_TIME,
      terms: settlementTerms,
      settlementSafe: SAFE,
    });
    const doubleCommitmentMessage = {
      ...validSettlement.message,
      resources: [
        AGENT,
        settlement.keyId,
        bindingTermsCommitment(roleBindingTerms("solver-delivery", ANCHOR_TIME)),
        bindingTermsCommitment(settlementTerms),
      ],
    };
    await expect(authorRoleBinding({
      role: "solver-settlement",
      signer: settlement,
      agent: AGENT,
      ceremonyAccount: EOA,
      ceremony: {
        ...validSettlement,
        message: doubleCommitmentMessage,
        messageBytes: serializeCeremonyMessage("eoa", doubleCommitmentMessage),
      },
      validFrom: ANCHOR_TIME,
      anchorDigest: ANCHOR,
    })).rejects.toThrow(/2 terms commitments/u);
  });

  it("refuses a ceremony that names a different agent or key", async () => {
    const signers = await solverSigners();
    const role = signers.get("solver-delivery")!;
    const other = signers.get("solver-settlement")!;
    const ceremony = await performEoaCeremony({
      signer,
      agent: AGENT,
      didKey: role.keyId,
      issuedAt: ANCHOR_TIME,
      terms: roleBindingTerms("solver-delivery", ANCHOR_TIME),
    });
    await expect(authorRoleBinding({
      role: "solver-delivery",
      signer: role,
      agent: "urn:uuid:00000000-0000-4000-8000-00000000000b",
      ceremonyAccount: EOA,
      ceremony,
      validFrom: ANCHOR_TIME,
      anchorDigest: ANCHOR,
    })).rejects.toThrow(/ceremony resources name agent/u);
    await expect(authorRoleBinding({
      role: "solver-delivery",
      signer: { ...other, role: "solver-delivery" },
      agent: AGENT,
      ceremonyAccount: EOA,
      ceremony,
      validFrom: ANCHOR_TIME,
      anchorDigest: ANCHOR,
    })).rejects.toThrow(/ceremony resources name key/u);
  });
});
