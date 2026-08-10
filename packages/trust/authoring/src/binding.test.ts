// SPDX-License-Identifier: Apache-2.0

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ceremonyEvidenceDigest, validateKeyBinding, type KeyBinding } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import { authorRoleBinding } from "./binding.js";
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
  it("binds validFrom to the VERBATIM anchor-time string (§6 law 2)", async () => {
    const signers = await solverSigners();
    const role = signers.get("solver-delivery")!;
    const ceremony = await performEoaCeremony({
      signer, agent: AGENT, didKey: role.keyId, issuedAt: ANCHOR_TIME,
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
  });

  it("refuses a validFrom that is merely the same instant in a different spelling", async () => {
    const signers = await solverSigners();
    const role = signers.get("solver-delivery")!;
    const ceremony = await performEoaCeremony({
      signer, agent: AGENT, didKey: role.keyId, issuedAt: ANCHOR_TIME,
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

  it("requires exactly three ceremony resources for a settlement-scoped role (§2.3b)", async () => {
    const signers = await solverSigners();
    const role = signers.get("solver-settlement")!;
    const twoResource = await performEoaCeremony({
      signer, agent: AGENT, didKey: role.keyId, issuedAt: ANCHOR_TIME,
    });
    await expect(authorRoleBinding({
      role: "solver-settlement",
      signer: role,
      agent: AGENT,
      ceremonyAccount: EOA,
      ceremony: twoResource,
      validFrom: ANCHOR_TIME,
      anchorDigest: ANCHOR,
    })).rejects.toThrow(/exactly 3 ceremony resources/u);

    const threeResource = await performEoaCeremony({
      signer, agent: AGENT, didKey: role.keyId, issuedAt: ANCHOR_TIME, settlementSafe: SAFE,
    });
    const entry = await authorRoleBinding({
      role: "solver-settlement",
      signer: role,
      agent: AGENT,
      ceremonyAccount: EOA,
      ceremony: threeResource,
      validFrom: ANCHOR_TIME,
      anchorDigest: ANCHOR,
    });
    expect(payloadOf(entry.envelopeBytes).scope).toEqual(["settlements"]);
    expect(entry.ceremony.message.resources[2]).toBe(`did:pkh:eip155:84532:${SAFE}`);
  });

  it("requires exactly two ceremony resources for a non-settlement role", async () => {
    const signers = await solverSigners();
    const role = signers.get("solver-delivery")!;
    const ceremony = await performEoaCeremony({
      signer, agent: AGENT, didKey: role.keyId, issuedAt: ANCHOR_TIME, settlementSafe: SAFE,
    });
    await expect(authorRoleBinding({
      role: "solver-delivery",
      signer: role,
      agent: AGENT,
      ceremonyAccount: EOA,
      ceremony,
      validFrom: ANCHOR_TIME,
      anchorDigest: ANCHOR,
    })).rejects.toThrow(/exactly 2 ceremony resources/u);
  });

  it("refuses a ceremony that names a different agent or key", async () => {
    const signers = await solverSigners();
    const role = signers.get("solver-delivery")!;
    const other = signers.get("solver-settlement")!;
    const ceremony = await performEoaCeremony({
      signer, agent: AGENT, didKey: role.keyId, issuedAt: ANCHOR_TIME,
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
