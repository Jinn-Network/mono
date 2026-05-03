/**
 * deploy-jinn-mvi-l1.ts — Phase A5 of the Jinn v0 MVI.
 *
 * Deploys the L1 governance + distribution stack:
 *   1. JINN          — ERC20Votes governance token
 *   2. TimelockController — OZ standard, holds {JINN.owner} + {Distributor.owner}
 *   3. JinnGovernor       — OZ Governor module composition
 *   4. Messenger          — MockMessenger (mock mode) or CanonicalOpStackMessenger
 *                           (canonical mode); see {JinnMviMessengerMode}
 *   5. JinnDistributor    — Sole-minter cross-chain claim surface
 *
 * Wiring sequence (the order matters because Ownable2Step requires the
 * deployer to still hold ownership when calling {setMinter}):
 *
 *   - Deploy JINN, Timelock, Governor (steps 1–3).
 *   - Deploy messenger + distributor (steps 4–5) with the deployer as
 *     {distributor.owner} (transferred to Timelock at the end).
 *   - Set {JINN.minter} to the distributor while the deployer is still
 *     {JINN.owner}.
 *   - Grant the Governor PROPOSER + EXECUTOR + CANCELLER on the Timelock.
 *   - Transfer {JINN.owner} to the Timelock (Ownable2Step pending).
 *   - Transfer {Distributor.owner} to the Timelock (Ownable2Step pending).
 *   - Renounce the deployer's optional Timelock admin role.
 *
 *   Both {JINN.acceptOwnership} and {Distributor.acceptOwnership} must be
 *   called by the Timelock itself; the deploy script CANNOT do this on a
 *   live network. It must happen via the first Governor proposal once
 *   voting power has been bootstrapped. The console output flags this
 *   explicitly.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-jinn-mvi-l1.ts --network hardhat
 *   JINN_MVI_TIMING_PROFILE=fast-test npx hardhat run scripts/deploy-jinn-mvi-l1.ts --network sepolia
 *
 * Env vars:
 *   JINN_MVI_TIMING_PROFILE         "canonical" | "fast-test". Defaults are
 *                                   chainId-aware: Sepolia/Hardhat → fast-test,
 *                                   mainnet → canonical. Per R-1 the canonical
 *                                   7-day OP-Stack finality is impractical on
 *                                   testnet, so we default to fast-test there.
 *   JINN_MVI_MESSENGER_MODE         "canonical" | "mock"; default follows timing profile
 *   JINN_MVI_OPTIMISM_PORTAL        canonical mode: L1 OptimismPortal2 address
 *   JINN_MVI_DISPUTE_GAME_FACTORY   canonical mode: DisputeGameFactory address
 *   JINN_MVI_CLAIM_EMITTER          canonical mode: deployed TaskClaimEmitter (L2)
 *   JINN_MVI_CLAIM_TICKET_TOPIC     canonical mode: optional, defaults to keccak256
 *                                   of the ClaimTicket signature
 *   JINN_MVI_ALLOW_CHAIN            opt in to a non-whitelisted chainId (e.g. mainnet)
 *   JINN_MVI_RENOUNCE_ADMIN         "true"|"false"; default true on mainnet,
 *                                   false on Sepolia/Hardhat (testnet-recovery)
 *   JINN_MVI_MOCK_MESSENGER_OWNER   transfer MockMessenger ownership to this
 *                                   address post-deploy (testnet-only; canonical mode ignores)
 *   DEPLOYER_PRIVATE_KEY            deployer wallet private key (live networks)
 *   RPC_URL                         optional; otherwise hardhat.config.ts is used
 *
 * Output:
 *   deployment-jinn-mvi-l1-{network}{-fast?}.json
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import {
  CANONICAL_GOVERNANCE_CONFIG,
  FAST_TEST_GOVERNANCE_CONFIG,
  JinnMviGovernanceConfig,
  JinnMviMessengerMode,
  JinnDistributorInitialConfig,
  LOCKED_DISTRIBUTOR_INITIAL_CONFIG,
  CanonicalMessengerWiring,
  CHAIN_ID_HARDHAT,
  CHAIN_ID_SEPOLIA,
  CHAIN_ID_MAINNET,
  JINN_MVI_L1_ALLOWED_CHAINS,
  assertChainIdAllowed,
  getJinnMviGovernanceConfig,
  getJinnMviL1DeploymentArtifactName,
  resolveJinnMviTimingProfile,
  resolveJinnMviTimingProfileForChain,
  resolveJinnMviMessengerMode,
  resolveCanonicalMessengerWiring,
} from "./lib/jinn-mvi-helpers";

/**
 * Parameters that fully specify how a JinnDistributor messenger is
 * deployed. Either `mode === "mock"` (no extra wiring) or
 * `mode === "canonical"` with a {CanonicalMessengerWiring}.
 */
