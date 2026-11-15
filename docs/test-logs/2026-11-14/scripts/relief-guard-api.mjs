// Relief guard from another project: board marks the sick guard, candidates
// are grouped, the relief guard can check in at that site only during the
// duty, gets an alert, appears on the site supervisor's muster, and a night
// duty's morning Out goes on the duty's own day. Test DB seeded with two
// projects (Gulshan Tower, Banani Site), guard logins, a sick leave and a team.
import mysql from '/home/user/CredenceHR/node_modules/mysql2/promise.js';
const B='http://localhost:3200';
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
const login=async(e)=>(await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:e,password:'ProbePass123',workspace:'credence'})})).json());
const db=await mysql.createConnection({host:'127.0.0.1',user:'cred',password:'credpass',database:'admin_ui',dateStrings:true});
const q=async(s,p=[])=>(await db.query(s,p))[0];
const A=await login('admin@credence.test'), N=await login('nurul.guard@credence.test');
const call=(tok)=>async(m,u,b)=>{const r=await fetch(B+u,{method:m,headers:{Authorization:'Bearer '+tok,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>null)};};
const admin=call(A.token), guard=call(N.token);
const [g]=await q("SELECT id FROM projects WHERE project_name='Gulshan Tower'");
const GUL={project_id:g.id,latitude:23.7925,longitude:90.4078};
const today=new Date(Date.now()+6*3600e3).toISOString().slice(0,10);
const yday=new Date(Date.now()-18*3600e3).toISOString().slice(0,10);
const [nEmp]=await q("SELECT id FROM all_employees WHERE employee_id='SG-2202'");
const [day]=await q("SELECT id FROM duty_shifts WHERE name='Day'");
await q("DELETE FROM guard_relief"); await q("DELETE FROM attendance WHERE user_id=?",[N.user.id]); await q("DELETE FROM alerts WHERE user_id=?",[N.user.id]);

// 1. board: the sick guard
const cov=await admin('GET',`/api/guard/coverage?from=${today}&to=${today}`);
const mg=cov.j.posts.find(p=>p.name==='Main Gate'); const dayRow=mg.rows.find(r=>r.shift_id===day.id);
const cell=dayRow.days[0]; const hamid=cell.people.find(x=>x.name==='Abdul Hamid');
ok(hamid&&hamid.away==='leave'&&hamid.leave_type==='Sick Leave',`board: Abdul Hamid shows on sick leave (${JSON.stringify(hamid)})`);
ok(cell.empty>=1,`board: the post counts as needing ${cell.empty}`);
ok(cov.j.today===today,'board knows today');
// 2. candidates
const fr=await admin('GET',`/api/guard/free?date=${today}&shift_id=${day.id}&post_id=${mg.id}`);
const same=fr.j.people.filter(p=>p.same_site), other=fr.j.people.filter(p=>p.guard&&!p.same_site);
ok(same.length>0&&same.every(p=>/Gulshan/.test(p.home_site||'')),`candidates: same site first (${same.map(p=>p.name).join(', ')})`);
ok(other.length>0&&other.every(p=>p.distance_km!=null),`candidates: other sites with distance (${other.map(p=>p.name+' '+p.distance_km+'km').join(', ')})`);
ok(!fr.j.people.some(p=>p.name==='Abdul Hamid'),'candidates: the sick guard is not offered');
// 3. before relief: no check-in at Gulshan
let mp=await guard('GET','/api/attendance/my-projects');
ok(!mp.j.some(p=>p.id===g.id),'before relief: Gulshan Tower is not among his check-in sites');
let ci=await guard('POST','/api/attendance/check-in',GUL);
ok(ci.s===403,`before relief: check-in at Gulshan Tower is refused (${ci.s} ${ci.j?.error||''})`);
// 4. relief today (Day shift covers now)
const rl=await admin('POST','/api/guard/relief',{employee_id:nEmp.id,date:today,post_id:mg.id,shift_id:day.id});
ok(rl.s===200,`relief put (${JSON.stringify(rl.j)})`);
const al=await q("SELECT title,message FROM alerts WHERE user_id=? AND type='roster'",[N.user.id]);
ok(al.length===1&&/Main Gate/.test(al[0].message)&&/check in there/.test(al[0].message),`he gets an alert: "${al[0]?.message}"`);
const my=await guard('GET','/api/guard/my-relief');
ok(my.j.duties.length===1&&my.j.duties[0].active===true&&my.j.duties[0].site==='Gulshan Tower','my-relief: the duty, active now, at Gulshan Tower');
mp=await guard('GET','/api/attendance/my-projects');
ok(mp.j.some(p=>p.id===g.id),'during the duty: Gulshan Tower is a check-in site');
ci=await guard('POST','/api/attendance/check-in',GUL);
ok(ci.s===200||ci.s===201,`during the duty: check-in at Gulshan Tower works (${ci.s} ${ci.j?.error||ci.j?.project_name||''})`);
const co=await guard('POST','/api/attendance/check-out',GUL);
ok(co.s===200,`and check-out (${co.s} ${co.j?.error||''})`);
// 5. site supervisor's muster
const [team]=await q("SELECT id FROM site_attendance_teams WHERE name='Gulshan Tower guards'");
const sh=await admin('GET',`/api/site-attendance/sheet?team_id=${team.id}&date=${today}`);
const row=sh.j.rows?.find(r=>r.name==='Nurul Amin');
ok(row&&/Main Gate/.test(row.relief||''),`muster: he is on Gulshan's sheet, tagged relief (${row?.relief})`);
const sv=await admin('POST','/api/site-attendance/sheet',{team_id:team.id,date:today,entries:[{employee_id:nEmp.id,status:'present',in_time:'08:05'}]});
const saved=await q("SELECT status FROM site_attendance_entries WHERE employee_id=? AND attendance_date=?",[nEmp.id,today]);
ok(sv.s===200&&saved[0]?.status==='present',`muster: the supervisor can mark him (${sv.s} ${sv.j?.error||''})`);
await q("DELETE FROM site_attendance_entries WHERE employee_id=?",[nEmp.id]);
// 6. relief removed: Gulshan closed again
await admin('DELETE',`/api/guard/relief/${rl.j.id}`);
mp=await guard('GET','/api/attendance/my-projects');
ok(!mp.j.some(p=>p.id===g.id),'relief removed: Gulshan Tower is no longer a check-in site');
// 7. night duty: In yesterday evening, Out this morning goes on yesterday's row
await q("DELETE FROM attendance WHERE user_id=?",[N.user.id]);
const hour=new Date(Date.now()+6*3600e3).getUTCHours();
const endH=String(Math.min(23,hour+2)).padStart(2,'0');
await q("INSERT INTO duty_shifts (name, code, start_time, end_time, color) VALUES ('QA Long Night','QL','22:00',?, '#334155')",[`${endH}:00`]);
const [ln]=await q("SELECT id FROM duty_shifts WHERE name='QA Long Night'");
await q("INSERT INTO guard_relief (employee_id, relief_date, post_id, shift_id) VALUES (?,?,?,?)",[nEmp.id,yday,mg.id,ln.id]);
await q("INSERT INTO attendance (user_id, project_id, attendance_date, check_in_at, check_in_lat, check_in_lng) VALUES (?,?,?,?,23.7925,90.4078)",[N.user.id,g.id,yday,`${yday} 22:03:00`]);
const night=await guard('POST','/api/attendance/check-out',GUL);
const rows=await q("SELECT attendance_date, check_out_at FROM attendance WHERE user_id=? ORDER BY id",[N.user.id]);
ok(night.s===200&&rows.length===1&&rows[0].attendance_date===yday&&!!rows[0].check_out_at,`night duty: morning Out goes on ${yday}'s In (${night.s} ${night.j?.error||''}; rows ${JSON.stringify(rows)})`);
// clean up
await q("DELETE FROM guard_relief"); await q("DELETE FROM duty_shifts WHERE name='QA Long Night'"); await q("DELETE FROM attendance WHERE user_id=?",[N.user.id]);
console.log(`\n${pass} passed, ${fail} failed`); await db.end();
