/**
 * Native role-identity store fixtures for the native e2e rig (one-swap M7, umbrella #2461,
 * DR-2026-08-05).
 *
 * The fixture used to shadow-implement the encrypted store format byte-for-byte, because the rig
 * needs to hold each role key in order to SELF-SIGN its catalog binding. That shadow is gone: the
 * production authoring package (`@jinn-network/trust-authoring`, spec/2026-08-07 §3.1/§3.4) now owns
 * the one implementation of the store format AND hands back per-role `DsseSigner`s, so the rig can
 * author bindings without ever holding raw private bytes.
 *
 * What remains here is rig-shaped plumbing only: a by-role lookup and a stable return shape the
 * two-operator config fixture and the loop rig already speak.
 */
import { openRoleSigners, type RoleSigner } from '@jinn-network/trust-authoring';
import type { NativeRoleIdentityRole } from '../../../../src/daemon/role-identities.js';

/** A minted role key's public identity plus its trust-core signer. */
export type FixtureRoleKey = RoleSigner;

export interface MintedIdentityStore {
  readonly storePath: string;
  readonly keys: readonly FixtureRoleKey[];
  key(role: NativeRoleIdentityRole): FixtureRoleKey;
}

/**
 * Mints (or reopens) an encrypted identity store owning exactly `roles` through the production
 * opener, and returns the store path plus the role signers the catalog fixture authors bindings
 * with. `openRoleSigners` never clobbers, so a rig that re-runs against the same temp dir gets the
 * same keys rather than a store its catalog no longer matches.
 */
export async function mintIdentityStore(input: {
  readonly storePath: string;
  readonly password: string;
  readonly roles: readonly NativeRoleIdentityRole[];
  readonly createdAt?: string;
}): Promise<MintedIdentityStore> {
  const createdAt = new Date(input.createdAt ?? '2026-08-01T00:00:00.000Z');
  const signers = await openRoleSigners({
    storePath: input.storePath,
    password: input.password,
    ownedRoles: input.roles,
    create: true,
    now: () => createdAt,
  });
  const keys = input.roles.map((role) => {
    const signer = signers.get(role);
    if (signer === undefined) throw new Error(`fixture identity store does not own role ${role}`);
    return signer;
  });
  return {
    storePath: input.storePath,
    keys,
    key(role) {
      const signer = signers.get(role);
      if (signer === undefined) throw new Error(`fixture identity store does not own role ${role}`);
      return signer;
    },
  };
}
