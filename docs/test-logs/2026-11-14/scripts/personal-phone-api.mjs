const B='http://localhost:3200';
async function login(email){const r=await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:'ProbePass123',workspace:'credence'})});const j=await r.json();return j.token;}
let pass=0,fail=0;const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
for (const who of ['tanvir.r@credence.test', process.argv[2]]) {
  const t=await login(who); const h={authorization:'Bearer '+t};
  const r=await fetch(B+'/api/employee-directory',{headers:h}); const body=await r.text();
  ok(r.status===200, who+' directory 200');
  ok(!body.includes('01999000002'), who+' directory has no personal number');
  ok(!/"mobile"/.test(body), who+' directory has no mobile field');
  const f=JSON.parse(body).find(e=>e.id===36); ok(f && f.phone==='01711000001', who+' directory shows office number');
}
const t=await login(process.argv[2]); const r=await fetch(B+'/api/employees',{headers:{authorization:'Bearer '+t}}); const j=await r.json();
const rows=Array.isArray(j)?j:(j.rows||j.employees||[]); const f=rows.find(e=>e.id===36);
ok(f && f.phone==='01711000001','Employees list: Contact column value is office number');
ok(f && f.mobile==='01999000002','Employees list still has the personal number for the Personal Contact tab');
console.log(`${pass}/${pass+fail}`);
