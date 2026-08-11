import React from 'react';
const S={sm:26,md:32,lg:38};
export function IconButton({label,icon,size='md',variant='ghost',disabled=false,onClick,style,...rest}){
  const d=S[size];
  const v=variant==='outline'?{border:'var(--border-hair) solid var(--rule-strong)',background:'var(--surface-card)'}:{border:'var(--border-hair) solid transparent',background:'transparent'};
  return <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} style={{width:d,height:d,display:'inline-flex',alignItems:'center',justifyContent:'center',borderRadius:'var(--radius-sm)',color:'var(--text-secondary)',cursor:disabled?'not-allowed':'pointer',opacity:disabled?.4:1,transition:'var(--transition-ui)',...v,...style}} {...rest}>{icon}</button>;
}