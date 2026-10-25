// full.dot -> full.svg (fdp, মডিউল-বাক্স একে অপরের উপর পড়ে না)
const { Graphviz } = await import(process.env.GV_INDEX);
import fs from 'fs';
const gv = await Graphviz.load();
const dot = fs.readFileSync('full.dot', 'utf8');
const svg = gv.layout(dot.replace('rankdir=LR', 'K=3.2, maxiter=5000, start=7'), 'svg', 'fdp');
fs.writeFileSync('full.svg', svg);
console.log('full.svg', svg.match(/<svg[^>]*width="([^"]+)" height="([^"]+)"/)?.slice(1));
