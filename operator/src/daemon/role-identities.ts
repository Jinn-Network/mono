/**
 * Native role keys are custody material, not a derivation of the operator EOA. They are created
 * once in an encrypted local store, then each boot proves their real, effective-time trust
 * binding before any native component may use them. Legacy EOA signing deliberately lives in
 * `trust-keys.ts` and is not imported here.
 *
 * The encrypted store CODEC — the envelope, the `StoredIdentitySetV3` parse/validate, and
 * `IdentityStore` with its exclusive-link create and atomic rewrite — now lives in
 * `@jinn-network/trust-authoring` (spec/2026-08-07-native-identity-ceremony.md §3.1): the format is
 * a shared artifact, written by the ceremony and read here, so there is exactly one implementation
 * of it. Everything below is verification-side and unchanged — which store bytes mean what is not a
 * decision this file makes, but whether a key may sign is.
 */
import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { BindingResolver } from '@jinn-network/trust-core';
import {
  IdentityStore,
  IdentityStoreError,
  NATIVE_ROLE_IDENTITY_REQUIREMENTS,
  NATIVE_ROLE_IDENTITY_ROLES,
  type NativeRoleIdentityRole,
} from '@jinn-network/trust-authoring';

export {
  IdentityStore,
  IdentityStoreError,
  NATIVE_ROLE_IDENTITY_REQUIREMENTS,
  NATIVE_ROLE_IDENTITY_ROLES,
};
export type { NativeRoleIdentityRole };

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
  /** Roles actually owned by this process. Omission retains the pre-cutover all-role test API. */
  readonly requiredRoles?: readonly NativeRoleIdentityRole[];
  /** Persistent encrypted identity store path, owned by this operator process. */
  readonly storePath: string;
  /** Existing keystore password: unlocks ciphertext but is never used as key material. */
  readonly password: string;
  /** Real trust-resolve implementation; native composition has no permissive fallback. */
  readonly bindingResolver: BindingResolver;
  /** Full ceremony/DSSE/policy verification supplied by the native trust authority. */
  readonly verifyRoleBinding?: (input: {
    readonly role: NativeRoleIdentityRole;
    readonly key: string;
    readonly agent: string;
    readonly family: string;
    readonly atTime: string;
  }) => Promise<{ readonly bindingDigest: `sha256:${string}` }>;
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

function parseTime(value: string, label: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new IdentityStoreError(`${label} is not a valid effective time`);
  }
  return time;
}

/**
 * A loaded native identity set. Construction validates every key's precise binding at the
 * supplied effective time; callers receive no partially trusted or fallback identity.
 */
export class RoleIdentitySet {
  private constructor(
    readonly agent: string,
    private readonly byRole: ReadonlyMap<NativeRoleIdentityRole, NativeRoleIdentity>,
    private readonly bindingResolver: BindingResolver,
    private readonly now: () => Date,
  ) {}

  static async open(input: NativeRoleIdentitySetInput): Promise<RoleIdentitySet> {
    if (input.agent.length === 0) throw new IdentityStoreError('native role identity agent is required');
    const now = input.now?.() ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new IdentityStoreError('native role identity boot time is invalid');
    const effectiveTime = now.toISOString();
    const store = await IdentityStore.open({ path: input.storePath, password: input.password });
    const requiredRoles = input.requiredRoles ?? NATIVE_ROLE_IDENTITY_ROLES;
    const required = new Set<NativeRoleIdentityRole>();
    for (const role of requiredRoles) {
      if (required.has(role)) throw new IdentityStoreError(`native role "${role}" is requested more than once`);
      required.add(role);
    }
    if (required.size === 0) throw new IdentityStoreError('native process must own at least one role identity');
    const orderedRequired = NATIVE_ROLE_IDENTITY_ROLES.filter((role) => required.has(role));
    const { roles: storedRoles } = await store.loadOrCreate(now, orderedRequired);
    const byRole = new Map<NativeRoleIdentityRole, NativeRoleIdentity>();

    for (const stored of storedRoles) {
      const role = stored.role;
      if (!required.has(role)) continue;
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
      if (input.verifyRoleBinding !== undefined) {
        for (const family of requiredScopes) {
          // eslint-disable-next-line no-await-in-loop -- every owned role/family is an independent authority gate.
          await input.verifyRoleBinding({
            role,
            key: stored.keyId,
            agent: input.agent,
            family,
            atTime: effectiveTime,
          });
        }
      }
      byRole.set(role, {
        role,
        keyId: stored.keyId,
        publicKey,
        sign: (payload) => new Uint8Array(cryptoSign(null, payload, privateKey)),
        verify: (payload, signature) => cryptoVerify(null, payload, publicKey, signature),
      });
    }
    if (byRole.size !== required.size) throw new IdentityStoreError('identity store did not load every process-owned role');
    return new RoleIdentitySet(
      input.agent,
      byRole,
      input.bindingResolver,
      input.now ?? (() => new Date()),
    );
  }

