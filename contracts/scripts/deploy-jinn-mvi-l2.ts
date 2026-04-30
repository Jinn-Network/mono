/**
 * deploy-jinn-mvi-l2.ts — Phase A6 of the Jinn v0 MVI.
 *
 * Deploys the L2 measurement-side `JinnClaimEmitter` on Base / Base
 * Sepolia. The emitter snapshots three monotonic counters (verified
 * creations + novelty-weighted restoration deliveries from the V2
 * checker, evaluation delivery count from the V2 JinnRouter) plus the
 * service multisig from the OLAS ServiceRegistry, and writes the
 * snapshot hash into a fixed mapping slot. The L1 messenger
 * (CanonicalOpStackMessenger or β2 OP Succinct variant) recovers
 * those values via a canonical OP-Stack storage proof and feeds the
 * recovered tuple into `JinnDistributor.claim`.
 *
 * The emitter constructor enforces `claimSnapshotHashes.slot == 1` via
 * inline assembly — that gate fires here, so a future storage-layout
 * regression on the emitter side would block the L2 deploy.
 *
 * ## Wiring sources
 *
 *   - V2 router + checker addresses come from
 *     `deployment-phase1b-router-checker-{network}{-fast?}.json` (the
 *     phase1b deploy artifact). Override individually with
 *     `JINN_MVI_L2_ROUTER` and `JINN_MVI_L2_CHECKER` if needed.
 *   - The OLAS ServiceRegistry address is chain-pinned (Base Sepolia
 *     default) and overridable via `JINN_MVI_L2_REGISTRY`.
 *
 * ## Output
 *
 * Writes `deployment-jinn-mvi-l2-{network}{-fast?}.json` matching the
 * shape consumed by the daemon — see `client/src/earning/contracts.ts`
 * `JinnMviL2Artifact`. The relevant field is
 * `contracts.JinnClaimEmitter`.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-jinn-mvi-l2.ts --network hardhat
 *   npx hardhat run scripts/deploy-jinn-mvi-l2.ts --network base-sepolia
 *
 * Env vars:
 *   JINN_MVI_L2_CHECKER             override RestorationActivityCheckerV2 address
 *   JINN_MVI_L2_ROUTER              override JinnRouterV2 (proxy) address
 *   JINN_MVI_L2_REGISTRY            override OLAS ServiceRegistry address
 *   JINN_MVI_L2_ARTIFACT_PATH       path to the phase1b deploy artifact
 *                                   (default: alongside this script's
 *                                   working directory)
 *   JINN_MVI_ALLOW_CHAIN            opt in to a non-whitelisted chainId
 *   PHASE1A_TIMING_PROFILE          "canonical" | "fast-test" — selects the
 *                                   phase1b artifact suffix
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import {
  CHAIN_ID_HARDHAT,
  CHAIN_ID_BASE_SEPOLIA,
  CHAIN_ID_BASE_MAINNET,
  JINN_MVI_L2_ALLOWED_CHAINS,
  assertChainIdAllowed,
} from "./lib/jinn-mvi-helpers";

// ---------------------------------------------------------------------------
// Chain-pinned defaults
// ---------------------------------------------------------------------------

/** OLAS ServiceRegistryL2 on Base Sepolia (pinned per scripts/deploy-stolas-l2.ts). */
const OLAS_SERVICE_REGISTRY_BASE_SEPOLIA =
  "0x31D3202d8744B16A120117A053459DDFAE93c855";

interface Phase1bArtifact {
  contracts?: {
    activityChecker?: string;
    jinnRouterProxy?: string;
  };
}

interface JinnMviL2Wiring {
  checker: string;
  router: string;
  registry: string;
}

interface JinnMviL2DeployResult {
  emitter: string;
  wiring: JinnMviL2Wiring;
  txHash: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readPhase1bArtifact(artifactPath: string): Phase1bArtifact {
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `Phase1b deploy artifact not found at ${artifactPath}. ` +
        `Set JINN_MVI_L2_ARTIFACT_PATH or pass --route via env.`,
    );
  }
  const raw = fs.readFileSync(artifactPath, "utf8");
  return JSON.parse(raw) as Phase1bArtifact;
}

/**
 * Resolve the V2 checker + router addresses, preferring explicit env
 * overrides, then falling back to the phase1b deploy artifact.
 */
