/**
 * CLI argument and amount parsing for operator withdraw script.
 */

import { getAddress, isAddress } from 'viem';

export type WithdrawParsedArgs = {
  help: boolean;
  dryRun: boolean;
  yes: boolean;
  json: boolean;
  human: boolean;
  to: `0x${string}` | null;
  jinnWei: bigint | null;
  drainJinn: boolean;
  ethWei: bigint | null;
  drainEth: boolean;
  sweepAgents: boolean;
  minSweepWei: bigint;
  masterGasReserveWei: bigint;
};

const ZERO = 0n;

export function parseEtherToWei(input: string): bigint {
  const s = input.trim();
  if (!s) throw new Error('Empty ETH amount');
  if (!/^\d*\.?\d+$/.test(s)) {
    throw new Error(`Invalid ETH amount: ${input}`);
  }
  const [whole, frac = ''] = s.split('.');
  const wholePart = whole === '' ? '0' : whole;
  if (!/^\d+$/.test(wholePart)) throw new Error(`Invalid ETH amount: ${input}`);
  if (frac.length > 18) {
    throw new Error('ETH amount must have at most 18 decimal places');
  }
  const fracPadded = (frac + '0'.repeat(18)).slice(0, 18);
  const wei = BigInt(wholePart) * 10n ** 18n + BigInt(fracPadded || '0');
  return wei;
}

/** Parse a decimal token amount into wei given token decimals (default 18). */
export function parseTokenDecimalToWei(input: string, decimals: number): bigint {
  if (decimals < 0 || decimals > 36) {
    throw new Error(`Unsupported token decimals: ${decimals}`);
  }
  const s = input.trim();
  if (!s) throw new Error('Empty token amount');
  if (!/^\d*\.?\d+$/.test(s)) {
    throw new Error(`Invalid token amount: ${input}`);
  }
  const [whole, frac = ''] = s.split('.');
  const wholePart = whole === '' ? '0' : whole;
  if (!/^\d+$/.test(wholePart)) throw new Error(`Invalid token amount: ${input}`);
  if (frac.length > decimals) {
    throw new Error(`Token amount must have at most ${decimals} decimal places`);
  }
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const scale = 10n ** BigInt(decimals);
  const wei = BigInt(wholePart) * scale + BigInt(fracPadded || '0');
  return wei;
}

export function parsePositiveWeiString(input: string, label: string): bigint {
  const s = input.trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(`${label} must be a non-negative integer string (wei), got: ${input}`);
  }
  const v = BigInt(s);
  if (v <= ZERO) {
    throw new Error(`${label} must be positive`);
  }
  return v;
}

function takeFlag(argv: string[], name: string): boolean {
  const idx = argv.indexOf(name);
  if (idx === -1) return false;
  argv.splice(idx, 1);
  return true;
}

function takeValue(argv: string[], name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx === -1) return null;
  const v = argv[idx + 1];
  if (v === undefined || v.startsWith('--')) {
    throw new Error(`Missing value for ${name}`);
  }
  argv.splice(idx, 2);
  return v;
}

/**
 * Parse withdraw CLI argv (typically process.argv.slice(2)).
 * Mutates a copy of argv only — pass a slice if you need to preserve process.argv.
 */
