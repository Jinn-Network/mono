// SPDX-License-Identifier: Apache-2.0
/**
 * The corpus composition root (C7 host adapter layer).
 *
 * `BinIo` has carried optional corpus ports since C5, and nothing in this
 * repository supplied them: `hasCorpusPorts` was always false, the corpus
 * capability was never constructed, and the `verified` chain-verification
 * posture — the default — could not be reached from any process entry point.
 * This module is what makes that posture live, for both entry points.
 *
 * Everything the runtime library refuses to do on custody grounds happens
 * here and only here: naming a network primitive, reading the trust-policy
 * directory off the disk, deciding a curve, and turning an operator's
 * file-declared signing keys into resolvable authority.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  AgentKeyCatalog,
  AgentKeyCatalogEntry,
  RawSignatureVerifier,
  Transport,
  VerifyDriver,
} from "@jinn-network/record-discovery-client";
import { createTrustAdapter, createVerifyDriver } from "@jinn-network/record-discovery-client";
import { DISCOVERY_SIGNING_SCOPE } from "@jinn-network/record-discovery-protocol";
import { createHttpTransport, type FetchLike } from "@jinn-network/record-discovery-transport-http";
import type {
  BindingResolver,
  BindingResolverQuery,
  DsseChainVerifier,
  KeyBinding,
  ResolvedBinding,
} from "@jinn-network/trust-core";

import { createNodeCorpusFilesystem } from "./bin-node-fs.js";
import { resolveRuntimeConfig, type MirrorSourceSigningKey, type RuntimeConfig } from "./config.js";
import type { CorpusFilesystem } from "./corpus/fs.js";
import { createFileHighWaterMarkStore } from "./corpus/high-water-mark.js";
import { createDidKeyDsseVerifier, decodeEd25519DidKey, verifyEd25519 } from "./session-host-crypto.js";

/**
 * Every URL the mirror hands the transport is absolute — `servingRoot` plus a
 * protocol path, or the configured `archiveRootUrl` — so the base is never
 * consulted. It is a reserved-by-RFC-2606 name rather than a plausible host so
 * that a future relative URL fails to resolve loudly instead of silently
 * reaching somewhere real.
 */
const UNUSED_TRANSPORT_BASE = "https://corpus-base.invalid";

export interface LocalCorpusPortsOptions {
  readonly config: RuntimeConfig;
  /** Injectable so tests drive a loopback archive; defaults to the platform fetch. */
  readonly fetchLike?: FetchLike;
  readonly now?: () => Date;
}

/** Exactly the corpus fields of `BinIo`, so a caller spreads this whole object into it. */
export interface LocalCorpusPorts {
  readonly corpusTransport: Transport;
  readonly corpusFs: CorpusFilesystem;
  readonly dsseVerifier: DsseChainVerifier;
  readonly readPolicyVersions: (directory: string) => Promise<readonly Uint8Array[]>;
  readonly corpusVerifyDriver: VerifyDriver;
}

/**
 * The trust-policy version chain, in name order.
 *
 * Ordering is by file name because the chain's order IS its version order and
 * a directory listing has none of its own. A missing directory REJECTS rather
 * than reading as an empty chain: the capability renders that as
 * `corpus-trust-policy` red with no remedy, whereas an empty chain admits
 * nobody while reporting a successfully loaded policy.
 */
async function readPolicyVersions(directory: string): Promise<readonly Uint8Array[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const versions: Uint8Array[] = [];
  for (const name of files) {
    versions.push(new Uint8Array(await readFile(join(directory, name))));
  }
  return versions;
}

/**
 * The `(agent, keyid)` pairs the operator has declared in the config file.
 *
 * Authority is per agent rather than per source because that is the question
 * `KeyResolver.resolve(agent, at)` asks — an agent that publishes two archives
 * signs both with the same working keys.
 */
function declaredSigningKeys(
  config: RuntimeConfig,
): ReadonlyMap<string, readonly MirrorSourceSigningKey[]> {
  const byAgent = new Map<string, MirrorSourceSigningKey[]>();
  for (const source of config.corpus.sources) {
    const declared = byAgent.get(source.agent) ?? [];
    for (const key of source.signingKeys) {
      if (!declared.some((existing) => existing.keyid === key.keyid)) declared.push(key);
    }
    byAgent.set(source.agent, declared);
  }
  return byAgent;
}

/**
 * Turns a declared `(agent, did:key, validFrom)` triple into the binding
 * `createTrustAdapter` resolves against.
 *
 * The adapter reads a resolved binding's SCOPE, KEY and EFFECTIVE START and
 * nothing else — `isActiveForDiscoverySigning` in `trust-adapter.ts` records
 * that narrowing and why. The remaining §7.1 fields below therefore describe
 * the config declaration itself and carry no independent proof: this
 * composition resolves NO key-binding records and performs no ceremony or
 * consent-chain check. Do not feed these bindings to trust-core's full §7.5
 * procedure; a composition that wants that must resolve real binding records.
 */
