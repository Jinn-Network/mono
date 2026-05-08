import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { api } from '../../api/client.js';
import type {
  DraftSolverNetRecord,
  DraftSolverNetRecordPatch,
  LaunchActionPhase,
  LaunchedSolverNetRecord,
} from '../../api/types.js';
import { ensureCompletedStep, formatEthFromWei } from './draft-helpers.js';
import { FieldShell, StepNav, StepShell } from './StepShell.js';
import { PREDICTION_V1_TEMPLATE, type CreateWizardTemplate } from './templates.js';

/**
 * Step 5 — Review the manifest summary, pick `openRoles`, and Launch.
 *
 * The Launch button calls `api.solvernets.launch(draftId)`, then polls
 * `api.solvernets.get(solverNetId)` every `POLL_INTERVAL_MS` until
 * either:
 *
 *   - `status === 'launched'`     → navigate to `/launcher/launched/:id`
 *   - `status === 'failed'`       → render error with retry / abandon
 *   - `launchProgress.txError`    → surfaced in the progress strip
 *
 * Phases progress through `pinning → recording → broadcasting →
 * confirming → spawning`. The progress strip shows which phase is
 * currently active.
 */

const POLL_INTERVAL_MS = 1500;

export const LAUNCH_PHASES: ReadonlyArray<LaunchActionPhase> = [
  'pinning',
  'recording',
  'broadcasting',
  'confirming',
  'spawning',
];

const PHASE_LABELS: Record<LaunchActionPhase, string> = {
  pinning: 'Pinning manifest',
  recording: 'Recording draft',
  broadcasting: 'Broadcasting tx',
  confirming: 'Confirming on-chain',
  spawning: 'Spawning generator',
};

export interface Step5ReviewLaunchProps {
  draft: DraftSolverNetRecord;
  /**
   * Active template. Defaults to {@link PREDICTION_V1_TEMPLATE} so existing
   * tests render without explicitly threading a template through; the wizard
   * always passes the URL-selected template explicitly.
   */
  template?: CreateWizardTemplate;
  /** Used to update `openRoles` on the draft as the operator toggles checkboxes. */
  onUpdateDraft: (patch: DraftSolverNetRecordPatch) => Promise<void> | void;
  onBack: () => void;
  /**
   * Called on launch failure — the parent (`LauncherCreate`) clears
   * launch-in-flight state so the operator can retry.
   */
  onLaunchFailure?: () => void;
  /**
   * Optional override for navigation; defaults to `wouter.useLocation`.
   * Tests pass a stub.
   */
  navigateTo?: (path: string) => void;
  /**
   * Optional poll interval override (used by tests to drive the loop
   * without long sleeps).
   */
  pollIntervalMs?: number;
}

type LaunchUiState =
  | { kind: 'idle' }
  | { kind: 'launching'; phase: LaunchActionPhase; solverNetId: string }
  | { kind: 'failed'; message: string; solverNetId?: string };

