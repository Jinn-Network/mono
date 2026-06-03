import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

// HH3 + EDR async-revert noise guard.
// When a tx is asserted to revert via `expect(...).to.be.revertedWithCustomError`,
// EDR's automatic gas-estimation pass emits a *second*, async copy of the same
// revert as a process-level unhandled rejection (name === "SolidityError").
// @nomicfoundation/hardhat-mocha only swallows unhandled rejections whose name is
// "AssertionError" (its missing-await guard), so the SolidityError copy reaches
// Node's default `--unhandled-rejections=throw` and crashes the test process
// mid-suite (HH2 never threw on these). The chai matcher has already asserted the
// revert, so this duplicate is pure noise. Swallow exactly that one class; rethrow
// everything else so genuine unhandled rejections still fail loud.
process.on("unhandledRejection", (reason) => {
  if (reason instanceof Error && reason.name === "SolidityError") {
    return;
  }
  throw reason;
});

const optimizerSettings = {
  optimizer: {
    enabled: true,
    runs: 1000000,
  },
  viaIR: true,
};

// Tokenomics and Dispenser exceed the 24KB contract size limit with high
// optimizer runs. Use fewer runs to reduce bytecode size.
const largeContractSettings = {
  optimizer: {
    enabled: true,
    runs: 200,
  },
  viaIR: true,
};

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    // HH3 only emits standalone artifacts for npm-dependency contracts listed
    // here (HH2 emitted one for every compiled contract). deploy-jinn-mvi-l1.ts
    // deploys OZ's TimelockController by fully-qualified name, so its artifact
    // must be emitted even though it appears only as a constructor-param type.
    npmFilesToBuild: ["@openzeppelin/contracts/governance/TimelockController.sol"],
    compilers: [
      { version: "0.8.25", settings: optimizerSettings },
      { version: "0.8.28", settings: optimizerSettings },
      { version: "0.8.30", settings: { ...optimizerSettings, evmVersion: "cancun" } },
    ],
    overrides: {
      "src/vendor/tokenomics/Tokenomics.sol": {
        version: "0.8.30",
        settings: largeContractSettings,
      },
      "src/vendor/tokenomics/Dispenser.sol": {
        version: "0.8.25",
        settings: largeContractSettings,
      },
    },
  },
  paths: {
    sources: "./src",
    // HH3 globs every `.sol` under the Solidity-tests path as a compilation
    // root. The Foundry invariant suite (test/jinn/invariants/*.t.sol) lives
    // under ./test and depends on forge-std/lib (a Foundry-only submodule
    // Hardhat must not resolve). Scope HH's Solidity-test discovery to a
    // dedicated empty dir so it never picks up the Foundry .t.sol files;
    // keep Mocha discovery (the .ts unit tests) pointed at ./test.
    tests: {
      mocha: "./test",
      solidity: "./test/solidity",
    },
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainType: "op",
      chainId: 8453,
    },
    localhost: {
      type: "http",
      url: process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545",
      chainId: process.env.LOCAL_CHAIN_ID ? Number(process.env.LOCAL_CHAIN_ID) : 31337,
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
      chainId: 11155111,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
    baseSepolia: {
      type: "http",
      chainType: "op",
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
    base: {
      type: "http",
      chainType: "op",
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      chainId: 8453,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
  },
  verify: {
    etherscan: {
      apiKey: process.env.BASESCAN_API_KEY || "",
    },
  },
});
