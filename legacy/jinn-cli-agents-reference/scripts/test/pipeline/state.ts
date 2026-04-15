/**
 * Gate Runner state management + session log.
 *
 * State file: `.tmp/gate-runner/state.json`
 * Session log: `.tmp/gate-runner/session-log.md`
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { ensureDir, nowIso } from '../railway/common.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GateStatus = 'PENDING' | 'PASS' | 'FAIL' | 'SKIP';
export type Tier = 'unit' | 'inspect' | 'tenderly' | 'canary' | 'smoke';
export type Profile = 'quick' | 'standard' | 'full';

export interface GateResult {
  status: GateStatus;
  attempts: number;
  detail?: string;
  lastError?: string;
}

export interface Fix {
  gate: string;
  commit: string;
  description: string;
  timestamp: string;
}

export interface EphemeralServices {
  worker?: string;
  gateway?: string;
  workerProject?: string;
  gatewayProject?: string;
}

export interface PipelineState {
  runId: string;
  branch: string;
  profile: Profile;
  startedAt: string;
  currentTier: Tier;
  ephemeralServices: EphemeralServices;
  gates: Record<string, GateResult>;
  fixes: Fix[];
  recoveryNotes: string;
}

// ---------------------------------------------------------------------------
// Tier ordering & profile mapping
// ---------------------------------------------------------------------------

const TIER_ORDER: Tier[] = ['unit', 'inspect', 'tenderly', 'canary', 'smoke'];

const PROFILE_TIERS: Record<Profile, Tier[]> = {
  quick: ['unit', 'inspect'],
  standard: ['unit', 'inspect', 'tenderly'],
  full: ['unit', 'inspect', 'tenderly', 'canary', 'smoke'],
};

export function tiersForProfile(profile: Profile): Tier[] {
  return PROFILE_TIERS[profile];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DEFAULT_RUN_DIR = resolve(process.cwd(), '.tmp', 'gate-runner');

export function statePath(runDir = DEFAULT_RUN_DIR): string {
  return resolve(runDir, 'state.json');
}

export function sessionLogPath(runDir = DEFAULT_RUN_DIR): string {
  return resolve(runDir, 'session-log.md');
}

// ---------------------------------------------------------------------------
// State CRUD
// ---------------------------------------------------------------------------

export async function loadState(runDir = DEFAULT_RUN_DIR): Promise<PipelineState | null> {
  const path = statePath(runDir);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as PipelineState;
}

export async function saveState(state: PipelineState, runDir = DEFAULT_RUN_DIR): Promise<void> {
  const path = statePath(runDir);
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

export async function initState(
  branch: string,
  profile: Profile,
  gateIds: string[],
  runDir = DEFAULT_RUN_DIR,
): Promise<PipelineState> {
  const gates: Record<string, GateResult> = {};
  for (const id of gateIds) {
    gates[id] = { status: 'PENDING', attempts: 0 };
  }

  const state: PipelineState = {
    runId: `${branch.replace(/\//g, '-')}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`,
    branch,
    profile,
    startedAt: nowIso(),
    currentTier: TIER_ORDER[0],
    ephemeralServices: {},
    gates,
    fixes: [],
    recoveryNotes: '',
  };

  await saveState(state, runDir);
  await initSessionLog(state, runDir);
  return state;
}

export function updateGate(
  state: PipelineState,
  gateId: string,
  update: Partial<GateResult>,
): void {
  const existing = state.gates[gateId];
  if (!existing) {
    state.gates[gateId] = { status: 'PENDING', attempts: 0, ...update };
  } else {
    Object.assign(existing, update);
  }
}

export function addFix(state: PipelineState, fix: Omit<Fix, 'timestamp'>): void {
  state.fixes.push({ ...fix, timestamp: nowIso() });
}

// ---------------------------------------------------------------------------
// Tier navigation
// ---------------------------------------------------------------------------

export function getNextTier(state: PipelineState, gateTiers: Record<string, Tier>): Tier | null {
  const activeTiers = tiersForProfile(state.profile);

  for (const tier of activeTiers) {
    const tierGates = Object.entries(state.gates).filter(([id]) => gateTiers[id] === tier);
    const hasPendingOrFail = tierGates.some(
      ([, result]) => result.status === 'PENDING' || result.status === 'FAIL',
    );
    if (hasPendingOrFail) return tier;
  }

  return null; // all done
}

export function getRetryableGates(
  state: PipelineState,
  tier: Tier,
  gateTiers: Record<string, Tier>,
  maxAttempts = 3,
): string[] {
  return Object.entries(state.gates)
    .filter(
      ([id, result]) =>
        gateTiers[id] === tier &&
        (result.status === 'FAIL' || result.status === 'PENDING') &&
        result.attempts < maxAttempts,
    )
    .map(([id]) => id);
}

export function gateCountsByStatus(state: PipelineState): Record<GateStatus, number> {
  const counts: Record<GateStatus, number> = { PENDING: 0, PASS: 0, FAIL: 0, SKIP: 0 };
  for (const result of Object.values(state.gates)) {
    counts[result.status] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Session log
// ---------------------------------------------------------------------------

const LOG_HEADER_DELIMITER = '\n---\n';

async function initSessionLog(state: PipelineState, runDir = DEFAULT_RUN_DIR): Promise<void> {
  const path = sessionLogPath(runDir);
  await ensureDir(dirname(path));

  const header = renderLogHeader(state);
  await writeFile(path, `${header}${LOG_HEADER_DELIMITER}\n`, 'utf-8');
}

function renderLogHeader(state: PipelineState): string {
  const counts = gateCountsByStatus(state);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const lines = [
    `# Gate Runner Session — ${state.branch}`,
    `Branch: ${state.branch} | Profile: ${state.profile} | Started: ${state.startedAt}`,
    `Status: IN_PROGRESS | Current tier: ${state.currentTier} | Gates: ${counts.PASS}/${total} PASS, ${counts.FAIL} FAIL, ${counts.PENDING} PENDING`,
    '',
    '## Recovery Instructions',
    '1. Read this file top-to-bottom for full context',
    '2. Read `.tmp/gate-runner/state.json` for current gate statuses',
    '3. Run `bd prime` to restore beads context',
    '4. Resume from the last log entry below',
  ];
  return lines.join('\n');
}

export async function updateLogHeader(state: PipelineState, runDir = DEFAULT_RUN_DIR): Promise<void> {
  const path = sessionLogPath(runDir);
  if (!existsSync(path)) return;

  const content = await readFile(path, 'utf-8');
  const delimIndex = content.indexOf(LOG_HEADER_DELIMITER);
  if (delimIndex === -1) return;

  const body = content.slice(delimIndex);
  const header = renderLogHeader(state);
  await writeFile(path, `${header}${body}`, 'utf-8');
}

export async function appendLog(
  entry: string,
  runDir = DEFAULT_RUN_DIR,
): Promise<void> {
  const path = sessionLogPath(runDir);
  if (!existsSync(path)) {
    await ensureDir(dirname(path));
    await writeFile(path, '', 'utf-8');
  }

  const timestamp = new Date().toISOString().slice(11, 19); // HH:MM:SS
  const formatted = `\n## [${timestamp}] ${entry}\n`;
  const existing = await readFile(path, 'utf-8');
  await writeFile(path, existing + formatted, 'utf-8');
}

// Convenience log helpers
export async function logTierStart(tier: Tier, detail: string, runDir?: string): Promise<void> {
  await appendLog(`Tier: ${tier} — START\n${detail}`, runDir);
}

export async function logTierPass(tier: Tier, detail: string, runDir?: string): Promise<void> {
  await appendLog(`Tier: ${tier} — PASS\n${detail}`, runDir);
}

export async function logTierFail(tier: Tier, detail: string, runDir?: string): Promise<void> {
  await appendLog(`Tier: ${tier} — FAIL\n${detail}`, runDir);
}

export async function logGateFail(gateId: string, error: string, rootCause: string, filesToCheck: string[], runDir?: string): Promise<void> {
  const files = filesToCheck.map((f) => `- ${f}`).join('\n');
  await appendLog(
    `Gate ${gateId} — FAIL\n${error}\n**Root cause**: ${rootCause}\n**Files to check**:\n${files}`,
    runDir,
  );
}

export async function logFix(gateId: string, fix: { file: string; change: string; commit: string; subtreePushed: boolean }, runDir?: string): Promise<void> {
  await appendLog(
    `FIX: ${gateId}\n- File: \`${fix.file}\`\n- Change: ${fix.change}\n- Commit: \`${fix.commit}\`\n- Subtree pushed: ${fix.subtreePushed ? 'yes' : 'no'}`,
    runDir,
  );
}

export async function logRetry(gateId: string, attempt: number, runDir?: string): Promise<void> {
  await appendLog(`RETRY: ${gateId} (attempt ${attempt})`, runDir);
}

// Pipeline evolution log helpers

export async function logPipelineFix(gateId: string, fix: { file: string; oldPattern: string; newPattern: string; commit: string }, runDir?: string): Promise<void> {
  await appendLog(
    `PIPELINE_FIX: ${gateId}\n- File: \`${fix.file}\`\n- Old: ${fix.oldPattern}\n- New: ${fix.newPattern}\n- Commit: \`${fix.commit}\``,
    runDir,
  );
}

export async function logNewGate(gate: { id: string; name: string; tier: string; rationale: string }, runDir?: string): Promise<void> {
  await appendLog(
    `NEW_GATE: ${gate.id}\n- Name: ${gate.name}\n- Tier: ${gate.tier}\n- Rationale: ${gate.rationale}`,
    runDir,
  );
}

export async function logGateProposal(proposal: { id: string; tier: string; name: string; rationale: string; suggestedCheck: string; files: string[] }, runDir?: string): Promise<void> {
  const files = proposal.files.map((f) => `- ${f}`).join('\n');
  await appendLog(
    `GATE_PROPOSAL: ${proposal.id}\n- Tier: ${proposal.tier}\n- Name: ${proposal.name}\n- Rationale: ${proposal.rationale}\n- Suggested check: ${proposal.suggestedCheck}\n**Files**:\n${files}`,
    runDir,
  );
}

export async function logGateRetired(gateId: string, reason: string, runDir?: string): Promise<void> {
  await appendLog(`GATE_RETIRED: ${gateId}\n- Reason: ${reason}`, runDir);
}

export async function logRetrospective(summary: { codeFixes: number; codeFixesWithGates: number; pipelineFixes: number; gateProposals: string[]; newGates: string[]; gatesRetired: number; totalBefore: number; totalAfter: number }, runDir?: string): Promise<void> {
  const proposals = summary.gateProposals.length > 0
    ? summary.gateProposals.map((p) => `  - ${p}`).join('\n')
    : '  (none)';
  const newGates = summary.newGates.length > 0
    ? summary.newGates.map((g) => `  - ${g}`).join('\n')
    : '  (none)';
  await appendLog(
    `RETROSPECTIVE\n- Code fixes: ${summary.codeFixes} (${summary.codeFixesWithGates} had new gates added)\n- Pipeline fixes: ${summary.pipelineFixes}\n- Gate proposals:\n${proposals}\n- New gates added:\n${newGates}\n- Gates retired: ${summary.gatesRetired}\n- Coverage delta: was ${summary.totalBefore} gates, now ${summary.totalAfter} gates`,
    runDir,
  );
}
