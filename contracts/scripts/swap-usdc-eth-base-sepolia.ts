/**
 * Swap USDC and EURC → native ETH on Base Sepolia via Uniswap V3 (token → WETH → unwrap).
 *
 * Env:
 *   DEPLOYER_PRIVATE_KEY (required)
 *   BASE_SEPOLIA_RPC_URL (optional, default https://sepolia.base.org)
 *   BASE_SEPOLIA_MAX_FEE_GWEI / BASE_SEPOLIA_PRIORITY_FEE_GWEI — gas overrides (see deploy-phase1a-l2)
 *   SWAP_USDC_RESERVE_RAW — optional 6-decimal USDC to leave (default 0)
 *   SWAP_EURC_RESERVE_RAW — optional 6-decimal EURC to leave (default 0)
 *   SWAP_GAS_LIMIT / UNWRAP_GAS_LIMIT — explicit gas (default 400k / 80k)
 *   SWAP_V3_FEE — first fee tier to try for USDC→WETH (default 3000)
 *   SWAP_EURC_V3_FEE — optional first fee for EURC→WETH (default tries 3000, 500, 10000)
 *
 * Run from contracts/: npx hardhat run scripts/swap-usdc-eth-base-sepolia.ts --network baseSepolia
 */

import * as dotenv from "dotenv";
import * as path from "path";
import { Contract, JsonRpcProvider, Wallet, ethers } from "ethers";

dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const CHAIN_ID = 84532n;

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
/** Circle EURC on Base Sepolia (6 decimals). */
const EURC = "0x808456652fdb597867f38412077a9182bf77359f";
const WETH = "0x4200000000000000000000000000000000000006";
const SWAP_ROUTER = "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4";
/** Same CREATE2 address on Base Sepolia; SwapRouter02 pulls via Permit2, not token→router approve. */
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const UNISWAP_V3_FACTORY = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
] as const;

const WETH_ABI = [
  ...ERC20_ABI,
  "function withdraw(uint256)",
] as const;

/** SwapRouter02 / V3SwapRouter: no `deadline` in struct (use multicall deadline variant if needed). */
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)",
] as const;

const PERMIT2_ABI = [
  "function approve(address token, address spender, uint160 amount, uint48 expiration) external",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
] as const;

const V3_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"] as const;
const V3_POOL_ABI = ["function liquidity() view returns (uint128)"] as const;

export function resolveFeeCandidates(initial: number, fallbacks: number[]): number[] {
  return [initial, ...fallbacks].filter((fee, index, arr) => arr.indexOf(fee) === index);
}

export function pickLiquidFeeTier(candidates: Array<{ fee: number; liquidity: bigint }>): number | null {
  const match = candidates.find((candidate) => candidate.liquidity > 0n);
  return match ? match.fee : null;
}

