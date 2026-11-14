import fs from 'fs';
const a=JSON.parse(fs.readFileSync(process.argv[2])), b=JSON.parse(fs.readFileSync(process.argv[3]));
const diffs=[];
const walk=(x,y,path)=>{
  if (JSON.stringify(x)===JSON.stringify(y)) return;
  if (x&&y&&typeof x==='object'&&typeof y==='object'&&!Array.isArray(x)===!Array.isArray(y)) {
    const keys=new Set([...Object.keys(x),...Object.keys(y)]);
    for (const k of keys) walk(x[k],y[k],path+'.'+k);
    return;
  }
  diffs.push(`${path}: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`);
};
for (const k of Object.keys(a)) walk(a[k],b[k],k);
console.log(diffs.length+' differences'); for (const d of diffs) console.log('  '+d);
