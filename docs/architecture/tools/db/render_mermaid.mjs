const { chromium } = (await import(process.env.PLAYWRIGHT || 'playwright')).default ?? await import(process.env.PLAYWRIGHT || 'playwright');
import fs from 'fs';
const dir=process.env.DOCS_DB_OUT+'/diagrams';
const files=fs.readdirSync(dir).filter(f=>f.endsWith('.mmd'));
const b=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
const p=await b.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:1.5});
await p.setContent('<html><body style="margin:0;background:#fff"><div id="o"></div></body></html>');
await p.addScriptTag({path:process.env.MERMAID_JS});
await p.evaluate(()=>mermaid.initialize({startOnLoad:false,theme:'default',er:{useMaxWidth:false,fontSize:13},flowchart:{useMaxWidth:false,htmlLabels:true},securityLevel:'loose',maxTextSize:900000,maxEdges:3000}));
for(const f of files){
  const src=fs.readFileSync(dir+'/'+f,'utf8');
  try{
    const svg=await p.evaluate(async([s,id])=>{const r=await mermaid.render(id,s);return r.svg;},[src,'m'+f.replace(/[^a-z0-9]/gi,'')]);
    fs.writeFileSync(dir+'/'+f.replace('.mmd','.svg'),svg);
    await p.evaluate((h)=>{document.getElementById('o').innerHTML=h;},svg);
    const el=await p.$('#o svg'); const bb=await el.boundingBox();
    await p.setViewportSize({width:Math.min(7000,Math.ceil(bb.width)+40),height:Math.min(9000,Math.ceil(bb.height)+40)});
    await p.screenshot({path:dir+'/'+f.replace('.mmd','.png'),clip:{x:0,y:0,width:Math.min(7000,bb.width+20),height:Math.min(9000,bb.height+20)}});
    console.log('OK',f,Math.round(bb.width),'x',Math.round(bb.height));
  }catch(e){console.log('ERR',f,String(e).slice(0,200));process.exitCode=1;}
}
await b.close();
