import React from 'react';
export const VERDICTS={met:{label:'Met',c:'var(--verdict-met)',bg:'var(--verdict-met-bg)'},unmet:{label:'Unmet',c:'var(--verdict-unmet)',bg:'var(--verdict-unmet-bg)'},conflicted:{label:'Conflicted',c:'var(--verdict-conflicted)',bg:'var(--verdict-conflicted-bg)'},attested:{label:'Attested',c:'var(--verdict-attested)',bg:'var(--verdict-attested-bg)'},incomplete:{label:'Incomplete',c:'var(--verdict-incomplete)',bg:'var(--verdict-incomplete-bg)'},unverifiable:{label:'Unverifiable',c:'var(--verdict-unverifiable)',bg:'var(--verdict-unverifiable-bg)'}};
const TEX={observed:null,attested:'var(--texture-attested)',conflicted:'var(--texture-conflicted)',missing:'var(--texture-missing)'};
export function VerdictChip({verdict='met',texture,count,size='md',children,style}){
  const v=VERDICTS[verdict]||VERDICTS.met;
  const tex=TEX[texture||(verdict==='conflicted'?'conflicted':verdict==='attested'?'attested':verdict==='incomplete'?'missing':'observed')];
  const s=size==='sm'?{padding:'1px 6px',fontSize:'var(--text-2xs)'}:{padding:'3px 9px',fontSize:'var(--text-xs)'};
  return <span style={{position:'relative',display:'inline-flex',alignItems:'center',gap:'var(--space-4)',borderRadius:'var(--radius-xs)',border:'var(--border-hair) solid '+v.c,background:v.bg,color:v.c,fontFamily:'var(--font-ui)',fontWeight:'var(--weight-semibold)',letterSpacing:'var(--tracking-wide)',overflow:'hidden',whiteSpace:'nowrap',...s,...style}}>
    {tex&&<span aria-hidden="true" style={{position:'absolute',inset:0,background:tex,backgroundSize:texture==='missing'||verdict==='incomplete'?'var(--texture-missing-size)':undefined,opacity:'var(--texture-opacity)',pointerEvents:'none'}}/>}
    <span style={{position:'relative'}}>{children||v.label}</span>
    {count!=null&&<span style={{position:'relative',fontFamily:'var(--font-mono)',fontWeight:400,opacity:.85}}>{count}</span>}
  </span>;
}