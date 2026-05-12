import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles/colors_and_type.css';
import './styles/foundations.css';
import './styles/app.css';
import { App } from './App';

const qc = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 20_000, retry: 1 } },
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
