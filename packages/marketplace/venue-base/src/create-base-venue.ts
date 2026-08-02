// SPDX-License-Identifier: MIT

// The supported composition surface (program §5). Per-port factories exist underneath; hosts
// build a venue through this one call so the single-broadcaster rule and the single-state-file
// rule hold by construction rather than by convention.
import type {
  ClaimPorts, DeliveryWaitPort, FinalityPort, MarketplaceLifecyclePorts, MarketplaceObservePort,
  PostingIntentStore, ReleaseAttemptPort, SettlementPorts,
} from "@jinn-network/marketplace-binding";
import type { BaseVenueConfig } from "./config.js";
import { createBroadcastLock } from "./broadcast/lock.js";
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
  /** Feature-disabled today-mode evaluator settlement primitives. */
  readonly verdict: VerdictPorts;
  close(): void;
}

export function createBaseVenue(config: BaseVenueConfig): BaseVenue {
  if (config.walletClient.account === undefined) {
    throw new Error(
      "createBaseVenue requires an injected WalletClient account: venue-base is signer-injection "
      + "only and never loads or derives key material",
    );
  }
  const state = openVenueState(config.stateDbPath);
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
    intents: createSqlitePostingIntentStore(state),
    verdict: createVerdictPorts({
      publicClient: config.publicClient,
      broadcaster: safe,
      safeAddress: config.safeAddress,
      routerAddress: config.chain.jinnRouter,
      mechAddress: config.priorityMech,
    }),
    close() {
      logSource.close();
      state.close();
    },
  };
}
