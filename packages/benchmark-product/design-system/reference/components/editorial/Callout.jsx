import React from 'react';
const K={note:['var(--indigo-600)','var(--indigo-100)'],limitation:['var(--ochre-600)','var(--ochre-100)'],caution:['var(--vermilion-600)','var(--vermilion-100)'],method:['var(--ink-700)','var(--surface-inset)']};
export function Callout({kind='note',title,icon,children,style}){
  const [c,bg]=K[kind];
  return <aside style={{display:'flex',gap:'var(--space-6)',background:bg,borderTop:'var(--border-heavy) solid '+c,padding:'var(--space-6) var(--space-7)',...style}}>
    {icon&&<span style={{color:c,flex:'none',paddingTop:2}}>{icon}</span>}
    <div style={{display:'flex',flexDirection:'column',gap:'var(--space-3)'}}>
      {title&&<span style={{font:'var(--type-label)',letterSpacing:'var(--tracking-caps)',textTransform:'uppercase',color:c}}>{title}</span>}
      <div style={{font:'var(--type-body)',fontSize:'var(--text-base)',color:'var(--text-primary)',maxWidth:'var(--measure)'}}>{children}</div>
    </div>
  </aside>;
}