export type MessengerDeployParams =
  | { mode: "mock" }
  | { mode: "canonical"; wiring: CanonicalMessengerWiring };

/**
 * Resolve whether to renounce the deployer's optional Timelock admin role.
 *
 * Defaults:
 *  - mainnet (chainId=1): renounce. The first Governor proposal
 *    accepts both ownerships; if it misconfigures, the captain
 *    expects to recover via additional proposals — not by reaching
 *    for the deployer's admin role.
 *  - Sepolia / Hardhat: do NOT renounce. Testnet first-proposal
 *    misconfigs are common; renouncing on testnet wastes governance
 *    cycles on infra fixes.
 *
 * Override via `JINN_MVI_RENOUNCE_ADMIN=true|false`.
 */
export function resolveRenounceAdmin(
  chainId: number,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.JINN_MVI_RENOUNCE_ADMIN;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return chainId === 1;
}

export interface JinnMviL1Deployment {
  jinn: string;
  timelock: string;
  governor: string;
  distributor: string;
  messenger: string;
  messengerMode: JinnMviMessengerMode;
  /** Final owner of the messenger (mock mode only). For canonical mode
   *  this is `null` since CanonicalOpStackMessenger has no owner. */
  messengerOwner: string | null;
  /** Whether the deployer's optional Timelock admin role was renounced. */
  adminRenounced: boolean;
  config: JinnMviGovernanceConfig;
  distributorConfig: JinnDistributorInitialConfig;
}

/**
 * Deploy the messenger contract for the chosen mode. Returns the deployed
 * address — the caller wires it into the JinnDistributor.
 */
async function deployMessenger(
  signer: import("ethers").Signer,
  params: MessengerDeployParams,
): Promise<{ address: string; mode: JinnMviMessengerMode }> {
  if (params.mode === "mock") {
    const Mock = await ethers.getContractFactory(
      "src/jinn/cross-chain/MockMessenger.sol:MockMessenger",
      signer,
    );
    const messenger = await Mock.deploy(await signer.getAddress());
    await messenger.waitForDeployment();
    return { address: await messenger.getAddress(), mode: "mock" };
  }

  const Canonical = await ethers.getContractFactory(
    "src/jinn/cross-chain/CanonicalOpStackMessenger.sol:CanonicalOpStackMessenger",
    signer,
  );
  const messenger = await Canonical.deploy(
    params.wiring.optimismPortal,
    params.wiring.disputeGameFactory,
    params.wiring.expectedEmitter,
    params.wiring.claimTicketTopic,
  );
  await messenger.waitForDeployment();
  return { address: await messenger.getAddress(), mode: "canonical" };
}

