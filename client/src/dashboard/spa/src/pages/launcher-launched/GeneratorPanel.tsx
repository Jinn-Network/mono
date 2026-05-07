import { useEffect, useMemo, useState } from 'react';
import type {
  GeneratorConfig,
  LaunchedSolverNetRecord,
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

export interface GeneratorPanelProps {
  record: LaunchedSolverNetRecord;
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

export function GeneratorPanel({ record, onSave }: GeneratorPanelProps): JSX.Element {
  const initial = useMemo(() => initialForm(record.generatorConfig), [record.generatorConfig]);
  const [form, setForm] = useState<FormState>(initial);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });

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
        <h2 style={titleStyle}>Generator</h2>
        <GeneratorStatusBadge record={record} />
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

      <h3
        style={{
          margin: 0,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-dim)',
        }}
      >
        Hot-apply config
      </h3>

      <div
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}
      >
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

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          paddingTop: '8px',
          borderTop: '1px solid var(--border)',
        }}
      >
        <SaveStatusLine status={saveStatus} />
        <button
          type="button"
          data-testid="launcher-launched-generator-save"
          onClick={() => {
            void submit();
          }}
          disabled={!dirty || !validation.ok || saving}
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '13px',
            padding: '10px 18px',
            background:
              dirty && validation.ok && !saving
                ? 'var(--accent-sky)'
                : 'var(--bg-elevated)',
            color:
              dirty && validation.ok && !saving
                ? 'var(--bg-sunken)'
                : 'var(--fg-dim)',
            border: '1px solid var(--accent-sky)',
            borderRadius: 'var(--radius-2)',
            cursor:
              dirty && validation.ok && !saving ? 'pointer' : 'not-allowed',
            opacity: dirty && validation.ok && !saving ? 1 : 0.7,
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
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
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: "'Instrument Serif', 'Times New Roman', serif",
  fontSize: '22px',
  color: 'var(--fg)',
  fontWeight: 400,
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
