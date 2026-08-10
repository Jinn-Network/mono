import React from 'react';
export function Footnote({marker,href,children,style}){
  const body=<span style={{font:'var(--type-body)',fontSize:'var(--text-sm)',color:'var(--text-secondary)'}}>{children}</span>;
  return <div style={{display:'flex',gap:'var(--space-5)',alignItems:'flex-start',maxWidth:'var(--measure)',...style}}>
    <span style={{font:'var(--type-data)',fontSize:'var(--text-xs)',color:'var(--vermilion-600)',flex:'none',paddingTop:3}}>{marker}</span>
    {href?<a href={href} style={{textDecorationColor:'var(--ink-300)'}}>{body}</a>:body}
  </div>;
}