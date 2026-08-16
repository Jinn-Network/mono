import { useMemo, useRef, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../api/client.js';
import type { OperatorArtifactsResponse, OperatorPricingConfig } from '../../../../../api/contract/index.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { Switch } from '../../components/ui/switch.js';
import { Separator } from '../../components/ui/separator.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog.js';

interface OperatorDataMarketProps {
  /** Reserved for backwards compatibility; the post-shadcn card has no
   *  expand/collapse — it's always open. */
  defaultExpanded?: boolean;
  onRestartPending?: () => void;
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function samePricing(a: OperatorPricingConfig, b: OperatorPricingConfig): boolean {
  return (
    a.publicEndpoint === b.publicEndpoint &&
    a.defaultPriceUsdc === b.defaultPriceUsdc &&
    JSON.stringify(sortedRecord(a.perArtifactTypePrice)) ===
      JSON.stringify(sortedRecord(b.perArtifactTypePrice)) &&
    a.donation.enabled === b.donation.enabled
  );
}

function DecisionFact({
  label,
  value,
  meta,
}: {
  label: string;
  value: string;
  meta: string;
}): JSX.Element {
  return (
    <div
      data-testid="operator-donation-fact"
      className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border px-3.5 py-3"
    >
      <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-dim)]">
        {label}
      </span>
      <strong className="font-mono text-[18px] font-medium text-foreground">{value}</strong>
      <span className="truncate font-mono text-[12px] text-[var(--fg-dim)]">{meta}</span>
    </div>
  );
}

