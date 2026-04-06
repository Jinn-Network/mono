import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import * as path from "path";

// Load env from parent directory
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.25",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000000,
      },
      viaIR: true,
    },
  },
  paths: {
    sources: "./staking",
    tests: "./test",
    cache: "./cache",
    artifacts: "./staking/artifacts",
  },
  networks: {
    hardhat: {
      chainId: 8453,
      forking: {
        url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
        enabled: false,
      },
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: process.env.DEPLOYER_PRIVATE_KEY 
        ? [process.env.DEPLOYER_PRIVATE_KEY] 
        : [],
    },
    base: {
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      chainId: 8453,
      accounts: process.env.DEPLOYER_PRIVATE_KEY 
        ? [process.env.DEPLOYER_PRIVATE_KEY] 
        : [],
    },
  },
  etherscan: {
    // hardhat-verify v2 uses a single Etherscan API key for supported chains,
    // including Base and Base Sepolia.
    apiKey: process.env.BASESCAN_API_KEY || "",
  },
};

export default config;
