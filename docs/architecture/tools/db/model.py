# *.tsv -> model.json, আর groups.json হালনাগাদ (নতুন টেবিল নামের মিল দেখে মডিউলে বসে, মোছা টেবিল বাদ)
import json,collections,os,sys
cols=collections.defaultdict(list)
for l in open('cols.tsv').read().splitlines():
    if not l: continue
    t,c,ty,nul,key,df,ex,pos=l.split('\t'); cols[t].append(dict(name=c,type=ty,null=nul=='YES',key=key,default=df,extra=ex))
fks=collections.defaultdict(list)
for l in open('fks.tsv').read().splitlines():
    if not l: continue
    t,c,rt,rc,cn=l.split('\t'); fks[t].append((c,rt,rc))
tabs=set(cols)
inf=collections.defaultdict(list); declared={(t,c) for t in fks for c,_,_ in fks[t]}
special={'user':'users','employee':'all_employees','approver':'users','project':'projects','branch':'branches','department':'departments','company':'companies','job':'jobs','mpr':'mpr_numbers','room':'chat_rooms','sim':'mobile_sims','candidate':'job_candidates','posting':'job_postings','entry':'entries','shift':'duty_shifts','category':'leave_categories'}
for t in cols:
    for c in cols[t]:
        n=c['name']
        if (t,n) in declared or not n.endswith('_id') or n=='id': continue
        base=n[:-3]
        cands=[base,base+'s',base+'es',base[:-1]+'ies' if base.endswith('y') else '']
        tgt=None
        for x in cands:
            if x in tabs and x!=t: tgt=x;break
        if not tgt and base in special and special[base] in tabs and special[base]!=t: tgt=special[base]
        if tgt: inf[t].append((n,tgt))
json.dump({'cols':cols,'fks':fks,'inf':inf},open('model.json','w'))
gfile=sys.argv[1]
G=json.load(open(gfile))
known={t:g for g,ts in G.items() for t in ts}
for g in G: G[g]=[t for t in G[g] if t in tabs]
def guess(t):
    # ১) যে টেবিলের দিকে FK যায় তার মডিউল  ২) নামের সবচেয়ে লম্বা মিল
    for c,rt,rc in fks.get(t,[]):
        if rt in known and rt not in ('users','all_employees','companies'): return known[rt]
    best,bl=None,0
    for k,g in known.items():
        n=len(os.path.commonprefix([k,t]))
        if n>bl: best,bl=g,n
    return best if bl>=3 else list(G)[0]
added=[]
for t in sorted(tabs-set(known)):
    g=guess(t); G[g].append(t); known[t]=g; added.append(f'{t} -> {g}')
for g in G: G[g].sort()
json.dump(G,open(gfile,'w'),ensure_ascii=False,indent=1)
json.dump(G,open('groups.json','w'),ensure_ascii=False)
print('tables',len(tabs),'fks',sum(len(v) for v in fks.values()),'logical',sum(len(v) for v in inf.values()))
for a in added: print('নতুন টেবিল মডিউলে বসানো হল:',a)
