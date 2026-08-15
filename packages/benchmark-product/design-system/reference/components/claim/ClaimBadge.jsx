import React from 'react';
const STATUS={observed:['Observed','var(--verdict-met)'],attested:['Attested','var(--verdict-attested)'],conflicted:['Conflicted','var(--verdict-conflicted)'],incomplete:['Incomplete','var(--verdict-incomplete)'],draft:['Draft','var(--verdict-unverifiable)']};
export function ClaimBadge({label='colophon',value,status='observed',href='#',style}){
  const [txt,c]=STATUS[status]||STATUS.observed;
  return <a href={href} style={{display:'inline-flex',alignItems:'stretch',height:22,border:'var(--border-hair) solid var(--rule-strong)',borderRadius:'var(--radius-xs)',overflow:'hidden',textDecoration:'none',fontFamily:'var(--font-mono)',fontSize:'var(--text-2xs)',lineHeight:'20px',...style}}>
    <span style={{display:'inline-flex',alignItems:'center',gap:5,padding:'0 7px',background:'var(--ink-900)',color:'var(--ink-50)'}}>
      <span style={{color:'var(--vermilion-500)',display:'inline-flex'}}><svg width="10" height="10" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><rect x="12.5" y="1.5" width="7" height="7" transform="rotate(45 16 5)"/><rect x="2.5" y="19.5" width="7" height="7" transform="rotate(45 6 23)"/><rect x="22.5" y="19.5" width="7" height="7" transform="rotate(45 26 23)"/></svg></span>{label}</span>
    <span style={{padding:'0 7px',background:'var(--surface-card)',color:'var(--text-primary)'}}>{value}</span>
    <span style={{padding:'0 7px',background:'var(--surface-inset)',color:c,borderLeft:'var(--border-hair) solid var(--rule)'}}>{txt}</span>
  </a>;
}