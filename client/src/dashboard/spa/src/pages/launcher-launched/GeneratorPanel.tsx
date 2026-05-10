import { useEffect, useMemo, useState } from 'react';
import type {
  GeneratorConfig,
  LaunchedSolverNetRecord,
  SolverNetManifestV1,
} from '../../api/types.js';
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
const SWE_REBENCH_V2_MIN_COOLDOWN_MS = 60_000;

export interface GeneratorPanelProps {
  record: LaunchedSolverNetRecord;
  manifest?: SolverNetManifestV1;
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
  N_max_postings_per_task: string;
  cooldown_ms: string;
  maxClaims: string;
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
    maxClaims: 50,
    maxClaimsPerOperator: 5,
    claimLeaseTtlSeconds: 60 * 60,
  };
  return {
    N_target_successes: stringField(c.N_target_successes),
    N_max_postings_per_task: stringField(c.N_max_postings_per_task),
    cooldown_ms: stringField(c.cooldown_ms),
    maxClaims: stringField(policy.maxClaims ?? defaults.maxClaims),
    maxClaimsPerOperator: stringField(
      policy.maxClaimsPerOperator ?? defaults.maxClaimsPerOperator,
    ),
    claimLeaseTtlSeconds: stringField(
      policy.claimLeaseTtlSeconds ?? defaults.claimLeaseTtlSeconds,
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

  const parsedTarget = parsePositiveInt(form.N_target_successes);
  const parsedMaxPostings = parsePositiveInt(form.N_max_postings_per_task);
  const parsedMaxClaims = parsePositiveInt(form.maxClaims);
  const parsedMaxClaimsPerOperator = parsePositiveInt(form.maxClaimsPerOperator);

  for (const key of [
    'N_target_successes',
    'N_max_postings_per_task',
    'cooldown_ms',
  ] as const) {
    if (form[key] === prior[key]) continue;
    if (form[key].trim().length === 0) continue;
    const parsed = parsePositiveInt(form[key]);
    if (parsed === null) {
      errors[key] = key === 'cooldown_ms'
        ? 'Must be a positive integer (ms).'
        : 'Must be a positive integer.';
      continue;
    }
    if (key === 'cooldown_ms' && parsed < SWE_REBENCH_V2_MIN_COOLDOWN_MS) {
      errors[key] = `Cooldown must be at least ${SWE_REBENCH_V2_MIN_COOLDOWN_MS / 1000}s.`;
      continue;
    }
    patch[key] = parsed;
  }

  const claimPolicyPatch: Record<string, unknown> = {};
  for (const key of [
    'maxClaims',
    'maxClaimsPerOperator',
    'claimLeaseTtlSeconds',
  ] as const) {
    if (form[key] === prior[key]) continue;
    if (form[key].trim().length === 0) continue;
    const parsed = parsePositiveInt(form[key]);
    if (parsed === null) {
      errors[key] = key === 'claimLeaseTtlSeconds'
        ? 'Must be a positive integer (seconds).'
        : 'Must be a positive integer.';
      continue;
    }
    claimPolicyPatch[key] = parsed;
  }
  if (Object.keys(claimPolicyPatch).length > 0) {
    patch.claimPolicy = claimPolicyPatch;
  }

  if (
    parsedTarget !== null &&
    parsedMaxPostings !== null &&
    parsedMaxPostings < parsedTarget
  ) {
    errors.N_max_postings_per_task =
      'Max postings must be >= target successes.';
  }
  if (
    parsedMaxClaims !== null &&
    parsedMaxClaimsPerOperator !== null &&
    parsedMaxClaimsPerOperator > parsedMaxClaims
  ) {
    errors.maxClaimsPerOperator =
      'Claims per operator must be <= max claims.';
  }

  return {
    ok: Object.keys(errors).length === 0,
    patch: patch as Partial<GeneratorConfig>,
    errors,
  };
}

function isSweRebenchV2Record(record: LaunchedSolverNetRecord): boolean {
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
    Object.prototype.hasOwnProperty.call(config, 'cooldown_ms')
  );
}

