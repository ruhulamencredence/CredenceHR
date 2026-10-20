import { execFileSync } from 'child_process';
const BASE='http://localhost:3100';
async function api(t,m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'content-type':'application/json',...(t?{authorization:`Bearer ${t}`}:{})},body:b!==undefined?JSON.stringify(b):undefined});const x=await r.text();let j;try{j=JSON.parse(x)}catch{j=x};return{status:r.status,body:j}}
const sql=(q)=>execFileSync('mysql',['-N','mpr_tracker_db','-e',q]).toString().trim();
const SA=(await api(null,'POST','/api/auth/login',{identifier:'admin@credence.test',password:'AdminPass123'})).body.token;
const e=await api(SA,'POST','/api/employees',{name:'Delete Probe',designation:'Officer',department_id:2,joining_date:'2024-01-01'});const id=e.body.id;
console.log('salary structure',(await api(SA,'POST','/api/payroll/salary-structures',{employee_id:id,effective_date:'2026-01-01',basic_salary:20000,house_rent:0,medical_allowance:0,conveyance_allowance:0})).status);
const g=await api(SA,'POST','/api/payroll/generate',{employee_id:id,month_year:'2026-07',total_working_days:26,present_days:26,leave_days:0,absent_days:0});
console.log('generate',g.status,JSON.stringify(g.body).slice(0,80),'rows before delete',sql(`SELECT COUNT(*) FROM payrolls WHERE employee_id=${id}`));
await api(SA,'POST','/api/payroll/approval/2026-07/submit',{});await api(SA,'POST','/api/payroll/approval/2026-07/approve',{});
const pay=await api(SA,'POST','/api/payroll/approval/2026-07/pay',{payment_date:'2026-07-31',payment_method:'Bank Transfer',payment_reference:'X'});
console.log('paid',pay.status,'status',sql(`SELECT payment_status FROM payrolls WHERE employee_id=${id}`));
const pid=sql(`SELECT id FROM payrolls WHERE employee_id=${id} LIMIT 1`);
const edit=await api(SA,'PUT',`/api/payroll/${pid}`,{bonus_amount:900000});console.log('edit paid payroll',edit.status,JSON.stringify(edit.body).slice(0,100),'net now',sql(`SELECT net_salary FROM payrolls WHERE id=${pid}`));
const del=await api(SA,'DELETE',`/api/employees/${id}`);
console.log('delete employee',del.status,JSON.stringify(del.body),'| payroll rows after',sql(`SELECT COUNT(*) FROM payrolls WHERE employee_id=${id}`),'| employee rows',sql(`SELECT COUNT(*) FROM all_employees WHERE id=${id}`));
