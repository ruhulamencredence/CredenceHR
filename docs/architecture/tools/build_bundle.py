#!/usr/bin/env python3
"""সব পেজ একটাই HTML ফাইলে (ট্যাব বদলালে ফাইল হারায় না; ছবি ও Mermaid ভেতরেই থাকে)।
চালান: python3 tools/build_bundle.py   (দরকার: pip install markdown)"""
import os, re, base64, mimetypes, markdown, importlib.util
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
src = open(os.path.join(ROOT, 'tools/build_html.py'), encoding='utf-8').read()
PAGES = eval(re.search(r'PAGES = (\[.*?\n\])', src, re.S).group(1))
CSS = re.search(r'CSS = """(.*?)"""', src, re.S).group(1) + "\nsection.pg{display:none}section.pg.on{display:block}"
known = {os.path.normpath(os.path.join(ROOT, a)): i for i, (a, b, t) in enumerate(PAGES)}
def img(m, base):
    p = os.path.normpath(os.path.join(ROOT, base, m.group(1)))
    if p.endswith('.png') and os.path.isfile(p[:-4]+'.svg'): p = p[:-4]+'.svg'
    if not os.path.isfile(p): return m.group(0)
    mt = mimetypes.guess_type(p)[0] or 'application/octet-stream'
    return 'src="data:%s;base64,%s"' % (mt, base64.b64encode(open(p, 'rb').read()).decode())
secs = []
for i, (s, d, title) in enumerate(PAGES):
    md = open(os.path.join(ROOT, s), encoding='utf-8').read()
    html = markdown.markdown(md, extensions=['tables', 'fenced_code', 'toc'])
    html = re.sub(r'<pre><code class="language-mermaid">(.*?)</code></pre>', lambda m: '<pre class="mermaid">' + m.group(1) + '</pre>', html, flags=re.S)
    base = os.path.dirname(s)
    def fix(m):
        t = os.path.normpath(os.path.join(ROOT, base, m.group(1) + '.md'))
        return 'href="#p%d" data-go="%d"' % (known[t], known[t]) if t in known else m.group(0)
    html = re.sub(r'href="([^"#:]+)\.md(#[^"]*)?"', fix, html)
    html = re.sub(r'src="(?!data:|http)([^"]+\.(?:png|svg|jpg))"', lambda m: img(m, base), html)
    html = re.sub(r'(id="|href="#)(?!p\d+")', lambda m: m.group(0), html)
    secs.append('<section class="pg" id="p%d"><main>%s</main></section>' % (i, html))
nav = ''.join('<a href="#p%d" data-go="%d">%s</a>' % (i, i, t) for i, (_, _, t) in enumerate(PAGES))
js = mermaid = open(os.path.join(ROOT, 'assets/mermaid.min.js'), encoding='utf-8').read().replace('</script', '<\\/script')
boot = """mermaid.initialize({startOnLoad:false,securityLevel:"loose",theme:"default",flowchart:{useMaxWidth:true},maxTextSize:900000});
var done={};
function show(i){document.querySelectorAll('section.pg').forEach(function(s){s.classList.toggle('on',s.id==='p'+i)});
document.querySelectorAll('nav a').forEach(function(a){a.classList.toggle('on',a.dataset.go==i)});window.scrollTo(0,0);
try{localStorage.setItem('crPage',i)}catch(e){}
if(!done[i]){done[i]=1;var n=document.querySelectorAll('#p'+i+' pre.mermaid');if(n.length)mermaid.run({nodes:n})}}
document.addEventListener('click',function(e){var a=e.target.closest('a[data-go]');if(a){e.preventDefault();show(+a.dataset.go)}});
var st=0;try{st=+localStorage.getItem('crPage')||0}catch(e){}show(st);"""
out = '<!doctype html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CredenceHR Documentation</title><style>%s</style></head><body><nav>%s</nav>%s<script>%s</script><script>%s</script></body></html>' % (CSS, nav, ''.join(secs), mermaid, boot)
dst = os.path.join(ROOT, 'CredenceHR-Documentation.html')
open(dst, 'w', encoding='utf-8').write(out)
print(dst, len(out)//1024, 'KB')