export function GeneratorPanel({ record, manifest, onSave }: GeneratorPanelProps): JSX.Element {
  if (isSweRebenchV2Record(record)) {
    return <SweRebenchV2GeneratorPanel record={record} manifest={manifest} onSave={onSave} />;
  }
  return <PredictionGeneratorPanel record={record} onSave={onSave} />;
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
    <section
      data-testid="launcher-launched-generator-panel"
      style={panelStyle}
    >
      <header style={headerStyle}>
        <div style={titleRowStyle}>
          <h2 style={titleStyle}>Generator</h2>
          <GeneratorStatusBadge record={record} />
        </div>
        <button
          type="button"
          data-testid="launcher-launched-generator-toggle"
          aria-expanded={configExpanded}
          aria-controls="launcher-launched-generator-config"
          onClick={() => setConfigExpanded((expanded) => !expanded)}
          style={toggleButtonStyle}
        >
          {configExpanded ? 'Hide config' : 'Edit config'}
        </button>
      </header>

      <dl style={metaGridStyle}>
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
      </dl>

      {record.generatorState?.lastError && (
        <div
          data-testid="launcher-launched-generator-error"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--break-red)',
            borderRadius: 'var(--radius-2)',
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
          }}
        >
          <span
            style={{
              color: 'var(--break-red)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '12px',
              fontWeight: 500,
            }}
          >
            Last error · {formatTimestamp(record.generatorState.lastError.at)}
          </span>
          <span
            style={{
              color: 'var(--fg-muted)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '12px',
            }}
          >
            {record.generatorState.lastError.message}
          </span>
        </div>
      )}

      {configExpanded && (
        <div
          id="launcher-launched-generator-config"
          data-testid="launcher-launched-generator-config"
          style={configBodyStyle}
        >
          <h3 style={sectionHeadingStyle}>Hot-apply config</h3>

          <div style={twoColumnGridStyle}>
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
    </section>
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
    <section
      data-testid="launcher-launched-generator-panel"
      style={panelStyle}
    >
      <header style={headerStyle}>
        <div style={titleRowStyle}>
          <h2 style={titleStyle}>Generator</h2>
          <GeneratorStatusBadge record={record} />
        </div>
        <button
          type="button"
          data-testid="launcher-launched-generator-toggle"
          aria-expanded={configExpanded}
          aria-controls="launcher-launched-generator-config"
          onClick={() => setConfigExpanded((expanded) => !expanded)}
          style={toggleButtonStyle}
        >
          {configExpanded ? 'Hide config' : 'Edit config'}
        </button>
      </header>

      <dl style={metaGridStyle}>
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
      </dl>

      {record.generatorState?.lastError && <GeneratorError record={record} />}

      {configExpanded && (
        <div
          id="launcher-launched-generator-config"
          data-testid="launcher-launched-generator-config"
          style={configBodyStyle}
        >
          <h3 style={sectionHeadingStyle}>Hot-apply config</h3>

          <div style={twoColumnGridStyle}>
            <NumField
              label="Target successful Verdicts per instance"
              testid="launcher-launched-generator-N_target_successes"
              value={form.N_target_successes}
              onChange={(v) => set('N_target_successes', v)}
              error={validation.errors.N_target_successes}
              disabled={saving}
            />
            <NumField
              label="Max Task postings per instance"
              testid="launcher-launched-generator-N_max_postings_per_task"
              value={form.N_max_postings_per_task}
              onChange={(v) => set('N_max_postings_per_task', v)}
              error={validation.errors.N_max_postings_per_task}
              disabled={saving}
            />
            <NumField
              label="Cooldown between task postings (ms)"
              testid="launcher-launched-generator-cooldown_ms"
              value={form.cooldown_ms}
              onChange={(v) => set('cooldown_ms', v)}
              error={validation.errors.cooldown_ms}
              disabled={saving}
            />
          </div>

          <h3 style={sectionHeadingStyle}>Claim policy</h3>

          <div style={threeColumnGridStyle}>
            <NumField
              label="Max claims per Task"
              testid="launcher-launched-generator-claimPolicy-maxClaims"
              value={form.maxClaims}
              onChange={(v) => set('maxClaims', v)}
              error={validation.errors.maxClaims}
              disabled={saving}
            />
            <NumField
              label="Max claims per operator"
              testid="launcher-launched-generator-claimPolicy-maxClaimsPerOperator"
              value={form.maxClaimsPerOperator}
              onChange={(v) => set('maxClaimsPerOperator', v)}
              error={validation.errors.maxClaimsPerOperator}
              disabled={saving}
            />
            <NumField
              label="Claim lease (seconds)"
              testid="launcher-launched-generator-claimPolicy-claimLeaseTtlSeconds"
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
    </section>
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
    <div style={saveRowStyle}>
      <SaveStatusLine status={saveStatus} />
      <button
        type="button"
        data-testid="launcher-launched-generator-save"
        onClick={() => {
          void onSubmit();
        }}
        disabled={!canSave}
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '13px',
          padding: '10px 18px',
          background: canSave ? 'var(--accent-sky)' : 'var(--bg-elevated)',
          color: canSave ? 'var(--bg-sunken)' : 'var(--fg-dim)',
          border: '1px solid var(--accent-sky)',
          borderRadius: 'var(--radius-2)',
          cursor: canSave ? 'pointer' : 'not-allowed',
          opacity: canSave ? 1 : 0.7,
        }}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

function GeneratorError({ record }: { record: LaunchedSolverNetRecord }): JSX.Element {
  return (
    <div
      data-testid="launcher-launched-generator-error"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--break-red)',
        borderRadius: 'var(--radius-2)',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      }}
    >
      <span
        style={{
          color: 'var(--break-red)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '12px',
          fontWeight: 500,
        }}
      >
        Last error · {formatTimestamp(record.generatorState?.lastError?.at)}
      </span>
      <span
        style={{
          color: 'var(--fg-muted)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '12px',
        }}
      >
        {record.generatorState?.lastError?.message}
      </span>
    </div>
  );
}