function txFees() {
  const maxFeeGwei = process.env.BASE_SEPOLIA_MAX_FEE_GWEI ?? "2";
  const prioGwei = process.env.BASE_SEPOLIA_PRIORITY_FEE_GWEI ?? "1";
  return {
    maxFeePerGas: ethers.parseUnits(maxFeeGwei, "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits(prioGwei, "gwei"),
  };
}

/** Public RPC eth_estimateGas under-budgets V3 swap+unwrap on Base Sepolia; use explicit limits. */
function swapGasLimit(): bigint {
  const raw = process.env.SWAP_GAS_LIMIT?.trim();
  if (raw) return BigInt(raw);
  return 400_000n;
}

function unwrapGasLimit(): bigint {
  const raw = process.env.UNWRAP_GAS_LIMIT?.trim();
  if (raw) return BigInt(raw);
  return 80_000n;
}

async function swapErc20ToEth(
  wallet: Wallet,
  weth: Contract,
  router: Contract,
  permit2: Contract,
  token: Contract,
  tokenAddress: string,
  label: string,
  amountIn: bigint,
  feeCandidates: number[],
): Promise<void> {
  if (amountIn <= 0n) {
    console.log(`[${label}] Nothing to swap.`);
    return;
  }

  console.log(`[${label}] Swapping amount (raw):`, amountIn.toString());

  const toPermit2: bigint = await token.allowance(wallet.address, PERMIT2);
  if (toPermit2 < amountIn) {
    const approveTx = await token.approve(PERMIT2, ethers.MaxUint256, txFees());
    console.log(`[${label}] → Permit2 approve tx:`, approveTx.hash);
    await approveTx.wait();
  }

  const p2 = await permit2.allowance(wallet.address, tokenAddress, SWAP_ROUTER);
  const p2Amt = BigInt(p2.amount?.toString?.() ?? p2[0]);
  if (p2Amt < amountIn) {
    const expiration = Math.floor(Date.now() / 1000) + 86400 * 365;
    if (expiration > 0xffffffffffff) {
      throw new Error("Permit2 expiration overflow uint48");
    }
    const permitTx = await permit2.approve(tokenAddress, SWAP_ROUTER, amountIn, expiration, txFees());
    console.log(`[${label}] Permit2 → router tx:`, permitTx.hash);
    await permitTx.wait();
  }

  const baseParams = {
    tokenIn: tokenAddress,
    tokenOut: WETH,
    recipient: wallet.address,
    amountIn,
    amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0,
  };

  const feeOpts = { ...txFees(), gasLimit: swapGasLimit() };

  let lastErr: Error | undefined;
  let sawSuccess = false;

  for (const fee of feeCandidates) {
    try {
      const swapTx = await router.exactInputSingle({ ...baseParams, fee }, feeOpts);
      console.log(`[${label}] Swap tx (fee ${fee}):`, swapTx.hash);
      const receipt = await swapTx.wait();
      if (receipt && receipt.status === 1) {
        sawSuccess = true;
        break;
      }
    } catch (e) {
      lastErr = e as Error;
      console.log(`[${label}] Fee ${fee} failed:`, (e as Error).message);
    }
  }

  if (!sawSuccess) {
    throw lastErr ?? new Error(`[${label}] All fee tiers failed`);
  }

  // Avoid `eth_call` with historical blockTag on flaky public RPCs ("header not found").
  const wethBal: bigint = await weth.balanceOf(wallet.address);
  console.log(`[${label}] WETH after swap (raw):`, wethBal.toString());

  if (wethBal > 0n) {
    const unwrapTx = await weth.withdraw(wethBal, { ...txFees(), gasLimit: unwrapGasLimit() });
    console.log(`[${label}] Unwrap tx:`, unwrapTx.hash);
    await unwrapTx.wait();
  }
}

async function eurcWethPoolLiquidFee(
  provider: JsonRpcProvider,
  feeCandidates: number[],
): Promise<{ fee: number | null; liquidity: bigint }> {
  const t0 = WETH.toLowerCase() < EURC.toLowerCase() ? WETH : EURC;
  const t1 = WETH.toLowerCase() < EURC.toLowerCase() ? EURC : WETH;
  const factory = new Contract(UNISWAP_V3_FACTORY, V3_FACTORY_ABI, provider);
  const checks: Array<{ fee: number; liquidity: bigint }> = [];

  for (const fee of feeCandidates) {
    const poolAddr: string = await factory.getPool(t0, t1, fee);
    if (poolAddr === ethers.ZeroAddress) {
      checks.push({ fee, liquidity: 0n });
      continue;
    }
    const pool = new Contract(poolAddr, V3_POOL_ABI, provider);
    const liquidity: bigint = await pool.liquidity();
    checks.push({ fee, liquidity });
  }

  const selectedFee = pickLiquidFeeTier(checks);
  const selected = checks.find((check) => check.fee === selectedFee);
  return { fee: selectedFee, liquidity: selected?.liquidity ?? 0n };
}

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!pk) {
    throw new Error("DEPLOYER_PRIVATE_KEY is required.");
  }

  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== CHAIN_ID) {
    throw new Error(`Expected Base Sepolia chainId ${CHAIN_ID}, got ${network.chainId}`);
  }

  const wallet = new Wallet(pk, provider);
  const usdc = new Contract(USDC, ERC20_ABI, wallet);
  const eurc = new Contract(EURC, ERC20_ABI, wallet);
  const weth = new Contract(WETH, WETH_ABI, wallet);
  const router = new Contract(SWAP_ROUTER, ROUTER_ABI, wallet);
  const permit2 = new Contract(PERMIT2, PERMIT2_ABI, wallet);

  console.log("Signer:", wallet.address);

  const ethBefore = await provider.getBalance(wallet.address);

  const wethStart = await weth.balanceOf(wallet.address);
  if (wethStart > 0n) {
    console.log("Unwrapping existing WETH (raw wei):", wethStart.toString());
    const unwrapStart = await weth.withdraw(wethStart, { ...txFees(), gasLimit: unwrapGasLimit() });
    console.log("Initial unwrap tx:", unwrapStart.hash);
    await unwrapStart.wait();
  }

  const usdcBal: bigint = await usdc.balanceOf(wallet.address);
  const eurcBal: bigint = await eurc.balanceOf(wallet.address);
  console.log("USDC balance (raw):", usdcBal.toString());
  console.log("EURC balance (raw):", eurcBal.toString());

  const usdcReserve = BigInt(process.env.SWAP_USDC_RESERVE_RAW?.trim() ?? "0");
  const usdcIn = usdcBal > usdcReserve ? usdcBal - usdcReserve : 0n;

  const feeEnv = process.env.SWAP_V3_FEE?.trim();
  const usdcFeeFirst = feeEnv ? Number(feeEnv) : 3000;
  const usdcFeeSecond = usdcFeeFirst === 3000 ? 500 : 3000;

  await swapErc20ToEth(wallet, weth, router, permit2, usdc, USDC, "USDC", usdcIn, [usdcFeeFirst, usdcFeeSecond]);

  const eurcReserve = BigInt(process.env.SWAP_EURC_RESERVE_RAW?.trim() ?? "0");
  const eurcIn = eurcBal > eurcReserve ? eurcBal - eurcReserve : 0n;

  if (eurcIn > 0n) {
    const eurcFeeEnv = process.env.SWAP_EURC_V3_FEE?.trim();
    const eurcFees = resolveFeeCandidates(eurcFeeEnv ? Number(eurcFeeEnv) : 3000, [3000, 500, 10000]);
    const eurcPool = await eurcWethPoolLiquidFee(provider, eurcFees);

    if (eurcPool.liquidity === 0n) {
      console.log(
        `[EURC] Uniswap V3 WETH/EURC pools for fee tiers ${eurcFees.join(", ")} have zero liquidity on Base Sepolia — swap would revert. ` +
          "Skip EURC→ETH here; options: bridge to Base mainnet, add testnet LP, or use another venue if one appears.",
      );
    } else {
      await swapErc20ToEth(wallet, weth, router, permit2, eurc, EURC, "EURC", eurcIn, eurcFees);
    }
  }

  const ethAfter = await provider.getBalance(wallet.address);
  console.log("ETH before (wei):", ethBefore.toString());
  console.log("ETH after (wei):", ethAfter.toString());
  console.log("Δ ETH (wei):", (ethAfter - ethBefore).toString());
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
