import { chromium } from 'playwright';
import fs from 'fs';
const dir='/home/user/CredenceHR/docs/architecture/database/diagrams';
const files=fs.readdirSync(dir).filter(f=>f.endsWith('.mmd'));
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const p=await b.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:1.5});
await p.setContent('<html><body style="margin:0;background:#fff"><div id="o"></div></body></html>');
await p.addScriptTag({path:'/tmp/claude-0/arch/mm/dist/mermaid.min.js'});
await p.evaluate(()=>mermaid.initialize({startOnLoad:false,theme:'default',er:{useMaxWidth:false,fontSize:13},flowchart:{useMaxWidth:false,htmlLabels:true},securityLevel:'loose',maxTextSize:900000,maxEdges:3000}));
for(const f of files){
  const src=fs.readFileSync(dir+'/'+f,'utf8');
  try{
    const svg=await p.evaluate(async(s)=>{const r=await mermaid.render('g'+Math.random().toString(36).slice(2),s);return r.svg;},src);
    fs.writeFileSync(dir+'/'+f.replace('.mmd','.svg'),svg);
    await p.evaluate((h)=>{document.getElementById('o').innerHTML=h;},svg);
    const el=await p.$('#o svg'); const bb=await el.boundingBox();
    await p.setViewportSize({width:Math.min(7000,Math.ceil(bb.width)+40),height:Math.min(9000,Math.ceil(bb.height)+40)});
    await p.screenshot({path:dir+'/'+f.replace('.mmd','.png'),clip:{x:0,y:0,width:Math.min(7000,bb.width+20),height:Math.min(9000,bb.height+20)}});
    console.log('OK',f,Math.round(bb.width),'x',Math.round(bb.height));
  }catch(e){console.log('ERR',f,String(e).slice(0,200));}
}
await b.close();
