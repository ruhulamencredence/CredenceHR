// Captures every report that turns office machine punches into In / Out, as JSON.
import fs from 'fs';
const B='http://localhost:3200', OUT=process.argv[2], TODAY=process.argv[3], Y=process.argv[4];
const login=async e=>(await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:e,password:'ProbePass123',workspace:'credence'})})).json()).token;
const get=async(t,u)=>{const r=await fetch(B+u,{headers:{authorization:'Bearer '+t}});return {status:r.status,body:await r.json().catch(()=>null)}};
const sa=await login('admin@credence.test'), tv=await login('tanvir.r@credence.test');
const [y,m]=TODAY.split('-').map(Number);
const cap={
  monthly: await get(sa,`/api/attendance/report/monthly?year=${y}&month=${m}`),
  monthly_prev: await get(sa,`/api/attendance/report/monthly?year=${m===1?y-1:y}&month=${m===1?12:m-1}`),
  daily_today: await get(sa,`/api/attendance/report/daily?date=${TODAY}`),
  daily_y: await get(sa,`/api/attendance/report/daily?date=${Y}`),
  office: await get(sa,`/api/office-attendance?from=${TODAY.slice(0,8)}01&to=${TODAY}`),
  p360: await get(sa,`/api/hr-ops/p360/37/section/attendance?month=${TODAY.slice(0,7)}`),
  mine: await get(tv,'/api/attendance/mine'),
  day_status: await get(tv,'/api/attendance/day-status'),
  status_p1: await get(tv,'/api/attendance/status?project_id=1')
};
fs.writeFileSync(OUT, JSON.stringify(cap,null,1));
for (const [k,v] of Object.entries(cap)) console.log(k, v.status);