export async function deployJinnMviL1(
  signer: import("ethers").Signer,
  config: JinnMviGovernanceConfig,
  options: {
    messenger?: MessengerDeployParams;
    distributorConfig?: JinnDistributorInitialConfig;
    /** Token name to pass to the JINN constructor (e.g. "JINN" mainnet,
     *  "JINN (testnet)" Sepolia). Defaults to "JINN". */
    tokenName?: string;
    /** Token symbol (e.g. "JINN" mainnet, "tJINN" testnet). Defaults to "JINN". */
    tokenSymbol?: string;
    /** If set and != deployer, transfer MockMessenger ownership to this
     *  address after deploy. Ignored in canonical mode. */
    mockMessengerOwner?: string;
    /** If true, renounce the deployer's optional Timelock admin role at
     *  the end of step 7. Defaults to true (preserves prior behavior). */
    renounceAdmin?: boolean;
  } = {},
): Promise<JinnMviL1Deployment> {
  const deployerAddress = await signer.getAddress();
  const messengerParams: MessengerDeployParams =
    options.messenger ?? { mode: "mock" };
  const distributorConfig: JinnDistributorInitialConfig =
    options.distributorConfig ?? { ...LOCKED_DISTRIBUTOR_INITIAL_CONFIG };
  const renounceAdmin = options.renounceAdmin ?? true;
  const tokenName = options.tokenName ?? "JINN";
  const tokenSymbol = options.tokenSymbol ?? "JINN";

  // -----------------------------------------------------------------------
  // Step 1: JINN token — initialOwner = deployer (transferred to Timelock
  // in Step 6 below; uses Ownable2Step so the new owner must accept).
  // -----------------------------------------------------------------------
  const JINN = await ethers.getContractFactory(
    "src/jinn/token/JINN.sol:JINN",
    signer,
  );
  const jinn = await JINN.deploy(tokenName, tokenSymbol, deployerAddress);
  await jinn.waitForDeployment();

  // -----------------------------------------------------------------------
  // Step 2: TimelockController — proposers + executors are wired in Step 6
  // after the Governor deploys. Admin = deployer for setup; renounced at
  // the end (see notes below).
  // -----------------------------------------------------------------------
  const Timelock = await ethers.getContractFactory(
    "@openzeppelin/contracts/governance/TimelockController.sol:TimelockController",
    signer,
  );
  const timelock = await Timelock.deploy(
    config.timelockMinDelaySeconds,
    [], // proposers — granted later
    [], // executors — granted later
    deployerAddress, // optional admin for setup
  );
  await timelock.waitForDeployment();

  // -----------------------------------------------------------------------
  // Step 3: JinnGovernor — pulls voting power from JINN's ERC20Votes
  // checkpoints and routes execution through the Timelock.
  // -----------------------------------------------------------------------
  const Governor = await ethers.getContractFactory(
    "src/jinn/governance/JinnGovernor.sol:JinnGovernor",
    signer,
  );
  const governor = await Governor.deploy(
    await jinn.getAddress(),
    await timelock.getAddress(),
    config.votingDelaySeconds,
    config.votingPeriodSeconds,
    config.proposalThreshold,
    config.quorumNumerator,
  );
  await governor.waitForDeployment();

  // -----------------------------------------------------------------------
  // Step 4: Messenger — `mock` for fast-test / dev, `canonical` for live
  // OP-Stack message-passing finality.
  // -----------------------------------------------------------------------
  const messenger = await deployMessenger(signer, messengerParams);

  // -----------------------------------------------------------------------
  // Step 5: JinnDistributor — initialOwner = deployer (so we can call the
  // ownership-related plumbing below; transferred to the Timelock in Step
  // 7 via Ownable2Step). daoTreasury = Timelock — DAO-share mints land
  // there. The distributor cannot mint until JINN.minter is set to its
  // address (Step 6).
  // -----------------------------------------------------------------------
  const Distributor = await ethers.getContractFactory(
    "src/jinn/distribution/JinnDistributor.sol:JinnDistributor",
    signer,
  );
  const timelockAddress = await timelock.getAddress();
  const distributor = await Distributor.deploy(
    deployerAddress, // initialOwner — transferred to Timelock in Step 7
    await jinn.getAddress(),
    timelockAddress, // daoTreasury — DAO-share mint recipient
    messenger.address,
    distributorConfig.operatorRatio,
    distributorConfig.daoRatio,
    distributorConfig.wTaskCreation,
    distributorConfig.wSolutionDelivery,
    distributorConfig.wVerdictDelivery,
  );
  await distributor.waitForDeployment();
  const distributorAddress = await distributor.getAddress();

  // -----------------------------------------------------------------------
  // Step 6: Set JINN.minter = distributor BEFORE handing JINN ownership to
  // the Timelock. {setMinter} is `onlyOwner` and the deployer is still the
  // owner here. Once minter is set, the distributor can mint via its
  // {claim} flow.
  // -----------------------------------------------------------------------
  await (await jinn.setMinter(distributorAddress)).wait();

  // -----------------------------------------------------------------------
  // Step 7: Wire ownership.
  //
  // 7a. Grant Timelock roles to JinnGovernor:
  //     - PROPOSER_ROLE: only the Governor can schedule.
  //     - EXECUTOR_ROLE: only the Governor (safe default; alternative is
  //       address(0) for "anyone can execute", but we keep it tight in v0).
  //     - CANCELLER_ROLE: Governor can cancel its own queued proposals.
  // -----------------------------------------------------------------------
  const proposerRole = await timelock.PROPOSER_ROLE();
  const executorRole = await timelock.EXECUTOR_ROLE();
  const cancellerRole = await timelock.CANCELLER_ROLE();
  const adminRole = await timelock.DEFAULT_ADMIN_ROLE();
  const governorAddress = await governor.getAddress();

  await (await timelock.grantRole(proposerRole, governorAddress)).wait();
  await (await timelock.grantRole(executorRole, governorAddress)).wait();
  await (await timelock.grantRole(cancellerRole, governorAddress)).wait();

  // 7b. Hand JINN ownership to the Timelock. Ownable2Step requires the new
  // owner to call {acceptOwnership} — on live networks this happens via a
  // first Governor proposal; on hardhat tests we do it via impersonation
  // so the resulting deployment matches the post-acceptance state.
  await (await jinn.transferOwnership(timelockAddress)).wait();

  // 7c. Hand JinnDistributor ownership to the Timelock. Same Ownable2Step
  // story — Timelock must call {acceptOwnership} via a Governor proposal
  // before {setMessenger} / {setRatios} / {setWeights} become callable.
  await (await distributor.transferOwnership(timelockAddress)).wait();

  // 7d. Renounce the optional Timelock admin role so the Timelock is the
  // sole admin of itself. Once renounced, all role changes must go through
  // a Governor proposal. Gated by `renounceAdmin` so the captain can
  // defer renunciation on testnet — a misconfigured first proposal that
  // blocks the Governor's `acceptOwnership` call would otherwise strand
  // ownership permanently.
  if (renounceAdmin) {
    await (await timelock.renounceRole(adminRole, deployerAddress)).wait();
  }

  // 7e. Transfer MockMessenger ownership to the daemon-controlled key
  // if the caller supplied one. Only meaningful in mock mode — the
  // daemon needs to write fixtures, and in tests the deployer is also
  // the test runner so we leave it unchanged. The CanonicalOpStackMessenger
  // has no owner so this is a no-op there.
  let messengerOwner: string | null = null;
  if (messenger.mode === "mock") {
    if (
      options.mockMessengerOwner
        && options.mockMessengerOwner.toLowerCase() !== deployerAddress.toLowerCase()
    ) {
      const mock = await ethers.getContractAt(
        "src/jinn/cross-chain/MockMessenger.sol:MockMessenger",
        messenger.address,
        signer,
      );
      await (await mock.transferOwnership(options.mockMessengerOwner)).wait();
      messengerOwner = options.mockMessengerOwner;
    } else {
      messengerOwner = deployerAddress;
    }
  }

  return {
    jinn: await jinn.getAddress(),
    timelock: timelockAddress,
    governor: governorAddress,
    distributor: distributorAddress,
    messenger: messenger.address,
    messengerMode: messenger.mode,
    messengerOwner,
    adminRenounced: renounceAdmin,
    config,
    distributorConfig,
  };
}

