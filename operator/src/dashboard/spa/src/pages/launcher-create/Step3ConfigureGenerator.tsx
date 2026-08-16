import { useMemo, useState, type JSX } from 'react';
import type {
  DraftSolverNetRecord,
  DraftSolverNetRecordPatch,
} from '../../../../../api/contract/index.js';
import { Input } from '../../components/ui/input.js';
import { cn } from '../../lib/utils.js';
import { ensureCompletedStep } from './draft-helpers.js';
import { FieldShell, StepNav, StepShell } from './StepShell.js';
import {
  PREDICTION_V1_TEMPLATE,
  SWE_REBENCH_V2_V1_TEMPLATE,
  type CreateWizardTemplate,
} from './templates.js';

/**
 * Step 3 — Configure the auto-generator that posts Tasks while this
 * SolverNet is launched.
 *
 * Each template has its own generator-config shape. The form branches
 * on `template.id`:
 *   - `prediction`     — Polymarket polling cadence + market filters
 *                        (mirrors `prediction-v1-auto.ts` defaults).
 *   - `swe-rebench-v2` — Fill-the-pool posting knobs:
 *                        target successes, max postings, posting window,
 *                        batch size, optional per-operator cap, claim lease
 *                        (mirrors `swe-rebench-v2-auto.ts` defaults).
 *
 * Adding a new template means adding a new branch here. The validated
 * `generatorConfig` object is forward-only persisted onto the draft;
 * the daemon's runtime falls back to its own DEFAULT_GENERATOR_CONFIG
 * for any keys it doesn't recognise.
 */

export interface Step3ConfigureGeneratorProps {
  draft: DraftSolverNetRecord;
  /**
   * Active template. Defaults to {@link PREDICTION_V1_TEMPLATE} so existing
   * tests render without explicitly threading a template through; the wizard
   * always passes the URL-selected template explicitly.
   */
  template?: CreateWizardTemplate;
  onAdvance: (patch: DraftSolverNetRecordPatch) => Promise<void> | void;
  onBack: () => void;
  busy?: boolean;
  error?: string | null;
}

const textareaBase =
  'flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[13px] text-foreground placeholder:text-fg-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-y';

export function Step3ConfigureGenerator(
  props: Step3ConfigureGeneratorProps,
): JSX.Element {
  const template = props.template ?? PREDICTION_V1_TEMPLATE;
  switch (template.id) {
    case 'prediction':
      return <PredictionGeneratorForm {...props} template={template} />;
    case 'swe-rebench-v2':
      return <SweRebenchV2GeneratorForm {...props} template={template} />;
    default: {
      // Exhaustive guard — TS will flag unhandled template ids if a new
      // variant is added to the discriminated union.
      const _exhaustive: never = template;
      void _exhaustive;
      return (
        <StepShell
          step={3}
          title="Configure generator"
          blurb="No generator form is registered for this template."
          error={props.error ?? null}
          footer={<StepNav onBack={props.onBack} onNext={() => {}} nextDisabled busy={props.busy} />}
        >
          <div data-testid="launcher-create-generator-unsupported" />
        </StepShell>
      );
    }
  }
}

// The narrowed-template forms accept a required `template` from the
// dispatcher above (where narrowing has already happened); the dispatcher
// strips the optional/defaulted shape before forwarding.
type Step3FormProps = Omit<Step3ConfigureGeneratorProps, 'template'> & {
  template: CreateWizardTemplate;
};

// ─── prediction.v1 ──────────────────────────────────────────────────────────

const MIN_CADENCE_MS = 60_000;

export interface GeneratorConfigDraft {
  cadenceMs: string;
  windowMs: string;
  resolveGapMs: string;
  maxNewRoundsPerPoll: string;
  maxNewRoundsPerDay: string;
  maxOpenRounds: string;
  allowlistConditionIds: string;
  blocklistConditionIds: string;
}

function asString(v: unknown, fallback: number): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return String(fallback);
}

function asListString(v: unknown): string {
  if (Array.isArray(v)) return v.filter((s) => typeof s === 'string').join(', ');
  return '';
}

