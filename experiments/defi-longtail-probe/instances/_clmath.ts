// Float64 concentrated-liquidity math for verifier tolerance checks (all
// tolerances ≥ 15bps; double precision error is ~1e-16 relative — fine).
export function tickToPrice(tick: number): number {
  return 1.0001 ** tick; // raw token1-per-token0 (USDC-6dp per WETH-wei here)
}

export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint): number {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  return s * s;
}

/** Token amounts for a position, standard Uniswap-v3 piecewise formulas. */
export function amountsForLiquidity(liquidity: bigint, tickLower: number, tickUpper: number, sqrtPriceX96: bigint): { amount0: number; amount1: number } {
  const L = Number(liquidity);
  const sa = Math.sqrt(tickToPrice(tickLower));
  const sb = Math.sqrt(tickToPrice(tickUpper));
  const sp = Number(sqrtPriceX96) / 2 ** 96;
  if (sp <= sa) return { amount0: L * (sb - sa) / (sa * sb), amount1: 0 };
  if (sp >= sb) return { amount0: 0, amount1: L * (sb - sa) };
  return { amount0: L * (sb - sp) / (sp * sb), amount1: L * (sp - sa) };
}

/** Position value denominated in token1 raw units (USDC 6dp for WETH/USDC). */
export function positionValueToken1(liquidity: bigint, tickLower: number, tickUpper: number, sqrtPriceX96: bigint): number {
  const { amount0, amount1 } = amountsForLiquidity(liquidity, tickLower, tickUpper, sqrtPriceX96);
  return amount0 * sqrtPriceX96ToPrice(sqrtPriceX96) + amount1;
}
