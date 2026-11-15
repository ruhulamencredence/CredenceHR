import { execSync } from 'child_process';
const B='http://localhost:3200', T=process.argv[2], Y=process.argv[3];
const sql=(q)=>execSync(`mysql -N -ucred -pcredpass admin_ui -e "${q.replace(/"/g,'\\"')}"`).toString().trim();
const call=async(t,m,u,b)=>{const r=await fetch(B+u,{method:m,headers:{...(t?{authorization:'Bearer '+t}:{}),'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))}};
const login=async e=>(await call(null,'POST','/api/auth/login',{email:e,password:'ProbePass123',workspace:'credence'})).j?.token;
let pass=0,fail=0;const ok=(m,c)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const punches=(...hms)=>{sql(`DELETE FROM zk_attendance_logs WHERE device_user_pin='102' AND DATE(punch_time)='${T}'`); for (const h of hms) sql(`INSERT INTO zk_attendance_logs (device_id, device_user_pin, raw_pin, punch_time) VALUES (7,'102','102','${T} ${h}')`);};
const resetDay=()=>{sql(`DELETE FROM attendance WHERE user_id=132 AND attendance_date='${T}'`);};
const sa=await login('admin@credence.test'), hr=await login('roster.hr@credence.test'), tv=await login('tanvir.r@credence.test');
const ds=async()=> (await call(tv,'GET','/api/attendance/day-status')).j;
const officeRow=async()=> ((await call(sa,'GET',`/api/office-attendance?from=${T}&to=${T}`)).j||[]).find(r=>r.employee_id===37);
const dailyRow=async()=> ((await call(sa,'GET',`/api/attendance/report/daily?date=${T}`)).j.present||[]).find(r=>r.user_id===132);
const monthDay=async()=> { const j=(await call(sa,'GET',`/api/attendance/report/monthly?year=${T.slice(0,4)}&month=${Number(T.slice(5,7))}`)).j; const u=j.users.find(x=>x.user_id===132||x.id===132); return u.days.find(d=>String(d.date).slice(0,10)===T); };
const p360Day=async()=> ((await call(sa,'GET',`/api/hr-ops/p360/37/section/attendance?month=${T.slice(0,7)}`)).j.days||[]).find(d=>d.date===T);

// --- the rule's own settings ---
sql("DELETE FROM admin_module_permission_layers WHERE user_id=133 AND module_key='office_attendance'");
sql("INSERT IGNORE INTO admin_module_permissions (user_id, module_key, company_id) VALUES (133,'office_attendance',1)");
let r=await call(sa,'GET','/api/office-attendance/punch-rule'); ok('rule starts at 5 minutes from today', r.j.minutes===5 && r.j.effective_from===T);
ok('Superadmin can edit', r.j.can_edit===true);
r=await call(hr,'GET','/api/office-attendance/punch-rule'); ok('HR with Office Attendance can see the rule', r.s===200 && r.j.minutes===5);
ok('...but not edit (no layer)', r.j.can_edit===false);
ok('...and the API refuses the change (403)', (await call(hr,'PUT','/api/office-attendance/punch-rule',{minutes:3})).s===403);
ok('an employee cannot read it (403)', (await call(tv,'GET','/api/office-attendance/punch-rule')).s===403);
ok('bad value refused (400)', (await call(sa,'PUT','/api/office-attendance/punch-rule',{minutes:-1})).s===400 && (await call(sa,'PUT','/api/office-attendance/punch-rule',{minutes:'abc'})).s===400 && (await call(sa,'PUT','/api/office-attendance/punch-rule',{minutes:999})).s===400);

// --- double punch (09:00:00 + 09:04:00: beyond the report's 2-minute tap filter, inside 5 minutes) ---
resetDay(); punches('09:00:00','09:04:00');
let d=await ds(); ok('card: double punch is not the Out', d.check_in_at && !d.check_out_at);
ok('Office Attendance report: no Out, 2 punches shown', (await officeRow())?.check_out_at===null && (await officeRow())?.punch_count===2);
ok('daily report: no Out', (await dailyRow())?.check_out_at===null);
ok('monthly report: no Out', !(await monthDay())?.check_out_at);
ok('HR 360: no Out', (await p360Day())?.out===null);
// 5 minutes exactly counts as an Out
punches('09:00:00','09:05:00'); d=await ds(); ok('a punch exactly 5 minutes later IS the Out', String(d.check_out_at||'').includes('09:05'));
// a real Out later still counts
punches('09:00:00','09:01:30','18:00:00');
d=await ds(); ok('card: a real later punch is still the Out', String(d.check_out_at).includes('18:00'));
const dhaka=(v)=>v?new Date(v).toLocaleTimeString('en-GB',{timeZone:'Asia/Dhaka',hour:'2-digit',minute:'2-digit'}):null;
ok('Office report: Out 18:00', dhaka((await officeRow())?.check_out_at)==='18:00');
ok('daily report: Out 18:00', String((await dailyRow())?.check_out_at).includes('18:00'));
ok('monthly report: Out 18:00', String((await monthDay())?.check_out_at).includes('18:00'));
ok('HR 360: Out 18:00', (await p360Day())?.out==='18:00');
// turning it off brings the old behaviour back for today
punches('09:00:00','09:04:00');
ok('Superadmin sets 0 (off)', (await call(sa,'PUT','/api/office-attendance/punch-rule',{minutes:0})).s===200);
d=await ds(); ok('off: the second punch is the Out again (old behaviour)', String(d.check_out_at).includes('09:04'));
ok('saving twice the same day corrects that day, does not stack', sql(`SELECT COUNT(*) FROM zk_punch_rules WHERE effective_from='${T}'`)==='1');
sql("INSERT INTO admin_module_permission_layers (user_id, module_key, layer_key) VALUES (133,'office_attendance','read'),(133,'office_attendance','punch_rules')");
ok('HR with the "Double punch rule" layer can change it', (await call(hr,'PUT','/api/office-attendance/punch-rule',{minutes:5})).s===200);
r=await call(sa,'GET','/api/office-attendance/punch-rule'); ok('history shows who set it', r.j.minutes===5 && r.j.history[0].by);
// yesterday's double punch keeps its old Out (rule starts today)
const ym=(await call(sa,'GET',`/api/attendance/report/monthly?year=${Y.slice(0,4)}&month=${Number(Y.slice(5,7))}`)).j.users.find(x=>x.user_id===132||x.id===132).days.find(x=>String(x.date).slice(0,10)===Y);
ok("yesterday (before the rule) keeps its Out 09:01", String(ym?.check_out_at).includes('09:01'));

// --- after a double punch the employee can give the Out from the app (no special permission) ---
resetDay(); punches('09:00:00','09:01:30');
d=await ds(); ok('no Out shown, so "Set Now" is offered', !d.check_out_at);
r=await call(tv,'POST','/api/attendance/check-out',{project_id:1, latitude:23.7806, longitude:90.4074});
ok('employee gives the Out from the app ('+r.s+(r.j.error?': '+r.j.error:'')+')', r.s===200);
d=await ds(); ok('the app Out is the day Out', d.check_out_source==='remote' && d.check_out_at);
ok('machine punches untouched', sql(`SELECT COUNT(*) FROM zk_attendance_logs WHERE device_user_pin='102' AND DATE(punch_time)='${T}'`)==='2');

// --- Step 1: a real machine Out, then "Set again" ---
resetDay(); punches('09:00:00','13:00:00');
d=await ds(); ok('machine Out 13:00 shown', d.check_out_source==='office' && String(d.check_out_at).includes('13:00'));
ok('without the permission: no "Set again"', d.can_update_check_out===false);
sql('UPDATE users SET can_update_check_out=1 WHERE id=132');
d=await ds(); ok('with "update Out Time": "Set again" offered on a machine Out', d.can_update_check_out===true);
ok('/status agrees', (await call(tv,'GET','/api/attendance/status?project_id=1')).j.can_update_check_out===true);
r=await call(tv,'POST','/api/attendance/check-out',{project_id:1, latitude:23.7806, longitude:90.4074});
ok('"Set again" saves ('+r.s+(r.j.error?': '+r.j.error:'')+')', r.s===200);
d=await ds(); ok('the new Out (from the app) is the day Out now', d.check_out_source==='remote');
ok('goes for approval', sql(`SELECT COUNT(*) FROM approval_requests WHERE source_type='attendance' AND event_type='check_out' AND source_id IN (SELECT id FROM attendance WHERE user_id=132 AND attendance_date='${T}')`)==='1');
ok('the machine 13:00 punch is still on record', sql(`SELECT COUNT(*) FROM zk_attendance_logs WHERE device_user_pin='102' AND punch_time='${T} 13:00:00'`)==='1');
sql('UPDATE users SET can_update_check_out=0 WHERE id=132');
sql("DELETE FROM admin_module_permission_layers WHERE user_id=133 AND module_key='office_attendance'");
console.log(`${pass}/${pass+fail}`);
