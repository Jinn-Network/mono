import React from 'react';
export function Imprint({rows=[],builtOnJinn=true,mark=true,style}){
  return <div style={{borderTop:'var(--border-heavy) solid var(--rule-heavy)',paddingTop:'var(--space-6)',display:'flex',gap:'var(--space-9)',alignItems:'flex-start',flexWrap:'wrap',...style}}>
    {mark&&<span style={{color:'var(--vermilion-500)',flex:'none'}} aria-hidden="true"><svg width="22" height="22" viewBox="0 0 32 32" fill="currentColor"><rect x="12.5" y="1.5" width="7" height="7" transform="rotate(45 16 5)"/><rect x="2.5" y="19.5" width="7" height="7" transform="rotate(45 6 23)"/><rect x="22.5" y="19.5" width="7" height="7" transform="rotate(45 26 23)"/></svg></span>}
    <dl style={{display:'grid',gridTemplateColumns:'auto 1fr',columnGap:'var(--space-8)',rowGap:'var(--space-3)',margin:0,flex:1,minWidth:260}}>
      {rows.map((r,i)=><React.Fragment key={i}>
        <dt style={{font:'var(--type-label)',letterSpacing:'var(--tracking-caps)',textTransform:'uppercase',color:'var(--text-muted)',paddingTop:2}}>{r.label}</dt>
        <dd style={{font:'var(--type-data)',color:'var(--text-secondary)',margin:0,wordBreak:'break-word'}}>{r.value}</dd>
      </React.Fragment>)}
    </dl>
    {builtOnJinn&&<span style={{font:'var(--type-data)',fontSize:'var(--text-xs)',color:'var(--text-faint)',flex:'none',alignSelf:'flex-end'}}>Built on Jinn.</span>}
  </div>;
}