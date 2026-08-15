// SPDX-License-Identifier: Apache-2.0

/**
 * The encrypted identity-store codec — extracted verbatim from the daemon's
 * `operator/src/daemon/role-identities.ts` per spec/2026-08-07-native-identity-ceremony.md §3.1.
 *
 * The store format (`StoredIdentitySetV3` inside a scrypt/AES-256-GCM envelope) was implemented
 * twice — once in the daemon, once shadowed by the e2e fixtures — which is the proof it is a shared
 * artifact rather than daemon-internal state. There is now exactly one implementation: the daemon
 * re-imports this module and keeps every verification-side decision (`RoleIdentitySet`, binding
 * checks, `merge`) where it was.
 *
 * The bytes are unchanged. `IdentityStore.open` defaults to the native role-identity profile, so
 * every existing daemon call site reads and writes exactly the files it did before.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  type KeyObject,
} from "node:crypto";
import { chmod, link, mkdir, open as openFile, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import bs58 from "bs58";

import { NATIVE_ROLE_IDENTITY_ROLES, type NativeRoleIdentityRole } from "./roles.js";

const ENVELOPE_VERSION = 1;
const STORE_VERSION = 3;
const SCRYPT_KEY_LENGTH = 32;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/** Bounds the lose-the-create-race retry loop in `IdentityStore.loadOrCreate`. */
const MAX_CREATE_ATTEMPTS = 5;

export class IdentityStoreError extends Error {
  override readonly name = "IdentityStoreError";
}

/**
 * Which vocabulary a store file's roles are drawn from, and which `metadata.format` tag it carries.
 * The native role store keeps its shipped tag; the catalog-authority store (§5) reuses the same
 * envelope and codec under its own tag and its own one-member vocabulary, so a role store can never
 * be mistaken for an authority store or vice versa.
 */
export interface IdentityStoreProfile<Role extends string = string> {
  readonly format: string;
  readonly vocabulary: readonly Role[];
}

export const NATIVE_ROLE_IDENTITY_STORE_PROFILE: IdentityStoreProfile<NativeRoleIdentityRole> = {
  format: "jinn.native-role-identities/2",
  vocabulary: NATIVE_ROLE_IDENTITY_ROLES,
};

export const CATALOG_AUTHORITY_ROLE = "catalog-authority" as const;
export type CatalogAuthorityRole = typeof CATALOG_AUTHORITY_ROLE;

export const CATALOG_AUTHORITY_STORE_PROFILE: IdentityStoreProfile<CatalogAuthorityRole> = {
  format: "jinn.trust-catalog-authority/1",
  vocabulary: [CATALOG_AUTHORITY_ROLE],
};

export interface StoredRoleIdentity<Role extends string = string> {
  readonly role: Role;
  readonly keyId: string;
  readonly publicKeyDer: string;
  readonly privateKeyDer: string;
  readonly createdAt: string;
}

interface StoredRoleMetadata<Role extends string = string> {
  readonly role: Role;
  readonly keyId: string;
  readonly algorithm: "Ed25519";
  readonly createdAt: string;
}

interface StoredIdentitySetV3<Role extends string = string> {
  readonly version: 3;
  readonly metadata: {
    readonly format: string;
    readonly ownedRoles: readonly Role[];
    readonly roles: readonly StoredRoleMetadata<Role>[];
  };
  readonly roles: readonly StoredRoleIdentity<Role>[];
}

interface EncryptedIdentityEnvelope {
  readonly version: 1;
  readonly kdf: "scrypt";
  readonly cipher: "aes-256-gcm";
  readonly salt: string;
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
}

function asKnownRole<Role extends string>(value: string, profile: IdentityStoreProfile<Role>): Role {
  if ((profile.vocabulary as readonly string[]).includes(value)) {
    return value as Role;
  }
  throw new IdentityStoreError(`identity store contains unknown role "${value}"`);
}

export function publicKeyId(publicKey: KeyObject): string {
  const der = Buffer.from(publicKey.export({ type: "spki", format: "der" }));
  if (
    der.length !== ED25519_SPKI_PREFIX.length + 32
    || !der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    throw new IdentityStoreError("identity store key is not an Ed25519 SPKI key");
  }
  const multicodec = Buffer.concat([Buffer.from([0xed, 0x01]), der.subarray(ED25519_SPKI_PREFIX.length)]);
  return `did:key:z${bs58.encode(multicodec)}`;
}

