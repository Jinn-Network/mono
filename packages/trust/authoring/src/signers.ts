// SPDX-License-Identifier: Apache-2.0

/**
 * Custody openers (spec §3.2). Both go through `IdentityStore.loadOrCreate` — the same
 * exclusive-hard-link create path production boot uses — so there is no code path here that
 * replaces existing key material. The private bytes never leave this module: callers get a
 * `DsseSigner` closure and a `did:key` id, which is exactly what binding/policy authoring needs.
 */
import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { DsseSigner } from "@jinn-network/trust-core";

import {
  CATALOG_AUTHORITY_ROLE,
  CATALOG_AUTHORITY_STORE_PROFILE,
  IdentityStore,
  IdentityStoreError,
  type StoredRoleIdentity,
} from "./identity-store.js";
import { orderedNativeRoles, type NativeRoleIdentityRole } from "./roles.js";

export interface RoleSigner {
  readonly role: NativeRoleIdentityRole;
  /** `did:key:z…` — the public identity the catalog binding names. */
  readonly keyId: string;
  /** Trust-core signer over this role's Ed25519 key; private bytes never escape. */
  readonly dsseSigner: DsseSigner;
}

export interface CatalogAuthoritySigner {
  readonly keyId: string;
  readonly dsseSigner: DsseSigner;
}

function ed25519DsseSigner(stored: StoredRoleIdentity<string>): DsseSigner {
  const privateKey = createPrivateKey({
    key: Buffer.from(stored.privateKeyDer, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return async ({ preAuthEncoding }) => [{
    keyid: stored.keyId,
    signature: new Uint8Array(cryptoSign(null, preAuthEncoding, privateKey)),
  }];
}

async function refuseWhenAbsent(storePath: string): Promise<void> {
  try {
    await stat(storePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new IdentityStoreError(`identity store cannot be accessed: ${String(cause)}`);
    }
    throw new IdentityStoreError(
      `identity store does not exist at ${storePath}; pass create: true to mint its role identities`,
    );
  }
}

/**
 * Opens (or, with `create`, mints) the encrypted role store and returns per-role `DsseSigner`s over
 * the SAME `loadOrCreate` path production boot uses. NEVER clobbers: an existing store is opened,
 * never rewritten; a concurrent first-create is settled by `IdentityStore`'s exclusive hard link
 * (EEXIST → reread), so no interleaving replaces existing key material. A store whose owned-role set
 * differs from `ownedRoles` refuses (the loader's own invariant).
 *
 * `ownedRoles` is canonicalized to `NATIVE_ROLE_IDENTITY_ROLES` order before it reaches the codec,
 * because `RoleIdentitySet.open` derives its expected set that way and then byte-compares the
 * store's `metadata.ownedRoles` — a store minted from a differently-ordered request would be a store
 * the daemon refuses to boot.
 */
export async function openRoleSigners(input: {
  readonly storePath: string;
  readonly password: string;
  readonly ownedRoles: readonly NativeRoleIdentityRole[];
  /** `false` → an absent store is a refusal, not a mint. */
  readonly create: boolean;
  readonly now?: () => Date;
}): Promise<ReadonlyMap<NativeRoleIdentityRole, RoleSigner>> {
  if (!isAbsolute(input.storePath)) throw new IdentityStoreError("identity store path must be absolute");
  const ownedRoles = orderedNativeRoles(input.ownedRoles);
  if (ownedRoles.length === 0) {
    throw new IdentityStoreError("role signer custody requires at least one owned role");
  }
  if (!input.create) await refuseWhenAbsent(input.storePath);

  const store = await IdentityStore.open({ path: input.storePath, password: input.password });
  const { roles } = await store.loadOrCreate(input.now?.() ?? new Date(), ownedRoles);
  const signers = new Map<NativeRoleIdentityRole, RoleSigner>();
  for (const stored of roles) {
    signers.set(stored.role, {
      role: stored.role,
      keyId: stored.keyId,
      dsseSigner: ed25519DsseSigner(stored),
    });
  }
  return signers;
}

/**
 * Dedicated catalog-authority custody (spec §5): the same encrypted envelope and the same
 * never-clobber create path, one Ed25519 key, in its own file under its own store-format tag. The
 * authority key is deliberately NOT an operator role key — role keys rotate on operator events, and
 * policy-update capability must survive any operator's rotation.
 */
export async function openCatalogAuthority(input: {
  readonly storePath: string;
  readonly password: string;
  readonly create: boolean;
  readonly now?: () => Date;
}): Promise<CatalogAuthoritySigner> {
  if (!isAbsolute(input.storePath)) throw new IdentityStoreError("identity store path must be absolute");
  if (!input.create) await refuseWhenAbsent(input.storePath);

  const store = await IdentityStore.open({
    path: input.storePath,
    password: input.password,
    profile: CATALOG_AUTHORITY_STORE_PROFILE,
  });
  const { roles } = await store.loadOrCreate(input.now?.() ?? new Date(), [CATALOG_AUTHORITY_ROLE]);
  const authority = roles[0];
  if (authority === undefined) throw new IdentityStoreError("catalog authority store holds no key");
  return { keyId: authority.keyId, dsseSigner: ed25519DsseSigner(authority) };
}
