/**
 * Setup Display Utilities
 *
 * Clean, user-friendly progress display for yarn setup.
 * Replaces verbose logging with step-by-step visual output.
 */

export type StepStatus = 'pending' | 'active' | 'done' | 'error';

const BOX_WIDTH = 60;

/**
 * Print the setup header banner
 */
export function printHeader(title: string = 'JINN Node Setup'): void {
  const line = '─'.repeat(BOX_WIDTH - 2);
  console.log(`\n┌${line}┐`);
  console.log(`│  ${title.padEnd(BOX_WIDTH - 5)}│`);
  console.log(`└${line}┘\n`);
}

/**
 * Print a step with status indicator
 */
export function printStep(status: StepStatus, label: string, detail?: string): void {
  const icons: Record<StepStatus, string> = {
    pending: '[ ]',
    active: '[→]',
    done: '[✓]',
    error: '[✗]',
  };

  const icon = icons[status];
  console.log(`  ${icon} ${label}`);

  if (detail) {
    console.log(`      └─ ${detail}`);
  }
}

/**
 * Print a prominent funding requirement box
 */
export function printFundingBox(params: {
  purpose: string;
  address: string;
  amount: string;
  token: string;
  network: string;
}): void {
  const { purpose, address, amount, token, network } = params;
  const innerWidth = BOX_WIDTH - 4;

  console.log('');
  console.log('╔' + '═'.repeat(BOX_WIDTH - 2) + '╗');
  console.log('║  💰 FUNDING REQUIRED' + ' '.repeat(innerWidth - 19) + '║');
  console.log('╠' + '═'.repeat(BOX_WIDTH - 2) + '╣');
  console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');
  console.log(`║  ${purpose}:`.padEnd(BOX_WIDTH - 1) + '║');
  console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');
  console.log(`║  Address: ${address}`.padEnd(BOX_WIDTH - 1) + '║');
  console.log(`║  Amount:  ${amount} ${token}`.padEnd(BOX_WIDTH - 1) + '║');
  console.log(`║  Network: ${network}`.padEnd(BOX_WIDTH - 1) + '║');
  console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');
  console.log('║  Checking balance every 10 seconds...'.padEnd(BOX_WIDTH - 1) + '║');
  console.log('║  Press Ctrl+C to exit'.padEnd(BOX_WIDTH - 1) + '║');
  console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');
  console.log('╚' + '═'.repeat(BOX_WIDTH - 2) + '╝');
  console.log('');
}

/**
 * Print multiple funding requirements at once
 */
export function printFundingRequirements(requirements: Array<{
  purpose: string;
  address: string;
  amount: string;
  token: string;
}>, network: string = 'Base'): void {
  if (requirements.length === 0) return;

  const innerWidth = BOX_WIDTH - 4;

  console.log('');
  console.log('╔' + '═'.repeat(BOX_WIDTH - 2) + '╗');
  console.log('║  💰 FUNDING REQUIRED' + ' '.repeat(innerWidth - 19) + '║');
  console.log('╠' + '═'.repeat(BOX_WIDTH - 2) + '╣');

  for (const req of requirements) {
    console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');
    console.log(`║  ${req.purpose}:`.padEnd(BOX_WIDTH - 1) + '║');
    console.log(`║    Address: ${req.address}`.padEnd(BOX_WIDTH - 1) + '║');
    console.log(`║    Amount:  ${req.amount} ${req.token}`.padEnd(BOX_WIDTH - 1) + '║');
  }

  console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');
  console.log(`║  Network: ${network}`.padEnd(BOX_WIDTH - 1) + '║');
  console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');
  console.log('║  Checking balance every 10 seconds...'.padEnd(BOX_WIDTH - 1) + '║');
  console.log('║  Press Ctrl+C to exit'.padEnd(BOX_WIDTH - 1) + '║');
  console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');
  console.log('╚' + '═'.repeat(BOX_WIDTH - 2) + '╝');
  console.log('');
}

/**
 * Print success summary
 */
export function printSuccess(result: {
  serviceConfigId?: string;
  serviceSafeAddress?: string;
}): void {
  const line = '═'.repeat(BOX_WIDTH - 2);

  console.log('');
  console.log('╔' + line + '╗');
  console.log('║  ✅ SETUP COMPLETED SUCCESSFULLY' + ' '.repeat(BOX_WIDTH - 35) + '║');
  console.log('╠' + line + '╣');
  console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');

  if (result.serviceConfigId) {
    console.log(`║  Service Config ID: ${result.serviceConfigId}`.padEnd(BOX_WIDTH - 1) + '║');
  }
  if (result.serviceSafeAddress) {
    console.log(`║  Service Safe: ${result.serviceSafeAddress}`.padEnd(BOX_WIDTH - 1) + '║');
  }

  console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');
  console.log('║  Next: Run the worker with `yarn worker`'.padEnd(BOX_WIDTH - 1) + '║');
  console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');
  console.log('╚' + line + '╝');
  console.log('');
}

/**
 * Print error box
 */
