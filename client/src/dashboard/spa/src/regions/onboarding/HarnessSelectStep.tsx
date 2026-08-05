import { type JSX, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import type { HarnessReadinessEntry } from '../../../../../api/contract/index.js';
import {
  CLAUDE_CODE_HARNESS,
  CODEX_HARNESS,
  HERMES_AGENT_HARNESS,
  harnessDisplayName,
} from '../../pages/configuration/harnessNames.js';
import {
  defaultModelForHarness,
  modelOptionsForHarness,
} from '../../pages/configuration/claudeModels.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group.js';
import { Label } from '../../components/ui/label.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { TierDots } from './TierDots.js';

/**
 * Onboarding step 5 — choose the harness + model your node uses for its work.
 *
 * Build-deltas: Approach A (status column only); one solver harness + model,
 * evaluator hidden (it is manifest-bound and runs automatically); defaults
 * Codex / GPT-5.4 Mini. Copy must not imply the chosen harness evaluates.
 *
 * Readiness is probed via `GET /v1/harnesses/:name/readiness`. That registry
 * holder is populated post-flip only; in setup mode the probe 503s. We treat
 * BOTH `harness_not_found` (404) AND `subsystem_not_ready` (503) — and any
 * undefined result — as "checking", never "not ready", so the step never
 * falsely blocks the operator. Only a definitive `ready: false` renders the
 * setup block and reports the gate closed.
 */

const SOLVER_HARNESSES = [CODEX_HARNESS, CLAUDE_CODE_HARNESS, HERMES_AGENT_HARNESS] as const;

const SWALLOWED_READINESS_CODES = new Set(['harness_not_found', 'subsystem_not_ready']);

export interface HarnessSelection {
  harness: string;
  model: string;
  /** True only on a definitive `ready: true` probe. */
  ready: boolean;
}

export function HarnessSelectStep({
  onSelectionChange,
}: {
  onSelectionChange: (sel: HarnessSelection) => void;
}): JSX.Element {
  const [harness, setHarness] = useState<string>(CODEX_HARNESS);
  const [model, setModel] = useState<string>(defaultModelForHarness(CODEX_HARNESS));

  // Probe only the selected harness. `null` data = checking (not ready).
  // TanStack Query rejects `undefined` from a queryFn, so the swallow path
  // returns `null` (which the query accepts) rather than `undefined`.
  const readinessQuery = useQuery<HarnessReadinessEntry | null>({
    queryKey: ['onboarding-harness-readiness', harness],
    refetchInterval: 5_000,
    queryFn: async () => {
      try {
        return await api.harnessReadiness(harness);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code && SWALLOWED_READINESS_CODES.has(code)) return null;
        throw err;
      }
    },
  });

  const readiness = readinessQuery.data;
  const definitivelyReady = readiness?.ready === true;
  const definitivelyNotReady = readiness?.ready === false;

  // Report the selection upward on every change.
  useEffect(() => {
    onSelectionChange({ harness, model, ready: definitivelyReady });
  }, [harness, model, definitivelyReady, onSelectionChange]);

  function selectHarness(next: string): void {
    setHarness(next);
    setModel(defaultModelForHarness(next));
  }

  const modelOptions = modelOptionsForHarness(harness);

  return (
    <Card data-testid="onboarding-harness-card">
      <CardHeader>
        <CardTitle className="font-mono text-[15px]">
          Harness &amp; model
        </CardTitle>
        <p className="text-sm text-[var(--fg-muted)]">
          The harness and model your node uses for its work.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <RadioGroup value={harness} onValueChange={selectHarness} className="gap-2">
          {SOLVER_HARNESSES.map((name) => {
            const selected = name === harness;
            // Status column (Approach A): only the selected harness is probed,
            // so the tag for unselected rows reads "Select to check".
            const tag = !selected
              ? 'Select to check'
              : definitivelyReady
                ? 'Ready'
                : definitivelyNotReady
                  ? 'Setup required'
                  : 'Checking…';
            return (
              <label
                key={name}
                htmlFor={`onboarding-harness-${name}`}
                className="flex cursor-pointer items-center gap-3 rounded-[var(--radius-2)] border border-border px-3 py-2.5"
                data-testid={`onboarding-harness-row-${name}`}
              >
                <RadioGroupItem value={name} id={`onboarding-harness-${name}`} />
                <span className="flex-1 font-mono text-[13px]">
                  {harnessDisplayName(name)}
                </span>
                <TierDots
                  protocol
                  node
                  machine={selected ? definitivelyReady : false}
                />
                <Badge variant={tag === 'Ready' ? 'default' : 'secondary'}>{tag}</Badge>
              </label>
            );
          })}
        </RadioGroup>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="onboarding-model-select" className="text-[var(--fg-muted)]">
            Model
          </Label>
          <select
            id="onboarding-model-select"
            data-testid="onboarding-model-select"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="rounded-[var(--radius-1)] border border-border bg-transparent px-2 py-1.5 font-mono text-[13px]"
          >
            {modelOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {definitivelyNotReady && (
          <div
            data-testid="onboarding-harness-not-ready"
            className="flex flex-col gap-2 rounded-[var(--radius-2)] border border-[var(--break-red)] px-3 py-2.5"
          >
            <span className="font-mono text-[12px] text-[var(--break-red)]">
              {readiness?.reason ?? 'This harness needs setup before your node can use it.'}
            </span>
            {readiness?.nextStep?.description && (
              <span className="text-sm text-[var(--fg-muted)]">
                {readiness.nextStep.description}
              </span>
            )}
            {readiness?.nextStep?.cli && (
              <code className="rounded-[var(--radius-1)] bg-[var(--bg-sunken)] px-2 py-1 font-mono text-[12px]">
                {readiness.nextStep.cli}
              </code>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="onboarding-harness-recheck"
              onClick={() => void readinessQuery.refetch()}
              className="self-start"
            >
              Recheck
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
