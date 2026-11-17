// SPDX-License-Identifier: Apache-2.0

/**
 * Trust-catalog authoring (spec §3.2, §5, §6 law 3): genesis, late join, policy succession, and
 * rotation (revocation and rebind) for the `jinn.native-trust-catalog/2` file
 * `openNativeTrustCatalog` reads.
 *
 * Governance shape, restated where it is enforced: policies are signed by a DEDICATED catalog
 * authority key (never an operator role key), the genesis digest never changes after `authorCatalog`,
 * and every later membership change is a hash-linked successor rather than a rewrite — so existing
 * operators' `trustPolicyGenesisDigest` pins stay valid across every join.
 */
import { link, open as openFile, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  didPkh,
  isCalendarStrictRfc3339,
  recordDigest,
  recoverEip191Address,
  sealRevocation,
  sealTrustPolicy,
  toChecksumAddress,
  TRUST_REVOCATION_FORMAT,
  TRUST_REVOCATION_MEDIA_TYPE,
  validateKeyBinding,
  validateRevocation,
  validateTrustPolicy,
  type DidPkh,
  type DsseSigner,
  type KeyBinding,
  type Revocation,
  type Sha256Digest,
  type SignerSet,
  type TrustPolicy,
} from "@jinn-network/trust-core";

import { NATIVE_ANCHOR_CHAIN_ID, type AnchorDeclaration } from "./anchor.js";
import type { SealedBindingEntry } from "./binding.js";
import type { CeremonySigner } from "./ceremony.js";
import { TrustAuthoringError } from "./errors.js";
import type { NativeRoleIdentityRole } from "./roles.js";

export const NATIVE_TRUST_CATALOG_FORMAT = "jinn.native-trust-catalog/2" as const;
export const TRUST_POLICY_PROTOCOL = "https://spec.jinn.network/trust/policy/v1" as const;

/** The core-registered admission purpose, carried alongside the `native:admission` spelling (§6). */
export const ADMISSION_AGENT_PURPOSE = "admission-agent" as const;
export const NATIVE_ADMISSION_PURPOSE = "native:admission" as const;
export const EVALUATOR_ELIGIBILITY_PURPOSE = "evaluator-eligibility" as const;

export interface CatalogAuthority {
  readonly keyId: string;
  readonly dsseSigner: DsseSigner;
}

export interface RoleAgent {
  readonly role: NativeRoleIdentityRole;
  readonly agent: string;
}

function b64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function nativeRolePurpose(role: NativeRoleIdentityRole): string {
  return `native:${role}`;
}

function unionAccepted(
  purposes: TrustPolicy["purposes"],
  purpose: string,
  agents: readonly string[],
  requiredStrength: "strong" | "weak",
): void {
  const existing = purposes[purpose];
  const accepted = new Set(existing?.accepted ?? []);
  for (const agent of agents) accepted.add(agent);
  purposes[purpose] = {
    ...(existing ?? {}),
    accepted: [...accepted],
    requiredStrength: existing?.requiredStrength ?? requiredStrength,
  };
}

/**
 * §6 law 3's completeness, authored rather than discovered: an entry for every `native:<role>` any
 * bound key will be verified under, BOTH admission spellings, and `evaluator-eligibility`.
 *
 * The last two are the ones a catalog silently omits and then fails on: `policyFor` throws on any
 * absent purpose, and `createVerdictGate` resolves `evaluator-eligibility` eagerly at evaluator
 * boot — so a catalog missing it boots solver and requester and then refuses the evaluator.
 * Admission and evaluator agent sets default to whoever owns the corresponding roles.
 */
export function completePolicyPurposes(input: {
  readonly roleAgents: readonly RoleAgent[];
  /** Defaults to the agents owning the `admission` role. */
  readonly admissionAgents?: readonly string[];
  /** Defaults to the agents owning any `evaluator-*` role. */
  readonly evaluatorAgents?: readonly string[];
  readonly requiredStrength?: "strong" | "weak";
}): TrustPolicy["purposes"] {
  const strength = input.requiredStrength ?? "strong";
  const purposes: TrustPolicy["purposes"] = {};
  for (const { role, agent } of input.roleAgents) {
    unionAccepted(purposes, nativeRolePurpose(role), [agent], strength);
  }
  const admissionAgents = input.admissionAgents
    ?? input.roleAgents.filter(({ role }) => role === "admission").map(({ agent }) => agent);
  const evaluatorAgents = input.evaluatorAgents
    ?? input.roleAgents.filter(({ role }) => role.startsWith("evaluator-")).map(({ agent }) => agent);
  // Both admission spellings carry the same admission-agent IRIs; the entries exist even when the
  // deployment provisions no admission or evaluator custody, because absence is a refusal, not a
  // degraded mode.
  unionAccepted(purposes, NATIVE_ADMISSION_PURPOSE, admissionAgents, strength);
  unionAccepted(purposes, ADMISSION_AGENT_PURPOSE, admissionAgents, strength);
  unionAccepted(purposes, EVALUATOR_ELIGIBILITY_PURPOSE, evaluatorAgents, strength);
  return purposes;
}

