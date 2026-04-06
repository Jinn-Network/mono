import { ethers } from 'ethers';

export function formatOLAS(wei: bigint): string {
  const num = parseFloat(ethers.formatEther(wei));
  return num.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function formatVeOLAS(wei: bigint): string {
  return formatOLAS(wei);
}

export function formatPercent(value: number, decimals = 2): string {
  return `${value.toFixed(decimals)}%`;
}

export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function chainName(chainId: number): string {
  switch (chainId) {
    case 1: return 'Ethereum';
    case 8453: return 'Base';
    case 100: return 'Gnosis';
    case 10: return 'OP';
    case 34443: return 'Mode';
    case 137: return 'Polygon';
    default: return `Chain ${chainId}`;
  }
}

export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
