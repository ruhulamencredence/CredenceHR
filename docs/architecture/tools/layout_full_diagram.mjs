import { Graphviz } from '/tmp/claude-0/arch/gv/dist/index.js';
import fs from 'fs';
const gv=await Graphviz.load();
const dot=fs.readFileSync('/tmp/claude-0/arch/full.dot','utf8');
for (const k of [3.2]) { const t0=Date.now(); const svg=gv.layout(dot.replace('rankdir=LR',`K=${k}, maxiter=5000`),'svg','fdp'); fs.writeFileSync(`/tmp/claude-0/arch/full-fdp-k${k}.svg`,svg); console.log(k,Date.now()-t0,'ms',svg.match(/<svg[^>]*width="([^"]+)" height="([^"]+)"/)?.slice(1)); }