// ---------------------------------------------------------------------------
// Post-deploy sanity assertions
// ---------------------------------------------------------------------------

/**
 * Read every load-bearing handover wire from chain and assert that
 * each lands on the address recorded in the deployment object. Throws
 * on the first mismatch with an actionable message naming what was
 * expected and what was observed. Required by the v0 threat model
 * §3.2 ("post-deploy ceremony reads back from chain").
 */
export async function verifyDeploy(
  deployment: JinnMviL1Deployment,
  deployerAddress: string,
  renounceAdmin: boolean,
  expected: { tokenName?: string; tokenSymbol?: string } = {},
): Promise<void> {
  const checks: Array<[string, string, string]> = [];

  const jinn = await ethers.getContractAt(
    "src/jinn/token/JINN.sol:JINN",
    deployment.jinn,
  );

  // Token name / symbol — assert the on-chain values match what the deploy
  // intended (e.g. "JINN (testnet)" / "tJINN" on Sepolia).
  if (expected.tokenName !== undefined) {
    const onChainName: string = await jinn.name();
    checks.push(["JINN.name", onChainName, expected.tokenName]);
  }
  if (expected.tokenSymbol !== undefined) {
    const onChainSymbol: string = await jinn.symbol();
    checks.push(["JINN.symbol", onChainSymbol, expected.tokenSymbol]);
  }
  const distributor = await ethers.getContractAt(
    "src/jinn/distribution/JinnDistributor.sol:JinnDistributor",
    deployment.distributor,
  );
  const timelock = await ethers.getContractAt(
    "@openzeppelin/contracts/governance/TimelockController.sol:TimelockController",
    deployment.timelock,
  );

  const minter: string = await jinn.minter();
  checks.push(["JINN.minter", minter, deployment.distributor]);

  const dMessenger: string = await distributor.messenger();
  checks.push(["distributor.messenger", dMessenger, deployment.messenger]);

  const dDao: string = await distributor.daoTreasury();
  checks.push(["distributor.daoTreasury", dDao, deployment.timelock]);

  const jPending: string = await jinn.pendingOwner();
  checks.push(["JINN.pendingOwner", jPending, deployment.timelock]);

  const dPending: string = await distributor.pendingOwner();
  checks.push(["distributor.pendingOwner", dPending, deployment.timelock]);

  for (const [label, actual, expected] of checks) {
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `[verifyDeploy] ${label} mismatch: expected ${expected}, observed ${actual}`,
      );
    }
  }

  // Role checks: Governor must be PROPOSER + EXECUTOR + CANCELLER on the
  // Timelock. These are the three roles the deploy script grants in 7a.
  const proposerRole: string = await timelock.PROPOSER_ROLE();
  const executorRole: string = await timelock.EXECUTOR_ROLE();
  const cancellerRole: string = await timelock.CANCELLER_ROLE();
  const adminRole: string = await timelock.DEFAULT_ADMIN_ROLE();

  const roleChecks: Array<[string, string]> = [
    ["PROPOSER_ROLE", proposerRole],
    ["EXECUTOR_ROLE", executorRole],
    ["CANCELLER_ROLE", cancellerRole],
  ];
  for (const [label, role] of roleChecks) {
    const has: boolean = await timelock.hasRole(role, deployment.governor);
    if (!has) {
      throw new Error(
        `[verifyDeploy] Governor missing ${label} on Timelock ` +
          `(governor=${deployment.governor}, timelock=${deployment.timelock})`,
      );
    }
  }

  // Admin role: if renounced, the deployer must be off the role.
  // OZ TimelockController inherits plain AccessControl, not the
  // Enumerable variant, so we cannot enumerate members directly. The
  // Timelock self-administers (it grants admin to itself in its
  // constructor), so the only role-holder we need to check after
  // renunciation is the deployer.
  if (renounceAdmin) {
    const deployerHasAdmin: boolean = await timelock.hasRole(
      adminRole,
      deployerAddress,
    );
    if (deployerHasAdmin) {
      throw new Error(
        `[verifyDeploy] deployer ${deployerAddress} still holds ` +
          `DEFAULT_ADMIN_ROLE on the Timelock; expected renounced.`,
      );
    }
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;
  const chainId = Number(network.chainId);

  // Fix 8: chainId gate. Refuse to deploy on chains we have not signed
  // off on (e.g. mainnet, Base, Polygon) unless the captain explicitly
  // sets `JINN_MVI_ALLOW_CHAIN=<id>` to opt in.
  assertChainIdAllowed({
    chainId,
    allowed: JINN_MVI_L1_ALLOWED_CHAINS,
    scriptName: "Jinn MVI L1 stack",
  });

  // Fix 9: chainId-aware default timing profile. The canonical 7-day
  // OP-Stack finality is impractical on Sepolia (per R-1), so when the
  // captain has not pinned `JINN_MVI_TIMING_PROFILE` we default to
  // fast-test on Sepolia + Hardhat. Mainnet (when whitelisted) keeps
  // the canonical default.
  const profile = resolveJinnMviTimingProfileForChain(chainId);
  const config: JinnMviGovernanceConfig = getJinnMviGovernanceConfig(profile);

  const messengerMode = resolveJinnMviMessengerMode(profile);
  let messengerParams: MessengerDeployParams;
  if (messengerMode === "mock") {
    messengerParams = { mode: "mock" };
  } else {
    const wiring = resolveCanonicalMessengerWiring();
    if (wiring === null) {
      throw new Error(
        "JINN_MVI_MESSENGER_MODE=canonical requires JINN_MVI_OPTIMISM_PORTAL, " +
          "JINN_MVI_DISPUTE_GAME_FACTORY, and JINN_MVI_CLAIM_EMITTER env vars. " +
          "Optionally set JINN_MVI_CLAIM_TICKET_TOPIC to override the default keccak256.",
      );
    }
    messengerParams = { mode: "canonical", wiring };
  }
  const distributorConfig: JinnDistributorInitialConfig = {
    ...LOCKED_DISTRIBUTOR_INITIAL_CONFIG,
  };

  // Fix 11: opt-in admin renunciation. Defaults: mainnet → renounce,
  // Sepolia/Hardhat → keep (so a misconfigured first proposal cannot
  // strand ownership permanently). `JINN_MVI_RENOUNCE_ADMIN` overrides.
  const renounceAdmin = resolveRenounceAdmin(chainId);

  // Fix 10: optional MockMessenger ownership transfer. Captures the
  // testnet pattern where the daemon (not the deployer) needs to
  // write fixtures. Canonical mode ignores this.
  const mockMessengerOwner = process.env.JINN_MVI_MOCK_MESSENGER_OWNER;

  // Token name + symbol — env-driven for testnet/mainnet disambiguation.
  // Mainnet default: "JINN" / "JINN". Sepolia/Hardhat default: "JINN (testnet)" / "tJINN".
  // The on-chain ERC20 reports these — explorers and wallets show the testnet
  // variant clearly distinct from the Phase 1a "Jinn" tokens (which play the
  // OLAS-equivalent role; see CLAUDE.md / runbooks).
  const isTestnet = chainId === 11155111 || chainId === 31337;
  const tokenName = process.env.JINN_TOKEN_NAME ?? (isTestnet ? "JINN (testnet)" : "JINN");
  const tokenSymbol = process.env.JINN_TOKEN_SYMBOL ?? (isTestnet ? "tJINN" : "JINN");

  console.log("=== Jinn v0 MVI L1 Deployment ===");
  console.log(`Network:        ${networkName} (chainId: ${network.chainId})`);
  console.log(`Deployer:       ${deployer.address}`);
  console.log(
    `Balance:        ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`,
  );
  console.log(`Timing profile: ${profile}`);
  console.log(`  votingDelay:        ${config.votingDelaySeconds}s`);
  console.log(`  votingPeriod:       ${config.votingPeriodSeconds}s`);
  console.log(`  proposalThreshold:  ${config.proposalThreshold.toString()}`);
  console.log(`  quorumFraction:     ${config.quorumNumerator}%`);
  console.log(`  timelockMinDelay:   ${config.timelockMinDelaySeconds}s`);
  console.log(`Messenger mode: ${messengerMode}`);
  if (messengerParams.mode === "canonical") {
    console.log(`  optimismPortal:     ${messengerParams.wiring.optimismPortal}`);
    console.log(`  disputeGameFactory: ${messengerParams.wiring.disputeGameFactory}`);
    console.log(`  expectedEmitter:    ${messengerParams.wiring.expectedEmitter}`);
    console.log(`  claimTicketTopic:   ${messengerParams.wiring.claimTicketTopic}`);
  }
  console.log(`Distributor initial:`);
  console.log(`  operatorRatio:        ${distributorConfig.operatorRatio.toString()}`);
  console.log(`  daoRatio:             ${distributorConfig.daoRatio.toString()}`);
  console.log(`  wTaskCreation:            ${distributorConfig.wTaskCreation.toString()}`);
  console.log(`  wSolutionDelivery: ${distributorConfig.wSolutionDelivery.toString()}`);
  console.log(`  wVerdictDelivery:  ${distributorConfig.wVerdictDelivery.toString()}`);
  console.log();

  console.log(`Renounce admin: ${renounceAdmin}`);
  if (mockMessengerOwner) {
    console.log(`Mock messenger owner override: ${mockMessengerOwner}`);
  }
  console.log(`Token name:     ${tokenName}`);
  console.log(`Token symbol:   ${tokenSymbol}`);
  console.log(
    "Deploying JINN, TimelockController, JinnGovernor, Messenger, JinnDistributor…\n",
  );
  const deployment = await deployJinnMviL1(deployer, config, {
    messenger: messengerParams,
    distributorConfig,
    mockMessengerOwner,
    renounceAdmin,
    tokenName,
    tokenSymbol,
  });

  // Fix 12: post-deploy sanity assertions, before writing the artifact.
  // Throws on the first mismatch. Required by threat model §3.2.
  await verifyDeploy(deployment, deployer.address, renounceAdmin, {
    tokenName,
    tokenSymbol,
  });
  console.log("[verifyDeploy] All post-deploy invariants verified.");

  if (deployment.messengerMode === "mock") {
    if (
      mockMessengerOwner
        && mockMessengerOwner.toLowerCase() !== deployer.address.toLowerCase()
    ) {
      console.log(
        `MockMessenger owner transferred to: ${deployment.messengerOwner}`,
      );
    } else {
      console.warn(
        "WARNING: MockMessenger owner is the deployer signer. The daemon must " +
          "share that key to plant fixtures, or set " +
          "JINN_MVI_MOCK_MESSENGER_OWNER and re-run. Testnet-only practice.",
      );
    }
  }

  console.log("=== Deployment Summary ===");
  console.log(`  JINN               ${deployment.jinn}`);
  console.log(`  TimelockController ${deployment.timelock}`);
  console.log(`  JinnGovernor       ${deployment.governor}`);
  console.log(`  Messenger          ${deployment.messenger} (mode=${deployment.messengerMode})`);
  console.log(`  JinnDistributor    ${deployment.distributor}`);
  console.log();
  console.log("Notes:");
  console.log("  - JINN.minter is set to JinnDistributor.");
  console.log("  - JINN.owner is now the TimelockController (PENDING acceptance).");
  console.log("  - JinnDistributor.owner is now the TimelockController (PENDING acceptance).");
  if (renounceAdmin) {
    console.log("  - Deployer's optional admin role on the Timelock has been renounced.");
  } else {
    console.log("  - Deployer RETAINS the optional admin role on the Timelock.");
    console.log("    Set JINN_MVI_RENOUNCE_ADMIN=true to enforce mainnet-style renunciation.");
  }
  console.log("  - JinnDistributor.daoTreasury is the TimelockController.");
  console.log();
  console.log("Pending: Timelock must call acceptOwnership() on JINN and JinnDistributor");
  console.log("via the first Governor proposal post-deploy. Until then, governance-mutable");
  console.log("setters (setMinter / setMessenger / setRatios / setWeights) are unreachable.");

  const output = {
    network: networkName,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    config: {
      timingProfile: deployment.config.timingProfile,
      votingDelaySeconds: deployment.config.votingDelaySeconds,
      votingPeriodSeconds: deployment.config.votingPeriodSeconds,
      proposalThreshold: deployment.config.proposalThreshold.toString(),
      quorumNumerator: deployment.config.quorumNumerator,
      timelockMinDelaySeconds: deployment.config.timelockMinDelaySeconds,
    },
    distributor: {
      operatorRatio: deployment.distributorConfig.operatorRatio.toString(),
      daoRatio: deployment.distributorConfig.daoRatio.toString(),
      wTaskCreation: deployment.distributorConfig.wTaskCreation.toString(),
      wSolutionDelivery: deployment.distributorConfig.wSolutionDelivery.toString(),
      wVerdictDelivery: deployment.distributorConfig.wVerdictDelivery.toString(),
    },
    messenger: {
      mode: deployment.messengerMode,
      address: deployment.messenger,
      owner: deployment.messengerOwner,
    },
    handover: {
      renounceAdmin: deployment.adminRenounced,
    },
    contracts: {
      JINN: deployment.jinn,
      TimelockController: deployment.timelock,
      JinnGovernor: deployment.governor,
      JinnDistributor: deployment.distributor,
      Messenger: deployment.messenger,
    },
  };

  const outPath = path.resolve(
    process.cwd(),
    getJinnMviL1DeploymentArtifactName(deployment.config.timingProfile, networkName),
  );
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nDeployment written to: ${outPath}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