function resolveCheckerRouter(args: {
  artifactPath?: string;
  env?: Record<string, string | undefined>;
}): { checker: string; router: string } {
  const env = args.env ?? process.env;
  const checker = env.JINN_MVI_L2_CHECKER;
  const router = env.JINN_MVI_L2_ROUTER;
  if (checker && router) {
    return { checker, router };
  }
  if (!args.artifactPath) {
    throw new Error(
      "Phase1b artifact path not provided and JINN_MVI_L2_CHECKER / " +
        "JINN_MVI_L2_ROUTER not set. Pass JINN_MVI_L2_ARTIFACT_PATH or both " +
        "addresses explicitly.",
    );
  }
  const artifact = readPhase1bArtifact(args.artifactPath);
  const fromArtifactChecker = checker ?? artifact.contracts?.activityChecker;
  const fromArtifactRouter = router ?? artifact.contracts?.jinnRouterProxy;
  if (!fromArtifactChecker || !fromArtifactRouter) {
    throw new Error(
      `Phase1b artifact at ${args.artifactPath} is missing ` +
        `contracts.activityChecker or contracts.jinnRouterProxy.`,
    );
  }
  return { checker: fromArtifactChecker, router: fromArtifactRouter };
}

/**
 * Resolve the OLAS ServiceRegistry address for the connected chain.
 * Defaults to the Base Sepolia ServiceRegistryL2; mainnet Base must
 * supply `JINN_MVI_L2_REGISTRY` explicitly.
 */
function resolveServiceRegistry(args: {
  chainId: number;
  env?: Record<string, string | undefined>;
}): string {
  const env = args.env ?? process.env;
  const override = env.JINN_MVI_L2_REGISTRY;
  if (override) return override;
  if (args.chainId === CHAIN_ID_BASE_SEPOLIA) {
    return OLAS_SERVICE_REGISTRY_BASE_SEPOLIA;
  }
  throw new Error(
    `No default ServiceRegistry for chainId ${args.chainId}. ` +
      `Set JINN_MVI_L2_REGISTRY explicitly.`,
  );
}

function getJinnMviL2ArtifactName(networkName: string, fastSuffix: boolean): string {
  const suffix = fastSuffix ? "-fast" : "";
  return `deployment-jinn-mvi-l2-${networkName}${suffix}.json`;
}

function getPhase1bArtifactPath(networkName: string, fastSuffix: boolean): string {
  const suffix = fastSuffix ? "-fast" : "";
  return path.resolve(
    process.cwd(),
    `deployment-phase1b-router-checker-${networkName}${suffix}.json`,
  );
}

/**
 * Deploy `JinnClaimEmitter(checker, router, registry)`. Reads back
 * the immutable wiring from chain and asserts that each field lands
 * on the value passed to the constructor. The constructor itself
 * already gates the storage-slot invariant.
 */