export function Step5ReviewLaunch({
  draft,
  template = PREDICTION_V1_TEMPLATE,
  onUpdateDraft,
  onBack,
  onLaunchFailure,
  navigateTo,
  pollIntervalMs = POLL_INTERVAL_MS,
}: Step5ReviewLaunchProps): JSX.Element {
  const [, navigateHook] = useLocation();
  const navigate = navigateTo ?? navigateHook;

  const initialOpenRoles = useMemo<Array<'solver' | 'evaluator'>>(
    () => (draft.openRoles && draft.openRoles.length > 0 ? draft.openRoles : ['solver', 'evaluator']),
    [draft.openRoles],
  );
  const [openRoles, setOpenRoles] = useState<Array<'solver' | 'evaluator'>>(initialOpenRoles);
  const [launchState, setLaunchState] = useState<LaunchUiState>({ kind: 'idle' });
  const cancelledRef = useRef(false);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const toggleRole = (role: 'solver' | 'evaluator'): void => {
    setOpenRoles((prev) => {
      if (prev.includes(role)) return prev.filter((r) => r !== role);
      return [...prev, role];
    });
  };

  const launch = async (): Promise<void> => {
    if (openRoles.length === 0) return;
    setLaunchState((prev) =>
      prev.kind === 'failed' ? { kind: 'idle' } : prev,
    );
    cancelledRef.current = false;

    try {
      // Persist the latest openRoles + mark the step complete on the
      // draft before kicking off the launch — the daemon's launch
      // endpoint reads `openRoles` straight off the draft.
      await onUpdateDraft({
        openRoles,
        completedSteps: ensureCompletedStep(draft.completedSteps, 'configurePricing'),
      });

      const action = await api.solvernets.launch(draft.draftId);
      if (cancelledRef.current) return;

      // First record fetch — the daemon tries to wait for the initial
      // record to land on disk, but may still return before pinning
      // completes.
      let phase: LaunchActionPhase = 'pinning';
      setLaunchState({ kind: 'launching', phase, solverNetId: action.solverNetId });

      // Poll loop.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (cancelledRef.current) return;

        let record: LaunchedSolverNetRecord;
        try {
          record = await api.solvernets.get(action.solverNetId);
        } catch (err) {
          if (cancelledRef.current) return;
          // Treat one-off get failures as transient; keep polling.
          await sleep(pollIntervalMs);
          continue;
        }

        if (record.launchProgress?.phase) {
          phase = record.launchProgress.phase;
        }

        if (record.status === 'launched') {
          setLaunchState({ kind: 'launching', phase: 'spawning', solverNetId: action.solverNetId });
          navigate(`/launcher/launched/${encodeURIComponent(action.solverNetId)}`);
          return;
        }

        if (record.status === 'failed') {
          const message =
            record.launchProgress?.txError?.message ??
            `Launch failed during ${phase}.`;
          setLaunchState({ kind: 'failed', message, solverNetId: action.solverNetId });
          onLaunchFailure?.();
          return;
        }

        setLaunchState({ kind: 'launching', phase, solverNetId: action.solverNetId });
        await sleep(pollIntervalMs);
      }
    } catch (err) {
      if (cancelledRef.current) return;
      setLaunchState({
        kind: 'failed',
        message: err instanceof Error ? err.message : String(err),
      });
      onLaunchFailure?.();
    }
  };

  const launching = launchState.kind === 'launching';
  const launchDisabled = openRoles.length === 0 || launching;

  return (
    <StepShell
      step={5}
      title="Review & launch"
      blurb="One last check. The Launch button signs the manifest, pins it to IPFS, and broadcasts the registry transaction."
      footer={
        <StepNav
          onBack={onBack}
          onNext={() => {
            void launch();
          }}
          nextLabel={launching ? 'Launching…' : 'Launch'}
          nextDisabled={launchDisabled}
          busy={launching}
          right={
            launching && (
              <PhaseStrip
                current={launchState.kind === 'launching' ? launchState.phase : 'pinning'}
              />
            )
          }
        />
      }
    >
      <ManifestSummary draft={draft} template={template} />

      <FieldShell
        label="Open roles"
        helperText="Operators can opt in to any role you open here. Most launchers want both."
      >
        <div
          data-testid="launcher-create-openRoles"
          style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
        >
          <RoleCheckbox
            role="solver"
            checked={openRoles.includes('solver')}
            onChange={() => toggleRole('solver')}
            disabled={launching}
          />
          <RoleCheckbox
            role="evaluator"
            checked={openRoles.includes('evaluator')}
            onChange={() => toggleRole('evaluator')}
            disabled={launching}
          />
        </div>
        {openRoles.length === 0 && (
          <span
            data-testid="launcher-create-openRoles-error"
            style={{
              fontSize: '12px',
              color: 'var(--break-red)',
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            At least one role must be open.
          </span>
        )}
      </FieldShell>

      {launchState.kind === 'failed' && (
        <div
          data-testid="launcher-create-launch-failure"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--break-red)',
            borderRadius: 'var(--radius-2)',
            padding: '14px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <span
            style={{
              color: 'var(--break-red)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '13px',
              fontWeight: 500,
            }}
          >
            Launch failed.
          </span>
          <span style={{ color: 'var(--fg-muted)', fontSize: '12px', fontFamily: "'JetBrains Mono', monospace" }}>
            {launchState.message}
          </span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              data-testid="launcher-create-launch-retry"
              onClick={() => {
                void launch();
              }}
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '13px',
                padding: '8px 14px',
                background: 'var(--accent-sky)',
                color: 'var(--bg-sunken)',
                border: '1px solid var(--accent-sky)',
                borderRadius: 'var(--radius-2)',
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
            <button
              type="button"
              data-testid="launcher-create-launch-abandon"
              onClick={() => {
                navigate('/launcher');
              }}
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '13px',
                padding: '8px 14px',
                background: 'transparent',
                color: 'var(--fg)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-2)',
                cursor: 'pointer',
              }}
            >
              Abandon
            </button>
          </div>
        </div>
      )}
    </StepShell>
  );
}