function DonationStatusPanel({
  pricing,
  eligibleRuns,
  peerDatasetsUsed,
  saving,
  onSave,
  registerRevert,
}: {
  pricing: OperatorPricingConfig;
  eligibleRuns: number;
  peerDatasetsUsed: number;
  saving: boolean;
  onSave: (pricing: OperatorPricingConfig) => void;
  registerRevert: (revert: (() => void) | null) => void;
}): JSX.Element {
  const [donationEnabled, setDonationEnabled] = useState(pricing.donation.enabled);
  const [confirmationOpen, setConfirmationOpen] = useState(false);

  const draft = useMemo<OperatorPricingConfig>(
    () => ({
      publicEndpoint: pricing.publicEndpoint,
      defaultPriceUsdc: pricing.defaultPriceUsdc,
      perArtifactTypePrice: pricing.perArtifactTypePrice,
      donation: { enabled: donationEnabled },
    }),
    [pricing.defaultPriceUsdc, pricing.perArtifactTypePrice, pricing.publicEndpoint, donationEnabled],
  );

  const dirty = !samePricing(pricing, draft);

  const requestDonationChange = (enabled: boolean): void => {
    if (enabled && !donationEnabled && !pricing.donation.enabled) {
      setConfirmationOpen(true);
      return;
    }
    setDonationEnabled(enabled);
  };

  const confirmDonationEnable = (): void => {
    const confirmed: OperatorPricingConfig = { ...draft, donation: { enabled: true } };
    setDonationEnabled(true);
    setConfirmationOpen(false);
    registerRevert(() => setDonationEnabled(false));
    onSave(confirmed);
  };

  return (
    <div data-testid="operator-donation-status" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-[260px] flex-[1_1_360px] flex-col gap-2">
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-dim)]">
            Donate execution data
          </span>
          <strong
            data-testid="operator-donation-mode"
            className={
              donationEnabled
                ? 'font-mono text-[18px] font-medium text-[var(--vow-green)]'
                : 'font-mono text-[18px] font-medium text-foreground'
            }
          >
            {donationEnabled ? 'Donation is on' : 'Donation is off'}
          </strong>
          <p className="m-0 max-w-[64ch] font-mono text-[12px] leading-relaxed text-[var(--fg-dim)]">
            Share scrubbed and anonymized solver/evaluator data from future runs with other
            operators. This lets the network learn from real executions and improve itself.
            Public testnet donations are free and published to IPFS.
          </p>
        </div>

        <label
          data-testid="operator-donation-toggle"
          className="inline-flex cursor-pointer items-center gap-3 rounded-full border border-border bg-[var(--bg-sunken)] px-3 py-2"
        >
          <span
            className={
              donationEnabled
                ? 'font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--vow-green)]'
                : 'font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground'
            }
          >
            {donationEnabled ? 'On' : 'Off'}
          </span>
          <Switch
            aria-label="Donate produced data"
            checked={donationEnabled}
            onCheckedChange={requestDonationChange}
          />
        </label>
      </div>

      <div
        data-testid="operator-donation-facts"
        className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]"
      >
        <DecisionFact label="Eligible runs" value={String(eligibleRuns)} meta="local history" />
        <DecisionFact
          label="Peer datasets used"
          value={String(peerDatasetsUsed)}
          meta="from other operators"
        />
      </div>

      <Alert variant="info" data-testid="operator-donation-caveat">
        <AlertDescription>
          Turning donation off stops future publishing. Data already published to IPFS may remain
          available.
        </AlertDescription>
      </Alert>

      <Separator />

      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex items-center gap-3">
          <span
            data-testid="operator-donation-settings-state"
            className={
              dirty
                ? 'font-mono text-[12px] text-primary'
                : 'font-mono text-[12px] text-[var(--fg-dim)]'
            }
          >
            {dirty ? 'Donation changed' : 'Current'}
          </span>
          <Button
            variant="default"
            size="sm"
            type="button"
            disabled={!dirty || saving}
            onClick={() => {
              const priorEnabled = pricing.donation.enabled;
              if (donationEnabled !== priorEnabled) {
                registerRevert(() => setDonationEnabled(priorEnabled));
              }
              onSave(draft);
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmationOpen} onOpenChange={setConfirmationOpen}>
        <AlertDialogContent data-testid="operator-donation-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Share future execution data</AlertDialogTitle>
            <AlertDialogDescription>
              Future solver/evaluator runs will be scrubbed, anonymized, and published to IPFS so
              other operators can use them. This helps the network learn from real executions and
              improve itself. Turning donation off later stops future publishing, but data already
              published to IPFS may remain available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDonationEnable}>Enable donation</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function OperatorDataMarket({
  onRestartPending = () => undefined,
}: OperatorDataMarketProps): JSX.Element {
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch } = useQuery<OperatorArtifactsResponse>({
    queryKey: ['operator-artifacts', 'served'],
    queryFn: () => api.operator.listArtifacts({ source: 'served', limit: 100 }),
    refetchInterval: 10_000,
  });

  const revertRef = useRef<(() => void) | null>(null);
  const registerRevert = (revert: (() => void) | null): void => {
    revertRef.current = revert;
  };

  const pricingMutation = useMutation({
    mutationFn: (pricing: OperatorPricingConfig) => api.operator.updatePricing(pricing),
    onSuccess: async () => {
      revertRef.current = null;
      toast.success('Donation setting saved', {
        description: 'Restart pending — applies on next daemon start.',
      });
      onRestartPending();
      await queryClient.invalidateQueries({ queryKey: ['operator-artifacts'] });
    },
    onError: (err) => {
      const revert = revertRef.current;
      revertRef.current = null;
      revert?.();
      toast.error('Failed to save donation setting', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const summary = data?.summary;
  const sectionSummary = summary
    ? `${summary.served.totalCount} eligible runs · donation ${data?.pricing.donation.enabled ? 'on' : 'off'} · ${summary.network.totalCount} peer datasets used`
    : 'Donate scrubbed and anonymized run data to IPFS so other operators can use it.';

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="flex items-center gap-2">
            <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
            Data donation
          </CardTitle>
          <CardDescription>{sectionSummary}</CardDescription>
        </div>
        <Badge variant={data?.pricing.donation.enabled ? 'success' : 'outline'}>
          {data?.pricing.donation.enabled ? 'IPFS donation on' : 'Donation off'}
        </Badge>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div
            data-testid="operator-data-market-loading"
            className="flex flex-col gap-3"
            aria-label="Loading execution data"
          >
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-72" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}

        {isError && (
          <Alert
            variant="blocking"
            role="alert"
            data-testid="operator-data-market-error"
            className="flex items-center justify-between gap-3"
          >
            <AlertTitle className="text-[var(--break-red)]">
              {error instanceof Error ? error.message : 'Failed to load execution data.'}
            </AlertTitle>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => {
                void refetch();
              }}
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
              Retry
            </Button>
          </Alert>
        )}

        {data && (
          <DonationStatusPanel
            key={`${data.pricing.publicEndpoint}|${data.pricing.defaultPriceUsdc}|${data.pricing.donation.enabled}|${JSON.stringify(sortedRecord(data.pricing.perArtifactTypePrice))}`}
            pricing={data.pricing}
            eligibleRuns={data.summary.served.totalCount}
            peerDatasetsUsed={data.summary.network.totalCount}
            saving={pricingMutation.isPending}
            onSave={(pricing) => pricingMutation.mutate(pricing)}
            registerRevert={registerRevert}
          />
        )}
      </CardContent>
    </Card>
  );
}