function declaredBinding(agent: string, key: MirrorSourceSigningKey): ResolvedBinding {
  // `strength` is derived from the ceremony type rather than asserted
  // (`deriveStrength`), so this pair is internally consistent — but it is a
  // consistent description of a ceremony that did not happen. Nothing keeps
  // `verify.ts`'s `requiredStrength` gate from reading it as a satisfied
  // strong requirement, which is the sharpest form of the warning above: these
  // bindings are for `isActiveForDiscoverySigning` and nothing else.
  const binding: KeyBinding = {
    protocol: "https://spec.jinn.network/trust/key-binding/v1",
    agent,
    key: {
      publicKey: key.keyid,
      keyid: key.keyid,
      algorithm: "ed25519",
      didKey: key.keyid,
    },
    voucher: { kind: "account", did: "did:pkh:eip155:1:0x0", contractAccount: false },
    relationship: "signs-for",
    scope: [DISCOVERY_SIGNING_SCOPE],
    validFrom: key.validFrom,
    ceremony: { type: "eoa", digest: `sha256:${"0".repeat(64)}` },
    strength: "strong",
    anchors: [],
  };
  return {
    binding,
    envelopeBytes: new Uint8Array(),
    bindingDigest: `sha256:${"0".repeat(64)}`,
    effectiveStart: key.validFrom,
    isGenesis: true,
    // A config file expresses authority by ADDING a key, and withdraws it by
    // removing one. There is no revocation record to resolve here, and an
    // empty list is the honest answer rather than a claim that none exists.
    revocations: [],
  };
}

function createDeclaredKeyCatalog(
  byAgent: ReadonlyMap<string, readonly MirrorSourceSigningKey[]>,
): AgentKeyCatalog {
  return {
    async candidateKeys(agent: string): Promise<AgentKeyCatalogEntry[]> {
      // `probeAt` is the key's own `validFrom`, which is by construction inside
      // its validity window — the point-in-time probe `everBound` needs so a
      // rotated-out key still corroborates the entries it signed.
      return (byAgent.get(agent) ?? []).map((key) => ({
        keyid: key.keyid,
        probeAt: key.validFrom,
      }));
    },
  };
}

function createDeclaredBindingResolver(
  byAgent: ReadonlyMap<string, readonly MirrorSourceSigningKey[]>,
): BindingResolver {
  return {
    async resolveBinding(query: BindingResolverQuery, atTime: string): Promise<ResolvedBinding | null> {
      const key = (byAgent.get(query.agent) ?? []).find((candidate) => candidate.keyid === query.key);
      if (key === undefined) return null;
      if (key.validFrom > atTime) return null;
      // A did:key that does not decode to an Ed25519 key can never verify a
      // signature, so resolving it would only defer the same refusal.
      if (decodeEd25519DidKey(key.keyid) === undefined) return null;
      return declaredBinding(query.agent, key);
    },
  };
}

/** Real Ed25519 over the DSSE pre-auth encoding, keyed off the self-describing did:key. */
const declaredSignatureVerifier: RawSignatureVerifier = {
  async verify(pae, sig, key) {
    return verifyEd25519(pae, sig, key.keyid);
  },
};

function createDeclaredVerifyDriver(
  config: RuntimeConfig,
  fs: CorpusFilesystem,
  now: () => Date,
): VerifyDriver {
  const byAgent = declaredSigningKeys(config);
  return createVerifyDriver({
    trust: createTrustAdapter({
      bindingResolver: createDeclaredBindingResolver(byAgent),
      keyCatalog: createDeclaredKeyCatalog(byAgent),
      verifier: declaredSignatureVerifier,
    }),
    // Deliberately the mirror's own state FILE, which is what the two
    // actually share: `verifySourceChain` reads and advances the same mark the
    // mirror reads to decide `firstAdoption` and where `returningSync` resumes
    // from. The capability builds its own store object over this same path
    // (`capability.ts`, `get mirror()`), so the file is the shared position and
    // the store objects are interchangeable views of it — which holds only
    // because `createFileHighWaterMarkStore` memoizes nothing. A separate
    // PATH would leave the two disagreeing from the second sync onward, and
    // the linkage walk would refuse a sound chain.
    hwm: createFileHighWaterMarkStore({ filePath: config.mirrorStatePath, fs }),
    // Item-grade ports, fail-closed. This composition offers CHAIN
    // verification only: the mirror calls `verifySource` and nothing else, so
    // `verifyForDecision` / `verifyForFilter` are off its path entirely.
    // Stubs that admit nothing are honest about that; fakes that returned
    // plausible facts would not be. The fetchers answer with empty bytes
    // rather than throwing (the same shape `client`'s own driver tests use):
    // empty bytes never re-hash to a requested digest, so an item check
    // refuses, while a throw would escape a path nothing here is on.
    factsProfiles: { get: () => undefined },
    factsRecompute: { get: () => undefined },
    records: { "fetch": async () => new Uint8Array() },
    entries: { "fetch": async () => new Uint8Array() },
    now,
  });
}

export function createLocalCorpusPorts(options: LocalCorpusPortsOptions): LocalCorpusPorts {
  const now = options.now ?? (() => new Date());
  const fs = createNodeCorpusFilesystem();
  return Object.freeze({
    corpusTransport: createHttpTransport(UNUSED_TRANSPORT_BASE, options.fetchLike),
    corpusFs: fs,
    dsseVerifier: createDidKeyDsseVerifier(),
    readPolicyVersions,
    corpusVerifyDriver: createDeclaredVerifyDriver(options.config, fs, now),
  });
}

/**
 * The one call each process entry point makes.
 *
 * Configuration failure yields NO fields rather than throwing: `main` resolves
 * the same configuration and owns the `configuration failed` message and exit
 * code, and an entry point that threw here would replace that with an
 * unhandled rejection before the runtime ever started.
 */
export function resolveCorpusBinIoFields(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}): LocalCorpusPorts | Record<string, never> {
  let config: RuntimeConfig;
  try {
    config = resolveRuntimeConfig({ env: options.env, homeDirectory: options.homeDirectory });
  } catch {
    return {};
  }
  return createLocalCorpusPorts({ config });
}