function createStoredRole<Role extends string>(role: Role, createdAt: string): StoredRoleIdentity<Role> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    role,
    keyId: publicKeyId(publicKey),
    publicKeyDer: Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64"),
    privateKeyDer: Buffer.from(privateKey.export({ type: "pkcs8", format: "der" })).toString("base64"),
    createdAt,
  };
}

function metadataFor<Role extends string>(
  roles: readonly StoredRoleIdentity<Role>[],
): readonly StoredRoleMetadata<Role>[] {
  return roles.map((role) => ({
    role: role.role,
    keyId: role.keyId,
    algorithm: "Ed25519",
    createdAt: role.createdAt,
  }));
}

function validateRoles<Role extends string>(
  roles: readonly StoredRoleIdentity<Role>[],
  expectedRoles: readonly Role[],
  profile: IdentityStoreProfile<Role>,
): readonly StoredRoleIdentity<Role>[] {
  if (roles.length !== expectedRoles.length) {
    throw new IdentityStoreError("identity store role set does not equal the explicitly owned role set");
  }
  const byRole = new Map<Role, StoredRoleIdentity<Role>>();
  for (const candidate of roles) {
    const role = asKnownRole(candidate.role, profile);
    if (byRole.has(role)) throw new IdentityStoreError(`identity store contains duplicate role "${role}"`);
    if (
      typeof candidate.keyId !== "string"
      || typeof candidate.publicKeyDer !== "string"
      || typeof candidate.privateKeyDer !== "string"
    ) {
      throw new IdentityStoreError(`identity store role "${role}" has invalid key material`);
    }
    let privateKey: KeyObject;
    let publicKey: KeyObject;
    try {
      privateKey = createPrivateKey({
        key: Buffer.from(candidate.privateKeyDer, "base64"),
        format: "der",
        type: "pkcs8",
      });
      publicKey = createPublicKey(privateKey);
    } catch (cause) {
      throw new IdentityStoreError(`identity store role "${role}" cannot be decoded: ${String(cause)}`);
    }
    const derivedPublicDer = Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64");
    if (derivedPublicDer !== candidate.publicKeyDer || publicKeyId(publicKey) !== candidate.keyId) {
      throw new IdentityStoreError(`identity store role "${role}" has inconsistent public key metadata`);
    }
    byRole.set(role, { ...candidate, role });
  }
  return expectedRoles.map((role) => {
    const stored = byRole.get(role);
    if (stored === undefined) throw new IdentityStoreError(`identity store is missing required role "${role}"`);
    return stored;
  });
}

function parseStoredIdentitySet<Role extends string>(
  bytes: Uint8Array,
  expectedRoles: readonly Role[],
  profile: IdentityStoreProfile<Role>,
): { readonly value: StoredIdentitySetV3<Role>; readonly migrated: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    throw new IdentityStoreError(`identity store plaintext is invalid JSON: ${String(cause)}`);
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { roles?: unknown }).roles)) {
    throw new IdentityStoreError("identity store plaintext has no role list");
  }
  const version = (parsed as { version?: unknown }).version;
  if (version === 1 || version === 2) {
    if (
      expectedRoles.length !== profile.vocabulary.length
      || expectedRoles.some((role, index) => role !== profile.vocabulary[index])
    ) {
      throw new IdentityStoreError("legacy all-role identity store cannot be narrowed or reused by a scoped production role");
    }
    const roles = validateRoles((parsed as { roles: StoredRoleIdentity<Role>[] }).roles, expectedRoles, profile);
    // Add metadata only. The stored key bytes/key IDs retain their exact authority; legacy EVM
    // material is never read, transformed, or treated as a native role identity.
    return {
      value: {
        version: STORE_VERSION,
        metadata: { format: profile.format, ownedRoles: expectedRoles, roles: metadataFor(roles) },
        roles,
      },
      migrated: true,
    };
  }
  if (version !== STORE_VERSION) throw new IdentityStoreError(`identity store version ${String(version)} is unsupported`);
  const metadata = (parsed as Partial<StoredIdentitySetV3<Role>>).metadata;
  if (
    metadata?.format !== profile.format
    || !Array.isArray(metadata.ownedRoles)
    || !Array.isArray(metadata.roles)
  ) {
    throw new IdentityStoreError("identity store key metadata is missing");
  }
  if (JSON.stringify(metadata.ownedRoles) !== JSON.stringify(expectedRoles)) {
    throw new IdentityStoreError("identity store owned role set does not match the process role set");
  }
  const roles = validateRoles((parsed as { roles: StoredRoleIdentity<Role>[] }).roles, expectedRoles, profile);
  const expectedMetadata = metadataFor(roles);
  if (JSON.stringify(metadata.roles) !== JSON.stringify(expectedMetadata)) {
    throw new IdentityStoreError("identity store key metadata does not match stored role keys");
  }
  return {
    value: {
      version: STORE_VERSION,
      metadata: { format: profile.format, ownedRoles: expectedRoles, roles: expectedMetadata },
      roles,
    },
    migrated: false,
  };
}

