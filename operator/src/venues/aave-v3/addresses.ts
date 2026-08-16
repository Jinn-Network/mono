export interface AaveReserveAddressSet {
  pool: `0x${string}`;
  reserve: `0x${string}`;
  symbol: string;
}

export const AAVE_V3_USDC: Record<'aave-v3-base-sepolia' | 'aave-v3-base' | 'aave-v3-mainnet', AaveReserveAddressSet> = {
  'aave-v3-base-sepolia': {
    // Base Sepolia pool proxy + USDC reserve (Aave v3 test deployment).
    pool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
    reserve: '0x31d3A7711a10C45D72649D51E1c8D74282702572',
    symbol: 'USDC',
  },
  'aave-v3-base': {
    pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    reserve: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    symbol: 'USDC',
  },
  'aave-v3-mainnet': {
    pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    reserve: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    symbol: 'USDC',
  },
};
