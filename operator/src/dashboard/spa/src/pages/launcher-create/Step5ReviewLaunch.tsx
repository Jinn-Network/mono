import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useLocation } from 'wouter';
import { api } from '../../api/client.js';
import type {
  DraftSolverNetRecord,
  DraftSolverNetRecordPatch,
  LaunchActionPhase,
  LaunchedSolverNetRecord,
} from '../../../../../api/contract/index.js';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { Separator } from '../../components/ui/separator.js';
import { cn } from '../../lib/utils.js';
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
        asLabel={false}
      >
        <div
          data-testid="launcher-create-openRoles"
          className="flex flex-col gap-2.5"
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
            className="font-mono text-[12px] text-break-red"
          >
            At least one role must be open.
          </span>
        )}
      </FieldShell>

      {launchState.kind === 'failed' && (
        <Alert variant="blocking" data-testid="launcher-create-launch-failure">
          <AlertTitle className="font-mono text-[13px] font-medium text-break-red">
            Launch failed.
          </AlertTitle>
          <AlertDescription className="font-mono text-[12px] text-fg-muted">
            {launchState.message}
          </AlertDescription>
          <div className="mt-2.5 flex gap-2">
            <Button
              type="button"
              size="sm"
              data-testid="launcher-create-launch-retry"
              onClick={() => {
                void launch();
              }}
            >
              Retry
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="launcher-create-launch-abandon"
              onClick={() => {
                navigate('/launcher');
              }}
            >
              Abandon
            </Button>
          </div>
        </Alert>
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
      className="flex items-center gap-1.5 font-mono text-[11px] tracking-[0.06em] text-fg-muted"
    >
      <span data-testid="launcher-create-launch-phase">
        {PHASE_LABELS[current]}
      </span>
      <div className="flex gap-[3px]">
        {LAUNCH_PHASES.map((phase, idx) => (
          <span
            key={phase}
            data-testid={`launcher-create-launch-phase-pip-${phase}`}
            data-active={idx <= currentIdx ? 'true' : 'false'}
            className={cn(
              'h-[3px] w-2 rounded-sm',
              idx <= currentIdx ? 'bg-accent-sky' : 'bg-border',
            )}
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
    <Card data-testid="launcher-create-manifest-summary">
      <CardContent className="flex flex-col gap-3 p-6">
        <header className="flex flex-col gap-1">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-fg-dim">
            {displayId}.{displayVersion}
          </span>
          <h2 className="m-0 font-serif text-[24px] font-normal text-foreground">
            {draft.name ?? '— unnamed'}
          </h2>
          {draft.description && (
            <p className="m-0 text-[13px] leading-relaxed text-fg-muted">
              {draft.description}
            </p>
          )}
        </header>
        <Separator />
        <SummaryGrid>
          <SummaryItem label="Solution price" value={priceString(draft.solutionPriceWei)} />
          <SummaryItem label="Verdict price" value={priceString(draft.verdictPriceWei)} />
          {template.id === 'prediction' ? (
            <PredictionGeneratorSummary generator={generator} />
          ) : (
            <SweRebenchV2GeneratorSummary generator={generator} />
          )}
        </SummaryGrid>
      </CardContent>
    </Card>
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
  const postingWindow = numericString(generator.posting_window_ms);
  const batchSize = numericString(generator.post_batch_size);
  return (
    <>
      <SummaryItem label="Target successes" value={targetSuccesses ?? '—'} />
      <SummaryItem label="Posting window" value={postingWindow ? `${postingWindow} ms` : '—'} />
      <SummaryItem label="Batch size" value={batchSize ?? '—'} />
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
    <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
      {children}
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-dim">
        {label}
      </span>
      <span className="font-mono text-[13px] text-foreground">{value}</span>
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
      className={cn(
        'flex items-center gap-2.5',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
      )}
    >
      <input
        data-testid={`launcher-create-openRoles-${role}`}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="h-4 w-4 cursor-pointer accent-accent-sky"
      />
      <span className="font-mono text-[13px] text-foreground">{role}</span>
    </label>
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