function bindingEntry(binding: SealedBindingEntry): Record<string, unknown> {
  return {
    digest: binding.digest,
    envelope: b64(binding.envelopeBytes),
    ceremony: {
      type: "eoa",
      message: binding.ceremony.message,
      messageBytes: b64(binding.ceremony.messageBytes),
      signature: b64(binding.ceremony.signature),
    },
  };
}

interface CatalogFile {
  readonly schemaVersion: 2;
  readonly format: typeof NATIVE_TRUST_CATALOG_FORMAT;
  readonly policyGenesisDigest: string;
  readonly policies: readonly { readonly digest: string; readonly envelope: string }[];
  readonly anchors: readonly AnchorDeclaration[];
  readonly bindings: readonly Record<string, unknown>[];
  readonly revocations: readonly { readonly digest: string; readonly envelope: string }[];
}

function dedupeByDigest(bindings: readonly SealedBindingEntry[]): readonly SealedBindingEntry[] {
  const byDigest = new Map<string, SealedBindingEntry>();
  for (const binding of bindings) {
    if (!byDigest.has(binding.digest)) byDigest.set(binding.digest, binding);
  }
  return [...byDigest.values()];
}

function assertPurposesCoverBindings(
  purposes: TrustPolicy["purposes"],
  bindings: readonly SealedBindingEntry[],
): void {
  for (const binding of bindings) {
    const purpose = nativeRolePurpose(binding.role);
    const entry = purposes[purpose];
    if (entry === undefined) {
      throw new TrustAuthoringError(`trust policy has no ${purpose} purpose for a bound ${binding.role} key`);
    }
    if (!entry.accepted.includes(binding.agent)) {
      throw new TrustAuthoringError(`trust policy ${purpose} does not accept ${binding.agent}`);
    }
  }
}

/**
 * §6 law 3's three non-derivable purposes, asserted rather than merely produced.
 *
 * `assertPurposesCoverBindings` already covers every `native:<role>` a binding is authored for, but
 * these three are bound to NO key — nothing in the binding set implies them — so a caller that
 * hand-builds `purposes` instead of using `completePolicyPurposes` can omit them and get a catalog
 * that authors cleanly, boots solver and requester, and then refuses the EVALUATOR: `policyFor`
 * throws on any absent purpose, and `createVerdictGate` resolves `evaluator-eligibility` eagerly at
 * evaluator boot. Until now law 3 was enforced only by USING `completePolicyPurposes` — a
 * convention, not a check.
 */
function assertLawThreePurposes(purposes: TrustPolicy["purposes"]): void {
  const missing = [NATIVE_ADMISSION_PURPOSE, ADMISSION_AGENT_PURPOSE, EVALUATOR_ELIGIBILITY_PURPOSE]
    .filter((purpose) => purposes[purpose] === undefined);
  if (missing.length > 0) {
    throw new TrustAuthoringError(
      `trust policy is missing the mandatory ${missing.join(", ")} purpose `
        + `entr${missing.length === 1 ? "y" : "ies"} (§6 law 3); build purposes with completePolicyPurposes`,
    );
  }
}

/**
 * Seals the genesis policy and writes the catalog. Refuses to overwrite an existing path: a second
 * genesis at the same location would strand every pin that named the first one.
 */
export async function authorCatalog(input: {
  readonly path: string;
  readonly authority: CatalogAuthority;
  readonly purposes: TrustPolicy["purposes"];
  readonly refreshBy: string;
  readonly bindings: readonly SealedBindingEntry[];
  readonly anchors: readonly AnchorDeclaration[];
  readonly signerSet?: SignerSet;
}): Promise<{ readonly policyGenesisDigest: `sha256:${string}`; readonly newestPolicyVersion: number }> {
  const bindings = dedupeByDigest(input.bindings);
  if (bindings.length === 0) throw new TrustAuthoringError("a trust catalog requires at least one binding");
  if (input.anchors.length === 0) throw new TrustAuthoringError("a trust catalog requires at least one anchor");
  assertLawThreePurposes(input.purposes);
  assertPurposesCoverBindings(input.purposes, bindings);
  for (const binding of bindings) {
    if (!input.anchors.some(({ digest }) => digest === binding.anchorDigest)) {
      throw new TrustAuthoringError(`binding ${binding.digest} references undeclared anchor ${binding.anchorDigest}`);
    }
  }

  const policy: TrustPolicy = {
    protocol: TRUST_POLICY_PROTOCOL,
    version: 1,
    purposes: input.purposes,
    signerSet: input.signerSet ?? { keys: [input.authority.keyId], threshold: 1 },
    refreshBy: input.refreshBy,
  };
  const sealed = await sealTrustPolicy(policy, input.authority.dsseSigner);

  const catalog: CatalogFile = {
    schemaVersion: 2,
    format: NATIVE_TRUST_CATALOG_FORMAT,
    policyGenesisDigest: sealed.recordDigest,
    policies: [{ digest: sealed.recordDigest, envelope: b64(sealed.envelopeBytes) }],
    anchors: [...input.anchors],
    bindings: bindings.map(bindingEntry),
    revocations: [],
  };
  await writeExclusive(input.path, JSON.stringify(catalog));
  return { policyGenesisDigest: sealed.recordDigest, newestPolicyVersion: 1 };
}

/**
 * Stages `contents` in a sibling temp file, fully written and fsynced, and returns its path.
 *
 * A failed stage removes its own temp file: the caller has no path to clean up yet (this function
 * has not returned one), so leaving it would strand a partial file next to the catalog on every
 * interrupted write.
 */
