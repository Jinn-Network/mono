import { expect } from "chai";
import { ethers } from "hardhat";
import type { Signer } from "ethers";
import * as deployL2Module from "../../scripts/deploy-phase1a-l2";
import * as bridgeModule from "../../scripts/deploy-phase1a-bridge";
import * as claimL2Module from "../../scripts/phase1a-claim-l2-rewards";
import * as claimStakingModule from "../../scripts/phase1a-claim-staking-incentives";
import * as maintenanceModule from "../../scripts/phase1a-process-l2-maintenance";
import * as mintVoteModule from "../../scripts/phase1a-mint-jinn-for-vote";
import * as recordActivityModule from "../../scripts/phase1a-record-activity";
import * as statusModule from "../../scripts/status-phase1a-live";
import * as swapModule from "../../scripts/swap-usdc-eth-base-sepolia";
import { deployL1Stack, DEFAULT_DEPLOY_CONFIG } from "../../scripts/lib/deploy-helpers";

function buildStakingParams(serviceRegistry: string, activityChecker: string) {
  return {
    metadataHash: ethers.id("phase1a-rollout-test"),
    maxNumServices: 100,
    rewardsPerSecond: ethers.parseEther("0.0001"),
    minStakingDeposit: ethers.parseEther("10"),
    minNumStakingPeriods: 3,
    maxNumInactivityPeriods: 2,
    livenessPeriod: 86400,
    timeForEmissions: 2592000,
    numAgentInstances: 1,
    agentIds: [] as number[],
    threshold: 0,
    configHash: ethers.ZeroHash,
    proxyHash: ethers.id("proxy-hash-placeholder"),
    serviceRegistry,
    activityChecker,
  };
}

function buildMaintenanceData(target: string, amount: bigint, batchHash: string): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["address[]", "uint256[]", "bytes32"],
    [[target], [amount], batchHash],
  );
}

async function configureTokenomicsForCheckpoint(tokenomicsAddress: string) {
  const tokenomics = await ethers.getContractAt("Tokenomics", tokenomicsAddress);
  const tx = await tokenomics.changeTokenomicsImplementation(tokenomicsAddress);
  await tx.wait();
}

async function advanceEpoch() {
  await ethers.provider.send("evm_increaseTime", [DEFAULT_DEPLOY_CONFIG.epochLen + 1]);
  await ethers.provider.send("evm_mine", []);
}

function loadRolloutHelpers(): Record<string, unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../../scripts/lib/phase1a-rollout-helpers");
  } catch {
    return {};
  }
}

function loadL2TokenCreationModule(): Record<string, unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../../scripts/create-phase1a-l2-token");
  } catch {
    return {};
  }
}

