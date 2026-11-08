# database/README.md ও ../README.md-এর সংখ্যা ও মডিউল অংশ model.json থেকে লেখে
# (শুধু <!-- AUTO:... --> ও <!--n:...--> চিহ্নের ভেতরে; বাকি লেখা হাতে)
import json,re,os,collections
OUT=os.environ['DOCS_DB_OUT']; NOTES=os.environ['DB_NOTES']
M=json.load(open('model.json')); cols=M['cols']; fks=M['fks']; G=json.load(open('groups.json')); fn=json.load(open('fnmap.json'))
notes=json.load(open(NOTES))
def bn(n): return f'{n:,}'.translate(str.maketrans('0123456789','০১২৩৪৫৬৭৮৯'))
rules=dict(l.split('\t') for l in open('rules.tsv').read().splitlines() if l)
nfk=sum(len(v) for v in fks.values())
ncol=sum(len(v) for v in cols.values())
comp=sum(1 for t in cols if any(c['name']=='company_id' for c in cols[t]))
blob=sum(1 for t in cols for c in cols[t] if 'blob' in c['type'])
top=sorted(cols,key=lambda t:-len(cols[t]))[:3]
rtxt=', '.join(f'{k} {bn(int(v))}' for k,v in sorted(rules.items(),key=lambda x:-int(x[1])))
stats=f"""| বিষয় | সংখ্যা |
|---|---|
| টেবিল | **{bn(len(cols))}** |
| কলাম | **{bn(ncol)}** |
| ঘোষিত Foreign Key | **{bn(nfk)}** (ON DELETE: {rtxt}) |
| `company_id` আছে এমন টেবিল (multi-company) | {bn(comp)} |
| ফাইল/ছবি ডাটাবেসেই রাখা হয় (BLOB কলাম) | {bn(blob)}টি কলাম (ডকুমেন্ট, ছবি, স্বাক্ষর, মেইল সংযুক্তি, সার্টিফিকেট) |
| সবচেয়ে বেশি কলামের টেবিল | {', '.join(f'`{t}` ({bn(len(cols[t]))})' for t in top)} |"""
mods=[]
for g,ts in G.items():
    f=fn[g]
    mods.append(f"""### {g} ({len(ts)}টি টেবিল)

{notes.get(g,'')}

![{g}](diagrams/{f}.png)

[বড় SVG](diagrams/{f}.svg) · [Mermaid সোর্স](diagrams/{f}.mmd)

<details><summary>এই মডিউলের সব টেবিলের নাম</summary>

{', '.join(f'`{t}`' for t in sorted(ts))}

</details>""")
nums={'tables':bn(len(cols)),'fks':bn(nfk),'columns':bn(ncol)}
def fill(path,blocks):
    s=open(path,encoding='utf8').read(); o=s
    for k,v in blocks.items():
        s=re.sub(rf'(<!-- AUTO:{k} -->\n).*?(\n<!-- /AUTO:{k} -->)',lambda m:m.group(1)+v+m.group(2),s,flags=re.S)
    s=re.sub(r'<!--n:(\w+)-->.*?<!--/n-->',lambda m:f'<!--n:{m.group(1)}-->{nums[m.group(1)]}<!--/n-->',s)
    if s!=o: open(path,'w',encoding='utf8').write(s); print('updated',path)
fill(OUT+'/README.md',{'stats':stats,'modules':'\n\n'.join(mods)})
fill(OUT+'/../README.md',{})
