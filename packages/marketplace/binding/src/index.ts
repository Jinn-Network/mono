// @jinn-network/marketplace-binding -- public surface (M0+M1 slice).
//
// `order.ts`/`canonical-json.ts` are deliberately NOT exported here: they seal the binding's own
// backend-internal canonical bytes only (broadcast-intent WAL record, correspondence-assertion
// payload), never a TEP or discovery document family (program §7.1/§7.14/§7.15) -- they are an
// implementation detail, not part of this package's public contract.

// --- the two-generation seam (§5.4, frozen §11.1/§11.6) ---
export { selectGeneration } from "./generation.js";
export type { ContractGeneration, GenerationSelectable } from "./generation.js";

// --- deployed today-mode chain config (Preflight-confirmed) ---
export { BASE_SEPOLIA_TODAY } from "./addresses.js";
export type { MarketplaceChainConfig } from "./addresses.js";

// --- marketplace Attempt-URI derivation: a thin adapter over the protocol export (must #2) ---
export {
  MARKETPLACE_BINDING_NAME,
  deriveMarketplaceAttemptUri,
  normalizeAttemptTuple,
} from "./attempt-uri.js";
export type { MarketplaceAttemptTuple } from "./attempt-uri.js";

// --- the two-party engagement entry (named surface; consumed by the pipeline at Milestone M6) ---
export type { TwoPartyEngagement } from "./two-party-engagement.js";
