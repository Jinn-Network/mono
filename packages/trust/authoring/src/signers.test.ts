// SPDX-License-Identifier: Apache-2.0

import { createDecipheriv, scryptSync } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { IdentityStoreError } from "./identity-store.js";
import { openCatalogAuthority, openRoleSigners } from "./signers.js";

const PASSWORD = "trust-authoring-test-password";

function decryptStore(bytes: Uint8Array, password: string): Record<string, unknown> {
  const envelope = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>;
  const key = scryptSync(password, Buffer.from(envelope.salt!, "base64"), 32);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv!, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.authTag!, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext!, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
}

describe("openRoleSigners", () => {
  it("writes the exact jinn.native-role-identities/2 store shape the daemon loader reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "trust-authoring-store-"));
    const storePath = join(root, "solver.enc.json");
    await openRoleSigners({
      storePath,
      password: PASSWORD,
      ownedRoles: ["solver-delivery", "solver-settlement", "solver-discovery"],
      create: true,
    });

    const bytes = await readFile(storePath);
    const envelope = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    expect(envelope.version).toBe(1);
    expect(envelope.kdf).toBe("scrypt");
    expect(envelope.cipher).toBe("aes-256-gcm");

    const store = decryptStore(bytes, PASSWORD) as {
      version: number;
      metadata: { format: string; ownedRoles: string[]; roles: { role: string; algorithm: string }[] };
      roles: { role: string; keyId: string; publicKeyDer: string; privateKeyDer: string }[];
    };
    expect(store.version).toBe(3);
    expect(store.metadata.format).toBe("jinn.native-role-identities/2");
    expect(store.metadata.ownedRoles).toEqual(["solver-delivery", "solver-settlement", "solver-discovery"]);
    expect(store.metadata.roles.map(({ algorithm }) => algorithm)).toEqual(["Ed25519", "Ed25519", "Ed25519"]);
    for (const role of store.roles) expect(role.keyId.startsWith("did:key:z")).toBe(true);

    const mode = (await stat(storePath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("canonicalizes ownedRoles order, because the daemon byte-compares it", async () => {
    const root = await mkdtemp(join(tmpdir(), "trust-authoring-order-"));
    const storePath = join(root, "solver.enc.json");
    await openRoleSigners({
      storePath,
      password: PASSWORD,
      // Deliberately out of NATIVE_ROLE_IDENTITY_ROLES order.
      ownedRoles: ["solver-discovery", "solver-delivery", "solver-settlement"],
      create: true,
    });
    const store = decryptStore(await readFile(storePath), PASSWORD) as {
      metadata: { ownedRoles: string[] };
    };
    expect(store.metadata.ownedRoles).toEqual(["solver-delivery", "solver-settlement", "solver-discovery"]);
  });

  it("NEVER clobbers: a second open returns the same keys rather than re-minting", async () => {
    const root = await mkdtemp(join(tmpdir(), "trust-authoring-clobber-"));
    const storePath = join(root, "requester.enc.json");
    const first = await openRoleSigners({
      storePath,
      password: PASSWORD,
      ownedRoles: ["requester-submission", "requester-discovery"],
      create: true,
    });
    const firstBytes = await readFile(storePath);

    const second = await openRoleSigners({
      storePath,
      password: PASSWORD,
      ownedRoles: ["requester-submission", "requester-discovery"],
      create: true,
    });
    expect(second.get("requester-submission")!.keyId).toBe(first.get("requester-submission")!.keyId);
    expect(second.get("requester-discovery")!.keyId).toBe(first.get("requester-discovery")!.keyId);
    // Byte-for-byte untouched: reopening does not even re-encrypt (a fresh salt/IV would differ).
    expect(Buffer.from(await readFile(storePath)).equals(Buffer.from(firstBytes))).toBe(true);
  });

  it("refuses an absent store when create is false", async () => {
    const root = await mkdtemp(join(tmpdir(), "trust-authoring-absent-"));
    await expect(openRoleSigners({
      storePath: join(root, "missing.enc.json"),
      password: PASSWORD,
      ownedRoles: ["admission"],
      create: false,
    })).rejects.toBeInstanceOf(IdentityStoreError);
  });

  it("refuses a relative store path and an empty role set", async () => {
    await expect(openRoleSigners({
      storePath: "relative/store.enc.json",
      password: PASSWORD,
      ownedRoles: ["admission"],
      create: true,
    })).rejects.toThrow(/absolute/u);
    const root = await mkdtemp(join(tmpdir(), "trust-authoring-empty-"));
    await expect(openRoleSigners({
      storePath: join(root, "store.enc.json"),
      password: PASSWORD,
      ownedRoles: [],
      create: true,
    })).rejects.toThrow(/at least one owned role/u);
  });

  it("refuses to reuse a store under a different owned-role set", async () => {
    const root = await mkdtemp(join(tmpdir(), "trust-authoring-narrow-"));
    const storePath = join(root, "solver.enc.json");
    await openRoleSigners({
      storePath,
      password: PASSWORD,
      ownedRoles: ["solver-delivery", "solver-settlement", "solver-discovery"],
      create: true,
    });
    await expect(openRoleSigners({
      storePath,
      password: PASSWORD,
      ownedRoles: ["solver-delivery"],
      create: true,
    })).rejects.toBeInstanceOf(IdentityStoreError);
  });
});

describe("openCatalogAuthority", () => {
  it("mints one key in its own store-format tag, and never clobbers it", async () => {
    const root = await mkdtemp(join(tmpdir(), "trust-authoring-authority-"));
    const storePath = join(root, "authority.enc.json");
    const first = await openCatalogAuthority({ storePath, password: PASSWORD, create: true });
    expect(first.keyId.startsWith("did:key:z")).toBe(true);

    const store = decryptStore(await readFile(storePath), PASSWORD) as {
      metadata: { format: string; ownedRoles: string[] };
      roles: unknown[];
    };
    expect(store.metadata.format).toBe("jinn.trust-catalog-authority/1");
    expect(store.metadata.ownedRoles).toEqual(["catalog-authority"]);
    expect(store.roles).toHaveLength(1);

    const second = await openCatalogAuthority({ storePath, password: PASSWORD, create: true });
    expect(second.keyId).toBe(first.keyId);
  });

  it("refuses an absent authority store when create is false", async () => {
    const root = await mkdtemp(join(tmpdir(), "trust-authoring-authority-absent-"));
    await expect(openCatalogAuthority({
      storePath: join(root, "missing.enc.json"),
      password: PASSWORD,
      create: false,
    })).rejects.toBeInstanceOf(IdentityStoreError);
  });

  it("cannot be opened as a role store (the tags keep the two custody kinds apart)", async () => {
    const root = await mkdtemp(join(tmpdir(), "trust-authoring-crosswire-"));
    const storePath = join(root, "authority.enc.json");
    await openCatalogAuthority({ storePath, password: PASSWORD, create: true });
    await expect(openRoleSigners({
      storePath,
      password: PASSWORD,
      ownedRoles: ["admission"],
      create: true,
    })).rejects.toBeInstanceOf(IdentityStoreError);
  });

  /**
   * The reverse direction, which matters MORE in production than the one above: §5's whole point is
   * that the policy-signing key is never an operator role key. A ceremony run that pointed
   * `--authority-store` at an existing role store must refuse, not quietly promote a role key to
   * catalog authority — which is exactly the fixture expedient (`policySigner = roleKeys[0]`) the
   * spec forbids. Pinning both directions keeps the store-format tags load-bearing.
   */
  it("refuses to open a role store as the catalog authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "trust-authoring-crosswire-reverse-"));
    const storePath = join(root, "roles.enc.json");
    await openRoleSigners({ storePath, password: PASSWORD, ownedRoles: ["admission"], create: true });
    await expect(openCatalogAuthority({ storePath, password: PASSWORD, create: true }))
      .rejects.toBeInstanceOf(IdentityStoreError);
  });
});
