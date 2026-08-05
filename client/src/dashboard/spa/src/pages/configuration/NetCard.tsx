import { useState, type JSX } from 'react';
import type {
  SolverNetCatalogEntry,
  SolverNetManifestV1,
} from '../../../../../api/contract/index.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Label } from '../../components/ui/label.js';
import { Separator } from '../../components/ui/separator.js';
import { cn } from '../../lib/utils.js';
import { api } from '../../api/client.js';
import { SolverNetSigil } from './solverNetSigils.js';
import {
  defaultModelForHarness,
  modelOptionsForHarness,
  resolveModelOption,
} from './claudeModels.js';
import { canonicalHarnessName, harnessDisplayName, harnessOptionLabel } from './harnessNames.js';
import { formatWeiAmount } from '../launcher-launched/helpers.js';

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
    return <ManifestJoinedCard {...props} />;
  }
  return <LegacyNetCard {...props} />;
}

// ── Reusable mono select that matches shadcn Input styling ────────────────

interface MonoSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  dirty?: boolean;
  invalid?: boolean;
}

function MonoSelect({ className, dirty, invalid, ...props }: MonoSelectProps): JSX.Element {
  return (
    <select
      {...props}
      className={cn(
        'flex h-9 w-full rounded-md border bg-background px-3 py-1 font-mono text-[13px] text-foreground transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        invalid ? 'border-destructive' : dirty ? 'border-primary' : 'border-input',
        className,
      )}
    />
  );
}

// ── Reusable field label + optional Restart badge ─────────────────────────

interface FieldLabelProps {
  children: React.ReactNode;
  htmlFor?: string;
  restartRequired?: boolean;
}

function FieldLabel({ children, htmlFor, restartRequired }: FieldLabelProps): JSX.Element {
  return (
    <Label htmlFor={htmlFor} className="flex items-center gap-1.5">
      {children}
      {restartRequired && <Badge variant="pill">restart</Badge>}
    </Label>
  );
}

// ── Legacy mode ───────────────────────────────────────────────────────────

