/**
 * `jinn ceremony init | join | show` — the operator-facing production path that CREATES the trust
 * artifacts the native fleet daemon verifies (spec/2026-08-07-native-identity-ceremony.md §4).
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
import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

import {
  anchorDeclaration,
  appendOperator,
  authorCatalog,
  authorRoleBinding,
  completePolicyPurposes,
  isSettlementRole,
  openCatalogAuthority,
  openRoleSigners,
  performEoaCeremony,
  type AnchorLocator,
  type CatalogAuthoritySigner,
  type FinalizedAnchorObservation,
  type NativeRoleIdentityRole,
  type RoleSigner,
  type SealedBindingEntry,
} from '@jinn-network/trust-authoring';
import { recordDigest, validateTrustPolicy, type TrustPolicy } from '@jinn-network/trust-core';

import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { emitResult } from '../output.js';
import {
  planNativeIdentityWriteBack,
  writeNativeIdentityConfig,
  type NativeIdentityStorePaths,
} from '../../config/write-native-identity.js';
import { ROLE_SETS, orderedRolesForSet, type RoleSetName } from './native-requester.js';
import { resolveDefaultStateDir } from '../../state-dir.js';

const OPTIONS = {
  ...COMMON_FLAGS,
  dir: { type: 'string' as const },
  'role-sets': { type: 'string' as const },
  'authority-store': { type: 'string' as const },
  'rpc-url': { type: 'string' as const },
  'anchor-target': { type: 'string' as const },
  'service-index': { type: 'string' as const },
  catalog: { type: 'string' as const },
  genesis: { type: 'string' as const },
  store: { type: 'string' as const },
  'finality-timeout-ms': { type: 'string' as const },
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

function parseRoleSets(ctx: CommandContext, raw: string | undefined): readonly RoleSetName[] {
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
  if (!names.includes('requester')) {
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

function writeReceipt(dir: string, receipt: CeremonyReceipt): void {
  const path = receiptPath(dir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
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
 *
 * The shape is re-validated rather than trusted: the receipt is an operator-writable file, and a
 * malformed locator would otherwise reach `anchorDeclaration` as a sealed catalog anchor.
 */
