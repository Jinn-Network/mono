import type { BindingResolver } from "@jinn-network/trust-core";
import { DISCOVERY_SIGNING_SCOPE } from "@jinn-network/record-discovery-protocol";
import type { FreshnessPolicy, KeyResolver, ResolvedKey, SignatureVerifier } from "@jinn-network/record-discovery-protocol";

// Verification driver, trust-adapter half (design §10.1/§10.3, program
// §7.5/finding F5): implements protocol's KeyResolver/SignatureVerifier/
// FreshnessPolicy ports on top of trust-core's key-binding resolution.
//
// trust-core resolves ONE (key, agent) pair at a time
// (`BindingResolver.resolveBinding`, §7.5 step 2 -- "never by key alone");
// it does not enumerate every key ever bound to an agent. Discovery's
// `KeyResolver.resolve(agent, at)` needs exactly that enumeration before it
// can ask trust-core to resolve+validate each candidate, so this adapter
// takes a second injected port, `AgentKeyCatalog`, supplying the did:key
// candidates a host knows of for an agent (e.g. backed by a local
// key-binding announcement cache). This is the concrete adaptation finding
// F5 named: trust-core's frozen surface is per-key, discovery's port is
// per-agent, and the seam between them is a host-supplied enumeration.
//
// Likewise, trust-core keeps raw cryptographic signature checking behind
// its own injected port (`DsseChainVerifier`/`WitnessVerifier` in
// `policy.ts`/`verify.ts`) rather than deciding a curve library ahead of a
// stack-wide decision -- multicodec `did:key`s can encode more than one
// curve. This adapter follows the same discipline: `RawSignatureVerifier`
// is injected, not implemented here.

export interface AgentKeyCatalogEntry {
  keyid: string;
  /**
   * An ISO instant known to fall within this key's own binding validity
   * window (typically the binding's own `validFrom`). `everBound` needs
   * this: trust-core's `resolveBinding` is point-in-time-only (no
   * "at any time" query mode), so probing at the real current wall clock
   * would spuriously report `false` for a key whose historical window has
   * since fully elapsed -- exactly the case §10.1's rotation-survives-
   * history guarantee exists for.
   */
  probeAt: string;
}

export interface AgentKeyCatalog {
  /** did:key candidates a host knows of for `agent` (not necessarily still valid or in scope -- this adapter resolves+validates each). */
  candidateKeys(agent: string): Promise<AgentKeyCatalogEntry[]>;
}

export interface RawSignatureVerifier {
  verify(pae: Uint8Array, sig: Uint8Array, key: ResolvedKey): Promise<boolean>;
}

export interface TrustAdapterDeps {
  bindingResolver: BindingResolver;
  keyCatalog: AgentKeyCatalog;
  verifier: RawSignatureVerifier;
}

export interface TrustAdapter {
  keys: KeyResolver;
  sigs: SignatureVerifier;
  fresh: FreshnessPolicy;
}

/**
 * A resolved binding is active for discovery signing at `atIso` when: it
 * holds the discovery signing scope, its effective start has passed, and
 * no revocation is effective by `atIso`. This is a deliberately narrower
 * check than trust-core's own full §7.5 procedure (which also verifies the
 * ceremony leg, the consent chain, and revoker authority) -- entry
 * corroboration and head-signature acceptance need "is this key currently
 * authorized to sign under this scope," not the full binding-establishment
 * proof, which trust-core's own consumers verify once when the binding
 * itself is admitted. Recorded as a scoping decision (Finding F5's
 * adaptation), not a shortcut around trust-core's guarantees.
 */
function isActiveForDiscoverySigning(binding: Awaited<ReturnType<BindingResolver["resolveBinding"]>>, atIso: string): boolean {
  if (binding === null) return false;
  if (!binding.binding.scope.includes(DISCOVERY_SIGNING_SCOPE)) return false;
  if (binding.effectiveStart > atIso) return false;
  return binding.revocations.every((revocation) => revocation.effectiveTime > atIso);
}

export function createTrustAdapter(deps: TrustAdapterDeps): TrustAdapter {
  const keys: KeyResolver = {
    async resolve(agent: string, at: Date): Promise<ResolvedKey[]> {
      const atIso = at.toISOString();
      const candidates = await deps.keyCatalog.candidateKeys(agent);
      const resolved: ResolvedKey[] = [];
      for (const candidate of candidates) {
        const binding = await deps.bindingResolver.resolveBinding({ key: candidate.keyid, agent }, atIso);
        if (isActiveForDiscoverySigning(binding, atIso)) {
          resolved.push({ keyid: binding!.binding.key.keyid, publicKey: binding!.binding.key.publicKey, algorithm: binding!.binding.key.algorithm });
        }
      }
      return resolved;
    },
    async everBound(agent: string, keyid: string): Promise<boolean> {
      // "Ever bound" ignores current validity/revocation (§10.1: rotation
      // never orphans history) -- it only asks whether a binding under the
      // discovery scope was ever resolvable for this (key, agent) pair.
      // Probes at the catalog's own recorded `probeAt` for this key
      // (guaranteed to fall within its historical validity window), not
      // the real current wall clock -- see AgentKeyCatalogEntry's doc.
      const candidates = await deps.keyCatalog.candidateKeys(agent);
      const candidate = candidates.find((c) => c.keyid === keyid);
      if (candidate === undefined) return false;
      const binding = await deps.bindingResolver.resolveBinding({ key: keyid, agent }, candidate.probeAt);
      return binding !== null && binding.binding.scope.includes(DISCOVERY_SIGNING_SCOPE);
    },
  };

  const sigs: SignatureVerifier = {
    async verify(pae: Uint8Array, sig: Uint8Array, key: ResolvedKey): Promise<boolean> {
      return deps.verifier.verify(pae, sig, key);
    },
  };

  const fresh: FreshnessPolicy = {
    isFresh(refreshBy: string, now: Date): boolean {
      return new Date(refreshBy).getTime() > now.getTime();
    },
  };

  return { keys, sigs, fresh };
}