export function printError(message: string): void {
  console.log('');
  console.log('╔' + '═'.repeat(BOX_WIDTH - 2) + '╗');
  console.log('║  ❌ SETUP FAILED' + ' '.repeat(BOX_WIDTH - 19) + '║');
  console.log('╠' + '═'.repeat(BOX_WIDTH - 2) + '╣');
  console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');

  // Word wrap the message
  const maxLineLength = BOX_WIDTH - 6;
  const words = message.split(' ');
  let currentLine = '';

  for (const word of words) {
    if ((currentLine + ' ' + word).trim().length > maxLineLength) {
      console.log(`║  ${currentLine.padEnd(BOX_WIDTH - 4)}║`);
      currentLine = word;
    } else {
      currentLine = (currentLine + ' ' + word).trim();
    }
  }
  if (currentLine) {
    console.log(`║  ${currentLine.padEnd(BOX_WIDTH - 4)}║`);
  }

  console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');
  console.log('╚' + '═'.repeat(BOX_WIDTH - 2) + '╝');
  console.log('');
}

/**
 * Print a simple info message
 */
export function printInfo(message: string): void {
  console.log(`  ℹ️  ${message}`);
}

/**
 * Print a warning message
 */
export function printWarning(message: string): void {
  console.log(`  ⚠️  ${message}`);
}

/**
 * Clear line and print polling status (for in-place updates)
 */
export function printPollingStatus(secondsElapsed: number): void {
  process.stdout.write(`\r  Waiting for funding... (${secondsElapsed}s elapsed)`);
}

/**
 * Clear the polling line
 */
export function clearPollingStatus(): void {
  process.stdout.write('\r' + ' '.repeat(60) + '\r');
}

/**
 * Print stOLAS intro banner
 */
export function printStolasIntro(): void {
  const line = '═'.repeat(BOX_WIDTH - 2);

  console.log('');
  console.log('╔' + line + '╗');
  console.log('║  stOLAS Setup — No OLAS Required' + ' '.repeat(BOX_WIDTH - 35) + '║');
  console.log('╠' + line + '╣');
  console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');
  console.log('║  Staking is funded by LemonTree depositors.'.padEnd(BOX_WIDTH - 1) + '║');
  console.log('║  You only need ETH for gas (~0.01 ETH).'.padEnd(BOX_WIDTH - 1) + '║');
  console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');
  console.log('║  Flow: stake() -> discover service -> import config'.padEnd(BOX_WIDTH - 1) + '║');
  console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');
  console.log('╚' + line + '╝');
  console.log('');
}

/**
 * Print stOLAS success summary
 */
export function printStolasSuccess(result: {
  serviceId: number;
  serviceConfigId: string;
  multisig: string;
  operatorAddress: string;
  masterEoaAddress?: string;
  masterSafeAddress?: string;
  mechAddress?: string;
  mechDeployError?: string;
}): void {
  const line = '═'.repeat(BOX_WIDTH - 2);

  console.log('');
  console.log('╔' + line + '╗');
  console.log('║  stOLAS SETUP COMPLETE' + ' '.repeat(BOX_WIDTH - 25) + '║');
  console.log('╠' + line + '╣');
  console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');
  console.log(`║  Service ID:  ${result.serviceId}`.padEnd(BOX_WIDTH - 1) + '║');
  console.log(`║  Config ID:   ${result.serviceConfigId}`.padEnd(BOX_WIDTH - 1) + '║');
  console.log(`║  Service Safe: ${result.multisig}`.padEnd(BOX_WIDTH - 1) + '║');
  console.log(`║  Agent EOA:   ${result.operatorAddress}`.padEnd(BOX_WIDTH - 1) + '║');
  if (result.masterSafeAddress) {
    console.log(`║  Master Safe: ${result.masterSafeAddress}`.padEnd(BOX_WIDTH - 1) + '║');
  }
  if (result.mechAddress) {
    console.log(`║  Mech:        ${result.mechAddress}`.padEnd(BOX_WIDTH - 1) + '║');
  } else {
    console.log('║  Mech:        pending deployment'.padEnd(BOX_WIDTH - 1) + '║');
  }
  console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');
  console.log('║  OLAS staked: 0 (funded by LemonTree)'.padEnd(BOX_WIDTH - 1) + '║');
  console.log('║  Owner: Master Safe (consistent with existing services)'.padEnd(BOX_WIDTH - 1) + '║');
  console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');
  if (result.mechDeployError) {
    console.log('║  Mech deployment deferred:'.padEnd(BOX_WIDTH - 1) + '║');
    // Word wrap the error message
    const maxLen = BOX_WIDTH - 8;
    const words = result.mechDeployError.split(' ');
    let currentLine = '';
    for (const word of words) {
      if ((currentLine + ' ' + word).trim().length > maxLen) {
        console.log(`║    ${currentLine.padEnd(BOX_WIDTH - 6)}║`);
        currentLine = word;
      } else {
        currentLine = (currentLine + ' ' + word).trim();
      }
    }
    if (currentLine) {
      console.log(`║    ${currentLine.padEnd(BOX_WIDTH - 6)}║`);
    }
    console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');
  }
  console.log('║  Next: Run the worker with `yarn worker`'.padEnd(BOX_WIDTH - 1) + '║');
  console.log('║' + ' '.repeat(BOX_WIDTH - 2) + '║');
  console.log('╚' + line + '╝');
  console.log('');
}
