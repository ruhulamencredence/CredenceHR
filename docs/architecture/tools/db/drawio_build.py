import json,re,html,collections,subprocess,sys
M=json.load(open('model.json')); cols=M['cols']; fks=M['fks']; inf=M['inf']; G=json.load(open('groups.json'))
tab2g={t:g for g,ts in G.items() for t in ts}
SKIP={'company_id','target_id'}
COL={'A':'#fde68a','B':'#bfdbfe','C':'#bbf7d0','D':'#fbcfe8','E':'#fed7aa','F':'#ddd6fe','G':'#fecaca','H':'#a7f3d0','I':'#fef08a','J':'#c7d2fe','K':'#e9d5ff','L':'#d9f99d','M':'#bae6fd'}
AUD=re.compile(r'(_by$|_by_user_id$)')
def base(ty):
    m=re.match(r'([a-z]+)',ty); return m.group(1) if m else ''
def rows_of(t,full=False):
    fkset={c for c,_,_ in fks.get(t,[])}|{c for c,_ in inf.get(t,[]) if c not in SKIP}
    rows=[]
    for c in cols[t]:
        n=c['name']; tag='PK' if c['key']=='PRI' else ('FK' if n in fkset and n not in SKIP else '')
        rows.append((n,base(c['type']),tag))
    if full: return rows,0
    sel=[r for r in rows if r[2]]
    rest=[r for r in rows if not r[2] and not re.search(r'(created|updated|deleted)_at$|password|hash|token|secret|_data$|blob',r[0]) and not AUD.search(r[0]) and r[0]!='company_id'][:max(0,6-len(sel))]
    shown=sel+rest
    return shown,len(rows)-len(shown)
def edges_of(tset):
    E=[];seen=set()
    for t in tset:
        for c,rt,rc in fks.get(t,[]):
            if rt==t or (t,c) in seen: continue
            seen.add((t,c)); E.append((rt,t,c,False))
        for c,rt in inf.get(t,[]):
            if c in SKIP or (t,c) in seen or any(x[0]==c for x in fks.get(t,[])): continue
            seen.add((t,c)); E.append((rt,t,c,True))
    return E
def node_dot(t,stub=False):
    if stub: rs=[('id','int','PK')];hid=0
    else: rs,hid=rows_of(t)
    h=26+18*(len(rs)+(1 if hid>0 else 0))
    return f'  {t} [shape=box, width={220/72:.3f}, height={h/72:.3f}, fixedsize=true, label=""];'
jobs={}
# full (fdp, clusters)
L=['digraph F { graph [K=3.2, maxiter=5000, compound=true, splines=false, pad=0.4]; node [shape=box,fixedsize=true];']
for g,ts in G.items():
    L.append(f'  subgraph cluster_{g[0]} {{ label="{g}"; fontsize=26; style=rounded;')
    for t in ts: L.append(node_dot(t))
    L.append('  }')
for rt,t,c,lg in edges_of(list(tab2g)): L.append(f'  {rt} -> {t};')
L.append('}'); jobs['full']={'dot':'\n'.join(L),'engine':'fdp'}
# modules
for g,ts in G.items():
    tset=set(ts); E=edges_of(ts); ext=set()
    for rt,t,c,lg in E:
        if rt not in tset: ext.add(rt)
    # edges where child is external but parent inside? skip (those appear on the child's module page)
    L=['digraph M { graph [rankdir=LR, nodesep=0.3, ranksep=1.0, pad=0.3]; node [shape=box,fixedsize=true];']
    for t in ts: L.append(node_dot(t))
    for t in sorted(ext): L.append(node_dot(t,True))
    for rt,t,c,lg in E:
        if t in tset: L.append(f'  {rt} -> {t};')
    L.append('}'); jobs[g]={'dot':'\n'.join(L),'engine':'dot'}
json.dump(jobs,open('jobs.json','w'))
