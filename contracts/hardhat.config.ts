import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

// HH3 + EDR async-revert noise guard (remove-and-rewrap).
//
// When a tx is asserted to revert via `expect(...).to.be.revertedWithCustomError`,
// EDR's automatic gas-estimation pass (AutomaticGasHandler.getMultipliedGasEstimation)
// re-runs the same tx and sometimes loses the race to attach the chai matcher's
// `.catch`, emitting a *second*, async copy of the revert as a process-level
// unhandled rejection (name === "SolidityError"). The chai matcher has already
// asserted the revert synchronously, so this async copy is pure noise — but the
// crash is real: Hardhat's CLI registers its OWN unhandledRejection listener at
// startup (cli/.../global-error-handlers.js) that calls `process.exit(1)`. Node
// runs EVERY registered listener on each rejection, so a second listener that
// merely returns CANNOT cancel Hardhat's already-registered exit — the suite
// crashes mid-run (~28% of default-mode runs; reproduced here ~14%).
//
// The fix is to *remove* Hardhat's listener rather than race it: capture the
// existing unhandledRejection listeners, clear them, then install ONE
// replacement that ignores the benign SolidityError copy and re-dispatches every
// other rejection to the captured originals — so genuine unhandled rejections
// still hit Hardhat's `process.exit(1)` exactly as intended. This config is
// evaluated AFTER Hardhat's CLI registers its handler (verified: one listener is
// present at config-eval time), so the capture is non-empty. If that ever stops
// holding (capturedListeners empty), the rewrap still installs a fail-loud
// fallback that rethrows non-SolidityError rejections.
{
  const capturedListeners = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", (reason, promise) => {
    if (reason instanceof Error && reason.name === "SolidityError") {
      return; // benign async copy of an already-asserted revert — drop it
    }
    if (capturedListeners.length > 0) {
      for (const original of capturedListeners) {
        original.call(process, reason, promise);
      }
    } else {
      // Nothing was registered to delegate to — stay fail-loud.
      throw reason;
    }
  });
}

const optimizerSettings = {
  optimizer: {
    enabled: true,
    runs: 1000000,
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
    // Size-biased settings for the revised router (prepare + spentOut accounting).
    overrides: {
      "src/staking/JinnRouterV4.sol": {
        version: "0.8.30",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          viaIR: true,
          evmVersion: "cancun",
        },
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
      accounts: process.env.LOCAL_PRIVATE_KEY
        ? [process.env.LOCAL_PRIVATE_KEY]
        : [],
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
