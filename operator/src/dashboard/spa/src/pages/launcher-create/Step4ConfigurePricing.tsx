import { useMemo, useState, type JSX } from 'react';
import type {
  DraftSolverNetRecord,
  DraftSolverNetRecordPatch,
} from '../../../../../api/contract/index.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { Input } from '../../components/ui/input.js';
import { Separator } from '../../components/ui/separator.js';
import { cn } from '../../lib/utils.js';
import { ensureCompletedStep, formatEthFromWei, parseWei } from './draft-helpers.js';
import { FieldShell, StepNav, StepShell } from './StepShell.js';
import { PREDICTION_V1_TEMPLATE, type CreateWizardTemplate } from './templates.js';

/**
 * Step 4 — Configure pricing.
 *
 * Replaces the predecessor's `N` placeholder budget step (jinn-mono-p1t4.4).
 * Two operator inputs:
 *
 *   - solutionPriceWei  — wei paid per claimed solution
 *   - verdictPriceWei   — wei paid per evaluation verdict
 *
 * Plus a read-only summary:
 *
 *   - funding Safe address (defaults to launcher's master address)
 *   - current Safe balance (if available)
 *   - projected number of Tasks at the chosen prices
 *
 * Note on the Safe address: the daemon picks the launcher's Safe at
 * launch time (see `LaunchAction.launch` populating
 * `manifest.launcher.safeAddress`); the value shown here is informational
 * — operators see which Safe will fund Tasks rather than choosing a
 * different one. (The spec text "defaults to launcher master" is
 * literally what the daemon does.)
 */

export interface Step4ConfigurePricingProps {
  draft: DraftSolverNetRecord;
  /**
   * Active template. Defaults to {@link PREDICTION_V1_TEMPLATE} so existing
   * tests render without explicitly threading a template through; the wizard
   * always passes the URL-selected template explicitly.
   */
  template?: CreateWizardTemplate;
  onAdvance: (patch: DraftSolverNetRecordPatch) => Promise<void> | void;
  onBack: () => void;
  /**
   * Display-only Safe address. Sourced from the bootstrap state's
   * `master_address`. May be `null` when the daemon hasn't finished
   * bootstrapping; the form still works without it.
   */
  fundingSafeAddress: string | null;
  /** Display-only Safe balance in wei. Optional. */
  fundingSafeBalanceWei?: string | null;
  busy?: boolean;
  error?: string | null;
}

interface PricingValidation {
  ok: boolean;
  errors: { solutionPriceWei?: string; verdictPriceWei?: string; combined?: string };
  solutionWei?: bigint;
  verdictWei?: bigint;
}

export function validatePricing(
  solutionPriceWei: string,
  verdictPriceWei: string,
): PricingValidation {
  const errors: PricingValidation['errors'] = {};
  let solutionWei: bigint | null;
  let verdictWei: bigint | null;
  try {
    solutionWei = parseWei(solutionPriceWei);
    if (solutionWei === null) errors.solutionPriceWei = 'Required.';
    else if (solutionWei < 0n) errors.solutionPriceWei = 'Must be non-negative.';
  } catch {
    errors.solutionPriceWei = 'Must be a non-negative integer (wei).';
    solutionWei = null;
  }
  try {
    verdictWei = parseWei(verdictPriceWei);
    if (verdictWei === null) errors.verdictPriceWei = 'Required.';
    else if (verdictWei < 0n) errors.verdictPriceWei = 'Must be non-negative.';
  } catch {
    errors.verdictPriceWei = 'Must be a non-negative integer (wei).';
    verdictWei = null;
  }

  if (
    solutionWei !== null &&
    verdictWei !== null &&
    !errors.solutionPriceWei &&
    !errors.verdictPriceWei &&
    solutionWei === 0n &&
    verdictWei === 0n
  ) {
    errors.combined = 'At least one price must be positive.';
  }

  const ok = Object.keys(errors).length === 0;
  return {
    ok,
    errors,
    solutionWei: solutionWei ?? undefined,
    verdictWei: verdictWei ?? undefined,
  };
}

/**
 * Rough Tasks-projection: how many Tasks the Safe can fund at the chosen
 * prices, assuming the active template's claim-policy `maxClaimsPerOperator`
 * (so each Task pays out once for solution + N times for verdict).
 *
 * If the Safe balance is unknown, returns `null`. If both prices are
 * zero, also returns `null` (validator catches that).
 */
export function projectTasks(
  safeBalanceWei: string | null | undefined,
  solutionWei: bigint | undefined,
  verdictWei: bigint | undefined,
  maxClaimsPerOperator: number,
): { tasks: number; perTaskWei: bigint } | null {
  if (
    !safeBalanceWei ||
    !/^\d+$/.test(safeBalanceWei) ||
    solutionWei === undefined ||
    verdictWei === undefined
  ) {
    return null;
  }
  let bal: bigint;
  try {
    bal = BigInt(safeBalanceWei);
  } catch {
    return null;
  }
  const perTaskWei = solutionWei + verdictWei * BigInt(maxClaimsPerOperator);
  if (perTaskWei <= 0n) return null;
  const tasks = Number(bal / perTaskWei);
  return { tasks, perTaskWei };
}

