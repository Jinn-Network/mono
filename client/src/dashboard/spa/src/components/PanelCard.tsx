import type { CSSProperties, ReactNode } from 'react';

export interface PanelCardProps {
  title?: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const panelStyle: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-3, 10px)',
  padding: '24px',
  background: 'var(--surface)',
};

export function PanelCard({ title, children, className, style }: PanelCardProps): JSX.Element {
  return (
    <section style={{ ...panelStyle, ...style }} className={className}>
      {title && <h3 style={{ marginTop: 0 }}>{title}</h3>}
      {children}
    </section>
  );
}
