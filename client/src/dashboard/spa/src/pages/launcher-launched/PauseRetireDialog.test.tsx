import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PauseRetireDialog } from './PauseRetireDialog.js';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('PauseRetireDialog', () => {
  it('renders nothing when open=false', () => {
    render(
      <PauseRetireDialog
        open={false}
        target="paused"
        solverNetName="Polymarket"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(screen.queryByTestId('launcher-launched-dialog')).toBeNull();
  });

  it('Pause: Confirm enabled immediately, no typed-name input', () => {
    render(
      <PauseRetireDialog
        open
        target="paused"
        solverNetName="Polymarket"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const confirm = screen.getByTestId('launcher-launched-dialog-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    expect(screen.queryByTestId('launcher-launched-dialog-typed')).toBeNull();
    expect(screen.getByText(/Pause SolverNet/i)).toBeTruthy();
  });

  it('Resume: Confirm enabled immediately, body explains resume', () => {
    render(
      <PauseRetireDialog
        open
        target="launched"
        solverNetName="Polymarket"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const confirm = screen.getByTestId('launcher-launched-dialog-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    expect(confirm.textContent).toMatch(/Resume/);
    expect(screen.getByText(/resume polling/i)).toBeTruthy();
  });

  it('Retire: Confirm disabled until typed name matches', () => {
    render(
      <PauseRetireDialog
        open
        target="retired"
        solverNetName="Polymarket"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const typed = screen.getByTestId('launcher-launched-dialog-typed') as HTMLInputElement;
    const confirm = screen.getByTestId('launcher-launched-dialog-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(typed, { target: { value: 'Wrong' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(typed, { target: { value: 'Polymarket' } });
    expect(confirm.disabled).toBe(false);
  });

  it('Retire: typed-name gate is case-insensitive (matches the uppercase display)', () => {
    // The confirm label renders the SolverNet name with `text-transform:
    // uppercase` via CSS, so an operator who types exactly what is displayed
    // (e.g. "SWE-REBENCH V2" for a net named "SWE-rebench v2") must be able
    // to enable the Retire button.  Regression for #413.
    render(
      <PauseRetireDialog
        open
        target="retired"
        solverNetName="SWE-rebench v2"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const typed = screen.getByTestId('launcher-launched-dialog-typed') as HTMLInputElement;
    const confirm = screen.getByTestId('launcher-launched-dialog-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    // Typing the CSS-uppercased form (what the dialog visually shows) should match.
    fireEvent.change(typed, { target: { value: 'SWE-REBENCH V2' } });
    expect(confirm.disabled).toBe(false);
    // Typing the original mixed-case form should also still match.
    fireEvent.change(typed, { target: { value: 'SWE-rebench v2' } });
    expect(confirm.disabled).toBe(false);
    // A clearly wrong value must not match.
    fireEvent.change(typed, { target: { value: 'SWE-rebench' } });
    expect(confirm.disabled).toBe(true);
  });

  it('Retire: Confirm fires onConfirm only when name matches', () => {
    const onConfirm = vi.fn();
    render(
      <PauseRetireDialog
        open
        target="retired"
        solverNetName="Polymarket"
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );
    const confirm = screen.getByTestId('launcher-launched-dialog-confirm') as HTMLButtonElement;
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('launcher-launched-dialog-typed'), {
      target: { value: 'Polymarket' },
    });
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Cancel button fires onCancel', () => {
    const onCancel = vi.fn();
    render(
      <PauseRetireDialog
        open
        target="paused"
        solverNetName="Polymarket"
        onConfirm={() => undefined}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId('launcher-launched-dialog-cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('pressing Escape fires onCancel', () => {
    // shadcn AlertDialog (Radix) routes backdrop click + Escape through
    // `onOpenChange`. We assert the keyboard path here; the backdrop-click
    // path is exercised by Radix itself.
    const onCancel = vi.fn();
    render(
      <PauseRetireDialog
        open
        target="paused"
        solverNetName="Polymarket"
        onConfirm={() => undefined}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(screen.getByTestId('launcher-launched-dialog'), {
      key: 'Escape',
      code: 'Escape',
    });
    expect(onCancel).toHaveBeenCalled();
  });

  it('pending=true disables Confirm and renders pending label', () => {
    render(
      <PauseRetireDialog
        open
        target="paused"
        solverNetName="Polymarket"
        onConfirm={() => undefined}
        onCancel={() => undefined}
        pending
      />,
    );
    const confirm = screen.getByTestId('launcher-launched-dialog-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toMatch(/Pause…/);
  });

  it('renders errorMessage when supplied', () => {
    render(
      <PauseRetireDialog
        open
        target="paused"
        solverNetName="Polymarket"
        onConfirm={() => undefined}
        onCancel={() => undefined}
        errorMessage="500 boom"
      />,
    );
    expect(screen.getByTestId('launcher-launched-dialog-error').textContent).toBe('500 boom');
  });

  it('clears typed input when dialog re-opens', () => {
    const { rerender } = render(
      <PauseRetireDialog
        open
        target="retired"
        solverNetName="Polymarket"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    fireEvent.change(screen.getByTestId('launcher-launched-dialog-typed'), {
      target: { value: 'Polymarket' },
    });
    rerender(
      <PauseRetireDialog
        open={false}
        target="retired"
        solverNetName="Polymarket"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    rerender(
      <PauseRetireDialog
        open
        target="retired"
        solverNetName="Polymarket"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const typed = screen.getByTestId('launcher-launched-dialog-typed') as HTMLInputElement;
    expect(typed.value).toBe('');
  });

  it('Escape is ignored when pending=true', () => {
    const onCancel = vi.fn();
    render(
      <PauseRetireDialog
        open
        target="paused"
        solverNetName="Polymarket"
        onConfirm={() => undefined}
        onCancel={onCancel}
        pending
      />,
    );
    fireEvent.keyDown(screen.getByTestId('launcher-launched-dialog'), {
      key: 'Escape',
      code: 'Escape',
    });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