function buildPredictionInitial(
  existing: Record<string, unknown> | undefined,
): GeneratorConfigDraft {
  const d = PREDICTION_V1_TEMPLATE.generatorDefaults;
  // `resolveGapMs` is not part of PredictionV1AutoConfig DEFAULTS — it's
  // an operator-tuned offset baked into the round-resolution logic.
  // Surface it with a 60-min default that operators can override; the
  // daemon ignores keys it doesn't recognise.
  const resolveGapMsDefault = 60 * 60 * 1000;
  return {
    cadenceMs: asString(existing?.cadenceMs, d.cadenceMs),
    windowMs: asString(existing?.windowMs ?? existing?.submissionWindowMs, d.submissionWindowMs),
    resolveGapMs: asString(existing?.resolveGapMs, resolveGapMsDefault),
    maxNewRoundsPerPoll: asString(existing?.maxNewRoundsPerPoll, d.maxNewRoundsPerPoll),
    maxNewRoundsPerDay: asString(existing?.maxNewRoundsPerDay, d.maxNewRoundsPerDay),
    maxOpenRounds: asString(existing?.maxOpenRounds, d.maxOpenRounds),
    allowlistConditionIds: asListString(existing?.allowlistConditionIds),
    blocklistConditionIds: asListString(existing?.blocklistConditionIds),
  };
}

interface PredictionValidationResult {
  ok: boolean;
  errors: Partial<Record<keyof GeneratorConfigDraft, string>>;
  /** When `ok`, the patch shape to send to the daemon. */
  generatorConfig?: Record<string, unknown>;
}

export function validateGeneratorConfig(
  draft: GeneratorConfigDraft,
): PredictionValidationResult {
  const errors: Partial<Record<keyof GeneratorConfigDraft, string>> = {};

  const cadenceMs = parsePositiveInt(draft.cadenceMs);
  if (cadenceMs === null) errors.cadenceMs = 'Must be a positive integer (ms).';
  else if (cadenceMs < MIN_CADENCE_MS)
    errors.cadenceMs = `Cadence must be at least ${MIN_CADENCE_MS / 1000}s.`;

  const windowMs = parsePositiveInt(draft.windowMs);
  if (windowMs === null) errors.windowMs = 'Must be a positive integer (ms).';

  const resolveGapMs = parsePositiveInt(draft.resolveGapMs);
  if (resolveGapMs === null) errors.resolveGapMs = 'Must be a positive integer (ms).';

  const maxNewRoundsPerPoll = parsePositiveInt(draft.maxNewRoundsPerPoll);
  if (maxNewRoundsPerPoll === null)
    errors.maxNewRoundsPerPoll = 'Must be a positive integer.';

  const maxNewRoundsPerDay = parsePositiveInt(draft.maxNewRoundsPerDay);
  if (maxNewRoundsPerDay === null)
    errors.maxNewRoundsPerDay = 'Must be a positive integer.';

  const maxOpenRounds = parsePositiveInt(draft.maxOpenRounds);
  if (maxOpenRounds === null) errors.maxOpenRounds = 'Must be a positive integer.';

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: {},
    generatorConfig: {
      cadenceMs,
      windowMs,
      resolveGapMs,
      submissionWindowMs: windowMs,
      maxNewRoundsPerPoll,
      maxNewRoundsPerDay,
      maxOpenRounds,
      allowlistConditionIds: parseList(draft.allowlistConditionIds),
      blocklistConditionIds: parseList(draft.blocklistConditionIds),
    },
  };
}

