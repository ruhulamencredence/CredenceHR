import { chromium } from 'playwright';
import fs from 'fs';
const BASE='http://localhost:3100';
const src=fs.readFileSync('/home/user/CredenceHR/src/lib/adminUrl.ts','utf8');
const tabs=[...src.match(/ADMIN_TAB_KEYS = new Set<string>\(\[(.*?)\]\)/s)[1].matchAll(/"([a-z_]+)"/g)].map(m=>m[1]);
const selfSrc=fs.readFileSync('/home/user/CredenceHR/src/lib/selfUrl.ts','utf8');
const slugs=[...selfSrc.matchAll(/^\s+\w+: '([a-z-]+)',?$/gm)].map(m=>m[1]);
async function api(t,m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'content-type':'application/json',...(t?{authorization:`Bearer ${t}`}:{})},body:b?JSON.stringify(b):undefined});return r.json().catch(()=>null)}
const login=async(i,p)=>api(null,'POST','/api/auth/login',{identifier:i,password:p});
const SA=await login('admin@credence.test','AdminPass123'); const BOB=await login('bob.rv@credence.test','Pass12345');
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const out=[];
async function run(label,auth,urls,vp){
  const ctx=await b.newContext({viewport:vp});
  await ctx.addInitScript(([t,u])=>{localStorage.setItem('mpr_token',t);localStorage.setItem('mpr_user',JSON.stringify(u));localStorage.setItem(`credence_webpush_snooze_${u.id}`,String(Date.now()+9e9));},[auth.token,auth.user]);
  const page=await ctx.newPage(); let errs=[],bad=[];
  page.on('pageerror',e=>errs.push(e.message.slice(0,160)));
  page.on('console',m=>{if(m.type()==='error'&&!/ERR_TUNNEL|Failed to load resource: net::|tiles|carto|fonts/i.test(m.text()))errs.push('console: '+m.text().slice(0,140));});
  page.on('response',r=>{const u=r.url();if(u.startsWith(BASE+'/api')&&r.status()>=400)bad.push(`${r.status()} ${u.replace(BASE,'').slice(0,70)}`);});
  for(const u of urls){errs=[];bad=[];const t0=Date.now();
    try{await page.goto(BASE+u,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(2200);}catch(e){errs.push('nav: '+e.message.slice(0,100));}
    const ov=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth).catch(()=>0);
    const body=await page.evaluate(()=>document.body.innerText.slice(0,200).replace(/\s+/g,' ')).catch(()=> '');
    out.push({label,url:u,ms:Date.now()-t0,errors:[...new Set(errs)],api4xx5xx:[...new Set(bad)],overflowPx:ov>2?ov:0,blank:body.trim().length<20});
  }
  await ctx.close();
}
const adminUrls=['/',...tabs.map(t=>'/admin/'+t.replace(/_/g,'-'))];
await run('superadmin-desktop',SA,adminUrls,{width:1440,height:900});
await run('superadmin-self-desktop',SA,slugs.map(s=>'/self/'+s),{width:1440,height:900});
await run('employee-desktop',BOB,['/',...slugs.map(s=>'/self/'+s)],{width:1440,height:900});
await run('employee-mobile',BOB,['/',...slugs.slice(0,8).map(s=>'/self/'+s)],{width:390,height:844});
await run('superadmin-mobile',SA,['/','/admin/employees','/admin/payroll','/admin/leave-applications','/admin/measurement-sheet','/admin/users'],{width:390,height:844});
await b.close();
fs.writeFileSync('/tmp/claude-0/review/ui-smoke.json',JSON.stringify(out,null,1));
const bad=out.filter(o=>o.errors.length||o.overflowPx||o.blank);
console.log('pages',out.length,'with problems',bad.length); for(const o of bad) console.log(o.label,o.url,'| err:',o.errors.join(' ; ').slice(0,200),'| overflow',o.overflowPx,'| blank',o.blank);
const api4=out.filter(o=>o.api4xx5xx.length); console.log('api 4xx/5xx on',api4.length,'pages'); for(const o of api4.slice(0,40)) console.log(o.label,o.url,o.api4xx5xx.join(', '));
