// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealTrustPolicy, validateTrustPolicy, type TrustPolicy } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import { TrustAuthoringError } from "./errors.js";

import { NATIVE_ANCHOR_CHAIN_ID, NATIVE_ANCHOR_PROFILE, type AnchorDeclaration } from "./anchor.js";
import { authorRoleBinding, type SealedBindingEntry } from "./binding.js";
import {
  appendOperator,
  authorCatalog,
  completePolicyPurposes,
  revokeBinding,
  sealPolicySuccessor,
} from "./catalog.js";
import { performEoaCeremony } from "./ceremony.js";
import { openCatalogAuthority, openRoleSigners } from "./signers.js";
import type { NativeRoleIdentityRole } from "./roles.js";

const PASSWORD = "trust-authoring-catalog-password";
const EOA = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const SAFE = "0x8464135c8F25Da09e49BC8782676a84730C318bC" as const;
const AGENT_A = "urn:uuid:00000000-0000-4000-8000-00000000000a";
const AGENT_B = "urn:uuid:00000000-0000-4000-8000-00000000000b";
const ANCHOR_A = "sha256:1111111111111111111111111111111111111111111111111111111111111111" as const;
const ANCHOR_B = "sha256:2222222222222222222222222222222222222222222222222222222222222222" as const;
const TIME_A = "2026-08-07T12:00:00.000Z";
const TIME_B = "2026-08-08T12:00:00.000Z";
const REFRESH_BY = "2027-02-07T00:00:00.000Z";

const signer = {
  address: EOA,
  async signMessage(): Promise<`0x${string}`> { return `0x${"33".repeat(65)}`; },
};

function declaration(digest: `sha256:${string}`, hashByte: string): AnchorDeclaration {
  return {
    digest,
    locator: {
      profile: NATIVE_ANCHOR_PROFILE,
      chainId: NATIVE_ANCHOR_CHAIN_ID,
      transactionHash: `0x${hashByte.repeat(32)}`,
      contractAddress: `0x${hashByte.repeat(20)}`,
      inputByteOffset: 0,
    },
  };
}

async function bindingsFor(input: {
  readonly root: string;
  readonly label: string;
  readonly agent: string;
  readonly roles: readonly NativeRoleIdentityRole[];
  readonly anchorDigest: `sha256:${string}`;
  readonly validFrom: string;
}): Promise<readonly SealedBindingEntry[]> {
  const signers = await openRoleSigners({
    storePath: join(input.root, `${input.label}.enc.json`),
    password: PASSWORD,
    ownedRoles: input.roles,
    create: true,
  });
  const entries: SealedBindingEntry[] = [];
  for (const role of input.roles) {
    const roleSigner = signers.get(role)!;
    const settlement = role.endsWith("-settlement");
    const ceremony = await performEoaCeremony({
      signer,
      agent: input.agent,
      didKey: roleSigner.keyId,
      issuedAt: input.validFrom,
      ...(settlement ? { settlementSafe: SAFE } : {}),
    });
    entries.push(await authorRoleBinding({
      role,
      signer: roleSigner,
      agent: input.agent,
      ceremonyAccount: EOA,
      ceremony,
      validFrom: input.validFrom,
      anchorDigest: input.anchorDigest,
    }));
  }
  return entries;
}

async function genesis(): Promise<{
  readonly root: string;
  readonly path: string;
  readonly authority: Awaited<ReturnType<typeof openCatalogAuthority>>;
  readonly bindings: readonly SealedBindingEntry[];
  readonly policyGenesisDigest: `sha256:${string}`;
}> {
  const root = await mkdtemp(join(tmpdir(), "trust-authoring-catalog-"));
  const authority = await openCatalogAuthority({
    storePath: join(root, "authority.enc.json"),
    password: PASSWORD,
    create: true,
  });
  const bindings = await bindingsFor({
    root,
    label: "a-solver",
    agent: AGENT_A,
    roles: ["solver-delivery", "solver-settlement", "solver-discovery"],
    anchorDigest: ANCHOR_A,
    validFrom: TIME_A,
  });
  const path = join(root, "trust.json");
  const { policyGenesisDigest } = await authorCatalog({
    path,
    authority,
    purposes: completePolicyPurposes({ roleAgents: bindings.map(({ role, agent }) => ({ role, agent })) }),
    refreshBy: REFRESH_BY,
    bindings,
    anchors: [declaration(ANCHOR_A, "ab")],
  });
  return { root, path, authority, bindings, policyGenesisDigest };
}

