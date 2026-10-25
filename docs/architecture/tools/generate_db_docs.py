import json,re,collections,os
M=json.load(open('model.json')); cols=M['cols']; fks=M['fks']; inf=M['inf']
G=json.load(open('groups.json'))
OUT='/home/user/CredenceHR/docs/architecture/database'
tab2g={t:g for g,ts in G.items() for t in ts}
AUDIT=re.compile(r'(created|updated|approved|reviewed|decided|paid|held|released|generated|processed|deleted|sent|resolved|cancelled|completed|assigned|uploaded|requested|submitted|recorded|issued|by)_?by(_user_id)?$|^(created|updated|approved|reviewed|decided|paid|held|released|generated|processed|deleted|sent|resolved|cancelled|completed|assigned|uploaded|requested|submitted|recorded|issued)_by')
SKIPCOL={'company_id','target_id'}
def base(ty): 
    m=re.match(r'([a-z]+)',ty); return m.group(1) if m else 'text'
desc={
'A. Accounts, Access & Security':'লগইন অ্যাকাউন্ট (`users`), সেশন, ডিভাইস, Module Access (কে কোন মডিউল/layer পাবে), পাসওয়ার্ড রিসেট, লগইন চেষ্টার লক। পুরো সিস্টেমের কেন্দ্র `users` টেবিল।',
'B. Company, Organisation & Employees':'কোম্পানি-গ্রুপ, বিভাগ, শাখা, প্রজেক্ট, কর্মীর মূল তথ্য (`all_employees`), শিক্ষা/অভিজ্ঞতা/পরিবার/প্রশিক্ষণ, সুপারভাইজার, বদলি, ছুটির ক্যালেন্ডার। `users` = লগইন, `all_employees` = HR-এর কর্মী রেকর্ড; দুটো `user_id` দিয়ে জোড়া।',
'C. Leave':'ছুটির ধরন, নীতি, ব্যালেন্স, বছরের সেটিং, ব্যালেন্স workflow এবং আবেদন (`leave_applications`)।',
'D. Attendance, Roster, Breaks & Tracking':'রিমোট উপস্থিতি (GPS), অফিস উপস্থিতি (ZKTeco ডিভাইস লগ), সাইট muster roll, ডিউটি রোস্টার, দেরি নীতি, বিরতি, লাইভ লোকেশন।',
'E. Payroll & Salary':'বেতন কাঠামো, pay grade, payroll মাস/ব্যাচ, payslip লাইন, bonus, advance/ঋণ, final settlement, payroll দেখার লগ।',
'F. Claims, Conveyance & Mobile Bill':'Movement claim, Conveyance Bill Claim (bill ও লাইন), অনুমোদনকারীর স্বাক্ষর, ক্লেইম নীতি, মোবাইল SIM ও বিল।',
'G. Approvals & Alerts':'অনুমোদন-চেইনের টেমপ্লেট ও ধাপ, চলমান অনুমোদন (`approval_requests`), নোটিফিকেশন (`alerts`)।',
'H. HR Operations, Onboarding & Recruitment':'HR action (পদোন্নতি, বদলি, increment…), চিঠি ও টেমপ্লেট, onboarding, নিয়োগ (job posting, প্রার্থী, ইন্টারভিউ), রিপোর্ট ও রিমাইন্ডার।',
'I. Performance, Grievance, Exit, Targets & Tasks':'পারফরম্যান্স চক্র, অভিযোগ ও শৃঙ্খলা, পদত্যাগ/ছাড়পত্র, টার্গেট, টাস্ক।',
'J. Documents & E-Signature':'Document Vault-এর ডকুমেন্ট ইভেন্ট, স্বাক্ষরকারী, স্বাক্ষর, সার্টিফিকেট (PKI), OTP।',
'K. Communication: Notices, Chat, Mail, Assistant, Feedback':'Notice, Chat (রুম, মেসেজ, reaction, pin), Credence Mail (মেইল, ফোল্ডার, গ্রুপ, ফিল্টার), Assistant, Feedback।',
'L. Assets & Vehicles':'অফিস সম্পদ, requisition, assignment, গাড়ি ও রাইড requisition।',
'M. PEPM: MPR, Jobs, Budget & Materials':'প্রকল্পের MPR নম্বর, job, entry (সারি), budget ও submission, dispatch/receive, উপকরণ ক্যাটাগরি, রেট লিস্ট।',
}
def key_cols(t,extra_edges):
    cs=cols[t]; out=[]; fkc={c for c,_,_ in fks.get(t,[])}|{c for c,_ in inf.get(t,[])}
    for c in cs:
        n=c['name']; tags=[]
        if c['key']=='PRI': tags.append('PK')
        if n in fkc and n not in SKIPCOL: tags.append('FK')
        if n=='company_id': tags=[]
        out.append((n,base(c['type']),tags,c['key']))
    pri=[x for x in out if 'PK' in x[2]]; fk=[x for x in out if 'FK' in x[2] and 'PK' not in x[2] and not AUDIT.search(x[0])]
    rest=[x for x in out if not x[2] and not re.search(r'(created|updated)_at$|^updated|^created|password|hash|blob|token|secret',x[0]) and AUDIT.search(x[0]) is None]
    sel=pri+fk+rest[:max(0,7-len(pri)-len(fk))] if len(pri)+len(fk)<7 else pri+fk
    return sel[:12]
