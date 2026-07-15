/**
 * AiUnitsPauseAlert — issue #815 running-mode surface.
 *
 * Shows a compact banner per paused credential, naming the reason
 * (which window tripped) and the next reset instant in operator-local
 * time. Renders nothing when no credentials are paused.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AiUnitsPauseAlert } from './AiUnitsPauseAlert.js';

afterEach(() => cleanup());

describe('AiUnitsPauseAlert', () => {
  it('renders nothing when no aiUnits block is present', () => {
    const { container } = render(<AiUnitsPauseAlert aiUnits={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when no credentials are paused', () => {
    const { container } = render(
      <AiUnitsPauseAlert
        aiUnits={{
          credentials: [
            {
              credentialId: 'anthropic:api-key',
              unitsThisBlock: 30,
              unitsThisWeek: 200,
              capPerBlock: 100,
              capPerWeek: 2800,
              paused: false,
              blockResetsAt: '2026-05-28T18:00:00.000Z',
              weekResetsAt: '2026-06-04T13:00:00.000Z',
            },
          ],
        }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a banner per paused credential with the reset time', () => {
    render(
      <AiUnitsPauseAlert
        aiUnits={{
          credentials: [
            {
              credentialId: 'anthropic:api-key',
              unitsThisBlock: 100,
              unitsThisWeek: 200,
              capPerBlock: 100,
              capPerWeek: 2800,
              paused: true,
              blockResetsAt: '2026-05-28T18:00:00.000Z',
              weekResetsAt: '2026-06-04T13:00:00.000Z',
            },
          ],
        }}
      />,
    );
    const alert = screen.getByTestId('ai-units-pause-alert-anthropic:api-key');
    expect(alert.textContent).toContain('anthropic:api-key');
    expect(alert.textContent).toContain('Paused');
    expect(alert.textContent).toContain('AI-unit');
  });

  it('does not render an idle credential as active (#891)', () => {
    // active:false, paused:false — configured but not being worked against.
    const { container } = render(
      <AiUnitsPauseAlert
        aiUnits={{
          credentials: [
            {
              credentialId: 'anthropic:subscription',
              unitsThisBlock: 0,
              unitsThisWeek: 0,
              capPerBlock: 100,
              capPerWeek: 2800,
              paused: false,
              active: false,
              blockResetsAt: '2026-05-28T18:00:00.000Z',
              weekResetsAt: '2026-06-04T13:00:00.000Z',
            },
          ],
        }}
      />,
    );
    // Idle + unpaused → no banner at all, so it is never shown as active.
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('ai-units-credential-state-anthropic:subscription')).toBeNull();
  });

  it('labels a paused, active credential as Active (#891)', () => {
    render(
      <AiUnitsPauseAlert
        aiUnits={{
          credentials: [
            {
              credentialId: 'anthropic:subscription',
              unitsThisBlock: 100,
              unitsThisWeek: 200,
              capPerBlock: 100,
              capPerWeek: 2800,
              paused: true,
              active: true,
              blockResetsAt: '2026-05-28T18:00:00.000Z',
              weekResetsAt: '2026-06-04T13:00:00.000Z',
            },
          ],
        }}
      />,
    );
    const state = screen.getByTestId('ai-units-credential-state-anthropic:subscription');
    expect(state.textContent).toMatch(/Active/i);
  });

  it('names the binding window (block or week)', () => {
    render(
      <AiUnitsPauseAlert
        aiUnits={{
          credentials: [
            {
              credentialId: 'a:k',
              unitsThisBlock: 100,
              unitsThisWeek: 500,
              capPerBlock: 100,
              capPerWeek: 2800,
              paused: true,
              blockResetsAt: '2026-05-28T18:00:00.000Z',
              weekResetsAt: '2026-06-04T13:00:00.000Z',
            },
            {
              credentialId: 'b:k',
              unitsThisBlock: 5,
              unitsThisWeek: 2800,
              capPerBlock: 100,
              capPerWeek: 2800,
              paused: true,
              blockResetsAt: '2026-05-28T18:00:00.000Z',
              weekResetsAt: '2026-06-04T13:00:00.000Z',
            },
          ],
        }}
      />,
    );
    expect(screen.getByTestId('ai-units-pause-alert-a:k').textContent).toMatch(/6h/);
    expect(screen.getByTestId('ai-units-pause-alert-b:k').textContent).toMatch(/7d|week/i);
  });

  it('prefers the gate-sourced pausedWindow over local derivation when they disagree (#830)', () => {
    // unitsThisBlock >= capPerBlock would locally derive "block", but the
    // daemon gate says the binding window is actually "week" — the
    // gate-sourced field must win.
    render(
      <AiUnitsPauseAlert
        aiUnits={{
          credentials: [
            {
              credentialId: 'c:k',
              unitsThisBlock: 100,
              unitsThisWeek: 2800,
              capPerBlock: 100,
              capPerWeek: 2800,
              paused: true,
              pausedWindow: 'week',
              blockResetsAt: '2026-05-28T18:00:00.000Z',
              weekResetsAt: '2026-06-04T13:00:00.000Z',
            },
          ],
        }}
      />,
    );
    const alert = screen.getByTestId('ai-units-pause-alert-c:k');
    expect(alert.textContent).toMatch(/7d|week/i);
    expect(alert.textContent).not.toMatch(/6h/);
    expect(alert.textContent).toContain('13:00 UTC'); // formatUtc(weekResetsAt)
  });
});
