/**
 * `jinn ceremony init | join | rotate | show`: the operator-facing production path that CREATES the
 * trust artifacts the native fleet daemon verifies (spec/2026-08-07-native-identity-ceremony.md §4),
 * and retires and replaces role keys (`rotate`, §3.2).
 *
 * The one-swap estate shipped a complete trust VERIFICATION layer and, until this verb, no
 * production way to produce what it verifies: `jinn native-vertical identity` mints a store, and a
 * store alone is a set of keys no catalog accepts. `ceremony` is the missing half — custody, IRIs,
 * an on-chain anchor, sealed bindings, an authority-signed catalog, and the config write-back that
 * points the daemon at all of it.
 *
 * ── What this module owns and what it delegates ──────────────────────────────────────────────
 * Authoring itself is `@jinn-network/trust-authoring`'s job and is called directly (it is
 * filesystem + crypto only, so the tests exercise the real thing in a tmpdir rather than a mock of
 * it). Only the CHAIN-touching steps are injected as deps, matching `native-requester.ts`: reading
 * the operator's earning state, the `Safe.isOwner` preflight, and the anchor submit/finality wait.
 *
 * ── §6's sequencing law is ENFORCED here, not documented here ────────────────────────────────
 * The order below is the law, and each step's refusal is the enforcement:
 *   1. anchor FIRST, because `validFrom` must be the anchor's block time;
 *   2. `validFrom` = that block time VERBATIM (the string, not the instant — the resolver compares
 *      these lexicographically, so `…00Z` vs `…00.000Z` changes outcomes). `authorRoleBinding`
 *      re-checks this, so a drift here is a refusal, not a subtly broken catalog;
 *   3. complete purposes via `completePolicyPurposes` + `authorCatalog`'s law-3 assertion;
 *   4. wait for `finalized` before declaring success — the catalog opener accepts only anchors
 *      below the finalized head, so an early success hands the operator a catalog that cannot boot;
 *   5. a rewritten catalog means a daemon RESTART (`assertFresh` refuses a changed catalog under a
 *      running daemon), stated in the output of every verb that rewrites.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

import {
  anchorDeclaration,
  appendOperator,
  assertNoRetiredKeyBound,
  authorCatalog,
  authorRoleBinding,
  completePolicyPurposes,
  isSettlementRole,
  openCatalogAuthority,
  openRoleSigners,
  performEoaCeremony,
  planRevocation,
  rebindRoles,
  retiredKeys,
  revocationsToCarry,
  revokeBinding,
  roleBindingTerms,
  scopeForRole,
  type AnchorLocator,
  type CarriedRevocations,
  type CatalogAuthoritySigner,
  type FinalizedAnchorObservation,
  type NativeRoleIdentityRole,
  type RevocationPlan,
  type RoleSigner,
  type SealedBindingEntry,
} from '@jinn-network/trust-authoring';
import {
  didPkh,
  recordDigest,
  validateKeyBinding,
  validateRevocation,
  validateTrustPolicy,
  type KeyBinding,
  type Revocation,
  type TrustPolicy,
} from '@jinn-network/trust-core';

import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { emitResult } from '../output.js';
import {
  planNativeIdentityWriteBack,
  writeNativeIdentityConfig,
  type NativeIdentityStorePaths,
} from '../../config/write-native-identity.js';
import { writeConfigFileAtomic } from '../../config/atomic-write.js';
import { ROLE_SETS, orderedRolesForSet, type RoleSetName } from './native-requester.js';
import { resolveDefaultStateDir } from '../../state-dir.js';
import {
  legacyKeystorePasswordPath,
  primaryKeystorePasswordPath,
  readKeystorePasswordFile,
} from '../../earning/password-file.js';

const OPTIONS = {
  ...COMMON_FLAGS,
  dir: { type: 'string' as const },
  'role-sets': { type: 'string' as const },
  'authority-store': { type: 'string' as const },
  'rpc-url': { type: 'string' as const },
  'anchor-target': { type: 'string' as const },
  'service-index': { type: 'string' as const },
  catalog: { type: 'string' as const },
  'previous-catalog': { type: 'string' as const },
  genesis: { type: 'string' as const },
  store: { type: 'string' as const },
  'finality-timeout-ms': { type: 'string' as const },
  'resubmit-anchor': { type: 'boolean' as const, default: false },
  'retiring-store': { type: 'string' as const, multiple: true as const },
  'dry-run': { type: 'boolean' as const, default: false },
  execute: { type: 'boolean' as const, default: false },
};

type Parsed = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;

/** §5: genesis + ~6 months. `openNativeTrustCatalog` hard-refuses an expired policy. */
const REFRESH_BY_MONTHS = 6;
/** §6 law 4: the Base Sepolia `finalized` tag trails head by roughly 10-20 minutes. */
const DEFAULT_FINALITY_TIMEOUT_MS = 45 * 60_000;
const FINALITY_POLL_MS = 20_000;

const EXAMPLE_CLI = 'jinn ceremony init --dir ~/.jinn-client --role-sets requester,admission,solver,evaluator --authority-store <path> --execute';

// ── deps ───────────────────────────────────────────────────────────────────────────────────────

/** The on-chain custody an operator already has from the OLAS earning bootstrap. */
export interface CeremonyChainCustody {
  readonly serviceIndex: number;
  readonly agentEoa: `0x${string}`;
  /** The service Safe — the settlement authority declared as the §2.3b third ceremony resource. */
  readonly safeAddress: `0x${string}`;
}

/**
 * The operator's decrypted agent-EOA custody for the duration of one ceremony: anchor submission,
 * finality waiting, and the EIP-191 signature every key-binding ceremony needs.
 *
 * Signing lives here rather than beside the role signers because the ceremony signer is the CHAIN
 * key — the same EOA that sends the anchor transaction and that `Safe.isOwner` names. Keeping both
 * on one session means the key is decrypted once, and `close()` bounds its lifetime.
 */
export interface CeremonyAnchorSession {
  /** EIP-191 over the serialized SIWE ceremony bytes, by the agent EOA. */
  signMessage(input: { readonly message: { readonly raw: Uint8Array } }): Promise<`0x${string}`>;
  submit(digest: `sha256:${string}`): Promise<AnchorLocator>;
  waitForFinalized(input: {
    readonly digest: `sha256:${string}`;
    readonly locator: AnchorLocator;
    readonly timeoutMs: number;
    readonly pollMs: number;
    readonly onProgress?: (elapsedMs: number) => void;
  }): Promise<FinalizedAnchorObservation>;
  close?(): Promise<void>;
}

export interface CeremonyCommandDeps {
  /** Reads `earning_state.json`. No password, no key material — this runs under `--dry-run`. */
  readChainCustody(input: {
    readonly dir: string;
    readonly serviceIndex?: number;
  }): Promise<CeremonyChainCustody>;
  /**
   * `Safe.isOwner(agentEoa)`. The §2 amendment makes this the load-bearing link between the role
   * key and the settlement address, so it is checked FIRST — before any store is minted and before
   * any gas is spent — rather than discovered at the first settlement verification.
   */
  verifySafeOwnership(input: {
    readonly safeAddress: `0x${string}`;
    readonly agentEoa: `0x${string}`;
    readonly rpcUrl?: string;
  }): Promise<boolean>;
  /** Opens the operator's keystore and the RPC clients. Password-gated; `--execute` only. */
  openAnchorSession(input: {
    readonly dir: string;
    readonly serviceIndex: number;
    readonly password: string;
    readonly anchorTarget: `0x${string}`;
    readonly rpcUrl?: string;
  }): Promise<CeremonyAnchorSession>;
  /** `show`'s live anchor read. Absent → `show` reports anchor status as `unknown`. */
  readAnchorStatus?(input: {
    readonly digest: `sha256:${string}`;
    readonly locator: unknown;
    readonly rpcUrl?: string;
  }): Promise<{ readonly finalized: boolean; readonly anchorTime?: string } | null>;
}

// ── shared helpers ─────────────────────────────────────────────────────────────────────────────

/**
 * Marks a refusal that has ALREADY emitted its envelope, so the stack can unwind without emitting
 * a second one.
 *
 * `ctx.exit` is `process.exit` in production (which never returns) but a recording stub under test,
 * where execution would otherwise continue straight past the refusal into the very work the
 * refusal exists to prevent — minting stores after a failed Safe-ownership check, for instance.
 * Throwing makes the `never` return type honest on both paths, which matters most in the nested
 * helpers (`parseRoleSets`, `resolveAuthorityStore`, `buildProvisionPlan`) whose callers cannot
 * return on their behalf.
 */
class CeremonyRefusal extends Error {
  override readonly name = 'CeremonyRefusal';
}

function invalid(ctx: CommandContext, message: string, hint?: string): never {
  emitEnvelope({
    code: 'invalid_invocation',
    message,
    ...(hint === undefined ? {} : { hint }),
    exampleCli: EXAMPLE_CLI,
  }, { writer: ctx.writer, exit: ctx.exit });
  throw new CeremonyRefusal(message);
}

function defaultOperatorDir(env: NodeJS.ProcessEnv): string {
  return resolveDefaultStateDir({ home: env.HOME ?? homedir(), env });
}

/**
 * Whether this invocation may take side effects.
 *
 * `--dry-run` is the flag an operator reaches for when they want to be CERTAIN nothing happens, so
 * it forces the plan and refuses loudly rather than quietly losing to `--execute`. (It previously
 * parsed and was never read, which made `--dry-run --execute` spend gas.)
 */
function resolveExecute(ctx: CommandContext, parsed: Parsed): boolean {
  const dryRun = parsed.values['dry-run'] === true;
  const execute = parsed.values.execute === true;
  if (dryRun && execute) {
    invalid(
      ctx,
      '--dry-run and --execute are mutually exclusive',
      '--dry-run forces the read-only plan. Drop one of the two; without --execute the ceremony is already plan-only.',
    );
  }
  return execute;
}

/**
 * Progress lines during the long chain waits, in the mode the operator asked for.
 *
 * `emitResult` is for one terminal value; these are a stream, so they are written directly — but
 * they must still honour `--human`, because an operator watching a 45-minute finality wait on a
 * live run should not be reading raw JSON.
 */
function progressWriter(
  ctx: CommandContext,
  parsed: Parsed,
): (payload: Record<string, unknown>, human: string) => void {
  const human = Boolean(parsed.values.human);
  return (payload, line) => {
    ctx.writer.write(human ? `${line}\n` : `${JSON.stringify(payload)}\n`);
  };
}

function resolveDir(ctx: CommandContext, parsed: Parsed): string {
  const dir = parsed.values.dir;
  if (dir === undefined || dir.length === 0) return defaultOperatorDir(ctx.env);
  if (dir.startsWith('~/')) return join(ctx.env.HOME ?? homedir(), dir.slice(2));
  if (!isAbsolute(dir)) invalid(ctx, `--dir must be an absolute path, got "${dir}"`);
  return dir;
}

function parseRoleSets(
  ctx: CommandContext,
  raw: string | undefined,
  options: { readonly requireRequester: boolean } = { requireRequester: true },
): readonly RoleSetName[] {
  if (raw === undefined || raw.trim().length === 0) {
    invalid(ctx, 'ceremony requires --role-sets (comma-separated: requester,admission,solver,evaluator)');
  }
  const names = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  const seen = new Set<string>();
  for (const name of names) {
    if (!Object.hasOwn(ROLE_SETS, name)) {
      invalid(ctx, `--role-sets got unknown family "${name}"; accepted: requester, admission, solver, evaluator`);
    }
    // Symmetric with `orderedNativeRoles`, which now refuses a duplicated role rather than
    // deduping it: `--role-sets solver,solver` is an operator mistake, not a shorthand.
    if (seen.has(name)) invalid(ctx, `--role-sets names "${name}" more than once`);
    seen.add(name);
  }
  if (names.length === 0) invalid(ctx, 'ceremony requires at least one --role-sets family');
  // §4.4: the fleet runtime ALWAYS opens requester custody (the projector's requester-association
  // resolver needs `requester-submission`), even for an operator who is solver-only in intent. A
  // ceremony that skipped it would mint a catalog whose owner's own daemon refuses to boot.
  if (options.requireRequester && !names.includes('requester')) {
    invalid(
      ctx,
      '--role-sets must include `requester`: the native fleet runtime opens requester custody on every boot, '
        + 'including for a solver-only operator.',
      'Add `requester` to --role-sets.',
    );
  }
  return names as readonly RoleSetName[];
}

function storePathFor(dir: string, family: RoleSetName): string {
  return join(dir, 'identity', `${family}.enc.json`);
}

function receiptPath(dir: string): string {
  return join(dir, 'ceremony', 'receipt.json');
}

interface CeremonyReceipt {
  readonly schemaVersion: 1;
  readonly agentIri: string;
  readonly admissionAgent?: string;
  readonly catalogPath?: string;
  readonly policyGenesisDigest?: string;
  readonly anchorDigest?: string;
  readonly anchorTransactionHash?: string;
  /**
   * The whole locator, not just its hash: it is what lets a re-run REUSE the anchor instead of
   * paying for a second one. `anchorDeclaration` needs every field, so recording only the hash
   * would make the receipt a record of the anchor rather than a way to resume onto it.
   */
  readonly anchorLocator?: AnchorLocator;
  readonly validFrom?: string;
  readonly completedAt?: string;
  /**
   * Every anchor and catalog the fields above named before a later run replaced them, oldest first.
   * Each init or join that submits a new anchor rewrites the receipt, and its anchor covers only the
   * families that run bound, so without these the receipt would lose the anchor under which an
   * earlier run bound a family a rotation then retired, and the catalog that revokes it. Optional: a
   * receipt without it reads as one that names only the fields above.
   */
  readonly earlierAnchors?: readonly EarlierAnchor[];
}

/** An anchor an earlier init or join from this directory bound keys under, and the catalog it bound them in. */
interface EarlierAnchor {
  readonly anchorDigest: string;
  readonly catalogPath?: string;
}

/** The receipt's earlier anchors, each checked field by field: the receipt is an operator-writable file. */
function earlierAnchorsOf(receipt: CeremonyReceipt | undefined): readonly EarlierAnchor[] {
  const entries: unknown = receipt?.earlierAnchors;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: unknown) => {
    if (entry === null || typeof entry !== 'object') return [];
    const { anchorDigest, catalogPath } = entry as Record<string, unknown>;
    return typeof anchorDigest === 'string' && (catalogPath === undefined || typeof catalogPath === 'string')
      ? [{ anchorDigest, ...(catalogPath === undefined ? {} : { catalogPath }) }]
      : [];
  });
}

