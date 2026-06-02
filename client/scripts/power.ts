import { compareRates, wilsonInterval } from '../src/eval/wilson.js';
for (const N of [3,5,8,10,20,30]) {
  const rows: string[] = [];
  for (let b = 0; b <= N; b++) {
    let minA = -1;
    for (let a = b+1; a <= N; a++) {
      if (compareRates({passed:a,scorable:N},{passed:b,scorable:N}).verdict === 'trustworthy') { minA = a; break; }
    }
    rows.push(minA>=0 ? `${b}->${minA}(Δ${(((minA-b)/N)*100).toFixed(0)}pp)` : `${b}->none`);
  }
  console.log(`N=${N}: ` + rows.join('  '));
}
console.log('--- intervals at N=10 ---');
for (const [p,n] of [[0,10],[1,10],[2,10],[3,10],[5,10],[8,10],[10,10]] as [number,number][]) {
  const w = wilsonInterval(p,n);
  console.log(`  ${p}/${n}: ${(w.p*100).toFixed(0)}% [${(w.lo*100).toFixed(0)}, ${(w.hi*100).toFixed(0)}]`);
}
