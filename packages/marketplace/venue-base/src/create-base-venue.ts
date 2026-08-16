// SPDX-License-Identifier: MIT

// The supported composition surface (program §5). Per-port factories exist underneath; hosts
// build a venue through this one call so the single-broadcaster rule and the single-state-file
// rule hold by construction rather than by convention.
import type {
  ClaimPorts, DeliveryWaitPort, FinalityPort, MarketplaceLifecyclePorts, MarketplaceObservePort,
  PostingIntentStore, ReleaseAttemptPort, SettlementPorts,
} from "@jinn-network/marketplace-binding";
import { resolve } from "node:path";
import type { BaseVenueConfig } from "./config.js";
import { createBroadcastLock, type BroadcastLock } from "./broadcast/lock.js";
import { createSubmissionLedger } from "./broadcast/ledger.js";
import { createSafeBroadcaster, type BaseVenueSafeBroadcaster } from "./broadcast/safe-broadcaster.js";
import { createChainLogSource, type ChainLogSource } from "./log-source/chain-log-source.js";
import { createFinalityWaiter } from "./waiters/finality.js";
import { createDeliveryWaiter } from "./waiters/delivery.js";
import { createClaimWriter } from "./writers/claim.js";
import { createVerdictPorts, type VerdictPorts } from "./verdict.js";
import { createSettlementPorts } from "./writers/settlement.js";
import { createLifecyclePorts, createReleasePort } from "./writers/lifecycle.js";
import { createSqlitePostingIntentStore } from "./intents/intent-store.js";
import { createProjectorObservePort } from "./observe/projector-observe.js";
import { openVenueState } from "./state/database.js";

// A venue owns the only mutable SQLite connection/cursor/broadcast ledger for its state path.
// Without this process-local guard two independently assembled builders can race Safe nonces and
// projector cursors even though SQLite's WAL mode permits both file handles to exist.
const ACTIVE_STATE_PATHS = new Set<string>();

export class BaseVenueOwnershipError extends Error {
  override readonly name = "BaseVenueOwnershipError";
}

export interface BaseVenue {
  readonly claim: ClaimPorts;
  readonly settlement: SettlementPorts;
  readonly lifecycle: MarketplaceLifecyclePorts;
  readonly finality: FinalityPort;
  readonly deliveryWait: DeliveryWaitPort;
  readonly release: ReleaseAttemptPort;
  readonly observe: MarketplaceObservePort;
  readonly safe: BaseVenueSafeBroadcaster;
  readonly logSource: ChainLogSource;
  readonly intents: PostingIntentStore;
  /**
   * The durable, SQLite-backed per-`(chainId, sender)` lock `safe` broadcasts through. Exposed so
   * a host can share it with OTHER broadcast domains against the same agent EOA that do not route
   * through this venue's Safe broadcaster (finding #525/#562/#897: two independently-locked
   * broadcasters over one EOA can still collide on a nonce). See
   * `operator/src/tx-retry.ts`'s `setDefaultEoaBroadcastLock`.
   */
  readonly broadcastLock: BroadcastLock;
  /** Feature-disabled V3 evaluator primitives; absent for revised V4 venues. */
  readonly verdict?: VerdictPorts;
  close(): void;
}