function readReceipt(dir: string): CeremonyReceipt | undefined {
  const path = receiptPath(dir);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as CeremonyReceipt;
    return typeof parsed.agentIri === 'string' && parsed.agentIri.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes the receipt whole. The anchor and catalog the receipt on disk names, and its earlier ones,
 * are carried forward into `earlierAnchors` whenever `receipt` names another pair; naming, for the
 * same anchor, a catalog where none was recorded is not another pair.
 */
function writeReceipt(dir: string, receipt: CeremonyReceipt): void {
  const path = receiptPath(dir);
  const existing = readReceipt(dir);
  const carried = [
    ...earlierAnchorsOf(existing),
    ...(existing?.anchorDigest === undefined
      ? []
      : [{ anchorDigest: existing.anchorDigest, ...(existing.catalogPath === undefined ? {} : { catalogPath: existing.catalogPath }) }]),
  ].filter(({ anchorDigest, catalogPath }) => anchorDigest !== receipt.anchorDigest
    || (catalogPath !== undefined && catalogPath !== receipt.catalogPath));
  const earlierAnchors = carried.filter((entry, index) => carried.findIndex((other) =>
    other.anchorDigest === entry.anchorDigest && other.catalogPath === entry.catalogPath) === index);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    `${JSON.stringify({ ...receipt, earlierAnchors: earlierAnchors.length === 0 ? undefined : earlierAnchors }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/**
 * Extends the receipt in place.
 *
 * The receipt is written in stages (anchor → catalog → config) precisely so that a crash between
 * two of them leaves a record of what already happened. A merge keeps the earlier stages' fields —
 * a replace would erase the anchor the later stage is standing on.
 */
function extendReceipt(dir: string, patch: Partial<CeremonyReceipt>): void {
  const existing = readReceipt(dir);
  if (existing === undefined) return;
  writeReceipt(dir, { ...existing, ...patch });
}

/**
 * The anchor a previous, interrupted run already paid for — or `undefined`.
 *
 * The ~10-45 minute finality wait is the only realistic crash window in the whole ceremony, and
 * until this receipt existed a crash there orphaned the on-chain anchor: the re-run minted a fresh
 * `urn:uuid:` Agent IRI and sent a SECOND anchor transaction. Reuse is safe because the digest is a
 * pure function of (agent, admission agent, Safe, role→keyId) and every one of those re-resolves
 * identically on a re-run — the stores are re-OPENED, never re-minted. So a digest match is proof
 * that the recorded locator anchors exactly the key set this run is about to bind; a mismatch (an
 * added role family, a rotated store) correctly falls through to a fresh submit.
 */
function reusableAnchor(
  receipt: CeremonyReceipt | undefined,
  anchorDigest: `sha256:${string}`,
): AnchorLocator | undefined {
  if (receipt?.anchorDigest !== anchorDigest) return undefined;
  return recordedLocator(receipt.anchorLocator);
}

/**
 * A locator read back from a receipt, re-validated rather than trusted: the receipt is an
 * operator-writable file, and a malformed locator would otherwise reach `anchorDeclaration` as a
 * sealed catalog anchor.
 */
function recordedLocator(locator: AnchorLocator | undefined): AnchorLocator | undefined {
  if (locator === null || typeof locator !== 'object') return undefined;
  const ok = locator.profile === 'https://spec.jinn.network/trust/anchor-locators/base-sepolia-calldata-v1'
    && locator.chainId === 84532
    && /^0x[0-9a-fA-F]{64}$/u.test(String(locator.transactionHash))
    && /^0x[0-9a-fA-F]{40}$/u.test(String(locator.contractAddress))
    && Number.isInteger(locator.inputByteOffset) && locator.inputByteOffset >= 0
    // The block time is the ONE field the ceremony cannot recompute: §6 law 2 makes it every
    // binding's `validFrom` verbatim, so a resume without it would author a different catalog.
    && typeof locator.anchorTime === 'string' && locator.anchorTime.length > 0;
  return ok ? locator : undefined;
}

/**
 * `--previous-catalog`: the catalog a re-author replaces, moved aside so `init` can seal the new one
 * at the same path. Read before anything is minted or anchored, so a catalog whose revocations cannot
 * be carried refuses before gas is spent.
 */
async function resolvePreviousCatalog(
  ctx: CommandContext,
  parsed: Parsed,
): Promise<{ readonly path: string; readonly carried: CarriedRevocations } | undefined> {
  const path = previousCatalogPath(ctx, parsed);
  if (path === undefined) return undefined;
  try {
    return { path, carried: await revocationsToCarry(path) };
  } catch (cause) {
    return invalid(
      ctx,
      `the previous catalog at ${path} cannot be carried forward: ${cause instanceof Error ? cause.message : String(cause)}`,
      'Pass the catalog this re-author replaces, unchanged since it was moved aside.',
    );
  }
}

/** `--previous-catalog`, resolved to an absolute path, or `undefined` when it is not given. */
function previousCatalogPath(ctx: CommandContext, parsed: Parsed): string | undefined {
  const raw = parsed.values['previous-catalog'];
  if (raw === undefined) return undefined;
  const path = raw.startsWith('~/') ? join(ctx.env.HOME ?? homedir(), raw.slice(2)) : raw;
  if (!isAbsolute(path)) invalid(ctx, `--previous-catalog must be an absolute path, got "${raw}"`);
  return path;
}

/**
 * Why this `init` replaces a catalog, or `undefined`. A catalog sealed in its place without
 * `--previous-catalog` would drop every revocation the replaced one holds, and each key they retired
 * would bind again. The run receipt shows this operator sealed a catalog at this path; the rotation
 * receipt shows it revoked keys in one.
 */
function replacedCatalogEvidence(dir: string, catalogPath: string): string | undefined {
  const receipt = readReceipt(dir);
  if (receipt?.catalogPath === catalogPath && typeof receipt.policyGenesisDigest === 'string') {
    return `${receiptPath(dir)} records that this operator sealed a catalog at ${catalogPath} `
      + `(genesis ${receipt.policyGenesisDigest})`;
  }
  if (existsSync(rotationReceiptPath(dir))) {
    return `${rotationReceiptPath(dir)} records a key rotation, whose revocations the replaced catalog holds`;
  }
  return undefined;
}

/**
 * The stores `jinn ceremony rotate` minted for `family` in `<dir>/identity`. Every rotation mints its
 * replacement store there, `<family>.rotated-<stamp>.enc.json`, beside the store init and join open,
 * before it sends any anchor, and points identityStores at the newest one. So one is there for
 * every rotation of the family in `<dir>`, including one before the latest, whatever the config or the
 * rotation receipt says. Listing the directory opens no store.
 */
function rotatedStoresOf(dir: string, family: RoleSetName): readonly string[] {
  const identityDir = join(dir, 'identity');
  let names: readonly string[];
  try {
    names = readdirSync(identityDir);
  } catch (cause) {
    // No identity directory, so no store of any kind, rotated or not.
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw cause;
  }
  return names
    .filter((name) => name.startsWith(`${family}.rotated-`) && name.endsWith('.enc.json'))
    .sort()
    .map((name) => join(identityDir, name));
}

/**
 * The families of `families` whose keys in `<dir>/identity` a catalog shows revoked, found with no
 * store opened, and the catalogs read. The run receipt names every anchor under which init or join
 * bound those keys, the latest and the earlier ones it carries forward, with the catalog each bound
 * them in; every binding under one of those anchors is a binding of one of them. A rotation revokes
 * every binding of every key of the family it retires, so a revoked one, for a role whose scope no
 * other family's role shares, names that family, wherever its rotated store now sits and whatever it
 * is called. A scope several families share (discovery, settlement) names none. Each catalog is read
 * for its own bindings and revocations: those the run receipt names, and the `catalogs` the verb
 * reads besides, where they exist.
 */
function familiesRevokedIn(ctx: CommandContext, input: {
  readonly dir: string;
  readonly families: readonly RoleSetName[];
  readonly catalogs: readonly (string | undefined)[];
}): {
  readonly receipt: string;
  readonly revoked: ReadonlyMap<RoleSetName, string>;
  readonly read: readonly string[];
} {
  const runReceipt = readReceipt(input.dir);
  const recorded: readonly EarlierAnchor[] = [
    ...(runReceipt?.anchorDigest === undefined
      ? []
      : [{ anchorDigest: runReceipt.anchorDigest, ...(runReceipt.catalogPath === undefined ? {} : { catalogPath: runReceipt.catalogPath }) }]),
    ...earlierAnchorsOf(runReceipt),
  ];
  if (recorded.length === 0) return { receipt: receiptPath(input.dir), revoked: new Map(), read: [] };
  const anchors = new Set(recorded.map(({ anchorDigest }) => anchorDigest));
  const scopeOf = (scope: readonly string[]): string => [...scope].sort().join(' ');
  const familiesByScope = new Map<string, Set<RoleSetName>>();
  for (const family of Object.keys(ROLE_SETS) as RoleSetName[]) {
    for (const role of ROLE_SETS[family]) {
      const scope = scopeOf(scopeForRole(role));
      familiesByScope.set(scope, new Set([...familiesByScope.get(scope) ?? [], family]));
    }
  }
  const read = [...new Set([...recorded.map(({ catalogPath }) => catalogPath), ...input.catalogs])]
    .filter((path): path is string => path !== undefined && existsSync(path));
  const revoked = new Map<RoleSetName, string>();
  for (const path of read) {
    const { bindings, revocations } = catalogRecords(loadCatalogFile(ctx, path));
    const targets = new Set(revocations.map(({ target }) => target));
    for (const { digest, binding } of bindings) {
      if (!targets.has(digest) || !binding.anchors.some((reference) => anchors.has(reference.digest))) continue;
      const owners = [...familiesByScope.get(scopeOf(binding.scope)) ?? []];
      const family = owners.length === 1 ? owners[0]! : undefined;
      if (family !== undefined && input.families.includes(family) && !revoked.has(family)) revoked.set(family, path);
    }
  }
  return { receipt: receiptPath(input.dir), revoked, read };
}

/**
 * Refuses when `init` or `join` would bind a role family a rotation retired or is retiring. Both open
 * only `<dir>/identity/<family>.enc.json`, never the store `identityStores` names, and after
 * `jinn ceremony rotate` that store holds the keys the rotation retired.
 *
 * Any one record is enough. A store rotate minted for the family in `<dir>/identity`
 * (`rotatedStoresOf`) records every rotation of it, the earlier ones included, whatever file
 * `--config` names. A store of that name the config names, wherever it now sits, is one too. The
 * rotation receipt names every family of the latest rotation, finished or not, and covers the moment
 * between writing it and minting the new store. A receipt that exists but cannot be read refuses
 * rather than reading as no rotation. A catalog that revokes the keys the run receipt records as bound
 * from `<dir>/identity`, under any anchor it records (`familiesRevokedIn`), is one too, once a
 * rotation's revocation has landed, so a rotated store moved or renamed out of `<dir>/identity` is
 * still seen.
 *
 * With none of them, a config whose `identityStores` names another store for a family was not
 * written by a rotation, and binding would point `identityStores` away from that store. That is
 * refused too, saying so (`store-elsewhere`), rather than as a rotation.
 */
function refuseRotatedFamilies(ctx: CommandContext, input: {
  readonly verb: 'init' | 'join';
  readonly dir: string;
  readonly configPath: string;
  readonly families: readonly RoleSetName[];
  /** Catalogs the verb reads besides the one the run receipt names: join's target, init's previous. */
  readonly catalogs: readonly (string | undefined)[];
  readonly sideEffects: boolean;
  readonly hint: string;
}): void {
  const identityDir = join(input.dir, 'identity');
  const receiptPath = rotationReceiptPath(input.dir);
  const receiptExists = existsSync(receiptPath);
  const receipt = readRotationReceiptOrRefuse(ctx, input);
  const configured = readConfigObject(input.configPath).identityStores;
  const namedFor = (family: RoleSetName): string | undefined => {
    const named = configured !== null && typeof configured === 'object'
      ? (configured as Record<string, unknown>)[family]
      : undefined;
    return typeof named === 'string' ? named : undefined;
  };
  // A store rotate minted that the config still names is a rotation too, wherever it now sits: an
  // operator may move the live store out of <dir>/identity and repoint the config at it.
  const minted = new Map(input.families.map((family) => {
    const stores = rotatedStoresOf(input.dir, family);
    const named = namedFor(family);
    const namedRotated = named !== undefined && !stores.includes(named)
      && basename(named).startsWith(`${family}.rotated-`) && named.endsWith('.enc.json');
    return [family, namedRotated ? [...stores, named] : stores] as const;
  }));
  const byStores = input.families.filter((family) => minted.get(family)!.length > 0);
  const byReceipt = input.families.filter((family) => receipt?.roleSets.includes(family) === true);
  const revocations = familiesRevokedIn(ctx, input);
  const families = input.families.filter((family) =>
    byStores.includes(family) || byReceipt.includes(family) || revocations.revoked.has(family));
  if (families.length > 0) {
    const reasons = [
      ...(byStores.length === 0 ? [] : [`rotate minted ${byStores.flatMap((family) => minted.get(family)!).join(', ')}`]),
      ...(byReceipt.length === 0 ? [] : [`${receiptPath} records a rotation of ${byReceipt.join(', ')}`]),
      ...revocations.read.flatMap((catalog) => {
        const revoked = input.families.filter((family) => revocations.revoked.get(family) === catalog);
        return revoked.length === 0
          ? []
          : [`${catalog} revokes the ${revoked.join(', ')} keys init or join bound there under an anchor ${revocations.receipt} records`];
      }),
    ];
    const message = `${input.verb} would bind the keys in ${identityDir}/<family>.enc.json for `
      + `${families.join(', ')}: ${reasons.join('; ')}. After \`jinn ceremony rotate\` that store holds the keys the `
      + 'rotation retired or is retiring.'
      + (receiptExists
        ? ''
        : ` ${receiptPath} does not exist, so no receipt says which keys were retired, and ${input.verb} refuses rather than guess.`);
    emitEnvelope({
      code: 'invalid_invocation',
      message,
      hint: input.hint,
      exampleCli: EXAMPLE_CLI,
      details: { feature: 'ceremony', state: 'rotated-family', sideEffects: input.sideEffects, families },
    }, { writer: ctx.writer, exit: ctx.exit });
    throw new CeremonyRefusal(message);
  }

  const elsewhere = input.families.flatMap((family) => {
    const named = namedFor(family);
    return named !== undefined && named !== storePathFor(input.dir, family) ? [{ family, named }] : [];
  });
  if (elsewhere.length === 0) return;
  const named = elsewhere.map(({ family }) => family);
  const message = `${input.verb} binds the keys in ${identityDir}/<family>.enc.json and writes those paths into `
    + `identityStores, but ${input.configPath} names ${elsewhere.map((entry) => `${entry.named} for ${entry.family}`).join(', ')}. `
    + `Nothing in ${input.dir} shows a rotation of ${named.join(', ')}: ${identityDir} holds no `
    + `${named.map((family) => `${family}.rotated-<stamp>.enc.json`).join(' or ')}, ${receiptPath} `
    + `${receiptExists ? `records no rotation of ${named.join(', ')}` : 'does not exist'}, and `
    + (revocations.read.length === 0
      ? `${revocations.receipt} names no anchor and catalog that could show their keys revoked`
      : `${revocations.read.join(' and ')} revoke${revocations.read.length === 1 ? 's' : ''} none of the keys init or join `
        + `bound under the anchors ${revocations.receipt} records`)
    + `. So ${input.verb} would replace a store it did not provision, and refuses.`;
  emitEnvelope({
    code: 'invalid_invocation',
    message,
    hint: `${input.verb} binds no store but ${identityDir}/<family>.enc.json. If a store ${input.configPath} names `
      + 'is one `jinn ceremony rotate` minted, since moved or renamed, that family was rotated: '
      + `${identityDir}/<family>.enc.json holds the keys the rotation retired, and ${input.verb} cannot bind them. `
      + `Otherwise, if the keys in ${identityDir}/<family>.enc.json are the ones to bind for ${named.join(', ')}, `
      + `name those paths in identityStores in ${input.configPath} and re-run.`,
    exampleCli: EXAMPLE_CLI,
    details: { feature: 'ceremony', state: 'store-elsewhere', sideEffects: input.sideEffects, families: named },
  }, { writer: ctx.writer, exit: ctx.exit });
  throw new CeremonyRefusal(message);
}

function readConfigObject(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown;
    return (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * The Agent IRIs, resolved rather than re-minted.
 *
 * A re-run must reuse the operator's IRIs: they are minted once and never rotated (trust design
 * §5), and a fresh IRI on a second run would author bindings for an identity no existing catalog
 * accepts. Precedence is config first (it is what the daemon actually reads), then the receipt,
 * then a fresh mint.
 */
function resolveAgentIris(input: {
  readonly dir: string;
  readonly configPath: string;
  readonly needsAdmission: boolean;
}): { readonly agentIri: string; readonly admissionAgent?: string; readonly minted: boolean } {
  const config = readConfigObject(input.configPath);
  const receipt = readReceipt(input.dir);
  const agentIri = (typeof config.agentIri === 'string' && config.agentIri.length > 0)
    ? config.agentIri
    : receipt?.agentIri ?? `urn:uuid:${randomUUID()}`;
  const minted = agentIri !== config.agentIri && agentIri !== receipt?.agentIri;
  if (!input.needsAdmission) return { agentIri, minted };
  const existingAdmission = (typeof config.admissionAgent === 'string' && config.admissionAgent.length > 0)
    ? config.admissionAgent
    : receipt?.admissionAgent;
  // DISTINCT from the operator's own Agent IRI (§4.1 step 3): admission is a separate signing
  // authority from the requester it admits for, and the runtime refuses the two being equal.
  const admissionAgent = existingAdmission ?? `urn:uuid:${randomUUID()}`;
  return { agentIri, admissionAgent, minted: minted || admissionAgent !== existingAdmission };
}

function refreshByFrom(anchorTime: string): string {
  const at = new Date(anchorTime);
  const refresh = new Date(at.getTime());
  refresh.setUTCMonth(refresh.getUTCMonth() + REFRESH_BY_MONTHS);
  refresh.setUTCHours(0, 0, 0, 0);
  return refresh.toISOString();
}

/**
 * The anchor's payload: a commitment to exactly the key set this ceremony session is about to bind.
 *
 * Nothing in the catalog schema constrains WHAT the anchor digest is a digest of — the reader only
 * checks that the transaction's calldata at `inputByteOffset` equals the declared digest. That
 * makes an opaque constant (what the e2e fixture uses) schema-legal but evidentially empty. Hashing
 * the (agent, safe, role→keyId) tuple instead makes the on-chain transaction say something true and
 * checkable: THESE keys, for THIS agent, with THIS settlement Safe, existed at that block time.
 *
 * It is computed from values known BEFORE the anchor is mined, which it has to be — §6 law 1 puts
 * the anchor first precisely because `validFrom` is not knowable until afterwards.
 */
export function ceremonyAnchorDigest(input: {
  readonly agentIri: string;
  readonly admissionAgent?: string;
  readonly safeAddress: `0x${string}`;
  readonly keys: readonly { readonly role: string; readonly keyId: string }[];
}): `sha256:${string}` {
  const canonical = JSON.stringify({
    protocol: 'https://spec.jinn.network/trust/ceremony-anchor/v1',
    agent: input.agentIri,
    ...(input.admissionAgent === undefined ? {} : { admissionAgent: input.admissionAgent }),
    settlementSafe: input.safeAddress.toLowerCase(),
    keys: [...input.keys]
      .map(({ role, keyId }) => ({ role, keyId }))
      .sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0)),
  });
  return recordDigest(new TextEncoder().encode(canonical));
}

