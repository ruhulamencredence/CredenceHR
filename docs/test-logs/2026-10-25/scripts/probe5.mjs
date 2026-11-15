const BASE='http://localhost:3100';
async function api(t,m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'content-type':'application/json',...(t?{authorization:`Bearer ${t}`}:{})},body:b!==undefined?JSON.stringify(b):undefined});const x=await r.text();let j;try{j=JSON.parse(x)}catch{j=x};return{status:r.status,body:j}}
const SA=(await api(null,'POST','/api/auth/login',{identifier:'admin@credence.test',password:'AdminPass123'})).body.token;
const N=(await api(null,'POST','/api/auth/login',{identifier:'nasrin.hr@credence.test',password:'Pass12345'})).body.token||(await api(null,'POST','/api/auth/login',{identifier:'nasrin@credence.test',password:'Pass12345'})).body.token;
for (const [n,t] of [['superadmin',SA],['HR (Nasrin)',N]]) { if(!t){console.log(n,'no token');continue}
 const q=await api(t,'GET','/api/my-approvals'); const items=q.body.items||q.body; console.log(n,'queue',q.status,Array.isArray(items)?items.length:'?', JSON.stringify((Array.isArray(items)?items:[]).filter(i=>i.source_type==='leave_application').map(i=>i.source_id)));
 const d=await api(t,'POST','/api/leave-applications/2/decision',{action:'approved'}); console.log(n,'decision on #2',d.status,JSON.stringify(d.body).slice(0,140)); }
const emp=await api(null,'GET','/x'); 
