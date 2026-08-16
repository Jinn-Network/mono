import { useEffect, useMemo, useState, type JSX } from 'react';
import type {
  GeneratorConfig,
  LaunchedSolverNetRecord,
  SolverNetManifestV1,
} from '../../../../../api/contract/index.js';
import type { CreateWizardTemplate } from '../launcher-create/templates.js';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Separator } from '../../components/ui/separator.js';
import { cn } from '../../lib/utils.js';
import { formatTimestamp } from './helpers.js';

/**
 * Hot-apply form for the launched SolverNet's generator config.
 *
 * On Save, the parent's `onSave` callback hits
 * `api.solvernets.updateGeneratorConfig(solverNetId, patch)`. The daemon
 * applies the patch to its in-memory mirror without restart (Task 14 §6.3),
 * and the parent's polling refetch picks up the new `record.generatorConfig`
 * on the next tick — so a successful save is observable in the dashboard
 * without any restart wiring on the SPA side.
 *
 * The form is a thinner cousin of `Step3ConfigureGenerator` from the Create
 * flow — the daemon validates strictly (`mapGeneratorPatch` table), so this
 * panel keeps validation light: positive-integer parsing for numeric fields,
 * comma-split for allow/blocklist, with daemon errors surfaced inline.
 */

const MIN_CADENCE_MS = 60_000;

export interface GeneratorPanelProps {
  record: LaunchedSolverNetRecord;
  manifest?: SolverNetManifestV1;
  template?: CreateWizardTemplate;
  onSave: (patch: Partial<GeneratorConfig>) => Promise<void>;
}

interface FormState {
  cadenceMs: string;
  windowMs: string;
  resolveGapMs: string;
  maxNewRoundsPerPoll: string;
  maxNewRoundsPerDay: string;
  maxOpenRounds: string;
  allowlistConditionIds: string;
  blocklistConditionIds: string;
}

interface SweRebenchV2FormState {
  N_target_successes: string;
  posting_window_ms: string;
  post_batch_size: string;
  maxClaimsPerOperator: string;
  claimLeaseTtlSeconds: string;
}

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: Date }
  | { kind: 'error'; message: string };

function initialForm(config: Record<string, unknown> | undefined): FormState {
  const c = config ?? {};
  return {
    cadenceMs: stringField(c.cadenceMs),
    windowMs: stringField(c.windowMs ?? c.submissionWindowMs),
    resolveGapMs: stringField(c.resolveGapMs),
    maxNewRoundsPerPoll: stringField(c.maxNewRoundsPerPoll),
    maxNewRoundsPerDay: stringField(c.maxNewRoundsPerDay),
    maxOpenRounds: stringField(c.maxOpenRounds),
    allowlistConditionIds: listField(c.allowlistConditionIds),
    blocklistConditionIds: listField(c.blocklistConditionIds),
  };
}

function initialSweRebenchV2Form(
  config: Record<string, unknown> | undefined,
  manifest?: SolverNetManifestV1,
): SweRebenchV2FormState {
  const c = config ?? {};
  const policy = readClaimPolicyConfig(c.claimPolicy);
  const defaults = manifest?.contract.claimPolicyDefaults ?? {
    maxClaims: 5,
    maxClaimsPerOperator: 5,
    claimLeaseTtlSeconds: 60 * 60,
  };
  return {
    N_target_successes: stringField(c.N_target_successes),
    posting_window_ms: stringField(c.posting_window_ms),
    post_batch_size: stringField(c.post_batch_size),
    maxClaimsPerOperator: stringField(
      c.maxClaimsPerOperator ?? policy.maxClaimsPerOperator ?? defaults.maxClaimsPerOperator,
    ),
    claimLeaseTtlSeconds: stringField(
      c.claimLeaseTtlSeconds ?? policy.claimLeaseTtlSeconds ?? defaults.claimLeaseTtlSeconds,
    ),
  };
}

function readClaimPolicyConfig(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {};
}

function stringField(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return '';
}

function listField(v: unknown): string {
  if (Array.isArray(v)) return v.filter((s) => typeof s === 'string').join(', ');
  return '';
}