// ── password identity guard (§4.1, §4.4) ───────────────────────────────────────────────────────

export interface CeremonyPasswordResolution {
  readonly password: string;
  readonly source: 'env' | 'keystore-file';
  readonly warnings: readonly string[];
}

/**
 * The ceremony MUST run with the password the DAEMON will later resolve, or it mints custody the
 * daemon cannot decrypt — a failure that surfaces only at the next boot, after the anchor gas is
 * spent and the catalog is sealed.
 *
 * The daemon resolves `JINN_PASSWORD` first, then `<dir>/earning/keystore-password` (primary),
 * then the host-wide default-state file (legacy). JINN_PASSWORD is not required when the primary
 * file exists under `--dir`.
 */
export function resolveCeremonyPassword(input: {
  readonly dir: string;
  readonly env: NodeJS.ProcessEnv;
}): CeremonyPasswordResolution | { readonly refusal: string; readonly hint: string } {
  const primaryPath = primaryKeystorePasswordPath(join(input.dir, 'earning'));
  const legacyPath = legacyKeystorePasswordPath({ env: input.env });
  const fromFile = readKeystorePasswordFile(join(input.dir, 'earning'), input.env);
  const filePassword = fromFile?.password;
  const filePath = fromFile?.path;

  const envPassword = input.env.JINN_PASSWORD;
  if (typeof envPassword === 'string' && envPassword.length > 0) {
    const warnings: string[] = [];
    if (filePassword !== undefined && filePassword !== envPassword && filePath !== undefined) {
      warnings.push(
        `JINN_PASSWORD differs from the password stored at ${filePath}. The daemon prefers the env var, `
          + 'so any start without it will resolve the file value and fail to open this custody.',
      );
    }
    return { password: envPassword, source: 'env', warnings };
  }

  if (filePassword !== undefined && filePath !== undefined) {
    return { password: filePassword, source: 'keystore-file', warnings: [] };
  }
  return {
    refusal: `JINN_PASSWORD is required for an operator homed at ${input.dir} when neither ${primaryPath} nor ${legacyPath} exists.`,
    hint: 'The daemon auto-generates and persists a password next to the keystore on its first start, which would not match custody '
      + 'minted now. Either export JINN_PASSWORD, write <dir>/earning/keystore-password, or start the daemon once so the file exists, then re-run.',
  };
}

// ── catalog reading (show) ─────────────────────────────────────────────────────────────────────

interface CatalogFileShape {
  readonly policyGenesisDigest: string;
  readonly policies: readonly { readonly digest: string; readonly envelope: string }[];
  readonly anchors: readonly { readonly digest: `sha256:${string}`; readonly locator: unknown }[];
  readonly bindings: readonly Record<string, unknown>[];
  readonly revocations: readonly unknown[];
}

function loadCatalogFile(ctx: CommandContext, path: string): CatalogFileShape {
  if (!existsSync(path)) invalid(ctx, `no trust catalog at ${path}`);
  let parsed: CatalogFileShape;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as CatalogFileShape;
  } catch (cause) {
    return invalid(ctx, `trust catalog at ${path} is not JSON: ${String(cause)}`);
  }
  if (!Array.isArray(parsed.policies) || typeof parsed.policyGenesisDigest !== 'string') {
    invalid(ctx, `trust catalog at ${path} is not a jinn.native-trust-catalog/2 file`);
  }
  return parsed;
}

/**
 * The tail of the hash-linked chain. Structural, not cryptographic — `verifyPolicyChain` is the
 * verifier, and a second implementation here would be a second thing to drift.
 */
function newestPolicy(file: CatalogFileShape): { readonly digest: string; readonly value: TrustPolicy } | undefined {
  const parsed = file.policies.flatMap((entry) => {
    const bytes = new Uint8Array(Buffer.from(entry.envelope, 'base64'));
    const report = validateTrustPolicy(bytes);
    return report.conforms && report.value !== undefined
      ? [{ digest: recordDigest(bytes) as string, value: report.value }]
      : [];
  });
  return parsed.reduce<{ readonly digest: string; readonly value: TrustPolicy } | undefined>(
    (newest, candidate) => (newest === undefined || candidate.value.version > newest.value.version ? candidate : newest),
    undefined,
  );
}

// ── init / join shared flow ────────────────────────────────────────────────────────────────────

interface ProvisionPlan {
  readonly dir: string;
  readonly configPath: string;
  readonly roleSets: readonly RoleSetName[];
  readonly authorityStore: string;
  readonly catalogPath: string;
  readonly identityStores: NativeIdentityStorePaths;
  readonly custody: CeremonyChainCustody;
  readonly agentIri: string;
  readonly admissionAgent?: string;
  readonly anchorTarget: `0x${string}`;
  readonly finalityTimeoutMs: number;
}

function resolveAuthorityStore(ctx: CommandContext, parsed: Parsed, dir: string): string {
  const raw = parsed.values['authority-store'];
  if (raw === undefined || raw.length === 0) {
    invalid(
      ctx,
      'ceremony requires --authority-store <path>',
      'The catalog-authority key is a DEDICATED keypair held by the deploy coordinator, never an operator role key '
        + '(§5): role keys rotate on operator events, and policy-update capability must survive any rotation.',
    );
  }
  if (raw.startsWith('~/')) return join(ctx.env.HOME ?? homedir(), raw.slice(2));
  if (!isAbsolute(raw)) invalid(ctx, `--authority-store must be an absolute path, got "${raw}"`);
  // Refuse the shape §5 forbids before any key material is touched: an authority store that lives
  // inside an operator's own identity directory is one `cp -r` away from being operator custody.
  if (raw.startsWith(join(dir, 'identity'))) {
    invalid(
      ctx,
      `--authority-store must not live under ${join(dir, 'identity')} (operator role custody)`,
      'Keep the catalog authority in the coordinator\'s own directory, e.g. ~/.jinn-ceremony/authority.enc.json.',
    );
  }
  return raw;
}

async function buildProvisionPlan(input: {
  readonly ctx: CommandContext;
  readonly parsed: Parsed;
  readonly deps: CeremonyCommandDeps;
}): Promise<ProvisionPlan> {
  const { ctx, parsed, deps } = input;
  const dir = resolveDir(ctx, parsed);
  const configPath = parsed.values.config ?? join(dir, 'config.json');
  const roleSets = parseRoleSets(ctx, parsed.values['role-sets']);
  const authorityStore = resolveAuthorityStore(ctx, parsed, dir);
  const catalogPath = parsed.values.catalog ?? join(dir, 'trust.json');

  const serviceIndexRaw = parsed.values['service-index'];
  const serviceIndex = serviceIndexRaw === undefined ? undefined : Number(serviceIndexRaw);
  if (serviceIndex !== undefined && (!Number.isInteger(serviceIndex) || serviceIndex < 1)) {
    invalid(ctx, `--service-index must be a positive integer, got "${serviceIndexRaw}"`);
  }

  let custody: CeremonyChainCustody;
  try {
    custody = await deps.readChainCustody({
      dir,
      ...(serviceIndex === undefined ? {} : { serviceIndex }),
    });
  } catch (cause) {
    return invalid(
      ctx,
      `the operator's earning state at ${dir} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      'The ceremony binds role keys to the agent EOA and service Safe the OLAS earning bootstrap already created. '
        + 'Run `jinn bootstrap` to completion first.',
    );
  }

  const iris = resolveAgentIris({ dir, configPath, needsAdmission: roleSets.includes('admission') });

  const identityStores: NativeIdentityStorePaths = Object.fromEntries(
    roleSets.map((family) => [family, storePathFor(dir, family)]),
  );

  const anchorTargetRaw = parsed.values['anchor-target'];
  if (anchorTargetRaw !== undefined && !/^0x[0-9a-fA-F]{40}$/u.test(anchorTargetRaw)) {
    invalid(ctx, `--anchor-target must be a 20-byte hex address, got "${anchorTargetRaw}"`);
  }

  const timeoutRaw = parsed.values['finality-timeout-ms'];
  const finalityTimeoutMs = timeoutRaw === undefined ? DEFAULT_FINALITY_TIMEOUT_MS : Number(timeoutRaw);
  if (!Number.isFinite(finalityTimeoutMs) || finalityTimeoutMs <= 0) {
    invalid(ctx, `--finality-timeout-ms must be a positive number, got "${timeoutRaw}"`);
  }

  return {
    dir,
    configPath,
    roleSets,
    authorityStore,
    catalogPath,
    identityStores,
    custody,
    agentIri: iris.agentIri,
    ...(iris.admissionAgent === undefined ? {} : { admissionAgent: iris.admissionAgent }),
    // The anchor is a calldata commitment, not a call: the reader checks only that the transaction's
    // input at `inputByteOffset` carries the digest and that `to` matches the declared address, so
    // no contract needs to exist at the target. Defaulting to the operator's OWN EOA keeps the
    // ceremony free of any external address to trust, misconfigure, or have to keep alive.
    anchorTarget: (anchorTargetRaw as `0x${string}` | undefined) ?? custody.agentEoa,
    finalityTimeoutMs,
  };
}

/** The §2 preflight: the Safe→EOA ownership link, checked before a single store is minted. */
async function assertSafeOwnership(
  ctx: CommandContext,
  deps: CeremonyCommandDeps,
  plan: Pick<ProvisionPlan, 'custody'>,
  rpcUrl: string | undefined,
): Promise<void> {
  let owns: boolean;
  try {
    owns = await deps.verifySafeOwnership({
      safeAddress: plan.custody.safeAddress,
      agentEoa: plan.custody.agentEoa,
      ...(rpcUrl === undefined ? {} : { rpcUrl }),
    });
  } catch (cause) {
    return invalid(
      ctx,
      `Safe ownership could not be read for ${plan.custody.safeAddress}: ${cause instanceof Error ? cause.message : String(cause)}`,
      'The ceremony refuses fail-closed rather than binding a settlement authority it could not verify.',
    );
  }
  if (!owns) {
    invalid(
      ctx,
      `Safe ${plan.custody.safeAddress} does not report ${plan.custody.agentEoa} as an owner.`,
      'The §2 settlement-authority chain of custody runs role key → agent EOA (ceremony) → Safe (isOwner). '
        + 'Without the last link, every settlement this operator seals would refuse verification.',
    );
  }
}

interface MintedCustody {
  readonly signers: ReadonlyMap<NativeRoleIdentityRole, RoleSigner>;
  readonly authority: CatalogAuthoritySigner;
  readonly created: readonly string[];
}

async function mintCustody(input: {
  readonly plan: ProvisionPlan;
  readonly password: string;
}): Promise<MintedCustody> {
  const signers = new Map<NativeRoleIdentityRole, RoleSigner>();
  const created: string[] = [];
  for (const family of input.plan.roleSets) {
    const storePath = storePathFor(input.plan.dir, family);
    const existed = existsSync(storePath);
    // Never clobbers: an existing store is OPENED. `openRoleSigners` goes through the same
    // exclusive-hard-link create path production boot uses, so a re-run is idempotent rather than
    // a fresh mint that would strand every binding the previous run authored.
    // eslint-disable-next-line no-await-in-loop -- bounded (≤4 families), and each is a file write.
    const familySigners = await openRoleSigners({
      storePath,
      password: input.password,
      ownedRoles: orderedRolesForSet(family),
      create: true,
    });
    for (const [role, signer] of familySigners) signers.set(role, signer);
    if (!existed) created.push(storePath);
  }
  const authorityExisted = existsSync(input.plan.authorityStore);
  const authority = await openCatalogAuthority({
    storePath: input.plan.authorityStore,
    password: input.password,
    create: true,
  });
  if (!authorityExisted) created.push(input.plan.authorityStore);
  return { signers, authority, created };
}

/** The parts of a plan that name who a binding is for and which Safe settles for it. */
type BindingPlan = Pick<ProvisionPlan, 'agentIri' | 'admissionAgent' | 'custody'>;

/** Which Agent IRI owns a given role: admission is its own authority, everything else is the operator. */
function agentForRole(plan: BindingPlan, role: NativeRoleIdentityRole): string {
  return role === 'admission' ? plan.admissionAgent ?? plan.agentIri : plan.agentIri;
}

async function authorBindings(input: {
  readonly plan: BindingPlan;
  readonly signers: ReadonlyMap<NativeRoleIdentityRole, RoleSigner>;
  readonly ceremonySigner: { readonly address: `0x${string}`; signMessage(m: { readonly message: { readonly raw: Uint8Array } }): Promise<`0x${string}`> };
  readonly validFrom: string;
  readonly anchorDigest: `sha256:${string}`;
}): Promise<readonly SealedBindingEntry[]> {
  const bindings: SealedBindingEntry[] = [];
  for (const [role, signer] of input.signers) {
    const agent = agentForRole(input.plan, role);
    // eslint-disable-next-line no-await-in-loop -- bounded, and each seal is a signing operation.
    const ceremony = await performEoaCeremony({
      signer: input.ceremonySigner,
      agent,
      didKey: signer.keyId,
      // §6 law 2: issuedAt = validFrom = the anchor's block time, VERBATIM. `authorRoleBinding`
      // re-checks the equality, so a drift refuses here rather than producing a catalog whose
      // consent-chain checks fail at boot.
      issuedAt: input.validFrom,
      // Ceremony currency §2: the last resource commits to the terms `authorRoleBinding` seals,
      // and `authorRoleBinding` refuses a ceremony that commits to any other terms.
      terms: roleBindingTerms(role, input.validFrom),
      // §2.3b: settlement-scoped roles declare the service Safe as a third resource, inside the
      // EIP-191-signed bytes.
      ...(isSettlementRole(role) ? { settlementSafe: input.plan.custody.safeAddress } : {}),
    });
    // eslint-disable-next-line no-await-in-loop -- see above.
    bindings.push(await authorRoleBinding({
      role,
      signer,
      agent,
      ceremonyAccount: input.ceremonySigner.address,
      ceremony,
      validFrom: input.validFrom,
      anchorDigest: input.anchorDigest,
    }));
  }
  return bindings;
}

function humanPlan(plan: ProvisionPlan, verb: 'init' | 'join', extra: readonly string[]): string {
  const lines = [
    `jinn ceremony ${verb} — PLAN (no side effects)`,
    '',
    `operator dir        ${plan.dir}`,
    `config              ${plan.configPath}`,
    `role families       ${plan.roleSets.join(', ')}`,
    `agent IRI           ${plan.agentIri}`,
    ...(plan.admissionAgent === undefined ? [] : [`admission agent     ${plan.admissionAgent}`]),
    `agent EOA           ${plan.custody.agentEoa}`,
    `service Safe        ${plan.custody.safeAddress}`,
    `authority store     ${plan.authorityStore}`,
    `catalog             ${plan.catalogPath}`,
    `anchor target       ${plan.anchorTarget}`,
    '',
    'identity stores',
    ...plan.roleSets.map((family) => `  ${family.padEnd(10)} ${storePathFor(plan.dir, family)}`),
    '',
    ...extra,
  ];
  return lines.join('\n');
}

/**
 * The terminal `--execute` result, through the same `--human` switch every other verb honours.
 *
 * It used to be a raw `JSON.stringify`, so the one output an operator most wants to read on a live
 * run — the genesis digest they have to hand to the next operator — arrived as an unwrapped line of
 * JSON no matter what they asked for.
 */
function emitCompletion(ctx: CommandContext, parsed: Parsed, value: Record<string, unknown>): void {
  emitResult(
    value,
    (raw) => {
      const v = raw as {
        kind: string; dir: string; agentIri: string; admissionAgent?: string; catalogPath: string;
        policyGenesisDigest: string; anchorTransactionHash: string; anchorReused: boolean;
        validFrom: string; storesCreated: string[]; bindings: { role: string; keyId: string }[];
        carriedRevocations?: string[]; warnings: string[]; nextSteps: string[];
      };
      return [
        `jinn ceremony ${v.kind === 'ceremony_init_complete' ? 'init' : 'join'} — COMPLETE`,
        '',
        `operator dir        ${v.dir}`,
        `agent IRI           ${v.agentIri}`,
        ...(v.admissionAgent === undefined ? [] : [`admission agent     ${v.admissionAgent}`]),
        `catalog             ${v.catalogPath}`,
        `genesis digest      ${v.policyGenesisDigest}`,
        `anchor tx           ${v.anchorTransactionHash}${v.anchorReused ? ' (reused from a previous run)' : ''}`,
        `validFrom           ${v.validFrom}`,
        ...(v.carriedRevocations === undefined || v.carriedRevocations.length === 0
          ? []
          : [`revocations carried ${v.carriedRevocations.length}`]),
        '',
        'bindings',
        ...v.bindings.map((binding) => `  ${binding.role.padEnd(24)} ${binding.keyId}`),
        ...(v.storesCreated.length === 0 ? [] : ['', 'stores created', ...v.storesCreated.map((path) => `  ${path}`)]),
        ...(v.warnings.length === 0 ? [] : ['', ...v.warnings.map((warning) => `WARNING: ${warning}`)]),
        '',
        'next',
        ...v.nextSteps.map((step) => `  - ${step}`),
      ].join('\n');
    },
    {
      json: Boolean(parsed.values.json),
      human: Boolean(parsed.values.human),
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env.NO_COLOR),
    },
  );
}

// ── init ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The refusal for the one state whose obvious recovery is wrong.
 *
 * After the catalog is sealed but before the config write-back lands, `init` sees a catalog that
 * exists and used to point the operator at `ceremony join` — which would append a SECOND set of
 * bindings for an operator already in the catalog. Nothing is left to re-run: the remaining work is
 * five config keys, and they are all already known, so they are handed over verbatim.
 */
function refuseConfigWriteBackPending(input: {
  readonly ctx: CommandContext;
  readonly verb: 'init' | 'join';
  readonly plan: ProvisionPlan;
  readonly policyGenesisDigest: string;
}): void {
  const values = {
    agentIri: input.plan.agentIri,
    ...(input.plan.admissionAgent === undefined ? {} : { admissionAgent: input.plan.admissionAgent }),
    identityStores: input.plan.identityStores,
    trustRootsPath: input.plan.catalogPath,
    trustPolicyGenesisDigest: input.policyGenesisDigest,
  };
  emitEnvelope({
    code: 'invalid_invocation',
    message: `this operator's ceremony already anchored and sealed ${input.plan.catalogPath} `
      + `(genesis ${input.policyGenesisDigest}); re-running ${input.verb} would `
      + `${input.verb === 'init' ? 'overwrite the genesis' : 'append a second set of bindings for the same operator'}.`,
    hint: `Nothing on chain is left to do. Only the config write-back is missing: run \`jinn ceremony show --dir `
      + `${input.plan.dir} --catalog ${input.plan.catalogPath}\` to confirm, then write these keys onto `
      + `${input.plan.configPath} by hand — ${Object.keys(values).join(', ')} (values in details.configValues). `
      + `Delete ${receiptPath(input.plan.dir)} only if you intend a genuinely new ceremony.`,
    exampleCli: EXAMPLE_CLI,
    details: {
      feature: 'ceremony',
      state: 'config-write-back-pending',
      sideEffects: false,
      configPath: input.plan.configPath,
      configValues: values,
    },
  }, { writer: input.ctx.writer, exit: input.ctx.exit });
}