function newestPolicyOf(file: {
  policies: readonly { readonly envelope: string }[];
}): TrustPolicy {
  const parsed = file.policies.map((entry) => {
    const report = validateTrustPolicy(new Uint8Array(Buffer.from(entry.envelope, "base64")));
    return report.value!;
  });
  return parsed.reduce((newest, candidate) => (candidate.version > newest.version ? candidate : newest));
}

async function readCatalog(path: string): Promise<{
  policyGenesisDigest: string;
  policies: { digest: string; envelope: string }[];
  anchors: AnchorDeclaration[];
  bindings: { digest: string }[];
  revocations: unknown[];
}> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("completePolicyPurposes", () => {
  it("carries every native:<role>, BOTH admission spellings, and evaluator-eligibility (§6 law 3)", () => {
    const purposes = completePolicyPurposes({
      roleAgents: [
        { role: "solver-delivery", agent: AGENT_A },
        { role: "evaluator-verdict", agent: AGENT_A },
        { role: "admission", agent: "urn:uuid:admission-a" },
      ],
    });
    expect(Object.keys(purposes).sort()).toEqual([
      "admission-agent",
      "evaluator-eligibility",
      "native:admission",
      "native:evaluator-verdict",
      "native:solver-delivery",
    ]);
    expect(purposes["admission-agent"]!.accepted).toEqual(["urn:uuid:admission-a"]);
    expect(purposes["native:admission"]!.accepted).toEqual(["urn:uuid:admission-a"]);
    expect(purposes["evaluator-eligibility"]!.accepted).toEqual([AGENT_A]);
  });

  it("emits the admission and evaluator entries even when nobody owns those roles", () => {
    const purposes = completePolicyPurposes({ roleAgents: [{ role: "solver-delivery", agent: AGENT_A }] });
    expect(purposes["evaluator-eligibility"]).toEqual({ accepted: [], requiredStrength: "strong" });
    expect(purposes["admission-agent"]).toEqual({ accepted: [], requiredStrength: "strong" });
  });

  it("accepts every agent that owns a shared role rather than the last one written", () => {
    const purposes = completePolicyPurposes({
      roleAgents: [
        { role: "solver-delivery", agent: AGENT_A },
        { role: "solver-delivery", agent: AGENT_B },
      ],
    });
    expect(purposes["native:solver-delivery"]!.accepted).toEqual([AGENT_A, AGENT_B]);
  });
});

