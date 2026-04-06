import pino from 'pino';
import { formatEther } from 'viem';
import { buildLogger } from './factory.js';

const { logger: rootLogger, flush: flushDestination, destination } = buildLogger();

export const logger = rootLogger;

export async function flushLogger(): Promise<void> {
  await flushDestination();
}

function flushLoggerSync(): void {
  if (!destination) {
    return;
  }
  if (typeof destination.flushSync === 'function') {
    destination.flushSync();
    return;
  }

  if (typeof destination.flush === 'function') {
    destination.flush(() => { });
  }
}

export function createChildLogger(component: string): pino.Logger {
  return logger.child({ component });
}

function withHelpers<T extends pino.Logger, H extends Record<string, unknown>>(child: T, helpers: H): T & H {
  return Object.assign(child, helpers);
}

const baseWalletLogger = createChildLogger('WALLET');
export const walletLogger = withHelpers(baseWalletLogger, {
  success(message: string) {
    baseWalletLogger.info(message);
  },
});

const baseWorkerLogger = createChildLogger('WORKER');
export const workerLogger: pino.Logger & { success: (message: string) => void } = withHelpers(baseWorkerLogger, {
  success(message: string) {
    baseWorkerLogger.info(message);
  },
});

export const configLogger = createChildLogger('CONFIG');

const baseAgentLogger = createChildLogger('AGENT');
export const agentLogger = withHelpers(baseAgentLogger, {
  // Exception: Uses process.stdout.write for subprocess stdout forwarding (per spec: "Subprocess streaming in process managers")
  // This forwards Gemini CLI output directly to stdout, bypassing pino-pretty to prevent line wrapping of JSON
  output(message: string) {
    // Sanitize message to prevent terminal corruption from raw buffer data
    // Keep printable ASCII (32-126), whitespace, newlines, and standard ANSI color codes
    // But strip other control characters that crash xterm.js (like DEL=127)
    // eslint-disable-next-line no-control-regex
    const sanitized = message.replace(/[^\x20-\x7E\s\n\r\t\x1b]/g, '');
    process.stdout.write(`\x1b[95m${sanitized}\x1b[0m\n`);
  },
  thinking(message: string) {
    baseAgentLogger.debug({ agentThinking: true }, message);
  },
});

const baseJobLogger = createChildLogger('JOB');
export const jobLogger = withHelpers(baseJobLogger, {
  started(jobId: string, model: string) {
    baseJobLogger.info({ jobId, model }, 'Job execution started');
  },
  completed(jobId: string) {
    baseJobLogger.info({ jobId }, 'Job completed successfully');
  },
  failed(jobId: string, reason: string) {
    baseJobLogger.error({ jobId, reason }, 'Job failed');
  },
  retry(jobId: string, attempt: number, maxRetries: number) {
    baseJobLogger.warn({ jobId, attempt, maxRetries }, `Job retry attempt ${attempt}/${maxRetries}`);
  },
});

const baseMcpLogger = createChildLogger('MCP');
export const mcpLogger = withHelpers(baseMcpLogger, {
  toolCall(toolName: string, params?: unknown) {
    baseMcpLogger.debug({ toolName, params }, 'Tool call executed');
  },
  toolError(toolName: string, error: string) {
    baseMcpLogger.error({ toolName, error }, 'Tool call failed');
  },
});

export const scriptLogger = createChildLogger('SCRIPT');

export function serializeError(err: Error | unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      type: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return { message: String(err) };
}

export function formatAddress(address: string, label?: string): string {
  const formatted = address.startsWith('0x') ? address : `0x${address}`;
  return label ? `${label}: ${formatted}` : formatted;
}

export function formatWeiToEth(wei: bigint): string {
  const eth = formatEther(wei);
  if (eth.includes('.')) {
    return eth.replace(/\.?0+$/, '');
  }
  return eth;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  return `${minutes.toFixed(1)}m`;
}

export function exitWithCode(
  code: 0 | 1 | 2 | 3 | 4 | 5,
  message: string,
  error?: Error
): never {
  switch (code) {
    case 0:
      logger.info({ exitCode: code }, message);
      break;
    case 1:
      logger.fatal({ exitCode: code, error }, message);
      break;
    case 2:
      configLogger.fatal({ exitCode: code, error }, `Configuration Error: ${message}`);
      break;
    case 3:
      walletLogger.warn({ exitCode: code }, `Funding Required: ${message}`);
      break;
    case 4:
      walletLogger.fatal({ exitCode: code, error }, `On-Chain Conflict: ${message}`);
      break;
    case 5:
      logger.fatal({ exitCode: code, error }, `RPC/Network Error: ${message}`);
      break;
  }

  flushLoggerSync();
  process.exit(code);
}