export async function deployJinnMviL2(
  signer: import("ethers").Signer,
  wiring: JinnMviL2Wiring,
): Promise<JinnMviL2DeployResult> {
  const Emitter = await ethers.getContractFactory(
    "src/jinn/cross-chain/JinnClaimEmitter.sol:JinnClaimEmitter",
    signer,
  );
  const emitter = await Emitter.deploy(
    wiring.checker,
    wiring.router,
    wiring.registry,
  );
  const tx = emitter.deploymentTransaction();
  await emitter.waitForDeployment();
  const address = await emitter.getAddress();

  // Sanity: the constructor's slot-pinning assembly already fired. Read
  // back the immutables and assert they round-trip — this catches the
  // unlikely case where the wrong factory is deployed (wrong artifact)
  // and gives the operator a single point of confidence.
  const checkerOnChain: string = await emitter.checker();
  const routerOnChain: string = await emitter.router();
  const registryOnChain: string = await emitter.serviceRegistry();
  if (checkerOnChain.toLowerCase() !== wiring.checker.toLowerCase()) {
    throw new Error(
      `[deployJinnMviL2] checker mismatch: expected ${wiring.checker}, got ${checkerOnChain}`,
    );
  }
  if (routerOnChain.toLowerCase() !== wiring.router.toLowerCase()) {
    throw new Error(
      `[deployJinnMviL2] router mismatch: expected ${wiring.router}, got ${routerOnChain}`,
    );
  }
  if (registryOnChain.toLowerCase() !== wiring.registry.toLowerCase()) {
    throw new Error(
      `[deployJinnMviL2] serviceRegistry mismatch: expected ${wiring.registry}, got ${registryOnChain}`,
    );
  }

  return {
    emitter: address,
    wiring,
    txHash: tx?.hash ?? "(unknown — already mined)",
  };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;
  const chainId = Number(network.chainId);

  // chainId gate: Hardhat + Base Sepolia by default. Mainnet (8453)
  // requires explicit `JINN_MVI_ALLOW_CHAIN=8453` opt-in.
  assertChainIdAllowed({
    chainId,
    allowed: JINN_MVI_L2_ALLOWED_CHAINS,
    scriptName: "Jinn MVI L2 emitter",
  });

  const fastSuffix = (process.env.PHASE1A_TIMING_PROFILE ?? "canonical") === "fast-test";

  // Resolve wiring. On Hardhat tests we tolerate fully-mocked wiring
  // because both the phase1b artifact and the ServiceRegistry are
  // unlikely to exist locally.
  let wiring: JinnMviL2Wiring;
  if (chainId === CHAIN_ID_HARDHAT) {
    const env = process.env;
    if (env.JINN_MVI_L2_CHECKER && env.JINN_MVI_L2_ROUTER && env.JINN_MVI_L2_REGISTRY) {
      wiring = {
        checker: env.JINN_MVI_L2_CHECKER,
        router: env.JINN_MVI_L2_ROUTER,
        registry: env.JINN_MVI_L2_REGISTRY,
      };
    } else {
      // Spin up local mocks so `npx hardhat run` works with no env.
      console.log(
        "Hardhat network detected — deploying mock checker/router/registry stubs.",
      );
      const Checker = await ethers.getContractFactory("MockCheckerV2");
      const checker = await Checker.deploy();
      await checker.waitForDeployment();
      const Router = await ethers.getContractFactory("MockRouterV2");
      const router = await Router.deploy();
      await router.waitForDeployment();
      const Registry = await ethers.getContractFactory("MockServiceRegistryForEmitter");
      const registry = await Registry.deploy();
      await registry.waitForDeployment();
      wiring = {
        checker: await checker.getAddress(),
        router: await router.getAddress(),
        registry: await registry.getAddress(),
      };
    }
  } else {
    // Live / testnet path. Read the phase1b artifact + chain-pinned
    // service registry, allow env overrides for any of the three.
    const normalizedNetwork = networkName === "base-sepolia" ? "baseSepolia" : networkName;
    const phase1bPath =
      process.env.JINN_MVI_L2_ARTIFACT_PATH
        ?? getPhase1bArtifactPath(normalizedNetwork, fastSuffix);
    const checkerRouter = resolveCheckerRouter({ artifactPath: phase1bPath });
    const registry = resolveServiceRegistry({ chainId });
    wiring = {
      checker: checkerRouter.checker,
      router: checkerRouter.router,
      registry,
    };
  }

  console.log("=== Jinn v0 MVI L2 Emitter Deployment ===");
  console.log(`Network:                 ${networkName} (chainId: ${chainId})`);
  console.log(`Deployer:                ${deployer.address}`);
  console.log(
    `Balance:                 ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`,
  );
  console.log(`Activity checker (V2):   ${wiring.checker}`);
  console.log(`JinnRouter (V2 proxy):   ${wiring.router}`);
  console.log(`OLAS ServiceRegistry:    ${wiring.registry}`);
  console.log();

  const result = await deployJinnMviL2(deployer, wiring);

  console.log("=== Deployment Summary ===");
  console.log(`  JinnClaimEmitter   ${result.emitter}`);
  console.log(`  tx                 ${result.txHash}`);
  console.log();

  const normalizedNetwork = networkName === "base-sepolia" ? "baseSepolia" : networkName;
  const artifactName = getJinnMviL2ArtifactName(normalizedNetwork, fastSuffix);
  const output = {
    network: normalizedNetwork,
    chainId,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      JinnClaimEmitter: result.emitter,
      RestorationActivityCheckerV2: wiring.checker,
      JinnRouterV2: wiring.router,
      ServiceRegistry: wiring.registry,
    },
  };
  const outPath = path.resolve(process.cwd(), artifactName);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`Deployment written to: ${outPath}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
