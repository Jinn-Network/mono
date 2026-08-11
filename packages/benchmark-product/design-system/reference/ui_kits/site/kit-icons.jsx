function Icon({name,size=16,strokeWidth=1.6,style}){
  const ref=React.useRef(null);
  React.useEffect(()=>{if(window.lucide&&ref.current){ref.current.innerHTML='';const el=document.createElement('i');el.setAttribute('data-lucide',name);ref.current.appendChild(el);window.lucide.createIcons({attrs:{width:size,height:size,'stroke-width':strokeWidth},nameAttr:'data-lucide'});}},[name,size,strokeWidth]);
  return <span ref={ref} aria-hidden="true" style={{display:'inline-flex',width:size,height:size,flex:'none',...style}}/>;
}
function Mark({size=24,color='var(--vermilion-500)'}){
  return <svg width={size} height={size} viewBox="0 0 32 32" fill={color} aria-hidden="true"><rect x="12.5" y="1.5" width="7" height="7" transform="rotate(45 16 5)"/><rect x="2.5" y="19.5" width="7" height="7" transform="rotate(45 6 23)"/><rect x="22.5" y="19.5" width="7" height="7" transform="rotate(45 26 23)"/></svg>;
}
Object.assign(window.__K,{Icon,Mark});