def mm_id(t): return t
diagrams={}
for g,ts in G.items():
    tset=set(ts); edges=[]; ext=set(); seen=set()
    for t in ts:
        for c,rt,rc in fks.get(t,[]):
            if c in SKIPCOL or (rt in ('users',) and AUDIT.search(c)): continue
            if rt==t: edges.append((rt,t,c,'self'));continue
            edges.append((rt,t,c,'fk')); 
            if rt not in tset: ext.add(rt)
        for c,rt in inf.get(t,[]):
            if c in SKIPCOL or (t,c) in seen: continue
            if rt in ('users',) and AUDIT.search(c): continue
            if any(e[1]==t and e[2]==c for e in edges): continue
            edges.append((rt,t,c,'logical'))
            if rt not in tset: ext.add(rt)
    L=['erDiagram']
    for t in ts:
        L.append(f'  {t} {{')
        for n,ty,tags,key in key_cols(t,edges):
            L.append(f'    {ty} {n}'+(' '+','.join(tags) if tags else ''))
        L.append('  }')
    for e in sorted(ext):
        L.append(f'  {e} {{'); L.append(f'    int id PK'); L.append('  }')
    for rt,ch,c,kind in edges:
        op='||--o{' if kind!='logical' else '||..o{'
        L.append(f'  {rt} {op} {ch} : "{c}"')
    diagrams[g]='\n'.join(L)
    fn=re.sub(r'[^a-z0-9]+','-',g.lower()).strip('-')
    open(f'{OUT}/diagrams/{fn}.mmd','w').write(diagrams[g])
    diagrams[g+'_fn']=fn
# data dictionary
D=['# Data Dictionary — CredenceHR ডাটাবেস (সব টেবিল ও কলাম)','',f'> স্বয়ংক্রিয়ভাবে তৈরি: চালু সার্ভারের `information_schema` থেকে (MariaDB, ২১২টি টেবিল, {sum(len(c) for c in cols.values())}টি কলাম)।','> `PK` = প্রাইমারি কী, `FK` = ঘোষিত foreign key (→ কোন টেবিল), `logical` = foreign key ঘোষণা নেই কিন্তু নাম দেখে যে টেবিলের সাথে সম্পর্ক বোঝা যায়।','']
fkmap={t:{c:(rt,rc) for c,rt,rc in v} for t,v in fks.items()}
infmap={t:dict(v) for t,v in inf.items()}
idx=collections.defaultdict(list)
for l in open('idx.tsv').read().splitlines():
    t,i,nu,cs=l.split('\t'); idx[t].append((i,nu=='0',cs))
rows={l.split('\t')[0]:l.split('\t')[1] for l in open('tabs.tsv').read().splitlines()}
for g,ts in G.items():
    D+= [f'## {g}','',desc[g],'']
    for t in sorted(ts):
        D+=[f'### `{t}`','', '| কলাম | ধরন | Null | মান/কী | সম্পর্ক |','|---|---|---|---|---|']
        for c in cols[t]:
            n=c['name']; rel=''
            if n in fkmap.get(t,{}): rt,rc=fkmap[t][n]; rel=f'FK → `{rt}.{rc}`'
            elif n in infmap.get(t,{}) and n not in SKIPCOL: rel=f'logical → `{infmap[t][n]}`'
            elif n=='company_id': rel='কোম্পানি-মালিকানা (code-level scope)'
            k='PK' if c['key']=='PRI' else ('UNI' if c['key']=='UNI' else '')
            D.append(f"| `{n}` | {c['type']} | {'হ্যাঁ' if c['null'] else 'না'} | {k} {('default '+c['default']) if c['default'] not in ('NULL','') else ''} {c['extra']} | {rel} |".replace('  ',' '))
        us=[f'`{i}`({cs})' for i,u,cs in idx[t] if i!='PRIMARY' and u]
        if us: D+=['','Unique: '+', '.join(us)]
        D.append('')
open(f'{OUT}/data-dictionary.md','w').write('\n'.join(D))
# overview diagram (module level)
modedges=collections.Counter()
for t,v in fks.items():
    for c,rt,rc in v:
        a,b=tab2g[rt],tab2g[t]
        if a!=b: modedges[(a,b)]+=1
for t,v in inf.items():
    for c,rt in v:
        if c in SKIPCOL: continue
        a,b=tab2g[rt],tab2g[t]
        if a!=b and (a,b) not in modedges: modedges[(a,b)]+=0
def short(g): return g.split('. ')[0]+'_'+re.sub(r'[^A-Za-z]','',g.split('. ')[1].split(',')[0].split('&')[0])[:14]
O=['flowchart LR']
for g in G: O.append(f'  {g[0]}["{g}<br/>({len(G[g])} টেবিল)"]')
for (a,b),n in sorted(modedges.items()):
    if n>0: O.append(f'  {a[0]} -->|{n} FK| {b[0]}')
open(f'{OUT}/diagrams/00-module-map.mmd','w').write('\n'.join(O))
json.dump({g:diagrams[g+'_fn'] for g in G},open('fnmap.json','w'))
print('ok',len(G)); print(sum(len(v) for v in G.values()))
for g in G: print(g, len(diagrams[g].splitlines()))