function GeneratorStatusBadge({
  record,
}: {
  record: LaunchedSolverNetRecord;
}): JSX.Element {
  const enabled = record.generatorEnabled;
  const errored = Boolean(record.generatorState?.lastError);
  const tone = errored
    ? { fg: 'var(--break-red)', label: 'Errored' }
    : enabled
      ? { fg: 'var(--vow-green)', label: 'Enabled' }
      : { fg: 'var(--fg-dim)', label: 'Disabled' };
  return (
    <span
      data-testid="launcher-launched-generator-state-badge"
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '11px',
        fontWeight: 500,
        textTransform: 'uppercase',
        letterSpacing: '0.14em',
        color: tone.fg,
        border: `1px solid ${tone.fg}`,
        borderRadius: 'var(--radius-1)',
        padding: '2px 8px',
      }}
    >
      {tone.label}
    </span>
  );
}

function SaveStatusLine({ status }: { status: SaveStatus }): JSX.Element {
  if (status.kind === 'saving') {
    return (
      <span
        data-testid="launcher-launched-generator-save-status"
        style={{
          color: 'var(--fg-muted)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '12px',
        }}
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
        style={{
          color: 'var(--vow-green)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '12px',
        }}
      >
        Saved at {ts} UTC
      </span>
    );
  }
  if (status.kind === 'error') {
    return (
      <span
        data-testid="launcher-launched-generator-save-status"
        style={{
          color: 'var(--break-red)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '12px',
        }}
      >
        Save failed: {status.message}
      </span>
    );
  }
  return (
    <span
      data-testid="launcher-launched-generator-save-status"
      style={{
        color: 'var(--fg-dim)',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '11px',
      }}
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
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={fieldLabelStyle}>{label}</span>
      <input
        data-testid={testid}
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={error ? inputErrorStyle : inputStyle}
      />
      {error && (
        <span
          data-testid={`${testid}-error`}
          style={{
            fontSize: '11px',
            color: 'var(--break-red)',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {error}
        </span>
      )}
    </label>
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
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={fieldLabelStyle}>{label}</span>
      <textarea
        data-testid={testid}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={2}
        placeholder="0xabc…, 0xdef…"
        style={{ ...inputStyle, resize: 'vertical' }}
      />
    </label>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <dt style={fieldLabelStyle}>{label}</dt>
      <dd
        data-testid={testid}
        style={{
          margin: 0,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '13px',
          color: 'var(--fg)',
        }}
      >
        {value}
      </dd>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-3)',
  padding: '20px 22px',
  display: 'flex',
  flexDirection: 'column',
  gap: '14px',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  flexWrap: 'wrap',
};

const titleRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  minWidth: 0,
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: "'Instrument Serif', 'Times New Roman', serif",
  fontSize: '22px',
  color: 'var(--fg)',
  fontWeight: 400,
};

const toggleButtonStyle: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-2)',
  color: 'var(--fg)',
  cursor: 'pointer',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '12px',
  padding: '8px 12px',
};

const configBodyStyle: React.CSSProperties = {
  borderTop: '1px solid var(--border)',
  display: 'flex',
  flexDirection: 'column',
  gap: '14px',
  paddingTop: '14px',
};

const sectionHeadingStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '11px',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-dim)',
};

const twoColumnGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: '14px',
};

const threeColumnGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: '14px',
};

const saveRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  paddingTop: '8px',
  borderTop: '1px solid var(--border)',
};

const fieldLabelStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '10px',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--fg-dim)',
};

const metaGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: '8px 16px',
  margin: 0,
};

const inputStyle: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-2)',
  padding: '10px 12px',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '13px',
  color: 'var(--fg)',
  width: '100%',
  boxSizing: 'border-box',
};

const inputErrorStyle: React.CSSProperties = {
  ...inputStyle,
  border: '1px solid var(--break-red)',
};
