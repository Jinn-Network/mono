import { useEffect, useRef, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { api } from '../../api/client.js';
import type {
  RegistryManifestResponse,
  SolverNetCatalogEntry,
  SolverNetsCatalogResponse,
} from '../../../../../api/contract/index.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Label } from '../../components/ui/label.js';
import { Separator } from '../../components/ui/separator.js';
import { cn } from '../../lib/utils.js';
import {
  defaultModelForHarness,
  modelOptionsForHarness,
  providerForModel,
  resolveModelOption,
} from './claudeModels.js';
import {
  canonicalHarnessName,
  harnessDisplayName,
  harnessNamesMatch,
  harnessOptionLabel,
} from './harnessNames.js';
import { PluginPicker } from './PluginPicker.js';
import { decideCostSurface } from '../../../../../harnesses/cost-estimates.js';
import { CostEstimatePanel } from './CostEstimatePanel.js';
import { HarnessFootprintPanel } from './HarnessFootprintPanel.js';
import { useHarnessUsesPaidApiKey } from '../../hooks/useHarnessUsesPaidApiKey.js';
import type { ProviderRef } from '../../../../../harnesses/provider-ref.js';

/**
 * Per-SolverNet edit card on /operator → SolverNets → Joined.
 *
 * Edit surface for `joinedSolverNets[<manifestCid>] = { roles, harness,
 * plugins, model }`. Roles are immutable post-join (set by `JoinFlow` and
 * not editable here — operators leave + rejoin to change roles). Save
 * re-uses `api.operator.join(cid, body)` with full-overwrite semantics; the
 * daemon returns `{ restartRequired: true }` and the parent (`MembershipsTab`)
 * surfaces the restart banner.
 *
 * Compatibility warning: when the chosen harness isn't in
 * `catalogEntry.compatibleHarnesses` the picker surfaces the same
 * `prediction_harness_unsupported` mismatch diagnostic, with the list
 * of compatible alternatives.
 */

export interface JoinedNetEntry {
  manifestCid: string;
  name?: string;
  contract?: { id: string; version: string };
  roles: Array<'solver' | 'evaluator'>;
  harness?: string;
  model?: string;
  provider?: ProviderRef;
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

const MONO_SELECT_CLASSES =
  'flex h-9 w-full rounded-sm border border-border bg-sunken px-2.5 py-1 font-mono text-[13px] text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

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
    mutationFn: () => {
      const joinedHarness = canonicalHarnessName(joined.harness);
      const joinedModel = joined.model ?? defaultModelForHarness(joinedHarness);
      const routeUnchanged =
        form.harness === joinedHarness && form.model === joinedModel;
      const provider = routeUnchanged
        ? joined.provider
        : providerForModel(form.model, form.harness);

      return api.operator.join(joined.manifestCid, {
        ...(joined.name !== undefined ? { name: joined.name } : {}),
        ...(contractRef !== undefined
          ? { contract: { id: contractRef.id, version: contractRef.version } }
          : {}),
        roles: joined.roles,
        ...(form.harness ? { harness: form.harness } : {}),
        plugins: form.plugins,
        disabledDefaultPlugins: form.disabledDefaultPlugins,
        ...(form.model ? { model: form.model } : {}),
        ...(provider !== undefined ? { provider } : {}),
      });
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['operator', 'joined'] });
      if (res.restartRequired) onRestartPending?.();
    },
  });

  const [highCostAcknowledged, setHighCostAcknowledged] = useState(false);
  const isSolver = joined.roles.includes('solver');
  const usesPaidApiKey = useHarnessUsesPaidApiKey(isSolver ? form.harness : undefined);
  const costDecision = decideCostSurface(
    usesPaidApiKey,
    isSolver ? form.model : undefined,
  );
  const requiresCostConfirmation = isSolver && costDecision.requiresConfirmation;
  const costGateBlocked = requiresCostConfirmation && !highCostAcknowledged;

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
      className="flex flex-col gap-2.5 rounded-md border border-border bg-background px-4 py-3.5"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span
            data-testid="joined-net-card-name"
            className="truncate font-serif text-[20px] leading-tight text-foreground tracking-[-0.01em]"
          >
            {displayName}
          </span>
          <div className="flex flex-wrap gap-2 font-mono text-[11px] text-muted-foreground">
            {joined.roles.map((role) => (
              <RoleChip key={role} label={role} />
            ))}
            <span className="text-dim">cid {cidShort}</span>
          </div>
        </div>
        {orphaned ? (
          <div className="flex flex-col items-end gap-1.5">
            {!confirmingLeave ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                data-testid="joined-net-card-leave"
                onClick={() => setConfirmingLeave(true)}
              >
                <X aria-hidden="true" className="!size-3" />
                Leave
              </Button>
            ) : (
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  data-testid="joined-net-card-leave-cancel"
                  disabled={leaveMutation.isPending}
                  onClick={() => setConfirmingLeave(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  data-testid="joined-net-card-leave-confirm"
                  disabled={leaveMutation.isPending}
                  onClick={() => leaveMutation.mutate()}
                >
                  {leaveMutation.isPending ? 'Leaving…' : 'Confirm leave'}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="joined-net-card-toggle"
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? (
              <>
                <ChevronDown aria-hidden="true" className="!size-3.5" />
                Close
              </>
            ) : (
              <>
                <ChevronRight aria-hidden="true" className="!size-3.5" />
                Edit
              </>
            )}
          </Button>
        )}
      </div>

      {orphaned && (
        <div
          data-testid="joined-net-card-orphaned"
          className="rounded-sm border border-wane bg-transparent px-3.5 py-2.5 font-mono text-[12px] leading-relaxed text-muted-foreground"
        >
          <Badge variant="pill" className="mr-2 align-baseline">
            Retired
          </Badge>
          Manifest no longer in the registry. This SolverNet is not claiming on-chain anymore — leaving it removes the entry from your config. Restart the daemon afterwards so it stops looking for this manifest at startup.
          {leaveMutation.isError && (
            <div role="alert" className="mt-1.5 text-[11px] text-destructive">
              {leaveMutation.error instanceof Error ? leaveMutation.error.message : 'Leave failed.'}
            </div>
          )}
        </div>
      )}

      {!expanded && !orphaned && (
        <SummaryGrid
          harness={joined.harness}
          plugins={joined.plugins}
          model={joined.model}
          harnessWarning={harnessIncompatible ? `does not support ${contractLabel}` : null}
          warningTestId="joined-net-card-warn-collapsed"
        />
      )}

      {orphaned && (
        <SummaryGrid
          harness={joined.harness}
          plugins={joined.plugins}
          model={joined.model}
          harnessWarning={null}
        />
      )}

      {expanded && !orphaned && (
        <div
          data-testid="joined-net-card-form"
          className="flex flex-col gap-3.5 border-t border-border pt-3"
        >
          <div ref={harnessFieldRef} className="flex flex-col gap-1.5">
            <Label htmlFor="joined-net-card-harness-select">Harness</Label>
            <select
              ref={harnessSelectRef}
              id="joined-net-card-harness-select"
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
                setHighCostAcknowledged(false);
              }}
              className={cn(
                MONO_SELECT_CLASSES,
                harnessIncompatible && 'border-destructive',
              )}
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
                className="font-mono text-[11px] leading-relaxed text-destructive"
              >
                ⚠ This harness does not support <span className="text-foreground">{contractLabel}</span>.
                {compatible.length > 0 && (
                  <>
                    {' Compatible: '}
                    {compatible.map((h, i) => (
                      <span key={h.name} className="text-primary">
                        {harnessDisplayName(h.name)}
                        {i < compatible.length - 1 ? ' · ' : ''}
                      </span>
                    ))}
                  </>
                )}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Plugins</Label>
            {catalogResolving ? (
              <span
                data-testid="joined-net-card-catalog-loading"
                className="font-mono text-[12px] text-dim"
              >
                Loading registry catalog…
              </span>
            ) : !catalogEntry ? (
              <span
                data-testid="joined-net-card-catalog-missing"
                className="font-mono text-[12px] italic text-dim"
              >
                Registry catalog has no template for this SolverNet&apos;s contract — plugins can&apos;t be verified.
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
                harness={form.harness}
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
                harness={form.harness}
              />
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="joined-net-card-model-select">Model</Label>
            <select
              id="joined-net-card-model-select"
              aria-label="Model"
              data-testid="joined-net-card-model-select"
              value={form.model}
              onChange={(e) => {
                setForm({ ...form, model: e.target.value });
                setHighCostAcknowledged(false);
              }}
              className={MONO_SELECT_CLASSES}
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

          {isSolver && (
            <CostEstimatePanel
              modelId={form.model}
              usesPaidApiKey={usesPaidApiKey}
              variant="inline"
              testIdPrefix="joined-net-card-cost"
            />
          )}

          {/* Issue #815 — AI-units footprint shown alongside the
              per-task USD surface when the operator changes
              harness/model from Settings. */}
          {isSolver && (
            <HarnessFootprintPanel
              harness={form.harness}
              modelId={form.model}
              variant="inline"
              testIdPrefix="joined-net-card-footprint"
            />
          )}

          {requiresCostConfirmation && (
            <label
              data-testid="joined-net-card-cost-confirmation"
              data-cost-confirmation-checked={highCostAcknowledged ? 'true' : 'false'}
              className="flex cursor-pointer items-start gap-2 rounded-md border border-destructive bg-background px-3 py-2.5 font-mono text-[12px] text-foreground"
            >
              <input
                type="checkbox"
                data-testid="joined-net-card-cost-confirmation-checkbox"
                checked={highCostAcknowledged}
                onChange={(e) => setHighCostAcknowledged(e.target.checked)}
                className="mt-0.5 size-3.5 accent-destructive"
                aria-label="I understand the per-task cost and have a budget for this"
              />
              <span>
                I understand — I have a budget for this. The selected model is estimated above $1/task on
                my own provider key.
              </span>
            </label>
          )}

          {saveMutation.isError && (
            <span
              role="alert"
              data-testid="joined-net-card-error"
              className="font-mono text-[12px] text-destructive"
            >
              {saveMutation.error instanceof Error ? saveMutation.error.message : 'Save failed.'}
            </span>
          )}

          <Separator />

          <div className="flex items-center justify-between font-mono text-[11px] text-dim">
            <span>{dirty ? 'Restart required to apply.' : 'No unsaved changes.'}</span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="joined-net-card-cancel"
                disabled={!dirty || saveMutation.isPending}
                onClick={() => setForm(snapshot(joined))}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid="joined-net-card-save"
                disabled={!dirty || saveMutation.isPending || costGateBlocked}
                onClick={() => saveMutation.mutate()}
              >
                {saveMutation.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>

          <div
            data-testid="joined-net-card-leave-zone"
            className="mt-1 flex flex-wrap items-start justify-between gap-3 border-t border-dashed border-border pt-3"
          >
            <span
              data-testid="joined-net-card-leave-explainer"
              className="max-w-[440px] font-mono text-[11px] leading-relaxed text-dim"
            >
              Leave removes this SolverNet from your config right away. The
              running daemon keeps its loaded copy in memory, so it will go on
              claiming and finishing tasks for this SolverNet until you restart
              it — restart to actually stop new claims. Tasks already in flight
              run to completion either way. You can re-join from the Discover
              catalog later.
            </span>
            {!confirmingLeave ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                data-testid="joined-net-card-leave"
                onClick={() => setConfirmingLeave(true)}
              >
                <X aria-hidden="true" className="!size-3" />
                Leave SolverNet
              </Button>
            ) : (
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  data-testid="joined-net-card-leave-cancel"
                  disabled={leaveMutation.isPending}
                  onClick={() => setConfirmingLeave(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  data-testid="joined-net-card-leave-confirm"
                  disabled={leaveMutation.isPending}
                  onClick={() => leaveMutation.mutate()}
                >
                  {leaveMutation.isPending ? 'Leaving…' : 'Confirm leave'}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

interface SummaryGridProps {
  harness: string | undefined;
  plugins: string[] | undefined;
  model: string | undefined;
  harnessWarning: string | null;
  warningTestId?: string;
}

function SummaryGrid({
  harness,
  plugins,
  model,
  harnessWarning,
  warningTestId,
}: SummaryGridProps): JSX.Element {
  return (
    <div className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-1.5 font-mono text-[12px] text-muted-foreground">
      <span>harness</span>
      <span className="text-foreground">
        {harness ? harnessDisplayName(harness) : <span className="text-dim">—</span>}
        {harnessWarning && warningTestId && (
          <span data-testid={warningTestId} className="ml-2.5 text-destructive">
            ⚠ {harnessWarning}
          </span>
        )}
      </span>
      <span>plugins</span>
      <span className="text-foreground">
        {(plugins ?? []).length === 0 ? (
          <span className="text-dim">—</span>
        ) : (
          `${plugins!.length} active`
        )}
      </span>
      <span>model</span>
      <span className="text-foreground">
        {model ? (
          resolveModelOption(model, canonicalHarnessName(harness)).label
        ) : (
          <span className="text-dim">—</span>
        )}
      </span>
    </div>
  );
}

function RoleChip({ label }: { label: string }): JSX.Element {
  return (
    <Badge variant="outline" data-testid="joined-net-card-role" className="px-1.5 py-px text-[10px]">
      {label}
    </Badge>
  );
}