  /**
   * Unions several per-store role sets into the ONE `RoleIdentitySet` the fleet daemon's native
   * composition takes (one-swap M2, umbrella #2461).
   *
   * `identityStores` (config shape-v2, M1) is keyed by role FAMILY — requester, admission, solver,
   * evaluator — each a separate encrypted file, and `RoleIdentitySet.open` loads exactly one of
   * them. `composition-root.ts`'s native mode, however, reads across families off a single set:
   * `solver-delivery` / `solver-settlement` / `solver-discovery` for delivery signing, publication
   * and settlement, plus `requester-submission` for the projector's requester-association
   * resolver. A multi-role fleet process therefore has to present one set over several stores.
   *
   * This is a union, never a widening of authority. Every input set was already opened by
   * `RoleIdentitySet.open`, so each key in it has already proved its own effective-time binding,
   * scope and non-revocation. Merging adds no role that no store owned, re-resolves nothing, and
   * caches no decision: `resolveEffective` on the merged set still goes back to the resolver at
   * the signed record's own effective time.
   *
   * Refuses two things outright rather than picking a winner: an empty input, and sets that do not
   * share one Agent IRI (a merged set has exactly one `agent`, and `composition-root.ts` checks it
   * against `nativeClaimRuntime.operatorAgent`). A role owned by two sets is also a refusal — two
   * files claiming the same signing authority is a custody fault, not something to resolve by
   * order.
   */
  static merge(sets: readonly RoleIdentitySet[]): RoleIdentitySet {
    const [first, ...rest] = sets;
    if (first === undefined) throw new IdentityStoreError('native role identity merge requires at least one set');
    for (const set of rest) {
      if (set.agent !== first.agent) {
        throw new IdentityStoreError('native role identity sets do not share one Agent IRI');
      }
      if (set.bindingResolver !== first.bindingResolver) {
        throw new IdentityStoreError('native role identity sets do not share one binding resolver');
      }
    }
    const byRole = new Map<NativeRoleIdentityRole, NativeRoleIdentity>();
    for (const set of sets) {
      for (const [role, identity] of set.byRole) {
        if (byRole.has(role)) {
          throw new IdentityStoreError(`native role "${role}" is owned by more than one identity store`);
        }
        byRole.set(role, identity);
      }
    }
    return new RoleIdentitySet(first.agent, byRole, first.bindingResolver, first.now);
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

}

export function openRoleIdentitySet(input: NativeRoleIdentitySetInput): Promise<RoleIdentitySet> {
  return RoleIdentitySet.open(input);
}

/** Public role material only — never a private key, never enough to sign. */
export interface RoleIdentitySummary {
  readonly role: NativeRoleIdentityRole;
  readonly keyId: string;
}

/**
 * Opens the identity store at `storePath` for `ownedRoles` (minting it first when `create` is
 * true and no store exists yet) and returns only public role -> keyId material for trust-catalog
 * authoring. Reuses `IdentityStore` directly rather than `RoleIdentitySet.open`: keygen/listing
 * has no agent or binding resolver to check against, and the return shape structurally excludes
 * the private key bytes `IdentityStore.loadOrCreate` also holds.
 *
 * Concurrency: correctness against a concurrent creator (e.g. this call racing a native daemon's
 * own first boot on the same store path) lives entirely in `IdentityStore.loadOrCreate`'s
 * exclusive-link create path, not here. A verify-after-the-fact re-read cannot be made correct —
 * it only catches the narrow interleaving where the competing write lands inside the verify
 * window, not the dominant one where this call's own write, read-back, and print all complete
 * before the competitor's later write clobbers the file. `created`/`identities` below are exactly
 * what `loadOrCreate` reports as actually persisted; there is no second read here.
 */
export async function listRoleIdentityKeyIds(input: {
  readonly storePath: string;
  readonly password: string;
  readonly ownedRoles: readonly NativeRoleIdentityRole[];
  readonly create: boolean;
  readonly now?: () => Date;
}): Promise<{ readonly created: boolean; readonly identities: readonly RoleIdentitySummary[] }> {
  if (!isAbsolute(input.storePath)) throw new IdentityStoreError('identity store path must be absolute');
  if (!input.create) {
    try {
      await stat(input.storePath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new IdentityStoreError(`identity store cannot be accessed: ${String(cause)}`);
      }
      throw new IdentityStoreError(
        `identity store does not exist at ${input.storePath}; pass create: true to mint its role identities`,
      );
    }
  }
  const store = await IdentityStore.open({ path: input.storePath, password: input.password });
  const now = input.now?.() ?? new Date();
  const { created, roles } = await store.loadOrCreate(now, input.ownedRoles);
  return {
    created,
    identities: roles.map((role) => ({ role: role.role, keyId: role.keyId })),
  };
}
