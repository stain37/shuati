# -*- coding: utf-8 -*-
"""把「资料」文件夹里的文档转成 知识库.js —— 网页刷新后自动出现这些知识库。

用法（在站点目录里）：
    python make-kb.py                 扫 站点目录\资料\
    python make-kb.py D:\书 D:\讲义    每个目录 = 一个知识库（可给多个）

支持：.txt .md .csv .json .html .docx .pdf
      .docx 需要 python-docx（没有也能读：会退回直接解压的方式）
      .pdf  需要 pypdf（pip install pypdf），没装就跳过并提示
"""
import os
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8')   # Windows 控制台里中文才不乱码
except Exception:
    pass
import json
import io
import re
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, '知识库.js')
EXTS = ['.txt', '.md', '.markdown', '.csv', '.json', '.docx', '.pdf', '.html', '.htm']

PDF_SKIP = False     # --skip-pdf：完全不读 PDF（快）
PDF_PAGES = 0        # --pdf-pages N：每个 PDF 只读前 N 页
MAX_CHARS = 60000    # --max-chars N：每个文件最多留 N 字


def read_text(path):
    for enc in ('utf-8-sig', 'utf-8', 'gbk', 'gb18030', 'big5'):
        try:
            with io.open(path, 'r', encoding=enc) as f:
                return f.read()
        except Exception:
            continue
    with io.open(path, 'r', encoding='utf-8', errors='ignore') as f:
        return f.read()


def strip_html(s):
    s = re.sub(r'(?is)<(script|style)[^>]*>.*?</\1>', ' ', s)
    s = re.sub(r'(?s)<[^>]+>', ' ', s)
    s = s.replace('&nbsp;', ' ').replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&')
    return s


def flatten_json(o, out):
    if isinstance(o, dict):
        for v in o.values():
            if isinstance(v, (dict, list)):
                flatten_json(v, out)
            else:
                out.append(str(v))
    elif isinstance(o, list):
        for v in o:
            flatten_json(v, out)
    else:
        out.append(str(o))


def read_docx(path):
    try:
        import docx
        d = docx.Document(path)
        parts = [p.text for p in d.paragraphs]
        for t in d.tables:
            for row in t.rows:
                parts.append(' | '.join(c.text.strip() for c in row.cells))
        txt = '\n'.join(parts)
        if txt.strip():
            return txt
    except Exception:
        pass
    try:
        with zipfile.ZipFile(path) as z:
            xml = z.read('word/document.xml').decode('utf-8', 'ignore')
        xml = xml.replace('</w:p>', '\n').replace('</w:tr>', '\n')
        return strip_html(xml)
    except Exception as e:
        print('  ! 读不了 docx：' + path + '（' + str(e) + '）')
        return ''


def read_pdf(path):
    try:
        from pypdf import PdfReader
    except Exception:
        try:
            from PyPDF2 import PdfReader
        except Exception:
            print('  ! 读 PDF 需要 pypdf：在命令行里跑  pip install pypdf  再试')
            return ''
    try:
        r = PdfReader(path)
        pages = r.pages if not PDF_PAGES else r.pages[:PDF_PAGES]
        txt = '\n'.join((pg.extract_text() or '') for pg in pages)
        if PDF_PAGES and len(r.pages) > PDF_PAGES:
            print('    （只读了前 ' + str(PDF_PAGES) + ' 页 / 共 ' + str(len(r.pages)) + ' 页）')
        return txt
    except Exception as e:
        print('  ! 读不了 pdf：' + path + '（' + str(e) + '）')
        return ''


