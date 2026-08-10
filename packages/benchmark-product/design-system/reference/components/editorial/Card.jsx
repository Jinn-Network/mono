import React from 'react';
export function Card({title,eyebrow,actions,footnote,tone='raised',padding='md',children,style,...rest}){
  const P={none:0,sm:'var(--space-6)',md:'var(--space-8)',lg:'var(--space-9)'}[padding];
  const bg=tone==='sunken'?'var(--surface-inset)':tone==='flat'?'transparent':'var(--surface-card)';
  return <section style={{background:bg,border:'var(--border-hair) solid var(--rule)',borderRadius:'var(--radius-md)',display:'flex',flexDirection:'column',...style}} {...rest}>
    {(title||actions||eyebrow)&&<header style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:'var(--space-6)',padding:P,paddingBottom:'var(--space-6)',borderBottom:children?'var(--border-hair) solid var(--rule)':'none'}}>
      <div style={{display:'flex',flexDirection:'column',gap:'var(--space-2)'}}>
        {eyebrow&&<span style={{font:'var(--type-label)',letterSpacing:'var(--tracking-caps)',textTransform:'uppercase',color:'var(--text-muted)'}}>{eyebrow}</span>}
        {title&&<h3 style={{font:'var(--type-section)',fontSize:'var(--text-lg)',margin:0}}>{title}</h3>}
      </div>
      {actions&&<div style={{display:'flex',gap:'var(--space-4)',flex:'none'}}>{actions}</div>}
    </header>}
    {children&&<div style={{padding:P}}>{children}</div>}
    {footnote&&<footer style={{padding:P,paddingTop:'var(--space-5)',borderTop:'var(--border-hair) solid var(--rule)',font:'var(--type-data)',fontSize:'var(--text-xs)',color:'var(--text-muted)'}}>{footnote}</footer>}
  </section>;
}