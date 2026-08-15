import React from 'react';
export function Switch({label,checked=false,disabled=false,onChange,style}){
  return <label style={{display:'inline-flex',alignItems:'center',gap:'var(--space-5)',cursor:disabled?'not-allowed':'pointer',opacity:disabled?.5:1,...style}}>
    <span onClick={()=>!disabled&&onChange&&onChange(!checked)} role="switch" aria-checked={checked} style={{width:34,height:19,flex:'none',borderRadius:'var(--radius-pill)',background:checked?'var(--ink-900)':'var(--ink-200)',border:'var(--border-hair) solid '+(checked?'var(--ink-900)':'var(--rule-strong)'),position:'relative',transition:'var(--transition-ui)'}}>
      <span style={{position:'absolute',top:2,left:checked?17:2,width:13,height:13,borderRadius:'var(--radius-pill)',background:'var(--ink-50)',transition:'left var(--duration-fast) var(--ease-standard)'}}/>
    </span>
    {label&&<span style={{font:'var(--type-ui)',fontSize:'var(--text-sm)'}}>{label}</span>}
  </label>;
}