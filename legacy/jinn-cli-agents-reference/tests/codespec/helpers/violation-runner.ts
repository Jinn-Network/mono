// @ts-nocheck
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import { Ledger } from '../../../codespec/lib/ledger.js';

const execAsync = promisify(exec);

export interface ViolationRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  violations: number;
  ledgerUpdated: boolean;
}

/**
 * Runs the detect-violations script and returns results
 */
export async function runDetectViolations(
  target: string,
  options: { cwd?: string; timeout?: number } = {}
): Promise<ViolationRunResult> {
  const { cwd = process.cwd(), timeout = 120000 } = options;

  try {
    const { stdout, stderr } = await execAsync(
      `./codespec/scripts/detect-violations.sh ${target}`,
      { cwd, timeout, encoding: 'utf-8' }
    );

    // Extract violation count from output
    const violations = extractViolationCount(stdout);

    // Check if ledger was updated
    const ledgerUpdated = await checkLedgerUpdated(cwd);

    return {
      exitCode: 0,
      stdout,
      stderr,
      violations,
      ledgerUpdated,
    };
  } catch (error: any) {
    const violations = extractViolationCount(error.stdout || '');
    const ledgerUpdated = await checkLedgerUpdated(cwd);

    return {
      exitCode: error.code || 1,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      violations,
      ledgerUpdated,
    };
  }
}

/**
 * Runs a specific objective review (obj1, obj2, or obj3)
 */
export async function runObjectiveReview(
  objective: 'obj1' | 'obj2' | 'obj3',
  target: string,
  options: { cwd?: string; timeout?: number } = {}
): Promise<ViolationRunResult> {
  const { cwd = process.cwd(), timeout = 120000 } = options;

  try {
    const { stdout, stderr } = await execAsync(
      `./codespec/scripts/review-${objective}.sh ${target}`,
      { cwd, timeout, encoding: 'utf-8' }
    );

    const violations = extractViolationCount(stdout);
    const ledgerUpdated = await checkLedgerUpdated(cwd);

    return {
      exitCode: 0,
      stdout,
      stderr,
      violations,
      ledgerUpdated,
    };
  } catch (error: any) {
    const violations = extractViolationCount(error.stdout || '');
    const ledgerUpdated = await checkLedgerUpdated(cwd);

    return {
      exitCode: error.code || 1,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      violations,
      ledgerUpdated,
    };
  }
}

/**
 * Extracts violation count from script output
 */
function extractViolationCount(output: string): number {
  // Look for "Total violations found: N" or "Found N violation(s)"
  const match = output.match(/(?:Total violations found|Found):\s*(\d+)/i) ||
                output.match(/Found\s+(\d+)\s+.*violation/i) ||
                output.match(/(\d+)\s+violation/i);

  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Checks if ledger file exists and has content
 */
async function checkLedgerUpdated(cwd: string): Promise<boolean> {
  try {
    const ledgerPath = `${cwd}/.codespec/ledger.jsonl`;
    const content = await readFile(ledgerPath, 'utf-8');
    return content.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Gets ledger statistics
 */
export async function getLedgerStats(cwd: string) {
  const ledger = new Ledger(`${cwd}/.codespec/ledger.jsonl`);
  return ledger.getStats();
}

/**
 * Gets all violations from ledger
 */
export async function getAllViolations(cwd: string) {
  const ledger = new Ledger(`${cwd}/.codespec/ledger.jsonl`);
  return ledger.getAll();
}

/**
 * Gets open violations from ledger
 */
export async function getOpenViolations(cwd: string) {
  const ledger = new Ledger(`${cwd}/.codespec/ledger.jsonl`);
  return ledger.getAllOpen();
}

/**
 * Waits for ledger to be updated (polls for changes)
 * @deprecated No longer needed with synchronous ledger updates.
 * Kept for backwards compatibility but immediately returns ledger state.
 */
export async function waitForLedgerUpdate(
  cwd: string,
  timeout = 10000
): Promise<boolean> {
  // With synchronous ledger updates, no need to wait/poll
  // Just check if ledger exists immediately
  return await checkLedgerUpdated(cwd);
}