function encrypt<Role extends string>(
  value: StoredIdentitySetV3<Role>,
  password: string,
): EncryptedIdentityEnvelope {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: ENVELOPE_VERSION,
    kdf: "scrypt",
    cipher: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decrypt(bytes: Uint8Array, password: string): Uint8Array {
  let envelope: Partial<EncryptedIdentityEnvelope>;
  try {
    envelope = JSON.parse(new TextDecoder().decode(bytes)) as Partial<EncryptedIdentityEnvelope>;
  } catch (cause) {
    throw new IdentityStoreError(`identity store envelope is invalid JSON: ${String(cause)}`);
  }
  if (
    envelope.version !== ENVELOPE_VERSION
    || envelope.kdf !== "scrypt"
    || envelope.cipher !== "aes-256-gcm"
    || typeof envelope.salt !== "string"
    || typeof envelope.iv !== "string"
    || typeof envelope.authTag !== "string"
    || typeof envelope.ciphertext !== "string"
  ) {
    throw new IdentityStoreError("identity store envelope is malformed");
  }
  try {
    const key = scryptSync(password, Buffer.from(envelope.salt, "base64"), SCRYPT_KEY_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
  } catch (cause) {
    throw new IdentityStoreError(`identity store cannot be decrypted: ${String(cause)}`);
  }
}

/** Encrypted, durable custody for one explicit process-owned role set. */
export class IdentityStore<Role extends string = NativeRoleIdentityRole> {
  private constructor(
    private readonly path: string,
    private readonly password: string,
    private readonly profile: IdentityStoreProfile<Role>,
  ) {}

  static async open(input: {
    readonly path: string;
    readonly password: string;
  }): Promise<IdentityStore<NativeRoleIdentityRole>>;
  static async open<Role extends string>(input: {
    readonly path: string;
    readonly password: string;
    readonly profile: IdentityStoreProfile<Role>;
  }): Promise<IdentityStore<Role>>;
  static async open(input: {
    readonly path: string;
    readonly password: string;
    readonly profile?: IdentityStoreProfile<string>;
  }): Promise<IdentityStore<string>> {
    if (input.password.length === 0) throw new IdentityStoreError("identity store password is required");
    if (!isAbsolute(input.path)) throw new IdentityStoreError("identity store path must be absolute");
    // `mkdir` resolves to the first directory path it actually created, or `undefined` when the
    // whole chain already existed. Only chmod in the former case: an operator-supplied `--store`
    // path can land inside a pre-existing directory (even $HOME), and this must never silently
    // narrow that directory's mode.
    const createdDir = await mkdir(dirname(input.path), { recursive: true, mode: 0o700 });
    if (createdDir !== undefined) await chmod(dirname(input.path), 0o700);
    return new IdentityStore(
      input.path,
      input.password,
      input.profile ?? (NATIVE_ROLE_IDENTITY_STORE_PROFILE as IdentityStoreProfile<string>),
    );
  }

  /**
   * Loads the persisted role set, or mints and persists one if absent. `created` reflects
   * whether *this* call's mint is the one now on disk — never a lost race's in-memory keys (see
   * `createExclusive`). Bounded retry: losing the create race means someone else's file is now
   * readable, so the loop falls through to the load branch; it only spins again if that file
   * vanishes before the reread (a second, rarer race), and gives up loudly past
   * `MAX_CREATE_ATTEMPTS` rather than spinning forever against an adversarial deleter.
   */
  async loadOrCreate(
    now: Date,
    ownedRoles: readonly Role[],
  ): Promise<{ readonly created: boolean; readonly roles: readonly StoredRoleIdentity<Role>[] }> {
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      let encrypted: Uint8Array | undefined;
      try {
        // eslint-disable-next-line no-await-in-loop -- each attempt depends on the previous one's outcome.
        encrypted = await readFile(this.path);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new IdentityStoreError(`identity store cannot be read: ${String(cause)}`);
        }
      }

      if (encrypted === undefined) {
        const createdAt = now.toISOString();
        const roles = ownedRoles.map((role) => createStoredRole(role, createdAt));
        const value: StoredIdentitySetV3<Role> = {
          version: STORE_VERSION,
          metadata: { format: this.profile.format, ownedRoles, roles: metadataFor(roles) },
          roles,
        };
        // eslint-disable-next-line no-await-in-loop -- see loop doc above.
        const won = await this.createExclusive(value);
        if (won) return { created: true, roles };
        continue; // a concurrent creator's exclusive link won; reread and return its content.
      }

      const parsed = parseStoredIdentitySet(decrypt(encrypted, this.password), ownedRoles, this.profile);
      // eslint-disable-next-line no-await-in-loop -- see loop doc above.
      if (parsed.migrated) await this.write(parsed.value);
      return { created: false, roles: parsed.value.roles };
    }
    throw new IdentityStoreError(
      `identity store at ${this.path} did not converge after ${MAX_CREATE_ATTEMPTS} concurrent create attempts`,
    );
  }

  private async writeTempFile(value: StoredIdentitySetV3<Role>): Promise<string> {
    const tempPath = `${this.path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    const serialized = `${JSON.stringify(encrypt(value, this.password))}\n`;
    const temporary = await openFile(tempPath, "wx", 0o600);
    try {
      await temporary.writeFile(serialized, "utf8");
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    await chmod(tempPath, 0o600);
    return tempPath;
  }

  private async syncContainingDir(): Promise<void> {
    const directory = await openFile(dirname(this.path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  /**
   * Rewrites an already-existing store (format migration only). The caller has already
   * confirmed a store is present, so overwriting it via atomic rename is intentional here —
   * unlike first-create, there is no "which concurrent writer should win" question to answer.
   */
  private async write(value: StoredIdentitySetV3<Role>): Promise<void> {
    let tempPath: string | undefined;
    try {
      tempPath = await this.writeTempFile(value);
      await rename(tempPath, this.path);
      tempPath = undefined;
      await chmod(this.path, 0o600);
      await this.syncContainingDir();
    } catch (cause) {
      if (tempPath !== undefined) await unlink(tempPath).catch(() => undefined);
      throw new IdentityStoreError(`identity store cannot be written atomically: ${String(cause)}`);
    }
  }

  /**
   * Claims `this.path` for `value` only if nothing is persisted there yet. Uses a hard link
   * (atomic, fails EEXIST if the destination already exists) rather than `rename` (which would
   * silently clobber a concurrent creator's already-won file with this call's own mint, or vice
   * versa, depending purely on timing). Returns whether `value` is the one now on disk: `false`
   * means a concurrent creator's link won this race, and its content — not `value` — is what
   * `this.path` now holds.
   */
  private async createExclusive(value: StoredIdentitySetV3<Role>): Promise<boolean> {
    let tempPath: string | undefined;
    try {
      tempPath = await this.writeTempFile(value);
      try {
        await link(tempPath, this.path);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw cause;
      }
      await chmod(this.path, 0o600);
      await this.syncContainingDir();
      return true;
    } catch (cause) {
      throw new IdentityStoreError(`identity store cannot be created exclusively: ${String(cause)}`);
    } finally {
      if (tempPath !== undefined) await unlink(tempPath).catch(() => undefined);
    }
  }
}
