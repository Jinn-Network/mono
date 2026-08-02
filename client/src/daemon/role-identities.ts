/**
 * Native role keys are custody material, not a derivation of the operator EOA. They are created
 * once in an encrypted local store, then each boot proves their real, effective-time trust
 * binding before any native component may use them. Legacy EOA signing deliberately lives in
 * `trust-keys.ts` and is not imported here.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { chmod, mkdir, open as openFile, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import bs58 from 'bs58';
import type { BindingResolver } from '@jinn-network/trust-core';
import type { HostSecretResolver } from '@jinn-network/task-execution-backend-local';
import { EVALUATION_TASK_PROFILE_URI } from '@jinn-network/task-execution-profiles';

export const NATIVE_ROLE_IDENTITY_ROLES = [
  'requester-submission',
  'admission',
  'requester-discovery',
  'solver-delivery',
  'solver-discovery',
  'evaluator-verdict',
  'evaluator-discovery',
] as const;

export type NativeRoleIdentityRole = (typeof NATIVE_ROLE_IDENTITY_ROLES)[number];

/** Trust-core record families each native key is permitted to sign. */
export const NATIVE_ROLE_IDENTITY_REQUIREMENTS: Readonly<Record<NativeRoleIdentityRole, readonly string[]>> = {
  'requester-submission': ['authorizations'],
  admission: ['authorizations'],
  'requester-discovery': ['observations'],
  'solver-delivery': ['deliveries'],
  'solver-discovery': ['observations'],
  'evaluator-verdict': ['verdicts', 'deliveries'],
  'evaluator-discovery': ['observations'],
};

const ENVELOPE_VERSION = 1;
const STORE_VERSION = 2;
const SCRYPT_KEY_LENGTH = 32;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class IdentityStoreError extends Error {
  override readonly name = 'IdentityStoreError';
}

export interface NativeRoleIdentity {
  readonly role: NativeRoleIdentityRole;
  readonly keyId: string;
  readonly publicKey: KeyObject;
  sign(payload: Uint8Array): Uint8Array;
  verify(payload: Uint8Array, signature: Uint8Array): boolean;
}

export interface NativeRoleIdentitySetInput {
  /** Absolute, durable operator identity used in every binding-resolver query. */
  readonly agent: string;
  /** Persistent encrypted identity store path, owned by this operator process. */
  readonly storePath: string;
  /** Existing keystore password: unlocks ciphertext but is never used as key material. */
  readonly password: string;
  /** Real trust-resolve implementation; native composition has no permissive fallback. */
  readonly bindingResolver: BindingResolver;
  /** Injectable only for deterministic tests; production uses wall-clock boot time. */
  readonly now?: () => Date;
}

export type NativeRoleBindingDecision =
  | { readonly ok: true; readonly bindingDigest: string }
  | {
      readonly ok: false;
      readonly reason: 'invalid-effective-time' | 'binding-not-resolved' | 'binding-key-mismatch'
        | 'not-effective' | 'expired' | 'scope-policy-rejected' | 'revoked';
    };

interface StoredRoleIdentity {
  readonly role: NativeRoleIdentityRole;
  readonly keyId: string;
  readonly publicKeyDer: string;
  readonly privateKeyDer: string;
  readonly createdAt: string;
}

interface StoredRoleMetadata {
  readonly role: NativeRoleIdentityRole;
  readonly keyId: string;
  readonly algorithm: 'Ed25519';
  readonly createdAt: string;
}

interface StoredIdentitySetV2 {
  readonly version: 2;
  readonly metadata: {
    readonly format: 'jinn.native-role-identities/1';
    readonly roles: readonly StoredRoleMetadata[];
  };
  readonly roles: readonly StoredRoleIdentity[];
}

interface EncryptedIdentityEnvelope {
  readonly version: 1;
  readonly kdf: 'scrypt';
  readonly cipher: 'aes-256-gcm';
  readonly salt: string;
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
}

function asNativeRole(value: string): NativeRoleIdentityRole {
  if ((NATIVE_ROLE_IDENTITY_ROLES as readonly string[]).includes(value)) {
    return value as NativeRoleIdentityRole;
  }
  throw new IdentityStoreError(`identity store contains unknown role "${value}"`);
}

