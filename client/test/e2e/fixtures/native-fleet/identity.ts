/**
 * Native role-identity store fixtures for the native e2e rig (one-swap M7, umbrella #2461,
 * DR-2026-08-05).
 *
 * The production `IdentityStore` (`src/daemon/role-identities.ts`) mints role keys internally and
 * never exposes their private bytes — but the native trust catalog binds each role key with a
 * DSSE envelope the role key SELF-SIGNS (`sealKeyBinding(binding, roleSigner)`, see
 * `native-trust-catalog.test.ts`). So the rig has to hold the private keys to author a catalog the
 * production boot will then accept.
 *
 * This fixture therefore MINTS the keys itself and writes the exact encrypted store format
 * `IdentityStore.loadOrCreate` reads back (`StoredIdentitySetV3` inside an AES-256-GCM/scrypt
 * envelope — the shape `role-identities.ts` defines). The production loader validates every field
 * on read, so a drift in the store format reddens this fixture's own unit test rather than passing
 * silently. Keeping the private keys in hand is the whole point: the same keypair signs the store
 * entry AND its catalog binding, so the two never disagree.
 */
import {
  createCipheriv,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import bs58 from 'bs58';
import type { NativeRoleIdentityRole } from '../../../../src/daemon/role-identities.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const STORE_VERSION = 3 as const;
const ENVELOPE_VERSION = 1 as const;
const SCRYPT_KEY_LENGTH = 32;

/** A minted role key with its private material retained for catalog signing. */
export interface FixtureRoleKey {
  readonly role: NativeRoleIdentityRole;
  readonly keyId: string;
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  sign(payload: Uint8Array): Uint8Array;
  verify(payload: Uint8Array, signature: Uint8Array): boolean;
}

/**
 * The exact `did:key:z…` id `role-identities.ts`'s `publicKeyId` computes for an Ed25519 SPKI key.
 * Replicated so the fixture store's key ids match what the production loader recomputes on read.
 */
export function fixtureKeyId(publicKey: KeyObject): string {
  const der = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }));
  if (
    der.length !== ED25519_SPKI_PREFIX.length + 32
    || !der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    throw new Error('fixture role key is not an Ed25519 SPKI key');
  }
  const multicodec = Buffer.concat([Buffer.from([0xed, 0x01]), der.subarray(ED25519_SPKI_PREFIX.length)]);
  return `did:key:z${bs58.encode(multicodec)}`;
}

function mintRoleKey(role: NativeRoleIdentityRole): FixtureRoleKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    role,
    keyId: fixtureKeyId(publicKey),
    publicKey,
    privateKey,
    sign: (payload) => new Uint8Array(cryptoSign(null, payload, privateKey)),
    verify: (payload, signature) => cryptoVerify(null, payload, publicKey, signature),
  };
}

interface StoredRole {
  readonly role: NativeRoleIdentityRole;
  readonly keyId: string;
  readonly publicKeyDer: string;
  readonly privateKeyDer: string;
  readonly createdAt: string;
}

/**
 * Writes the encrypted identity store the production `IdentityStore` reads. `roles` order is
 * canonicalized to `NATIVE_ROLE_IDENTITY_ROLES` by the loader's `orderedRequired`, but the file's
 * `ownedRoles` must equal the process-owned role set exactly, so we store them in the requested
 * order and let the loader re-order for lookup.
 */
async function writeIdentityStore(input: {
  readonly storePath: string;
  readonly password: string;
  readonly keys: readonly FixtureRoleKey[];
  readonly createdAt: string;
}): Promise<void> {
  const roles: StoredRole[] = input.keys.map((key) => ({
    role: key.role,
    keyId: key.keyId,
    publicKeyDer: Buffer.from(key.publicKey.export({ type: 'spki', format: 'der' })).toString('base64'),
    privateKeyDer: Buffer.from(key.privateKey.export({ type: 'pkcs8', format: 'der' })).toString('base64'),
    createdAt: input.createdAt,
  }));
  const ownedRoles = input.keys.map((key) => key.role);
  const value = {
    version: STORE_VERSION,
    metadata: {
      format: 'jinn.native-role-identities/2',
      ownedRoles,
      roles: roles.map((role) => ({
        role: role.role,
        keyId: role.keyId,
        algorithm: 'Ed25519' as const,
        createdAt: role.createdAt,
      })),
    },
    roles,
  };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(input.password, salt, SCRYPT_KEY_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = {
    version: ENVELOPE_VERSION,
    kdf: 'scrypt' as const,
    cipher: 'aes-256-gcm' as const,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  await mkdir(dirname(input.storePath), { recursive: true, mode: 0o700 });
  await writeFile(input.storePath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  await chmod(input.storePath, 0o600);
}

export interface MintedIdentityStore {
  readonly storePath: string;
  readonly keys: readonly FixtureRoleKey[];
  key(role: NativeRoleIdentityRole): FixtureRoleKey;
}

/**
 * Mints an encrypted identity store owning exactly `roles`, and returns the store path plus the
 * private role keys (for catalog authoring). The written file is byte-shape-compatible with
 * `IdentityStore.loadOrCreate`.
 */
export async function mintIdentityStore(input: {
  readonly storePath: string;
  readonly password: string;
  readonly roles: readonly NativeRoleIdentityRole[];
  readonly createdAt?: string;
}): Promise<MintedIdentityStore> {
  const keys = input.roles.map(mintRoleKey);
  await writeIdentityStore({
    storePath: input.storePath,
    password: input.password,
    keys,
    createdAt: input.createdAt ?? new Date('2026-08-01T00:00:00.000Z').toISOString(),
  });
  const byRole = new Map(keys.map((key) => [key.role, key]));
  return {
    storePath: input.storePath,
    keys,
    key(role) {
      const key = byRole.get(role);
      if (key === undefined) throw new Error(`fixture identity store does not own role ${role}`);
      return key;
    },
  };
}
