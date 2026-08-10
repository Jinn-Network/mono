import React from 'react';
const T={neutral:['var(--text-secondary)','var(--surface-inset)','var(--rule)'],ink:['var(--ink-50)','var(--ink-900)','var(--ink-900)'],accent:['var(--vermilion-700)','var(--vermilion-100)','var(--vermilion-300)'],indigo:['var(--indigo-700)','var(--indigo-100)','var(--indigo-300)'],outline:['var(--text-secondary)','transparent','var(--rule-strong)']};
export function Tag({tone='neutral',mono=false,icon,children,style,...rest}){
  const [c,bg,bd]=T[tone];
  return <span style={{display:'inline-flex',alignItems:'center',gap:'var(--space-3)',padding:'2px 7px',borderRadius:'var(--radius-xs)',border:'var(--border-hair) solid '+bd,background:bg,color:c,fontFamily:mono?'var(--font-mono)':'var(--font-ui)',fontSize:'var(--text-2xs)',fontWeight:mono?400:600,letterSpacing:mono?'var(--tracking-mono-caps)':'var(--tracking-wide)',whiteSpace:'nowrap',...style}} {...rest}>{icon}{children}</span>;
}