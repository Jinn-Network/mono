import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('App', () => {
  it('renders the explorer heading', () => {
    render(<App />, { wrapper });
    expect(screen.getByText('Jinn network explorer')).toBeInTheDocument();
  });
});
