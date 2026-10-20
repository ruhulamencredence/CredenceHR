const BASE='http://localhost:3100';
async function api(t,m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'content-type':'application/json',...(t?{authorization:`Bearer ${t}`}:{})},body:b!==undefined?JSON.stringify(b):undefined});const x=await r.text();let j;try{j=JSON.parse(x)}catch{j=x};return{status:r.status,body:j}}
const SA=(await api(null,'POST','/api/auth/login',{identifier:'admin@credence.test',password:'AdminPass123'})).body.token;
const e=(await api(SA,'GET','/api/employees')).body; const emp=(Array.isArray(e)?e:e.employees||e.rows||[])[0];
const nb=await api(SA,'POST','/api/payroll/pending-bonuses',{employee_id:emp.id,month_year:'2026-12',amount:-5000}); console.log('negative bonus',nb.status,JSON.stringify(nb.body).slice(0,100));
const big=await api(SA,'POST','/api/payroll/salary-structures',{employee_id:emp.id,effective_date:'2026-02-01',basic_salary:99999999999,house_rent:0,medical_allowance:0,conveyance_allowance:0}); console.log('absurd basic salary 99,999,999,999',big.status,JSON.stringify(big.body).slice(0,100));
const t=await api(SA,'POST','/api/users',{name:'x',email:'a@b.c',password:'Pass12345',role:'superadmin'}); console.log('create a second superadmin via API',t.status,JSON.stringify(t.body).slice(0,100));
