const { VerdictChip, Tag } = window.__C;
function ResultTable({entrants,showIncomplete}){
  const max=Math.max(...entrants.map(e=>e.score));
  return <div style={{border:'var(--border-hair) solid var(--rule)',background:'var(--surface-card)'}}>
    <table style={{width:'100%',borderCollapse:'collapse',font:'var(--type-ui)',fontSize:'var(--text-sm)'}}>
      <thead><tr>
        {['Configuration','Model · harness','Met','Score','Conflicted',...(showIncomplete?['Incomplete']:[]),'Cost'].map((h,i)=>
          <th key={h} style={{textAlign:i>1?'right':'left',font:'var(--type-label)',letterSpacing:'var(--tracking-caps)',textTransform:'uppercase',color:'var(--text-muted)',padding:'var(--space-5) var(--space-6)',borderBottom:'var(--border-heavy) solid var(--rule-heavy)',whiteSpace:'nowrap'}}>{h}</th>)}
      </tr></thead>
      <tbody>
        {entrants.map((e,i)=><tr key={e.id} style={{borderBottom:'var(--border-hair) solid var(--rule)'}}>
          <td style={{padding:'var(--space-6)'}}>
            <div style={{display:'flex',alignItems:'center',gap:'var(--space-5)'}}>
              <span style={{width:3,height:22,background:i===0?'var(--vermilion-500)':'var(--ink-300)',flex:'none'}}/>
              <div style={{display:'flex',flexDirection:'column',gap:1}}>
                <span style={{fontFamily:'var(--font-mono)',fontSize:'var(--text-sm)'}}>{e.id}</span>
                {e.note&&<span style={{fontSize:'var(--text-xs)',color:'var(--text-muted)'}}>{e.note}</span>}
              </div>
            </div>
          </td>
          <td style={{padding:'var(--space-6)',color:'var(--text-secondary)',fontSize:'var(--text-xs)',fontFamily:'var(--font-mono)'}}>{e.stack}</td>
          <td style={{padding:'var(--space-6)',textAlign:'right',fontFamily:'var(--font-mono)'}}>{e.met}<span style={{color:'var(--text-faint)'}}>/{e.expected}</span></td>
          <td style={{padding:'var(--space-6)',textAlign:'right'}}>
            <div style={{display:'flex',alignItems:'center',gap:'var(--space-5)',justifyContent:'flex-end'}}>
              <span style={{width:88,height:'var(--bar-height)',background:'var(--surface-inset)',border:'var(--border-hair) solid var(--rule)',position:'relative',flex:'none'}}>
                <span style={{position:'absolute',inset:'0 auto 0 0',width:(100*e.score/max)+'%',background:i===0?'var(--vermilion-500)':'var(--ink-400)'}}/>
              </span>
              <span style={{fontFamily:'var(--font-mono)',minWidth:52,textAlign:'right'}}>{e.score.toFixed(1)}%</span>
            </div>
          </td>
          <td style={{padding:'var(--space-6)',textAlign:'right'}}>{e.conflicted?<VerdictChip size="sm" verdict="conflicted" count={e.conflicted}>Conflicted</VerdictChip>:<span style={{color:'var(--text-faint)',fontFamily:'var(--font-mono)'}}>0</span>}</td>
          {showIncomplete&&<td style={{padding:'var(--space-6)',textAlign:'right'}}>{e.incomplete?<VerdictChip size="sm" verdict="incomplete" count={e.incomplete}>Not returned</VerdictChip>:<span style={{color:'var(--text-faint)',fontFamily:'var(--font-mono)'}}>0</span>}</td>}
          <td style={{padding:'var(--space-6)',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--text-secondary)'}}>{e.cost}</td>
        </tr>)}
      </tbody>
    </table>
  </div>;
}
Object.assign(window.__K,{ResultTable});
