import json,re,html,sys
exec(open('build_drawio.py').read().split("jobs={}")[0])
LAY=json.load(open('layouts.json'))
S=1.0  # pt -> px
PAL=['#e6194b','#3cb44b','#4363d8','#f58231','#911eb4','#0891b2','#d946ef','#65a30d','#b45309','#0f766e','#be123c','#1d4ed8','#7c2d12','#4d7c0f','#6d28d9','#c2410c','#047857','#a21caf','#0369a1','#a16207','#15803d','#9f1239','#4338ca','#b91c1c']
def ecol(t): return PAL[sum(ord(ch)*(i+7) for i,ch in enumerate(t))%len(PAL)]
def esc(x): return html.escape(str(x),quote=True)
cid=[1]
def nid(): cid[0]+=1; return f'c{cid[0]}'
def table_cells(t,x,y,w,stub,out,ids,full=False):
    rs,hid=([('id','int','PK')],0) if stub else rows_of(t)
    n=len(rs)+(1 if hid>0 else 0); h=26+18*n
    tid=nid(); ids[t]=tid
    color=COL[tab2g[t][0]] if t in tab2g else '#e5e7eb'
    style=f"swimlane;fontStyle=1;childLayout=stackLayout;horizontal=1;startSize=26;horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=0;marginBottom=0;html=1;fillColor={color};strokeColor=#7c3aed;fontSize=12;"+("dashed=1;opacity=70;" if stub else "")
    out.append(f'<mxCell id="{tid}" value="{esc(t)}" style="{style}" vertex="1" parent="1"><mxGeometry x="{x:.0f}" y="{y:.0f}" width="{w}" height="{h}" as="geometry"/></mxCell>')
    for r,(nm,ty,tag) in enumerate(rs):
        colr='#b91c1c' if tag=='PK' else ('#1d4ed8' if tag=='FK' else '#111827')
        val=f'<font color="{colr}">{esc(nm)}</font> <font color="#6b7280">: {esc(ty)}</font>'+(f' <b><font color="{colr}">{tag}</font></b>' if tag else '')
        out.append(f'<mxCell id="{nid()}" value="{esc(val)}" style="text;strokeColor=none;fillColor=#ffffff;align=left;verticalAlign=middle;spacingLeft=6;spacingRight=4;overflow=hidden;rotatable=0;html=1;fontSize=11;" vertex="1" parent="{tid}"><mxGeometry y="{26+18*r}" width="{w}" height="18" as="geometry"/></mxCell>')
    if hid>0:
        out.append(f'<mxCell id="{nid()}" value="… +{hid} কলাম (data-dictionary.md-তে)" style="text;strokeColor=none;fillColor=#ffffff;align=left;verticalAlign=middle;spacingLeft=6;overflow=hidden;rotatable=0;html=1;fontSize=10;fontColor=#9ca3af;" vertex="1" parent="{tid}"><mxGeometry y="{26+18*len(rs)}" width="{w}" height="18" as="geometry"/></mxCell>')
def page(name,lay,tset,extset,edges):
    out=[];ids={}
    bb=[float(v) for v in lay['bb'].split(',')]; H=bb[3]
    # clusters
    for o in lay.get('objects',[]):
        if o['name'].startswith('cluster_'):
            x0,y0,x1,y1=[float(v) for v in o['bb'].split(',')]
            k=o['name'][-1]; label=o.get('label','')
            out.append(f'<mxCell id="{nid()}" value="{esc(label)}" style="rounded=1;whiteSpace=wrap;html=1;fillColor={COL[k]};opacity=30;strokeColor={COL[k]};verticalAlign=top;fontStyle=1;fontSize=22;arcSize=3;" vertex="1" parent="1"><mxGeometry x="{x0*S:.0f}" y="{(H-y1)*S:.0f}" width="{(x1-x0)*S:.0f}" height="{(y1-y0)*S:.0f}" as="geometry"/></mxCell>')
    for o in lay['objects']:
        if 'pos' in o and not o['name'].startswith('cluster_'):
            t=o['name']; cx,cy=[float(v) for v in o['pos'].split(',')]
            stub=t in extset
            rs=([('id','int','PK')],0) if stub else rows_of(t)
            n=len(rs[0])+(1 if rs[1]>0 else 0); h=26+18*n; w=220
            table_cells(t,cx*S-w/2,(H-cy)*S-h/2,w,stub,out,ids)
    for rt,t,c,lg in edges:
        if rt in ids and t in ids:
            st="edgeStyle=none;html=1;endArrow=ERmany;endFill=0;startArrow=ERone;startFill=0;strokeColor="+ecol(rt)+";strokeWidth=1.6;fontSize=9;fontColor="+ecol(rt)+";"+("dashed=1;" if lg else "")
            out.append(f'<mxCell id="{nid()}" value="{esc(c)}" style="{st}" edge="1" parent="1" source="{ids[rt]}" target="{ids[t]}"><mxGeometry relative="1" as="geometry"/></mxCell>')
    return f'<diagram name="{esc(name)}" id="p{abs(hash(name))%10**8}"><mxGraphModel dx="1400" dy="900" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="827" pageHeight="1169" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>{"".join(out)}</root></mxGraphModel></diagram>'
pages=[]
allt=set(tab2g)
# fdp full layout: cluster names lack label in json? supply
for o in LAY['full']['objects']:
    if o['name'].startswith('cluster_'):
        k=o['name'][-1]; g=[g for g in G if g[0]==k][0]; o['label']=f'{g} ({len(G[g])} টেবিল)'
pages.append(page('সম্পূর্ণ ডাটাবেস (২১২ টেবিল)',LAY['full'],allt,set(),edges_of(sorted(allt))))
for g,ts in G.items():
    tset=set(ts); E=[e for e in edges_of(ts)]; ext={rt for rt,t,c,lg in E if rt not in tset}
    # remove clusters in module layouts (none)
    pages.append(page(g,LAY[g],tset,ext,[e for e in E if e[1] in tset]))
xml='<?xml version="1.0" encoding="UTF-8"?><mxfile host="app.diagrams.net" agent="CredenceHR docs generator" version="24.0.0">'+''.join(pages)+'</mxfile>'
open('/home/user/CredenceHR/docs/architecture/database/credencehr-database.drawio','w',encoding='utf8').write(xml)
print(len(xml), len(pages),'pages', xml.count('<mxCell'),'cells')
