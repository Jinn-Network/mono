import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { ActivityCard, type ActivityJoinedNet, type ActivityTask } from './ActivityCard.js';

import type { JSX } from 'react';

function wrap(ui: JSX.Element, initial = '/overview'): {
  hook: ReturnType<typeof memoryLocation>['hook'];
  history: string[];
  ui: JSX.Element;
} {
  const memory = memoryLocation({ path: initial, record: true });
  return { hook: memory.hook, history: memory.history, ui: <Router hook={memory.hook}>{ui}</Router> };
}

const joined: ActivityJoinedNet[] = [
  {
    name: 'SWE-rebench v2',
    manifestCid: 'bafkreiswe',
    roles: ['solver', 'evaluator'],
    harness: 'hermes-agent',
    model: 'minimax-m2.7',
    plugins: [
      { name: 'network-tools', displayName: 'Network Tools', defaultIncluded: true },
      {
        name: 'swe-rebench-v2-runtime',
        displayName: 'SWE-rebench v2 Runtime',
        defaultIncluded: true,
      },
    ],
  },
];

const baseTask: ActivityTask = {
  requestId: '0xabc1234567890abcdef',
  manifestCid: 'bafkreiswe',
  solverType: 'swe-rebench-v2.v1',
  taskRole: 'restoration',
  state: 'COMPLETE',
  implName: 'hermes-agent',
  windowStartTs: Date.now() - 120_000,
  runStartedAt: Date.now() - 120_000,
  stateUpdatedAt: Date.now() - 60_000,
  deliveryTxHash: null,
};

