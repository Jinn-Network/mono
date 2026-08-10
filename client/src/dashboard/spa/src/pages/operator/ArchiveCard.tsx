import { type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Archive, AlertTriangle } from 'lucide-react';
import { api } from '../../api/client.js';
import type { StatusV1Response } from '../../../../../api/contract/index.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';

const POLL_MS = 8000;

/**
 * §2.16 Record Archive. Read-only. Two things: the evidence-indexing health the driver
 * surfaces (records that failed to index stall the announcement stream, contract 6), and the
 * public-serving posture. Serving is a config opt-in (restart-required) — the SPA does not
 * toggle it; the IP-disclosure copy lives here because the operator's IP exposure is on the
 * line (BRAND.md: plain speech on safety). Indexing failures render from the server, not a
 * client kind→copy map (headless design §8).
 */
export function ArchiveCard(): JSX.Element {
  const { data } = useQuery<StatusV1Response>({
    queryKey: ['status'],
    queryFn: () => api.getStatus(),
    refetchInterval: POLL_MS,
  });

  const indexing = data?.evidenceIndexing;

  return (
    <Card data-testid="archive-status-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Archive className="h-4 w-4" aria-hidden="true" />
          Record archive
        </CardTitle>
        <CardDescription>
          Your signed record of completed work. The evidence driver publishes into it as work
          indexes; a second operator can mirror it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Evidence indexing
          </span>
          {indexing === undefined ? (
            <p className="text-sm text-muted-foreground">No indexing activity yet.</p>
          ) : indexing.failures.length > 0 ? (
            <Alert variant="warning" data-testid="archive-indexing-degraded">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>Evidence indexing degraded</AlertTitle>
              <AlertDescription>
                <p>
                  {indexing.failures.length} record{indexing.failures.length === 1 ? '' : 's'}{' '}
                  failed to index. The driver retries automatically.
                </p>
                <ul className="mt-2 flex flex-col gap-1">
                  {indexing.failures.map((f) => (
                    <li key={f.reference} className="font-mono text-xs">
                      {f.reference}: {f.message}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : indexing.pending > 0 ? (
            <p className="text-sm text-muted-foreground">
              {indexing.pending} record{indexing.pending === 1 ? '' : 's'} waiting to index.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">All records indexed.</p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Public serving
          </span>
          <p className="text-sm text-muted-foreground">
            Off by default. If you enable public serving in your config, anyone who fetches the
            archive learns this machine&rsquo;s IP address. To share without disclosing it, publish
            the archive files to a mirror or static host instead — the archive is plain files and
            needs no Jinn software to serve.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