function parsePositiveInt(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function parseList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

interface ValidatedPatch {
  ok: boolean;
  patch: Partial<GeneratorConfig>;
  errors: Partial<Record<keyof FormState, string>>;
}

interface SweRebenchV2ValidatedPatch {
  ok: boolean;
  patch: Partial<GeneratorConfig>;
  errors: Partial<Record<keyof SweRebenchV2FormState, string>>;
}

export function buildPatch(form: FormState, prior: FormState): ValidatedPatch {
  const errors: Partial<Record<keyof FormState, string>> = {};
  const patch: Record<string, unknown> = {};

  for (const key of [
    'cadenceMs',
    'windowMs',
    'resolveGapMs',
    'maxNewRoundsPerPoll',
    'maxNewRoundsPerDay',
    'maxOpenRounds',
  ] as const) {
    if (form[key] === prior[key]) continue;
    if (form[key].trim().length === 0) continue;
    const parsed = parsePositiveInt(form[key]);
    if (parsed === null) {
      errors[key] = 'Must be a positive integer.';
      continue;
    }
    if (key === 'cadenceMs' && parsed < MIN_CADENCE_MS) {
      errors[key] = `Cadence must be at least ${MIN_CADENCE_MS / 1000}s.`;
      continue;
    }
    if (key === 'windowMs') {
      // Daemon's GeneratorConfig calls this `submissionWindowMs`.
      patch.submissionWindowMs = parsed;
    } else {
      patch[key] = parsed;
    }
  }

  for (const key of ['allowlistConditionIds', 'blocklistConditionIds'] as const) {
    if (form[key] === prior[key]) continue;
    patch[key] = parseList(form[key]);
  }

  return {
    ok: Object.keys(errors).length === 0,
    patch: patch as Partial<GeneratorConfig>,
    errors,
  };
}

export function buildSweRebenchV2Patch(
  form: SweRebenchV2FormState,
  prior: SweRebenchV2FormState,
): SweRebenchV2ValidatedPatch {
  const errors: Partial<Record<keyof SweRebenchV2FormState, string>> = {};
  const patch: Record<string, unknown> = {};

  for (const key of [
    'N_target_successes',
    'posting_window_ms',
    'post_batch_size',
    'maxClaimsPerOperator',
    'claimLeaseTtlSeconds',
  ] as const) {
    if (form[key] === prior[key]) continue;
    if (form[key].trim().length === 0) continue;
    const parsed = parsePositiveInt(form[key]);
    if (parsed === null) {
      errors[key] = key === 'posting_window_ms'
        ? 'Must be a positive integer (ms).'
        : key === 'claimLeaseTtlSeconds'
          ? 'Must be a positive integer (seconds).'
        : 'Must be a positive integer.';
      continue;
    }
    patch[key] = parsed;
  }

  return {
    ok: Object.keys(errors).length === 0,
    patch: patch as Partial<GeneratorConfig>,
    errors,
  };
}

function isSweRebenchV2Record(
  record: LaunchedSolverNetRecord,
  template?: CreateWizardTemplate,
): boolean {
  if (template) {
    return template.id === 'swe-rebench-v2' && template.version === 'v1';
  }
  if (
    record.summary?.contractId === 'swe-rebench-v2' &&
    record.summary.contractVersion === 'v1'
  ) {
    return true;
  }
  const config = record.generatorConfig ?? {};
  return (
    Object.prototype.hasOwnProperty.call(config, 'N_target_successes') ||
    Object.prototype.hasOwnProperty.call(config, 'N_max_postings_per_task') ||
    Object.prototype.hasOwnProperty.call(config, 'posting_window_ms') ||
    Object.prototype.hasOwnProperty.call(config, 'cooldown_ms')
  );
}

export function GeneratorPanel({
  record,
  manifest,
  template,
  onSave,
}: GeneratorPanelProps): JSX.Element {
  if (isSweRebenchV2Record(record, template)) {
    return <SweRebenchV2GeneratorPanel record={record} manifest={manifest} onSave={onSave} />;
  }
  return <PredictionGeneratorPanel record={record} onSave={onSave} />;
}

function PanelShell({
  record,
  configExpanded,
  setConfigExpanded,
  children,
}: {
  record: LaunchedSolverNetRecord;
  configExpanded: boolean;
  setConfigExpanded: (next: boolean | ((prev: boolean) => boolean)) => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Card
      data-testid="launcher-launched-generator-panel"
      role="region"
      aria-label="Generator"
      className="flex flex-col gap-4 p-6"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <h2 className="m-0 font-serif text-[22px] font-normal text-foreground">
            Generator
          </h2>
          <GeneratorStatusBadge record={record} />
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="launcher-launched-generator-toggle"
          aria-expanded={configExpanded}
          aria-controls="launcher-launched-generator-config"
          onClick={() => setConfigExpanded((expanded) => !expanded)}
        >
          {configExpanded ? 'Hide config' : 'Edit config'}
        </Button>
      </header>

      <dl className="m-0 grid gap-y-2 gap-x-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
        <MetaItem
          label="Last poll"
          value={formatTimestamp(record.generatorState?.lastPollAt)}
          testid="launcher-launched-generator-last-poll"
        />
        <MetaItem
          label="Generator enabled"
          value={record.generatorEnabled ? 'yes' : 'no'}
          testid="launcher-launched-generator-enabled"
        />
        {record.generatorState?.totalPosted !== undefined && (
          <MetaItem
            label="Total posted"
            value={String(record.generatorState.totalPosted)}
            testid="launcher-launched-generator-total-posted"
          />
        )}
        {record.generatorState?.lastPostedInstanceId !== undefined && (
          <MetaItem
            label="Last posted"
            value={record.generatorState.lastPostedInstanceId}
            testid="launcher-launched-generator-last-posted"
          />
        )}
      </dl>

      <GeneratorPoolSummary record={record} />

      <PoolRepublishedNotice record={record} />

      <PoolStaleNotice record={record} />

      {record.generatorState?.lastError && <GeneratorError record={record} />}

      {children}
    </Card>
  );
}

function PredictionGeneratorPanel({ record, onSave }: GeneratorPanelProps): JSX.Element {
  const initial = useMemo(() => initialForm(record.generatorConfig), [record.generatorConfig]);
  const [form, setForm] = useState<FormState>(initial);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [configExpanded, setConfigExpanded] = useState(false);

  // When the polled record changes (hot-apply round-trip), re-seed the form
  // — but only if the operator hasn't dirtied the inputs since the last save.
  // The simplest signal is: re-seed only when the prior `initial` matches the
  // current form (no unsaved edits).
  useEffect(() => {
    setForm((prev) => {
      const dirty = JSON.stringify(prev) !== JSON.stringify(initialFromPrior());
      if (dirty) return prev;
      return initial;
    });
    function initialFromPrior(): FormState {
      // Reconstruct what `initial` was on the previous render — the simplest
      // approach is to just compare against the new initial; any deviation
      // counts as dirty.
      return initial;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(record.generatorConfig)]);

  const set = <K extends keyof FormState>(key: K, value: string): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const validation = useMemo(() => buildPatch(form, initial), [form, initial]);
  const dirty = Object.keys(validation.patch).length > 0;
  const saving = saveStatus.kind === 'saving';

  const submit = async (): Promise<void> => {
    if (!validation.ok || !dirty || saving) return;
    setSaveStatus({ kind: 'saving' });
    try {
      await onSave(validation.patch);
      setSaveStatus({ kind: 'saved', at: new Date() });
    } catch (err) {
      setSaveStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <PanelShell
      record={record}
      configExpanded={configExpanded}
      setConfigExpanded={setConfigExpanded}
    >
      {configExpanded && (
        <div
          id="launcher-launched-generator-config"
          data-testid="launcher-launched-generator-config"
          className="flex flex-col gap-3.5 pt-3.5"
        >
          <Separator />
          <h3 className="m-0 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--fg-dim)]">
            Hot-apply config
          </h3>

          <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
            <NumField
              label="Cadence (ms)"
              testid="launcher-launched-generator-cadenceMs"
              value={form.cadenceMs}
              onChange={(v) => set('cadenceMs', v)}
              error={validation.errors.cadenceMs}
              disabled={saving}
            />
            <NumField
              label="Submission window (ms)"
              testid="launcher-launched-generator-windowMs"
              value={form.windowMs}
              onChange={(v) => set('windowMs', v)}
              error={validation.errors.windowMs}
              disabled={saving}
            />
            <NumField
              label="Resolve gap (ms)"
              testid="launcher-launched-generator-resolveGapMs"
              value={form.resolveGapMs}
              onChange={(v) => set('resolveGapMs', v)}
              error={validation.errors.resolveGapMs}
              disabled={saving}
            />
            <NumField
              label="Max rounds / poll"
              testid="launcher-launched-generator-maxNewRoundsPerPoll"
              value={form.maxNewRoundsPerPoll}
              onChange={(v) => set('maxNewRoundsPerPoll', v)}
              error={validation.errors.maxNewRoundsPerPoll}
              disabled={saving}
            />
            <NumField
              label="Max rounds / day"
              testid="launcher-launched-generator-maxNewRoundsPerDay"
              value={form.maxNewRoundsPerDay}
              onChange={(v) => set('maxNewRoundsPerDay', v)}
              error={validation.errors.maxNewRoundsPerDay}
              disabled={saving}
            />
            <NumField
              label="Max open rounds"
              testid="launcher-launched-generator-maxOpenRounds"
              value={form.maxOpenRounds}
              onChange={(v) => set('maxOpenRounds', v)}
              error={validation.errors.maxOpenRounds}
              disabled={saving}
            />
          </div>

          <ListField
            label="Allowlist condition ids"
            testid="launcher-launched-generator-allowlistConditionIds"
            value={form.allowlistConditionIds}
            onChange={(v) => set('allowlistConditionIds', v)}
            disabled={saving}
          />
          <ListField
            label="Blocklist condition ids"
            testid="launcher-launched-generator-blocklistConditionIds"
            value={form.blocklistConditionIds}
            onChange={(v) => set('blocklistConditionIds', v)}
            disabled={saving}
          />

          <GeneratorSaveRow
            dirty={dirty}
            saving={saving}
            validationOk={validation.ok}
            saveStatus={saveStatus}
            onSubmit={submit}
          />
        </div>
      )}
    </PanelShell>
  );
}

function SweRebenchV2GeneratorPanel({
  record,
  manifest,
  onSave,
}: GeneratorPanelProps): JSX.Element {
  const initial = useMemo(
    () => initialSweRebenchV2Form(record.generatorConfig, manifest),
    [record.generatorConfig, manifest],
  );
  const [form, setForm] = useState<SweRebenchV2FormState>(initial);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [configExpanded, setConfigExpanded] = useState(false);

  useEffect(() => {
    setForm((prev) => {
      const dirty = JSON.stringify(prev) !== JSON.stringify(initial);
      if (dirty) return prev;
      return initial;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(record.generatorConfig)]);

  const set = <K extends keyof SweRebenchV2FormState>(key: K, value: string): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const validation = useMemo(
    () => buildSweRebenchV2Patch(form, initial),
    [form, initial],
  );
  const dirty = Object.keys(validation.patch).length > 0;
  const saving = saveStatus.kind === 'saving';

  const submit = async (): Promise<void> => {
    if (!validation.ok || !dirty || saving) return;
    setSaveStatus({ kind: 'saving' });
    try {
      await onSave(validation.patch);
      setSaveStatus({ kind: 'saved', at: new Date() });
    } catch (err) {
      setSaveStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <PanelShell
      record={record}
      configExpanded={configExpanded}
      setConfigExpanded={setConfigExpanded}
    >
      {configExpanded && (
        <div
          id="launcher-launched-generator-config"
          data-testid="launcher-launched-generator-config"
          className="flex flex-col gap-3.5 pt-3.5"
        >
          <Separator />
          <h3 className="m-0 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--fg-dim)]">
            Hot-apply config
          </h3>

          <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
            <NumField
              label="Target successful Verdicts per instance"
              testid="launcher-launched-generator-N_target_successes"
              value={form.N_target_successes}
              onChange={(v) => set('N_target_successes', v)}
              error={validation.errors.N_target_successes}
              disabled={saving}
            />
            <NumField
              label="Posting window (ms)"
              testid="launcher-launched-generator-posting_window_ms"
              value={form.posting_window_ms}
              onChange={(v) => set('posting_window_ms', v)}
              error={validation.errors.posting_window_ms}
              disabled={saving}
            />
            <NumField
              label="Post batch size"
              testid="launcher-launched-generator-post_batch_size"
              value={form.post_batch_size}
              onChange={(v) => set('post_batch_size', v)}
              error={validation.errors.post_batch_size}
              disabled={saving}
            />
          </div>

          <h3 className="m-0 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--fg-dim)]">
            Claim policy
          </h3>

          <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
            <NumField
              label="Max claims per operator"
              testid="launcher-launched-generator-maxClaimsPerOperator"
              value={form.maxClaimsPerOperator}
              onChange={(v) => set('maxClaimsPerOperator', v)}
              error={validation.errors.maxClaimsPerOperator}
              disabled={saving}
            />
            <NumField
              label="Claim lease (seconds)"
              testid="launcher-launched-generator-claimLeaseTtlSeconds"
              value={form.claimLeaseTtlSeconds}
              onChange={(v) => set('claimLeaseTtlSeconds', v)}
              error={validation.errors.claimLeaseTtlSeconds}
              disabled={saving}
            />
          </div>

          <GeneratorSaveRow
            dirty={dirty}
            saving={saving}
            validationOk={validation.ok}
            saveStatus={saveStatus}
            onSubmit={submit}
          />
        </div>
      )}
    </PanelShell>
  );
}

function GeneratorSaveRow({
  dirty,
  saving,
  validationOk,
  saveStatus,
  onSubmit,
}: {
  dirty: boolean;
  saving: boolean;
  validationOk: boolean;
  saveStatus: SaveStatus;
  onSubmit: () => Promise<void>;
}): JSX.Element {
  const canSave = dirty && validationOk && !saving;
  return (
    <div className="flex flex-col gap-2 pt-2">
      <Separator />
      <div className="flex items-center justify-between gap-3 pt-1">
      <SaveStatusLine status={saveStatus} />
      <Button
        type="button"
        variant="default"
        data-testid="launcher-launched-generator-save"
        onClick={() => {
          void onSubmit();
        }}
        disabled={!canSave}
      >
        {saving ? 'Saving…' : 'Save'}
      </Button>
      </div>
    </div>
  );
}

function GeneratorPoolSummary({ record }: { record: LaunchedSolverNetRecord }): JSX.Element | null {
  const summary = record.generatorState?.lastPollSummary;
  if (!isPoolSummary(summary)) return null;
  return (
    <dl
      data-testid="launcher-launched-generator-pool-summary"
      className="m-0 grid gap-y-2 gap-x-4 [grid-template-columns:repeat(auto-fit,minmax(120px,1fr))]"
    >
      <MetaItem label="Pool" value={String(summary.poolSize)} testid="launcher-launched-generator-poolSize" />
      <MetaItem label="Posted" value={String(summary.posted)} testid="launcher-launched-generator-posted" />
      <MetaItem label="Unposted" value={String(summary.unposted)} testid="launcher-launched-generator-unposted" />
      <MetaItem label="Live" value={String(summary.live)} testid="launcher-launched-generator-live" />
      <MetaItem label="Repostable" value={String(summary.repostable)} testid="launcher-launched-generator-repostable" />
      <MetaItem label="Saturated" value={String(summary.saturated)} testid="launcher-launched-generator-saturated" />
    </dl>
  );
}

function isPoolSummary(value: unknown): value is {
  poolSize: number;
  posted: number;
  unposted: number;
  live: number;
  repostable: number;
  saturated: number;
} {
  if (typeof value !== 'object' || value === null) return false;
  const summary = value as Record<string, unknown>;
  return [
    'poolSize',
    'posted',
    'unposted',
    'live',
    'repostable',
    'saturated',
  ].every((key) => typeof summary[key] === 'number');
}

function GeneratorError({ record }: { record: LaunchedSolverNetRecord }): JSX.Element {
  return (
    <div
      data-testid="launcher-launched-generator-error"
      className="flex flex-col gap-1 rounded-md border border-destructive bg-card p-3"
    >
      <span className="font-mono text-[12px] font-medium text-destructive">
        Last error · {formatTimestamp(record.generatorState?.lastError?.at)}
      </span>
      <span className="font-mono text-[12px] text-[var(--fg-muted)]">
        {record.generatorState?.lastError?.message}
      </span>
    </div>
  );
}

function PoolRepublishedNotice({
  record,
}: {
  record: LaunchedSolverNetRecord;
}): JSX.Element | null {
  const updatedAt = record.generatorState?.poolPublicationUpdatedAt;
  if (!updatedAt) return null;
  const prior = record.generatorState?.poolPublicationPriorSize;
  const current = record.generatorState?.poolPublicationCurrentSize;
  const sizeFragment =
    typeof prior === 'number' && typeof current === 'number'
      ? `Pool grew from ${prior} → ${current} scorable tasks`
      : 'Pool re-published';
  return (
    <Alert
      data-testid="launcher-launched-generator-pool-republished"
      variant="default"
    >
      <AlertTitle>Vetted pool re-published</AlertTitle>
      <AlertDescription>
        {sizeFragment} · {formatTimestamp(updatedAt)}
      </AlertDescription>
    </Alert>
  );
}

function PoolStaleNotice({
  record,
}: {
  record: LaunchedSolverNetRecord;
}): JSX.Element | null {
  if (record.generatorState?.poolPublicationStale !== true) return null;
  return (
    <Alert
      data-testid="launcher-launched-generator-pool-stale"
      variant="warning"
    >
      <AlertTitle>Vetted pool re-publish needed</AlertTitle>
      <AlertDescription>
        Published under an older eval-semantics version; the daemon
        re-publishes on the next generator tick.
      </AlertDescription>
    </Alert>
  );
}

function GeneratorStatusBadge({
  record,
}: {
  record: LaunchedSolverNetRecord;
}): JSX.Element {
  const enabled = record.generatorEnabled;
  const errored = Boolean(record.generatorState?.lastError);
  const tone: { variant: NonNullable<Parameters<typeof Badge>[0]['variant']>; label: string } =
    errored
      ? { variant: 'destructive', label: 'Errored' }
      : enabled
        ? { variant: 'success', label: 'Enabled' }
        : { variant: 'outline', label: 'Disabled' };
  return (
    <Badge
      data-testid="launcher-launched-generator-state-badge"
      variant={tone.variant}
    >
      {tone.label}
    </Badge>
  );
}

function SaveStatusLine({ status }: { status: SaveStatus }): JSX.Element {
  if (status.kind === 'saving') {
    return (
      <span
        data-testid="launcher-launched-generator-save-status"
        className="font-mono text-[12px] text-[var(--fg-muted)]"
      >
        Saving…
      </span>
    );
  }
  if (status.kind === 'saved') {
    const ts = status.at.toISOString().slice(11, 16);
    return (
      <span
        data-testid="launcher-launched-generator-save-status"
        // var(--vow-green) is unmapped in tailwind config (no shadcn equivalent
        // for the protocol "vow" tone); used here to mark a successful save.
        className="font-mono text-[12px] text-[var(--vow-green)]"
      >
        Saved at {ts} UTC
      </span>
    );
  }
  if (status.kind === 'error') {
    return (
      <span
        data-testid="launcher-launched-generator-save-status"
        className="font-mono text-[12px] text-destructive"
      >
        Save failed: {status.message}
      </span>
    );
  }
  return (
    <span
      data-testid="launcher-launched-generator-save-status"
      className="font-mono text-[11px] text-[var(--fg-dim)]"
    >
      Edits hot-apply without restart.
    </span>
  );
}

interface NumFieldProps {
  label: string;
  testid: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  disabled?: boolean;
}

function NumField({
  label,
  testid,
  value,
  onChange,
  error,
  disabled,
}: NumFieldProps): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Label
        htmlFor={testid}
        className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--fg-dim)]"
      >
        {label}
      </Label>
      <Input
        id={testid}
        data-testid={testid}
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={cn(error && 'border-destructive')}
      />
      {error && (
        <span
          data-testid={`${testid}-error`}
          className="font-mono text-[11px] text-destructive"
        >
          {error}
        </span>
      )}
    </div>
  );
}

interface ListFieldProps {
  label: string;
  testid: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}

function ListField({
  label,
  testid,
  value,
  onChange,
  disabled,
}: ListFieldProps): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Label
        htmlFor={testid}
        className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--fg-dim)]"
      >
        {label}
      </Label>
      <textarea
        id={testid}
        data-testid={testid}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={2}
        placeholder="0xabc…, 0xdef…"
        className="flex w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[13px] text-foreground transition-colors placeholder:text-[var(--fg-dim)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      />
    </div>
  );
}

function MetaItem({
  label,
  value,
  testid,
}: {
  label: string;
  value: string;
  testid?: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--fg-dim)]">
        {label}
      </dt>
      <dd
        data-testid={testid}
        className="m-0 font-mono text-[13px] text-foreground"
      >
        {value}
      </dd>
    </div>
  );
}
