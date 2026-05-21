import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ShapeCatalogue } from './ShapeCatalogue.js';

describe('ShapeCatalogue (hfmf)', () => {
  it('renders a row for each PLUGIN_SHAPE_FIELDS entry', () => {
    render(<ShapeCatalogue />);
    expect(screen.getByText('name')).toBeTruthy();
    expect(screen.getByText('version')).toBeTruthy();
    expect(screen.getByText('jinn.supports')).toBeTruthy();
    expect(screen.getByText('jinn.skills')).toBeTruthy();
  });

  it('marks required fields', () => {
    render(<ShapeCatalogue />);
    // Required cells are tagged with data-required="true"
    const required = document.querySelectorAll('[data-field-required="true"]');
    // name, version, jinn.supports
    expect(required.length).toBeGreaterThanOrEqual(3);
  });

  it('renders both plug-in modes', () => {
    render(<ShapeCatalogue />);
    expect(screen.getAllByText(/Runtime plug-in/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/SolverType plug-in/i).length).toBeGreaterThanOrEqual(1);
  });

  it('shows the runtime example with jinn.runtime', () => {
    render(<ShapeCatalogue />);
    expect(screen.getByText(/"supports": \["jinn\.runtime"\]/)).toBeTruthy();
  });

  it('shows the solver-type example with swe-rebench-v2.v1', () => {
    render(<ShapeCatalogue />);
    expect(screen.getByText(/swe-rebench-v2\.v1/)).toBeTruthy();
  });
});
