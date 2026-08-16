import { type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import { harnessDisplayName } from '../../pages/configuration/harnessNames.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';

/**
 * Onboarding step 4 — confirm this machine can run the work it is configured
 * for.
 *
 * This step used to be a harness + model PICKER whose selection was persisted
 * by re-joining a SolverNet. Wave-4 D1 (DR-2026-08-05) retired the join write
 * path, so the picker collected a choice and dropped it on the floor. Per
 * headless design §4.2 the surviving authority for harness + model is
 * configuration — `executionWiring` in `~/.jinn-client/config.json`, rendered
 * in Settings > Claim policy & wiring — so this step reports readiness and
 * asks for no choice.
 *
 * Data source is the composed snapshot (`GET /v1/harnesses/readiness`), which
 * covers every harness compiled into this build. The registry holder is
 * populated post-flip only; in setup mode the probe 503s. Both
 * `subsystem_not_ready` (503) and an undefined result read as "checking",
 * never "not ready", so a pre-flip poll never shows a false failure. Readiness
 * does not gate the takeover: an operator whose harness needs setup can still
 * enter the dashboard and fix it there.
 */

const SWALLOWED_READINESS_CODES = new Set(['harness_not_found', 'subsystem_not_ready']);

export function HarnessReadinessStep(): JSX.Element {
  const snapshotQuery = useQuery({
    queryKey: ['onboarding-harness-readiness-snapshot'],
    refetchInterval: 5_000,
    queryFn: async () => {
      try {
        return await api.harnessReadinessSnapshot();
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code && SWALLOWED_READINESS_CODES.has(code)) return null;
        throw err;
      }
    },
  });

  const harnesses = snapshotQuery.data?.harnesses ?? [];

  return (
    <Card data-testid="onboarding-harness-card">
      <CardHeader>
        <CardTitle className="font-mono text-[15px]">Harness readiness</CardTitle>
        <p className="text-sm text-[var(--fg-muted)]">
          Which execution harnesses this machine can run. Choose the harness and model your node
          uses in <code>executionWiring</code> (<code>~/.jinn-client/config.json</code>) — Settings
          &gt; Claim policy &amp; wiring shows the result.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {harnesses.length === 0 && (
          <span
            data-testid="onboarding-harness-checking"
            className="font-mono text-[12px] text-[var(--fg-muted)]"
          >
            Checking…
          </span>
        )}

        {harnesses.map((entry) => (
          <div
            key={entry.harnessName}
            data-testid={`onboarding-harness-row-${entry.harnessName}`}
            data-ready={entry.ready ? 'true' : 'false'}
            className="flex flex-col gap-2 rounded-[var(--radius-2)] border border-border px-3 py-2.5"
          >
            <div className="flex items-center gap-3">
              <span className="flex-1 font-mono text-[13px]">
                {harnessDisplayName(entry.harnessName)}
              </span>
              <Badge variant={entry.ready ? 'default' : 'secondary'}>
                {entry.ready ? 'Ready' : 'Setup required'}
              </Badge>
            </div>
            {!entry.ready && (
              <div className="flex flex-col gap-2">
                <span className="font-mono text-[12px] text-[var(--fg-muted)]">
                  {entry.reason ?? 'This harness needs setup before your node can use it.'}
                </span>
                {entry.nextStep?.description && (
                  <span className="text-sm text-[var(--fg-muted)]">
                    {entry.nextStep.description}
                  </span>
                )}
                {entry.nextStep?.cli && (
                  <code className="rounded-[var(--radius-1)] bg-[var(--bg-sunken)] px-2 py-1 font-mono text-[12px]">
                    {entry.nextStep.cli}
                  </code>
                )}
              </div>
            )}
          </div>
        ))}

        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="onboarding-harness-recheck"
          onClick={() => void snapshotQuery.refetch()}
          className="self-start"
        >
          Recheck
        </Button>
      </CardContent>
    </Card>
  );
}