function LegacyNetCard({ catalog, config, onSaved, onRestartPending }: NetCardLegacyProps): JSX.Element {
  const [draft, setDraft] = useState<NetCardConfig>({
    ...config,
    harness: canonicalHarnessName(config.harness),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const dirty =
    draft.enabled !== config.enabled ||
    !rolesEqual(draft.roles, config.roles) ||
    draft.harness !== canonicalHarnessName(config.harness) ||
    draft.model !== config.model ||
    draft.plugins.join(',') !== config.plugins.join(',');

  const rolesValid = draft.roles.length > 0;

  const stateBadge: { label: string; variant: 'secondary' | 'outline' | 'success' } = (() => {
    if (catalog.state === 'coming_soon') return { label: 'Coming soon', variant: 'secondary' };
    if (config.enabled) return { label: 'Live', variant: 'success' };
    return { label: 'Available', variant: 'outline' };
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
    setDraft({
      ...config,
      harness: canonicalHarnessName(config.harness),
    });
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

  const harnessDirty = draft.harness !== canonicalHarnessName(config.harness);
  const modelDirty = draft.model !== config.model;

  return (
    <div className="overflow-hidden rounded-md border border-border bg-background">
      <div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-4 px-4 py-3.5">
        <SolverNetSigil name={catalog.name} />
        <span>
          <span className="text-[15px] font-medium text-foreground">{catalog.name}</span>
          <span className="mt-0.5 block text-[12px] text-muted-foreground">
            {catalog.description}
          </span>
        </span>
        <Badge variant={stateBadge.variant} className="rounded-full px-2.5 py-0.5">
          {stateBadge.label}
        </Badge>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={toggle}
          disabled={catalog.state === 'coming_soon'}
          aria-label={draft.enabled ? `Disable ${catalog.name}` : `Enable ${catalog.name}`}
          className={cn(
            'relative h-[18px] w-9 rounded-full border bg-elevated p-0 hover:bg-elevated',
            draft.enabled ? 'border-primary' : 'border-border',
            catalog.state === 'coming_soon' && 'cursor-not-allowed opacity-50',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'absolute top-[2px] block h-3 w-3 rounded-full transition-all',
              draft.enabled ? 'right-[3px] bg-primary' : 'left-[3px] bg-muted-foreground',
            )}
          />
        </Button>
      </div>

      {draft.enabled && (
        <div className="grid grid-cols-2 gap-4 border-t border-border bg-sunken px-5 py-4">
          <div className="col-span-2 flex flex-col gap-1.5">
            <Label>Roles</Label>
            <div
              className={cn(
                'grid overflow-hidden rounded-md border border-border',
                catalog.supportedRoles.length === 1
                  ? 'grid-cols-1'
                  : catalog.supportedRoles.length === 2
                    ? 'grid-cols-2'
                    : 'grid-cols-3',
              )}
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
                    className={cn(
                      'flex cursor-pointer flex-col items-start gap-1.5 px-3.5 py-2.5 font-mono',
                      active ? 'bg-background text-foreground' : 'bg-transparent text-muted-foreground',
                      idx < catalog.supportedRoles.length - 1 && 'border-r border-border',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        id={checkboxId}
                        type="checkbox"
                        checked={active}
                        onChange={() => toggleRole(role)}
                        aria-label={role === 'solving' ? 'Solver' : 'Evaluator'}
                        className="size-3.5 accent-primary"
                      />
                      <span className="text-[14px] font-medium">
                        {role === 'solving' ? 'Solver' : 'Evaluator'}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'pl-[22px] text-[11px]',
                        active ? 'text-muted-foreground' : 'text-dim',
                      )}
                    >
                      {role === 'solving' ? 'attempt forecasts' : "verify others' forecasts"}
                    </span>
                  </label>
                );
              })}
            </div>
            {!rolesValid && (
              <span role="alert" className="font-mono text-[12px] text-destructive">
                At least one role required
              </span>
            )}
          </div>

          <FieldHarness
            catalog={catalog}
            draft={draft}
            setDraft={setDraft}
            dirty={harnessDirty}
            config={config}
          />

          <FieldModel
            draft={draft}
            setDraft={setDraft}
            dirty={modelDirty}
          />

          <div className="col-span-2 flex flex-col gap-2">
            <Label>Plugins</Label>
            {draft.plugins.map((p) => {
              const meta = catalog.compatiblePlugins.find((cp) => cp.name === p);
              return (
                <div
                  key={p}
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3.5 py-2.5 font-mono"
                >
                  <span className="text-[14px]">{p}</span>
                  <span className="flex items-center gap-3">
                    <span className="text-[12px] text-dim">
                      {meta ? `${meta.source} · ${meta.version}` : '—'}
                    </span>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setDraft({ ...draft, plugins: draft.plugins.filter((x) => x !== p) })}
                      aria-label={`Remove ${p}`}
                    >
                      Remove
                    </Button>
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
                  <span className="px-0.5 py-1 font-mono text-[12px] text-dim">
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
                  className="flex h-9 w-full rounded-md border border-dashed border-border bg-background px-3 py-1 font-mono text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
        <div className="flex items-center justify-between border-t border-border bg-elevated px-5 py-3.5 font-mono text-[13px] text-foreground">
          <span>Discard pending changes and disable {catalog.name}?</span>
          <span className="flex gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setConfirmDisable(false)}>
              Keep
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => {
                setDraft({ ...config, enabled: false });
                setConfirmDisable(false);
              }}
            >
              Discard + disable
            </Button>
          </span>
        </div>
      )}

      {dirty && !confirmDisable && (
        <div className="flex items-center justify-between border-t border-border px-5 py-3.5 font-mono">
          <span
            className={cn(
              'text-[12px]',
              error || !rolesValid ? 'text-destructive' : 'text-primary',
            )}
          >
            {error ?? (!rolesValid ? 'At least one role required' : saving ? 'Saving…' : 'Changes pending')}
          </span>
          <span className="flex gap-2">
            <Button type="button" variant="secondary" size="lg" onClick={cancel} disabled={saving}>
              Cancel
            </Button>
            <Button
              type="button"
              size="lg"
              onClick={() => {
                void save();
              }}
              disabled={saving || !rolesValid}
            >
              Save changes
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}

// ── Field components for the legacy editor ────────────────────────────────

interface FieldHarnessProps {
  catalog: SolverNetCatalogEntry;
  draft: NetCardConfig;
  setDraft: React.Dispatch<React.SetStateAction<NetCardConfig>>;
  dirty: boolean;
  config: NetCardConfig;
}

function FieldHarness({ catalog, draft, setDraft, dirty }: FieldHarnessProps): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel restartRequired>Harness</FieldLabel>
      <MonoSelect
        dirty={dirty}
        value={draft.harness}
        onChange={(e) => {
          const harness = e.target.value;
          setDraft({
            ...draft,
            harness,
            model: defaultModelForHarness(harness),
          });
        }}
      >
        {catalog.compatibleHarnesses
          .filter((h) =>
            draft.roles.length === 0
              ? true
              : draft.roles.some((r) => h.supportsRoles.includes(r)),
          )
          .map((h) => ({ ...h, name: canonicalHarnessName(h.name) }))
          .filter((h, index, all) => all.findIndex((candidate) => candidate.name === h.name) === index)
          .map((h) => (
            <option key={h.name} value={h.name}>
              {harnessOptionLabel(h.name, h.version)}
            </option>
          ))}
      </MonoSelect>
    </div>
  );
}

interface FieldModelProps {
  draft: NetCardConfig;
  setDraft: React.Dispatch<React.SetStateAction<NetCardConfig>>;
  dirty: boolean;
}

function FieldModel({ draft, setDraft, dirty }: FieldModelProps): JSX.Element {
  const modelOptions = modelOptionsForHarness(draft.harness);
  const resolved = resolveModelOption(draft.model, draft.harness);
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel restartRequired>Model</FieldLabel>
      <MonoSelect
        dirty={dirty}
        aria-label="Model"
        value={draft.model}
        onChange={(e) => setDraft({ ...draft, model: e.target.value })}
      >
        {modelOptions.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
        {resolved.isCustom && (
          <option key={draft.model} value={draft.model}>
            {resolved.label}
          </option>
        )}
      </MonoSelect>
    </div>
  );
}

// ── Manifest-keyed (joined) variant ───────────────────────────────────────

function ManifestJoinedCard({
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
      className="overflow-hidden rounded-md border border-border bg-background"
    >
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 px-4 py-3.5">
        <SolverNetSigil name={manifest.contract.id} />
        <span>
          <span className="text-[15px] font-medium text-foreground">{manifest.name}</span>
          <span className="mt-0.5 block font-mono text-[12px] text-muted-foreground">
            {manifest.contract.id}@{manifest.contract.version} · launched by{' '}
            agentId {manifest.launcher.agentId}
          </span>
        </span>
        <Badge
          variant="success"
          data-testid="netcard-joined-state"
          className="rounded-full px-2.5 py-0.5"
        >
          Joined
        </Badge>
      </div>

      <Separator />

      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 bg-sunken px-5 py-3.5 font-mono text-[12px] text-muted-foreground">
        <span>Roles</span>
        <span data-testid="netcard-joined-roles" className="text-foreground">
          {joined.roles.length === 0 ? '—' : joined.roles.join(', ')}
        </span>
        <span>Solution price</span>
        <span className="text-foreground">{formatWeiAmount(manifest.solutionPriceWei)}</span>
        <span>Verdict price</span>
        <span className="text-foreground">{formatWeiAmount(manifest.verdictPriceWei)}</span>
        {joined.roles.includes('solver') && joined.harness && (
          <>
            <span>Harness</span>
            <span data-testid="netcard-joined-harness" className="text-foreground">
              {harnessDisplayName(joined.harness)}
            </span>
          </>
        )}
        {joined.roles.includes('solver') && joined.model && (
          <>
            <span>Model</span>
            <span className="text-foreground">{joined.model}</span>
          </>
        )}
        {joined.roles.includes('solver') && (joined.plugins?.length ?? 0) > 0 && (
          <>
            <span>Plugins</span>
            <span className="text-foreground">{joined.plugins!.join(', ')}</span>
          </>
        )}
        {joined.roles.includes('evaluator') && (
          <>
            <span>Evaluator harness</span>
            <span data-testid="netcard-joined-evaluator-binding" className="text-dim">
              {manifest.contract.evaluationFunction.implementation} (manifest-bound)
            </span>
          </>
        )}
        <span>Manifest CID</span>
        <span
          data-testid="netcard-joined-manifest-cid"
          className="truncate text-dim"
        >
          {manifestCid}
        </span>
      </div>

      {error && (
        <div
          role="alert"
          className="border-t border-border px-5 py-2.5 font-mono text-[12px] text-destructive"
        >
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3 font-mono">
        {confirm ? (
          <>
            <span className="mr-auto text-[12px] text-foreground">
              Leave {manifest.name}? Restart required.
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setConfirm(false)}
              disabled={leaving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-testid="netcard-joined-leave-confirm"
              onClick={() => {
                void leave();
              }}
              disabled={leaving}
            >
              {leaving ? 'Leaving…' : 'Leave'}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="secondary"
            data-testid="netcard-joined-leave"
            onClick={() => setConfirm(true)}
          >
            Leave
          </Button>
        )}
      </div>
    </div>
  );
}
