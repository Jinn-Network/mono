import { useState } from 'react';
import type { SolverNetCatalogEntry } from '../../api/types.js';
import { ConfigField } from '../../components/ConfigField.js';
import { api } from '../../api/client.js';

/**
 * Per-SolverNet card inside the Configuration > SolverNets section. Shows
 * the catalog name + description + state pill + enable toggle. When
 * enabled, expands a body with role / harness / model / plugins fields and
 * a per-net save lifecycle (Cancel + Save changes).
 *
 * Disabling a net while edits are pending opens an in-card confirm prompt
 * before discarding the edits.
 */

export interface NetCardConfig {
  enabled: boolean;
  role: 'solving' | 'evaluating';
  harness: string;
  model: string;
  modelExplicit?: boolean;
  plugins: string[];
}

export interface NetCardProps {
  catalog: SolverNetCatalogEntry;
  config: NetCardConfig;
  onSaved: () => void;
  onRestartPending: () => void;
}

export function NetCard({ catalog, config, onSaved, onRestartPending }: NetCardProps): JSX.Element {
  const [draft, setDraft] = useState<NetCardConfig>(config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const dirty =
    draft.enabled !== config.enabled ||
    draft.role !== config.role ||
    draft.harness !== config.harness ||
    draft.model !== config.model ||
    draft.plugins.join(',') !== config.plugins.join(',');

  const stateLabel: { label: string; color: string } = (() => {
    if (catalog.state === 'coming_soon') return { label: 'Coming soon', color: 'var(--fg-dim)' };
    if (config.enabled) return { label: 'Live', color: 'var(--vow-green)' };
    return { label: 'Available', color: 'var(--fg-muted)' };
  })();

  const toggle = (): void => {
    if (catalog.state === 'coming_soon') return;
    if (!draft.enabled) {
      setDraft({ ...draft, enabled: true });
      return;
    }
    if (dirty) {
      setConfirmDisable(true);
      return;
    }
    setDraft({ ...draft, enabled: false });
  };

  const cancel = (): void => {
    setDraft(config);
    setError(null);
    setConfirmDisable(false);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const patch: Parameters<typeof api.updateSolverNet>[1] = {
        enabled: draft.enabled,
        role: draft.role,
        harness: draft.harness,
        plugins: draft.plugins,
      };
      if (config.modelExplicit || draft.model !== config.model) {
        patch.model = draft.model;
      }
      const res = await api.updateSolverNet(catalog.name, patch);
      if (res.restartRequired) onRestartPending();
      onSaved();
      setConfirmDisable(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg)', overflow: 'hidden' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr auto auto',
          gap: '16px',
          alignItems: 'center',
          padding: '14px 18px',
        }}
      >
        <span style={{ width: '26px', height: '26px', border: '1px solid var(--border)', borderRadius: '6px' }} />
        <span>
          <span style={{ fontSize: '15px', fontWeight: 500, color: 'var(--fg)' }}>{catalog.name}</span>
          <span style={{ display: 'block', fontSize: '12px', color: 'var(--fg-muted)', marginTop: '2px' }}>
            {catalog.description}
          </span>
        </span>
        <span
          style={{
            fontSize: '11px',
            fontWeight: 500,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: stateLabel.color,
            border: `1px solid ${stateLabel.color}`,
            borderRadius: '999px',
            padding: '2px 10px',
          }}
        >
          {stateLabel.label}
        </span>
        <button
          type="button"
          onClick={toggle}
          disabled={catalog.state === 'coming_soon'}
          aria-label={draft.enabled ? `Disable ${catalog.name}` : `Enable ${catalog.name}`}
          style={{
            background: 'var(--bg-elevated)',
            border: `1px solid ${draft.enabled ? 'var(--accent-sky)' : 'var(--border)'}`,
            borderRadius: '999px',
            width: '36px',
            height: '18px',
            position: 'relative',
            cursor: catalog.state === 'coming_soon' ? 'not-allowed' : 'pointer',
            opacity: catalog.state === 'coming_soon' ? 0.5 : 1,
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: '2px',
              left: draft.enabled ? 'auto' : '3px',
              right: draft.enabled ? '3px' : 'auto',
              width: '12px',
              height: '12px',
              borderRadius: '50%',
              background: draft.enabled ? 'var(--accent-sky)' : 'var(--fg-muted)',
            }}
          />
        </button>
      </div>

      {draft.enabled && (
        <div
          style={{
            borderTop: '1px solid var(--border)',
            padding: '18px 20px',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '16px',
            background: 'var(--bg-sunken)',
          }}
        >
          <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '11px',
                fontWeight: 500,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--fg-muted)',
              }}
            >
              Role
            </span>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${catalog.supportedRoles.length}, 1fr)`, border: '1px solid var(--border)', borderRadius: '6px', overflow: 'hidden' }}>
              {catalog.supportedRoles.map((role, idx) => {
                const active = draft.role === role;
                return (
                  <button
                    key={role}
                    type="button"
                    data-role-active={active ? 'true' : 'false'}
                    onClick={() => setDraft({ ...draft, role })}
                    style={{
                      padding: '10px 14px',
                      textAlign: 'center',
                      color: active ? 'var(--fg)' : 'var(--fg-muted)',
                      background: active ? 'var(--bg)' : 'transparent',
                      borderRight: idx < catalog.supportedRoles.length - 1 ? '1px solid var(--border)' : 'none',
                      border: 'none',
                      cursor: 'pointer',
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    <span style={{ display: 'block', fontSize: '14px', fontWeight: 500 }}>
                      {role.charAt(0).toUpperCase() + role.slice(1)}
                    </span>
                    <span style={{ display: 'block', fontSize: '11px', color: active ? 'var(--fg-muted)' : 'var(--fg-dim)' }}>
                      {role === 'solving' ? 'attempt forecasts' : "verify others' forecasts"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <ConfigField label="Harness" restartRequired>
            <select
              value={draft.harness}
              onChange={(e) => setDraft({ ...draft, harness: e.target.value })}
              style={{
                background: 'var(--bg)',
                border: `1px solid ${draft.harness !== config.harness ? 'var(--accent-sky)' : 'var(--border)'}`,
                borderRadius: '6px',
                padding: '10px 12px',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '14px',
                color: 'var(--fg)',
              }}
            >
              {catalog.compatibleHarnesses
                .filter((h) => h.supportsRoles.includes(draft.role))
                .map((h) => (
                  <option key={h.name} value={h.name}>
                    {h.name}@{h.version}
                  </option>
                ))}
            </select>
          </ConfigField>

          <ConfigField label="Claude model" restartRequired>
            <input
              type="text"
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              style={{
                background: 'var(--bg)',
                border: `1px solid ${draft.model !== config.model ? 'var(--accent-sky)' : 'var(--border)'}`,
                borderRadius: '6px',
                padding: '10px 12px',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '14px',
                color: 'var(--fg)',
              }}
            />
          </ConfigField>

          <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '11px',
                fontWeight: 500,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--fg-muted)',
              }}
            >
              Plugins
            </span>
            {draft.plugins.map((p) => {
              const meta = catalog.compatiblePlugins.find((cp) => cp.name === p);
              return (
                <div
                  key={p}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px 14px',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    background: 'var(--bg)',
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  <span style={{ fontSize: '14px' }}>{p}</span>
                  <span style={{ color: 'var(--fg-dim)', fontSize: '12px' }}>
                    {meta ? `${meta.source} · ${meta.version}` : '—'}
                  </span>
                </div>
              );
            })}
            <button
              type="button"
              disabled
              style={{
                border: '1px dashed var(--border)',
                borderRadius: '6px',
                padding: '10px 14px',
                background: 'transparent',
                color: 'var(--fg-dim)',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '11px',
                fontWeight: 500,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                cursor: 'not-allowed',
                textAlign: 'center',
              }}
            >
              + Add plugin (coming soon)
            </button>
          </div>
        </div>
      )}

      {confirmDisable && (
        <div
          style={{
            padding: '14px 20px',
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-elevated)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '13px',
            color: 'var(--fg)',
          }}
        >
          <span>Discard pending changes and disable {catalog.name}?</span>
          <span style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              onClick={() => setConfirmDisable(false)}
              style={{ border: '1px solid var(--border)', borderRadius: '6px', padding: '6px 14px', background: 'transparent', color: 'var(--fg)', fontFamily: 'inherit', fontSize: '12px' }}
            >
              Keep
            </button>
            <button
              type="button"
              onClick={() => { setDraft({ ...config, enabled: false }); setConfirmDisable(false); }}
              style={{ border: '1px solid var(--break-red)', borderRadius: '6px', padding: '6px 14px', background: 'var(--break-red)', color: 'var(--fg)', fontFamily: 'inherit', fontSize: '12px' }}
            >
              Discard + disable
            </button>
          </span>
        </div>
      )}

      {dirty && !confirmDisable && (
        <div
          style={{
            padding: '14px 20px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          <span style={{ fontSize: '12px', color: error ? 'var(--break-red)' : 'var(--accent-sky)' }}>
            {error ?? (saving ? 'Saving…' : 'Changes pending')}
          </span>
          <span style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              onClick={cancel}
              disabled={saving}
              style={{ border: '1px solid var(--border)', borderRadius: '6px', padding: '10px 20px', background: 'transparent', color: 'var(--fg)', fontFamily: 'inherit', fontSize: '14px' }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { void save(); }}
              disabled={saving}
              style={{ border: '1px solid var(--accent-sky)', borderRadius: '6px', padding: '10px 20px', background: 'var(--accent-sky)', color: 'var(--bg-sunken)', fontFamily: 'inherit', fontSize: '14px' }}
            >
              Save changes
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
