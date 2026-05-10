import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import type {
  RegistryManifestResponse,
  SolverNetCatalogEntry,
  SolverNetsCatalogResponse,
} from '../../api/types.js';
import {
  defaultModelForHarness,
  modelOptionsForHarness,
  resolveModelOption,
} from './claudeModels.js';
import {
  canonicalHarnessName,
  harnessDisplayName,
  harnessNamesMatch,
  harnessOptionLabel,
} from './harnessNames.js';
import { PluginPicker } from './PluginPicker.js';

/**
 * Per-SolverNet edit card on /operator → SolverNets → Joined.
 *
 * Spec: brainstorm + plan in `/Users/adrianobradley/.claude/plans/`.
 *
 * Edit surface for `joinedSolverNets[<manifestCid>] = { roles, harness,
 * plugins, model }`. Roles are immutable post-join (set by `JoinFlow` and
 * not editable here — operators leave + rejoin to change roles). Save
 * re-uses `api.operator.join(cid, body)` with full-overwrite semantics; the
 * daemon returns `{ restartRequired: true }` and the parent (`OperatorPage`)
 * surfaces the restart banner.
 *
 * Compatibility warning: when the chosen harness isn't in
 * `catalogEntry.compatibleHarnesses` the picker surfaces the same
 * mismatch the LiveNowBand's `prediction_harness_unsupported` diagnostic
 * uses, with the list of compatible alternatives.
 */

export interface JoinedNetEntry {
  manifestCid: string;
  name?: string;
  contract?: { id: string; version: string };
  roles: Array<'solver' | 'evaluator'>;
  harness?: string;
  model?: string;
  plugins?: string[];
  disabledDefaultPlugins?: string[];
}

export interface JoinedNetCardProps {
  joined: JoinedNetEntry;
  /** When provided, skips the internal manifest+catalog lookup. Tests pass
   *  a fully-resolved entry directly; production callers omit it and let
   *  the card resolve via manifest → contract `{id, version}` → catalog
   *  entry whose contract pair matches. (The legacy intrinsicSolverType
   *  string-match was removed in PRs d4491879 / 26548969.) */
  catalogEntry?: SolverNetCatalogEntry | undefined;
  defaultExpanded?: boolean;
  /** When set, scroll the harness field into view on expand. */
  focusOn?: 'harness';
  onRestartPending?: () => void;
}

interface FormState {
  harness: string;
  plugins: string[];
  disabledDefaultPlugins: string[];
  model: string;
}

function snapshot(joined: JoinedNetEntry): FormState {
  const harness = canonicalHarnessName(joined.harness);
  return {
    harness,
    plugins: joined.plugins ?? [],
    disabledDefaultPlugins: joined.disabledDefaultPlugins ?? [],
    model: joined.model ?? defaultModelForHarness(harness),
  };
}

function isDirty(form: FormState, joined: JoinedNetEntry): boolean {
  const joinedHarness = canonicalHarnessName(joined.harness);
  if (form.harness !== joinedHarness) return true;
  if (form.model !== (joined.model ?? defaultModelForHarness(joinedHarness))) return true;
  const a = [...form.plugins].sort();
  const b = [...(joined.plugins ?? [])].sort();
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return true;
  const disabledA = [...form.disabledDefaultPlugins].sort();
  const disabledB = [...(joined.disabledDefaultPlugins ?? [])].sort();
  if (disabledA.length !== disabledB.length) return true;
  for (let i = 0; i < disabledA.length; i += 1) if (disabledA[i] !== disabledB[i]) return true;
  return false;
}