describe("Phase 1a rollout regressions", function () {
  this.timeout(120_000);

  describe("L2 deployment", function () {
    it("resolves Base Sepolia token creation inputs from the L1 artifact", function () {
      const tokenCreation = loadL2TokenCreationModule() as any;
      const resolveTokenCreationConfig = tokenCreation.resolveTokenCreationConfig;

      expect(resolveTokenCreationConfig).to.be.a("function");

      const config = resolveTokenCreationConfig("baseSepolia", {
        env: {
          PHASE1A_L1_DEPLOYMENT: "unused.json",
        },
        l1Deployment: {
          contracts: {
            JINN: "0x00000000000000000000000000000000000000a1",
          },
        },
      });

      expect(config.l1Token).to.equal("0x00000000000000000000000000000000000000a1");
      expect(config.name).to.equal("Jinn");
      expect(config.symbol).to.equal("JINN");
      expect(config.factoryAddress).to.equal("0x4200000000000000000000000000000000000012");
    });

    it("extracts the created L2 token from the mintable factory receipt", function () {
      const tokenCreation = loadL2TokenCreationModule() as any;
      const parseCreatedMintableTokenAddress = tokenCreation.parseCreatedMintableTokenAddress;

      expect(parseCreatedMintableTokenAddress).to.be.a("function");

      const localToken = "0x00000000000000000000000000000000000000b1";
      const remoteToken = "0x00000000000000000000000000000000000000a1";
      const deployer = "0x00000000000000000000000000000000000000d1";
      const factoryInterface = new ethers.Interface([
        "event OptimismMintableERC20Created(address indexed localToken, address indexed remoteToken, address deployer)",
      ]);
      const encodedLog = factoryInterface.encodeEventLog(
        factoryInterface.getEvent("OptimismMintableERC20Created")!,
        [localToken, remoteToken, deployer],
      );

      const address = parseCreatedMintableTokenAddress(
        {
          logs: [
            {
              topics: encodedLog.topics,
              data: encodedLog.data,
            },
          ],
        },
        factoryInterface,
      );

      expect(ethers.getAddress(address)).to.equal(ethers.getAddress(localToken));
    });

    it("returns a factory-backed staking proxy deployment", async function () {
      const [deployer] = await ethers.getSigners();
      const deployment = await deployL2Module.deployL2Stack(deployer);
      const extended = deployment as any;

      expect(extended.stakingFactory, "stakingFactory missing").to.properAddress;
      expect(extended.stakingImplementation, "stakingImplementation missing").to.properAddress;
      expect(extended.jinnTokenSource).to.equal("test");

      const proxy = await ethers.getContractAt("StakingProxy", deployment.stakingToken);
      expect(await proxy.getImplementation()).to.equal(extended.stakingImplementation);

      const factory = await ethers.getContractAt("StakingFactory", extended.stakingFactory);
      expect(await factory.verifyInstance(deployment.stakingToken)).to.equal(true);

      const staking = await ethers.getContractAt("StakingToken", deployment.stakingToken);
      expect(
        await factory.verifyInstanceAndGetEmissionsAmount(deployment.stakingToken),
      ).to.equal(await staking.emissionsAmount());
    });

    it("wires supplied live staking dependencies into the deployed proxy", async function () {
      const [deployer] = await ethers.getSigners();

      const TestERC20 = await ethers.getContractFactory("TestERC20", deployer);
      const token = await TestERC20.deploy("Jinn", "JINN");
      await token.waitForDeployment();

      const ServiceRegistryStub = await ethers.getContractFactory("ServiceRegistryStub", deployer);
      const serviceRegistry = await ServiceRegistryStub.deploy();
      await serviceRegistry.waitForDeployment();

      const TokenUtilityStub = await ethers.getContractFactory("ServiceRegistryTokenUtilityStub", deployer);
      const tokenUtility = await TokenUtilityStub.deploy();
      await tokenUtility.waitForDeployment();

      const proxyHash = ethers.id("safe-proxy-runtime");
      const deployment = await deployL2Module.deployL2Stack(deployer, {
        ...deployL2Module.DEFAULT_L2_CONFIG,
        jinnTokenAddress: await token.getAddress(),
        jinnTokenSource: "external",
        serviceRegistryAddress: await serviceRegistry.getAddress(),
        serviceRegistrySource: "external",
        serviceRegistryTokenUtilityAddress: await tokenUtility.getAddress(),
        serviceRegistryTokenUtilitySource: "external",
        proxyHash,
        proxyHashSource: "external",
      });

      const staking = await ethers.getContractAt("StakingToken", deployment.stakingToken);
      expect(await staking.serviceRegistry()).to.equal(await serviceRegistry.getAddress());
      expect(await staking.serviceRegistryTokenUtility()).to.equal(await tokenUtility.getAddress());
      expect(await staking.proxyHash()).to.equal(proxyHash);
      expect(deployment.jinnToken).to.equal(await token.getAddress());
      expect((deployment as any).jinnTokenSource).to.equal("external");
    });

    it("requires an external L2 token on live networks", function () {
      const resolveConfig = (deployL2Module as any).resolveL2DeployConfig;

      expect(resolveConfig).to.be.a("function");
      expect(() =>
        resolveConfig("baseSepolia", {
          JINN_TOKEN_ADDRESS: "0x00000000000000000000000000000000000000a1",
        }),
      ).to.throw(/SERVICE_REGISTRY_ADDRESS/);

      const config = resolveConfig("baseSepolia", {
        JINN_TOKEN_ADDRESS: "0x00000000000000000000000000000000000000a1",
        SERVICE_REGISTRY_ADDRESS: "0x00000000000000000000000000000000000000a2",
        SERVICE_REGISTRY_TOKEN_UTILITY_ADDRESS: "0x00000000000000000000000000000000000000a3",
        SAFE_PROXY_HASH:
          "0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000",
      });
      expect(config.jinnTokenAddress).to.equal("0x00000000000000000000000000000000000000a1");
      expect(config.jinnTokenSource).to.equal("external");
      expect(config.serviceRegistryAddress).to.equal("0x00000000000000000000000000000000000000a2");
      expect(config.serviceRegistryTokenUtilityAddress).to.equal(
        "0x00000000000000000000000000000000000000a3",
      );
      expect(config.proxyHash).to.equal(
        "0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000",
      );
    });

    it("uses a stable Base Sepolia artifact filename", function () {
      const artifactName = (deployL2Module as any).getL2DeploymentArtifactName;

      expect(artifactName).to.be.a("function");
      expect(artifactName("hardhat")).to.equal("deployment-phase1a-l2-hardhat.json");
      expect(artifactName("baseSepolia")).to.equal("deployment-phase1a-l2-baseSepolia.json");
      expect(artifactName("base-sepolia")).to.equal("deployment-phase1a-l2-baseSepolia.json");
    });

    it("factory verification rejects rogue staking configurations", async function () {
      const [deployer] = await ethers.getSigners();
      const deployment = await deployL2Module.deployL2Stack(deployer);
      const factory = await ethers.getContractAt("StakingFactory", deployment.stakingFactory);

      const StakingToken = await ethers.getContractFactory("StakingToken", deployer);
      const rogueImplementation = await StakingToken.deploy();
      await rogueImplementation.waitForDeployment();

      const initPayload = StakingToken.interface.encodeFunctionData("initialize", [
        buildStakingParams(ethers.Wallet.createRandom().address, deployment.activityChecker),
        deployment.serviceRegistryTokenUtility,
        deployment.jinnToken,
      ]);

      await expect(
        factory.createStakingInstance(await rogueImplementation.getAddress(), initPayload),
      ).to.be.reverted;
    });
  });

  describe("Bridge deployment config", function () {
    it("builds bridge deployment inputs from the L1 and L2 artifacts", function () {
      const resolveBridgeConfig = (bridgeModule as any).resolveBridgeDeployConfig;

      expect(resolveBridgeConfig).to.be.a("function");

      const config = resolveBridgeConfig({
        l1Deployment: {
          contracts: {
            JINN: "0x00000000000000000000000000000000000000a1",
            Dispenser: "0x00000000000000000000000000000000000000b1",
          },
        },
        l2Deployment: {
          contracts: {
            jinnToken: "0x00000000000000000000000000000000000000c1",
            stakingFactory: "0x00000000000000000000000000000000000000d1",
          },
        },
        env: {},
      });

      expect(config.jinnL1).to.equal("0x00000000000000000000000000000000000000a1");
      expect(config.dispenserL1).to.equal("0x00000000000000000000000000000000000000b1");
      expect(config.jinnL2).to.equal("0x00000000000000000000000000000000000000c1");
      expect(config.stakingFactoryL2).to.equal("0x00000000000000000000000000000000000000d1");
    });

    it("rejects legacy L2 artifacts that do not expose a stakingFactory", function () {
      const resolveBridgeConfig = (bridgeModule as any).resolveBridgeDeployConfig;

      expect(resolveBridgeConfig).to.be.a("function");
      expect(() =>
        resolveBridgeConfig({
          l1Deployment: {
            contracts: {
              JINN: "0x00000000000000000000000000000000000000a1",
              Dispenser: "0x00000000000000000000000000000000000000b1",
            },
          },
          l2Deployment: {
            contracts: {
              jinnToken: "0x00000000000000000000000000000000000000c1",
              stakingToken: "0x00000000000000000000000000000000000000d1",
            },
          },
          env: {},
        }),
      ).to.throw(/stakingFactory/i);
    });

    it("uses the actual Hardhat runtime network to choose local vs remote deployment mode", function () {
      const resolveBridgeExecutionMode = (bridgeModule as any).resolveBridgeExecutionMode;

      expect(resolveBridgeExecutionMode).to.be.a("function");
      expect(resolveBridgeExecutionMode("hardhat")).to.equal("local");
      expect(resolveBridgeExecutionMode("sepolia")).to.equal("remote");
      expect(resolveBridgeExecutionMode("baseSepolia")).to.equal("remote");
      expect(resolveBridgeExecutionMode("base-sepolia")).to.equal("remote");
    });

    it("rejects unexpected live chain ids before bridge deployment", function () {
      expect(() => bridgeModule.validateBridgeChainIds(11155111, 84532)).to.not.throw();
      expect(() => bridgeModule.validateBridgeChainIds(1, 84532)).to.throw(/expected 11155111/i);
      expect(() => bridgeModule.validateBridgeChainIds(11155111, 8453)).to.throw(/expected 84532/i);
    });

    it("builds bridge fee, gas, and nonce helpers deterministically", function () {
      const l1Fees = bridgeModule.bridgeTxFees("l1", {
        SEPOLIA_MAX_FEE_GWEI: "13",
        SEPOLIA_PRIORITY_FEE_GWEI: "3",
      });
      const l2Fees = bridgeModule.bridgeTxFees("l2", {
        BASE_SEPOLIA_MAX_FEE_GWEI: "8",
        BASE_SEPOLIA_PRIORITY_FEE_GWEI: "2",
      });
      expect(l1Fees.maxFeePerGas).to.equal(ethers.parseUnits("13", "gwei"));
      expect(l1Fees.maxPriorityFeePerGas).to.equal(ethers.parseUnits("3", "gwei"));
      expect(l2Fees.maxFeePerGas).to.equal(ethers.parseUnits("8", "gwei"));
      expect(l2Fees.maxPriorityFeePerGas).to.equal(ethers.parseUnits("2", "gwei"));

      expect(bridgeModule.bridgeGasLimit("l1Deploy")).to.equal(3_500_000n);
      expect(bridgeModule.bridgeGasLimit("l2Deploy")).to.equal(3_500_000n);
      expect(bridgeModule.bridgeGasLimit("link")).to.equal(300_000n);

      const nextNonce = bridgeModule.createNonceAllocator(41);
      expect(nextNonce({ gasLimit: 1n })).to.deep.equal({ gasLimit: 1n, nonce: 41 });
      expect(nextNonce({ gasLimit: 2n })).to.deep.equal({ gasLimit: 2n, nonce: 42 });
    });
  });

  describe("Rollout helper library", function () {
    it("computes the staking nominee ids used by status and governance scripts", function () {
      const helpers = loadRolloutHelpers() as any;
      const buildStakingNominee = helpers.buildStakingNominee;

      expect(buildStakingNominee).to.be.a("function");

      const stakingToken = "0x00000000000000000000000000000000000000c1";
      const result = buildStakingNominee(stakingToken, 84532);

      const stakingTarget = ethers.zeroPadValue(stakingToken, 32);
      const nomineeHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [stakingTarget, 84532]),
      );

      expect(result.stakingTarget).to.equal(stakingTarget);
      expect(result.nomineeHash).to.equal(nomineeHash);
    });

    it("normalizes the rollout artifact bundle used by bridge and status scripts", function () {
      const helpers = loadRolloutHelpers() as any;
      const resolvePhase1aArtifacts = helpers.resolvePhase1aArtifacts;

      expect(resolvePhase1aArtifacts).to.be.a("function");

      const artifacts = resolvePhase1aArtifacts({
        l1Deployment: {
          contracts: {
            JINN: "0x00000000000000000000000000000000000000a1",
            veOLAS: "0x00000000000000000000000000000000000000a4",
            Dispenser: "0x00000000000000000000000000000000000000b1",
            Tokenomics: "0x00000000000000000000000000000000000000b2",
            VoteWeighting: "0x00000000000000000000000000000000000000b3",
          },
        },
        l2Deployment: {
          contracts: {
            jinnToken: "0x00000000000000000000000000000000000000c1",
            stakingFactory: "0x00000000000000000000000000000000000000c2",
            stakingToken: "0x00000000000000000000000000000000000000c3",
          },
        },
        bridgeDeployment: {
          contracts: {
            depositProcessorL1: "0x00000000000000000000000000000000000000d1",
            targetDispenserL2: "0x00000000000000000000000000000000000000d2",
          },
        },
      });

      expect(artifacts.l1Jinn).to.equal("0x00000000000000000000000000000000000000a1");
      expect(artifacts.veOLASL1).to.equal("0x00000000000000000000000000000000000000a4");
      expect(artifacts.dispenserL1).to.equal("0x00000000000000000000000000000000000000b1");
      expect(artifacts.tokenomicsL1).to.equal("0x00000000000000000000000000000000000000b2");
      expect(artifacts.voteWeightingL1).to.equal("0x00000000000000000000000000000000000000b3");
      expect(artifacts.jinnL2).to.equal("0x00000000000000000000000000000000000000c1");
      expect(artifacts.stakingFactoryL2).to.equal("0x00000000000000000000000000000000000000c2");
      expect(artifacts.stakingTokenL2).to.equal("0x00000000000000000000000000000000000000c3");
      expect(artifacts.depositProcessorL1).to.equal("0x00000000000000000000000000000000000000d1");
      expect(artifacts.targetDispenserL2).to.equal("0x00000000000000000000000000000000000000d2");
    });

    it("treats pause states 0 and 1 as staking-enabled", function () {
      const helpers = loadRolloutHelpers() as any;
      const isStakingIncentivesEnabled = helpers.isStakingIncentivesEnabled;
      const getTargetPauseStateForStaking = helpers.getTargetPauseStateForStaking;

      expect(isStakingIncentivesEnabled).to.be.a("function");
      expect(getTargetPauseStateForStaking).to.be.a("function");

      expect(isStakingIncentivesEnabled(0n)).to.equal(true);
      expect(isStakingIncentivesEnabled(1n)).to.equal(true);
      expect(isStakingIncentivesEnabled(2n)).to.equal(false);
      expect(isStakingIncentivesEnabled(3n)).to.equal(false);

      expect(getTargetPauseStateForStaking(0n)).to.equal(0n);
      expect(getTargetPauseStateForStaking(1n)).to.equal(1n);
      expect(getTargetPauseStateForStaking(2n)).to.equal(1n);
      expect(getTargetPauseStateForStaking(3n)).to.equal(1n);
    });
  });

  describe("Status helper logic", function () {
    it("flags wrong-chain status providers before contract reads", function () {
      expect(statusModule.getStatusNetworkBlockers(11155111, 84532)).to.deep.equal([]);
      expect(statusModule.getStatusNetworkBlockers(1, 84532)).to.deep.equal([
        "L1 provider is on chain 1, expected 11155111.",
      ]);
      expect(statusModule.getStatusNetworkBlockers(11155111, 8453)).to.deep.equal([
        "L2 provider is on chain 8453, expected 84532.",
      ]);
    });

    it("classifies zero nominee bookmark and zero-incentive probes as blockers", function () {
      expect(
        statusModule.getStatusProbeBlockers({
          nomineeBookmark: 0n,
          probeError: null,
          probeResult: null,
          nomineeHash: ethers.ZeroHash,
        }),
      ).to.deep.equal([
        "Dispenser nominee bookmark is still zero. The nominee has not advanced into a claimable epoch yet.",
      ]);

      expect(
        statusModule.getStatusProbeBlockers({
          nomineeBookmark: 2n,
          probeError: null,
          probeResult: {
            stakingIncentive: 0n,
            returnAmount: 0n,
            lastClaimedEpoch: 2n,
            probeNomineeHash: ethers.ZeroHash,
          },
          nomineeHash: ethers.ZeroHash,
        }),
      ).to.deep.equal(["Static staking-incentive probe returned zero claimable JINN."]);
    });

    it("treats target dispenser pause state 1 as unpaused", function () {
      expect(statusModule.isTargetDispenserUnpaused(1n)).to.equal(true);
      expect(statusModule.isTargetDispenserUnpaused(2n)).to.equal(false);
      expect(statusModule.targetDispenserPauseLabel(1n)).to.equal("Unpaused");
      expect(statusModule.targetDispenserPauseLabel(2n)).to.equal("Paused");
    });
  });

  describe("Operator script config", function () {
    it("derives mint-for-vote defaults from the L1 artifact and signer", function () {
      const signer = "0x00000000000000000000000000000000000000c1";
      const config = mintVoteModule.resolveMintForVoteConfig(
        {
          contracts: {
            JINN: "0x00000000000000000000000000000000000000a1",
            Treasury: "0x00000000000000000000000000000000000000b1",
          },
        },
        signer,
        {},
      );

      expect(config.jinn).to.equal("0x00000000000000000000000000000000000000a1");
      expect(config.treasury).to.equal("0x00000000000000000000000000000000000000b1");
      expect(config.recipient).to.equal(signer);
      expect(config.amount).to.equal(ethers.parseEther("100"));
    });

    it("builds staking-claim defaults and optional bridge gas payload", function () {
      const defaultConfig = claimStakingModule.resolveClaimStakingIncentivesConfig(
        "0x00000000000000000000000000000000000000d1",
        {},
      );
      expect(defaultConfig.numClaimedEpochs).to.equal(1n);
      expect(defaultConfig.chainId).to.equal(84532);
      expect(defaultConfig.stakingTarget).to.equal(
        ethers.zeroPadValue("0x00000000000000000000000000000000000000d1", 32),
      );
      expect(defaultConfig.bridgePayload).to.equal("0x");

      const customConfig = claimStakingModule.resolveClaimStakingIncentivesConfig(
        "0x00000000000000000000000000000000000000d1",
        {
          PHASE1A_NUM_CLAIMED_EPOCHS: "3",
          PHASE1A_STAKING_CHAIN_ID: "999",
          PHASE1A_STAKING_TARGET: "0x00000000000000000000000000000000000000e1",
          PHASE1A_BRIDGE_MESSAGE_GAS_LIMIT: "250000",
        },
      );
      expect(customConfig.numClaimedEpochs).to.equal(3n);
      expect(customConfig.chainId).to.equal(999);
      expect(customConfig.stakingTarget).to.equal(
        ethers.zeroPadValue("0x00000000000000000000000000000000000000e1", 32),
      );
      expect(customConfig.bridgePayload).to.equal(
        ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [250000n]),
      );
    });

    it("parses record-activity config from service id or explicit multisig", function () {
      expect(
        recordActivityModule.resolveRecordActivityConfig({
          PHASE1A_SERVICE_ID: "7",
          PHASE1A_ACTIVITY_TYPES: "0, 2",
        }),
      ).to.deep.equal({
        serviceId: 7n,
        multisig: undefined,
        activityTypes: [0, 2],
      });

      expect(
        recordActivityModule.resolveRecordActivityConfig({
          PHASE1A_MULTISIG: "0x00000000000000000000000000000000000000f1",
        }),
      ).to.deep.equal({
        serviceId: undefined,
        multisig: "0x00000000000000000000000000000000000000f1",
        activityTypes: [0, 1, 2],
      });

      expect(() =>
        recordActivityModule.resolveRecordActivityConfig({
          PHASE1A_ACTIVITY_TYPES: "3",
        }),
      ).to.throw(/0, 1, or 2/i);
    });

    it("requires a service id for L2 claims and defaults to checkpointAndClaim", function () {
      expect(() => claimL2Module.resolveClaimL2Config({})).to.throw(/PHASE1A_SERVICE_ID/i);
      expect(
        claimL2Module.resolveClaimL2Config({
          PHASE1A_SERVICE_ID: "9",
        }),
      ).to.include({
        serviceId: 9n,
        mode: "checkpointAndClaim",
      });
      expect(
        claimL2Module.resolveClaimL2Config({
          PHASE1A_SERVICE_ID: "9",
          PHASE1A_L2_CLAIM_MODE: "claim",
        }),
      ).to.include({
        serviceId: 9n,
        mode: "claim",
      });
    });

    it("derives the Safe-owner keystore path from the earning dir and supports dry-run", function () {
      expect(
        claimL2Module.resolveClaimL2KeystorePath({
          PHASE1A_EARNING_DIR: "/tmp/phase1a-earning",
        }),
      ).to.equal("/tmp/phase1a-earning/agent_keystore.json");

      expect(
        claimL2Module.resolveClaimL2KeystorePath({
          PHASE1A_SAFE_OWNER_KEYSTORE_PATH: "/tmp/custom-owner.json",
          PHASE1A_EARNING_DIR: "/tmp/ignored",
        }),
      ).to.equal("/tmp/custom-owner.json");

      expect(
        claimL2Module.resolveClaimL2Config({
          PHASE1A_SERVICE_ID: "9",
          PHASE1A_DRY_RUN: "true",
          PHASE1A_EARNING_DIR: "/tmp/phase1a-earning",
        }),
      ).to.include({
        serviceId: 9n,
        mode: "checkpointAndClaim",
        dryRun: true,
        safeOwnerKeystorePath: "/tmp/phase1a-earning/agent_keystore.json",
      });
    });

    it("encodes maintenance payloads from raw bytes or structured env vars", function () {
      const rawData = "0x1234";
      expect(
        maintenanceModule.resolveMaintenanceConfig({
          PHASE1A_MAINTENANCE_DATA: rawData,
          PHASE1A_UPDATE_WITHHELD_AMOUNT: "true",
        }),
      ).to.deep.equal({
        data: rawData,
        updateWithheldAmount: true,
      });

      const target = "0x00000000000000000000000000000000000000a5";
      const amount = "42";
      const batchHash = ethers.keccak256(ethers.toUtf8Bytes("batch"));
      expect(
        maintenanceModule.resolveMaintenanceConfig({
          PHASE1A_MAINTENANCE_TARGET: target,
          PHASE1A_MAINTENANCE_AMOUNT: amount,
          PHASE1A_MAINTENANCE_BATCH_HASH: batchHash,
        }),
      ).to.deep.equal({
        data: buildMaintenanceData(target, 42n, batchHash),
        updateWithheldAmount: false,
      });
    });
  });

  describe("Swap helper logic", function () {
    it("dedupes fee candidates while preserving priority order", function () {
      expect(swapModule.resolveFeeCandidates(500, [3000, 500, 10000])).to.deep.equal([500, 3000, 10000]);
      expect(swapModule.resolveFeeCandidates(3000, [3000, 500, 10000])).to.deep.equal([3000, 500, 10000]);
    });

    it("selects the first liquid EURC fee tier instead of assuming 0.3%", function () {
      expect(
        swapModule.pickLiquidFeeTier([
          { fee: 3000, liquidity: 0n },
          { fee: 500, liquidity: 123n },
          { fee: 10000, liquidity: 999n },
        ]),
      ).to.equal(500);
      expect(
        swapModule.pickLiquidFeeTier([
          { fee: 3000, liquidity: 0n },
          { fee: 500, liquidity: 0n },
        ]),
      ).to.equal(null);
    });
  });

  describe("Target dispenser delivery", function () {
    let deployer: Signer;
    let deployerAddress: string;
    let deployment: any;
    let token: any;
    let factoryAddress: string;

    beforeEach(async function () {
      [deployer] = await ethers.getSigners();
      deployerAddress = await deployer.getAddress();
      deployment = await deployL2Module.deployL2Stack(deployer);
      token = await ethers.getContractAt("TestERC20", deployment.jinnToken);
      factoryAddress = (deployment as any).stakingFactory;
      expect(factoryAddress, "stakingFactory missing").to.properAddress;
    });

    it("withholds funds for a non-factory staking target", async function () {
      const StakingToken = await ethers.getContractFactory("StakingToken", deployer);
      const standalone = await StakingToken.deploy();
      await standalone.waitForDeployment();

      const initTx = await standalone.initialize(
        buildStakingParams(deployment.serviceRegistry, deployment.activityChecker),
        deployment.serviceRegistryTokenUtility,
        deployment.jinnToken,
      );
      await initTx.wait();

      const TargetDispenser = await ethers.getContractFactory("OptimismTargetDispenserL2", deployer);
      const targetDispenser = await TargetDispenser.deploy(
        deployment.jinnToken,
        factoryAddress,
        deployerAddress,
        ethers.Wallet.createRandom().address,
        11155111,
      );
      await targetDispenser.waitForDeployment();

      const amount = ethers.parseEther("25");
      await token.mint(await targetDispenser.getAddress(), amount);

      const batchHash = ethers.keccak256(ethers.toUtf8Bytes("non-factory-target"));
      const tx = await targetDispenser.processDataMaintenance(
        buildMaintenanceData(await standalone.getAddress(), amount, batchHash),
        false,
      );
      await tx.wait();

      expect(await targetDispenser.withheldAmount()).to.equal(amount);
      expect(await standalone.availableRewards()).to.equal(0);
    });

    it("deposits bridged rewards into the verified factory staking proxy", async function () {
      const TargetDispenser = await ethers.getContractFactory("OptimismTargetDispenserL2", deployer);
      const targetDispenser = await TargetDispenser.deploy(
        deployment.jinnToken,
        factoryAddress,
        deployerAddress,
        ethers.Wallet.createRandom().address,
        11155111,
      );
      await targetDispenser.waitForDeployment();

      const amount = ethers.parseEther("25");
      await token.mint(await targetDispenser.getAddress(), amount);

      const staking = await ethers.getContractAt("StakingToken", deployment.stakingToken);
      const batchHash = ethers.keccak256(ethers.toUtf8Bytes("verified-target"));
      const tx = await targetDispenser.processDataMaintenance(
        buildMaintenanceData(deployment.stakingToken, amount, batchHash),
        false,
      );
      await tx.wait();

      expect(await targetDispenser.withheldAmount()).to.equal(0);
      expect(await staking.balance()).to.equal(amount);
      expect(await staking.availableRewards()).to.equal(amount);
    });
  });

  describe("Nominee epoch bookmark", function () {
    it("requires a later epoch after nominee registration before claiming begins", async function () {
      const [deployer] = await ethers.getSigners();
      const l1 = await deployL1Stack(deployer);
      await configureTokenomicsForCheckpoint(await l1.tokenomics.getAddress());

      await l1.dispenser.setPauseState(0);

      const stakingTargetAddress = ethers.Wallet.createRandom().address;
      const chainId = 84532;
      const stakingTarget = ethers.zeroPadValue(stakingTargetAddress, 32);

      await l1.voteWeighting.addNomineeEVM(stakingTargetAddress, chainId);

      await expect(
        l1.dispenser.calculateStakingIncentives.staticCall(1, chainId, stakingTarget, 18),
      ).to.be.reverted;

      await advanceEpoch();
      await l1.tokenomics.checkpoint();

      const result = await l1.dispenser.calculateStakingIncentives.staticCall(
        1,
        chainId,
        stakingTarget,
        18,
      );
      expect(result[2]).to.equal(2n);
    });
  });
});
