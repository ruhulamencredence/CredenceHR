#!/usr/bin/env python3
"""docs/architecture-এর সব .md থেকে ইন্টারনেট-ছাড়া দেখার HTML বানায় (Mermaid assets/mermaid.min.js দিয়ে)।
চালান: python3 tools/build_html.py   (দরকার: pip install markdown)"""
import os, re, markdown
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
PAGES = [
 ('README.md', 'index.html', 'সূচি'),
 ('database/README.md', 'database/README.html', 'ডাটাবেস ডায়াগ্রাম'),
 ('database/data-dictionary.md', 'database/data-dictionary.html', 'Data Dictionary'),
 ('02-application-workflow.md', '02-application-workflow.html', 'Application Workflow'),
 ('03-technology-and-libraries.md', '03-technology-and-libraries.html', 'প্রযুক্তি ও লাইব্রেরি'),
 ('04-security.md', '04-security.html', 'Security'),
 ('security/access-control-matrix.md', 'security/access-control-matrix.html', 'Access Matrix'),
 ('05-security-questions-and-answers.md', '05-security-questions-and-answers.html', 'প্রশ্ন-উত্তর'),
]
CSS = """body{margin:0;font:16px/1.65 'Noto Sans Bengali','Segoe UI',system-ui,sans-serif;color:#1b1233;background:#f6f4fb}
nav{position:sticky;top:0;z-index:5;background:#2a0f5c;display:flex;gap:4px;flex-wrap:wrap;padding:8px 14px}
nav a{color:#e9ddff;text-decoration:none;font-size:14px;padding:6px 12px;border-radius:999px}
nav a:hover,nav a.on{background:#7c3aed;color:#fff}
main{max-width:1180px;margin:0 auto;padding:24px 22px 80px;background:#fff;box-shadow:0 0 40px rgba(60,20,120,.08)}
h1{font-size:30px;border-bottom:3px solid #7c3aed;padding-bottom:8px}h2{margin-top:2em;border-bottom:1px solid #e5defa;padding-bottom:4px}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px;display:block;overflow-x:auto}
th,td{border:1px solid #ddd5f3;padding:6px 10px;vertical-align:top;text-align:left}th{background:#efe9ff}
code{background:#f1ecff;padding:1px 5px;border-radius:4px;font-size:.92em}pre{background:#f7f5fc;padding:12px;border-radius:8px;overflow:auto}
pre.mermaid{background:#fff;border:1px solid #e5defa;text-align:center;overflow:auto;padding:14px}
img{max-width:100%;height:auto;border:1px solid #e5defa;border-radius:8px}blockquote{border-left:4px solid #a78bfa;margin:12px 0;padding:4px 14px;background:#faf8ff}
details{margin:8px 0}a{color:#6d28d9}"""
for src, dst, title in PAGES:
    md = open(os.path.join(ROOT, src), encoding='utf-8').read()
    html = markdown.markdown(md, extensions=['tables', 'fenced_code', 'toc'])
    html = re.sub(r'<pre><code class="language-mermaid">(.*?)</code></pre>', lambda m: '<pre class="mermaid">' + m.group(1) + '</pre>', html, flags=re.S)
    base = os.path.dirname(src)
    known = {os.path.normpath(os.path.join(ROOT, a)): b for a, b, _ in PAGES}
    def fix(m):
        target = os.path.normpath(os.path.join(ROOT, base, m.group(1) + '.md'))
        if target in known:
            rel = os.path.relpath(os.path.join(ROOT, known[target]), os.path.join(ROOT, os.path.dirname(dst)))
            return f'href="{rel}{m.group(2) or ""}"'
        return m.group(0)
    html = re.sub(r'href="([^"#:]+)\.md(#[^"]*)?"', fix, html)
    depth = dst.count('/')
    up = '../' * depth
    nav = ''.join(f'<a class="{"on" if d == dst else ""}" href="{up}{d}">{t}</a>' for _, d, t in PAGES)
    out = f'<!doctype html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title} — CredenceHR</title><style>{CSS}</style></head><body><nav>{nav}</nav><main>{html}</main><script src="{up}assets/mermaid.min.js"></script><script>mermaid.initialize({{startOnLoad:true,securityLevel:"loose",theme:"default",flowchart:{{useMaxWidth:true}},maxTextSize:900000}});</script></body></html>'
    open(os.path.join(ROOT, dst), 'w', encoding='utf-8').write(out)
    print('built', dst)
