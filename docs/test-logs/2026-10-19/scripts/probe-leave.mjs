const BASE='http://localhost:3100';
async function api(t,m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'content-type':'application/json',...(t?{authorization:`Bearer ${t}`}:{})},body:b!==undefined?JSON.stringify(b):undefined});const x=await r.text();let j;try{j=JSON.parse(x)}catch{j=x};return{status:r.status,body:j}}
const login=async(i,p)=>(await api(null,'POST','/api/auth/login',{identifier:i,password:p})).body;
const SA=(await login('admin@credence.test','AdminPass123')).token; const A=(await login('alice.rv@credence.test','NewPass456')).token;
const day=(n)=>new Date(Date.now()+n*864e5).toLocaleDateString('en-CA',{timeZone:'Asia/Dhaka'});
const bal=async()=> (await api(A,'GET','/api/leave-balances/mine')).body[0]?.casual_leave ?? (await api(A,'GET','/api/leave-balances/mine')).body;
console.log('Alice casual balance before:', await bal());
const d=day(200);
const a1=await api(A,'POST','/api/leave-applications',{leave_type:'casual',start_date:d,end_date:d,purpose:'dup probe 1'});
const a2=await api(A,'POST','/api/leave-applications',{leave_type:'casual',start_date:d,end_date:d,purpose:'dup probe 2'});
console.log('two applications for the same single day:',a1.status,a1.body.id,a2.status,a2.body.id,'balance after applying:',await bal());
for(const a of [a1,a2]){const r=await api(SA,'POST',`/api/leave-applications/${a.body.id}/decision`,{action:'approved',remarks:'probe'});console.log('approve',a.body.id,r.status,JSON.stringify(r.body).slice(0,120));}
console.log('balance after approving both:',await bal());
const ls=await api(A,'GET','/api/leave-applications/mine'); console.log('approved rows for',d,':',(ls.body.items||ls.body).filter?.((x)=>(x.start_date||'').startsWith(d)&&x.status==='approved').length);
