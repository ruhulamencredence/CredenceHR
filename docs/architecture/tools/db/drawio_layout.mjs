const { Graphviz } = await import(process.env.GV_INDEX);
import fs from 'fs';
const gv=await Graphviz.load();
const jobs=JSON.parse(fs.readFileSync('jobs.json','utf8'));
const out={};
for (const [name,j] of Object.entries(jobs)) { try { const r=gv.layout(j.dot,'json',j.engine); out[name]=JSON.parse(r); } catch(e){ console.log('ERR',name,String(e.message||e).slice(0,120)); } }
fs.writeFileSync('layouts.json',JSON.stringify(out)); console.log(Object.keys(out).length,'layouts');
