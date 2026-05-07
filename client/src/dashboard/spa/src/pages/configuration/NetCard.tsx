import { useState } from 'react';
import type {
  SolverNetCatalogEntry,
  SolverNetManifestV1,
} from '../../api/types.js';
import { ConfigField } from '../../components/ConfigField.js';
import { api } from '../../api/client.js';
import { SolverNetSigil } from './solverNetSigils.js';
import { CLAUDE_MODELS, resolveModelOption } from './claudeModels.js';

/**
 * Per-SolverNet card inside the Operator > SolverNets section.
 *
 * Two modes, distinguished by props (Task 21 introduces the manifest-keyed
 * mode; the legacy mode lingers until Task 22 drops the legacy schema):
 *
 *   1. Legacy mode — `{catalog, config}`. Shows the bundled catalog row +
 *      enable toggle + role/harness/model/plugins editor. Persists through
 *      `POST /v1/setup/solvernets/:name`.
 *
 *   2. Manifest-keyed mode — `{manifest, manifestCid, joined}`. Shows the
 *      manifest summary + current roles + Leave button. Persists through
 *      `DELETE /v1/operator/join/:cid`. The full edit form lives in the
 *      `JoinFlow` page; this card surfaces the resulting state and
 *      provides the Leave affordance.
 *
 * Disabling a net while edits are pending opens an in-card confirm prompt
 * before discarding the edits.
 */

export type NetCardRole = 'solving' | 'evaluating';

export interface NetCardConfig {
  enabled: boolean;
  /**
   * Active operator roles for this SolverNet. Non-empty when persisted —
   * the operator disables the net via the enable toggle, not by clearing
   * roles. Both roles can be active concurrently; the daemon enforces
   * `disallowSolverSelfEvaluation` so the operator never grades its own
   * Solutions.
   */
  roles: NetCardRole[];
  harness: string;
  model: string;
  modelExplicit?: boolean;
  plugins: string[];
}

function rolesEqual(a: NetCardRole[], b: NetCardRole[]): boolean {
  if (a.length !== b.length) return false;
  const aset = new Set(a);
  return b.every((r) => aset.has(r));
}

/** Legacy / built-in catalog-row mode (`/v1/setup/solvernets/:name`). */
export interface NetCardLegacyProps {
  catalog: SolverNetCatalogEntry;
  config: NetCardConfig;
  onSaved: () => void;
  onRestartPending: () => void;
}

/** Manifest-keyed joined-instance mode (`/v1/operator/join/:cid`). */
export interface NetCardJoinedProps {
  manifestCid: string;
  manifest: SolverNetManifestV1;
  joined: {
    roles: Array<'solver' | 'evaluator'>;
    harness?: string;
    model?: string;
    plugins?: string[];
  };
  onLeft: () => void;
  onRestartPending: () => void;
}

export type NetCardProps = NetCardLegacyProps | NetCardJoinedProps;

function isJoinedProps(props: NetCardProps): props is NetCardJoinedProps {
  return (props as NetCardJoinedProps).manifest !== undefined;
}

export function NetCard(props: NetCardProps): JSX.Element {
  if (isJoinedProps(props)) {
    return <JoinedNetCard {...props} />;
  }
  return <LegacyNetCard {...props} />;
}