function reusableAnchor(
  receipt: CeremonyReceipt | undefined,
  anchorDigest: `sha256:${string}`,
): AnchorLocator | undefined {
  if (receipt?.anchorDigest !== anchorDigest) return undefined;
  const locator = receipt.anchorLocator;
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
 * The daemon resolves `JINN_PASSWORD` first and falls back to a keystore-password file whose path
 * is HARD-CODED to `~/.jinn-client/keystore-password` (`main.ts:178,198`) — it does not follow
 * `--dir`. So an operator homed anywhere else (§4.4's operator B at `~/.jinn-client-op-b`) can
 * never use the fallback and must supply the env var at ceremony time AND at every daemon start.
 */
export function resolveCeremonyPassword(input: {
  readonly dir: string;
  readonly env: NodeJS.ProcessEnv;
}): CeremonyPasswordResolution | { readonly refusal: string; readonly hint: string } {
  const home = input.env.HOME ?? homedir();
  const defaultDir = resolveDefaultStateDir({ home, env: input.env });
  const fallbackPath = join(defaultDir, 'keystore-password');
  const isDefaultDir = input.dir === defaultDir;
  const fallback = existsSync(fallbackPath)
    ? readFileSync(fallbackPath, 'utf-8').trim()
    : undefined;

  const envPassword = input.env.JINN_PASSWORD;
  if (typeof envPassword === 'string' && envPassword.length > 0) {
    const warnings: string[] = [];
    if (!isDefaultDir) {
      warnings.push(
        `The keystore-password file fallback is hard-coded to ${fallbackPath} and does NOT follow --dir, `
          + `so the daemon for ${input.dir} can only ever resolve JINN_PASSWORD. Set it on every daemon start.`,
      );
    } else if (fallback !== undefined && fallback !== envPassword) {
      // The daemon prefers env, so this only bites the day someone starts it without the var —
      // at which point it resolves a DIFFERENT password and refuses to open this custody.
      warnings.push(
        `JINN_PASSWORD differs from the password stored at ${fallbackPath}. The daemon prefers the env var, `
          + 'so any start without it will resolve the file value and fail to open this custody.',
      );
    }
    return { password: envPassword, source: 'env', warnings };
  }

  if (!isDefaultDir) {
    return {
      refusal: `JINN_PASSWORD is required for an operator homed at ${input.dir}.`,
      hint: `The daemon's keystore-password fallback is hard-coded to ${fallbackPath} and does not follow --dir, `
        + 'so a non-default operator directory has no fallback. Export JINN_PASSWORD for the ceremony and for '
        + 'every daemon start.',
    };
  }
  if (fallback !== undefined && fallback.length > 0) {
    // This IS what the daemon will resolve for the default directory, so using it is correct.
    return { password: fallback, source: 'keystore-file', warnings: [] };
  }
  return {
    refusal: `No password is resolvable: JINN_PASSWORD is unset and ${fallbackPath} does not exist.`,
    hint: 'The daemon auto-generates and persists a password on its first start, which would not match custody '
      + 'minted now. Either export JINN_PASSWORD, or start the daemon once so the file exists, then re-run.',
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
  plan: ProvisionPlan,
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

/** Which Agent IRI owns a given role: admission is its own authority, everything else is the operator. */
function agentForRole(plan: ProvisionPlan, role: NativeRoleIdentityRole): string {
  return role === 'admission' ? plan.admissionAgent ?? plan.agentIri : plan.agentIri;
}

async function authorBindings(input: {
  readonly plan: ProvisionPlan;
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
        warnings: string[]; nextSteps: string[];
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
        passwordSource: password.source,
        warnings: password.warnings,
        configWriteBack: writeBackPlan,
        restartRequired: true,
      },
      (value) => humanPlan(plan, 'init', [
        `password source     ${(value as { passwordSource: string }).passwordSource}`,
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

  const { signers, authority, created } = await mintCustody({ plan, password: password.password });

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

    const { policyGenesisDigest } = await authorCatalog({
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

Options (init and join):
  --dir <path>               Operator home (default ~/.jinn-client). The keystore, identity stores,
                             and config.json are resolved beneath it.
  --config <path>            Config file to write back to (default <dir>/config.json)
  --role-sets <list>         Comma-separated families: requester, admission, solver, evaluator.
                             \`requester\` is mandatory — every native boot opens requester custody.
  --authority-store <path>   The DEDICATED catalog-authority keypair, held by the deploy coordinator.
                             Never an operator role key: policy-update capability must survive any
                             operator's key rotation.
  --catalog <path>           Trust catalog path (default <dir>/trust.json; required for join)
  --genesis <digest>         join only: the sha256 genesis digest init printed. The pin is what makes
                             a join a join rather than an unnoticed fork onto a different catalog.
  --rpc-url <url>            Base Sepolia RPC (defaults to the configured chain)
  --anchor-target <address>  Address the anchor calldata is sent to (default: this operator's own EOA)
  --service-index <n>        Which earning service supplies the EOA and Safe (default: the primary)
  --finality-timeout-ms <n>  How long to wait for the finalized tag (default 2700000, i.e. 45 min)
  --execute                  Perform the ceremony. Without it, nothing is minted, sent, or written.
  --dry-run                  Force the read-only plan. Refuses if combined with --execute.
  --human                    Human-readable output, including the anchor and finality progress lines.
  JINN_PASSWORD              Required unless --dir is the default home AND its keystore-password file
                             exists. The ceremony must run with the password the daemon will later
                             resolve, or it mints custody the daemon cannot decrypt.

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
        if (parsed.positionals.length !== 1 || (verb !== 'init' && verb !== 'join' && verb !== 'show')) {
          return invalid(ctx, 'ceremony requires the `init`, `join`, or `show` subcommand');
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