async function runInit(ctx: CommandContext, parsed: Parsed, deps: CeremonyCommandDeps): Promise<void> {
  const execute = resolveExecute(ctx, parsed);
  const progress = progressWriter(ctx, parsed);
  const plan = await buildProvisionPlan({ ctx, parsed, deps });
  const rpcUrl = parsed.values['rpc-url'];
  await assertSafeOwnership(ctx, deps, plan, rpcUrl);

  // After `jinn ceremony rotate`, the store init opens holds the keys that rotation retired. Refused
  // before the plan, so the plan never lists such a store, and before any store is opened or anchor
  // sent, whatever --previous-catalog names: a copy older than the rotation holds none of its
  // revocations, so nothing later would catch it.
  refuseRotatedFamilies(ctx, {
    verb: 'init',
    dir: plan.dir,
    configPath: plan.configPath,
    families: plan.roleSets,
    catalogs: [previousCatalogPath(ctx, parsed)],
    sideEffects: false,
    hint: 'A rotated family cannot be re-authored by init.',
  });

  const password = resolveCeremonyPassword({ dir: plan.dir, env: ctx.env });
  if ('refusal' in password) {
    return emitEnvelope({
      code: 'invalid_invocation',
      message: password.refusal,
      hint: password.hint,
      exampleCli: EXAMPLE_CLI,
      details: { feature: 'ceremony', state: 'password-identity-unresolvable', sideEffects: false },
    }, { writer: ctx.writer, exit: ctx.exit });
  }

  const previous = await resolvePreviousCatalog(ctx, parsed);

  const writeBackPlan = planNativeIdentityWriteBack({
    configPath: plan.configPath,
    values: {
      agentIri: plan.agentIri,
      ...(plan.admissionAgent === undefined ? {} : { admissionAgent: plan.admissionAgent }),
      identityStores: plan.identityStores,
      trustRootsPath: plan.catalogPath,
      // The plan cannot know the real digest before the genesis is sealed; the placeholder exists
      // only so the write-back plan can report WHICH keys change, never to be written.
      trustPolicyGenesisDigest: `sha256:${'0'.repeat(64)}`,
    },
  });

  if (!execute) {
    emitResult(
      {
        schemaVersion: 1,
        kind: 'ceremony_init_plan',
        executeAuthorized: false,
        sideEffects: false,
        dir: plan.dir,
        configPath: plan.configPath,
        roleSets: plan.roleSets,
        agentIri: plan.agentIri,
        ...(plan.admissionAgent === undefined ? {} : { admissionAgent: plan.admissionAgent }),
        agentEoa: plan.custody.agentEoa,
        safeAddress: plan.custody.safeAddress,
        safeOwnershipVerified: true,
        authorityStore: plan.authorityStore,
        catalogPath: plan.catalogPath,
        anchorTarget: plan.anchorTarget,
        identityStores: plan.identityStores,
        ...(previous === undefined
          ? {}
          : { previousCatalogPath: previous.path, revocationsCarried: previous.carried.revocations.length }),
        passwordSource: password.source,
        warnings: password.warnings,
        configWriteBack: writeBackPlan,
        restartRequired: true,
      },
      (value) => humanPlan(plan, 'init', [
        `password source     ${(value as { passwordSource: string }).passwordSource}`,
        ...(previous === undefined
          ? []
          : [`previous catalog    ${previous.path} (${previous.carried.revocations.length} revocations carried)`]),
        `config keys         ${writeBackPlan.written.join(', ')}`,
        ...(writeBackPlan.outstanding.length === 0
          ? []
          : ['', `still operator-authored: ${writeBackPlan.outstanding.join(', ')}`]),
        ...(password.warnings.length === 0 ? [] : ['', ...password.warnings.map((w) => `WARNING: ${w}`)]),
        '',
        'Re-run with --execute to mint custody, submit the anchor, wait for finality, and author the catalog.',
      ]),
      {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env.NO_COLOR),
      },
    );
    return;
  }

  if (existsSync(plan.catalogPath)) {
    // Two different states wear the same symptom. If THIS operator's receipt says it sealed this
    // catalog, the crash was between the seal and the config write and `join` is the wrong advice.
    const prior = readReceipt(plan.dir);
    if (prior?.catalogPath === plan.catalogPath && typeof prior.policyGenesisDigest === 'string') {
      return refuseConfigWriteBackPending({
        ctx, verb: 'init', plan, policyGenesisDigest: prior.policyGenesisDigest,
      });
    }
    return emitEnvelope({
      code: 'invalid_invocation',
      message: `a trust catalog already exists at ${plan.catalogPath}; genesis never overwrites`,
      hint: 'Use `jinn ceremony join` to add an operator to an existing catalog, or point --catalog elsewhere.',
      exampleCli: EXAMPLE_CLI,
      details: { feature: 'ceremony', state: 'catalog-exists', sideEffects: false },
    }, { writer: ctx.writer, exit: ctx.exit });
  }
  const replaced = previous === undefined ? replacedCatalogEvidence(plan.dir, plan.catalogPath) : undefined;
  if (replaced !== undefined) {
    return emitEnvelope({
      code: 'invalid_invocation',
      message: `this init would replace a catalog: ${replaced}. Sealed without it, the new catalog would drop every `
        + 'revocation the replaced one holds, and each key they retired would bind again.',
      hint: 'Pass the replaced catalog as --previous-catalog <path>, the file as it was when moved aside, and init '
        + 'carries its revocations into the new one.',
      exampleCli: EXAMPLE_CLI,
      details: { feature: 'ceremony', state: 'previous-catalog-required', sideEffects: false },
    }, { writer: ctx.writer, exit: ctx.exit });
  }

  const { signers, authority, created } = await mintCustody({ plan, password: password.password });
  if (previous !== undefined) {
    // Before any anchor: a carried revocation retired one of these keys, so the new catalog could
    // only bind it again beside the revoked record.
    try {
      assertNoRetiredKeyBound(
        previous.carried,
        [...signers.values()].map(({ role, keyId }) => ({ agent: agentForRole(plan, role), keyId })),
      );
    } catch (cause) {
      return emitEnvelope({
        code: 'invalid_invocation',
        message: cause instanceof Error ? cause.message : String(cause),
        hint: `init binds the keys in ${join(plan.dir, 'identity')}/<family>.enc.json, and after \`jinn ceremony rotate\` `
          + 'those stores hold the keys it retired, not the ones identityStores names. A rotated family cannot be '
          + 're-authored by init.',
        exampleCli: EXAMPLE_CLI,
        details: { feature: 'ceremony', state: 'retired-key-bound', sideEffects: created.length > 0 },
      }, { writer: ctx.writer, exit: ctx.exit });
    }
  }

  // §6 law 1 — the anchor goes first, and its block time is the only correct `validFrom`.
  const anchorDigest = ceremonyAnchorDigest({
    agentIri: plan.agentIri,
    ...(plan.admissionAgent === undefined ? {} : { admissionAgent: plan.admissionAgent }),
    safeAddress: plan.custody.safeAddress,
    keys: [...signers.values()].map(({ role, keyId }) => ({ role, keyId })),
  });
  const reusedAnchor = reusableAnchor(readReceipt(plan.dir), anchorDigest);
  const session = await deps.openAnchorSession({
    dir: plan.dir,
    serviceIndex: plan.custody.serviceIndex,
    password: password.password,
    anchorTarget: plan.anchorTarget,
    ...(rpcUrl === undefined ? {} : { rpcUrl }),
  });
  try {
    const locator = reusedAnchor ?? await session.submit(anchorDigest);
    if (reusedAnchor === undefined) {
      // §4.1 step 3, made TRUE: the receipt is written the instant the anchor exists, not at the
      // end. Everything after this point is a crash window minutes long, and a crash inside it used
      // to orphan the anchor — the re-run minted a fresh Agent IRI and sent a second transaction.
      writeReceipt(plan.dir, {
        schemaVersion: 1,
        agentIri: plan.agentIri,
        ...(plan.admissionAgent === undefined ? {} : { admissionAgent: plan.admissionAgent }),
        anchorDigest,
        anchorTransactionHash: locator.transactionHash,
        anchorLocator: locator,
        validFrom: locator.anchorTime,
      });
    }
    progress({
      schemaVersion: 1,
      kind: reusedAnchor === undefined ? 'ceremony_anchor_submitted' : 'ceremony_anchor_reused',
      anchorDigest,
      transactionHash: locator.transactionHash,
      anchorTime: locator.anchorTime,
      note: 'waiting for the finalized tag (Base Sepolia trails head by roughly 10-20 minutes)',
    }, reusedAnchor === undefined
      ? `anchor submitted    ${locator.transactionHash} at ${locator.anchorTime}\n`
        + '  waiting for the finalized tag (Base Sepolia trails head by roughly 10-20 minutes)'
      : `anchor reused       ${locator.transactionHash} at ${locator.anchorTime} (from a previous run's receipt)\n`
        + '  waiting for the finalized tag');

    // §6 law 4 — declaring success before finality hands the operator a catalog that refuses to boot.
    await session.waitForFinalized({
      digest: anchorDigest,
      locator,
      timeoutMs: plan.finalityTimeoutMs,
      pollMs: FINALITY_POLL_MS,
      onProgress: (elapsedMs) => {
        progress({
          schemaVersion: 1,
          kind: 'ceremony_finality_wait',
          anchorDigest,
          elapsedMs,
        }, `  still waiting for finality — ${Math.round(elapsedMs / 1000)}s elapsed`);
      },
    });

    const validFrom = locator.anchorTime;
    const bindings = await authorBindings({
      plan,
      signers,
      ceremonySigner: { address: plan.custody.agentEoa, signMessage: (m) => session.signMessage(m) },
      validFrom,
      anchorDigest,
    });

    const { policyGenesisDigest, carriedRevocations } = await authorCatalog({
      path: plan.catalogPath,
      authority,
      // §6 law 3 completeness: every native:<role>, BOTH admission spellings, and
      // evaluator-eligibility. `authorCatalog` now asserts the last three independently.
      purposes: completePolicyPurposes({
        roleAgents: bindings.map(({ role, agent }) => ({ role, agent })),
      }),
      refreshBy: refreshByFrom(validFrom),
      bindings: [...bindings],
      anchors: [anchorDeclaration(anchorDigest, locator)],
      ...(previous === undefined ? {} : { previousCatalogPath: previous.path }),
    });

    // Stage 2: the catalog is sealed. Recorded BEFORE the config write so that a crash between the
    // two lands in a state `init` can recognise and give the right recovery for.
    extendReceipt(plan.dir, { catalogPath: plan.catalogPath, policyGenesisDigest });

    const writeResult = writeNativeIdentityConfig({
      configPath: plan.configPath,
      values: {
        agentIri: plan.agentIri,
        ...(plan.admissionAgent === undefined ? {} : { admissionAgent: plan.admissionAgent }),
        identityStores: plan.identityStores,
        trustRootsPath: plan.catalogPath,
        trustPolicyGenesisDigest: policyGenesisDigest,
      },
    });

    extendReceipt(plan.dir, { completedAt: new Date().toISOString() });

    const nextSteps = [
      `Distribute ${plan.catalogPath} to every operator's trustRootsPath and restart their daemons `
        + '(assertFresh refuses a changed catalog under a running daemon).',
      ...(writeResult.outstanding.length === 0
        ? []
        : [`Author the remaining native deploy-config by hand: ${writeResult.outstanding.join(', ')}.`]),
      'Set compositionMode: "native" in the deploy PR — the ceremony deliberately does not flip it.',
    ];
    emitCompletion(ctx, parsed, {
      schemaVersion: 1,
      kind: 'ceremony_init_complete',
      executeAuthorized: true,
      sideEffects: true,
      dir: plan.dir,
      agentIri: plan.agentIri,
      ...(plan.admissionAgent === undefined ? {} : { admissionAgent: plan.admissionAgent }),
      catalogPath: plan.catalogPath,
      policyGenesisDigest,
      refreshBy: refreshByFrom(validFrom),
      anchorDigest,
      anchorTransactionHash: locator.transactionHash,
      anchorReused: reusedAnchor !== undefined,
      validFrom,
      carriedRevocations,
      storesCreated: created,
      bindings: bindings.map(({ role, agent, keyId }) => ({ role, agent, keyId })),
      configWriteBack: writeResult,
      warnings: password.warnings,
      restartRequired: true,
      nextSteps,
    });
  } finally {
    await session.close?.();
  }
}

// ── join ───────────────────────────────────────────────────────────────────────────────────────