export function parseWithdrawArgv(argv: string[]): WithdrawParsedArgs {
  const args = [...argv];
  const help = takeFlag(args, '--help') || takeFlag(args, '-h');
  const dryRun = takeFlag(args, '--dry-run');
  const yes = takeFlag(args, '--yes');
  const json = takeFlag(args, '--json');
  const human = takeFlag(args, '--human');
  const drainJinn = takeFlag(args, '--drain-jinn');
  const drainEth = takeFlag(args, '--drain-eth');
  const sweepAgents = takeFlag(args, '--sweep-agents');

  const toRaw = takeValue(args, '--to');
  let to: `0x${string}` | null = null;
  if (toRaw !== null) {
    if (!isAddress(toRaw)) {
      throw new Error(`Invalid --to address: ${toRaw}`);
    }
    to = getAddress(toRaw) as `0x${string}`;
  }

  let jinnWei: bigint | null = null;
  const jinnWeiStr = takeValue(args, '--jinn-wei');
  const jinnAmount = takeValue(args, '--jinn-amount');
  const amountAlias = takeValue(args, '--amount');
  if ([jinnAmount, amountAlias].filter(Boolean).length > 1) {
    throw new Error('Use only one of --jinn-amount or --amount');
  }
  const jinnDecimal = jinnAmount ?? amountAlias;
  if (jinnWeiStr !== null && jinnDecimal !== null) {
    throw new Error('Use only one of --jinn-wei or --jinn-amount/--amount');
  }
  if (jinnWeiStr !== null) {
    jinnWei = parsePositiveWeiString(jinnWeiStr, '--jinn-wei');
  }
  if (jinnDecimal !== null) {
    jinnWei = parseTokenDecimalToWei(jinnDecimal, 18);
    if (jinnWei <= ZERO) throw new Error('--jinn-amount/--amount must be positive');
  }
  if (drainJinn && jinnWei !== null) {
    throw new Error('Cannot combine --drain-jinn with --jinn-amount/--amount/--jinn-wei');
  }

  let ethWei: bigint | null = null;
  const ethWeiStr = takeValue(args, '--eth-wei');
  const ethAmount = takeValue(args, '--eth-amount');
  if (ethWeiStr !== null && ethAmount !== null) {
    throw new Error('Use only one of --eth-wei or --eth-amount');
  }
  if (ethWeiStr !== null) {
    ethWei = parsePositiveWeiString(ethWeiStr, '--eth-wei');
  }
  if (ethAmount !== null) {
    ethWei = parseEtherToWei(ethAmount);
    if (ethWei <= ZERO) throw new Error('--eth-amount must be positive');
  }
  if (drainEth && ethWei !== null) {
    throw new Error('Cannot combine --drain-eth with --eth-amount/--eth-wei');
  }

  const minSweepRaw = takeValue(args, '--min-sweep-wei');
  let minSweepWei = 1_000_000_000_000_000n; // 0.001 ETH default dust floor
  if (minSweepRaw !== null) {
    minSweepWei = parsePositiveWeiString(minSweepRaw, '--min-sweep-wei');
  }

  const reserveRaw = takeValue(args, '--master-gas-reserve-wei');
  let masterGasReserveWei = 2_500_000_000_000_000n; // 0.0025 ETH default
  if (reserveRaw !== null) {
    const s = reserveRaw.trim();
    if (!/^\d+$/.test(s)) {
      throw new Error('--master-gas-reserve-wei must be a non-negative integer wei string');
    }
    masterGasReserveWei = BigInt(s);
  }

  const configIdx = args.indexOf('--config');
  if (configIdx !== -1) {
    const configPath = args[configIdx + 1];
    if (configPath === undefined || configPath.startsWith('--')) {
      throw new Error('Missing value for --config');
    }
    args.splice(configIdx, 2);
  }

  const passwordFdIdx = args.indexOf('--password-fd');
  if (passwordFdIdx !== -1) {
    const fdVal = args[passwordFdIdx + 1];
    if (fdVal === undefined || fdVal.startsWith('--')) {
      throw new Error('Missing value for --password-fd');
    }
    args.splice(passwordFdIdx, 2);
  }

  if (args.length > 0) {
    throw new Error(`Unexpected arguments: ${args.join(' ')}`);
  }

  return {
    help,
    dryRun,
    yes,
    json,
    human,
    to,
    jinnWei,
    drainJinn,
    ethWei,
    drainEth,
    sweepAgents,
    minSweepWei,
    masterGasReserveWei,
  };
}

export function withdrawArgsNeedMasterTransfer(p: WithdrawParsedArgs): boolean {
  return p.jinnWei !== null || p.drainJinn || p.ethWei !== null || p.drainEth;
}

export function validateWithdrawArgs(p: WithdrawParsedArgs): void {
  const needsTo = withdrawArgsNeedMasterTransfer(p) || p.sweepAgents;
  if (needsTo && !p.to) {
    throw new Error('--to <address> is required for transfers or --sweep-agents');
  }
  if (!needsTo && !p.help) {
    throw new Error(
      'Nothing to do: specify --jinn-amount/--amount/--jinn-wei/--drain-jinn, --eth-amount/--eth-wei/--drain-eth, and/or --sweep-agents',
    );
  }
}