async function stageTempFile(path: string, contents: string): Promise<string> {
  const tempPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const handle = await openFile(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (cause) {
    await handle.close();
    await unlink(tempPath).catch(() => undefined);
    throw cause;
  }
  await handle.close();
  return tempPath;
}

async function syncContainingDir(path: string): Promise<void> {
  const directory = await openFile(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/**
 * Creates the catalog at `path` ATOMICALLY and only if nothing is there yet — staged in a temp file
 * that is fully written and fsynced first, then hard-linked into place (atomic; EEXIST means the
 * path was already claimed).
 *
 * The temp+link shape, rather than a plain `open(path, "wx")` + write, is what makes the
 * never-overwrite refusal SAFE. Under `wx`+write, a crash between the two steps leaves a truncated
 * file that is indistinguishable from a real catalog to the EEXIST check — so every later
 * re-author refuses, and the operator has to `rm` a file this tool told them never to overwrite.
 * `link` is used rather than `rename` for the same reason `IdentityStore.createExclusive` does:
 * rename would silently clobber a concurrent creator's already-won file.
 */
async function writeExclusive(path: string, contents: string): Promise<void> {
  let tempPath: string | undefined;
  try {
    tempPath = await stageTempFile(path, contents);
    try {
      await link(tempPath, path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
        throw new TrustAuthoringError(`trust catalog already exists at ${path}; genesis never overwrites`);
      }
      throw cause;
    }
    await syncContainingDir(path);
  } catch (cause) {
    if (cause instanceof TrustAuthoringError) throw cause;
    throw new TrustAuthoringError(`trust catalog cannot be created: ${String(cause)}`);
  } finally {
    // `link` leaves the source in place, so the temp is always ours to remove — on success and on
    // failure alike. A failed genesis therefore leaves neither a catalog nor litter.
    if (tempPath !== undefined) await unlink(tempPath).catch(() => undefined);
  }
}

/**
 * A whole-file lock around the read-check-rewrite that every join and refresh performs.
 *
 * The digest compare alone is TOCTOU: two joins that both read version N can both seal a successor,
 * and the loser's write lands after the winner's — a LOST UPDATE, not the loud refusal §7 promises.
 * (Even that is fail-closed downstream — two successors sharing a predecessor trips
 * `rollback-detected` at every verifier — but a silently dropped join is a worse failure than a
 * refusal.) The `wx` lock file makes one of the two refuse before it reads anything.
 */
async function withCatalogLock<T>(path: string, body: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  let handle;
  try {
    handle = await openFile(lockPath, "wx", 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      throw new TrustAuthoringError(
        `another trust-catalog write holds ${lockPath}; joins are serialized through the coordinator. `
          + "Re-run once it finishes, or remove the lock file if no write is in progress.",
      );
    }
    throw new TrustAuthoringError(`trust catalog lock cannot be acquired: ${String(cause)}`);
  }
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.close();
    return await body();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

interface LoadedCatalog {
  readonly file: CatalogFile;
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
  readonly newest: { readonly digest: `sha256:${string}`; readonly value: TrustPolicy };
}

async function loadCatalog(path: string): Promise<LoadedCatalog> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    throw new TrustAuthoringError(`trust catalog cannot be read at ${path}: ${String(cause)}`);
  }
  let file: CatalogFile;
  try {
    file = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as CatalogFile;
  } catch (cause) {
    throw new TrustAuthoringError(`trust catalog at ${path} is not JSON: ${String(cause)}`);
  }
  if (file.format !== NATIVE_TRUST_CATALOG_FORMAT || file.schemaVersion !== 2) {
    throw new TrustAuthoringError(`trust catalog at ${path} is not a ${NATIVE_TRUST_CATALOG_FORMAT} file`);
  }
  return { file, bytes, digest: recordDigest(bytes), newest: newestPolicy(file) };
}

/**
 * Walks the hash-linked policy chain to its tail. Deliberately structural, not cryptographic: the
 * chain's dual-threshold signature verification is `verifyPolicyChain`'s job at open time, and
 * duplicating it here would be a second, divergable verifier.
 */
function newestPolicy(file: CatalogFile): { readonly digest: `sha256:${string}`; readonly value: TrustPolicy } {
  const parsed = file.policies.map((entry) => {
    const envelopeBytes = new Uint8Array(Buffer.from(entry.envelope, "base64"));
    const report = validateTrustPolicy(envelopeBytes);
    if (!report.conforms || report.value === undefined) {
      throw new TrustAuthoringError(`trust catalog policy ${entry.digest} is not a conforming sealed TrustPolicy`);
    }
    return { digest: recordDigest(envelopeBytes), value: report.value };
  });
  const genesis = parsed.filter(({ value }) => value.predecessor === undefined);
  if (genesis.length !== 1) {
    throw new TrustAuthoringError(`trust catalog has ${genesis.length} genesis policies; expected exactly one`);
  }
  if (genesis[0]!.digest !== file.policyGenesisDigest) {
    throw new TrustAuthoringError("trust catalog genesis digest does not match its genesis policy");
  }
  let current = genesis[0]!;
  const seen = new Set<string>([current.digest]);
  for (;;) {
    const children = parsed.filter(({ value, digest }) => value.predecessor === current.digest && !seen.has(digest));
    if (children.length === 0) return current;
    if (children.length > 1) {
      throw new TrustAuthoringError(`trust catalog policy ${current.digest} has ${children.length} successors`);
    }
    current = children[0]!;
    seen.add(current.digest);
  }
}

async function rewriteAtomically(input: {
  readonly path: string;
  readonly contents: string;
  readonly expectedDigest: `sha256:${string}`;
}): Promise<void> {
  // Read-check-rewrite: a concurrent join that landed between our read and this write produces one
  // loud refusal rather than two successors sharing a predecessor.
  const current = await readFile(input.path).catch((cause: unknown) => {
    throw new TrustAuthoringError(`trust catalog disappeared before rewrite: ${String(cause)}`);
  });
  if (recordDigest(current) !== input.expectedDigest) {
    throw new TrustAuthoringError(
      "trust catalog changed on disk since it was read; re-run the join against the current catalog",
    );
  }
  const tempPath = `${input.path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let handle;
  try {
    handle = await openFile(tempPath, "wx", 0o600);
    await handle.writeFile(input.contents, "utf8");
    await handle.sync();
  } catch (cause) {
    await unlink(tempPath).catch(() => undefined);
    throw new TrustAuthoringError(`trust catalog cannot be staged: ${String(cause)}`);
  } finally {
    await handle?.close();
  }
  try {
    await rename(tempPath, input.path);
  } catch (cause) {
    await unlink(tempPath).catch(() => undefined);
    throw new TrustAuthoringError(`trust catalog cannot be rewritten atomically: ${String(cause)}`);
  }
}

async function sealSuccessor(input: {
  readonly authority: CatalogAuthority;
  readonly newest: { readonly digest: `sha256:${string}`; readonly value: TrustPolicy };
  readonly purposes: TrustPolicy["purposes"];
  readonly refreshBy: string;
  readonly signerSet?: SignerSet;
}): Promise<{ readonly digest: `sha256:${string}`; readonly envelopeBytes: Uint8Array; readonly version: number }> {
  const version = input.newest.value.version + 1;
  // `TrustPolicy` is a `z.looseObject`, so a policy legitimately carries fields this package has
  // never heard of. Reconstructing the successor from a fixed field list silently DROPPED every one
  // of them — a successor that quietly deletes a term the predecessor carried is a governance
  // change nobody authored. Carry the predecessor forward whole and override only what succession
  // itself owns.
  const successor: TrustPolicy = {
    ...input.newest.value,
    protocol: TRUST_POLICY_PROTOCOL,
    version,
    predecessor: input.newest.digest as Sha256Digest,
    purposes: input.purposes,
    signerSet: input.signerSet ?? input.newest.value.signerSet,
    refreshBy: input.refreshBy,
  };
  const sealed = await sealTrustPolicy(successor, input.authority.dsseSigner);
  return { digest: sealed.recordDigest, envelopeBytes: sealed.envelopeBytes, version };
}

/**
 * Late join (spec §4.2): appends the joiner's bindings and their anchor, and seals a policy
 * SUCCESSOR whose per-purpose `accepted` lists now include the joiner's IRIs. The genesis digest is
 * unchanged by construction, so **existing operators' configs are untouched** — distribution is a
 * file copy plus a daemon restart (`assertFresh` makes a changed catalog under a running daemon a
 * hard refusal by design).
 */
export async function appendOperator(input: {
  readonly catalogPath: string;
  readonly authority: CatalogAuthority;
  readonly newBindings: readonly SealedBindingEntry[];
  readonly newAnchor: AnchorDeclaration;
  readonly refreshBy: string;
  /** Extra purposes to union in beyond those derived from `newBindings` (e.g. evaluator IRIs). */
  readonly additionalPurposes?: TrustPolicy["purposes"];
  readonly signerSet?: SignerSet;
}): Promise<{
  readonly newestPolicyVersion: number;
  readonly policyGenesisDigest: `sha256:${string}`;
}> {
  const newBindings = dedupeByDigest(input.newBindings);
  if (newBindings.length === 0) throw new TrustAuthoringError("a join requires at least one new binding");
  // The lock spans the whole read-check-rewrite, not just the write: a concurrent join that read
  // the same predecessor would otherwise seal a successor whose write silently overwrites ours.
  return withCatalogLock(input.catalogPath, async () => {
    const loaded = await loadCatalog(input.catalogPath);

    const existingDigests = new Set(
      loaded.file.bindings.map((entry) => String((entry as { digest?: unknown }).digest)),
    );
    const appended = newBindings.filter((binding) => !existingDigests.has(binding.digest));

    const purposes: TrustPolicy["purposes"] = {};
    for (const [purpose, entry] of Object.entries(loaded.newest.value.purposes)) {
      purposes[purpose] = { ...entry, accepted: [...entry.accepted] };
    }
    const joined = completePolicyPurposes({
      roleAgents: newBindings.map(({ role, agent }) => ({ role, agent })),
    });
    for (const [purpose, entry] of Object.entries(joined)) {
      unionAccepted(purposes, purpose, entry.accepted, entry.requiredStrength);
    }
    for (const [purpose, entry] of Object.entries(input.additionalPurposes ?? {})) {
      unionAccepted(purposes, purpose, entry.accepted, entry.requiredStrength);
    }
    assertPurposesCoverBindings(purposes, newBindings);

    const successor = await sealSuccessor({
      authority: input.authority,
      newest: loaded.newest,
      purposes,
      refreshBy: input.refreshBy,
      ...(input.signerSet === undefined ? {} : { signerSet: input.signerSet }),
    });

    const anchors = loaded.file.anchors.some(({ digest }) => digest === input.newAnchor.digest)
      ? loaded.file.anchors
      : [...loaded.file.anchors, input.newAnchor];
    for (const binding of newBindings) {
      if (!anchors.some(({ digest }) => digest === binding.anchorDigest)) {
        throw new TrustAuthoringError(`binding ${binding.digest} references undeclared anchor ${binding.anchorDigest}`);
      }
    }

    const rewritten: CatalogFile = {
      ...loaded.file,
      policies: [...loaded.file.policies, { digest: successor.digest, envelope: b64(successor.envelopeBytes) }],
      anchors,
      bindings: [...loaded.file.bindings, ...appended.map(bindingEntry)],
    };
    await rewriteAtomically({
      path: input.catalogPath,
      contents: JSON.stringify(rewritten),
      expectedDigest: loaded.digest,
    });
    return {
      newestPolicyVersion: successor.version,
      policyGenesisDigest: loaded.file.policyGenesisDigest as `sha256:${string}`,
    };
  });
}

/**
 * Succession without membership change — the §5 refresh tool. `openNativeTrustCatalog` hard-refuses
 * an expired policy, so the successor obligation before `refreshBy` is real; this is also the
 * TUF-native authority-rotation path (pass the new `signerSet`, signed to both thresholds).
 */
export async function sealPolicySuccessor(input: {
  readonly catalogPath: string;
  readonly authority: CatalogAuthority;
  readonly refreshBy: string;
  readonly purposes?: TrustPolicy["purposes"];
  readonly signerSet?: SignerSet;
}): Promise<{ readonly newestPolicyVersion: number; readonly policyDigest: `sha256:${string}` }> {
  return withCatalogLock(input.catalogPath, async () => {
    const loaded = await loadCatalog(input.catalogPath);
    const successor = await sealSuccessor({
      authority: input.authority,
      newest: loaded.newest,
      purposes: input.purposes ?? loaded.newest.value.purposes,
      refreshBy: input.refreshBy,
      ...(input.signerSet === undefined ? {} : { signerSet: input.signerSet }),
    });
    const rewritten: CatalogFile = {
      ...loaded.file,
      policies: [...loaded.file.policies, { digest: successor.digest, envelope: b64(successor.envelopeBytes) }],
    };
    await rewriteAtomically({
      path: input.catalogPath,
      contents: JSON.stringify(rewritten),
      expectedDigest: loaded.digest,
    });
    return { newestPolicyVersion: successor.version, policyDigest: successor.digest };
  });
}


// ── rotation: revocation and rebind (spec §3.2, §3.2b, §6 laws 1 and 6) ────────────────────────

/** The domain of the `revocation-anchor/v1` preimage (spec §3.2b). */
export const REVOCATION_ANCHOR_PROTOCOL = "https://spec.jinn.network/trust/revocation-anchor/v1" as const;

const LOWERCASE_SHA256 = /^sha256:[0-9a-f]{64}$/u;
/** Law 6: `effectiveFrom` is millisecond-ISO UTC, the form `submitAnchor` returns. */
const MILLISECOND_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** Sorted ascending by UTF-16 code units, at least one, no duplicates, each a lowercase digest. */
function canonicalTargets(targets: readonly `sha256:${string}`[]): readonly `sha256:${string}`[] {
  if (targets.length === 0) throw new TrustAuthoringError("a revocation act names at least one target");
  for (const target of targets) {
    if (!LOWERCASE_SHA256.test(target)) {
      throw new TrustAuthoringError(`revocation target "${target}" is not a lowercase sha256 digest`);
    }
  }
  const sorted = [...targets].sort();
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1]) {
      throw new TrustAuthoringError(`revocation target ${sorted[index]!} is named more than once`);
    }
  }
  return sorted;
}

/**
 * The anchor digest of one revocation act (spec §3.2b, `revocation-anchor/v1`): the sha256 of
 * ECMA-262 `JSON.stringify` over `{protocol, targets, revokedBy}`, keys in that order, `targets`
 * sorted. Every term is in the catalog, so a reader can recompute it, and its domain keeps it from
 * ever equalling a binding's `ceremony-anchor/v1` digest. `effectiveFrom` is left out: the block
 * time is the authority, and the preimage commits to what is revoked and by whom.
 */
export function revocationAnchorDigest(input: {
  readonly targets: readonly `sha256:${string}`[];
  readonly revokedBy: string;
}): `sha256:${string}` {
  const targets = canonicalTargets(input.targets);
  if (!/^[\x00-\x7f]+$/u.test(input.revokedBy)) {
    throw new TrustAuthoringError(`revokedBy "${input.revokedBy}" is not ASCII (spec §3.2b)`);
  }
  const preimage = JSON.stringify({ protocol: REVOCATION_ANCHOR_PROTOCOL, targets, revokedBy: input.revokedBy });
  return recordDigest(new TextEncoder().encode(preimage));
}

/**
 * Key authority section 8, "An account's signature": the revocation signer for a binding's voucher
 * account. Its `keyId` is the account's `did:pkh`, spelled as `authorRoleBinding` spells the voucher,
 * and is the revocation's `revokedBy`. It signs the DSSE pre-authentication encoding with a 65-byte
 * EIP-191 `personal_sign` signature.
 *
 * It signs revocations and nothing else, the one record the text gives an account's signature, and
 * refuses before asking the account for anything else. It refuses a signature that is not 65 bytes
 * or does not recover to the voucher's address, because every reader would ignore such a
 * revocation while its author took the key for retired.
 */
export function voucherAccountSigner(voucher: CeremonySigner): {
  readonly keyId: DidPkh;
  readonly dsseSigner: DsseSigner;
} {
  const keyId = didPkh(NATIVE_ANCHOR_CHAIN_ID, voucher.address);
  const address = toChecksumAddress(voucher.address);
  return {
    keyId,
    dsseSigner: async ({ payloadType, preAuthEncoding }) => {
      if (payloadType !== TRUST_REVOCATION_MEDIA_TYPE) {
        throw new TrustAuthoringError(`voucher account ${keyId} signs only revocations, not ${payloadType}`);
      }
      const signature = await voucher.signMessage({ message: { raw: preAuthEncoding } });
      if (!/^0x[0-9a-fA-F]{130}$/u.test(signature)) {
        throw new TrustAuthoringError(`voucher account ${keyId} returned a signature that is not 65 bytes of hex`);
      }
      const bytes = new Uint8Array(Buffer.from(signature.slice(2), "hex"));
      let recovered: string | undefined;
      try {
        recovered = recoverEip191Address(preAuthEncoding, bytes);
      } catch {
        recovered = undefined;
      }
      if (recovered !== address) {
        throw new TrustAuthoringError(
          `voucher account ${keyId} returned a signature that does not recover to ${address}`
            + (recovered === undefined ? "" : ` (it recovers to ${recovered})`),
        );
      }
      return [{ keyid: keyId, signature: bytes }];
    },
  };
}

interface CatalogBinding {
  readonly digest: string;
  readonly binding: KeyBinding;
}

function catalogBindings(file: CatalogFile): readonly CatalogBinding[] {
  return file.bindings.map((entry) => {
    const digest = String(entry.digest);
    if (typeof entry.envelope !== "string") {
      throw new TrustAuthoringError(`trust catalog binding ${digest} carries no envelope`);
    }
    const bytes = new Uint8Array(Buffer.from(entry.envelope, "base64"));
    if (recordDigest(bytes) !== digest) {
      throw new TrustAuthoringError(`trust catalog binding ${digest} does not match its envelope`);
    }
    const report = validateKeyBinding(bytes);
    if (!report.conforms || report.value === undefined) {
      throw new TrustAuthoringError(`trust catalog binding ${digest} is not a conforming sealed KeyBinding`);
    }
    return { digest, binding: report.value };
  });
}

function catalogRevocations(file: CatalogFile): readonly Revocation[] {
  return file.revocations.map((entry) => {
    const report = validateRevocation(new Uint8Array(Buffer.from(entry.envelope, "base64")));
    if (!report.conforms || report.value === undefined) {
      throw new TrustAuthoringError(`trust catalog revocation ${entry.digest} is not a conforming sealed Revocation`);
    }
    return report.value;
  });
}

function accountVoucherDid(binding: KeyBinding): string | undefined {
  return binding.voucher.kind === "account" ? binding.voucher.did : undefined;
}

/**
 * Key authority section 8 rule 1, checked against the catalog before anything is signed or
 * anchored: every target is a binding the catalog carries, vouched by this account, which is not a
 * contract account, and not already revoked by it. No native role binding holds `bindings` scope
 * (spec §3.2a), so rule 1 is the only rule under which a native role binding can be revoked.
 */
function revocableTargets(
  file: CatalogFile,
  voucher: CeremonySigner,
  requested: readonly `sha256:${string}`[],
): { readonly revokedBy: DidPkh; readonly targets: readonly `sha256:${string}`[] } {
  const revokedBy = didPkh(NATIVE_ANCHOR_CHAIN_ID, voucher.address);
  const targets = canonicalTargets(requested);
  const bindings = catalogBindings(file);
  const revocations = catalogRevocations(file);
  for (const target of targets) {
    const found = bindings.find(({ digest }) => digest === target);
    if (found === undefined) throw new TrustAuthoringError(`trust catalog carries no binding ${target}`);
    const bound = found.binding.voucher;
    if (bound.kind !== "account" || bound.did !== revokedBy) {
      throw new TrustAuthoringError(
        `${revokedBy} is not the voucher of binding ${target} (vouched by ${JSON.stringify(bound)}); `
          + "only that binding's voucher account can revoke it (key authority section 8)",
      );
    }
    if (bound.contractAccount) {
      throw new TrustAuthoringError(
        `binding ${target} is vouched by a contract account, which cannot revoke (key authority section 8)`,
      );
    }
    if (revocations.some((revocation) => revocation.target === target && revocation.revokedBy === revokedBy)) {
      throw new TrustAuthoringError(`binding ${target} is already revoked by ${revokedBy}`);
    }
  }
  return { revokedBy, targets };
}

export interface RevocationPlan {
  readonly revokedBy: DidPkh;
  /** Sorted, as the anchor preimage orders them. */
  readonly targets: readonly `sha256:${string}`[];
  /** The `revocation-anchor/v1` digest the act's one fresh anchor carries. */
  readonly anchorDigest: `sha256:${string}`;
}

/**
 * The first half of a revocation act, before any gas is spent: shows the voucher can revoke every
 * target in the catalog and names the anchor digest to submit. Law 6 puts the anchor first, because
 * the revocation's effective time is its block time; `revokeBinding` then seals and writes.
 */
export async function planRevocation(input: {
  readonly catalogPath: string;
  readonly voucher: CeremonySigner;
  readonly targets: readonly `sha256:${string}`[];
}): Promise<RevocationPlan> {
  const loaded = await loadCatalog(input.catalogPath);
  const { revokedBy, targets } = revocableTargets(loaded.file, input.voucher, input.targets);
  return { revokedBy, targets, anchorDigest: revocationAnchorDigest({ targets, revokedBy }) };
}

/**
 * The revocation half of rotation (spec §3.2): seals one revocation per target, signed by the
 * target binding's voucher account through `voucherAccountSigner`, never by the catalog authority,
 * whose key holds no binding to any Agent. No native role binding holds `bindings` scope (spec
 * §3.2a), so the voucher account is the one signer whose revocation of one counts.
 */
export interface RevokeBindingInput {
  readonly catalogPath: string;
  /** The ceremony EOA `authorRoleBinding` named as each target binding's `did:pkh` voucher. */
  readonly voucher: CeremonySigner;
  /** The `sha256:` digests of the sealed bindings being revoked, all in one act. */
  readonly targets: readonly `sha256:${string}`[];
  /**
   * The act's anchor block time, VERBATIM as `submitAnchor` returned it. Law 6 puts `effectiveFrom`
   * at or before that time, in millisecond-ISO UTC; a later value would delay the revocation.
   */
  readonly effectiveTime: string;
  /** The act's one fresh anchor, whose digest is `planRevocation`'s `anchorDigest`. */
  readonly anchor: AnchorDeclaration;
}

export interface RevokedBindings {
  readonly revokedBy: DidPkh;
  readonly effectiveTime: string;
  readonly revocations: readonly { readonly target: `sha256:${string}`; readonly digest: `sha256:${string}` }[];
}

/**
 * Seals the act's revocations and appends them, with their anchor, to the catalog. Refuses before
 * signing when the voucher is not every target's voucher, when the anchor is not the act's
 * `revocation-anchor/v1` digest (law 6: one anchor, newly submitted for this act, never a binding's),
 * or when the effective time is not millisecond-ISO UTC; and writes nothing when the voucher's
 * signature does not recover to its address. Revocations need no policy successor: the trust policy
 * names Agent IRIs, which a revocation does not change.
 */
export async function revokeBinding(input: RevokeBindingInput): Promise<RevokedBindings> {
  if (!MILLISECOND_UTC.test(input.effectiveTime) || !isCalendarStrictRfc3339(input.effectiveTime)) {
    throw new TrustAuthoringError(
      `revocation effectiveTime "${input.effectiveTime}" is not a millisecond ISO UTC time (spec §6 law 6); `
        + "pass the revocation anchor's block time as submitAnchor returned it",
    );
  }
  return withCatalogLock(input.catalogPath, async () => {
    const loaded = await loadCatalog(input.catalogPath);
    const { revokedBy, targets } = revocableTargets(loaded.file, input.voucher, input.targets);
    const anchorDigest = revocationAnchorDigest({ targets, revokedBy });
    if (input.anchor.digest !== anchorDigest) {
      throw new TrustAuthoringError(
        `revocation anchor ${input.anchor.digest} is not ${anchorDigest}, the revocation-anchor/v1 digest of `
          + "these targets and this revoker (spec §3.2b, §6 law 6)",
      );
    }
    const account = voucherAccountSigner(input.voucher);
    const sealed: { target: `sha256:${string}`; digest: `sha256:${string}`; envelopeBytes: Uint8Array }[] = [];
    for (const target of targets) {
      // eslint-disable-next-line no-await-in-loop -- one signature per target, from one account.
      const record = await sealRevocation({
        protocol: TRUST_REVOCATION_FORMAT,
        target,
        revokedBy,
        anchors: [{ digest: anchorDigest }],
        effectiveFrom: input.effectiveTime,
      }, account.dsseSigner);
      sealed.push({ target, digest: record.recordDigest, envelopeBytes: record.envelopeBytes });
    }
    const anchors = loaded.file.anchors.some(({ digest }) => digest === anchorDigest)
      ? loaded.file.anchors
      : [...loaded.file.anchors, input.anchor];
    const rewritten: CatalogFile = {
      ...loaded.file,
      anchors,
      revocations: [
        ...loaded.file.revocations,
        ...sealed.map(({ digest, envelopeBytes }) => ({ digest, envelope: b64(envelopeBytes) })),
      ],
    };
    await rewriteAtomically({
      path: input.catalogPath,
      contents: JSON.stringify(rewritten),
      expectedDigest: loaded.digest,
    });
    return {
      revokedBy,
      effectiveTime: input.effectiveTime,
      revocations: sealed.map(({ target, digest }) => ({ target, digest })),
    };
  });
}

function sameScope(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * The rebind half of rotation (spec §3.2): appends replacement role bindings, authored by
 * `authorRoleBinding` for new keys, and their anchor. Run it BEFORE the revocation. A replacement
 * draws its authority from a binding of its Agent under the same voucher that stands at its
 * effective start (key authority section 7), and an Agent whose only binding is the one being
 * retired, as an admission Agent is, has no other: revoked first, the replacement has no chain.
 *
 * Refuses an anchor the catalog already declares (a rebind's anchor is newly submitted, law 1), a
 * key the Agent already holds (rotating to the same key is no rotation), a role the Agent does not
 * hold under the replacement's voucher (a binding under another voucher needs consent, which this
 * flow does not author), and an Agent with no binding under that voucher left unrevoked. Seals no
 * policy successor: the trust policy names Agent IRIs, and a rebind keeps them.
 */
export async function rebindRoles(input: {
  readonly catalogPath: string;
  readonly replacements: readonly SealedBindingEntry[];
  readonly anchor: AnchorDeclaration;
}): Promise<{
  readonly bindings: readonly {
    readonly role: NativeRoleIdentityRole;
    readonly agent: string;
    readonly keyId: string;
    readonly digest: `sha256:${string}`;
  }[];
}> {
  const replacements = dedupeByDigest(input.replacements);
  if (replacements.length === 0) throw new TrustAuthoringError("a rebind requires at least one replacement binding");
  for (const replacement of replacements) {
    if (replacement.anchorDigest !== input.anchor.digest) {
      throw new TrustAuthoringError(
        `replacement binding ${replacement.digest} references anchor ${replacement.anchorDigest}, `
          + `not the rebind's ${input.anchor.digest}`,
      );
    }
  }
  return withCatalogLock(input.catalogPath, async () => {
    const loaded = await loadCatalog(input.catalogPath);
    if (loaded.file.anchors.some(({ digest }) => digest === input.anchor.digest)) {
      throw new TrustAuthoringError(
        `trust catalog already declares anchor ${input.anchor.digest}; a rebind's anchor is newly submitted `
          + "for that act (spec §3.2b, §6 law 1)",
      );
    }
    const existing = catalogBindings(loaded.file);
    // A revocation reaches the record it names and that record's siblings: the same key, Agent and
    // voucher (key authority section 8). Whether its signer had authority is not asked here, so this
    // guard refuses more, never less, than a verifier would.
    const revoked = new Set<string>();
    for (const revocation of catalogRevocations(loaded.file)) {
      const target = existing.find(({ digest }) => digest === revocation.target);
      if (target === undefined) continue;
      revoked.add(JSON.stringify([target.binding.agent, accountVoucherDid(target.binding), target.binding.key.didKey]));
    }
    for (const replacement of replacements) {
      const report = validateKeyBinding(replacement.envelopeBytes);
      if (!report.conforms || report.value === undefined) {
        throw new TrustAuthoringError(`replacement binding ${replacement.digest} is not a conforming sealed KeyBinding`);
      }
      const binding = report.value;
      const voucherDid = accountVoucherDid(binding);
      if (existing.some((entry) => entry.binding.agent === binding.agent && entry.binding.key.didKey === binding.key.didKey)) {
        throw new TrustAuthoringError(
          `trust catalog already binds key ${binding.key.didKey} to ${binding.agent}; a rotation binds a new key`,
        );
      }
      const underVoucher = existing.filter((entry) =>
        entry.binding.agent === binding.agent
        && voucherDid !== undefined
        && accountVoucherDid(entry.binding) === voucherDid);
      if (!underVoucher.some((entry) => sameScope(entry.binding.scope, binding.scope))) {
        throw new TrustAuthoringError(
          `replacement ${replacement.role} binding for ${binding.agent} replaces no binding the catalog holds under `
            + `voucher ${voucherDid ?? "(not an account)"}; a binding under another voucher needs consent, which a `
            + "rebind does not author",
        );
      }
      const standing = underVoucher.some((entry) =>
        entry.binding.relationship === "controls"
        && !revoked.has(JSON.stringify([entry.binding.agent, voucherDid, entry.binding.key.didKey])));
      if (!standing) {
        throw new TrustAuthoringError(
          `every binding of ${binding.agent} under ${voucherDid ?? "(not an account)"} is already revoked, so the `
            + `replacement ${replacement.role} binding would have no authority (key authority section 7); `
            + "rebind before revoking",
        );
      }
    }
    // No successor is sealed, so the newest policy must already accept every replacement's Agent.
    assertPurposesCoverBindings(loaded.newest.value.purposes, replacements);

    const rewritten: CatalogFile = {
      ...loaded.file,
      anchors: [...loaded.file.anchors, input.anchor],
      bindings: [...loaded.file.bindings, ...replacements.map(bindingEntry)],
    };
    await rewriteAtomically({
      path: input.catalogPath,
      contents: JSON.stringify(rewritten),
      expectedDigest: loaded.digest,
    });
    return {
      bindings: replacements.map(({ role, agent, keyId, digest }) => ({ role, agent, keyId, digest })),
    };
  });
}