def load_doc(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == '.docx':
        return read_docx(path)
    if ext == '.pdf':
        return '' if PDF_SKIP else read_pdf(path)
    s = read_text(path)
    if ext in ('.html', '.htm'):
        s = strip_html(s)
    if ext == '.json':
        try:
            out = []
            flatten_json(json.loads(s), out)
            s = '\n'.join(out)
        except Exception:
            pass
    return s


def clean(s):
    s = s.replace('\r\n', '\n').replace('\r', '\n')
    s = re.sub(r'[ \t]+\n', '\n', s)
    s = re.sub(r'\n{3,}', '\n\n', s)
    return s.strip()


def scan(dirpath):
    docs = []
    for cur, dirs, files in os.walk(dirpath):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for fn in sorted(files):
            if os.path.splitext(fn)[1].lower() not in EXTS:
                continue
            if PDF_SKIP and fn.lower().endswith('.pdf'):
                continue
            p = os.path.join(cur, fn)
            if os.path.abspath(p) == OUT:
                continue
            txt = clean(load_doc(p))
            if MAX_CHARS and len(txt) > MAX_CHARS:
                txt = txt[:MAX_CHARS]
            if not txt:
                print('  - 跳过（没读到文字）：' + fn)
                continue
            rel = os.path.relpath(p, dirpath)
            docs.append({'name': rel, 'text': txt})
            print('  + ' + rel + '（' + format(len(txt), ',') + ' 字）')
    return docs


USAGE = r"""刷题站 · 把文件夹转成知识库.js

用法：
    python make-kb.py                  扫站点目录里的 资料\ 文件夹
    python make-kb.py D:\书 D:\讲义     每个目录 = 一个知识库（可给多个）

可选参数：
    --skip-pdf        跳过 PDF（最快）
    --pdf-pages 30    每个 PDF 只读前 30 页
    --max-chars 60000 每个文件最多留多少字
    -h, --help        看这段说明
"""


def main():
    global PDF_SKIP, PDF_PAGES, MAX_CHARS
    raw = sys.argv[1:]
    args = []
    i = 0
    while i < len(raw):
        a = raw[i]
        if a in ('-h', '--help'):
            print(USAGE)
            return
        if a == '--skip-pdf':
            PDF_SKIP = True
        elif a == '--pdf-pages':
            i += 1
            PDF_PAGES = int(raw[i]) if i < len(raw) and raw[i].isdigit() else 0
        elif a.startswith('--pdf-pages='):
            PDF_PAGES = int(a.split('=', 1)[1]) if a.split('=', 1)[1].isdigit() else 0
        elif a == '--max-chars':
            i += 1
            MAX_CHARS = int(raw[i]) if i < len(raw) and raw[i].isdigit() else MAX_CHARS
        elif a.startswith('--max-chars='):
            MAX_CHARS = int(a.split('=', 1)[1]) if a.split('=', 1)[1].isdigit() else MAX_CHARS
        elif a.startswith('-'):
            print('不认识的参数：' + a)
            print(USAGE)
            return
        else:
            args.append(a)
        i += 1
    if args:
        bases = []
        for a in args:
            ap = os.path.abspath(a)
            bases.append((ap, os.path.basename(ap) or a))
    else:
        bases = [(os.path.join(ROOT, '资料'), '资料')]
    kbs = []
    for base, name in bases:
        if not os.path.isdir(base):
            print('！目录不存在：' + base)
            continue
        print('扫描：' + base)
        docs = scan(base)
        if not docs:
            print('  （这个目录里没有可读的文档）')
            continue
        kb_id = 'file-' + re.sub(r'[^\w\u4e00-\u9fa5-]+', '-', name).strip('-').lower()
        kbs.append({'id': kb_id, 'name': name, 'src': 'file', 'docs': docs})
    if not kbs:
        print('')
        print('没有生成内容。把 .txt / .md / .docx / .pdf 放进 资料\\ 文件夹，再双击一次 转知识库.bat。')
        return
    payload = json.dumps(kbs, ensure_ascii=False).replace('</', '<\\/')
    with io.open(OUT, 'w', encoding='utf-8') as f:
        f.write('/* 由「转知识库.bat」自动生成，重新转换会整个覆盖，不要手改。 */\n')
        f.write('window.__KBS__ = (window.__KBS__ || []).concat(' + payload + ');\n')
    total = sum(len(d['text']) for kb in kbs for d in kb['docs'])
    ndoc = sum(len(kb['docs']) for kb in kbs)
    print('')
    print('完成：' + str(len(kbs)) + ' 个知识库 / ' + str(ndoc) + ' 个文档 / 共 ' + format(total, ',') + ' 字')
    print('生成：' + OUT)
    print('回到刷题站按 Ctrl+F5 刷新，在「AI 与知识库」页面或 AI 面板的标签里就能看到它们。')


if __name__ == '__main__':
    main()
