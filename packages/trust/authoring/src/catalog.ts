// SPDX-License-Identifier: Apache-2.0

/**
 * Trust-catalog authoring (spec §3.2, §5, §6 law 3): genesis, late join, and policy succession for
 * the `jinn.native-trust-catalog/2` file `openNativeTrustCatalog` reads.
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
  recordDigest,
  sealTrustPolicy,
  validateTrustPolicy,
  type DsseSigner,
  type Sha256Digest,
  type SignerSet,
  type TrustPolicy,
} from "@jinn-network/trust-core";

import type { AnchorDeclaration } from "./anchor.js";
import type { SealedBindingEntry } from "./binding.js";
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

/**
 * DESIGNED, IMPLEMENTATION DEFERRED (spec §3.3, §9 follow-up issue). The catalog schema and the
 * binding resolver already carry anchored, effective-time revocations, so rotation needs no schema
 * change when it ships — only this body, plus the rebind flow (revoke + `authorRoleBinding` for the
 * replacement key + a new anchor). The surface is fixed here so that stays true.
 */
export interface RevokeBindingInput {
  readonly catalogPath: string;
  readonly authority: CatalogAuthority;
  /** The `sha256:` digest of the sealed binding being revoked. */
  readonly target: `sha256:${string}`;
  readonly effectiveTime: string;
  readonly anchor: AnchorDeclaration;
}

export function revokeBinding(_input: RevokeBindingInput): Promise<never> {
  return Promise.reject(new TrustAuthoringError(
    "revokeBinding is designed but not implemented (spec §3.3); rotation ships as the §9 follow-up issue",
  ));
}