export function JoinedNetCard({
  joined,
  catalogEntry: catalogEntryProp,
  defaultExpanded = false,
  focusOn,
  onRestartPending,
}: JoinedNetCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [form, setForm] = useState<FormState>(() => snapshot(joined));
  const harnessFieldRef = useRef<HTMLDivElement | null>(null);
  const harnessSelectRef = useRef<HTMLSelectElement | null>(null);
  const queryClient = useQueryClient();

  // Resolve the catalog entry: manifest → contract {id, version} → catalog
  // match (no concatenated solverType string anywhere). Skipped
  // when the caller injected a `catalogEntry` prop (test path). Manifests
  // are content-addressed, so we cache forever once fetched.
  const skipResolve = catalogEntryProp !== undefined;
  const manifestQuery = useQuery<RegistryManifestResponse>({
    queryKey: ['solvernets', 'manifest', joined.manifestCid],
    queryFn: () => api.solvernets.getManifest(joined.manifestCid),
    enabled: !skipResolve && Boolean(joined.manifestCid),
    staleTime: Infinity,
    retry: false,
  });
  const catalogQuery = useQuery<SolverNetsCatalogResponse>({
    queryKey: ['solvernets', 'catalog'],
    queryFn: () => api.getSolverNets(),
    enabled: !skipResolve,
  });
  const resolvedCatalogEntry = (() => {
    if (skipResolve) return catalogEntryProp;
    const manifest = manifestQuery.data?.manifest;
    if (!manifest || !catalogQuery.data) return undefined;
    return catalogQuery.data.nets.find(
      (n) =>
        n.contract.id === manifest.contract.id &&
        n.contract.version === manifest.contract.version,
    );
  })();
  const catalogEntry = resolvedCatalogEntry;
  const contractRef = joined.contract ?? catalogEntry?.contract;
  const catalogResolving =
    !skipResolve && (manifestQuery.isLoading || catalogQuery.isLoading);
  // Orphaned: manifest fetch failed (typically 404 — manifest no longer in
  // the registry). The only useful action on these is to leave; editing is
  // pointless because the daemon has no metadata to validate against and
  // the SolverNet is no longer claiming on-chain anyway.
  const orphaned = !skipResolve && manifestQuery.isError && !manifestQuery.isLoading;

  // Re-sync form when the joined record changes from the outside (e.g., post
  // refetch after save). Skip when dirty so the operator's in-flight edits
  // aren't blown away by a poll.
  useEffect(() => {
    if (!isDirty(form, joined)) {
      setForm(snapshot(joined));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    joined.harness,
    joined.model,
    JSON.stringify(joined.plugins ?? []),
    JSON.stringify(joined.disabledDefaultPlugins ?? []),
  ]);

  // Auto-expand when default flips true (parent decided this card is the hash
  // target). Scroll/focus when focusOn='harness'.
  useEffect(() => {
    if (defaultExpanded) {
      setExpanded(true);
      if (focusOn === 'harness') {
        // Defer to next paint so the field is mounted.
        setTimeout(() => {
          harnessFieldRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          harnessSelectRef.current?.focus();
        }, 50);
      }
    }
  }, [defaultExpanded, focusOn]);

  const compatible = (catalogEntry?.compatibleHarnesses ?? [])
    .filter((h) => h.supportsRoles.includes('solving'))
    .map((h) => ({ ...h, name: canonicalHarnessName(h.name) }))
    .filter((h, index, all) => all.findIndex((candidate) => candidate.name === h.name) === index);
  const compatibleNames = new Set(compatible.map((h) => h.name));
  const harnessIncompatible =
    form.harness !== '' &&
    compatible.length > 0 &&
    ![...compatibleNames].some((name) => harnessNamesMatch(name, form.harness));
  const contractLabel = catalogEntry
    ? `${catalogEntry.contract.id}@${catalogEntry.contract.version}`
    : '';
  const modelOptions = modelOptionsForHarness(form.harness);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.operator.join(joined.manifestCid, {
        ...(joined.name !== undefined ? { name: joined.name } : {}),
        ...(contractRef !== undefined
          ? { contract: { id: contractRef.id, version: contractRef.version } }
          : {}),
        roles: joined.roles,
        ...(form.harness ? { harness: form.harness } : {}),
        plugins: form.plugins,
        disabledDefaultPlugins: form.disabledDefaultPlugins,
        ...(form.model ? { model: form.model } : {}),
      }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['operator', 'joined'] });
      if (res.restartRequired) onRestartPending?.();
    },
  });

  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const leaveMutation = useMutation({
    mutationFn: () => api.operator.leave(joined.manifestCid),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['operator', 'joined'] });
      if (res.restartRequired) onRestartPending?.();
      setConfirmingLeave(false);
    },
  });

  const dirty = isDirty(form, joined);
  const displayName = joined.name ?? joined.manifestCid;
  const cidShort = `${joined.manifestCid.slice(0, 8)}…${joined.manifestCid.slice(-4)}`;

  return (
    <article
      data-testid="joined-net-card"
      data-manifest-cid={joined.manifestCid}
      data-expanded={expanded ? 'true' : 'false'}
      style={{
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-2)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto',
          alignItems: 'flex-start',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
          <span
            data-testid="joined-net-card-name"
            style={{
              fontFamily: "'Instrument Serif', 'Times New Roman', serif",
              fontSize: '20px',
              color: 'var(--fg)',
              letterSpacing: '-0.01em',
              lineHeight: 1.2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {displayName}
          </span>
          <div
            style={{
              display: 'flex',
              gap: '8px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '11px',
              color: 'var(--fg-muted)',
              flexWrap: 'wrap',
            }}
          >
            {joined.roles.map((role) => (
              <RoleChip key={role} label={role} />
            ))}
            <span style={{ color: 'var(--fg-dim)' }}>cid {cidShort}</span>
          </div>
        </div>
        {orphaned ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-end' }}>
            {!confirmingLeave ? (
              <button
                type="button"
                data-testid="joined-net-card-leave"
                onClick={() => setConfirmingLeave(true)}
                style={destructiveButtonStyle(true)}
              >
                ✕ Leave
              </button>
            ) : (
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  type="button"
                  data-testid="joined-net-card-leave-cancel"
                  disabled={leaveMutation.isPending}
                  onClick={() => setConfirmingLeave(false)}
                  style={ghostButtonStyle(!leaveMutation.isPending)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="joined-net-card-leave-confirm"
                  disabled={leaveMutation.isPending}
                  onClick={() => leaveMutation.mutate()}
                  style={destructiveButtonStyle(!leaveMutation.isPending, true)}
                >
                  {leaveMutation.isPending ? 'Leaving…' : 'Confirm leave'}
                </button>
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            data-testid="joined-net-card-toggle"
            onClick={() => setExpanded((e) => !e)}
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-1)',
              padding: '6px 10px',
              cursor: 'pointer',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '11px',
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--fg)',
            }}
          >
            {expanded ? '▾ Close' : '▸ Edit'}
          </button>
        )}
      </div>

      {orphaned && (
        <div
          data-testid="joined-net-card-orphaned"
          style={{
            border: '1px solid var(--wane)',
            borderRadius: 'var(--radius-1)',
            padding: '10px 14px',
            background: 'transparent',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
            color: 'var(--fg-muted)',
            lineHeight: 1.5,
          }}
        >
          <span style={{ color: 'var(--wane)', textTransform: 'uppercase', letterSpacing: '0.14em', fontSize: '10px', marginRight: '8px' }}>
            Retired
          </span>
          Manifest no longer in the registry. This SolverNet is not claiming on-chain anymore — leaving it cleans up your config.
          {leaveMutation.isError && (
            <div role="alert" style={{ marginTop: '6px', color: 'var(--break-red)', fontSize: '11px' }}>
              {leaveMutation.error instanceof Error ? leaveMutation.error.message : 'Leave failed.'}
            </div>
          )}
        </div>
      )}

      {!expanded && !orphaned && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '90px 1fr',
            gap: '6px 12px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
            color: 'var(--fg-muted)',
          }}
        >
          <span>harness</span>
          <span style={{ color: 'var(--fg)' }}>
            {joined.harness ? harnessDisplayName(joined.harness) : <span style={{ color: 'var(--fg-dim)' }}>—</span>}
            {harnessIncompatible && (
              <span data-testid="joined-net-card-warn-collapsed" style={{ marginLeft: '10px', color: 'var(--break-red)' }}>
                ⚠ does not support {contractLabel}
              </span>
            )}
          </span>
          <span>plugins</span>
          <span style={{ color: 'var(--fg)' }}>
            {(joined.plugins ?? []).length === 0 ? (
              <span style={{ color: 'var(--fg-dim)' }}>—</span>
            ) : (
              `${joined.plugins!.length} active`
            )}
          </span>
          <span>model</span>
          <span style={{ color: 'var(--fg)' }}>
            {joined.model ? (
              resolveModelOption(joined.model, canonicalHarnessName(joined.harness)).label
            ) : (
              <span style={{ color: 'var(--fg-dim)' }}>—</span>
            )}
          </span>
        </div>
      )}

      {orphaned && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '90px 1fr',
            gap: '6px 12px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
            color: 'var(--fg-muted)',
          }}
        >
          <span>harness</span>
          <span style={{ color: 'var(--fg)' }}>
            {joined.harness ? harnessDisplayName(joined.harness) : <span style={{ color: 'var(--fg-dim)' }}>—</span>}
          </span>
          <span>plugins</span>
          <span style={{ color: 'var(--fg)' }}>
            {(joined.plugins ?? []).length === 0 ? (
              <span style={{ color: 'var(--fg-dim)' }}>—</span>
            ) : (
              `${joined.plugins!.length} active`
            )}
          </span>
          <span>model</span>
          <span style={{ color: 'var(--fg)' }}>
            {joined.model ? (
              resolveModelOption(joined.model, canonicalHarnessName(joined.harness)).label
            ) : (
              <span style={{ color: 'var(--fg-dim)' }}>—</span>
            )}
          </span>
        </div>
      )}

      {expanded && !orphaned && (
        <div
          data-testid="joined-net-card-form"
          style={{ display: 'flex', flexDirection: 'column', gap: '14px', borderTop: '1px solid var(--border)', paddingTop: '12px' }}
        >
          <div ref={harnessFieldRef} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={fieldLabelStyle}>Harness</span>
            <select
              ref={harnessSelectRef}
              aria-label="Harness implementation"
              data-testid="joined-net-card-harness-select"
              value={form.harness}
              onChange={(e) => {
                const harness = e.target.value;
                setForm((prev) => ({
                  ...prev,
                  harness,
                  model: defaultModelForHarness(harness),
                }));
              }}
              style={{
                ...selectStyle,
                borderColor: harnessIncompatible ? 'var(--break-red)' : 'var(--border)',
              }}
            >
              {form.harness === '' && <option value="">—</option>}
              {compatible.map((h) => (
                <option key={h.name} value={h.name}>
                  {harnessOptionLabel(h.name, h.version)}
                </option>
              ))}
              {/* When we have catalog data and the chosen harness isn't in
               * the compatible list, surface it explicitly. Without catalog
               * data (compatible.length === 0) we can't classify, so we
               * just render the current value as-is. */}
              {form.harness && compatible.length > 0 && !compatibleNames.has(form.harness) && (
                <option value={form.harness}>{harnessDisplayName(form.harness)} (incompatible)</option>
              )}
              {form.harness && compatible.length === 0 && (
                <option value={form.harness}>{harnessDisplayName(form.harness)}</option>
              )}
            </select>
            {harnessIncompatible && (
              <span
                data-testid="joined-net-card-warn-expanded"
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '11px',
                  color: 'var(--break-red)',
                  lineHeight: 1.5,
                }}
              >
                ⚠ This harness does not support <span style={{ color: 'var(--fg)' }}>{contractLabel}</span>.
                {compatible.length > 0 && (
                  <>
                    {' Compatible: '}
                    {compatible.map((h, i) => (
                      <span key={h.name} style={{ color: 'var(--accent-sky)' }}>
                        {harnessDisplayName(h.name)}{i < compatible.length - 1 ? ' · ' : ''}
                      </span>
                    ))}
                  </>
                )}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={fieldLabelStyle}>Plugins</span>
            {catalogResolving ? (
              <span
                data-testid="joined-net-card-catalog-loading"
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '12px',
                  color: 'var(--fg-dim)',
                }}
              >
                Loading registry catalog…
              </span>
            ) : !catalogEntry ? (
              <span
                data-testid="joined-net-card-catalog-missing"
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '12px',
                  color: 'var(--fg-dim)',
                  fontStyle: 'italic',
                }}
              >
                Registry catalog has no template for this SolverNet's contract — plugins can't be verified.
              </span>
            ) : (catalogEntry.compatiblePlugins ?? []).length === 0 ? (
              <PluginPicker
                available={[]}
                selected={form.plugins}
                disabledDefaultPlugins={form.disabledDefaultPlugins}
                onChange={(plugins, disabledDefaultPlugins) =>
                  setForm((prev) => ({ ...prev, plugins, disabledDefaultPlugins }))
                }
                rowTestId="joined-net-card-plugin-row"
                searchTestId="joined-net-card-plugin-search"
              />
            ) : (
              <PluginPicker
                available={catalogEntry?.compatiblePlugins ?? []}
                selected={form.plugins}
                disabledDefaultPlugins={form.disabledDefaultPlugins}
                onChange={(plugins, disabledDefaultPlugins) =>
                  setForm((prev) => ({ ...prev, plugins, disabledDefaultPlugins }))
                }
                rowTestId="joined-net-card-plugin-row"
                searchTestId="joined-net-card-plugin-search"
              />
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={fieldLabelStyle}>Model</span>
            <select
              aria-label="Model"
              data-testid="joined-net-card-model-select"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              style={selectStyle}
            >
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              {(() => {
                const resolved = resolveModelOption(form.model, form.harness);
                if (resolved.isCustom) {
                  return (
                    <option key={form.model} value={form.model}>
                      {resolved.label}
                    </option>
                  );
                }
                return null;
              })()}
            </select>
          </div>

          {saveMutation.isError && (
            <span
              role="alert"
              data-testid="joined-net-card-error"
              style={{ color: 'var(--break-red)', fontFamily: "'JetBrains Mono', monospace", fontSize: '12px' }}
            >
              {saveMutation.error instanceof Error ? saveMutation.error.message : 'Save failed.'}
            </span>
          )}

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              borderTop: '1px solid var(--border)',
              paddingTop: '10px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '11px',
              color: 'var(--fg-dim)',
            }}
          >
            <span>{dirty ? 'Restart required to apply.' : 'No unsaved changes.'}</span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                data-testid="joined-net-card-cancel"
                disabled={!dirty || saveMutation.isPending}
                onClick={() => setForm(snapshot(joined))}
                style={ghostButtonStyle(dirty && !saveMutation.isPending)}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="joined-net-card-save"
                disabled={!dirty || saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
                style={primaryButtonStyle(dirty && !saveMutation.isPending)}
              >
                {saveMutation.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>

          <div
            data-testid="joined-net-card-leave-zone"
            style={{
              marginTop: '4px',
              paddingTop: '12px',
              borderTop: '1px dashed var(--border)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '12px',
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '11px',
                color: 'var(--fg-dim)',
                lineHeight: 1.5,
              }}
            >
              Leaving stops claims for this SolverNet on the next daemon
              restart. You can re-join from the Discover catalog later.
            </span>
            {!confirmingLeave ? (
              <button
                type="button"
                data-testid="joined-net-card-leave"
                onClick={() => setConfirmingLeave(true)}
                style={destructiveButtonStyle(true)}
              >
                ✕ Leave SolverNet
              </button>
            ) : (
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  type="button"
                  data-testid="joined-net-card-leave-cancel"
                  disabled={leaveMutation.isPending}
                  onClick={() => setConfirmingLeave(false)}
                  style={ghostButtonStyle(!leaveMutation.isPending)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="joined-net-card-leave-confirm"
                  disabled={leaveMutation.isPending}
                  onClick={() => leaveMutation.mutate()}
                  style={destructiveButtonStyle(!leaveMutation.isPending, true)}
                >
                  {leaveMutation.isPending ? 'Leaving…' : 'Confirm leave'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function RoleChip({ label }: { label: string }): JSX.Element {
  return (
    <span
      data-testid="joined-net-card-role"
      style={{
        fontSize: '10px',
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--fg-muted)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-1)',
        padding: '1px 6px',
      }}
    >
      {label}
    </span>
  );
}

const fieldLabelStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '11px',
  fontWeight: 500,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-muted)',
};

const selectStyle: React.CSSProperties = {
  background: 'var(--bg-sunken)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-1)',
  padding: '8px 10px',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '13px',
  color: 'var(--fg)',
};

function ghostButtonStyle(active: boolean): React.CSSProperties {
  return {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: '12px',
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    padding: '7px 12px',
    background: 'transparent',
    color: active ? 'var(--fg)' : 'var(--fg-dim)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-1)',
    cursor: active ? 'pointer' : 'not-allowed',
  };
}

function primaryButtonStyle(active: boolean): React.CSSProperties {
  return {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: '12px',
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    padding: '7px 14px',
    background: active ? 'var(--accent-sky)' : 'transparent',
    color: active ? 'var(--bg-sunken)' : 'var(--fg-dim)',
    border: `1px solid ${active ? 'var(--accent-sky)' : 'var(--border)'}`,
    borderRadius: 'var(--radius-1)',
    cursor: active ? 'pointer' : 'not-allowed',
  };
}

function destructiveButtonStyle(active: boolean, filled = false): React.CSSProperties {
  const tone = active ? 'var(--break-red)' : 'var(--fg-dim)';
  return {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: '11px',
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    padding: '7px 12px',
    background: filled && active ? 'var(--break-red)' : 'transparent',
    color: filled && active ? 'var(--bg-sunken)' : tone,
    border: `1px solid ${tone}`,
    borderRadius: 'var(--radius-1)',
    cursor: active ? 'pointer' : 'not-allowed',
  };
}