describe("authorCatalog", () => {
  it("writes a jinn.native-trust-catalog/2 file whose genesis digest is the sealed policy's", async () => {
    const { path, policyGenesisDigest } = await genesis();
    const file = await readCatalog(path);
    expect(file.policyGenesisDigest).toBe(policyGenesisDigest);
    expect(file.policies).toHaveLength(1);
    expect(file.policies[0]!.digest).toBe(policyGenesisDigest);
    expect(file.bindings).toHaveLength(3);
    expect(file.anchors).toHaveLength(1);
    expect(file.revocations).toEqual([]);
    expect(newestPolicyOf(file).version).toBe(1);
    expect(newestPolicyOf(file).predecessor).toBeUndefined();
  });

  it("refuses to overwrite an existing catalog", async () => {
    const { path, authority, bindings } = await genesis();
    await expect(authorCatalog({
      path,
      authority,
      purposes: completePolicyPurposes({ roleAgents: bindings.map(({ role, agent }) => ({ role, agent })) }),
      refreshBy: REFRESH_BY,
      bindings,
      anchors: [declaration(ANCHOR_A, "ab")],
    })).rejects.toThrow(/already exists/u);
  });

  it("refuses a policy whose purposes do not accept a bound agent", async () => {
    const { root, authority, bindings } = await genesis();
    await expect(authorCatalog({
      path: join(root, "other.json"),
      authority,
      purposes: completePolicyPurposes({ roleAgents: [{ role: "solver-delivery", agent: AGENT_B }] }),
      refreshBy: REFRESH_BY,
      bindings,
      anchors: [declaration(ANCHOR_A, "ab")],
    })).rejects.toThrow(/does not accept|has no native:/u);
  });

  /**
   * §6 law 3's three purposes are bound to NO key, so `assertPurposesCoverBindings` cannot see them
   * missing. A catalog without `evaluator-eligibility` authors cleanly, boots solver and requester,
   * and then refuses the evaluator at `createVerdictGate` — the exact LEG 6 gate leg. Until this
   * assertion, law 3 was enforced only by the CONVENTION of calling `completePolicyPurposes`.
   */
  it.each([
    ["evaluator-eligibility"],
    ["admission-agent"],
    ["native:admission"],
  ])("refuses a policy missing the mandatory %s purpose (§6 law 3)", async (purpose) => {
    const root = await mkdtemp(join(tmpdir(), "trust-authoring-law3-"));
    const bindings = await bindingsFor({
      root,
      label: "a-solver",
      agent: AGENT_A,
      roles: ["solver-delivery"],
      anchorDigest: ANCHOR_A,
      validFrom: TIME_A,
    });
    const purposes = completePolicyPurposes({
      roleAgents: bindings.map(({ role, agent }) => ({ role, agent })),
    });
    delete purposes[purpose];

    await expect(authorCatalog({
      path: join(root, "trust.json"),
      authority: await openCatalogAuthority({
        storePath: join(root, "authority.enc.json"),
        password: PASSWORD,
        create: true,
      }),
      purposes,
      refreshBy: REFRESH_BY,
      bindings,
      anchors: [declaration(ANCHOR_A, "ab")],
    })).rejects.toThrow(new RegExp(`missing the mandatory ${purpose} purpose entry \\(§6 law 3\\)`, "u"));
  });

  it("refuses a binding whose anchor is not declared", async () => {
    const { root, authority, bindings } = await genesis();
    await expect(authorCatalog({
      path: join(root, "unanchored.json"),
      authority,
      purposes: completePolicyPurposes({ roleAgents: bindings.map(({ role, agent }) => ({ role, agent })) }),
      refreshBy: REFRESH_BY,
      bindings,
      anchors: [declaration(ANCHOR_B, "cd")],
    })).rejects.toThrow(/undeclared anchor/u);
  });
});

