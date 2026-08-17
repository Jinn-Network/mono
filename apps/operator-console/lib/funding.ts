export function formatWeiAsEth(wei: string | undefined): string | undefined {
  if (!wei) return undefined;
  try {
    const value = BigInt(wei);
    const whole = value / 1_000_000_000_000_000_000n;
    const frac = value % 1_000_000_000_000_000_000n;
    const fracStr = frac.toString().padStart(18, '0').slice(0, 3).replace(/0+$/, '');
    return fracStr.length > 0 ? `${whole.toString()}.${fracStr} ETH` : `${whole.toString()} ETH`;
  } catch {
    return undefined;
  }
}

export type FundingSnapshot = {
  mode?: string;
  currentStep?: string;
  funding?: {
    eth_required?: string;
    targetWei?: string;
    eth_balance?: string;
  };
};

export function isAwaitingFunding(bootstrap: FundingSnapshot | null): boolean {
  if (!bootstrap) return false;
  return bootstrap.mode === 'setup' && bootstrap.currentStep === 'awaiting_funding';
}

export function fundingMinimumWei(bootstrap: FundingSnapshot | null): string | undefined {
  return bootstrap?.funding?.targetWei ?? bootstrap?.funding?.eth_required;
}