async function runJoin(ctx: CommandContext, parsed: Parsed, deps: CeremonyCommandDeps): Promise<void> {
  const execute = resolveExecute(ctx, parsed);
  const progress = progressWriter(ctx, parsed);
  const catalogFlag = parsed.values.catalog;
  if (catalogFlag === undefined || catalogFlag.length === 0) {
    return invalid(ctx, 'ceremony join requires --catalog <path to the existing catalog>');
  }
  const genesisPin = parsed.values.genesis;
  if (genesisPin === undefined || !/^sha256:[0-9a-f]{64}$/u.test(genesisPin)) {
    return invalid(
      ctx,
      'ceremony join requires --genesis sha256:<64 lowercase hex> (the digest init printed)',
      'The pin is what makes the join a join rather than an unnoticed fork onto a different catalog.',
    );
  }

  const plan = await buildProvisionPlan({ ctx, parsed, deps });
  const rpcUrl = parsed.values['rpc-url'];
  await assertSafeOwnership(ctx, deps, plan, rpcUrl);

  const existing = loadCatalogFile(ctx, plan.catalogPath);
  if (existing.policyGenesisDigest !== genesisPin) {
    return invalid(
      ctx,
      `--genesis ${genesisPin} does not match the catalog at ${plan.catalogPath} (${existing.policyGenesisDigest})`,
      'Joining the wrong catalog would produce a second trust root nobody else accepts.',
    );
  }

  // Before the plan, so the plan never lists a store that holds retired keys, and before any store is
  // opened or anchor sent. The re-run guard below stops only a second join into the same catalog
  // path; a join into one at another path would bind these keys there and point identityStores back
  // at them.
  refuseRotatedFamilies(ctx, {
    verb: 'join',
    dir: plan.dir,
    configPath: plan.configPath,
    families: plan.roleSets,
    catalogs: [plan.catalogPath],
    sideEffects: false,
    hint: `join binds only the stores at ${join(plan.dir, 'identity')}/<family>.enc.json, so it cannot add a rotated `
      + 'family to another catalog.',
  });

  const password = resolveCeremonyPassword({ dir: plan.dir, env: ctx.env });
  if ('refusal' in password) {
    return emitEnvelope({
      code: 'invalid_invocation',
      message: password.refusal,
      hint: password.hint,
      exampleCli: EXAMPLE_CLI,
      details: { feature: 'ceremony', state: 'password-identity-unresolvable', sideEffects: false },
    }, { writer: ctx.writer, exit: ctx.exit });
  }

  const writeBackPlan = planNativeIdentityWriteBack({
    configPath: plan.configPath,
    values: {
      agentIri: plan.agentIri,
      // A join whose --role-sets carries no admission family writes NO admissionAgent: this
      // operator admits for nobody, and claiming an admission authority with no custody behind it
      // is a config the runtime refuses.
      ...(plan.admissionAgent === undefined ? {} : { admissionAgent: plan.admissionAgent }),
      identityStores: plan.identityStores,
      trustRootsPath: plan.catalogPath,
      trustPolicyGenesisDigest: existing.policyGenesisDigest as `sha256:${string}`,
    },
  });

  if (!execute) {
    emitResult(
      {
        schemaVersion: 1,
        kind: 'ceremony_join_plan',
        executeAuthorized: false,
        sideEffects: false,
        dir: plan.dir,
        configPath: plan.configPath,
        roleSets: plan.roleSets,
        agentIri: plan.agentIri,
        ...(plan.admissionAgent === undefined ? {} : { admissionAgent: plan.admissionAgent }),
        agentEoa: plan.custody.agentEoa,
        safeAddress: plan.custody.safeAddress,
        safeOwnershipVerified: true,
        authorityStore: plan.authorityStore,
        catalogPath: plan.catalogPath,
        policyGenesisDigest: existing.policyGenesisDigest,
        currentPolicyVersion: newestPolicy(existing)?.value.version ?? null,
        anchorTarget: plan.anchorTarget,
        identityStores: plan.identityStores,
        passwordSource: password.source,
        warnings: password.warnings,
        configWriteBack: writeBackPlan,
        genesisDigestStable: true,
        restartRequired: true,
      },
      () => humanPlan(plan, 'join', [
        `genesis pin         ${existing.policyGenesisDigest} (unchanged by this join)`,
        `current policy      v${newestPolicy(existing)?.value.version ?? '?'} -> v${(newestPolicy(existing)?.value.version ?? 0) + 1}`,
        `config keys         ${writeBackPlan.written.join(', ')}`,
        ...(password.warnings.length === 0 ? [] : ['', ...password.warnings.map((w) => `WARNING: ${w}`)]),
        '',
        'Existing operators\' configs are untouched (the genesis digest does not move). Distribution of the',
        'rewritten catalog is a FILE COPY to each operator\'s trustRootsPath plus a DAEMON RESTART.',
        '',
        'Re-run with --execute.',
      ]),
      {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env.NO_COLOR),
      },
    );
    return;
  }

  const { signers, authority, created } = await mintCustody({ plan, password: password.password });
  // Before any anchor: a revocation in the catalog this join appends to retired one of these keys,
  // and binding it again, to this Agent or a new one, would make it verify again.
  const retired = await retiredKeys(plan.catalogPath);
  try {
    assertNoRetiredKeyBound(
      retired,
      [...signers.values()].map(({ role, keyId }) => ({ agent: agentForRole(plan, role), keyId })),
    );
  } catch (cause) {
    return emitEnvelope({
      code: 'invalid_invocation',
      message: cause instanceof Error ? cause.message : String(cause),
      hint: `join binds the keys in ${join(plan.dir, 'identity')}/<family>.enc.json, and after \`jinn ceremony rotate\` `
        + 'those stores hold the keys it retired. A rotated family cannot be added to a catalog by join, under its '
        + 'Agent IRI or a new one.',
      exampleCli: EXAMPLE_CLI,
      details: { feature: 'ceremony', state: 'retired-key-bound', sideEffects: created.length > 0 },
    }, { writer: ctx.writer, exit: ctx.exit });
  }

  const anchorDigest = ceremonyAnchorDigest({
    agentIri: plan.agentIri,
    ...(plan.admissionAgent === undefined ? {} : { admissionAgent: plan.admissionAgent }),
    safeAddress: plan.custody.safeAddress,
    keys: [...signers.values()].map(({ role, keyId }) => ({ role, keyId })),
  });

  const prior = readReceipt(plan.dir);
  // A join whose append already landed must not run again: the ceremony nonce is fresh per run, so
  // re-authoring the same keys produces DIFFERENT binding digests, which `appendOperator` would
  // dutifully add as a second set of bindings for one operator.
  if (prior?.anchorDigest === anchorDigest
    && prior.catalogPath === plan.catalogPath
    && typeof prior.policyGenesisDigest === 'string') {
    return refuseConfigWriteBackPending({
      ctx, verb: 'join', plan, policyGenesisDigest: prior.policyGenesisDigest,
    });
  }
  const reusedAnchor = reusableAnchor(prior, anchorDigest);

  const session = await deps.openAnchorSession({
    dir: plan.dir,
    serviceIndex: plan.custody.serviceIndex,
    password: password.password,
    anchorTarget: plan.anchorTarget,
    ...(rpcUrl === undefined ? {} : { rpcUrl }),
  });
  try {
    const locator = reusedAnchor ?? await session.submit(anchorDigest);
    if (reusedAnchor === undefined) {
      writeReceipt(plan.dir, {
        schemaVersion: 1,
        agentIri: plan.agentIri,
        ...(plan.admissionAgent === undefined ? {} : { admissionAgent: plan.admissionAgent }),
        anchorDigest,
        anchorTransactionHash: locator.transactionHash,
        anchorLocator: locator,
        validFrom: locator.anchorTime,
      });
    }
    progress({
      schemaVersion: 1,
      kind: reusedAnchor === undefined ? 'ceremony_anchor_submitted' : 'ceremony_anchor_reused',
      anchorDigest,
      transactionHash: locator.transactionHash,
      anchorTime: locator.anchorTime,
      note: 'waiting for the finalized tag (Base Sepolia trails head by roughly 10-20 minutes)',
    }, reusedAnchor === undefined
      ? `anchor submitted    ${locator.transactionHash} at ${locator.anchorTime}\n`
        + '  waiting for the finalized tag (Base Sepolia trails head by roughly 10-20 minutes)'
      : `anchor reused       ${locator.transactionHash} at ${locator.anchorTime} (from a previous run's receipt)\n`
        + '  waiting for the finalized tag');
    await session.waitForFinalized({
      digest: anchorDigest,
      locator,
      timeoutMs: plan.finalityTimeoutMs,
      pollMs: FINALITY_POLL_MS,
      // Without this the join printed NOTHING for up to 45 minutes — indistinguishable from a hang,
      // and the operator's only options were to wait blind or kill a run mid-ceremony.
      onProgress: (elapsedMs) => {
        progress({
          schemaVersion: 1,
          kind: 'ceremony_finality_wait',
          anchorDigest,
          elapsedMs,
        }, `  still waiting for finality — ${Math.round(elapsedMs / 1000)}s elapsed`);
      },
    });

    const validFrom = locator.anchorTime;
    const bindings = await authorBindings({
      plan,
      signers,
      ceremonySigner: { address: plan.custody.agentEoa, signMessage: (m) => session.signMessage(m) },
      validFrom,
      anchorDigest,
    });

    const { newestPolicyVersion, policyGenesisDigest } = await appendOperator({
      catalogPath: plan.catalogPath,
      authority,
      newBindings: [...bindings],
      newAnchor: anchorDeclaration(anchorDigest, locator),
      refreshBy: refreshByFrom(validFrom),
    });

    if (policyGenesisDigest !== genesisPin) {
      // Structurally impossible (`appendOperator` never rewrites the genesis), asserted anyway:
      // a moved genesis would silently invalidate every existing operator's pin.
      throw new Error(`join moved the genesis digest from ${genesisPin} to ${policyGenesisDigest}`);
    }

    extendReceipt(plan.dir, { catalogPath: plan.catalogPath, policyGenesisDigest });

    const writeResult = writeNativeIdentityConfig({
      configPath: plan.configPath,
      values: {
        agentIri: plan.agentIri,
        ...(plan.admissionAgent === undefined ? {} : { admissionAgent: plan.admissionAgent }),
        identityStores: plan.identityStores,
        trustRootsPath: plan.catalogPath,
        trustPolicyGenesisDigest: policyGenesisDigest,
      },
    });

    extendReceipt(plan.dir, { completedAt: new Date().toISOString() });

    emitCompletion(ctx, parsed, {
      schemaVersion: 1,
      kind: 'ceremony_join_complete',
      executeAuthorized: true,
      sideEffects: true,
      dir: plan.dir,
      agentIri: plan.agentIri,
      ...(plan.admissionAgent === undefined ? {} : { admissionAgent: plan.admissionAgent }),
      catalogPath: plan.catalogPath,
      policyGenesisDigest,
      genesisDigestStable: true,
      newestPolicyVersion,
      anchorDigest,
      anchorTransactionHash: locator.transactionHash,
      anchorReused: reusedAnchor !== undefined,
      validFrom,
      storesCreated: created,
      bindings: bindings.map(({ role, agent, keyId }) => ({ role, agent, keyId })),
      configWriteBack: writeResult,
      warnings: password.warnings,
      restartRequired: true,
      nextSteps: [
        `Copy ${plan.catalogPath} to every OTHER operator's trustRootsPath — the genesis digest did not move, `
          + 'so their configs need no edit.',
        'Restart every daemon: assertFresh makes a changed catalog under a running daemon a hard refusal.',
        ...(writeResult.outstanding.length === 0
          ? []
          : [`Author the remaining native deploy-config by hand: ${writeResult.outstanding.join(', ')}.`]),
      ],
    });
  } finally {
    await session.close?.();
  }
}

// ── rotate ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Where an in-progress rotation records the stores it minted and the stores it retires, so a re-run
 * after an interruption reopens them instead of minting a second set of keys, and each act's anchor
 * the moment it is submitted, so a re-run resumes onto it instead of sending a second one. The
 * catalog itself says which half has landed: a replacement key it binds is rebound, a retired
 * binding it revokes is revoked.
 */
function rotationReceiptPath(dir: string): string {
  return join(dir, 'ceremony', 'rotation.json');
}

interface RotationReceipt {
  readonly schemaVersion: 1;
  readonly roleSets: readonly RoleSetName[];
  /** The new store per family, minted for this rotation. */
  readonly stores: Partial<Record<RoleSetName, string>>;
  /**
   * The store per family this rotation retires: the config's when it began. The config is repointed
   * mid-rotation, so after that only the receipt names them. Absent from a receipt written before
   * #5311, whose rotation repointed the config last.
   */
  readonly retiring?: Partial<Record<RoleSetName, string>>;
  readonly rebindAnchor?: RecordedRotationAnchor;
  readonly revocationAnchor?: RecordedRotationAnchor;
  readonly completedAt?: string;
}

/** An anchor this rotation submitted for one of its two acts (§4.5). */
interface RecordedRotationAnchor {
  readonly digest: `sha256:${string}`;
  readonly locator: AnchorLocator;
}

/** The receipt's shape, checked field by field: every field rotate reads is one it can rely on. */
function isRotationReceipt(value: unknown): value is RotationReceipt {
  const isObject = (field: unknown): field is Record<string, unknown> =>
    field !== null && typeof field === 'object' && !Array.isArray(field);
  const isFamily = (family: unknown): boolean => typeof family === 'string' && Object.hasOwn(ROLE_SETS, family);
  const isStorePaths = (field: unknown): boolean => isObject(field)
    && Object.entries(field).every(([family, path]) => isFamily(family) && typeof path === 'string' && path.length > 0);
  const isRecordedAnchor = (field: unknown): boolean => field === undefined
    || (isObject(field) && typeof field.digest === 'string');
  return isObject(value)
    && value.schemaVersion === 1
    && Array.isArray(value.roleSets) && value.roleSets.length > 0 && value.roleSets.every(isFamily)
    && isStorePaths(value.stores)
    && (value.retiring === undefined || isStorePaths(value.retiring))
    && isRecordedAnchor(value.rebindAnchor)
    && isRecordedAnchor(value.revocationAnchor)
    && (value.completedAt === undefined || typeof value.completedAt === 'string');
}

