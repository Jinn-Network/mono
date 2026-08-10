// SPDX-License-Identifier: Apache-2.0

/**
 * Genesis durability under an interrupted write.
 *
 * The catalog file is the one artifact with no recovery path: `authorCatalog` refuses to overwrite
 * an existing path on purpose (a second genesis at the same location would strand every pin that
 * named the first). That refusal is only safe if the target path is created ATOMICALLY — under a
 * plain `open(path, "wx")` + write, a crash between the two leaves a truncated file that is
 * indistinguishable from a real catalog to the EEXIST check, so every later re-author refuses and
 * the operator has to `rm` a file the tool told them never to overwrite.
 *
 * These tests pin the invariant that makes the refusal safe: after a failed genesis there is NO
 * file at the target path, and re-authoring works.
 *
 * The write failure is injected by a SURGICAL `node:fs/promises` mock — only paths carrying the
 * `INTERRUPT_MARKER` fail, everything else (identity stores, temp files, reads) runs the real
 * implementation, so this file exercises the production code path rather than a stub of it.
 */
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const INTERRUPT_MARKER = "interrupt-this-write";

/**
 * Armed by the tests; only writes to `INTERRUPT_MARKER` paths fail, and only while it is true.
 * Reached through `globalThis` because `vi.mock`'s factory is hoisted above every module binding.
 */
const interrupt = { armed: false };
(globalThis as { __trustAuthoringInterrupt?: typeof interrupt }).__trustAuthoringInterrupt = interrupt;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    async open(path: string, ...rest: unknown[]) {
      const handle = await (actual.open as unknown as (...args: unknown[]) => Promise<
        Awaited<ReturnType<typeof actual.open>>
      >)(path, ...rest);
      const failures = (globalThis as { __trustAuthoringInterrupt?: { armed: boolean } })
        .__trustAuthoringInterrupt;
      if (failures?.armed !== true || !String(path).includes(INTERRUPT_MARKER)) return handle;
      // The open SUCCEEDED (so any file it creates is already on disk) and the write then dies —
      // exactly the crash window the plain `wx` + write shape leaves open.
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "writeFile") {
            return async () => { throw new Error("simulated interrupted genesis write"); };
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
    },
  };
});

const { authorCatalog, completePolicyPurposes } = await import("./catalog.js");
const { authorRoleBinding } = await import("./binding.js");
const { performEoaCeremony } = await import("./ceremony.js");
const { openCatalogAuthority, openRoleSigners } = await import("./signers.js");
const { NATIVE_ANCHOR_CHAIN_ID, NATIVE_ANCHOR_PROFILE } = await import("./anchor.js");
const { TrustAuthoringError } = await import("./errors.js");

const PASSWORD = "trust-authoring-durability-password";
const EOA = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const AGENT = "urn:uuid:00000000-0000-4000-8000-0000000000da";
const ANCHOR = "sha256:3333333333333333333333333333333333333333333333333333333333333333" as const;
const VALID_FROM = "2026-08-07T12:00:00.000Z";
const REFRESH_BY = "2027-02-07T00:00:00.000Z";

const signer = {
  address: EOA,
  async signMessage(): Promise<`0x${string}`> { return `0x${"44".repeat(65)}`; },
};

const anchors = [{
  digest: ANCHOR,
  locator: {
    profile: NATIVE_ANCHOR_PROFILE,
    chainId: NATIVE_ANCHOR_CHAIN_ID,
    transactionHash: `0x${"ab".repeat(32)}` as `0x${string}`,
    contractAddress: `0x${"cd".repeat(20)}` as `0x${string}`,
    inputByteOffset: 0,
  },
}];

async function fixture(): Promise<{
  readonly root: string;
  readonly authority: Awaited<ReturnType<typeof openCatalogAuthority>>;
  readonly bindings: Awaited<ReturnType<typeof authorRoleBinding>>[];
}> {
  const root = await mkdtemp(join(tmpdir(), "trust-authoring-durability-"));
  const authority = await openCatalogAuthority({
    storePath: join(root, "authority.enc.json"),
    password: PASSWORD,
    create: true,
  });
  const signers = await openRoleSigners({
    storePath: join(root, "roles.enc.json"),
    password: PASSWORD,
    ownedRoles: ["admission"],
    create: true,
  });
  const roleSigner = signers.get("admission")!;
  const ceremony = await performEoaCeremony({
    signer,
    agent: AGENT,
    didKey: roleSigner.keyId,
    issuedAt: VALID_FROM,
  });
  const binding = await authorRoleBinding({
    role: "admission",
    signer: roleSigner,
    agent: AGENT,
    ceremonyAccount: EOA,
    ceremony,
    validFrom: VALID_FROM,
    anchorDigest: ANCHOR,
  });
  return { root, authority, bindings: [binding] };
}

describe("authorCatalog durability", () => {
  beforeEach(() => { interrupt.armed = true; });
  afterEach(() => { interrupt.armed = false; });

  it("leaves NO file at the target path when the genesis write is interrupted", async () => {
    const { root, authority, bindings } = await fixture();
    const path = join(root, `${INTERRUPT_MARKER}.json`);

    await expect(authorCatalog({
      path,
      authority,
      purposes: completePolicyPurposes({ roleAgents: bindings.map(({ role, agent }) => ({ role, agent })) }),
      refreshBy: REFRESH_BY,
      bindings,
      anchors,
    })).rejects.toBeInstanceOf(TrustAuthoringError);

    // The whole point: a plain `open(path, "wx")` would have created this file before the write
    // died, and every later genesis would then refuse with EEXIST against a truncated artifact.
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up its staging file, so an interrupted genesis leaves no litter behind", async () => {
    const { root, authority, bindings } = await fixture();
    const path = join(root, `${INTERRUPT_MARKER}-litter.json`);

    await expect(authorCatalog({
      path,
      authority,
      purposes: completePolicyPurposes({ roleAgents: bindings.map(({ role, agent }) => ({ role, agent })) }),
      refreshBy: REFRESH_BY,
      bindings,
      anchors,
    })).rejects.toBeInstanceOf(TrustAuthoringError);

    const entries = await readdir(root);
    expect(entries.filter((entry) => entry.includes(".tmp-"))).toEqual([]);
  });

  it("re-authors successfully at the same path after an interrupted genesis", async () => {
    const { root, authority, bindings } = await fixture();
    const purposes = completePolicyPurposes({
      roleAgents: bindings.map(({ role, agent }) => ({ role, agent })),
    });

    await expect(authorCatalog({
      path: join(root, `${INTERRUPT_MARKER}-retry.json`),
      authority,
      purposes,
      refreshBy: REFRESH_BY,
      bindings,
      anchors,
    })).rejects.toBeInstanceOf(TrustAuthoringError);

    // The retry is the same operator running the same ceremony again, at the same path, once the
    // condition that killed the first attempt is gone. It must not need an `rm`.
    interrupt.armed = false;
    const retried = await authorCatalog({
      path: join(root, `${INTERRUPT_MARKER}-retry.json`),
      authority,
      purposes,
      refreshBy: REFRESH_BY,
      bindings,
      anchors,
    });
    expect(retried.policyGenesisDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(retried.newestPolicyVersion).toBe(1);
  });
});