function parseTime(value: string, label: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new IdentityStoreError(`${label} is not a valid effective time`);
  }
  return time;
}

function publicKeyId(publicKey: KeyObject): string {
  const der = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }));
  if (der.length !== ED25519_SPKI_PREFIX.length + 32 || !der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    throw new IdentityStoreError('identity store key is not an Ed25519 SPKI key');
  }
  const multicodec = Buffer.concat([Buffer.from([0xed, 0x01]), der.subarray(ED25519_SPKI_PREFIX.length)]);
  return `did:key:z${bs58.encode(multicodec)}`;
}

function createStoredRole(role: NativeRoleIdentityRole, createdAt: string): StoredRoleIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    role,
    keyId: publicKeyId(publicKey),
    publicKeyDer: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).toString('base64'),
    privateKeyDer: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })).toString('base64'),
    createdAt,
  };
}

function metadataFor(roles: readonly StoredRoleIdentity[]): readonly StoredRoleMetadata[] {
  return roles.map((role) => ({
    role: role.role,
    keyId: role.keyId,
    algorithm: 'Ed25519',
    createdAt: role.createdAt,
  }));
}

function validateRoles(roles: readonly StoredRoleIdentity[]): readonly StoredRoleIdentity[] {
  if (roles.length !== NATIVE_ROLE_IDENTITY_ROLES.length) {
    throw new IdentityStoreError('identity store is missing a required native role identity');
  }
  const byRole = new Map<NativeRoleIdentityRole, StoredRoleIdentity>();
  for (const candidate of roles) {
    const role = asNativeRole(candidate.role);
    if (byRole.has(role)) throw new IdentityStoreError(`identity store contains duplicate role "${role}"`);
    if (typeof candidate.keyId !== 'string' || typeof candidate.publicKeyDer !== 'string' || typeof candidate.privateKeyDer !== 'string') {
      throw new IdentityStoreError(`identity store role "${role}" has invalid key material`);
    }
    let privateKey: KeyObject;
    let publicKey: KeyObject;
    try {
      privateKey = createPrivateKey({ key: Buffer.from(candidate.privateKeyDer, 'base64'), format: 'der', type: 'pkcs8' });
      publicKey = createPublicKey(privateKey);
    } catch (cause) {
      throw new IdentityStoreError(`identity store role "${role}" cannot be decoded: ${String(cause)}`);
    }
    const derivedPublicDer = Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).toString('base64');
    if (derivedPublicDer !== candidate.publicKeyDer || publicKeyId(publicKey) !== candidate.keyId) {
      throw new IdentityStoreError(`identity store role "${role}" has inconsistent public key metadata`);
    }
    byRole.set(role, { ...candidate, role });
  }
  return NATIVE_ROLE_IDENTITY_ROLES.map((role) => {
    const stored = byRole.get(role);
    if (stored === undefined) throw new IdentityStoreError(`identity store is missing required role "${role}"`);
    return stored;
  });
}