describe("appendOperator", () => {
  it("appends the joiner and seals a successor without moving the genesis digest", async () => {
    const { root, path, authority, policyGenesisDigest, bindings: aBindings } = await genesis();
    const before = await readCatalog(path);

    const bBindings = await bindingsFor({
      root,
      label: "b-solver",
      agent: AGENT_B,
      roles: ["solver-delivery", "solver-settlement"],
      anchorDigest: ANCHOR_B,
      validFrom: TIME_B,
    });
    const result = await appendOperator({
      catalogPath: path,
      authority,
      newBindings: bBindings,
      newAnchor: declaration(ANCHOR_B, "cd"),
      refreshBy: REFRESH_BY,
    });
    expect(result.newestPolicyVersion).toBe(2);
    expect(result.policyGenesisDigest).toBe(policyGenesisDigest);

    const after = await readCatalog(path);
    expect(after.policyGenesisDigest).toBe(policyGenesisDigest);
    expect(after.policies[0]).toEqual(before.policies[0]);
    expect(after.policies).toHaveLength(2);
    expect(after.anchors).toHaveLength(2);
    // Operator A's bindings are untouched, byte for byte.
    expect(after.bindings.slice(0, 3)).toEqual(before.bindings);
    expect(after.bindings).toHaveLength(5);
    expect(after.bindings.map(({ digest }) => digest))
      .toEqual([...aBindings, ...bBindings].map(({ digest }) => digest));

    const newest = newestPolicyOf(after);
    expect(newest.version).toBe(2);
    expect(newest.predecessor).toBe(policyGenesisDigest);
    expect(newest.purposes["native:solver-delivery"]!.accepted.sort()).toEqual([AGENT_A, AGENT_B].sort());
    // A-only roles survive the extension.
    expect(newest.purposes["native:solver-discovery"]!.accepted).toEqual([AGENT_A]);
    expect(newest.signerSet.keys).toEqual([authority.keyId]);
  });

  it("dedupes bindings by digest and never re-appends an already-present binding", async () => {
    const { root, path, authority } = await genesis();
    const bBindings = await bindingsFor({
      root,
      label: "b-solver",
      agent: AGENT_B,
      roles: ["solver-delivery"],
      anchorDigest: ANCHOR_B,
      validFrom: TIME_B,
    });
    await appendOperator({
      catalogPath: path,
      authority,
      newBindings: [...bBindings, ...bBindings],
      newAnchor: declaration(ANCHOR_B, "cd"),
      refreshBy: REFRESH_BY,
    });
    const first = await readCatalog(path);
    expect(first.bindings).toHaveLength(4);

    // Re-running the same join appends no binding and no duplicate anchor; only the policy advances.
    await appendOperator({
      catalogPath: path,
      authority,
      newBindings: bBindings,
      newAnchor: declaration(ANCHOR_B, "cd"),
      refreshBy: REFRESH_BY,
    });
    const second = await readCatalog(path);
    expect(second.bindings).toHaveLength(4);
    expect(second.anchors).toHaveLength(2);
    expect(newestPolicyOf(second).version).toBe(3);
  });

  /**
   * The lock serializes joins that go THROUGH this package; the digest compare is what still
   * catches a writer that did not — an operator hand-edit, or the §4.2 file-copy distribution
   * landing a newer catalog from another host while a join is mid-flight.
   *
   * The competing write is driven from the authority's own signer, which `sealSuccessor` awaits
   * strictly between `loadCatalog` and `rewriteAtomically`. That makes the interleaving exact
   * rather than a bet on microtask ordering — which is what it was before the lock added await
   * points and quietly stopped reproducing.
   */
  it("refuses loudly when the catalog changed on disk since it was read", async () => {
    const { root, path, authority } = await genesis();
    const bBindings = await bindingsFor({
      root,
      label: "b-solver",
      agent: AGENT_B,
      roles: ["solver-delivery"],
      anchorDigest: ANCHOR_B,
      validFrom: TIME_B,
    });
    const racingAuthority = {
      keyId: authority.keyId,
      dsseSigner: async (input: Parameters<typeof authority.dsseSigner>[0]) => {
        const current = await readFile(path, "utf8");
        await writeFile(path, `${current} `);
        return authority.dsseSigner(input);
      },
    };

    await expect(appendOperator({
      catalogPath: path,
      authority: racingAuthority,
      newBindings: bBindings,
      newAnchor: declaration(ANCHOR_B, "cd"),
      refreshBy: REFRESH_BY,
    })).rejects.toThrow(/changed on disk/u);
  });

  /**
   * The digest compare alone is TOCTOU — two joins that both read version N can both seal a
   * successor, and the loser's write lands last. That is a LOST UPDATE (a join silently dropped),
   * not the loud refusal §7 promises. The lock spans read-check-rewrite, so exactly one of two
   * genuinely concurrent joins proceeds and the other refuses before it reads anything.
   */
  it("lets exactly one of two concurrent joins proceed and refuses the other loudly", async () => {
    const { root, path, authority } = await genesis();
    const bBindings = await bindingsFor({
      root,
      label: "b-solver",
      agent: AGENT_B,
      roles: ["solver-delivery"],
      anchorDigest: ANCHOR_B,
      validFrom: TIME_B,
    });
    const cBindings = await bindingsFor({
      root,
      label: "c-solver",
      agent: "urn:uuid:00000000-0000-4000-8000-00000000000c",
      roles: ["solver-delivery"],
      anchorDigest: ANCHOR_B,
      validFrom: TIME_B,
    });

    const results = await Promise.allSettled([
      appendOperator({
        catalogPath: path,
        authority,
        newBindings: bBindings,
        newAnchor: declaration(ANCHOR_B, "cd"),
        refreshBy: REFRESH_BY,
      }),
      appendOperator({
        catalogPath: path,
        authority,
        newBindings: cBindings,
        newAnchor: declaration(ANCHOR_B, "cd"),
        refreshBy: REFRESH_BY,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(TrustAuthoringError);
    expect(String((rejected as PromiseRejectedResult).reason)).toMatch(/holds .*\.lock/u);
    // The winner's successor is intact — a lost update would have left version 2 with the loser's
    // membership, or version 2 with the winner's write clobbered.
    expect(newestPolicyOf(await readCatalog(path)).version).toBe(2);
  });

  it("releases the lock on success, so the next join is not blocked by its predecessor", async () => {
    const { root, path, authority } = await genesis();
    const bBindings = await bindingsFor({
      root,
      label: "b-solver",
      agent: AGENT_B,
      roles: ["solver-delivery"],
      anchorDigest: ANCHOR_B,
      validFrom: TIME_B,
    });
    await appendOperator({
      catalogPath: path,
      authority,
      newBindings: bBindings,
      newAnchor: declaration(ANCHOR_B, "cd"),
      refreshBy: REFRESH_BY,
    });
    await expect(stat(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(sealPolicySuccessor({ catalogPath: path, authority, refreshBy: REFRESH_BY }))
      .resolves.toMatchObject({ newestPolicyVersion: 3 });
  });

  it("releases the lock when the join refuses, so a corrected re-run is not blocked", async () => {
    const { path, authority } = await genesis();
    await expect(appendOperator({
      catalogPath: path,
      authority,
      newBindings: [],
      newAnchor: declaration(ANCHOR_B, "cd"),
      refreshBy: REFRESH_BY,
    })).rejects.toBeInstanceOf(TrustAuthoringError);
    await expect(stat(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("sealPolicySuccessor", () => {
  it("refreshes without membership change and can rotate the signer set", async () => {
    const { root, path, authority } = await genesis();
    const successorAuthority = await openCatalogAuthority({
      storePath: join(root, "authority-2.enc.json"),
      password: PASSWORD,
      create: true,
    });
    const result = await sealPolicySuccessor({
      catalogPath: path,
      authority,
      refreshBy: "2027-08-07T00:00:00.000Z",
      signerSet: { keys: [authority.keyId, successorAuthority.keyId], threshold: 1 },
    });
    expect(result.newestPolicyVersion).toBe(2);
    const newest = newestPolicyOf(await readCatalog(path));
    expect(newest.refreshBy).toBe("2027-08-07T00:00:00.000Z");
    expect(newest.signerSet.keys).toEqual([authority.keyId, successorAuthority.keyId]);
    expect(newest.purposes["native:solver-delivery"]!.accepted).toEqual([AGENT_A]);
  });

  /**
   * `TrustPolicy` is a `z.looseObject`, so a policy legitimately carries fields this package has
   * never heard of. Reconstructing the successor from a fixed field list silently dropped them —
   * a successor that quietly deletes a term its predecessor carried is a governance change nobody
   * authored, and it is invisible until whoever reads that field notices it is gone.
   */
  it("carries unknown predecessor fields forward instead of silently dropping them", async () => {
    const { path, authority } = await genesis();
    const file = await readCatalog(path);
    const genesisPolicy = newestPolicyOf(file);
    // Re-seal the genesis carrying loose fields the authoring package does not model, and put it
    // back as the catalog's only policy — the shape a policy authored by a later schema has.
    const resealed = await sealTrustPolicy(
      {
        ...genesisPolicy,
        creditRegime: { "native:solver": "loop-completion" },
        jurisdiction: "testnet-only",
        contactOfRecord: "urn:uuid:00000000-0000-4000-8000-00000000000f",
      } as unknown as TrustPolicy,
      authority.dsseSigner,
    );
    await writeFile(path, JSON.stringify({
      ...file,
      policyGenesisDigest: resealed.recordDigest,
      policies: [{ digest: resealed.recordDigest, envelope: Buffer.from(resealed.envelopeBytes).toString("base64") }],
    }));

    await sealPolicySuccessor({ catalogPath: path, authority, refreshBy: "2027-08-07T00:00:00.000Z" });

    const successor = newestPolicyOf(await readCatalog(path)) as unknown as Record<string, unknown>;
    expect(successor.jurisdiction).toBe("testnet-only");
    expect(successor.contactOfRecord).toBe("urn:uuid:00000000-0000-4000-8000-00000000000f");
    expect(successor.creditRegime).toEqual({ "native:solver": "loop-completion" });
    // Succession still owns its own fields.
    expect(successor.version).toBe(2);
    expect(successor.predecessor).toBe(resealed.recordDigest);
    expect(successor.refreshBy).toBe("2027-08-07T00:00:00.000Z");
  });
});

describe("revokeBinding", () => {
  it("is designed but deliberately unimplemented (§3.3)", async () => {
    await expect(revokeBinding({
      catalogPath: "/tmp/whatever.json",
      authority: { keyId: "did:key:z", dsseSigner: async () => [{ keyid: "did:key:z", signature: new Uint8Array(64) }] },
      target: ANCHOR_A,
      effectiveTime: TIME_A,
      anchor: declaration(ANCHOR_A, "ab"),
    })).rejects.toThrow(/designed but not implemented/u);
  });
});
