import React from 'react';
export function Checkbox({label,description,checked,defaultChecked,disabled=false,onChange,id,style}){
  const rid=React.useId();const eid=id||rid;
  return <label htmlFor={eid} style={{display:'flex',gap:'var(--space-5)',alignItems:'flex-start',cursor:disabled?'not-allowed':'pointer',opacity:disabled?.5:1,...style}}>
    <input type="checkbox" id={eid} checked={checked} defaultChecked={defaultChecked} disabled={disabled} onChange={onChange} style={{width:15,height:15,marginTop:2,accentColor:'var(--ink-900)',flex:'none'}}/>
    <span style={{display:'flex',flexDirection:'column',gap:2}}>
      <span style={{font:'var(--type-ui)',fontSize:'var(--text-sm)',color:'var(--text-primary)'}}>{label}</span>
      {description&&<span style={{font:'var(--type-data)',fontSize:'var(--text-xs)',color:'var(--text-muted)'}}>{description}</span>}
    </span>
  </label>;
}