export function Step4ConfigurePricing({
  draft,
  template = PREDICTION_V1_TEMPLATE,
  onAdvance,
  onBack,
  fundingSafeAddress,
  fundingSafeBalanceWei,
  busy,
  error,
}: Step4ConfigurePricingProps): JSX.Element {
  const [solutionPriceWei, setSolutionPriceWei] = useState(draft.solutionPriceWei ?? '');
  const [verdictPriceWei, setVerdictPriceWei] = useState(draft.verdictPriceWei ?? '');
  const [touched, setTouched] = useState(false);

  const validation = useMemo(
    () => validatePricing(solutionPriceWei, verdictPriceWei),
    [solutionPriceWei, verdictPriceWei],
  );

  const maxClaimsPerOperator = template.claimPolicyDefaults.maxClaimsPerOperator;
  const projection = useMemo(
    () =>
      projectTasks(
        fundingSafeBalanceWei ?? null,
        validation.solutionWei,
        validation.verdictWei,
        maxClaimsPerOperator,
      ),
    [fundingSafeBalanceWei, validation.solutionWei, validation.verdictWei, maxClaimsPerOperator],
  );

  const submit = (): void => {
    setTouched(true);
    if (!validation.ok) return;
    void onAdvance({
      solutionPriceWei,
      verdictPriceWei,
      completedSteps: ensureCompletedStep(draft.completedSteps, 'configurePricing'),
    });
  };

  const showErrors = touched ? validation.errors : {};

  return (
    <StepShell
      step={4}
      title="Configure pricing"
      blurb="Set what each Task pays out. The funding Safe is your launcher's master Safe; pricing applies per claim and per verdict."
      error={error}
      footer={
        <StepNav
          onBack={onBack}
          onNext={submit}
          busy={busy}
          nextDisabled={touched && !validation.ok}
        />
      }
    >
      <FieldShell
        label="Funding Safe"
        helperText="Tasks are funded from this Safe at launch. Defaults to your launcher master Safe."
        asLabel={false}
      >
        <div
          data-testid="launcher-create-fundingSafe"
          className="rounded-md border border-border bg-surface-sunken px-3 py-2.5 font-mono text-[13px] text-fg-muted break-all"
        >
          {fundingSafeAddress ?? '— (master Safe will be picked at launch)'}
        </div>
      </FieldShell>

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <FieldShell
          label="Solution price (wei)"
          helperText={`≈ ${formatEthFromWei(validation.solutionWei?.toString())}`}
          error={showErrors.solutionPriceWei ?? null}
        >
          <Input
            data-testid="launcher-create-solutionPriceWei"
            type="text"
            inputMode="numeric"
            value={solutionPriceWei}
            onChange={(e) => setSolutionPriceWei(e.target.value)}
            placeholder="e.g. 100000000000000 (0.0001 ETH)"
            className={cn(showErrors.solutionPriceWei && 'border-break-red')}
            disabled={busy}
          />
        </FieldShell>
        <FieldShell
          label="Verdict price (wei)"
          helperText={`≈ ${formatEthFromWei(validation.verdictWei?.toString())}`}
          error={showErrors.verdictPriceWei ?? null}
        >
          <Input
            data-testid="launcher-create-verdictPriceWei"
            type="text"
            inputMode="numeric"
            value={verdictPriceWei}
            onChange={(e) => setVerdictPriceWei(e.target.value)}
            placeholder="e.g. 50000000000000 (0.00005 ETH)"
            className={cn(showErrors.verdictPriceWei && 'border-break-red')}
            disabled={busy}
          />
        </FieldShell>
      </div>

      {showErrors.combined && (
        <div
          data-testid="launcher-create-pricing-combined-error"
          className="font-mono text-[12px] text-break-red"
        >
          {showErrors.combined}
        </div>
      )}

      <Card data-testid="launcher-create-projection">
        <CardContent className="flex flex-col gap-2.5 p-5">
          <h3 className="m-0 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-fg-muted">
            Runway projection
          </h3>
          <Separator />
          <SummaryRow
            label="Safe balance"
            value={
              fundingSafeBalanceWei
                ? `${formatEthFromWei(fundingSafeBalanceWei)} (${fundingSafeBalanceWei} wei)`
                : '—'
            }
          />
          <SummaryRow
            label="Per-Task cost"
            value={
              projection
                ? `${formatEthFromWei(projection.perTaskWei.toString())} (${projection.perTaskWei} wei)`
                : '—'
            }
            hint={`solution + verdict × maxClaimsPerOperator (${maxClaimsPerOperator})`}
          />
          <SummaryRow
            label="Projected Tasks"
            value={projection ? `~${projection.tasks.toLocaleString('en-US')}` : '—'}
            hint="Approximate; ignores gas and any in-flight reservations."
            testId="launcher-create-projected-tasks"
          />
        </CardContent>
      </Card>
    </StepShell>
  );
}

function SummaryRow({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  testId?: string;
}): JSX.Element {
  return (
    <div
      data-testid={testId}
      className="grid grid-cols-[160px_1fr] items-baseline gap-3"
    >
      <span className="font-mono text-[11px] tracking-[0.06em] text-fg-dim">
        {label}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="font-mono text-[13px] text-foreground">{value}</span>
        {hint && <span className="text-[12px] text-fg-muted">{hint}</span>}
      </span>
    </div>
  );
}