function LegacyNetCard({ catalog, config, onSaved, onRestartPending }: NetCardLegacyProps): JSX.Element {
  const [draft, setDraft] = useState<NetCardConfig>(config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const dirty =
    draft.enabled !== config.enabled ||
    !rolesEqual(draft.roles, config.roles) ||
    draft.harness !== config.harness ||
    draft.model !== config.model ||
    draft.plugins.join(',') !== config.plugins.join(',');

  const rolesValid = draft.roles.length > 0;

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
    if (!rolesValid) {
      setError('At least one role required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const patch: Parameters<typeof api.updateSolverNet>[1] = {
        enabled: draft.enabled,
        roles: draft.roles,
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

  const toggleRole = (role: NetCardRole): void => {
    if (!catalog.supportedRoles.includes(role)) return;
    const has = draft.roles.includes(role);
    if (has) {
      // Allow unchecking even when it leaves zero roles — the validation
      // banner explains the requirement and the Save button is disabled.
      const next = draft.roles.filter((r) => r !== role);
      setDraft({ ...draft, roles: next });
      return;
    }
    // Preserve the catalog ordering ['solving', 'evaluating'] so the
    // persisted shape is canonical regardless of the order the operator
    // clicks the boxes.
    const ordered = catalog.supportedRoles.filter(
      (r) => r === role || draft.roles.includes(r),
    );
    setDraft({ ...draft, roles: ordered });
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
        <SolverNetSigil name={catalog.name} />
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
              Roles
            </span>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${catalog.supportedRoles.length}, 1fr)`,
                border: '1px solid var(--border)',
                borderRadius: '6px',
                overflow: 'hidden',
              }}
            >
              {catalog.supportedRoles.map((role, idx) => {
                const active = draft.roles.includes(role);
                const checkboxId = `role-${catalog.name}-${role}`;
                return (
                  <label
                    key={role}
                    htmlFor={checkboxId}
                    data-role={role}
                    data-role-active={active ? 'true' : 'false'}
                    style={{
                      padding: '10px 14px',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: '6px',
                      color: active ? 'var(--fg)' : 'var(--fg-muted)',
                      background: active ? 'var(--bg)' : 'transparent',
                      borderRight: idx < catalog.supportedRoles.length - 1 ? '1px solid var(--border)' : 'none',
                      cursor: 'pointer',
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <input
                        id={checkboxId}
                        type="checkbox"
                        checked={active}
                        onChange={() => toggleRole(role)}
                        aria-label={role === 'solving' ? 'Solver' : 'Evaluator'}
                        style={{ accentColor: 'var(--accent-sky)', width: '14px', height: '14px' }}
                      />
                      <span style={{ fontSize: '14px', fontWeight: 500 }}>
                        {role === 'solving' ? 'Solver' : 'Evaluator'}
                      </span>
                    </span>
                    <span
                      style={{
                        fontSize: '11px',
                        color: active ? 'var(--fg-muted)' : 'var(--fg-dim)',
                        paddingLeft: '22px',
                      }}
                    >
                      {role === 'solving' ? 'attempt forecasts' : "verify others' forecasts"}
                    </span>
                  </label>
                );
              })}
            </div>
            {!rolesValid && (
              <span
                role="alert"
                style={{
                  fontSize: '12px',
                  color: 'var(--break-red)',
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                At least one role required
              </span>
            )}
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
                // Show every harness that supports at least one currently-active role.
                // The daemon picks the right harness per-role at task-acceptance time;
                // a single Harness is allowed to cover both roles or only one.
                .filter((h) =>
                  draft.roles.length === 0
                    ? true
                    : draft.roles.some((r) => h.supportsRoles.includes(r)),
                )
                .map((h) => (
                  <option key={h.name} value={h.name}>
                    {h.name}@{h.version}
                  </option>
                ))}
            </select>
          </ConfigField>

          <ConfigField label="Claude model" restartRequired>
            {(() => {
              const resolved = resolveModelOption(draft.model);
              return (
                <select
                  aria-label="Claude model"
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
                >
                  {CLAUDE_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                  {resolved.isCustom && (
                    <option key={draft.model} value={draft.model}>
                      {resolved.label}
                    </option>
                  )}
                </select>
              );
            })()}
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
                    gap: '12px',
                    padding: '10px 14px',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    background: 'var(--bg)',
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  <span style={{ fontSize: '14px' }}>{p}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{ color: 'var(--fg-dim)', fontSize: '12px' }}>
                      {meta ? `${meta.source} · ${meta.version}` : '—'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setDraft({ ...draft, plugins: draft.plugins.filter((x) => x !== p) })}
                      aria-label={`Remove ${p}`}
                      style={{
                        border: '1px solid var(--border)',
                        borderRadius: '6px',
                        padding: '4px 10px',
                        background: 'transparent',
                        color: 'var(--fg-muted)',
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: '11px',
                        fontWeight: 500,
                        letterSpacing: '0.14em',
                        textTransform: 'uppercase',
                        cursor: 'pointer',
                      }}
                    >
                      Remove
                    </button>
                  </span>
                </div>
              );
            })}
            {(() => {
              const available = catalog.compatiblePlugins.filter(
                (cp) => !draft.plugins.includes(cp.name),
              );
              if (catalog.compatiblePlugins.length === 0) {
                return (
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '12px',
                      color: 'var(--fg-dim)',
                      padding: '4px 2px',
                    }}
                  >
                    No plugins available for this SolverNet
                  </span>
                );
              }
              if (available.length === 0) return null;
              return (
                <select
                  value=""
                  onChange={(e) => {
                    const picked = e.target.value;
                    if (!picked) return;
                    setDraft({ ...draft, plugins: [...draft.plugins, picked] });
                  }}
                  aria-label="Add plugin"
                  style={{
                    background: 'var(--bg)',
                    border: '1px dashed var(--border)',
                    borderRadius: '6px',
                    padding: '10px 12px',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '14px',
                    color: 'var(--fg)',
                  }}
                >
                  <option value="" disabled>
                    + Add plugin
                  </option>
                  {available.map((cp) => (
                    <option key={cp.name} value={cp.name}>
                      {cp.name} ({cp.source} · {cp.version})
                    </option>
                  ))}
                </select>
              );
            })()}
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
          <span style={{ fontSize: '12px', color: error || !rolesValid ? 'var(--break-red)' : 'var(--accent-sky)' }}>
            {error ?? (!rolesValid ? 'At least one role required' : saving ? 'Saving…' : 'Changes pending')}
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
              disabled={saving || !rolesValid}
              style={{
                border: `1px solid ${rolesValid ? 'var(--accent-sky)' : 'var(--border)'}`,
                borderRadius: '6px',
                padding: '10px 20px',
                background: rolesValid ? 'var(--accent-sky)' : 'transparent',
                color: rolesValid ? 'var(--bg-sunken)' : 'var(--fg-dim)',
                fontFamily: 'inherit',
                fontSize: '14px',
                cursor: rolesValid ? 'pointer' : 'not-allowed',
              }}
            >
              Save changes
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

// ── Manifest-keyed (joined) variant ─────────────────────────────────────────

function formatEthFromWei(wei: string | undefined): string {
  if (!wei || !/^\d+$/.test(wei)) return '—';
  try {
    const n = BigInt(wei);
    const eth = Number(n) / 1e18;
    if (eth === 0) return '0 ETH';
    if (eth < 0.0001) return `${eth.toExponential(3)} ETH`;
    return `${eth.toFixed(eth < 1 ? 6 : 4)} ETH`;
  } catch {
    return '—';
  }
}

function JoinedNetCard({
  manifestCid,
  manifest,
  joined,
  onLeft,
  onRestartPending,
}: NetCardJoinedProps): JSX.Element {
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const leave = async (): Promise<void> => {
    setLeaving(true);
    setError(null);
    try {
      const res = await api.operator.leave(manifestCid);
      if (res.restartRequired) onRestartPending();
      onLeft();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLeaving(false);
    }
  };

  return (
    <div
      data-testid="netcard-joined"
      data-manifest-cid={manifestCid}
      style={{
        border: '1px solid var(--border)',
        borderRadius: '6px',
        background: 'var(--bg)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr auto',
          gap: '16px',
          alignItems: 'center',
          padding: '14px 18px',
        }}
      >
        <SolverNetSigil name={manifest.contract.id} />
        <span>
          <span
            style={{ fontSize: '15px', fontWeight: 500, color: 'var(--fg)' }}
          >
            {manifest.name}
          </span>
          <span
            style={{
              display: 'block',
              fontSize: '12px',
              color: 'var(--fg-muted)',
              marginTop: '2px',
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {manifest.contract.id}@{manifest.contract.version} · launched by{' '}
            agentId {manifest.launcher.agentId}
          </span>
        </span>
        <span
          data-testid="netcard-joined-state"
          style={{
            fontSize: '11px',
            fontWeight: 500,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--vow-green)',
            border: '1px solid var(--vow-green)',
            borderRadius: '999px',
            padding: '2px 10px',
          }}
        >
          Joined
        </span>
      </div>

      <div
        style={{
          borderTop: '1px solid var(--border)',
          padding: '14px 20px',
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '6px 12px',
          background: 'var(--bg-sunken)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '12px',
          color: 'var(--fg-muted)',
        }}
      >
        <span>Roles</span>
        <span data-testid="netcard-joined-roles" style={{ color: 'var(--fg)' }}>
          {joined.roles.length === 0 ? '—' : joined.roles.join(', ')}
        </span>
        <span>Solution price</span>
        <span style={{ color: 'var(--fg)' }}>
          {formatEthFromWei(manifest.solutionPriceWei)}
        </span>
        <span>Verdict price</span>
        <span style={{ color: 'var(--fg)' }}>
          {formatEthFromWei(manifest.verdictPriceWei)}
        </span>
        {joined.roles.includes('solver') && joined.harness && (
          <>
            <span>Harness</span>
            <span
              data-testid="netcard-joined-harness"
              style={{ color: 'var(--fg)' }}
            >
              {joined.harness}
            </span>
          </>
        )}
        {joined.roles.includes('solver') && joined.model && (
          <>
            <span>Model</span>
            <span style={{ color: 'var(--fg)' }}>{joined.model}</span>
          </>
        )}
        {joined.roles.includes('solver') && (joined.plugins?.length ?? 0) > 0 && (
          <>
            <span>Plugins</span>
            <span style={{ color: 'var(--fg)' }}>
              {joined.plugins!.join(', ')}
            </span>
          </>
        )}
        {joined.roles.includes('evaluator') && (
          <>
            <span>Evaluator harness</span>
            <span
              data-testid="netcard-joined-evaluator-binding"
              style={{ color: 'var(--fg-dim)' }}
            >
              {manifest.contract.evaluationFunction.implementation} (manifest-bound)
            </span>
          </>
        )}
        <span>Manifest CID</span>
        <span
          data-testid="netcard-joined-manifest-cid"
          style={{
            color: 'var(--fg-dim)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {manifestCid}
        </span>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            padding: '10px 18px',
            borderTop: '1px solid var(--border)',
            color: 'var(--break-red)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          padding: '12px 20px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: '8px',
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        {confirm ? (
          <>
            <span
              style={{ color: 'var(--fg)', fontSize: '12px', marginRight: 'auto' }}
            >
              Leave {manifest.name}? Restart required.
            </span>
            <button
              type="button"
              onClick={() => setConfirm(false)}
              disabled={leaving}
              style={{
                border: '1px solid var(--border)',
                borderRadius: '6px',
                padding: '6px 14px',
                background: 'transparent',
                color: 'var(--fg)',
                fontFamily: 'inherit',
                fontSize: '12px',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="netcard-joined-leave-confirm"
              onClick={() => {
                void leave();
              }}
              disabled={leaving}
              style={{
                border: '1px solid var(--break-red)',
                borderRadius: '6px',
                padding: '6px 14px',
                background: 'var(--break-red)',
                color: 'var(--fg)',
                fontFamily: 'inherit',
                fontSize: '12px',
              }}
            >
              {leaving ? 'Leaving…' : 'Leave'}
            </button>
          </>
        ) : (
          <button
            type="button"
            data-testid="netcard-joined-leave"
            onClick={() => setConfirm(true)}
            style={{
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '8px 16px',
              background: 'transparent',
              color: 'var(--fg)',
              fontFamily: 'inherit',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            Leave
          </button>
        )}
      </div>
    </div>
  );
}