function PhaseStrip({ current }: { current: LaunchActionPhase }): JSX.Element {
  const currentIdx = LAUNCH_PHASES.indexOf(current);
  return (
    <div
      data-testid="launcher-create-launch-progress"
      data-phase={current}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '11px',
        color: 'var(--fg-muted)',
        letterSpacing: '0.06em',
      }}
    >
      <span data-testid="launcher-create-launch-phase">
        {PHASE_LABELS[current]}
      </span>
      <div style={{ display: 'flex', gap: '3px' }}>
        {LAUNCH_PHASES.map((phase, idx) => (
          <span
            key={phase}
            data-testid={`launcher-create-launch-phase-pip-${phase}`}
            data-active={idx <= currentIdx ? 'true' : 'false'}
            style={{
              width: '8px',
              height: '3px',
              background: idx <= currentIdx ? 'var(--accent-sky)' : 'var(--border)',
              borderRadius: 'var(--radius-1)',
            }}
          />
        ))}
      </div>
    </div>
  );
}

function ManifestSummary({
  draft,
  template,
}: {
  draft: DraftSolverNetRecord;
  template: CreateWizardTemplate;
}): JSX.Element {
  const generator = (draft.generatorConfig ?? {}) as Record<string, unknown>;
  // Prefer the active template's id/version for display; the draft fields
  // are only set after Step 2 advances. Both should agree once persisted.
  const displayId = draft.templateContractId ?? template.id;
  const displayVersion = draft.templateContractVersion ?? template.version;

  return (
    <article
      data-testid="launcher-create-manifest-summary"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-3)',
        padding: '20px 22px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '11px',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--fg-dim)',
          }}
        >
          {displayId}.{displayVersion}
        </span>
        <h2
          style={{
            margin: 0,
            fontFamily: "'Instrument Serif', 'Times New Roman', serif",
            fontSize: '24px',
            fontWeight: 400,
            color: 'var(--fg)',
          }}
        >
          {draft.name ?? '— unnamed'}
        </h2>
        {draft.description && (
          <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: '13px', lineHeight: 1.5 }}>
            {draft.description}
          </p>
        )}
      </header>
      <SummaryGrid>
        <SummaryItem label="Solution price" value={priceString(draft.solutionPriceWei)} />
        <SummaryItem label="Verdict price" value={priceString(draft.verdictPriceWei)} />
        {template.id === 'prediction' ? (
          <PredictionGeneratorSummary generator={generator} />
        ) : (
          <SweRebenchV2GeneratorSummary generator={generator} />
        )}
      </SummaryGrid>
    </article>
  );
}

function PredictionGeneratorSummary({
  generator,
}: {
  generator: Record<string, unknown>;
}): JSX.Element {
  const cadence = numericString(generator.cadenceMs);
  const window = numericString(generator.windowMs ?? generator.submissionWindowMs);
  const maxOpenRounds = numericString(generator.maxOpenRounds);
  return (
    <>
      <SummaryItem label="Cadence" value={cadence ? `${cadence} ms` : '—'} />
      <SummaryItem label="Window" value={window ? `${window} ms` : '—'} />
      <SummaryItem label="Max open rounds" value={maxOpenRounds ?? '—'} />
      <SummaryItem
        label="Allowlist"
        value={lengthDescriptor(generator.allowlistConditionIds)}
      />
      <SummaryItem
        label="Blocklist"
        value={lengthDescriptor(generator.blocklistConditionIds)}
      />
    </>
  );
}

function SweRebenchV2GeneratorSummary({
  generator,
}: {
  generator: Record<string, unknown>;
}): JSX.Element {
  const targetSuccesses = numericString(generator.N_target_successes);
  const maxPostings = numericString(generator.N_max_postings_per_task);
  const cooldown = numericString(generator.cooldown_ms);
  return (
    <>
      <SummaryItem label="Target successes" value={targetSuccesses ?? '—'} />
      <SummaryItem label="Max postings / Task" value={maxPostings ?? '—'} />
      <SummaryItem label="Cooldown" value={cooldown ? `${cooldown} ms` : '—'} />
    </>
  );
}

function priceString(wei: string | undefined): string {
  if (!wei) return '—';
  return `${wei} wei (${formatEthFromWei(wei)})`;
}

function numericString(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return v.trim();
  return null;
}

function lengthDescriptor(v: unknown): string {
  if (Array.isArray(v) && v.length > 0) return `${v.length} entries`;
  return 'none';
}

function SummaryGrid({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '8px 16px',
        paddingTop: '8px',
        borderTop: '1px solid var(--border)',
      }}
    >
      {children}
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '10px',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--fg-dim)',
        }}
      >
        {label}
      </span>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', color: 'var(--fg)' }}>
        {value}
      </span>
    </div>
  );
}

function RoleCheckbox({
  role,
  checked,
  onChange,
  disabled,
}: {
  role: 'solver' | 'evaluator';
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <label
      style={{
        display: 'flex',
        gap: '10px',
        alignItems: 'center',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <input
        data-testid={`launcher-create-openRoles-${role}`}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
      />
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', color: 'var(--fg)' }}>
        {role}
      </span>
    </label>
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
