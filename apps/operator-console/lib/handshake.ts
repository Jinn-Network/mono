import {
  CONSOLE_CONTRACT_VERSION,
  type ContractVersion,
} from './contract-version';
import { daemonFetch } from './daemon';

export type HandshakeVerdict =
  | { status: 'ok'; server: ContractVersion; console: ContractVersion }
  | {
      status: 'warn';
      reason: 'minor_mismatch';
      server: ContractVersion;
      console: ContractVersion;
    }
  | {
      status: 'incompatible';
      reason: 'major_mismatch';
      server: ContractVersion;
      console: ContractVersion;
    };

export function compareContractVersion(
  server: ContractVersion,
  consoleVersion: ContractVersion = CONSOLE_CONTRACT_VERSION,
): HandshakeVerdict {
  if (server.major !== consoleVersion.major) {
    return {
      status: 'incompatible',
      reason: 'major_mismatch',
      server,
      console: consoleVersion,
    };
  }
  if (server.minor !== consoleVersion.minor) {
    return {
      status: 'warn',
      reason: 'minor_mismatch',
      server,
      console: consoleVersion,
    };
  }
  return { status: 'ok', server, console: consoleVersion };
}

export type HandshakeResult =
  | HandshakeVerdict
  | { status: 'unreachable'; error: string }
  | { status: 'invalid'; error: string };

/**
 * Handshake reads GET /v1/status — never /health or /ready, which omit
 * contractVersion by design (headless §8 artifact 1).
 */
export async function handshakeWithDaemon(): Promise<HandshakeResult> {
  let response: Response;
  try {
    response = await daemonFetch('/v1/status');
  } catch (err) {
    return {
      status: 'unreachable',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!response.ok) {
    return { status: 'unreachable', error: `status ${response.status}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: 'invalid', error: 'status payload is not JSON' };
  }
  const version = readContractVersion(body);
  if (!version) {
    return { status: 'invalid', error: 'status payload omitted contractVersion' };
  }
  return compareContractVersion(version);
}

export function readContractVersion(body: unknown): ContractVersion | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const raw = (body as { contractVersion?: unknown }).contractVersion;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const major = (raw as { major?: unknown }).major;
  const minor = (raw as { minor?: unknown }).minor;
  if (typeof major !== 'number' || typeof minor !== 'number') return undefined;
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return undefined;
  if (major < 0 || minor < 0) return undefined;
  return { major, minor };
}