function parsePositiveInt(v: string): number | null {
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function parseList(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function PredictionGeneratorForm({
  draft,
  onAdvance,
  onBack,
  busy,
  error,
}: Step3FormProps): JSX.Element {
  const initial = useMemo(() => buildPredictionInitial(draft.generatorConfig), [draft.generatorConfig]);
  const [form, setForm] = useState<GeneratorConfigDraft>(initial);
  const [touched, setTouched] = useState(false);

  const validation = touched ? validateGeneratorConfig(form) : { ok: true, errors: {} };
  const fieldErrors = touched ? validation.errors : {};

  const submit = (): void => {
    setTouched(true);
    const v = validateGeneratorConfig(form);
    if (!v.ok || !v.generatorConfig) return;
    void onAdvance({
      generatorConfig: v.generatorConfig,
      completedSteps: ensureCompletedStep(draft.completedSteps, 'configureGenerator'),
    });
  };

  const set = <K extends keyof GeneratorConfigDraft>(key: K, value: string): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <StepShell
      step={3}
      title="Configure generator"
      blurb="The auto-generator polls Polymarket and posts Tasks while the SolverNet is launched. Defaults are tuned for a healthy idle SolverNet — adjust to match your appetite."
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
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <FieldShell
          label="Cadence (ms)"
          helperText="How often the generator polls Polymarket. Minimum 60s."
          error={fieldErrors.cadenceMs ?? null}
        >
          <Input
            data-testid="launcher-create-cadenceMs"
            type="text"
            inputMode="numeric"
            value={form.cadenceMs}
            onChange={(e) => set('cadenceMs', e.target.value)}
            className={cn(fieldErrors.cadenceMs && 'border-break-red')}
            disabled={busy}
          />
        </FieldShell>
        <FieldShell
          label="Submission window (ms)"
          helperText="How long Tasks stay open for solving."
          error={fieldErrors.windowMs ?? null}
        >
          <Input
            data-testid="launcher-create-windowMs"
            type="text"
            inputMode="numeric"
            value={form.windowMs}
            onChange={(e) => set('windowMs', e.target.value)}
            className={cn(fieldErrors.windowMs && 'border-break-red')}
            disabled={busy}
          />
        </FieldShell>
        <FieldShell
          label="Resolve gap (ms)"
          helperText="Cushion between window-close and resolution."
          error={fieldErrors.resolveGapMs ?? null}
        >
          <Input
            data-testid="launcher-create-resolveGapMs"
            type="text"
            inputMode="numeric"
            value={form.resolveGapMs}
            onChange={(e) => set('resolveGapMs', e.target.value)}
            className={cn(fieldErrors.resolveGapMs && 'border-break-red')}
            disabled={busy}
          />
        </FieldShell>
        <FieldShell
          label="Max rounds / poll"
          helperText="Cap on new Tasks per generator tick."
          error={fieldErrors.maxNewRoundsPerPoll ?? null}
        >
          <Input
            data-testid="launcher-create-maxNewRoundsPerPoll"
            type="text"
            inputMode="numeric"
            value={form.maxNewRoundsPerPoll}
            onChange={(e) => set('maxNewRoundsPerPoll', e.target.value)}
            className={cn(fieldErrors.maxNewRoundsPerPoll && 'border-break-red')}
            disabled={busy}
          />
        </FieldShell>
        <FieldShell
          label="Max rounds / day"
          helperText="Daily ceiling across all polls."
          error={fieldErrors.maxNewRoundsPerDay ?? null}
        >
          <Input
            data-testid="launcher-create-maxNewRoundsPerDay"
            type="text"
            inputMode="numeric"
            value={form.maxNewRoundsPerDay}
            onChange={(e) => set('maxNewRoundsPerDay', e.target.value)}
            className={cn(fieldErrors.maxNewRoundsPerDay && 'border-break-red')}
            disabled={busy}
          />
        </FieldShell>
        <FieldShell
          label="Max open rounds"
          helperText="Concurrent open Tasks before back-off kicks in."
          error={fieldErrors.maxOpenRounds ?? null}
        >
          <Input
            data-testid="launcher-create-maxOpenRounds"
            type="text"
            inputMode="numeric"
            value={form.maxOpenRounds}
            onChange={(e) => set('maxOpenRounds', e.target.value)}
            className={cn(fieldErrors.maxOpenRounds && 'border-break-red')}
            disabled={busy}
          />
        </FieldShell>
      </div>

      <FieldShell
        label="Allowlist condition ids"
        helperText="Comma-separated. If non-empty, only these markets are considered."
      >
        <textarea
          data-testid="launcher-create-allowlistConditionIds"
          value={form.allowlistConditionIds}
          onChange={(e) => set('allowlistConditionIds', e.target.value)}
          rows={2}
          placeholder="0xabc…, 0xdef…"
          className={textareaBase}
          disabled={busy}
        />
      </FieldShell>
      <FieldShell
        label="Blocklist condition ids"
        helperText="Comma-separated. Markets here are skipped, even if they pass the eligibility filters."
      >
        <textarea
          data-testid="launcher-create-blocklistConditionIds"
          value={form.blocklistConditionIds}
          onChange={(e) => set('blocklistConditionIds', e.target.value)}
          rows={2}
          placeholder="0xabc…"
          className={textareaBase}
          disabled={busy}
        />
      </FieldShell>
    </StepShell>
  );
}

// ─── swe-rebench-v2.v1 ──────────────────────────────────────────────────────

export interface SweRebenchV2GeneratorConfigDraft {
  N_target_successes: string;
  posting_window_ms: string;
  post_batch_size: string;
  maxClaimsPerOperator: string;
  claimLeaseTtlSeconds: string;
}

interface SweRebenchV2ValidationResult {
  ok: boolean;
  errors: Partial<Record<keyof SweRebenchV2GeneratorConfigDraft, string>>;
  generatorConfig?: Record<string, unknown>;
}

function buildSweRebenchV2Initial(
  existing: Record<string, unknown> | undefined,
): SweRebenchV2GeneratorConfigDraft {
  const d = SWE_REBENCH_V2_V1_TEMPLATE.generatorDefaults;
  const legacyPolicy = typeof existing?.claimPolicy === 'object' && existing.claimPolicy !== null
    ? existing.claimPolicy as Record<string, unknown>
    : {};
  return {
    N_target_successes: asString(existing?.N_target_successes, d.N_target_successes),
    posting_window_ms: asString(existing?.posting_window_ms, d.posting_window_ms),
    post_batch_size: asString(existing?.post_batch_size, d.post_batch_size),
    maxClaimsPerOperator: asString(
      existing?.maxClaimsPerOperator ?? legacyPolicy.maxClaimsPerOperator,
      d.maxClaimsPerOperator ?? d.N_target_successes,
    ),
    claimLeaseTtlSeconds: asString(
      existing?.claimLeaseTtlSeconds ?? legacyPolicy.claimLeaseTtlSeconds,
      d.claimLeaseTtlSeconds,
    ),
  };
}

export function validateSweRebenchV2GeneratorConfig(
  draft: SweRebenchV2GeneratorConfigDraft,
): SweRebenchV2ValidationResult {
  const errors: Partial<Record<keyof SweRebenchV2GeneratorConfigDraft, string>> = {};

  const N_target_successes = parsePositiveInt(draft.N_target_successes);
  if (N_target_successes === null)
    errors.N_target_successes = 'Must be a positive integer.';

  const posting_window_ms = parsePositiveInt(draft.posting_window_ms);
  if (posting_window_ms === null)
    errors.posting_window_ms = 'Must be a positive integer (ms).';

  const post_batch_size = parsePositiveInt(draft.post_batch_size);
  if (post_batch_size === null)
    errors.post_batch_size = 'Must be a positive integer.';

  const maxClaimsPerOperator = parsePositiveInt(draft.maxClaimsPerOperator);
  if (maxClaimsPerOperator === null)
    errors.maxClaimsPerOperator = 'Must be a positive integer.';

  const claimLeaseTtlSeconds = parsePositiveInt(draft.claimLeaseTtlSeconds);
  if (claimLeaseTtlSeconds === null)
    errors.claimLeaseTtlSeconds = 'Must be a positive integer (seconds).';

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: {},
    generatorConfig: {
      N_target_successes,
      posting_window_ms,
      post_batch_size,
      maxClaimsPerOperator,
      claimLeaseTtlSeconds,
    },
  };
}