/** The receipt, or `undefined` when there is none or it cannot be read. */
function readRotationReceipt(dir: string): RotationReceipt | undefined {
  const path = rotationReceiptPath(dir);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return isRotationReceipt(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The receipt, `undefined` when none exists, and a refusal when one exists but cannot be read.
 * From the config repoint on, the receipt is the only record of the stores a rotation retires, so
 * reading an unreadable one as no rotation would take the keys it just bound for the ones to retire.
 */
function readRotationReceiptOrRefuse(ctx: CommandContext, input: {
  readonly verb: 'init' | 'join' | 'rotate';
  readonly dir: string;
  readonly sideEffects: boolean;
}): RotationReceipt | undefined {
  const path = rotationReceiptPath(input.dir);
  const receipt = readRotationReceipt(input.dir);
  if (receipt !== undefined || !existsSync(path)) return receipt;
  const message = `${path} exists but cannot be read as a rotation receipt, so ${input.verb} cannot tell `
    + 'which keys a rotation retired, and refuses rather than guess.';
  emitEnvelope({
    code: 'invalid_invocation',
    message,
    hint: `Restore ${path} as \`jinn ceremony rotate\` wrote it: it names the stores a rotation retires.`,
    exampleCli: EXAMPLE_CLI,
    details: { feature: 'ceremony', state: 'rotation-receipt-unreadable', sideEffects: input.sideEffects },
  }, { writer: ctx.writer, exit: ctx.exit });
  throw new CeremonyRefusal(message);
}

/**
 * Written to a temporary file beside the receipt, flushed, then renamed over it, so a write that
 * fails or is interrupted leaves the previous receipt whole rather than truncated.
 */
function writeRotationReceipt(dir: string, receipt: RotationReceipt): void {
  const path = rotationReceiptPath(dir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeConfigFileAtomic(path, receipt);
}

/** One retiring role: its current key and the catalog binding of that key the rotation revokes. */
interface RetiringRole {
  readonly role: NativeRoleIdentityRole;
  readonly agent: string;
  readonly keyId: string;
  readonly bindingDigests: readonly `sha256:${string}`[];
}

/** The catalog's bindings and revocations, read structurally. Verification is the opener's job. */
function catalogRecords(file: CatalogFileShape): {
  readonly bindings: readonly { readonly digest: `sha256:${string}`; readonly binding: KeyBinding }[];
  readonly revocations: readonly Revocation[];
} {
  const bindings = file.bindings.flatMap((entry) => {
    if (typeof entry.envelope !== 'string' || typeof entry.digest !== 'string') return [];
    const report = validateKeyBinding(new Uint8Array(Buffer.from(entry.envelope, 'base64')));
    return report.conforms && report.value !== undefined
      ? [{ digest: entry.digest as `sha256:${string}`, binding: report.value }]
      : [];
  });
  const revocations = file.revocations.flatMap((entry) => {
    const envelope = (entry as { envelope?: unknown }).envelope;
    if (typeof envelope !== 'string') return [];
    const report = validateRevocation(new Uint8Array(Buffer.from(envelope, 'base64')));
    return report.conforms && report.value !== undefined ? [report.value] : [];
  });
  return { bindings, revocations };
}

/**
 * The catalog's bindings, unrevoked under `voucherDid`, of a key for one of the retiring roles that
 * is not in `held` (`<agent> <did:key>`). A binding names no role, so a role is matched by its Agent
 * and exact scope.
 */
function unaccountedBindings(input: {
  readonly catalog: ReturnType<typeof catalogRecords>;
  readonly retiring: readonly RetiringRole[];
  readonly voucherDid: string;
  readonly revokedByVoucher: ReadonlySet<string>;
  readonly held: ReadonlySet<string>;
}): readonly { readonly role: NativeRoleIdentityRole; readonly keyId: string; readonly bindingDigest: `sha256:${string}` }[] {
  const scopeOf = (scope: readonly string[]): string => [...scope].sort().join(' ');
  const found = new Map<string, { readonly role: NativeRoleIdentityRole; readonly keyId: string; readonly bindingDigest: `sha256:${string}` }>();
  for (const { role, agent } of input.retiring) {
    const scope = scopeOf(scopeForRole(role));
    for (const { digest, binding } of input.catalog.bindings) {
      if (binding.agent !== agent || scopeOf(binding.scope) !== scope) continue;
      if (binding.voucher.kind !== 'account' || binding.voucher.did !== input.voucherDid) continue;
      if (input.revokedByVoucher.has(digest) || input.held.has(`${binding.agent} ${binding.key.didKey}`)) continue;
      if (!found.has(digest)) found.set(digest, { role, keyId: binding.key.didKey, bindingDigest: digest });
    }
  }
  return [...found.values()];
}

/**
 * `--retiring-store <family>=<path>`, once for each family of `--role-sets`: the store a rotation
 * whose receipt was lost after its config repoint was retiring. `undefined` when the flag is absent.
 */
function parseRetiringStores(
  ctx: CommandContext,
  raw: readonly string[] | undefined,
  roleSets: readonly RoleSetName[],
): Partial<Record<RoleSetName, string>> | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const named: Partial<Record<RoleSetName, string>> = {};
  for (const entry of raw) {
    const separator = entry.indexOf('=');
    const family = entry.slice(0, separator) as RoleSetName;
    const path = entry.slice(separator + 1);
    if (separator < 0 || !roleSets.includes(family)) {
      invalid(ctx, `--retiring-store takes <family>=<path> for a family of --role-sets (${roleSets.join(', ')}), got "${entry}"`);
    }
    if (named[family] !== undefined) invalid(ctx, `--retiring-store names "${family}" more than once`);
    if (!isAbsolute(path)) invalid(ctx, `--retiring-store ${family} must be an absolute path, got "${path}"`);
    named[family] = path;
  }
  const unnamed = roleSets.filter((family) => named[family] === undefined);
  if (unnamed.length > 0) {
    invalid(
      ctx,
      `--retiring-store names no store for ${unnamed.join(', ')}`,
      'Name, for each family of --role-sets, the store the rotation whose receipt was lost was retiring.',
    );
  }
  return named;
}

/**
 * A UTC stamp to the second, safe in a file name. Two runs can read the same one, so the stamp alone
 * does not keep a rotated store off an existing path; `newRotatedStorePath` refuses one that is taken.
 */
function rotationStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

/**
 * Where a new rotation mints `family`'s store, `<dir>/identity/<family>.rotated-<stamp>.enc.json`,
 * refusing (`new-store-exists`) when a file is already there. The stamp is to the second, so a
 * rotation started in the same second as an earlier one, or after the clock stepped back, names that
 * rotation's store, which is the very store this rotation would retire when the config names it.
 * Taken as the new store, it would bind no new key, and the rotation would either retire nothing or
 * revoke the keys the config names while pointing the config at keys already bound. A new store is
 * minted, never found. A run finishing a lost rotation (`--retiring-store`) takes the configured
 * store as its new one and never comes here.
 */
function newRotatedStorePath(ctx: CommandContext, input: {
  readonly dir: string;
  readonly family: RoleSetName;
  readonly stamp: string;
  readonly retiringStore: string | undefined;
}): string {
  const path = join(input.dir, 'identity', `${input.family}.rotated-${input.stamp}.enc.json`);
  if (!existsSync(path)) return path;
  const message = `ceremony rotate would mint the new ${input.family} store at ${path}, but a file is already there`
    + `${path === input.retiringStore ? ', the store this rotation would retire' : ''}. A rotated store is named by `
    + 'the second its rotation started, so a rotation started in the same second as an earlier one, or after the '
    + 'clock stepped back, names the store that one minted. rotate never takes an existing store as a new one, and '
    + 'refuses before anything is minted or anchored.';
  emitEnvelope({
    code: 'invalid_invocation',
    message,
    hint: 'Re-run once the clock has passed that second: the new store then gets a name of its own.',
    exampleCli: EXAMPLE_CLI,
    details: { feature: 'ceremony', state: 'new-store-exists', sideEffects: false, family: input.family, path },
  }, { writer: ctx.writer, exit: ctx.exit });
  throw new CeremonyRefusal(message);
}

/**
 * `jinn ceremony rotate` (spec §3.2 rotation, §6 laws 1 and 6): retires every key of the named role
 * families and binds new ones, for an operator `init` or `join` already provisioned.
 *
 * A store holds all of a family's keys under one password and is never rewritten, so a family is
 * the unit: the rotation mints a NEW store for it, then
 *   1. rebinds: one fresh `ceremony-anchor/v1` anchor over the replacement keys, then their
 *      bindings, vouched by the same agent EOA (`rebindRoles`);
 *   2. points `identityStores.<family>` at the new store, whose keys are now bound;
 *   3. revokes: one fresh `revocation-anchor/v1` anchor, then the agent EOA's revocation of every
 *      retired binding (`planRevocation`, `revokeBinding`).
 * The rebind comes first because a replacement draws its authority from a binding of the same
 * Agent and voucher that still stands at its effective start, and an admission Agent has no other.
 * The config moves before the revocation, so it never names a store whose bindings are revoked.
 * The voucher check runs before either anchor is sent, so a rotation the catalog would ignore
 * spends no gas.
 */
async function runRotate(ctx: CommandContext, parsed: Parsed, deps: CeremonyCommandDeps): Promise<void> {
  const execute = resolveExecute(ctx, parsed);
  const progress = progressWriter(ctx, parsed);
  const dir = resolveDir(ctx, parsed);
  const configPath = parsed.values.config ?? join(dir, 'config.json');
  const roleSets = parseRoleSets(ctx, parsed.values['role-sets'], { requireRequester: false });
  const config = readConfigObject(configPath);
  const agentIri = typeof config.agentIri === 'string' && config.agentIri.length > 0 ? config.agentIri : undefined;
  const admissionAgent = typeof config.admissionAgent === 'string' && config.admissionAgent.length > 0
    ? config.admissionAgent
    : undefined;
  const genesisPin = typeof config.trustPolicyGenesisDigest === 'string' ? config.trustPolicyGenesisDigest : undefined;
  const configuredStores = (config.identityStores !== null && typeof config.identityStores === 'object')
    ? config.identityStores as Partial<Record<RoleSetName, unknown>>
    : {};
  if (agentIri === undefined || genesisPin === undefined) {
    return invalid(
      ctx,
      `ceremony rotate needs a provisioned operator, and ${configPath} has no agentIri or trustPolicyGenesisDigest`,
      'Rotation retires keys a ceremony already bound. Run `jinn ceremony init` or `join` first.',
    );
  }
  for (const family of roleSets) {
    if (typeof configuredStores[family] !== 'string') {
      invalid(ctx, `ceremony rotate --role-sets names "${family}", but ${configPath} has no identityStores.${family}`);
    }
  }
  if (roleSets.includes('admission') && admissionAgent === undefined) {
    invalid(ctx, `ceremony rotate --role-sets names "admission", but ${configPath} has no admissionAgent`);
  }
  const catalogPath = parsed.values.catalog
    ?? (typeof config.trustRootsPath === 'string' ? config.trustRootsPath : join(dir, 'trust.json'));

  const serviceIndexRaw = parsed.values['service-index'];
  const serviceIndex = serviceIndexRaw === undefined ? undefined : Number(serviceIndexRaw);
  if (serviceIndex !== undefined && (!Number.isInteger(serviceIndex) || serviceIndex < 1)) {
    invalid(ctx, `--service-index must be a positive integer, got "${serviceIndexRaw}"`);
  }
  const anchorTargetRaw = parsed.values['anchor-target'];
  if (anchorTargetRaw !== undefined && !/^0x[0-9a-fA-F]{40}$/u.test(anchorTargetRaw)) {
    invalid(ctx, `--anchor-target must be a 20-byte hex address, got "${anchorTargetRaw}"`);
  }
  const timeoutRaw = parsed.values['finality-timeout-ms'];
  const finalityTimeoutMs = timeoutRaw === undefined ? DEFAULT_FINALITY_TIMEOUT_MS : Number(timeoutRaw);
  if (!Number.isFinite(finalityTimeoutMs) || finalityTimeoutMs <= 0) {
    invalid(ctx, `--finality-timeout-ms must be a positive number, got "${timeoutRaw}"`);
  }
  const namedRetiring = parseRetiringStores(ctx, parsed.values['retiring-store'], roleSets);

  let custody: CeremonyChainCustody;
  try {
    custody = await deps.readChainCustody({ dir, ...(serviceIndex === undefined ? {} : { serviceIndex }) });
  } catch (cause) {
    return invalid(
      ctx,
      `the operator's earning state at ${dir} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      'Rotation re-vouches with the agent EOA the earning bootstrap created.',
    );
  }
  const rpcUrl = parsed.values['rpc-url'];
  await assertSafeOwnership(ctx, deps, { custody }, rpcUrl);
  const plan: BindingPlan = { agentIri, ...(admissionAgent === undefined ? {} : { admissionAgent }), custody };

  const password = resolveCeremonyPassword({ dir, env: ctx.env });
  if ('refusal' in password) {
    return emitEnvelope({
      code: 'invalid_invocation',
      message: password.refusal,
      hint: password.hint,
      exampleCli: EXAMPLE_CLI,
      details: { feature: 'ceremony', state: 'password-identity-unresolvable', sideEffects: false },
    }, { writer: ctx.writer, exit: ctx.exit });
  }

  // An unfinished receipt is resumed whatever the config names: the config is repointed between
  // the two acts, so after the rebind only the receipt names the stores being retired. A receipt that
  // exists but cannot be read refuses here, before anything is minted or anchored, in the plan too.
  const prior = readRotationReceiptOrRefuse(ctx, { verb: 'rotate', dir, sideEffects: false });
  const resuming = prior !== undefined && prior.completedAt === undefined;
  if (resuming && JSON.stringify([...prior.roleSets].sort()) !== JSON.stringify([...roleSets].sort())) {
    invalid(
      ctx,
      `a rotation of ${prior.roleSets.join(',')} is in progress (${rotationReceiptPath(dir)})`,
      `Re-run it with --role-sets ${prior.roleSets.join(',')} to finish it.`,
    );
  }
  const resubmitAnchor = parsed.values['resubmit-anchor'] === true;
  if (resubmitAnchor && !resuming) {
    invalid(
      ctx,
      `--resubmit-anchor applies only to an unfinished rotation, and ${rotationReceiptPath(dir)} names none`,
      'Without an unfinished rotation, rotate starts a new one, which retires the keys the config names. Drop the flag to do that.',
    );
  }
  if (namedRetiring !== undefined && resuming) {
    // The same command, re-run after an interruption: the receipt it wrote names these stores.
    const differs = roleSets.filter((family) => prior.retiring?.[family] !== namedRetiring[family]);
    if (differs.length > 0) {
      invalid(
        ctx,
        `--retiring-store names another store for ${differs.join(', ')} than the unfinished rotation in ${rotationReceiptPath(dir)} retires`,
        'Re-run without --retiring-store: rotate resumes that rotation from its receipt.',
      );
    }
  }
  // A rotation whose receipt was lost after its config repoint: identityStores names the store it
  // bound, and only the operator can name the store it was retiring. The catalog must bear that out
  // before anything is anchored (below), and this run finishes that rotation rather than starting one.
  const recovering = namedRetiring !== undefined && !resuming;
  const refuseRetiringStore = (message: string): never => {
    emitEnvelope({
      code: 'invalid_invocation',
      message,
      hint: '--retiring-store names, for each family of the rotation whose receipt was lost, the store identityStores '
        + 'named before that rotation. rotate revokes its keys only when the catalog binds the keys identityStores names '
        + 'now, unrevoked, and bound each one after the key it replaces.',
      exampleCli: EXAMPLE_CLI,
      details: { feature: 'ceremony', state: 'retiring-store-mismatch', sideEffects: false },
    }, { writer: ctx.writer, exit: ctx.exit });
    throw new CeremonyRefusal(message);
  };
  if (recovering) {
    for (const family of roleSets) {
      if (namedRetiring[family] === configuredStores[family]) {
        refuseRetiringStore(`--retiring-store names ${namedRetiring[family]} for ${family}, the store ${configPath} names. `
          + 'After a rotation repoints the config, that store holds the keys it bound, not the ones it was retiring.');
      }
    }
  }
  const retiringStores: Partial<Record<RoleSetName, string>> = Object.fromEntries(roleSets.map((family) => [
    family,
    // A receipt without them was written by a rotate that repointed the config last, so until that
    // rotation finished, the config still names them.
    (resuming ? prior.retiring?.[family] : namedRetiring?.[family]) ?? configuredStores[family] as string,
  ]));
  const stamp = rotationStamp(new Date());
  const newStores: Partial<Record<RoleSetName, string>> = Object.fromEntries(roleSets.map((family) => {
    if (resuming && typeof prior.stores[family] === 'string') return [family, prior.stores[family]];
    // Finishing a rotation: the store it minted and bound is the one the config already names.
    if (recovering) return [family, configuredStores[family] as string];
    return [family, newRotatedStorePath(ctx, { dir, family, stamp, retiringStore: retiringStores[family] })];
  }));

  // The keys being retired: the ones the retiring stores hold, and their catalog bindings.
  const catalog = catalogRecords(loadCatalogFile(ctx, catalogPath));
  const voucherDid = didPkh(84532, custody.agentEoa);
  const retiring: RetiringRole[] = [];
  for (const family of roleSets) {
    // Equal only for such a receipt once its rotation wrote the config: that rotation finished, and
    // this store holds the keys it bound, not the ones it retired. A new rotation never skips a
    // family: it opens the store it retires and refuses unless the catalog binds each key there, so
    // it never completes with nothing retired.
    if (resuming && retiringStores[family] === newStores[family]) continue;
    let current: ReadonlyMap<NativeRoleIdentityRole, RoleSigner>;
    try {
      // eslint-disable-next-line no-await-in-loop -- bounded (≤4 families).
      current = await openRoleSigners({
        storePath: retiringStores[family]!,
        password: password.password,
        ownedRoles: orderedRolesForSet(family),
        create: false,
      });
    } catch (cause) {
      return invalid(ctx, `the ${family} store at ${String(retiringStores[family])} could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    for (const [role, signer] of current) {
      const agent = agentForRole(plan, role);
      const bindingDigests = catalog.bindings
        .filter(({ binding }) => binding.agent === agent && binding.key.didKey === signer.keyId)
        .map(({ digest }) => digest);
      if (bindingDigests.length === 0) {
        invalid(ctx, `${catalogPath} binds no ${role} key ${signer.keyId} for ${agent}; there is nothing to rotate`);
      }
      retiring.push({ role, agent, keyId: signer.keyId, bindingDigests });
    }
  }
  const revokedByVoucher = new Set(catalog.revocations
    .filter(({ revokedBy }) => revokedBy === voucherDid)
    .map(({ target }) => target));

  // Finishing a rotation from --retiring-store revokes the named stores' keys only when the catalog
  // shows what that rotation's rebind left: each key of the store identityStores names bound and
  // unrevoked, and bound after the named store's key for the same role. A rotation binds its
  // replacement after the key it retires, so this never revokes the keys a rotation just bound.
  const replacementKeys: string[] = [];
  if (recovering) {
    const validFromOf = (digests: readonly string[]): number[] => catalog.bindings
      .filter(({ digest }) => digests.includes(digest))
      .map(({ binding }) => Date.parse(binding.validFrom));
    for (const family of roleSets) {
      let replacement: ReadonlyMap<NativeRoleIdentityRole, RoleSigner>;
      try {
        // eslint-disable-next-line no-await-in-loop -- bounded (≤4 families).
        replacement = await openRoleSigners({
          storePath: newStores[family]!,
          password: password.password,
          ownedRoles: orderedRolesForSet(family),
          create: false,
        });
      } catch (cause) {
        return invalid(ctx, `the ${family} store at ${String(newStores[family])} could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      for (const [role, signer] of replacement) {
        const agent = agentForRole(plan, role);
        const standing = catalog.bindings
          .filter(({ digest, binding }) => binding.agent === agent && binding.key.didKey === signer.keyId
            && !revokedByVoucher.has(digest))
          .map(({ digest }) => digest);
        if (standing.length === 0) {
          refuseRetiringStore(`${catalogPath} holds no unrevoked binding of the ${role} key ${signer.keyId} in `
            + `${String(newStores[family])}, the store ${configPath} names, so no rotation bound it and repointed the config at it.`);
        }
        const retired = retiring.find((entry) => entry.role === role)!;
        if (Math.max(...validFromOf(retired.bindingDigests)) >= Math.min(...validFromOf(standing))) {
          refuseRetiringStore(`${catalogPath} bound the ${role} key ${retired.keyId} in ${String(retiringStores[family])} `
            + `no earlier than the key ${signer.keyId} in ${String(newStores[family])}, the store ${configPath} names. A `
            + 'rotation binds its replacement after the key it retires, so these may be the keys a rotation just bound, '
            + 'and rotate does not revoke them.');
        }
        replacementKeys.push(`${agent} ${signer.keyId}`);
      }
    }
  }

  // A rotation stopped after its config repoint, whose receipt is then lost, leaves the config naming
  // the store it just bound while the keys it was retiring stay bound. A new rotation from the config
  // would revoke the newer keys and leave those. So a new rotation refuses while the catalog binds,
  // unrevoked under this voucher, another key for one of its roles that no store the config names
  // holds. Roles of different families can share an Agent and scope (the discovery roles, the
  // settlement roles), so the keys of the config's other stores are set aside first. A resumed
  // rotation is exempt: its receipt names both stores, and its replacement keys are its own rebind.
  // Finishing a rotation from --retiring-store is not: a key that neither the named stores nor the
  // config's hold means the named stores are not all that rotation was retiring.
  if (!resuming) {
    const held = new Set([...retiring.map(({ agent, keyId }) => `${agent} ${keyId}`), ...replacementKeys]);
    const unaccounted = () => unaccountedBindings({ catalog, retiring, voucherDid, revokedByVoucher, held });
    if (unaccounted().length > 0) {
      for (const family of Object.keys(ROLE_SETS) as RoleSetName[]) {
        const storePath = configuredStores[family];
        if (roleSets.includes(family) || typeof storePath !== 'string') continue;
        let keys: ReadonlyMap<NativeRoleIdentityRole, RoleSigner>;
        try {
          // eslint-disable-next-line no-await-in-loop -- bounded (≤4 families).
          keys = await openRoleSigners({
            storePath,
            password: password.password,
            ownedRoles: orderedRolesForSet(family),
            create: false,
          });
        } catch (cause) {
          return invalid(ctx, `the ${family} store at ${storePath} could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        for (const [role, signer] of keys) held.add(`${agentForRole(plan, role)} ${signer.keyId}`);
      }
    }
    const remaining = unaccounted();
    if (remaining.length > 0) {
      const roles = [...new Set(remaining.map(({ role }) => role))];
      const message = `${catalogPath} still binds, unrevoked under the agent EOA ${custody.agentEoa}, another key for `
        + `${roles.join(', ')} that no store ${configPath}${recovering ? ' or --retiring-store' : ''} names holds: `
        + `${remaining.map(({ keyId }) => keyId).join(', ')}. `
        + (recovering
          ? 'So the stores --retiring-store names are not every store the rotation whose receipt was lost was retiring, '
            + 'and rotate refuses before anything is anchored rather than leave those keys bound.'
          : 'A rotation that stopped after it repointed the config leaves exactly this: the config names the keys it bound, '
            + 'and the keys it was retiring are still bound. Rotating from the config would revoke the newer keys and leave '
            + 'these bound, so rotate refuses before anything is minted or anchored.');
      emitEnvelope({
        code: 'invalid_invocation',
        message,
        hint: recovering
          ? 'Re-run with the --role-sets of that rotation and a --retiring-store for each of its families. Roles of '
            + 'different families share an Agent and scope, so a key listed here can belong to another family of it.'
          : `If ${rotationReceiptPath(dir)} was moved or deleted, restore it as rotate wrote it and re-run with the same `
            + '--role-sets: rotate resumes that rotation. If its recorded anchor never reads back finalized, add '
            + '--resubmit-anchor. If the receipt is lost for good, finish that rotation from the store it was retiring, '
            + 'which rotate leaves where it was (for a store init or join minted, '
            + `${join(dir, 'identity', '<family>.enc.json')}): re-run with that rotation's --role-sets and, for each of its `
            + 'families, --retiring-store <family>=<path> naming the store identityStores named before it. rotate revokes '
            + 'those keys only when the catalog bound them before the keys identityStores names now.',
        exampleCli: EXAMPLE_CLI,
        details: { feature: 'ceremony', state: 'another-key-bound', sideEffects: false, bindings: remaining },
      }, { writer: ctx.writer, exit: ctx.exit });
      throw new CeremonyRefusal(message);
    }
  }
  const allTargets = retiring.flatMap(({ bindingDigests }) => bindingDigests);
  const pendingTargets = allTargets.filter((digest) => !revokedByVoucher.has(digest));
  if (recovering && pendingTargets.length === 0) {
    invalid(
      ctx,
      `${catalogPath} already revokes every binding of the keys in ${roleSets.map((family) => retiringStores[family]).join(', ')}: `
        + 'there is nothing to finish.',
    );
  }

  // Key authority section 8: only each binding's voucher account can revoke it. Shown against the
  // catalog before either anchor is sent; planning never asks the account to sign.
  const planningVoucher = {
    address: custody.agentEoa,
    async signMessage(): Promise<`0x${string}`> { throw new Error('planning a revocation signs nothing'); },
  };
  let revocationPlan: RevocationPlan | undefined;
  if (pendingTargets.length > 0) {
    try {
      revocationPlan = await planRevocation({ catalogPath, voucher: planningVoucher, targets: pendingTargets });
    } catch (cause) {
      return invalid(
        ctx,
        `the agent EOA ${custody.agentEoa} cannot revoke the retiring bindings: ${cause instanceof Error ? cause.message : String(cause)}`,
        'A role binding is revoked by the account that vouched for it. Run rotate with the earning service whose EOA ran the ceremony (--service-index).',
      );
    }
  }

  if (!execute) {
    emitResult(
      {
        schemaVersion: 1,
        kind: 'ceremony_rotate_plan',
        executeAuthorized: false,
        sideEffects: false,
        dir,
        configPath,
        catalogPath,
        roleSets,
        agentEoa: custody.agentEoa,
        safeOwnershipVerified: true,
        resuming,
        retiring: retiring.map(({ role, agent, keyId, bindingDigests }) => ({ role, agent, keyId, bindingDigests })),
        newStores,
        revocationAnchorDigest: revocationPlan?.anchorDigest ?? null,
        passwordSource: password.source,
        warnings: password.warnings,
        restartRequired: true,
      },
      () => [
        'jinn ceremony rotate: PLAN (no side effects)',
        '',
        `operator dir        ${dir}`,
        `catalog             ${catalogPath}`,
        `agent EOA           ${custody.agentEoa}`,
        '',
        'retiring',
        ...retiring.map(({ role, keyId }) => `  ${role.padEnd(24)} ${keyId}`),
        '',
        'new stores',
        ...Object.entries(newStores).map(([family, path]) => `  ${family.padEnd(10)} ${path}`),
        '',
        'Re-run with --execute to mint the new stores, anchor and author the replacement bindings, then anchor and',
        'author the revocation of the retiring ones. Two anchors, two finality waits.',
      ].join('\n'),
      {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env.NO_COLOR),
      },
    );
    return;
  }

  // Recorded BEFORE any store is minted, so an interrupted run reopens these stores rather than
  // minting a second set of keys, and before the config is repointed, so it can still find the
  // retiring ones.
  let receipt: RotationReceipt = resuming
    ? { ...prior, retiring: prior.retiring ?? retiringStores }
    : { schemaVersion: 1, roleSets, stores: newStores, retiring: retiringStores };
  writeRotationReceipt(dir, receipt);
  const replacementSigners = new Map<NativeRoleIdentityRole, RoleSigner>();
  const storesCreated: string[] = [];
  for (const family of roleSets) {
    const storePath = newStores[family]!;
    const existed = existsSync(storePath);
    // eslint-disable-next-line no-await-in-loop -- bounded (≤4 families).
    const minted = await openRoleSigners({
      storePath,
      password: password.password,
      ownedRoles: orderedRolesForSet(family),
      create: true,
    });
    for (const [role, signer] of minted) replacementSigners.set(role, signer);
    if (!existed) storesCreated.push(storePath);
  }
  const boundKeys = new Set(catalog.bindings.map(({ binding }) => `${binding.agent} ${binding.key.didKey}`));
  const unbound = new Map([...replacementSigners].filter(([role, signer]) =>
    !boundKeys.has(`${agentForRole(plan, role)} ${signer.keyId}`)));

  const session = await deps.openAnchorSession({
    dir,
    serviceIndex: custody.serviceIndex,
    password: password.password,
    anchorTarget: (anchorTargetRaw as `0x${string}` | undefined) ?? custody.agentEoa,
    ...(rpcUrl === undefined ? {} : { rpcUrl }),
  });
  const anchorAndWait = async (digest: `sha256:${string}`, act: 'rebind' | 'revocation'): Promise<AnchorLocator> => {
    // Each act's anchor is fresh for that act (§6): submitted by this rotation, never another act's.
    // An interrupted run recorded it the moment it existed, and a re-run of the same act, which
    // recomputes the same digest, waits on it again rather than sending a second one (§4.5). A fresh
    // one replaces the record when the recorded digest differs, and when the operator asks for one
    // because the recorded anchor never reads back finalized (--resubmit-anchor).
    const field = act === 'rebind' ? 'rebindAnchor' : 'revocationAnchor';
    const recorded = receipt[field];
    const reused = !resubmitAnchor && recorded?.digest === digest ? recordedLocator(recorded.locator) : undefined;
    const locator = reused ?? await session.submit(digest);
    if (reused === undefined) {
      receipt = { ...receipt, [field]: { digest, locator } };
      writeRotationReceipt(dir, receipt);
    }
    progress({
      schemaVersion: 1,
      kind: reused === undefined ? 'ceremony_anchor_submitted' : 'ceremony_anchor_reused',
      act,
      anchorDigest: digest,
      transactionHash: locator.transactionHash,
      anchorTime: locator.anchorTime,
      note: 'waiting for the finalized tag (Base Sepolia trails head by roughly 10-20 minutes)',
    }, `${act} anchor ${reused === undefined ? 'submitted' : 'reused'} ${locator.transactionHash} at ${locator.anchorTime}\n`
      + '  waiting for the finalized tag (Base Sepolia trails head by roughly 10-20 minutes)');
    const finalized = await session.waitForFinalized({
      digest,
      locator,
      timeoutMs: finalityTimeoutMs,
      pollMs: FINALITY_POLL_MS,
      onProgress: (elapsedMs) => {
        progress({ schemaVersion: 1, kind: 'ceremony_finality_wait', act, anchorDigest: digest, elapsedMs },
          `  still waiting for finality, ${Math.round(elapsedMs / 1000)}s elapsed`);
      },
    });
    // §6 law 2: the anchor's block time is the act's validFrom or effectiveTime. The finality read
    // is the chain's record of it; a resumed locator's copy came from the receipt, a file anyone with
    // the operator's access can edit. So the act takes the block time the finality read returns.
    return { ...locator, anchorTime: finalized.anchorTime };
  };
  try {
    const ceremonySigner = { address: custody.agentEoa, signMessage: (m: { readonly message: { readonly raw: Uint8Array } }) => session.signMessage(m) };
    let rebindAnchor: { digest: `sha256:${string}`; transactionHash: `0x${string}`; validFrom: string } | undefined;
    if (unbound.size > 0) {
      const anchorDigest = ceremonyAnchorDigest({
        agentIri,
        ...(admissionAgent === undefined ? {} : { admissionAgent }),
        safeAddress: custody.safeAddress,
        keys: [...unbound.values()].map(({ role, keyId }) => ({ role, keyId })),
      });
      const locator = await anchorAndWait(anchorDigest, 'rebind');
      const replacements = await authorBindings({
        plan,
        signers: unbound,
        ceremonySigner,
        validFrom: locator.anchorTime,
        anchorDigest,
      });
      await rebindRoles({ catalogPath, replacements: [...replacements], anchor: anchorDeclaration(anchorDigest, locator) });
      rebindAnchor = { digest: anchorDigest, transactionHash: locator.transactionHash, validFrom: locator.anchorTime };
    }

    // The new keys are bound, so the config moves to them before anything is revoked: no step leaves
    // it naming a store whose bindings the catalog revokes, and a daemon restarted from here boots.
    const writeResult = writeNativeIdentityConfig({
      configPath,
      values: {
        agentIri,
        ...(admissionAgent === undefined ? {} : { admissionAgent }),
        identityStores: newStores,
        trustRootsPath: catalogPath,
        trustPolicyGenesisDigest: genesisPin as `sha256:${string}`,
      },
    });

    let revocation: { digest: `sha256:${string}`; transactionHash: `0x${string}`; effectiveTime: string } | undefined;
    if (revocationPlan !== undefined) {
      const locator = await anchorAndWait(revocationPlan.anchorDigest, 'revocation');
      await revokeBinding({
        catalogPath,
        voucher: ceremonySigner,
        targets: revocationPlan.targets,
        effectiveTime: locator.anchorTime,
        anchor: anchorDeclaration(revocationPlan.anchorDigest, locator),
      });
      revocation = { digest: revocationPlan.anchorDigest, transactionHash: locator.transactionHash, effectiveTime: locator.anchorTime };
    }

    writeRotationReceipt(dir, { ...receipt, completedAt: new Date().toISOString() });

    emitResult(
      {
        schemaVersion: 1,
        kind: 'ceremony_rotate_complete',
        executeAuthorized: true,
        sideEffects: true,
        dir,
        catalogPath,
        roleSets,
        resumed: resuming,
        retired: retiring.map(({ role, agent, keyId, bindingDigests }) => ({ role, agent, keyId, bindingDigests })),
        bindings: [...replacementSigners].map(([role, { keyId }]) => ({ role, agent: agentForRole(plan, role), keyId })),
        rebindAnchor: rebindAnchor ?? null,
        revocationAnchor: revocation ?? null,
        storesCreated,
        configWriteBack: writeResult,
        warnings: password.warnings,
        restartRequired: true,
        nextSteps: [
          `Copy ${catalogPath} to every other operator's trustRootsPath; the genesis digest did not move, so their configs need no edit.`,
          'Restart every daemon: assertFresh makes a changed catalog under a running daemon a hard refusal.',
        ],
      },
      (raw) => {
        const v = raw as { retired: { role: string; keyId: string }[]; bindings: { role: string; keyId: string }[] };
        return [
          'jinn ceremony rotate: COMPLETE',
          '',
          `catalog             ${catalogPath}`,
          ...(revocation === undefined ? [] : [`retired from        ${revocation.effectiveTime}`]),
          '',
          'retired',
          ...v.retired.map(({ role, keyId }) => `  ${role.padEnd(24)} ${keyId}`),
          '',
          'bound',
          ...v.bindings.map(({ role, keyId }) => `  ${role.padEnd(24)} ${keyId}`),
          '',
          'next',
          `  - Copy ${catalogPath} to every other operator's trustRootsPath.`,
          '  - Restart every daemon.',
        ].join('\n');
      },
      {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env.NO_COLOR),
      },
    );
  } finally {
    await session.close?.();
  }
}

// ── show ───────────────────────────────────────────────────────────────────────────────────────

async function runShow(ctx: CommandContext, parsed: Parsed, deps: CeremonyCommandDeps): Promise<void> {
  const dir = resolveDir(ctx, parsed);
  const configPath = parsed.values.config ?? join(dir, 'config.json');
  const config = readConfigObject(configPath);
  const catalogPath = parsed.values.catalog
    ?? (typeof config.trustRootsPath === 'string' ? config.trustRootsPath : join(dir, 'trust.json'));

  const file = loadCatalogFile(ctx, catalogPath);
  const newest = newestPolicy(file);
  const refreshBy = newest?.value.refreshBy;
  const daysRemaining = refreshBy === undefined
    ? null
    : Math.floor((new Date(refreshBy).getTime() - Date.now()) / 86_400_000);

  const bindingsByAgent: Record<string, { role?: string; keyId?: string; validFrom?: string; anchor?: string }[]> = {};
  for (const entry of file.bindings) {
    const envelope = entry.envelope;
    let agent = 'unknown';
    let detail: { role?: string; keyId?: string; validFrom?: string; anchor?: string } = {};
    if (typeof envelope === 'string') {
      try {
        const dsse = JSON.parse(Buffer.from(envelope, 'base64').toString('utf-8')) as { payload?: string };
        const binding = JSON.parse(Buffer.from(dsse.payload ?? '', 'base64').toString('utf-8')) as {
          agent?: string; key?: { didKey?: string }; scope?: string[]; validFrom?: string;
          anchors?: { digest?: string }[];
        };
        agent = binding.agent ?? 'unknown';
        detail = {
          ...(binding.scope === undefined ? {} : { role: binding.scope.join('+') }),
          ...(binding.key?.didKey === undefined ? {} : { keyId: binding.key.didKey }),
          ...(binding.validFrom === undefined ? {} : { validFrom: binding.validFrom }),
          ...(binding.anchors?.[0]?.digest === undefined ? {} : { anchor: binding.anchors[0].digest }),
        };
      } catch {
        detail = {};
      }
    }
    (bindingsByAgent[agent] ??= []).push(detail);
  }

  const anchors: { digest: string; status: string; anchorTime?: string }[] = [];
  for (const anchor of file.anchors) {
    if (deps.readAnchorStatus === undefined) {
      anchors.push({ digest: anchor.digest, status: 'unknown' });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- bounded by the catalog's anchor count.
      const observed = await deps.readAnchorStatus({
        digest: anchor.digest,
        locator: anchor.locator,
        ...(parsed.values['rpc-url'] === undefined ? {} : { rpcUrl: parsed.values['rpc-url'] }),
      });
      anchors.push({
        digest: anchor.digest,
        status: observed === null ? 'not-found' : observed.finalized ? 'finalized' : 'pending',
        ...(observed?.anchorTime === undefined ? {} : { anchorTime: observed.anchorTime }),
      });
    } catch (cause) {
      anchors.push({ digest: anchor.digest, status: `unreadable: ${cause instanceof Error ? cause.message : String(cause)}` });
    }
  }

  const wiring = {
    configPath,
    agentIri: config.agentIri ?? null,
    admissionAgent: config.admissionAgent ?? null,
    identityStores: config.identityStores ?? null,
    trustRootsPath: config.trustRootsPath ?? null,
    trustPolicyGenesisDigest: config.trustPolicyGenesisDigest ?? null,
    compositionMode: config.compositionMode ?? null,
    genesisPinMatchesCatalog: config.trustPolicyGenesisDigest === file.policyGenesisDigest,
  };
  const missing: string[] = [];
  for (const key of ['agentIri', 'identityStores', 'trustRootsPath', 'trustPolicyGenesisDigest'] as const) {
    if (config[key] === undefined) missing.push(key);
  }
  if (config.ipfs === undefined) missing.push('ipfs.apiUrl');
  if (config.publicBaseUrl === undefined) missing.push('publicBaseUrl');
  if (!Array.isArray(config.recordSources) || config.recordSources.length === 0) missing.push('recordSources');
  if (config.compositionMode !== 'native') missing.push('compositionMode: "native"');

  let stores: { role: string; keyId: string }[] | undefined;
  const storeFlag = parsed.values.store;
  if (storeFlag !== undefined) {
    const password = ctx.env.JINN_PASSWORD;
    if (typeof password !== 'string' || password.length === 0) {
      return invalid(ctx, 'ceremony show --store requires JINN_PASSWORD');
    }
    // A store declares the exact owned-role set it was minted for and refuses to open under any
    // other, so listing needs the family named — it cannot be inferred from the file.
    const family = parsed.values['role-sets'];
    if (family === undefined || !Object.hasOwn(ROLE_SETS, family)) {
      return invalid(
        ctx,
        'ceremony show --store requires --role-sets <one of requester|admission|solver|evaluator>',
        'An identity store opens only under the exact role set it was minted for.',
      );
    }
    const { listRoleIdentityKeyIds } = await import('../../daemon/role-identities.js');
    try {
      const listing = await listRoleIdentityKeyIds({
        storePath: storeFlag,
        password,
        ownedRoles: orderedRolesForSet(family as RoleSetName),
        create: false,
      });
      stores = [...listing.identities];
    } catch (cause) {
      return invalid(ctx, `identity store at ${storeFlag} could not be listed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  emitResult(
    {
      schemaVersion: 1,
      kind: 'ceremony_show',
      catalogPath,
      policyGenesisDigest: file.policyGenesisDigest,
      newestPolicyVersion: newest?.value.version ?? null,
      refreshBy: refreshBy ?? null,
      refreshByDaysRemaining: daysRemaining,
      purposes: newest === undefined
        ? {}
        : Object.fromEntries(Object.entries(newest.value.purposes).map(([purpose, entry]) => [
          purpose,
          { accepted: entry.accepted, requiredStrength: entry.requiredStrength },
        ])),
      bindingsByAgent,
      anchors,
      revocations: file.revocations.length,
      wiring,
      missing,
      ...(stores === undefined ? {} : { stores }),
    },
    (value) => {
      const v = value as {
        policyGenesisDigest: string; newestPolicyVersion: number | null; refreshBy: string | null;
        refreshByDaysRemaining: number | null;
        purposes: Record<string, { accepted: string[] }>;
        bindingsByAgent: Record<string, { role?: string; keyId?: string }[]>;
        anchors: { digest: string; status: string }[];
        missing: string[];
      };
      return [
        `catalog             ${catalogPath}`,
        `genesis             ${v.policyGenesisDigest}`,
        `newest policy       v${v.newestPolicyVersion ?? '?'}`,
        `refreshBy           ${v.refreshBy ?? '?'} (${v.refreshByDaysRemaining ?? '?'} days remaining)`,
        '',
        'purposes',
        ...Object.entries(v.purposes).map(([purpose, entry]) => `  ${purpose.padEnd(28)} ${entry.accepted.join(', ')}`),
        '',
        'bindings',
        ...Object.entries(v.bindingsByAgent).flatMap(([agent, entries]) => [
          `  ${agent}`,
          ...entries.map((entry) => `    ${(entry.role ?? '?').padEnd(24)} ${entry.keyId ?? '?'}`),
        ]),
        '',
        'anchors',
        ...v.anchors.map((anchor) => `  ${anchor.digest}  ${anchor.status}`),
        '',
        ...(v.missing.length === 0
          ? ['config is complete for a native boot']
          : ['not yet configured', ...v.missing.map((key) => `  ${key}`)]),
      ].join('\n');
    },
    {
      json: Boolean(parsed.values.json),
      human: Boolean(parsed.values.human),
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env.NO_COLOR),
    },
  );
}

// ── module ─────────────────────────────────────────────────────────────────────────────────────

export function createCeremonyCommand(deps?: CeremonyCommandDeps): CommandModule {
  return {
    name: 'ceremony',
    summary: 'Provision native trust artifacts: role custody, on-chain anchor, and the shared trust catalog',
    helpText: `Usage:
  jinn ceremony init --dir <operator home> --role-sets <families> --authority-store <path> [--execute]
  jinn ceremony join --dir <operator home> --role-sets <families> --catalog <path> --genesis <digest> --authority-store <path> [--execute]
  jinn ceremony rotate --dir <operator home> --role-sets <families> [--catalog <path>] [--execute]
  jinn ceremony show [--catalog <path>] [--store <path>]

Status:
  \`init\` provisions the FIRST operator and the shared catalog genesis; \`join\` adds operator N+1 to
  an existing catalog via a hash-linked policy successor, leaving the genesis digest — and therefore
  every existing operator's config — untouched. Both are READ-ONLY by default and print a full plan;
  \`--execute\` is what mints custody, spends gas on the anchor, and writes files.

  Both verbs enforce the ceremony sequencing law: the anchor is submitted FIRST and its block time
  becomes every binding's validFrom verbatim; the command then WAITS for the anchor to read back
  finalized (Base Sepolia trails head by roughly 10-20 minutes) before authoring anything, because
  the catalog opener accepts only finalized anchors.

  A rewritten catalog requires a DAEMON RESTART. That is by design: the runtime refuses to authorize
  work over a catalog file that changed underneath it.

  RESUMABLE. The instant the anchor transaction exists, a receipt is written to
  <dir>/ceremony/receipt.json carrying the Agent IRIs and the full anchor locator. A run interrupted
  during the finality wait — the only long window in the ceremony — is re-run with the same command:
  it REUSES that anchor and those IRIs rather than minting a second identity and spending gas twice.
  After the catalog is sealed, a re-run refuses instead, and names the config keys still outstanding.

  RE-AUTHORING. To seal a catalog again over the same directory, move it aside and run init with
  --previous-catalog <where it went>. Every revocation it holds is carried into the new catalog
  verbatim, with the binding each names and the anchors both reference, so a retired key stays
  retired. Without the flag, init refuses once its receipt shows it sealed a catalog at --catalog or
  <dir>/ceremony/rotation.json exists. With it, init refuses (retired-key-bound), before any anchor,
  to bind a key a carried revocation retired, whatever Agent IRI it would bind the key to. join
  refuses the same way, before any anchor, to bind a key a revocation in its --catalog retired. So a
  family \`rotate\` replaced is still refused once the records STORES names are gone and the config
  names no other store for it, also when neither the config nor the run receipt supplies the
  operator's agentIri and admissionAgent and init or join mints new Agent IRIs.

  STORES. init and join bind the role stores at <dir>/identity/<family>.enc.json, never the stores
  identityStores names, and after \`rotate\` those hold the keys it retired. So both refuse
  (rotated-family), before their plan and before any store is opened, a family that any rotation in
  <dir> replaced or is replacing, earlier rotations included, whatever --config names. They read
  three records. A store rotate minted for the family, which every rotation leaves at
  <dir>/identity/<family>.rotated-<stamp>.enc.json beside the original (a store of that name the
  config names counts too, wherever it now sits). <dir>/ceremony/rotation.json, which records the
  latest rotation, finished or not. And the revocations a finished rotation leaves in the catalog:
  the run receipt, <dir>/ceremony/receipt.json, names every anchor under which init or join bound
  the keys in <dir>/identity, a later run's and the earlier ones it carries forward, with the
  catalog each bound them in, and a revocation there, in join's --catalog or in init's
  --previous-catalog, of a binding under one of those anchors for a role only one family holds
  shows that family rotated, wherever its rotated store now sits and whatever it is called. No store
  is opened to read them. A rotation.json that cannot be read is refused too
  (rotation-receipt-unreadable), rather than taken for no rotation. A rotated family cannot be
  re-authored by init or added to another catalog by join. When no record shows a rotation of a
  family but identityStores names another store for it, both refuse as well (store-elsewhere),
  since they would replace a store they did not provision.

  \`rotate\` retires every key of the named role families for an operator init or join already
  provisioned, for instance after a key leaks. A family's keys share one store, so the family is the
  unit: rotate mints a new store, binds its keys under a fresh anchor, points identityStores at the
  new store, then revokes the retiring bindings under a second fresh anchor, signed by the agent EOA
  that vouched for them. The replacement binding comes first because it draws its authority from the
  binding it replaces, and the config never names a store whose bindings are revoked. The retired
  keys stop verifying from the revocation anchor's block time; what they signed before it still
  verifies. No catalog authority is needed: the trust policy names Agent IRIs, and a rotation keeps
  them. An interrupted rotate is re-run with the same command: <dir>/ceremony/rotation.json names
  the stores it minted and retires and each anchor it submitted, so the re-run waits on that anchor
  rather than sending a second one, and the catalog shows which half landed. Each act takes its
  block time from the finality read, not from the receipt. Rotation cannot help when the agent EOA
  itself is compromised: that account is the voucher, so a binding under a new EOA needs consent,
  which rotate does not author.

  A new rotation without --retiring-store (below) mints each new store at
  <dir>/identity/<family>.rotated-<stamp>.enc.json, <stamp> being the UTC second the run started.
  It refuses (new-store-exists), before anything is minted or anchored and in the plan as well, when
  a file is already at that path, as when a rotation started in the same second as the last one
  would name the store it is about to retire: re-run once the clock has passed that second. A new
  rotation never skips a family: it opens the store it retires and refuses unless the catalog binds
  each key there, so it never completes with nothing retired.

  Keep rotation.json where rotate wrote it: once identityStores names the new store, it is the only
  record of the store being retired. rotate refuses a rotation.json it cannot read
  (rotation-receipt-unreadable), and refuses to start a new rotation while the catalog binds,
  unrevoked under the agent EOA, another key for one of its roles that no configured store holds
  (another-key-bound), which is what a lost receipt leaves. If a recorded anchor never reads back
  finalized (a transaction dropped after it mined), each re-run waits on it until the finality
  timeout: re-run with --resubmit-anchor, which sends a fresh anchor for the act being resumed and
  records it in place of the old one, leaving the rest of the receipt as it was.

  If rotation.json is lost for good after identityStores was repointed, finish that rotation from the
  store it was retiring, which rotate leaves where it was (<dir>/identity/<family>.enc.json for a
  store init or join minted): re-run with its --role-sets and --retiring-store <family>=<path> for
  each of its families. That run mints no store, since the store identityStores names is the new one.
  Before anything is anchored it refuses (retiring-store-mismatch) unless the catalog binds the keys
  of the store identityStores names, unrevoked, each one after the named store's key for the same
  role, so it never revokes the keys the lost rotation bound; and it refuses (another-key-bound)
  while another key for those roles is bound that neither the named stores nor the configured ones
  hold. It then sends a fresh revocation anchor and revokes the named stores' keys.

Options (init, join, and rotate; rotate takes no --authority-store or --genesis):
  --dir <path>               Operator home (default ~/.jinn-client). The keystore, identity stores,
                             and config.json are resolved beneath it.
  --config <path>            Config file to write back to (default <dir>/config.json)
  --role-sets <list>         Comma-separated families: requester, admission, solver, evaluator.
                             \`requester\` is mandatory — every native boot opens requester custody.
  --authority-store <path>   The DEDICATED catalog-authority keypair, held by the deploy coordinator.
                             Never an operator role key: policy-update capability must survive any
                             operator's key rotation.
  --catalog <path>           Trust catalog path (default <dir>/trust.json; required for join)
  --previous-catalog <path>  init only: the catalog a re-author replaces (see RE-AUTHORING above)
  --genesis <digest>         join only: the sha256 genesis digest init printed. The pin is what makes
                             a join a join rather than an unnoticed fork onto a different catalog.
  --rpc-url <url>            Base Sepolia RPC (defaults to the configured chain)
  --anchor-target <address>  Address the anchor calldata is sent to (default: this operator's own EOA)
  --service-index <n>        Which earning service supplies the EOA and Safe (default: the primary)
  --finality-timeout-ms <n>  How long to wait for the finalized tag (default 2700000, i.e. 45 min)
  --resubmit-anchor          rotate only: send a fresh anchor for the act an unfinished rotation
                             resumes, in place of a recorded one that never reads back finalized
  --retiring-store <family>=<path>
                             rotate only, once for each --role-sets family: the store a rotation
                             whose rotation.json was lost after the repoint was retiring
  --execute                  Perform the ceremony. Without it, nothing is minted, sent, or written.
  --dry-run                  Force the read-only plan. Refuses if combined with --execute.
  --human                    Human-readable output, including the anchor and finality progress lines.
  JINN_PASSWORD              Required unless a keystore-password file exists (primary
                             <dir>/earning/keystore-password, or the host-wide default-state
                             fallback). The ceremony must run with the password the daemon
                             will later resolve, or it mints custody the daemon cannot decrypt.

Options (show):
  --catalog <path>           Catalog to inspect (default: the config's trustRootsPath)
  --store <path>             Additionally list an identity store's role -> did:key ids (needs JINN_PASSWORD)

Config write-back:
  init and join write exactly five keys onto config.json: agentIri, admissionAgent (only when the
  admission family was provisioned), identityStores, trustRootsPath, trustPolicyGenesisDigest.
  ipfs.apiUrl, publicBaseUrl and recordSources stay operator-authored deploy-config — the ceremony
  cannot know them and reports them as outstanding. compositionMode is never written: the flip stays
  the deploy PR's one switch.

Examples:
  jinn ceremony init --dir ~/.jinn-client --role-sets requester,admission,solver,evaluator --authority-store ~/.jinn-ceremony/authority.enc.json
  JINN_PASSWORD=... jinn ceremony init --dir ~/.jinn-client --role-sets requester,admission,solver,evaluator --authority-store ~/.jinn-ceremony/authority.enc.json --execute
  JINN_PASSWORD=... jinn ceremony join --dir ~/.jinn-client-op-b --role-sets requester,solver --catalog ~/.jinn-client/trust.json --genesis sha256:<printed by init> --authority-store ~/.jinn-ceremony/authority.enc.json --execute
  JINN_PASSWORD=... jinn ceremony rotate --dir ~/.jinn-client --role-sets solver --execute
  jinn ceremony show --catalog ~/.jinn-client/trust.json
`,
    async run(ctx: CommandContext): Promise<void> {
      try {
        let parsed: Parsed;
        try {
          parsed = parseArgs({ args: ctx.argv, options: OPTIONS, allowPositionals: true }) as Parsed;
        } catch (error) {
          return invalid(ctx, error instanceof Error ? error.message : String(error));
        }
        const verb = parsed.positionals[0];
        if (parsed.positionals.length !== 1
          || (verb !== 'init' && verb !== 'join' && verb !== 'rotate' && verb !== 'show')) {
          return invalid(ctx, 'ceremony requires the `init`, `join`, `rotate`, or `show` subcommand');
        }
        if (deps === undefined) {
          return emitEnvelope({
            code: 'bootstrap_incomplete',
            message: 'The ceremony verb is feature-disabled in this build.',
            hint: 'Native identity provisioning is not available here.',
            exampleCli: EXAMPLE_CLI,
            details: { feature: 'ceremony', state: 'feature-disabled' },
          }, { writer: ctx.writer, exit: ctx.exit });
        }
        if (verb === 'show') return await runShow(ctx, parsed, deps);
        if (verb === 'init') return await runInit(ctx, parsed, deps);
        if (verb === 'rotate') return await runRotate(ctx, parsed, deps);
        return await runJoin(ctx, parsed, deps);
      } catch (cause) {
        // The envelope and the exit code were already emitted at the refusal site; this only stops
        // the unwind from being reported a second time as a `fatal`.
        if (cause instanceof CeremonyRefusal) return;
        throw cause;
      }
    },
  };
}

const productionDeps: CeremonyCommandDeps = {
  async readChainCustody(input) {
    const { readCeremonyChainCustody } = await import('../../earning/ceremony-custody.js');
    return readCeremonyChainCustody(input);
  },
  async verifySafeOwnership(input) {
    const { verifyCeremonySafeOwnership } = await import('../../earning/ceremony-custody.js');
    return verifyCeremonySafeOwnership(input);
  },
  async openAnchorSession(input) {
    const { openCeremonyAnchorSession } = await import('../../earning/ceremony-custody.js');
    return openCeremonyAnchorSession(input);
  },
  async readAnchorStatus(input) {
    const { readCeremonyAnchorStatus } = await import('../../earning/ceremony-custody.js');
    return readCeremonyAnchorStatus(input);
  },
};

export default createCeremonyCommand(productionDeps);
