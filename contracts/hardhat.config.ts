import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

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