function SweRebenchV2GeneratorForm({
  draft,
  onAdvance,
  onBack,
  busy,
  error,
}: Step3FormProps): JSX.Element {
  const initial = useMemo(
    () => buildSweRebenchV2Initial(draft.generatorConfig),
    [draft.generatorConfig],
  );
  const [form, setForm] = useState<SweRebenchV2GeneratorConfigDraft>(initial);
  const [touched, setTouched] = useState(false);

  const validation = touched
    ? validateSweRebenchV2GeneratorConfig(form)
    : { ok: true, errors: {} };
  const fieldErrors = touched ? validation.errors : {};

  const submit = (): void => {
    setTouched(true);
    const v = validateSweRebenchV2GeneratorConfig(form);
    if (!v.ok || !v.generatorConfig) return;
    void onAdvance({
      generatorConfig: v.generatorConfig,
      completedSteps: ensureCompletedStep(draft.completedSteps, 'configureGenerator'),
    });
  };

  const set = <K extends keyof SweRebenchV2GeneratorConfigDraft>(
    key: K,
    value: string,
  ): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <StepShell
      step={3}
      title="Configure generator"
      blurb="The generator pulls SWE-rebench v2 instances from the HuggingFace pool and posts Tasks until enough successful Verdicts accumulate or the posting cap is hit."
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
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <FieldShell
          label="Target successful Verdicts per instance"
          helperText="How many score=1 Verdicts saturate a SWE instance and stop further Task posting."
          error={fieldErrors.N_target_successes ?? null}
        >
          <Input
            data-testid="launcher-create-N_target_successes"
            type="text"
            inputMode="numeric"
            value={form.N_target_successes}
            onChange={(e) => set('N_target_successes', e.target.value)}
            className={cn(fieldErrors.N_target_successes && 'border-break-red')}
            disabled={busy}
          />
        </FieldShell>
        <FieldShell
          label="Posting window (ms)"
          helperText="On-chain claim-window deadline for each posting. Reposts trigger on claim-budget exhaustion observed via the indexer, not this window."
          error={fieldErrors.posting_window_ms ?? null}
        >
          <Input
            data-testid="launcher-create-posting_window_ms"
            type="text"
            inputMode="numeric"
            value={form.posting_window_ms}
            onChange={(e) => set('posting_window_ms', e.target.value)}
            className={cn(fieldErrors.posting_window_ms && 'border-break-red')}
            disabled={busy}
          />
        </FieldShell>
        <FieldShell
          label="Post batch size"
          helperText="Maximum number of SWE instances to post in one creator tick."
          error={fieldErrors.post_batch_size ?? null}
        >
          <Input
            data-testid="launcher-create-post_batch_size"
            type="text"
            inputMode="numeric"
            value={form.post_batch_size}
            onChange={(e) => set('post_batch_size', e.target.value)}
            className={cn(fieldErrors.post_batch_size && 'border-break-red')}
            disabled={busy}
          />
        </FieldShell>
        <FieldShell
          label="Max claims per operator"
          helperText="Optional cap; each posting is still limited by remaining target successes."
          error={fieldErrors.maxClaimsPerOperator ?? null}
        >
          <Input
            data-testid="launcher-create-maxClaimsPerOperator"
            type="text"
            inputMode="numeric"
            value={form.maxClaimsPerOperator}
            onChange={(e) => set('maxClaimsPerOperator', e.target.value)}
            className={cn(fieldErrors.maxClaimsPerOperator && 'border-break-red')}
            disabled={busy}
          />
        </FieldShell>
        <FieldShell
          label="Claim lease (seconds)"
          helperText="How long a claimed SWE task slot stays leased."
          error={fieldErrors.claimLeaseTtlSeconds ?? null}
        >
          <Input
            data-testid="launcher-create-claimLeaseTtlSeconds"
            type="text"
            inputMode="numeric"
            value={form.claimLeaseTtlSeconds}
            onChange={(e) => set('claimLeaseTtlSeconds', e.target.value)}
            className={cn(fieldErrors.claimLeaseTtlSeconds && 'border-break-red')}
            disabled={busy}
          />
        </FieldShell>
      </div>
    </StepShell>
  );
}
