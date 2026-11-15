const BASE='http://localhost:3100';
async function api(t,m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'content-type':'application/json',...(t?{authorization:`Bearer ${t}`}:{})},body:(b!==undefined&&m!=='GET')?JSON.stringify(b):undefined});const x=await r.text();let j;try{j=JSON.parse(x)}catch{j=x};return{status:r.status,body:j}}
const L=async(i,p)=>(await api(null,'POST','/api/auth/login',{identifier:i,password:p})).body.token;
const SA=await L('admin@credence.test','AdminPass123'); const BOB=await L('bob.rv@credence.test','Pass12345');
const P=(n,ok,d='')=>console.log(ok?'PASS':'FAIL',n,ok?'':d);
const j=(r)=>`${r.status} ${JSON.stringify(r.body).slice(0,110)}`;
for(const [m,p] of [['POST','/api/breaks/start'],['GET','/api/breaks/report'],['PUT','/api/break-settings'],['GET','/api/feedback'],['PUT','/api/feedback/settings']]){const r=await api(BOB,m,p,{});P(`Employee blocked from ${m} ${p}`,[401,403].includes(r.status),j(r));}
const fb=await api(BOB,'POST','/api/feedback',{rating:5,message:'<img src=x onerror=alert(1)> great',category:'idea'}); console.log('INFO feedback by employee',j(fb));
const k=await api(null,'POST','/api/auth/forgot/email',{identifier:'alice.rv@credence.test'}); const u=await api(null,'POST','/api/auth/forgot/email',{identifier:'nobody.zz@credence.test'});
P('Forgot-password answers the same for a known and an unknown email (no account enumeration)',k.status===u.status&&JSON.stringify(k.body)===JSON.stringify(u.body),`known ${j(k)} | unknown ${j(u)}`);
let c=[];for(let i=0;i<12;i++)c.push((await api(null,'POST','/api/auth/forgot/email/verify',{identifier:'alice.rv@credence.test',code:String(100000+i),new_password:'Brandnew123'})).status);
P('Guessing the 6-digit reset code is throttled (12 wrong tries)',c.some(x=>x===429||x===423),`statuses ${[...new Set(c)]}`);
const wk=await api(SA,'POST','/api/users',{name:'Weak2',email:'weak2@credence.test',password:'111111',role:'user'}); console.log('INFO password 111111 still accepted?',j(wk));