describe('ActivityCard', () => {
  it('renders the three regions: joined list, tasks table, settings', () => {
    const { ui } = wrap(<ActivityCard joined={joined} tasks={[baseTask]} />);
    render(ui);
    expect(screen.getByText(/^activity$/i)).toBeTruthy();
    expect(screen.getByTestId('activity-joined')).toBeTruthy();
    expect(screen.getByTestId('activity-tasks')).toBeTruthy();
    expect(screen.getByTestId('activity-settings')).toBeTruthy();
  });

  it('lists joined SolverNets and selects the first one by default', () => {
    const { ui } = wrap(<ActivityCard joined={joined} tasks={[]} />);
    render(ui);
    const row = screen.getByTestId('activity-joined-row-bafkreiswe');
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(row.textContent).toBe('SWE-rebench v2');
  });

  it('navigates to /operator/registry when "Join more SolverNets" is clicked', () => {
    const { history, ui } = wrap(<ActivityCard joined={joined} tasks={[]} />);
    render(ui);
    fireEvent.click(screen.getByTestId('activity-join-more'));
    expect(history.at(-1)).toBe('/operator/registry');
  });

  it('navigates to the event log from the Activity header', () => {
    const { history, ui } = wrap(<ActivityCard joined={joined} tasks={[]} />);
    render(ui);
    fireEvent.click(screen.getByTestId('activity-view-event-log'));
    expect(history.at(-1)).toBe('/events');
  });

  it('navigates to /operator/claim-policy when Settings · Edit is clicked', () => {
    const { history, ui } = wrap(<ActivityCard joined={joined} tasks={[]} />);
    render(ui);
    fireEvent.click(screen.getByTestId('activity-settings-edit'));
    expect(history.at(-1)).toBe('/operator/claim-policy');
  });

  it('renders task rows from the input, showing run type + state + relative time', () => {
    const tasks: ActivityTask[] = [
      { ...baseTask, requestId: 'task-a', state: 'COMPLETE', taskRole: 'restoration' },
      // Evaluation row that was actually engaged with (runStartedAt populated)
      // surfaces; opportunities we never claimed are filtered out elsewhere.
      { ...baseTask, requestId: 'task-b', state: 'FAILED', taskRole: 'evaluation', runStartedAt: Date.now() - 60_000 },
      { ...baseTask, requestId: 'task-c', state: 'RUNNING', taskRole: 'restoration' },
    ];
    const { ui } = wrap(<ActivityCard joined={joined} tasks={tasks} />);
    render(ui);
    const table = screen.getByTestId('activity-tasks-table');
    expect(table.textContent).toContain('task-a');
    expect(table.textContent).toContain('task-b');
    expect(table.textContent).toContain('task-c');
    expect(table.textContent).toMatch(/succeeded/i);
    expect(table.textContent).toMatch(/failed/i);
    expect(table.textContent).toMatch(/active/i);
    expect(screen.getAllByText('solve').length).toBeGreaterThan(0);
    expect(screen.getAllByText('evaluate').length).toBeGreaterThan(0);
  });

  it('renders an Outcome column with the task-relative verdict (#502)', () => {
    const tasks: ActivityTask[] = [
      // COMPLETE solve run the network judged a fail: both a State badge
      // (succeeded) and an Outcome badge (fail) render.
      { ...baseTask, requestId: 'solve-failed-outcome', state: 'COMPLETE', taskRole: 'restoration', outcome: 'fail' },
    ];
    const { ui } = wrap(<ActivityCard joined={joined} tasks={tasks} />);
    render(ui);
    const table = screen.getByTestId('activity-tasks-table');
    // The new column header.
    expect(table.textContent).toMatch(/Outcome/);
    // State axis unchanged.
    expect(table.textContent).toMatch(/succeeded/i);
    // Outcome axis.
    expect(screen.getByText('fail')).toBeTruthy();
  });

  it('renders "awaiting eval" for a COMPLETE solve run with no quorum yet (#502)', () => {
    const tasks: ActivityTask[] = [
      { ...baseTask, requestId: 'solve-awaiting', state: 'COMPLETE', taskRole: 'restoration', outcome: 'awaiting' },
    ];
    const { ui } = wrap(<ActivityCard joined={joined} tasks={tasks} />);
    render(ui);
    expect(screen.getByText('awaiting eval')).toBeTruthy();
  });

  it('renders "—" in the outcome cell for a run with no outcome (#502)', () => {
    const tasks: ActivityTask[] = [
      { ...baseTask, requestId: 'no-outcome', state: 'FAILED', taskRole: 'restoration', runStartedAt: Date.now() - 60_000, outcome: null },
    ];
    const { ui } = wrap(<ActivityCard joined={joined} tasks={tasks} />);
    render(ui);
    const table = screen.getByTestId('activity-tasks-table');
    // FAILED run has no outcome axis → the cell renders a muted em dash.
    expect(table.textContent).toContain('—');
    // No outcome badge label leaked.
    expect(screen.queryByText('fail')).toBeNull();
  });

  it('drills from a task request id into request-scoped events', () => {
    const { history, ui } = wrap(<ActivityCard joined={joined} tasks={[baseTask]} />);
    render(ui);
    fireEvent.click(screen.getByText('0xabc1…cdef'));
    expect(history.at(-1)).toBe('/events?requestId=0xabc1234567890abcdef');
  });

  it('renders RACE_LOST rows as a distinct neutral chip, not under "failed" (#896)', () => {
    // Pruned-by-another-operator runs are terminal but not failures. The chip
    // label must read "race-lost" (neutral tone), the row must appear, and the
    // FAILED-only filter at line 221 must NOT drop the row even when
    // runStartedAt is null (prunes happen before any work).
    const tasks: ActivityTask[] = [
      { ...baseTask, requestId: 'race-pruned', state: 'RACE_LOST', taskRole: 'restoration', runStartedAt: null },
    ];
    const { ui } = wrap(<ActivityCard joined={joined} tasks={tasks} />);
    render(ui);
    const row = screen.getByTestId('activity-task-row-race-pruned');
    expect(row).toBeTruthy();
    expect(row.textContent).toMatch(/race-lost/i);
    expect(row.textContent).not.toMatch(/\bfailed\b/i);
  });

  it('filters out FAILED rows we never engaged with (never started OR impl not ready) but keeps real failures', () => {
    const tasks: ActivityTask[] = [
      // Real solver failure: started, then failed mid-execution
      { ...baseTask, requestId: 'kept-real-fail', state: 'FAILED', taskRole: 'restoration', runStartedAt: Date.now() - 60_000 },
      // Never engaged: opportunity observed but daemon never started it
      { ...baseTask, requestId: 'dropped-never-started', state: 'FAILED', taskRole: 'evaluation', runStartedAt: null },
      // Never engaged: impl not enabled on this operator (evaluator harness off)
      { ...baseTask, requestId: 'dropped-impl-not-ready', state: 'FAILED', taskRole: 'evaluation', runStartedAt: Date.now() - 60_000, failureReason: "impl 'swe-rebench-v2-evaluator' not ready: not enabled" },
    ];
    const { ui } = wrap(<ActivityCard joined={joined} tasks={tasks} />);
    render(ui);
    expect(screen.queryByTestId('activity-task-row-kept-real-fail')).not.toBeNull();
    expect(screen.queryByTestId('activity-task-row-dropped-never-started')).toBeNull();
    expect(screen.queryByTestId('activity-task-row-dropped-impl-not-ready')).toBeNull();
  });

  it('keeps delivered COMPLETE runs by scoping on solverType, not the delivery CID (#838)', () => {
    // Multi-SolverNet operator: the old filter scoped by manifestCid equality,
    // but a delivered run's manifestCid is the delivery/solution CID — never the
    // SolverNet manifest CID — so every COMPLETE row was hidden. Scope by
    // solverType instead.
    const multiJoined: ActivityJoinedNet[] = [
      { name: 'SWE-rebench v2', manifestCid: 'bafkreiswe', solverType: 'swe-rebench-v2.v1', roles: ['solver'] },
      { name: 'prediction', manifestCid: 'bafkreipred', solverType: 'prediction.v1', roles: ['solver'] },
    ];
    const tasks: ActivityTask[] = [
      // Delivered swe-rebench run: manifestCid is the delivery CID (≠ selected
      // SolverNet manifest), but solverType matches the selected net.
      { ...baseTask, requestId: 'delivered-complete', state: 'COMPLETE', solverType: 'swe-rebench-v2.v1', manifestCid: 'bafkreiDELIVERYcid' },
      // A different SolverNet's run must stay scoped out of this view.
      { ...baseTask, requestId: 'other-net', state: 'COMPLETE', solverType: 'prediction.v1', manifestCid: 'bafkreiOTHER' },
    ];
    const { ui } = wrap(<ActivityCard joined={multiJoined} tasks={tasks} />);
    render(ui);
    expect(screen.queryByTestId('activity-task-row-delivered-complete')).not.toBeNull();
    expect(screen.queryByTestId('activity-task-row-other-net')).toBeNull();
    expect(screen.getByTestId('activity-tasks-table').textContent).toMatch(/succeeded/i);
  });

  it('shows STARTED from runStartedAt instead of an old task window start', () => {
    const now = Date.now();
    const sixDaysAgo = now - 6 * 86_400_000;
    const twoMinutesAgo = now - 120_000;
    const { ui } = wrap(
      <ActivityCard
        joined={joined}
        tasks={[
          {
            ...baseTask,
            requestId: 'fresh-claim',
            windowStartTs: sixDaysAgo,
            runStartedAt: twoMinutesAgo,
            stateUpdatedAt: twoMinutesAgo,
          },
        ]}
      />,
    );

    render(ui);

    const row = screen.getByTestId('activity-task-row-fresh-claim');
    expect(row.textContent).toMatch(/2m ago/);
    expect(row.textContent).not.toMatch(/6d ago/);
  });

  it('renders the empty-tasks state when there are no task runs', () => {
    const { ui } = wrap(<ActivityCard joined={joined} tasks={[]} />);
    render(ui);
    expect(screen.queryByTestId('activity-tasks-table')).toBeNull();
    expect(screen.getByTestId('activity-tasks').textContent).toMatch(/no task runs/i);
  });

  it('renders the settings panel with roles, harness, model, and plugins for the selected SolverNet', () => {
    const { ui } = wrap(<ActivityCard joined={joined} tasks={[]} />);
    render(ui);
    const settings = screen.getByTestId('activity-settings');
    expect(settings.textContent).toMatch(/roles/i);
    expect(settings.textContent).toMatch(/solver/i);
    expect(settings.textContent).toMatch(/evaluator/i);
    expect(settings.textContent).toMatch(/harness/i);
    expect(settings.textContent).toContain('hermes-agent');
    expect(settings.textContent).toMatch(/model/i);
    expect(settings.textContent).toContain('minimax-m2.7');
    expect(settings.textContent).toMatch(/plugins/i);
    // Display names, not raw plugin specifiers — and each default plugin
    // shows a small "default" qualifier so the operator knows whether it
    // came from manifest defaults or explicit config.
    expect(settings.textContent).toContain('Network Tools');
    expect(settings.textContent).toContain('SWE-rebench v2 Runtime');
    expect(settings.textContent).toMatch(/default/i);
  });

  it('renders model/plugins placeholders when the selected net is missing them', () => {
    const minimal: ActivityJoinedNet[] = [
      { name: 'SparseNet', manifestCid: 'bafsparse', roles: ['solver'] },
    ];
    const { ui } = wrap(<ActivityCard joined={minimal} tasks={[]} />);
    render(ui);
    const settings = screen.getByTestId('activity-settings');
    // Model line still renders, just dimmed with the em-dash placeholder.
    expect(settings.textContent).toContain('—');
    // Plugins section reports "None" when the array is empty/undefined.
    expect(settings.textContent).toMatch(/plugins/i);
    expect(settings.textContent).toMatch(/none/i);
  });

  it('handles the no-SolverNets-joined state gracefully', () => {
    const { ui } = wrap(<ActivityCard joined={[]} tasks={[]} />);
    render(ui);
    expect(screen.getByTestId('activity-joined').textContent).toMatch(/no solvernets joined/i);
    expect(screen.getByTestId('activity-settings').textContent).toMatch(/no solvernet selected/i);
    // The "Join more SolverNets" button is still available so the operator can act.
    expect(screen.getByTestId('activity-join-more')).toBeTruthy();
  });
});
