import json,re,collections,html
M=json.load(open('model.json')); cols=M['cols']; fks=M['fks']; inf=M['inf']; G=json.load(open('groups.json'))
tab2g={t:g for g,ts in G.items() for t in ts}
SKIP={'company_id','target_id'}
COLORS={'A':'#fde68a','B':'#bfdbfe','C':'#bbf7d0','D':'#fbcfe8','E':'#fed7aa','F':'#ddd6fe','G':'#fecaca','H':'#a7f3d0','I':'#fef08a','J':'#c7d2fe','K':'#e9d5ff','L':'#d9f99d','M':'#bae6fd'}
AUD=re.compile(r'(_by$|_by_user_id$)')
def base(ty):
    m=re.match(r'([a-z]+)',ty); return m.group(1) if m else ''
def esc(x): return html.escape(str(x),quote=True)
out=['digraph ER {','  graph [rankdir=LR, compound=true, newrank=true, splines=true, nodesep=0.25, ranksep=0.9, fontname="Helvetica", fontsize=22, pad=0.4, concentrate=false];','  node [shape=plain, fontname="Helvetica", fontsize=10];','  edge [color="#6b6b80", arrowsize=0.6, penwidth=0.8];']
fkcols={t:{c for c,_,_ in fks.get(t,[])} for t in cols}
for g,ts in G.items():
    k=g[0]; col=COLORS[k]
    out.append(f'  subgraph cluster_{k} {{ label=<<B>{esc(g)}</B> ({len(ts)} tables)>; style="rounded,filled"; fillcolor="{col}33"; color="{col}"; penwidth=2; fontsize=26;')
    for t in sorted(ts):
        rows=[]
        fkset=fkcols[t]|{c for c,_ in inf.get(t,[]) if c not in SKIP}
        for c in cols[t]:
            n=c['name']; tag=''
            if c['key']=='PRI': tag='PK'
            elif n in fkset and n not in SKIP: tag='FK'
            rows.append((n,base(c['type']),tag))
        sel=[r for r in rows if r[2]]
        rest=[r for r in rows if not r[2] and not re.search(r'(created|updated|deleted)_at$|password|hash|token|secret|_data$|blob',r[0]) and not AUD.search(r[0]) and r[0]!='company_id'][:max(0,6-len(sel))]
        shown=sel+rest
        hidden=len(rows)-len(shown)
        cell=''.join(f'<TR><TD ALIGN="LEFT" PORT="{esc(n)}"><FONT COLOR="{"#b91c1c" if tg=="PK" else ("#1d4ed8" if tg=="FK" else "#111827")}">{esc(n)}</FONT></TD><TD ALIGN="LEFT"><FONT COLOR="#6b7280">{esc(ty)}</FONT></TD><TD><FONT COLOR="#6b7280">{tg or "&nbsp;"}</FONT></TD></TR>' for n,ty,tg in shown)
        more=f'<TR><TD COLSPAN="3" ALIGN="LEFT"><FONT COLOR="#9ca3af" POINT-SIZE="9">… +{hidden} কলাম</FONT></TD></TR>' if hidden>0 else ''
        out.append(f'    {t} [label=<<TABLE BORDER="1" CELLBORDER="0" CELLSPACING="0" CELLPADDING="3" BGCOLOR="white" COLOR="#7c3aed"><TR><TD COLSPAN="3" BGCOLOR="{col}"><B>{esc(t)}</B></TD></TR>{cell}{more}</TABLE>>];')
    out.append('  }')
seen=set(); n=0
for t,v in fks.items():
    for c,rt,rc in v:
        if rt==t: continue
        key=(rt,t,c); 
        if key in seen: continue
        seen.add(key); out.append(f'  {rt} -> {t} [arrowhead=crow, arrowtail=none, dir=both, arrowtail=tee, tooltip="{c}"];'); n+=1
for t,v in inf.items():
    for c,rt in v:
        if c in SKIP: continue
        if (rt,t,c) in seen or any(x[0]==c for x in fks.get(t,[])): continue
        seen.add((rt,t,c)); out.append(f'  {rt} -> {t} [style=dashed, color="#9ca3af", arrowhead=crow, dir=both, arrowtail=tee, tooltip="{c} (logical)"];'); n+=1
out.append('}')
open('full.dot','w').write('\n'.join(out)); print('edges',n,'nodes',sum(len(v) for v in G.values()))