export function createBaseVenue(config: BaseVenueConfig): BaseVenue {
  if (config.walletClient.account === undefined) {
    throw new Error(
      "createBaseVenue requires an injected WalletClient account: venue-base is signer-injection "
      + "only and never loads or derives key material",
    );
  }
  const statePath = resolve(config.stateDbPath);
  if (ACTIVE_STATE_PATHS.has(statePath)) {
    throw new BaseVenueOwnershipError(`BaseVenue state path is already owned by this process: ${statePath}`);
  }
  ACTIVE_STATE_PATHS.add(statePath);

  let state: ReturnType<typeof openVenueState> | undefined;
  try {
    state = openVenueState(config.stateDbPath);
  // Capture the successfully opened state for the returned venue. The outer variable remains
  // optional solely so the factory catch path can clean up a partial construction.
  const ownedState = state;
  const ledger = createSubmissionLedger(state);
  const lock = createBroadcastLock(state);
  const safe = createSafeBroadcaster({
    chainId: config.chain.chainId,
    safeAddress: config.safeAddress,
    publicClient: config.publicClient,
    walletClient: config.walletClient,
    ledger,
    lock,
    ...(config.broadcast === undefined ? {} : { options: config.broadcast }),
  });
  const logSource = createChainLogSource({
    chain: config.chain,
    publicClient: config.publicClient,
    state,
    addresses: [
      config.chain.jinnRouter,
      config.chain.taskCoordinator,
      config.chain.mechMarketplace,
      // Mech Deliver events are emitted by the priority mech, not the marketplace. Settlement's
      // readMechDeliveryFacts scans this same logSource; omitting the mech made Deliver invisible
      // while delivery-watcher / e2e waitForDelivery (direct getLogs on mech) still saw it (E44).
      config.priorityMech,
    ],
    ...(config.logSource === undefined ? {} : { options: config.logSource }),
  });
  const observe = createProjectorObservePort({
    chain: config.chain, state, logSource, observations: config.observations,
  });
  const claimWriter = createClaimWriter({
    chain: config.chain, publicClient: config.publicClient, safeAddress: config.safeAddress,
    broadcaster: safe, priorityMech: config.priorityMech,
  });

  let closed = false;
  return {
    // Per-engagement members (taskDigest/submission/nonce/capabilityMatch) are supplied by the
    // host at each `runPipeline` call, exactly as `pipeline.ts` spreads them over `ports.claim`.
    claim: claimWriter as ClaimPorts,
    settlement: createSettlementPorts({
      chain: config.chain, publicClient: config.publicClient, safeAddress: config.safeAddress,
      broadcaster: safe, logSource, pin: config.pin,
      verifySettlementGrade: config.verifySettlementGrade,
    }),
    lifecycle: createLifecyclePorts({
      chain: config.chain, publicClient: config.publicClient, broadcaster: safe, state,
      resolveAttempt: async (attempt) => {
        const snapshot = await observe.observe(attempt);
        const engagement = snapshot.descriptor.annotations?.["engagement"] as
          { readonly taskId: string; readonly attemptIndex: number } | undefined;
        if (engagement === undefined) {
          throw new Error(`no venue engagement recorded for attempt ${attempt}`);
        }
        return { taskId: BigInt(engagement.taskId), attemptIndex: engagement.attemptIndex };
      },
    }),
    finality: createFinalityWaiter({
      publicClient: config.publicClient, logSource,
      ...(config.finality === undefined ? {} : { options: config.finality }),
    }),
    deliveryWait: createDeliveryWaiter(config.deliveryWait),
    release: createReleasePort({ chain: config.chain, broadcaster: safe }),
    observe,
    safe,
    logSource,
    broadcastLock: lock,
    intents: createSqlitePostingIntentStore(state),
    ...(config.chain.generation === "today" ? {
      verdict: createVerdictPorts({
        publicClient: config.publicClient,
        broadcaster: safe,
        safeAddress: config.safeAddress,
        routerAddress: config.chain.jinnRouter,
        mechAddress: config.priorityMech,
      }),
    } : {}),
    close() {
      if (closed) return;
      closed = true;
      try {
        logSource.close();
      } finally {
        try {
          ownedState.close();
        } finally {
          ACTIVE_STATE_PATHS.delete(statePath);
        }
      }
    },
  };
  } catch (cause) {
    try {
      state?.close();
    } catch {
      // Preserve the factory failure that caused cleanup, not a secondary close failure.
    }
    ACTIVE_STATE_PATHS.delete(statePath);
    throw cause;
  }
}