function parseStoredIdentitySet(bytes: Uint8Array): { readonly value: StoredIdentitySetV2; readonly migrated: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    throw new IdentityStoreError(`identity store plaintext is invalid JSON: ${String(cause)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { roles?: unknown }).roles)) {
    throw new IdentityStoreError('identity store plaintext has no role list');
  }
  const roles = validateRoles((parsed as { roles: StoredRoleIdentity[] }).roles);
  const version = (parsed as { version?: unknown }).version;
  if (version === 1) {
    // Add metadata only. The stored key bytes/key IDs retain their exact authority; legacy EVM
    // material is never read, transformed, or treated as a native role identity.
    return {
      value: { version: STORE_VERSION, metadata: { format: 'jinn.native-role-identities/1', roles: metadataFor(roles) }, roles },
      migrated: true,
    };
  }
  if (version !== STORE_VERSION) throw new IdentityStoreError(`identity store version ${String(version)} is unsupported`);
  const metadata = (parsed as Partial<StoredIdentitySetV2>).metadata;
  if (metadata?.format !== 'jinn.native-role-identities/1' || !Array.isArray(metadata.roles)) {
    throw new IdentityStoreError('identity store key metadata is missing');
  }
  const expectedMetadata = metadataFor(roles);
  if (JSON.stringify(metadata.roles) !== JSON.stringify(expectedMetadata)) {
    throw new IdentityStoreError('identity store key metadata does not match stored role keys');
  }
  return {
    value: { version: STORE_VERSION, metadata: { format: 'jinn.native-role-identities/1', roles: expectedMetadata }, roles },
    migrated: false,
  };
}

function encrypt(value: StoredIdentitySetV2, password: string): EncryptedIdentityEnvelope {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: ENVELOPE_VERSION,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
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
    || envelope.kdf !== 'scrypt'
    || envelope.cipher !== 'aes-256-gcm'
    || typeof envelope.salt !== 'string'
    || typeof envelope.iv !== 'string'
    || typeof envelope.authTag !== 'string'
    || typeof envelope.ciphertext !== 'string'
  ) {
    throw new IdentityStoreError('identity store envelope is malformed');
  }
  try {
    const key = scryptSync(password, Buffer.from(envelope.salt, 'base64'), SCRYPT_KEY_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
  } catch (cause) {
    throw new IdentityStoreError(`identity store cannot be decrypted: ${String(cause)}`);
  }
}

/** Encrypted, durable custody for the complete native role-key set. */
export class IdentityStore {
  private constructor(
    private readonly path: string,
    private readonly password: string,
  ) {}

  static async open(input: { readonly path: string; readonly password: string }): Promise<IdentityStore> {
    if (input.password.length === 0) throw new IdentityStoreError('identity store password is required');
    if (!isAbsolute(input.path)) throw new IdentityStoreError('identity store path must be absolute');
    await mkdir(dirname(input.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(input.path), 0o700);
    return new IdentityStore(input.path, input.password);
  }

  async loadOrCreate(now: Date): Promise<readonly StoredRoleIdentity[]> {
    let encrypted: Uint8Array | undefined;
    try {
      encrypted = await readFile(this.path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new IdentityStoreError(`identity store cannot be read: ${String(cause)}`);
      }
    }

    if (encrypted === undefined) {
      const createdAt = now.toISOString();
      const roles = NATIVE_ROLE_IDENTITY_ROLES.map((role) => createStoredRole(role, createdAt));
      await this.write({
        version: STORE_VERSION,
        metadata: { format: 'jinn.native-role-identities/1', roles: metadataFor(roles) },
        roles,
      });
      return roles;
    }

    const parsed = parseStoredIdentitySet(decrypt(encrypted, this.password));
    if (parsed.migrated) await this.write(parsed.value);
    return parsed.value.roles;
  }

  private async write(value: StoredIdentitySetV2): Promise<void> {
    const tempPath = `${this.path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
    const serialized = `${JSON.stringify(encrypt(value, this.password))}\n`;
    let temporary: Awaited<ReturnType<typeof openFile>> | undefined;
    try {
      temporary = await openFile(tempPath, 'wx', 0o600);
      await temporary.writeFile(serialized, 'utf8');
      await temporary.sync();
      await temporary.close();
      temporary = undefined;
      await chmod(tempPath, 0o600);
      await rename(tempPath, this.path);
      await chmod(this.path, 0o600);
      const directory = await openFile(dirname(this.path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (cause) {
      await temporary?.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      throw new IdentityStoreError(`identity store cannot be written atomically: ${String(cause)}`);
    }
  }
}

/**
 * A loaded native identity set. Construction validates every key's precise binding at the
 * supplied effective time; callers receive no partially trusted or fallback identity.
 */
export class RoleIdentitySet {
  private constructor(
    readonly agent: string,
    private readonly byRole: ReadonlyMap<NativeRoleIdentityRole, NativeRoleIdentity>,
    private readonly hostSecretKeys: ReadonlyMap<NativeRoleIdentityRole, KeyObject>,
    private readonly bindingResolver: BindingResolver,
    private readonly now: () => Date,
  ) {}

  static async open(input: NativeRoleIdentitySetInput): Promise<RoleIdentitySet> {
    if (input.agent.length === 0) throw new IdentityStoreError('native role identity agent is required');
    const now = input.now?.() ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new IdentityStoreError('native role identity boot time is invalid');
    const effectiveTime = now.toISOString();
    const store = await IdentityStore.open({ path: input.storePath, password: input.password });
    const storedRoles = await store.loadOrCreate(now);
    const byRole = new Map<NativeRoleIdentityRole, NativeRoleIdentity>();
    const hostSecretKeys = new Map<NativeRoleIdentityRole, KeyObject>();

    for (const stored of storedRoles) {
      const role = stored.role;
      const publicKey = createPublicKey({ key: Buffer.from(stored.publicKeyDer, 'base64'), format: 'der', type: 'spki' });
      const privateKey = createPrivateKey({ key: Buffer.from(stored.privateKeyDer, 'base64'), format: 'der', type: 'pkcs8' });
      const resolved = await input.bindingResolver.resolveBinding(
        { key: stored.keyId, agent: input.agent },
        effectiveTime,
      );
      if (resolved === null) {
        throw new IdentityStoreError(`native role "${role}" has no effective binding at boot`);
      }
      if (resolved.binding.key.didKey !== stored.keyId || resolved.binding.key.keyid !== stored.keyId) {
        throw new IdentityStoreError(`native role "${role}" binding does not identify its persisted key`);
      }
      const effectiveStart = parseTime(resolved.effectiveStart, `native role "${role}" binding effectiveStart`);
      if (effectiveStart > now.getTime()) {
        throw new IdentityStoreError(`native role "${role}" binding is not effective at boot`);
      }
      if (resolved.binding.expiresAt !== undefined && parseTime(resolved.binding.expiresAt, `native role "${role}" binding expiresAt`) < now.getTime()) {
        throw new IdentityStoreError(`native role "${role}" binding is expired at boot`);
      }
      const requiredScopes = NATIVE_ROLE_IDENTITY_REQUIREMENTS[role];
      const missingScopes = requiredScopes.filter((scope) => !resolved.binding.scope.includes(scope));
      if (missingScopes.length > 0) {
        throw new IdentityStoreError(`native role "${role}" binding lacks required ${missingScopes.join(', ')} scope`);
      }
      for (const revocation of resolved.revocations) {
        if (parseTime(revocation.effectiveTime, `native role "${role}" revocation effectiveTime`) <= now.getTime()) {
          throw new IdentityStoreError(`native role "${role}" binding is revoked at boot`);
        }
      }
      byRole.set(role, {
        role,
        keyId: stored.keyId,
        publicKey,
        sign: (payload) => new Uint8Array(cryptoSign(null, payload, privateKey)),
        verify: (payload, signature) => cryptoVerify(null, payload, publicKey, signature),
      });
      if (role === 'evaluator-verdict') {
        hostSecretKeys.set(role, privateKey);
      }
    }
    return new RoleIdentitySet(input.agent, byRole, hostSecretKeys, input.bindingResolver, input.now ?? (() => new Date()));
  }

  get(role: NativeRoleIdentityRole): NativeRoleIdentity {
    const identity = this.byRole.get(role);
    if (identity === undefined) throw new IdentityStoreError(`native role identity "${role}" is unavailable`);
    return identity;
  }

  /**
   * Re-resolves role authority at the signed record's own effective time. The successful boot
   * decision is never cached as authority for a later Delivery or verdict: policy scope,
   * validity window, and revocations are evaluated again against the durable resolver.
   */
  async resolveEffective(
    role: NativeRoleIdentityRole,
    atTime: string,
  ): Promise<NativeRoleBindingDecision> {
    const effective = Date.parse(atTime);
    if (!Number.isFinite(effective)) return { ok: false, reason: 'invalid-effective-time' };
    const identity = this.get(role);
    const resolved = await this.bindingResolver.resolveBinding(
      { key: identity.keyId, agent: this.agent },
      atTime,
    );
    if (resolved === null) return { ok: false, reason: 'binding-not-resolved' };
    if (
      resolved.binding.key.didKey !== identity.keyId
      || resolved.binding.key.keyid !== identity.keyId
    ) return { ok: false, reason: 'binding-key-mismatch' };
    const start = Date.parse(resolved.effectiveStart);
    if (!Number.isFinite(start) || start > effective) return { ok: false, reason: 'not-effective' };
    if (resolved.binding.expiresAt !== undefined) {
      const expires = Date.parse(resolved.binding.expiresAt);
      if (!Number.isFinite(expires) || expires < effective) return { ok: false, reason: 'expired' };
    }
    const requiredScopes = NATIVE_ROLE_IDENTITY_REQUIREMENTS[role];
    if (requiredScopes.some((scope) => !resolved.binding.scope.includes(scope))) {
      return { ok: false, reason: 'scope-policy-rejected' };
    }
    for (const revocation of resolved.revocations) {
      const revokedAt = Date.parse(revocation.effectiveTime);
      if (!Number.isFinite(revokedAt) || revokedAt <= effective) return { ok: false, reason: 'revoked' };
    }
    return { ok: true, bindingDigest: resolved.bindingDigest };
  }

  /**
   * Produces the backend's host-owned evaluator secret resolver. The child handle is only one
   * leg: every request must match the exact sealed Submission, evaluation profile, Attempt,
   * evaluator role, and immutable deployment registration/method selected by the host.
   */
  createEvaluatorHostSecretResolver(registration: {
    readonly handle: string;
    readonly evaluator: string;
    readonly registrationId: string;
    readonly evaluationMethodDigest: `sha256:${string}`;
    readonly authorize: (input: {
      readonly attemptUri: string;
      readonly taskDigest: `sha256:${string}`;
      readonly submission: `urn:uuid:${string}`;
      readonly submissionDigest: `sha256:${string}`;
      readonly deadline: string;
    }) => Promise<boolean> | boolean;
  }): HostSecretResolver {
    const identity = this.get('evaluator-verdict');
    if (registration.evaluator !== this.agent) {
      throw new IdentityStoreError('evaluator host-secret registration names a different agent');
    }
    const privateKey = this.hostSecretKeys.get('evaluator-verdict');
    if (privateKey === undefined) throw new IdentityStoreError('evaluator host-secret custody is unavailable');
    return {
      resolve: async (input, options) => {
        options.signal?.throwIfAborted();
        if (input.role !== 'evaluator'
          || input.launcherId !== 'evaluation-harness'
          || input.evaluator !== registration.evaluator
          || input.handle !== registration.handle
          || input.target !== registration.handle
          || input.registrationId !== registration.registrationId
          || input.evaluationMethodDigest !== registration.evaluationMethodDigest
          || input.taskProfile !== EVALUATION_TASK_PROFILE_URI
          || !/^sha256:[0-9a-f]{64}$/u.test(input.taskDigest)
          || !/^sha256:[0-9a-f]{64}$/u.test(input.submissionDigest)
          || !/^urn:uuid:/u.test(input.submission)
          || input.attempt.attemptUri.length === 0) {
          throw new IdentityStoreError('evaluator host-secret request is outside its sealed Attempt/registration scope');
        }
        if (!await registration.authorize({
          attemptUri: input.attempt.attemptUri,
          taskDigest: input.taskDigest,
          submission: input.submission,
          submissionDigest: input.submissionDigest,
          deadline: input.deadline,
        })) {
          throw new IdentityStoreError('evaluator host-secret request does not match the durable sealed evaluation');
        }
        const now = this.now();
        if (!Number.isFinite(now.getTime()) || Date.parse(input.deadline) <= now.getTime()) {
          throw new IdentityStoreError('evaluator host-secret request is expired');
        }
        const binding = await this.resolveEffective('evaluator-verdict', now.toISOString());
        if (!binding.ok || identity.keyId.length === 0) {
          throw new IdentityStoreError(`evaluator host-secret authority is not effective: ${binding.ok ? 'invalid-key' : binding.reason}`);
        }
        options.signal?.throwIfAborted();
        return new Uint8Array(Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })));
      },
    };
  }
}

export function openRoleIdentitySet(input: NativeRoleIdentitySetInput): Promise<RoleIdentitySet> {
  return RoleIdentitySet.open(input);
}
