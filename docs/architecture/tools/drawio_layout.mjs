import { Graphviz } from '/tmp/claude-0/arch/gv/dist/index.js';
import fs from 'fs';
const gv=await Graphviz.load();
const jobs=JSON.parse(fs.readFileSync('/tmp/claude-0/arch/jobs.json','utf8'));
const out={};
for (const [name,j] of Object.entries(jobs)) { try { const r=gv.layout(j.dot,'json',j.engine); out[name]=JSON.parse(r); } catch(e){ console.log('ERR',name,String(e.message||e).slice(0,120)); } }
fs.writeFileSync('/tmp/claude-0/arch/layouts.json',JSON.stringify(out)); console.log(Object.keys(out).length,'layouts');
