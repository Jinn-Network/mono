import { useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../../api/client.js';
import type { ClaimPolicyConfig, ExecutionWiringConfigEntry } from '../../../../../api/contract/index.js';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '../../components/ui/card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../components/ui/tooltip.js';

export interface ClaimPolicyTabProps {
  onRestartPending?: () => void;
}

/**
 * /operator/claim-policy — §2.15 Claim policy & wiring.
 *
 * Replaces `joinedSolverNets` as the claim authority at cutover stage 1
 * (spec §9). Per coordinator amendment 1, `spendCapWei` / `aiUnitCap` are
 * OPTIONAL — an *absent* cap is a normal, safe posture (the host's USD
 * rolling-window gates remain the operative bound), so absence never
 * renders as a blocking notice here. An *explicit* zero, by contrast, is a
 * real ceiling the daemon's `buildOperatorCaps` honors literally (a
 * spend cap of 0 wei really does stop every claim) — that state is worth
 * flagging, and is what the "caps at zero" alert below covers.
 *
 * Mode editing is intentionally not exposed yet: no shadcn `Select`
 * primitive is installed in this SPA (no `@radix-ui/react-select`
 * dependency), and installing one is outside this pass's scope. Only the
 * caps are editable through this page for now; the predicate mode renders
 * read-only.
 */
export function ClaimPolicyTab({
  onRestartPending = () => undefined,
}: ClaimPolicyTabProps = {}): JSX.Element {
  const query = useQuery({
    queryKey: ['operator', 'claim-policy'],
    queryFn: () => api.operator.getClaimPolicy(),
    refetchInterval: 30_000,
  });

  if (query.isLoading || !query.data) {
    return (
      <div data-testid="claim-policy-tab-loading" className="flex flex-col gap-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const claimPolicy = query.data.claimPolicy;
  const executionWiring = query.data.executionWiring;

  return (
    <div data-testid="claim-policy-tab" className="flex flex-col gap-4">
      <ClaimPolicyCard
        // Remount (and re-seed the draft) whenever the fetched policy
        // changes — same idiom as NetworkTab's Primary-RPC card, so an
        // in-progress edit within a stable value is never disturbed.
        key={
          claimPolicy
            ? `${claimPolicy.mode}:${claimPolicy.spendCapWei ?? ''}:${claimPolicy.aiUnitCap ?? ''}`
            : 'unset'
        }
        claimPolicy={claimPolicy}
        onRestartPending={onRestartPending}
      />
      <ExecutionWiringCard entries={executionWiring} />
    </div>
  );
}

interface ClaimPolicyCardProps {
  claimPolicy: ClaimPolicyConfig | undefined;
  onRestartPending: () => void;
}

function ClaimPolicyCard({ claimPolicy, onRestartPending }: ClaimPolicyCardProps): JSX.Element {
  const [mode] = useState(claimPolicy?.mode ?? 'claim-nothing');
  const [spendCapWei, setSpendCapWei] = useState(claimPolicy?.spendCapWei ?? '');
  const [aiUnitCap, setAiUnitCap] = useState(String(claimPolicy?.aiUnitCap ?? 0));
  const [saving, setSaving] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);

  // Explicit zero is a real, self-inflicted block — distinct from an absent
  // cap, which is informational (coordinator amendment 1; see the module
  // doc comment above).
  const capsAtZero = claimPolicy !== undefined && (spendCapWei === '0' || aiUnitCap === '0');

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.operator.setClaimPolicy({
        claimPolicy: { mode, spendCapWei, aiUnitCap: Number(aiUnitCap) },
      });
      setRestartRequired(true);
      onRestartPending();
      toast.success('Claim policy saved', {
        description: 'Restart pending — applies on next daemon start.',
      });
    } catch (err) {
      toast.error('Failed to save claim policy', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Claim policy</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label>Predicate mode</Label>
          <Badge data-testid="claim-policy-mode" variant="outline" className="w-fit">
            {claimPolicy ? mode : 'not set'}
          </Badge>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="claim-policy-spend-cap">Spend cap (wei)</Label>
          <Input
            id="claim-policy-spend-cap"
            data-testid="claim-policy-spend-cap"
            type="text"
            inputMode="numeric"
            value={spendCapWei}
            onChange={(e) => setSpendCapWei(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="claim-policy-ai-unit-cap">AI-unit cap</Label>
          <Input
            id="claim-policy-ai-unit-cap"
            data-testid="claim-policy-ai-unit-cap"
            type="text"
            inputMode="numeric"
            value={aiUnitCap}
            onChange={(e) => setAiUnitCap(e.target.value)}
          />
        </div>
        {capsAtZero && (
          <Alert variant="warning" data-testid="claim-policy-caps-unset">
            <AlertTitle>Caps at zero</AlertTitle>
            <AlertDescription>
              No tasks will be claimed until both caps are above zero.
            </AlertDescription>
          </Alert>
        )}
        <div className="flex items-center gap-2">
          <Button
            data-testid="claim-policy-save"
            type="button"
            disabled={saving}
            onClick={() => {
              void save();
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
          {restartRequired && (
            <Badge data-testid="claim-policy-restart-required" variant="warning">
              Restart pending
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ExecutionWiringCard({
  entries,
}: {
  entries: ExecutionWiringConfigEntry[];
}): JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Execution wiring</CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p
            data-testid="claim-policy-empty"
            className="m-0 font-mono text-[12px] text-muted-foreground"
          >
            Join a SolverNet to create your first execution wiring entry.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Work kind</TableHead>
                <TableHead>Harness</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Plugins</TableHead>
                <TableHead>Isolation</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.workKind} data-testid="execution-wiring-row">
                  <TableCell>{entry.workKind}</TableCell>
                  <TableCell>{entry.harness}</TableCell>
                  <TableCell>{entry.model}</TableCell>
                  <TableCell>{entry.plugins.join(', ')}</TableCell>
                  <TableCell>{entry.isolationPolicy}</TableCell>
                  <TableCell>
                    {entry.legacyManifestDigest !== undefined && (
                      <TooltipProvider delayDuration={150}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="outline" tabIndex={0} className="cursor-help">
                              legacy
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent>
                            Migrated from a legacy SolverNet manifest; matches by legacy
                            digest until this entry is rewired.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
